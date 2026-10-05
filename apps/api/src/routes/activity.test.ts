import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, runMigrations, schema } from "@ally/db";
import { createApp } from "../app.ts";
import type { SessionData } from "../auth/session.ts";

// 集成测试：需要真实 PostgreSQL（subject 可见性门、audit 投影的 JSON 过滤、
// actor 联名）。未设 DATABASE_URL 时跳过。
//
// 本文件用**独立的临时库**（每次运行新建、跑完 drop）：断言 audit_events 的
// 精确行集，共享库上其他文件的清理会随机干扰（样板：routes/comments.test.ts）。
// 临时库整体生灭，TRUNCATE 是本文件自己的清库通道，不与并行文件互相干扰。
const databaseUrl = process.env.DATABASE_URL;

const logger = pino({ level: "silent" });

/** alice/bob 是任务行属（可见者），carol 只有 customer 角色，dave 零角色 */
const USERS = {
  alice: randomUUID(),
  bob: randomUUID(),
  carol: randomUUID(),
  dave: randomUUID(),
} as const;

type UserName = keyof typeof USERS;

function sessionFor(userId: string, name: string): SessionData {
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** noUncheckedIndexedAccess：下标读法显式断言，索引越界在这里炸而不是在断言里 */
function expectDefined<T>(value: T | undefined): T {
  expect(value).toBeDefined();
  return value as T;
}

describe.skipIf(!databaseUrl)("activity endpoint (#110 slice 3, integration)", () => {
  const dbName = `activity_test_${String(Date.now())}_${String(process.pid)}`;
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
  // 拆库瞬间的 57P01 由 pg Pool 重发到 pool 对象上，无监听即未捕获异常（同
  // comments.test.ts 的 CI 实锤）。预期的拆除错误，吞掉。
  pool.on("error", () => {});

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
    authzStore: {
      getRoles: () => Promise.resolve([]),
      getDirectPermissions: () => Promise.resolve([]),
      grantRole: () => Promise.reject(new Error("not used")),
      revokeRole: () => Promise.reject(new Error("not used")),
    },
    notifyUsers: () => Promise.resolve(),
  });

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("unreachable: suite is skipped without DATABASE_URL");
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
    await db.execute(sql`truncate table ${schema.comments}`);
    await db.execute(sql`truncate table ${schema.tasks}`);
    await db.execute(sql`truncate table ${schema.notifications}`);
    await db.execute(sql`truncate table ${schema.auditEvents}`);
  });

  afterAll(async () => {
    // force drop：空闲池连接收到拆库通知时报 57P01，上面 pool.on("error") 吞掉
    await admin.pool.query(`drop database if exists "${dbName}" with (force)`);
    await admin.pool.end();
    await pool.end();
  });

  async function createTaskViaApi(who: UserName, assigneeId?: string): Promise<string> {
    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-user": who },
      body: JSON.stringify(
        assigneeId === undefined ? { title: "Task" } : { title: "Task", assigneeId },
      ),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { task: { id: string } };
    return body.task.id;
  }

  it("rejects unauthenticated, malformed and unregistered queries before touching data", async () => {
    const unauthorized = await app.request(`/api/activity?subjectType=task&subjectId=${randomUUID()}`);
    expect(unauthorized.status).toBe(401);

    const me = { "x-test-user": "alice" };
    const badUuid = await app.request("/api/activity?subjectType=task&subjectId=not-a-uuid", {
      headers: me,
    });
    expect(badUuid.status).toBe(400);

    // 未注册的 subject 类型：400 与评论内核同一裁决（类型不存在，不是探测不到）
    const unregistered = await app.request(
      `/api/activity?subjectType=lead&subjectId=${randomUUID()}`,
      { headers: me },
    );
    expect(unregistered.status).toBe(400);

    const missing = await app.request("/api/activity", { headers: me });
    expect(missing.status).toBe(400);
  });

  it("answers 404 for strangers and unknown subjects (anti-probe, same as comments)", async () => {
    const taskId = await createTaskViaApi("alice", USERS.bob);
    const me = { "x-test-user": "alice" };

    // 不可见者（carol 只在 customer 角色、dave 零角色，都不是行属）与不存在的
    // 行同回答 404——拿不到「任务存在但我看不见」的探测结论
    for (const who of ["carol", "dave"] as const) {
      const res = await app.request(`/api/activity?subjectType=task&subjectId=${taskId}`, {
        headers: { "x-test-user": who },
      });
      expect(res.status).toBe(404);
    }
    const ghost = await app.request(`/api/activity?subjectType=task&subjectId=${randomUUID()}`, {
      headers: me,
    });
    expect(ghost.status).toBe(404);
  });

  it("projects the subject's audit rows into a newest-first timeline with actor names", async () => {
    const taskId = await createTaskViaApi("alice", USERS.bob);
    await sleep(5);
    const statusRes = await app.request(`/api/tasks/${taskId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-test-user": "alice" },
      body: JSON.stringify({ status: "done" }),
    });
    expect(statusRes.status).toBe(200);
    await sleep(5);
    const commentRes = await app.request("/api/comments", {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-user": "alice" },
      body: JSON.stringify({ subjectType: "task", subjectId: taskId, body: "shipping notes" }),
    });
    expect(commentRes.status).toBe(201);
    const comment = (await commentRes.json()) as { comment: { id: string } };
    await sleep(5);
    const deleteRes = await app.request(`/api/comments/${comment.comment.id}`, {
      method: "DELETE",
      headers: { "x-test-user": "alice" },
    });
    expect(deleteRes.status).toBe(200);

    const res = await app.request(`/api/activity?subjectType=task&subjectId=${taskId}`, {
      headers: { "x-test-user": "bob" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const events = (
      body as {
        events: {
          id: string;
          action: string;
          target: string | null;
          detail: Record<string, unknown> | null;
          actor: { id: string; name: string } | null;
          createdAt: string;
        }[];
        total: number;
      }
    ).events;

    // task.created 落在创建事务里；评论行经 detail 引用 subject 进投影
    expect(events.map((e) => e.action)).toEqual([
      "comment.deleted",
      "comment.created",
      "task.status_changed",
      "task.created",
    ]);
    expect(body).toHaveProperty("total", 4);

    const [deleted, created, statusChange, taskCreated] = [
      expectDefined(events[0]),
      expectDefined(events[1]),
      expectDefined(events[2]),
      expectDefined(events[3]),
    ];
    // 评论行的 target 是评论 id，subject 引用在 detail（行 → subject 约定）
    expect(created.target).toBe(comment.comment.id);
    expect(created.detail).toMatchObject({ subjectType: "task", subjectId: taskId });
    // 对象行直接以 target 引用
    expect(taskCreated.target).toBe(taskId);
    expect(taskCreated.detail).toMatchObject({ title: "Task" });
    // 状态变更按 docs/audit.md 带 from/to
    expect(statusChange.detail).toEqual({ from: "open", to: "done" });
    // actor 经 auth_user 联名解析；时间 ISO 字符串
    expect(created.actor).toEqual({ id: USERS.alice, name: "Alice" });
    expect(deleted.actor).toEqual({ id: USERS.alice, name: "Alice" });
    expect(() => new Date(created.createdAt)).not.toThrow();
  });

  it("keeps other subjects' rows out of the projection", async () => {
    const taskA = await createTaskViaApi("alice");
    await sleep(5);
    const taskB = await createTaskViaApi("alice", USERS.bob);

    const res = await app.request(`/api/activity?subjectType=task&subjectId=${taskA}`, {
      headers: { "x-test-user": "alice" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events: { action: string; target: string | null }[];
      total: number;
    };
    expect(body.total).toBe(1);
    expect(body.events).toHaveLength(1);
    expect(body.events[0]?.target).toBe(taskA);
    expect(body.events[0]?.target).not.toBe(taskB);
  });

  it("pages with limit/offset and an exact total", async () => {
    const taskId = await createTaskViaApi("alice");
    // 第二页事件：改状态（task.created + task.status_changed = 2 行）
    const res1 = await app.request(`/api/tasks/${taskId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-test-user": "alice" },
      body: JSON.stringify({ status: "done" }),
    });
    expect(res1.status).toBe(200);

    const base = { headers: { "x-test-user": "alice" } };
    const page1 = await app.request(
      `/api/activity?subjectType=task&subjectId=${taskId}&limit=1&offset=0`,
      base,
    );
    const page2 = await app.request(
      `/api/activity?subjectType=task&subjectId=${taskId}&limit=1&offset=1`,
      base,
    );
    const beyond = await app.request(
      `/api/activity?subjectType=task&subjectId=${taskId}&limit=1&offset=2`,
      base,
    );
    const body1 = (await page1.json()) as { events: unknown[]; total: number };
    const body2 = (await page2.json()) as { events: unknown[]; total: number };
    const bodyBeyond = (await beyond.json()) as { events: unknown[]; total: number };
    expect(body1.total).toBe(2);
    expect(body2.total).toBe(2);
    expect(body1.events).toHaveLength(1);
    expect(body2.events).toHaveLength(1);
    expect(bodyBeyond.events).toHaveLength(0);
    expect(bodyBeyond.total).toBe(2);
  });

  it("leaves no audit row of its own (pure read, same adjudication as the audit page)", async () => {
    const taskId = await createTaskViaApi("alice");
    const before = await countAudits();
    await app.request(`/api/activity?subjectType=task&subjectId=${taskId}`, {
      headers: { "x-test-user": "alice" },
    });
    expect(await countAudits()).toBe(before);
  });

  async function countAudits(): Promise<number> {
    const rows = await db.select({ n: sql<number>`count(*)::int` }).from(schema.auditEvents);
    return rows[0]?.n ?? 0;
  }

  // 防回归：comment.deleted 的行要留在被删评论所属 subject 的活动流里
  // （评论行删除后，detail 里的 subject 引用是它唯一的归属凭据）
  it("keeps a deleted comment's audit row attached to its subject", async () => {
    const taskId = await createTaskViaApi("alice");
    const commentRes = await app.request("/api/comments", {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-user": "alice" },
      body: JSON.stringify({ subjectType: "task", subjectId: taskId, body: "to be removed" }),
    });
    const comment = (await commentRes.json()) as { comment: { id: string } };
    await app.request(`/api/comments/${comment.comment.id}`, {
      method: "DELETE",
      headers: { "x-test-user": "alice" },
    });
    const gone = await db
      .select({ id: schema.comments.id })
      .from(schema.comments)
      .where(eq(schema.comments.id, comment.comment.id));
    expect(gone).toHaveLength(0);

    const res = await app.request(`/api/activity?subjectType=task&subjectId=${taskId}`, {
      headers: { "x-test-user": "alice" },
    });
    const body = (await res.json()) as { events: { action: string }[]; total: number };
    expect(body.total).toBe(3);
    expect(body.events.map((e) => e.action)).toEqual([
      "comment.deleted",
      "comment.created",
      "task.created",
    ]);
  });
});

function adminUrl(databaseUrl: string | undefined): string {
  if (databaseUrl === undefined) return "";
  const url = new URL(databaseUrl);
  url.pathname = "/postgres";
  return url.toString();
}
