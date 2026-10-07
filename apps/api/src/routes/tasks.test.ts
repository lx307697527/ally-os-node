import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, runMigrations, schema } from "@ally/db";
import { createApp } from "../app.ts";
import type { SessionData } from "../auth/session.ts";
import { TASKS_PAGE_MAX } from "./tasks.ts";

// 集成测试：需要真实 PostgreSQL（行属读写、审计同事务、通知落表）。
// 未设 DATABASE_URL 时跳过。
//
// 本文件用**独立的临时库**（每次运行新建、跑完 drop）：断言 audit_events 的
// 精确行数与 tasks/notifications 的精确状态，共享库上其他文件的清理会随机干扰
// （样板：routes/audit-events.test.ts）。临时库整体生灭，TRUNCATE 是本文件
// 自己的清库通道，不与并行文件互相干扰。
const databaseUrl = process.env.DATABASE_URL;

const logger = pino({ level: "silent" });

/** alice/bob 是可分配员工（sales），carol 只有 customer 角色，dave 零角色 */
const USERS = {
  alice: randomUUID(),
  bob: randomUUID(),
  carol: randomUUID(),
  dave: randomUUID(),
} as const;

type UserName = keyof typeof USERS;

function sessionFor(userId: string, name: string): SessionData {
  // 会话里的名字与 auth_user 行同名（生产两者本就同源：better-auth 读库）
  const displayName = name.charAt(0).toUpperCase() + name.slice(1);
  return {
    user: {
      id: userId,
      email: `${name}@example.com`,
      name: displayName,
      emailVerified: true,
      twoFactorEnabled: true,
    },
    session: { id: `s-${userId}`, userId, expiresAt: new Date(Date.now() + 3_600_000) },
  };
}

describe.skipIf(!databaseUrl)("task endpoints (#113 slice 1, integration)", () => {
  const dbName = `tasks_test_${String(Date.now())}_${String(process.pid)}`;
  const admin = createDb(adminUrl(databaseUrl));
  const scopedUrl =
    databaseUrl === undefined
      ? ""
      : (() => {
          const url = new URL(databaseUrl);
          url.pathname = `/${dbName}`;
          return url.toString();
        })();
  const { db, pool } = createDb(scopedUrl);

  // #110 切片 2：notifyUsers 收集器——实时「催」的调用面，beforeEach 清空
  const nudged: string[][] = [];

  const app = createApp({
    logger,
    db,
    corsOrigins: ["http://localhost:5173"],
    checkDatabase: async () => {
      await pool.query("select 1");
    },
    authHandler: () => Promise.reject(new Error("auth handler should not be called")),
    resolveSession: (headers) => {
      const who = headers.get("x-test-user");
      if (who === null || !(who in USERS)) return Promise.resolve(null);
      const name = who as UserName;
      return Promise.resolve(sessionFor(USERS[name], name));
    },
    socialProviders: [],
    // 本套件不 exercise 附件端点；真被调到会在这里大声炸（AppDeps.storage 必选）
    storage: {
      put: () => Promise.reject(new Error("storage not used in this suite")),
      signedGetUrl: () => Promise.reject(new Error("storage not used in this suite")),
      signedPutUrl: () => Promise.reject(new Error("storage not used in this suite")),
      delete: () => Promise.reject(new Error("storage not used in this suite")),
    },
    authzStore: {
      getRoles: () => Promise.resolve([]),
      getDirectPermissions: () => Promise.resolve([]),
      grantRole: () => Promise.reject(new Error("not used")),
      revokeRole: () => Promise.reject(new Error("not used")),
    },
    // #110 切片 2：实时「催」的收集器
    notifyUsers: (userIds) => {
      nudged.push([...userIds]);
      return Promise.resolve();
    },
  });

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("unreachable: suite is skipped without DATABASE_URL");
    // 标识符不能走参数绑定，名字是本进程拼出来的固定格式，注入面可控
    await admin.pool.query(`create database "${dbName}"`);
    await runMigrations(db);
    await db.insert(schema.authUser).values([
      { id: USERS.alice, name: "Alice", email: "alice@example.com", emailVerified: true },
      { id: USERS.bob, name: "Bob", email: "bob@example.com", emailVerified: true },
      { id: USERS.carol, name: "Carol", email: "carol@example.com", emailVerified: true },
      { id: USERS.dave, name: "Dave", email: "dave@example.com", emailVerified: true },
    ]);
    await db.insert(schema.userRole).values([
      { userId: USERS.alice, role: "sales" },
      { userId: USERS.bob, role: "sales" },
      { userId: USERS.carol, role: "customer" },
    ]);
  });

  beforeEach(async () => {
    // 整库是本文件的：共享面表每条测试前清空
    await db.execute(sql`truncate table ${schema.tasks}`);
    await db.execute(sql`truncate table ${schema.follows}`);
    await db.execute(sql`truncate table ${schema.notifications}`);
    await db.execute(sql`truncate table ${schema.auditEvents}`);
    nudged.length = 0;
  });

  afterAll(async () => {
    await pool.end();
    // 库随测试生灭：即便断言中途失败也不留跨运行垃圾
    await admin.pool.query(`drop database if exists "${dbName}" with (force)`);
    await admin.pool.end();
  });

  const alice = { "x-test-user": "alice" };
  const bob = { "x-test-user": "bob" };

  interface TaskRow {
    id: string;
    title: string;
    description: string | null;
    status: "open" | "done" | "cancelled";
    dueAt: string | null;
    assignee: { id: string; name: string } | null;
    createdBy: { id: string; name: string } | null;
    createdAt: string;
    updatedAt: string;
  }

  async function createTask(
    headers: Record<string, string>,
    body: Record<string, unknown>,
  ): Promise<{ status: number; task: TaskRow | null }> {
    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { task?: TaskRow | null };
    return { status: res.status, task: json.task ?? null };
  }

  async function auditRows(action?: string): Promise<{ action: string; detail: unknown }[]> {
    const rows = await db
      .select({ action: schema.auditEvents.action, detail: schema.auditEvents.detail })
      .from(schema.auditEvents)
      .where(action === undefined ? sql`true` : eq(schema.auditEvents.action, action));
    return rows;
  }

  async function notificationsFor(userId: string): Promise<{ eventType: string; payload: Record<string, unknown> }[]> {
    return db
      .select({
        eventType: schema.notifications.eventType,
        payload: schema.notifications.payload,
      })
      .from(schema.notifications)
      .where(eq(schema.notifications.userId, userId));
  }

  it("未登录 401——任务列表不公开", async () => {
    const res = await app.request("/api/tasks");
    expect(res.status).toBe(401);
  });

  it("assignee-options 只列可分配员工：多角色去重，纯 customer 与零角色不在列", async () => {
    const res = await app.request("/api/tasks/assignee-options", { headers: alice });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { assignees: { id: string; name: string; email: string }[] };
    expect(body.assignees.map((a) => a.id).sort()).toEqual([USERS.alice, USERS.bob].sort());
  });

  it("创建：服务端记创建人，201 返回行；同事务写 task.created 审计", async () => {
    const { status, task } = await createTask(alice, { title: "跟进样品寄送", dueAt: "2026-10-10T00:00:00.000Z" });
    expect(status).toBe(201);
    expect(task?.title).toBe("跟进样品寄送");
    expect(task?.createdBy?.id).toBe(USERS.alice);
    expect(task?.assignee).toBeNull();
    expect(task?.status).toBe("open");
    expect(task?.dueAt).toBe("2026-10-10T00:00:00.000Z");
    const created = await auditRows("task.created");
    expect(created).toHaveLength(1);
    expect(created[0]?.detail).toEqual({ title: "跟进样品寄送", assignee: null });
  });

  it("创建即指派：经办人收到 task.assigned 通知；指派不存在/不可分配的人 400", async () => {
    const ok = await createTask(alice, { title: "整理报价", assigneeId: USERS.bob });
    expect(ok.status).toBe(201);
    const notes = await notificationsFor(USERS.bob);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.eventType).toBe("task.assigned");
    expect(notes[0]?.payload).toMatchObject({ taskTitle: "整理报价", actorName: "Alice" });
    // 通知落库后对经办人发一次实时「催」（#110 切片 2）
    expect(nudged).toEqual([[USERS.bob]]);

    const ghost = await createTask(alice, { title: "x", assigneeId: randomUUID() });
    expect(ghost.status).toBe(400);
    const customerOnly = await createTask(alice, { title: "x", assigneeId: USERS.carol });
    expect(customerOnly.status).toBe(400);
    const roleless = await createTask(alice, { title: "x", assigneeId: USERS.dave });
    expect(roleless.status).toBe(400);
  });

  it("派给自己：不给自己发通知", async () => {
    const { status } = await createTask(alice, { title: "自留任务", assigneeId: USERS.alice });
    expect(status).toBe(201);
    expect(await notificationsFor(USERS.alice)).toHaveLength(0);
    expect(nudged).toEqual([]);
  });

  it("校验：空标题/错类型/超上限 400", async () => {
    expect((await createTask(alice, { title: "" })).status).toBe(400);
    expect((await createTask(alice, { title: " ".repeat(201) })).status).toBe(400);
    expect((await createTask(alice, { title: "x", dueAt: "not-a-date" })).status).toBe(400);
    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json", ...alice },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  it("列表按行属隔离：scope=assigned 与 created 各归各，status 过滤，分页封顶", async () => {
    await createTask(alice, { title: "a-给-b", assigneeId: USERS.bob });
    await createTask(alice, { title: "a-自留" });
    await createTask(bob, { title: "b-给-b", assigneeId: USERS.bob });

    const assigned = await app.request("/api/tasks", { headers: bob });
    const assignedBody = (await assigned.json()) as { tasks: TaskRow[]; total: number };
    expect(assignedBody.total).toBe(2);
    expect(assignedBody.tasks.every((t) => t.assignee?.id === USERS.bob)).toBe(true);

    const created = await app.request("/api/tasks?scope=created", { headers: alice });
    const createdBody = (await created.json()) as { tasks: TaskRow[]; total: number };
    expect(createdBody.total).toBe(2);
    expect(createdBody.tasks.every((t) => t.createdBy?.id === USERS.alice)).toBe(true);

    // 到期升序 nulls last：没填到期的不挤占有到期的
    await createTask(alice, { title: "有到期", assigneeId: USERS.bob, dueAt: "2026-10-08T00:00:00.000Z" });
    const ordered = await app.request("/api/tasks", { headers: bob });
    const orderedBody = (await ordered.json()) as { tasks: TaskRow[] };
    expect(orderedBody.tasks[0]?.title).toBe("有到期");

    const openOnly = await app.request("/api/tasks?status=open", { headers: bob });
    const openBody = (await openOnly.json()) as { tasks: TaskRow[]; total: number };
    expect(openBody.total).toBe(3);

    const overCap = await app.request(`/api/tasks?limit=${String(TASKS_PAGE_MAX + 1)}`, { headers: alice });
    expect(overCap.status).toBe(400);
    const negative = await app.request("/api/tasks?offset=-1", { headers: alice });
    expect(negative.status).toBe(400);
    const badScope = await app.request("/api/tasks?scope=everything", { headers: alice });
    expect(badScope.status).toBe(400);
  });

  it("详情行属：创建人/经办人可见，无关人 404（不区分不存在与不属于）", async () => {
    const { task } = await createTask(alice, { title: "机密任务", assigneeId: USERS.bob });
    const id = task?.id;
    expect(id).toBeTruthy();
    expect((await app.request(`/api/tasks/${id}`, { headers: alice })).status).toBe(200);
    expect((await app.request(`/api/tasks/${id}`, { headers: bob })).status).toBe(200);
    const stranger = await app.request(`/api/tasks/${id}`, { headers: { "x-test-user": "carol" } });
    expect(stranger.status).toBe(404);
    const missing = await app.request(`/api/tasks/${randomUUID()}`, { headers: alice });
    expect(missing.status).toBe(404);
    const malformed = await app.request("/api/tasks/not-a-uuid", { headers: alice });
    expect(malformed.status).toBe(400);
  });

  it("经办人改状态：审计带 from/to；同值与 no-op PATCH 不写审计、不动 updatedAt", async () => {
    const { task } = await createTask(alice, { title: "样品跟进", assigneeId: USERS.bob });
    const id = task?.id;
    expect(id).toBeTruthy();

    const done = await app.request(`/api/tasks/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...bob },
      body: JSON.stringify({ status: "done" }),
    });
    expect(done.status).toBe(200);
    const doneBody = (await done.json()) as { task: TaskRow };
    expect(doneBody.task.status).toBe("done");
    const changes = await auditRows("task.status_changed");
    expect(changes).toHaveLength(1);
    expect(changes[0]?.detail).toEqual({ from: "open", to: "done" });

    const updatedAtBefore = doneBody.task.updatedAt;
    const noop = await app.request(`/api/tasks/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...bob },
      body: JSON.stringify({ status: "done" }),
    });
    expect(noop.status).toBe(200);
    const noopBody = (await noop.json()) as { task: TaskRow };
    expect(noopBody.task.updatedAt).toBe(updatedAtBefore);
    expect(await auditRows()).toHaveLength(2); // created + status_changed，无新增

    // 未勾回去：done → open 同样是合法翻转（勾选式）
    const reopen = await app.request(`/api/tasks/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...bob },
      body: JSON.stringify({ status: "open" }),
    });
    const reopenBody = (await reopen.json()) as { task: TaskRow };
    expect(reopenBody.task.status).toBe("open");
  });

  it("经办人不能改派（403 assignee_creator_only）；创建人改派写审计并发新通知", async () => {
    const { task } = await createTask(alice, { title: "改派流转", assigneeId: USERS.bob });
    const id = task?.id;
    expect(id).toBeTruthy();

    const byAssignee = await app.request(`/api/tasks/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...bob },
      body: JSON.stringify({ assigneeId: USERS.alice }),
    });
    expect(byAssignee.status).toBe(403);
    expect(((await byAssignee.json()) as { code?: string }).code).toBe("assignee_creator_only");

    const byCreator = await app.request(`/api/tasks/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...alice },
      body: JSON.stringify({ assigneeId: USERS.alice }),
    });
    expect(byCreator.status).toBe(200);
    const assigned = await auditRows("task.assigned");
    expect(assigned).toHaveLength(1);
    expect(assigned[0]?.detail).toEqual({ assignee: USERS.alice, assigneeName: "Alice" });
    // 改派给创建人自己：不发通知
    expect(await notificationsFor(USERS.alice)).toHaveLength(0);
    expect(await notificationsFor(USERS.bob)).toHaveLength(1); // 创建时那一条

    const toBob = await app.request(`/api/tasks/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...alice },
      body: JSON.stringify({ assigneeId: USERS.bob }),
    });
    expect(toBob.status).toBe(200);
    expect(await notificationsFor(USERS.bob)).toHaveLength(2);
    expect((await notificationsFor(USERS.bob)).at(-1)?.payload).toMatchObject({ taskTitle: "改派流转" });

    const unassign = await app.request(`/api/tasks/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...alice },
      body: JSON.stringify({ assigneeId: null }),
    });
    expect(unassign.status).toBe(200);
    const unassigned = (await unassign.json()) as { task: TaskRow };
    expect(unassigned.task.assignee).toBeNull();
    // 「催」与通知同拍：创建时一次，改派给 Bob 一次；改派给自己/解除不催
    expect(nudged).toEqual([[USERS.bob], [USERS.bob]]);
  });

  it("创建人改内容：task.updated 审计记字段名；无关人 PATCH 404", async () => {
    const { task } = await createTask(alice, { title: "初稿" });
    const id = task?.id;
    expect(id).toBeTruthy();

    const edit = await app.request(`/api/tasks/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...alice },
      body: JSON.stringify({ title: "终稿", description: "改了说明" }),
    });
    expect(edit.status).toBe(200);
    const edits = await auditRows("task.updated");
    expect(edits).toHaveLength(1);
    expect(edits[0]?.detail).toEqual({ fields: ["title", "description"] });

    const stranger = await app.request(`/api/tasks/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-test-user": "carol" },
      body: JSON.stringify({ title: "越权改" }),
    });
    expect(stranger.status).toBe(404);
  });

  it("状态流转对关注者的投递：关注者收 task.status_changed（from/to 事实齐），操作者不收自己的动作，no-op 零通知", async () => {
    const { task } = await createTask(alice, { title: "扇出流转", assigneeId: USERS.bob });
    const id = task?.id;
    expect(id).toBeTruthy();
    // 创建人与经办人都可见，都关注（关注门 = 同一扇可见性门）
    expect((await app.request(`/api/follows/task/${id}`, { method: "PUT", headers: alice })).status).toBe(200);
    expect((await app.request(`/api/follows/task/${id}`, { method: "PUT", headers: bob })).status).toBe(200);

    const done = await app.request(`/api/tasks/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...bob },
      body: JSON.stringify({ status: "done" }),
    });
    expect(done.status).toBe(200);
    const aliceNotes = await notificationsFor(USERS.alice);
    expect(aliceNotes).toHaveLength(1);
    expect(aliceNotes[0]?.eventType).toBe("task.status_changed");
    expect(aliceNotes[0]?.payload).toEqual({
      taskTitle: "扇出流转",
      actorName: "Bob",
      from: "open",
      to: "done",
    });
    // 操作者本人虽关注，不收自己的动作；手里只有创建时的 task.assigned
    const bobNotes = await notificationsFor(USERS.bob);
    expect(bobNotes.map((n) => n.eventType)).toEqual(["task.assigned"]);
    expect(nudged).toEqual([[USERS.bob], [USERS.alice]]);

    // no-op（同值）PATCH：无通知无催
    const noop = await app.request(`/api/tasks/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...bob },
      body: JSON.stringify({ status: "done" }),
    });
    expect(noop.status).toBe(200);
    expect(await notificationsFor(USERS.alice)).toHaveLength(1);
    expect(nudged).toEqual([[USERS.bob], [USERS.alice]]);
  });

  it("改派没有关注者事件：旧经办人随改派失去可见性（投递按当前可见者收口），重获可见性时定向事件优先、一人一个 PATCH 至多一条", async () => {
    const { task } = await createTask(alice, { title: "改派收口", assigneeId: USERS.bob });
    const id = task?.id;
    expect(id).toBeTruthy();
    expect((await app.request(`/api/follows/task/${id}`, { method: "PUT", headers: bob })).status).toBe(200);

    const move = await app.request(`/api/tasks/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...alice },
      body: JSON.stringify({ assigneeId: USERS.alice }),
    });
    expect(move.status).toBe(200);
    // bob 的关注行保留，但改派后他不再是可见者：没有关注者投递（链接只会 404）；
    // 改派的定向投递就是新经办人的 task.assigned（这里新经办人是操作者自己，无）
    const bobNotesAfterMove = await notificationsFor(USERS.bob);
    expect(bobNotesAfterMove.map((n) => n.eventType)).toEqual(["task.assigned"]);
    expect(nudged).toEqual([[USERS.bob]]);

    // 同拍「状态 + 改派回 bob」：bob 的陈旧关注行随重新指派复活，但他同时拿到
    // 定向 task.assigned——一人一个 PATCH 至多一条，定向优先
    const combo = await app.request(`/api/tasks/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...alice },
      body: JSON.stringify({ status: "done", assigneeId: USERS.bob }),
    });
    expect(combo.status).toBe(200);
    const bobNotesAfterCombo = await notificationsFor(USERS.bob);
    expect(bobNotesAfterCombo.map((n) => n.eventType)).toEqual(["task.assigned", "task.assigned"]);
    expect(nudged).toEqual([[USERS.bob], [USERS.bob]]);
  });
});

/** 同一实例上连 maintenance 库（postgres）用的管理连接串 */
function adminUrl(databaseUrl: string | undefined): string {
  if (!databaseUrl) return ""; // 套件被跳过时不会被用到
  const url = new URL(databaseUrl);
  url.pathname = "/postgres";
  return url.toString();
}
