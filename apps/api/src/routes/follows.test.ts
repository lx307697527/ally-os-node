import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, runMigrations, schema } from "@ally/db";
import { createApp } from "../app.ts";
import type { SessionData } from "../auth/session.ts";

// 集成测试：需要真实 PostgreSQL（可见性门、幂等不落审计、关注扇出的精确
// 通知行数）。未设 DATABASE_URL 时跳过。
//
// 本文件用**独立的临时库**（每次运行新建、跑完 drop）：断言 notifications /
// audit_events / follows 的精确行数，共享库上其他文件的清理会随机干扰（样板：
// routes/comments.test.ts）。临时库整体生灭，TRUNCATE 是本文件自己的清库通道。
const databaseUrl = process.env.DATABASE_URL;

const logger = pino({ level: "silent" });

/** alice/bob/dan 是员工（任务可见者池），carol 只有 customer 角色，dave 零角色 */
const USERS = {
  alice: randomUUID(),
  bob: randomUUID(),
  dan: randomUUID(),
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

describe.skipIf(!databaseUrl)("follow endpoints (#110 slice 4, integration)", () => {
  const dbName = `follows_test_${String(Date.now())}_${String(process.pid)}`;
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
  // 本套件的库在 afterAll 被 drop (force)：拆库瞬间若还有空闲池连接未收完，
  // 57P01 会由 pg Pool 重发到 pool 对象上，无监听即未捕获异常（同
  // routes/comments.test.ts 的 CI 实锤）。预期的拆除错误，吞掉。
  pool.on("error", () => {});

  // #110 slice 2: collector for the realtime nudge callback
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
    authzStore: {
      getRoles: () => Promise.resolve([]),
      getDirectPermissions: () => Promise.resolve([]),
      grantRole: () => Promise.reject(new Error("not used")),
      revokeRole: () => Promise.reject(new Error("not used")),
    },
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
      { id: USERS.dan, name: "Dan", email: "dan@example.com", emailVerified: true },
      { id: USERS.carol, name: "Carol", email: "carol@example.com", emailVerified: true },
      { id: USERS.dave, name: "Dave", email: "dave@example.com", emailVerified: true },
    ]);
    await db.insert(schema.userRole).values([
      { userId: USERS.alice, role: "sales" },
      { userId: USERS.bob, role: "sales" },
      { userId: USERS.dan, role: "sales" },
      { userId: USERS.carol, role: "customer" },
    ]);
  });

  beforeEach(async () => {
    // 整库是本文件的：五张表每条测试前清空
    await db.execute(sql`truncate table ${schema.comments}`);
    await db.execute(sql`truncate table ${schema.follows}`);
    await db.execute(sql`truncate table ${schema.tasks}`);
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
  const dan = { "x-test-user": "dan" };
  const carol = { "x-test-user": "carol" };
  const dave = { "x-test-user": "dave" };

  /** 直接插一行任务作夹具：可见者 = 创建人 + 经办人 */
  async function seedTask(createdBy: string, assignee: string | null): Promise<string> {
    const rows = await db
      .insert(schema.tasks)
      .values({ title: "Review label copy", createdById: createdBy, assigneeId: assignee })
      .returning({ id: schema.tasks.id });
    const row = rows[0];
    if (row === undefined) throw new Error("task seed returned no row");
    return row.id;
  }

  async function follow(
    headers: Record<string, string>,
    subjectType: string,
    subjectId: string,
    method: "PUT" | "DELETE",
  ): Promise<{ status: number; meFollowing: boolean | null }> {
    const res = await app.request(`/api/follows/${subjectType}/${subjectId}`, { method, headers });
    const json = (await res.json()) as { meFollowing?: boolean };
    return { status: res.status, meFollowing: json.meFollowing ?? null };
  }

  async function listFollowers(
    headers: Record<string, string>,
    subjectType: string,
    subjectId: string,
  ): Promise<{
    status: number;
    followers: { id: string; name: string }[];
    total: number;
    meFollowing: boolean;
  }> {
    const res = await app.request(`/api/follows/${subjectType}/${subjectId}`, { headers });
    const json = (await res.json()) as {
      followers?: { id: string; name: string }[];
      total?: number;
      meFollowing?: boolean;
    };
    return {
      status: res.status,
      followers: json.followers ?? [],
      total: json.total ?? 0,
      meFollowing: json.meFollowing === true,
    };
  }

  async function auditRows(action: string): Promise<{ actor: string | null; detail: unknown }[]> {
    return await db
      .select({ actor: schema.auditEvents.actor, detail: schema.auditEvents.detail })
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.action, action));
  }

  async function notificationsFor(userId: string): Promise<
    { eventType: string; aggregateId: string | null; payload: Record<string, unknown> }[]
  > {
    return await db
      .select({
        eventType: schema.notifications.eventType,
        aggregateId: schema.notifications.aggregateId,
        payload: schema.notifications.payload,
      })
      .from(schema.notifications)
      .where(eq(schema.notifications.userId, userId));
  }

  async function postComment(
    headers: Record<string, string>,
    body: Record<string, unknown>,
  ): Promise<{ status: number; notifiedFollowers: number }> {
    const res = await app.request("/api/comments", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { notifiedFollowers?: number };
    return { status: res.status, notifiedFollowers: json.notifiedFollowers ?? -1 };
  }

  it("a viewer follows a task: row lands, follow.created audit carries the subject reference", async () => {
    const taskId = await seedTask(USERS.alice, USERS.bob);
    const res = await follow(alice, "task", taskId, "PUT");
    expect(res.status).toBe(200);
    expect(res.meFollowing).toBe(true);

    const rows = await db
      .select({ userId: schema.follows.userId })
      .from(schema.follows)
      .where(eq(schema.follows.subjectId, taskId));
    expect(rows).toEqual([{ userId: USERS.alice }]);

    const created = await auditRows("follow.created");
    expect(created).toEqual([
      { actor: USERS.alice, detail: { subjectType: "task", subjectId: taskId } },
    ]);
  });

  it("following twice is idempotent: one row, one audit line", async () => {
    const taskId = await seedTask(USERS.alice, USERS.bob);
    expect((await follow(alice, "task", taskId, "PUT")).status).toBe(200);
    expect((await follow(alice, "task", taskId, "PUT")).status).toBe(200);

    const rows = await db
      .select({ userId: schema.follows.userId })
      .from(schema.follows)
      .where(eq(schema.follows.subjectId, taskId));
    expect(rows).toHaveLength(1);
    expect(await auditRows("follow.created")).toHaveLength(1);
  });

  it("unfollowing lands one row removal and one follow.deleted audit; repeat is a no-op", async () => {
    const taskId = await seedTask(USERS.alice, USERS.bob);
    expect((await follow(bob, "task", taskId, "PUT")).status).toBe(200);

    const off = await follow(bob, "task", taskId, "DELETE");
    expect(off.status).toBe(200);
    expect(off.meFollowing).toBe(false);
    expect(
      await db.select({ userId: schema.follows.userId }).from(schema.follows).where(eq(schema.follows.subjectId, taskId)),
    ).toEqual([]);

    const again = await follow(bob, "task", taskId, "DELETE");
    expect(again.status).toBe(200);
    expect(again.meFollowing).toBe(false);
    expect(await auditRows("follow.deleted")).toHaveLength(1);
  });

  it("GET lists followers with names and the caller's own state", async () => {
    const taskId = await seedTask(USERS.alice, USERS.bob);
    await follow(alice, "task", taskId, "PUT");
    await follow(bob, "task", taskId, "PUT");

    for (const [headers, meId] of [
      [alice, USERS.alice],
      [bob, USERS.bob],
    ] as const) {
      const list = await listFollowers(headers, "task", taskId);
      expect(list.status).toBe(200);
      expect(list.total).toBe(2);
      expect(new Set(list.followers.map((row) => row.id))).toEqual(
        new Set([USERS.alice, USERS.bob]),
      );
      expect(list.followers.map((row) => row.name).sort()).toEqual(["Alice", "Bob"]);
      expect(list.meFollowing).toBe(true);
      expect(list.followers.some((row) => row.id === meId)).toBe(true);
    }
  });

  it("unregistered subject type is a 400 on every verb", async () => {
    const nowhere = randomUUID();
    expect((await listFollowers(alice, "glyph", nowhere)).status).toBe(400);
    expect((await follow(alice, "glyph", nowhere, "PUT")).status).toBe(400);
    expect((await follow(alice, "glyph", nowhere, "DELETE")).status).toBe(400);
  });

  it("invisible or missing subjects are 404 (anti-probe, same answer for both)", async () => {
    // 不存在的 subject
    expect((await listFollowers(alice, "task", randomUUID())).status).toBe(404);
    // carol（customer 角色）看不见 alice 的任务；dave 零角色同理
    const taskId = await seedTask(USERS.alice, USERS.bob);
    expect((await listFollowers(carol, "task", taskId)).status).toBe(404);
    expect((await follow(carol, "task", taskId, "PUT")).status).toBe(404);
    expect((await follow(dave, "task", taskId, "DELETE")).status).toBe(404);
    // 反探测后没有留下任何痕迹
    expect(await auditRows("follow.created")).toEqual([]);
  });

  it("a comment notifies followers (comment.created) and nudges them once", async () => {
    const taskId = await seedTask(USERS.alice, USERS.bob);
    await follow(bob, "task", taskId, "PUT");

    const posted = await postComment(alice, {
      subjectType: "task",
      subjectId: taskId,
      body: "Draft looks good to ship.",
    });
    expect(posted.status).toBe(201);
    expect(posted.notifiedFollowers).toBe(1);

    const bobNotes = await notificationsFor(USERS.bob);
    expect(bobNotes).toHaveLength(1);
    expect(bobNotes[0]?.eventType).toBe("comment.created");
    expect(bobNotes[0]?.aggregateId).toBe(taskId);
    expect(bobNotes[0]?.payload.actorName).toBe("Alice");
    // 作者本人没有通知；催信号只发给拿到通知的人
    expect(await notificationsFor(USERS.alice)).toEqual([]);
    expect(nudged).toEqual([[USERS.bob]]);
  });

  it("a mention wins over the follower fan-out: one notification per person", async () => {
    const taskId = await seedTask(USERS.alice, USERS.bob);
    await follow(alice, "task", taskId, "PUT");
    await follow(bob, "task", taskId, "PUT");

    // bob 评论并 @Alice：alice 已被提及，关注扇出不再补发
    const posted = await postComment(bob, {
      subjectType: "task",
      subjectId: taskId,
      body: "Ping @Alice for the final call.",
    });
    expect(posted.status).toBe(201);
    expect(posted.notifiedFollowers).toBe(0);

    const aliceNotes = await notificationsFor(USERS.alice);
    expect(aliceNotes).toHaveLength(1);
    expect(aliceNotes[0]?.eventType).toBe("comment.mentioned");
    expect(await notificationsFor(USERS.bob)).toEqual([]);
  });

  it("a stale follower (visibility shrank) is never notified", async () => {
    const taskId = await seedTask(USERS.alice, USERS.bob);
    await follow(bob, "task", taskId, "PUT");

    // 改派给 dan：可见者缩成 alice + dan，bob 的关注变成陈旧行
    const patched = await app.request(`/api/tasks/${taskId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...alice },
      body: JSON.stringify({ assigneeId: USERS.dan }),
    });
    expect(patched.status).toBe(200);

    const posted = await postComment(alice, {
      subjectType: "task",
      subjectId: taskId,
      body: "Reassigned, heads up.",
    });
    expect(posted.status).toBe(201);
    expect(posted.notifiedFollowers).toBe(0);
    // 陈旧关注者 bob 不越过门；dan 没关注也不收（他名下此刻只有改派自带的
    // task.assigned 通知，没有评论投递）
    expect(await notificationsFor(USERS.bob)).toEqual([]);
    const danBefore = await notificationsFor(USERS.dan);
    expect(danBefore.some((row) => row.eventType.startsWith("comment."))).toBe(false);

    // dan 关注后，下一条评论落到他头上
    await follow(dan, "task", taskId, "PUT");
    const second = await postComment(alice, {
      subjectType: "task",
      subjectId: taskId,
      body: "Second note.",
    });
    expect(second.notifiedFollowers).toBe(1);
    // dan 名下是改派自带的 task.assigned + 这一条评论投递
    const danNotes = (await notificationsFor(USERS.dan)).filter((row) =>
      row.eventType.startsWith("comment."),
    );
    expect(danNotes).toHaveLength(1);
    expect(danNotes[0]?.eventType).toBe("comment.created");
  });

  it("the author does not get notified about their own comment even when following", async () => {
    const taskId = await seedTask(USERS.alice, USERS.bob);
    await follow(alice, "task", taskId, "PUT");
    const posted = await postComment(alice, {
      subjectType: "task",
      subjectId: taskId,
      body: "Note to self.",
    });
    expect(posted.status).toBe(201);
    expect(posted.notifiedFollowers).toBe(0);
    expect(await notificationsFor(USERS.alice)).toEqual([]);
  });
});

/** 同一实例上连 maintenance 库（postgres）用的管理连接串。 */
function adminUrl(databaseUrl: string | undefined): string {
  if (databaseUrl === undefined) return "";
  const url = new URL(databaseUrl);
  url.pathname = "/postgres";
  return url.toString();
}
