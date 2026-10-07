import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import pino from "pino";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb, runMigrations, schema } from "@ally/db";
import { createApp } from "../app.ts";
import type { SessionData } from "../auth/session.ts";

// 集成测试：需要真实 PostgreSQL（通知行按用户隔离读写）。未设 DATABASE_URL 跳过。
const databaseUrl = process.env.DATABASE_URL;

const logger = pino({ level: "silent" });

const userA = randomUUID();
const userB = randomUUID();

function sessionFor(userId: string): SessionData {
  return {
    user: {
      id: userId,
      email: `${userId}@example.com`,
      name: "Operator",
      emailVerified: true,
      twoFactorEnabled: true,
    },
    session: { id: `s-${userId}`, userId, expiresAt: new Date(Date.now() + 3_600_000) },
  };
}

describe.skipIf(!databaseUrl)("notification endpoints (#129, integration)", () => {
  const { db, pool } = createDb(databaseUrl ?? "");
  const app = createApp({
    stripe: undefined,
    paypal: undefined,
    logger,
    db,
    corsOrigins: ["http://localhost:5173"],
    checkDatabase: async () => {
      await pool.query("select 1");
    },
    authHandler: () => Promise.reject(new Error("auth handler should not be called")),
    resolveSession: (headers) => {
      const who = headers.get("x-test-user");
      if (who !== "A" && who !== "B") return Promise.resolve(null);
      return Promise.resolve(sessionFor(who === "B" ? userB : userA));
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
  
    notifyUsers: async () => {},});

  beforeAll(async () => {
    await runMigrations(db);
    await db.insert(schema.authUser).values([
      { id: userA, name: "A", email: "a@example.com", emailVerified: true },
      { id: userB, name: "B", email: "b@example.com", emailVerified: true },
    ]);
  });

  afterEach(async () => {
    await db.delete(schema.notifications);
    await db.delete(schema.notificationPreferences);
  });

  afterAll(async () => {
    await db.delete(schema.authUser).where(eq(schema.authUser.id, userA));
    await db.delete(schema.authUser).where(eq(schema.authUser.id, userB));
    await pool.end();
  });

  async function insertRow(userId: string, over: Partial<{ isRead: boolean }> = {}) {
    const rows = await db
      .insert(schema.notifications)
      .values({ userId, eventType: "test.event", payload: { title: "Hello" }, ...over })
      .returning({ id: schema.notifications.id });
    const id = rows[0]?.id;
    if (id === undefined) throw new Error("insert failed");
    return id;
  }

  it("未登录 401", async () => {
    const res = await app.request("/api/notifications/summary");
    expect(res.status).toBe(401);
  });

  it("summary 只返回本人的行，未读数封顶 21，最近倒序最多 20 行", async () => {
    for (let i = 0; i < 25; i++) {
      await db
        .insert(schema.notifications)
        .values({ userId: userA, eventType: "test.event", payload: {} });
    }
    await insertRow(userB);
    const res = await app.request("/api/notifications/summary", {
      headers: { "x-test-user": "A" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { recent: unknown[]; unreadCount: number };
    expect(body.recent).toHaveLength(20);
    expect(body.unreadCount).toBe(21);
  });

  it("已读：本人行置位；别人的 id 静默 no-op（200，不动数据）", async () => {
    const own = await insertRow(userA);
    await insertRow(userB);

    const stranger = await app.request(`/api/notifications/${own}/read`, {
      method: "POST",
      headers: { "x-test-user": "B" },
    });
    expect(stranger.status).toBe(200);
    expect(await stranger.json()).toEqual({ marked: 0 });
    const untouched = await db
      .select({ isRead: schema.notifications.isRead })
      .from(schema.notifications)
      .where(eq(schema.notifications.id, own));
    expect(untouched[0]?.isRead).toBe(false);

    const mine = await app.request(`/api/notifications/${own}/read`, {
      method: "POST",
      headers: { "x-test-user": "A" },
    });
    expect(await mine.json()).toEqual({ marked: 1 });
    const after = await db
      .select({ isRead: schema.notifications.isRead, readAt: schema.notifications.readAt })
      .from(schema.notifications)
      .where(eq(schema.notifications.id, own));
    expect(after[0]?.isRead).toBe(true);
    expect(after[0]?.readAt).toBeInstanceOf(Date);
  });

  it("已读：畸形 id 400", async () => {
    const res = await app.request("/api/notifications/not-a-uuid/read", {
      method: "POST",
      headers: { "x-test-user": "A" },
    });
    expect(res.status).toBe(400);
  });

  it("read-all 只清本人的未读，返回真实条数", async () => {
    await insertRow(userA);
    await insertRow(userA, { isRead: true });
    await insertRow(userB);

    const res = await app.request("/api/notifications/read-all", {
      method: "POST",
      headers: { "x-test-user": "A" },
    });
    expect(await res.json()).toEqual({ marked: 1 });
    const stillUnreadB = await db
      .select({ id: schema.notifications.id, isRead: schema.notifications.isRead })
      .from(schema.notifications)
      .where(eq(schema.notifications.userId, userB));
    expect(stillUnreadB[0]?.isRead).toBe(false);
  });

  it("偏好（#116）：没建行 = 全默认，GET 不写行", async () => {
    const res = await app.request("/api/notifications/preferences", {
      headers: { "x-test-user": "A" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ emailDigest: false, updatedAt: null });
    const rows = await db.select().from(schema.notificationPreferences);
    expect(rows).toHaveLength(0);
  });

  it("偏好（#116）：PUT 落库并可反复改（upsert 同一行）", async () => {
    const put = await app.request("/api/notifications/preferences", {
      method: "PUT",
      headers: { "content-type": "application/json", "x-test-user": "A" },
      body: JSON.stringify({ emailDigest: true }),
    });
    expect(put.status).toBe(200);
    const echoed = (await put.json()) as { emailDigest: boolean; updatedAt: string | null };
    expect(echoed.emailDigest).toBe(true);
    expect(typeof echoed.updatedAt).toBe("string");

    const afterOn = await app.request("/api/notifications/preferences", {
      headers: { "x-test-user": "A" },
    });
    const afterOnBody = (await afterOn.json()) as { emailDigest: boolean; updatedAt: string | null };
    expect(afterOnBody.emailDigest).toBe(true);
    expect(typeof afterOnBody.updatedAt).toBe("string");

    const putOff = await app.request("/api/notifications/preferences", {
      method: "PUT",
      headers: { "content-type": "application/json", "x-test-user": "A" },
      body: JSON.stringify({ emailDigest: false }),
    });
    const offBody = (await putOff.json()) as { emailDigest: boolean; updatedAt: string | null };
    expect(offBody.emailDigest).toBe(false);
    expect(typeof offBody.updatedAt).toBe("string");

    // 整份替换语义：翻两次还是自己的一行，不涨行
    const rows = await db
      .select()
      .from(schema.notificationPreferences)
      .where(eq(schema.notificationPreferences.userId, userA));
    expect(rows).toHaveLength(1);
  });

  it("偏好（#116）：按会话隔离——A 开摘要，B 仍是默认", async () => {
    await app.request("/api/notifications/preferences", {
      method: "PUT",
      headers: { "content-type": "application/json", "x-test-user": "A" },
      body: JSON.stringify({ emailDigest: true }),
    });
    const res = await app.request("/api/notifications/preferences", {
      headers: { "x-test-user": "B" },
    });
    expect(await res.json()).toEqual({ emailDigest: false, updatedAt: null });
  });

  it("偏好（#116）：畸形请求体 400（缺字段 / 类型错 / 非对象）", async () => {
    for (const body of [undefined, "{}", '{"emailDigest": "yes"}', "[true]", '{"emailDigest": true, "extra": 1}']) {
      const res = await app.request("/api/notifications/preferences", {
        method: "PUT",
        headers: { "content-type": "application/json", "x-test-user": "A" },
        ...(body === undefined ? {} : { body }),
      });
      expect(res.status).toBe(400);
    }
  });
});
