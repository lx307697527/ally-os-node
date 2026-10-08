import { randomUUID } from "node:crypto";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, runMigrations, schema } from "@ally/db";
import { createApp } from "../app.ts";
import type { SessionData } from "../auth/session.ts";

// 集成测试：需要真实 PostgreSQL（auth_session 行的真读）。未设 DATABASE_URL
// 时跳过。独立临时库：断言的是精确的令牌回还，不与并行文件互相干扰
// （样板：routes/comments.test.ts）。
const databaseUrl = process.env.DATABASE_URL;

const logger = pino({ level: "silent" });

const USER = randomUUID();
const SESSION_ID = randomUUID();
const EXPIRED_SESSION_ID = randomUUID();
const SESSION_TOKEN = "tok-first-segment";

function sessionFor(id: string): SessionData {
  return {
    user: {
      id: USER,
      email: "alice@example.com",
      name: "Alice",
      emailVerified: true,
      twoFactorEnabled: true,
    },
    session: { id, userId: USER, expiresAt: new Date(Date.now() + 3_600_000) },
  };
}

describe.skipIf(!databaseUrl)("realtime token endpoint (#110 slice 2, integration)", () => {
  const dbName = `realtime_test_${String(Date.now())}_${String(process.pid)}`;
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
  // 拆库瞬间的空闲连接被 57P01 强杀时，pg Pool 会把 FATAL 重发到 pool 对象
  // （样板：routes/comments.test.ts）。预期的拆除错误，吞掉。
  pool.on("error", () => {});

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
    resolveSession: (headers) => {
      // x-test-session 直接决定会话 id；"ghost" = 中间件放行但库里没有这行，
      // "expired" = 库里有但已过期
      const which = headers.get("x-test-session") ?? "live";
      if (which === "anon") return Promise.resolve(null);
      if (which === "ghost") return Promise.resolve(sessionFor(randomUUID()));
      if (which === "expired") return Promise.resolve(sessionFor(EXPIRED_SESSION_ID));
      return Promise.resolve(sessionFor(SESSION_ID));
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
    notifyUsers: async () => {},
  });

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("unreachable: suite is skipped without DATABASE_URL");
    await admin.pool.query(`create database "${dbName}"`);
    await runMigrations(db);
    await db
      .insert(schema.authUser)
      .values({ id: USER, name: "Alice", email: "alice@example.com", emailVerified: true });
    await db.insert(schema.authSession).values({
      id: SESSION_ID,
      userId: USER,
      token: SESSION_TOKEN,
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    await db.insert(schema.authSession).values({
      id: EXPIRED_SESSION_ID,
      userId: USER,
      token: "tok-expired",
      expiresAt: new Date(Date.now() - 1_000),
    });
  });

  afterAll(async () => {
    await pool.end();
    await admin.pool.query(`drop database if exists "${dbName}" with (force)`);
    await admin.pool.end();
  });

  it("发还调用者自己会话的令牌（WS auth 帧的取数通道）", async () => {
    const res = await app.request("/api/realtime/token", {
      headers: { "x-test-session": "live" },
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as { token: string }).toEqual({ token: SESSION_TOKEN });
  });

  it("未登录 401；中间件放行但会话行已没了/过期也是 401", async () => {
    const anon = await app.request("/api/realtime/token", {
      headers: { "x-test-session": "anon" },
    });
    expect(anon.status).toBe(401);

    const ghost = await app.request("/api/realtime/token", {
      headers: { "x-test-session": "ghost" },
    });
    expect(ghost.status).toBe(401);

    const expired = await app.request("/api/realtime/token", {
      headers: { "x-test-session": "expired" },
    });
    expect(expired.status).toBe(401);
  });
});

function adminUrl(databaseUrl: string | undefined): string {
  if (databaseUrl === undefined) return "";
  const url = new URL(databaseUrl);
  url.pathname = "/postgres";
  return url.toString();
}
