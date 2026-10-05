import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, runMigrations, schema } from "@ally/db";
import { createApp } from "../app.ts";
import type { SessionData } from "../auth/session.ts";
import { mentionsName } from "./comments.ts";

// 集成测试：需要真实 PostgreSQL（行属门、审计同事务、提及扇出通知）。
// 未设 DATABASE_URL 时跳过。
//
// 本文件用**独立的临时库**（每次运行新建、跑完 drop）：断言 notifications /
// audit_events 的精确行数与 comments 的精确状态，共享库上其他文件的清理会随机
// 干扰（样板：routes/audit-events.test.ts）。临时库整体生灭，TRUNCATE 是本文件
// 自己的清库通道，不与并行文件互相干扰。
const databaseUrl = process.env.DATABASE_URL;

const logger = pino({ level: "silent" });

/** alice/bob 是员工（任务的可见者），carol 只有 customer 角色，dave 零角色 */
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

describe.skipIf(!databaseUrl)("comment endpoints (#110 slice 1, integration)", () => {
  const dbName = `comments_test_${String(Date.now())}_${String(process.pid)}`;
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
    // 整库是本文件的：四张表每条测试前清空
    await db.execute(sql`truncate table ${schema.comments}`);
    await db.execute(sql`truncate table ${schema.tasks}`);
    await db.execute(sql`truncate table ${schema.notifications}`);
    await db.execute(sql`truncate table ${schema.auditEvents}`);
  });

  afterAll(async () => {
    await pool.end();
    // 库随测试生灭：即便断言中途失败也不留跨运行垃圾
    await admin.pool.query(`drop database if exists "${dbName}" with (force)`);
    await admin.pool.end();
  });

  const alice = { "x-test-user": "alice" };
  const bob = { "x-test-user": "bob" };

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

  interface CommentRow {
    id: string;
    subjectType: string;
    subjectId: string;
    body: string;
    author: { id: string; name: string } | null;
    createdAt: string;
  }

  async function listComments(
    headers: Record<string, string>,
    subjectType: string,
    subjectId: string,
    query = "",
  ): Promise<{ status: number; comments: CommentRow[]; total: number }> {
    const res = await app.request(
      `/api/comments?subjectType=${subjectType}&subjectId=${subjectId}${query}`,
      { headers },
    );
    const json = (await res.json()) as { comments?: CommentRow[]; total?: number };
    return { status: res.status, comments: json.comments ?? [], total: json.total ?? 0 };
  }

  async function postComment(
    headers: Record<string, string>,
    body: Record<string, unknown>,
  ): Promise<{ status: number; comment: CommentRow | null; mentioned: { id: string }[] }> {
    const res = await app.request("/api/comments", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { comment?: CommentRow | null; mentioned?: { id: string }[] };
    return { status: res.status, comment: json.comment ?? null, mentioned: json.mentioned ?? [] };
  }

  async function notificationsFor(userId: string): Promise<
    { eventType: string; aggregateType: string | null; aggregateId: string | null; payload: Record<string, unknown> }[]
  > {
    return db
      .select({
        eventType: schema.notifications.eventType,
        aggregateType: schema.notifications.aggregateType,
        aggregateId: schema.notifications.aggregateId,
        payload: schema.notifications.payload,
      })
      .from(schema.notifications)
      .where(eq(schema.notifications.userId, userId));
  }

  async function auditRows(action?: string): Promise<{ action: string; detail: unknown }[]> {
    return db
      .select({ action: schema.auditEvents.action, detail: schema.auditEvents.detail })
      .from(schema.auditEvents)
      .where(action === undefined ? sql`true` : eq(schema.auditEvents.action, action));
  }

  it("lists a task's comments in conversation order with an exact total; paging is offset-based", async () => {
    const taskId = await seedTask(USERS.alice, USERS.bob);
    for (const text of ["first", "second", "third"]) {
      const made = await postComment(bob, { subjectType: "task", subjectId: taskId, body: text });
      expect(made.status).toBe(201);
    }
    const page = await listComments(alice, "task", taskId, "&limit=2&offset=1");
    expect(page.status).toBe(200);
    expect(page.total).toBe(3);
    expect(page.comments.map((row) => row.body)).toEqual(["second", "third"]);
    expect(page.comments[0]?.author?.name).toBe("Bob");
  });

  it("404s a subject the caller cannot see, and 400s an unregistered subject type", async () => {
    const taskId = await seedTask(USERS.alice, USERS.bob);
    // 行属之外（carol 不是这张任务的任何人；dave 零角色）拿不到探测结论
    expect((await listComments({ "x-test-user": "carol" }, "task", taskId)).status).toBe(404);
    expect((await listComments({ "x-test-user": "dave" }, "task", taskId)).status).toBe(404);
    expect((await listComments(alice, "task", randomUUID())).status).toBe(404);
    // 未注册的 subject 类型在门口就被拒（注册表在代码，扩张随业务域切片）
    const unregistered = await app.request(
      `/api/comments?subjectType=quote&subjectId=${taskId}`,
      { headers: alice },
    );
    expect(unregistered.status).toBe(400);
  });

  it("a mention in the body notifies the mentioned viewer with facts for the deep link", async () => {
    const taskId = await seedTask(USERS.alice, USERS.bob);
    const made = await postComment(bob, {
      subjectType: "task",
      subjectId: taskId,
      body: "@Alice can you double-check the claim? thanks",
    });
    expect(made.status).toBe(201);
    expect(made.mentioned).toEqual([{ id: USERS.alice, name: "Alice" }]);
    const rows = await notificationsFor(USERS.alice);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.eventType).toBe("comment.mentioned");
    expect(rows[0]?.aggregateType).toBe("task");
    expect(rows[0]?.aggregateId).toBe(taskId);
    expect(rows[0]?.payload.taskTitle).toBe("Review label copy");
    expect(rows[0]?.payload.commentId).toBe(made.comment?.id);
    expect(rows[0]?.payload.actorName).toBe("Bob");
    expect(rows[0]?.payload.excerpt).toBe("@Alice can you double-check the claim? thanks");
    // 同一事务里有审计；mentioned 名单进 detail
    const audits = await auditRows("comment.created");
    expect(audits).toHaveLength(1);
    expect(audits[0]?.detail).toMatchObject({
      subjectType: "task",
      subjectId: taskId,
      mentioned: [USERS.alice],
    });
  });

  it("mentions resolve only against the subject's viewers: outsiders and prose never notify", async () => {
    const taskId = await seedTask(USERS.alice, USERS.bob);
    // 圈外人名字不是可见者，永不匹配
    const toOutsider = await postComment(bob, {
      subjectType: "task",
      subjectId: taskId,
      body: "carol from the customer team will join later",
    });
    expect(toOutsider.mentioned).toEqual([]);
    expect(await notificationsFor(USERS.carol)).toHaveLength(0);
    // 更长的词不是命中（@alice 之后紧跟字母 = 别的词）
    const longer = await postComment(bob, {
      subjectType: "task",
      subjectId: taskId,
      body: "we should alicia-check this… and @AliceS is not Alice either",
    });
    expect(longer.mentioned).toEqual([]);
    // 提到自己不通知自己；无提及则通知表零行
    const selfMention = await postComment(bob, {
      subjectType: "task",
      subjectId: taskId,
      body: "note to self: @Bob closes this tomorrow",
    });
    expect(selfMention.status).toBe(201);
    expect(selfMention.mentioned).toEqual([]);
    expect(await notificationsFor(USERS.bob)).toHaveLength(0);
    expect(await notificationsFor(USERS.alice)).toHaveLength(0);
  });

  it("mentions are case-insensitive and both viewers can be named in one comment", async () => {
    const taskId = await seedTask(USERS.alice, USERS.bob);
    const made = await postComment(alice, {
      subjectType: "task",
      subjectId: taskId,
      body: "sync: @alice notes archived, @BOB please pick this up",
    });
    // alice 是作者，@alice 是行文不通知；bob 全大写也命中
    expect(made.mentioned).toEqual([{ id: USERS.bob, name: "Bob" }]);
    expect(await notificationsFor(USERS.alice)).toHaveLength(0);
    expect(await notificationsFor(USERS.bob)).toHaveLength(1);
  });

  it("posting outside the viewer set is a 404, and bodies are validated", async () => {
    const taskId = await seedTask(USERS.alice, USERS.bob);
    expect(
      (await postComment({ "x-test-user": "carol" }, { subjectType: "task", subjectId: taskId, body: "hi" }))
        .status,
    ).toBe(404);
    expect((await postComment(alice, { subjectType: "task", subjectId: randomUUID(), body: "hi" })).status).toBe(404);
    expect((await postComment(alice, { subjectType: "task", subjectId: taskId, body: "  " })).status).toBe(400);
    expect(
      (await postComment(alice, { subjectType: "task", subjectId: taskId, body: "x".repeat(5001) })).status,
    ).toBe(400);
    expect((await postComment(alice, { subjectType: "wall", subjectId: taskId, body: "hi" })).status).toBe(400);
  });

  it("only the author can delete; other viewers get 403 and outsiders 404", async () => {
    const taskId = await seedTask(USERS.alice, USERS.bob);
    const made = await postComment(bob, { subjectType: "task", subjectId: taskId, body: "typo, removing" });
    const commentId = made.comment?.id;
    if (commentId === undefined) throw new Error("comment creation returned no id");
    // 同为可见者的 alice 删不了别人的评论：403 带码，不与 404 混
    const forbidden = await app.request(`/api/comments/${commentId}`, { method: "DELETE", headers: alice });
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ error: "forbidden", code: "author_only" });
    // 圈外人拿不到探测结论：404 与不存在同回答
    expect(
      (await app.request(`/api/comments/${commentId}`, { method: "DELETE", headers: { "x-test-user": "dave" } }))
        .status,
    ).toBe(404);
    expect(
      (await app.request(`/api/comments/${randomUUID()}`, { method: "DELETE", headers: bob })).status,
    ).toBe(404);
    // 作者删除成功：行没了，同事务留审计
    const ok = await app.request(`/api/comments/${commentId}`, { method: "DELETE", headers: bob });
    expect(ok.status).toBe(200);
    const left = await db.select({ id: schema.comments.id }).from(schema.comments).where(eq(schema.comments.id, commentId));
    expect(left).toHaveLength(0);
    const audits = await auditRows("comment.deleted");
    expect(audits).toHaveLength(1);
    expect(audits[0]?.detail).toMatchObject({ subjectType: "task", subjectId: taskId });
  });
});

describe("mentionsName (pure, #110 slice 1)", () => {
  it("matches @FullName case-insensitively at any position, including line starts", () => {
    expect(mentionsName("ping @Alice please", "Alice")).toBe(true);
    expect(mentionsName("@ALICE start of line", "Alice")).toBe(true);
    expect(mentionsName("two:\n@alice and @bob", "Alice")).toBe(true);
    expect(mentionsName("no mention here", "Alice")).toBe(false);
    expect(mentionsName("email alice@example.com", "Alice")).toBe(false);
  });

  it("respects word boundaries: a longer word containing the name is not a mention", () => {
    expect(mentionsName("alicia and @Alicia", "Alice")).toBe(false);
    expect(mentionsName("@Alice1 is a different token", "Alice")).toBe(false);
    // 名字后跟标点/结尾/换行都算命中
    expect(mentionsName("thanks @Alice!", "Alice")).toBe(true);
    expect(mentionsName("thanks @Alice.", "Alice")).toBe(true);
    expect(mentionsName("@Alice", "Alice")).toBe(true);
  });
});

function adminUrl(databaseUrl: string | undefined): string {
  if (databaseUrl === undefined) return "";
  const url = new URL(databaseUrl);
  url.pathname = "/postgres";
  return url.toString();
}
