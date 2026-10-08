import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import pino from "pino";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb, runMigrations, schema } from "@ally/db";
import { createApp } from "../app.ts";
import type { SessionData } from "../auth/session.ts";

// 集成测试：需要真实 PostgreSQL（落 feedback_reports、读回提交人快照）。
// 未设 DATABASE_URL 跳过。
const databaseUrl = process.env.DATABASE_URL;

const logger = pino({ level: "silent" });

const user = randomUUID();

function session(): SessionData {
  return {
    user: {
      id: user,
      email: "operator@example.com",
      name: "Operator O'Neil",
      emailVerified: true,
      twoFactorEnabled: true,
    },
    session: { id: `s-${user}`, userId: user, expiresAt: new Date(Date.now() + 3_600_000) },
  };
}

function makeApp() {
  const { db, pool } = createDb(databaseUrl ?? "");
  const app = createApp({
    stripe: undefined,
    sendPasswordSetupEmail: async () => {},
    paypal: undefined,
    logger,
    db,
    corsOrigins: ["http://localhost:5173"],
    checkDatabase: async () => {
      await pool.query("select 1");
    },
    authHandler: () => Promise.reject(new Error("auth handler should not be called")),
    resolveSession: (headers) =>
      Promise.resolve(headers.get("x-test-user") === "me" ? session() : null),
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
  return { app, db, pool };
}

describe.skipIf(!databaseUrl)("feedback submit endpoint (#129, integration)", () => {
  const { app, db, pool } = makeApp();

  beforeAll(async () => {
    await runMigrations(db);
    await db.insert(schema.authUser).values({
      id: user,
      name: "Operator O'Neil",
      email: "operator@example.com",
      emailVerified: true,
    });
  });

  afterEach(async () => {
    await db.delete(schema.feedbackReports);
  });

  afterAll(async () => {
    await db.delete(schema.authUser).where(eq(schema.authUser.id, user));
    await pool.end();
  });

  it("未登录 401", async () => {
    const res = await app.request("/api/feedback-reports", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "bug_report", title: "t", description: "d", priority: "low" }),
    });
    expect(res.status).toBe(401);
  });

  it("合法提交 201 + BR- 编号回执，提交人快照来自会话而非请求", async () => {
    const res = await app.request("/api/feedback-reports", {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-user": "me" },
      body: JSON.stringify({
        type: "bug_report",
        title: "  Quote totals double-count tax  ",
        description: "Steps in the description.",
        stepsToReproduce: "1. open quote 2. add row",
        priority: "high",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { reportNumber: string };
    expect(body.reportNumber).toMatch(/^BR-[0-9a-f]{8}$/);

    const [row] = await db.select().from(schema.feedbackReports);
    expect(row?.title).toBe("Quote totals double-count tax");
    expect(row?.status).toBe("pending");
    expect(row?.submittedByUserId).toBe(user);
    expect(row?.submitterName).toBe("Operator O'Neil");
    expect(row?.submitterEmail).toBe("operator@example.com");
  });

  it("非法体 400：未知类型 / 超 200 字标题 / 缺描述 / 未知优先级 / 坏 JSON", async () => {
    const base = { type: "bug_report", title: "t", description: "d", priority: "low" };
    const cases = [
      { ...base, type: "process_gap" },
      { ...base, title: "x".repeat(201) },
      { type: "bug_report", title: "t", priority: "low" },
      { ...base, priority: "urgent" },
    ];
    for (const body of cases) {
      const res = await app.request("/api/feedback-reports", {
        method: "POST",
        headers: { "content-type": "application/json", "x-test-user": "me" },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    }
    const garbage = await app.request("/api/feedback-reports", {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-user": "me" },
      body: "<html>spa fallback</html>",
    });
    expect(garbage.status).toBe(400);
  });

  it("stepsToReproduce 可省略", async () => {
    const res = await app.request("/api/feedback-reports", {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-user": "me" },
      body: JSON.stringify({
        type: "feature_request",
        title: "Bulk export invoices",
        description: "As a finance user…",
        priority: "medium",
      }),
    });
    expect(res.status).toBe(201);
    const [row] = await db.select().from(schema.feedbackReports);
    expect(row?.stepsToReproduce).toBeNull();
  });
});
