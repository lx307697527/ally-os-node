import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import pino from "pino";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb, runMigrations, schema } from "@ally/db";
import { createApp } from "../app.ts";
import type { SessionData } from "../auth/session.ts";
import type { Permission, Role } from "../authz/permissions.ts";
import type { AuthzStore } from "../authz/service.ts";
import { computeErrorFingerprint, ERROR_MESSAGE_MAX, ERROR_STACK_MAX } from "../errors/capture.ts";
import { ERROR_INGEST_RATE_LIMIT } from "./errors.ts";

// 集成测试：真实 PG（落 error_events、读回、限流内核真计数）。未设 DATABASE_URL
// 跳过。共享库上的清库范围：error_events / error_spikes 是本切片的新表整表清；
// rate_limit_* 是共表面，只清本套件的动作命名空间（errors.ingest），不碰别处。
const databaseUrl = process.env.DATABASE_URL;

const logger = pino({ level: "silent" });

const user = randomUUID();

function session(): SessionData {
  return {
    user: {
      id: user,
      email: "operator@example.com",
      name: "Operator",
      emailVerified: true,
      twoFactorEnabled: true,
    },
    session: { id: `s-${user}`, userId: user, expiresAt: new Date(Date.now() + 3_600_000) },
  };
}

function memoryStore(seed: Record<string, Role[]> = {}): AuthzStore {
  const roles: Record<string, Role[]> = { ...seed };
  return {
    async getRoles(userId) {
      await Promise.resolve();
      return roles[userId] ?? [];
    },
    async getDirectPermissions(): Promise<Permission[]> {
      await Promise.resolve();
      return [];
    },
    grantRole: () => Promise.reject(new Error("not used")),
    revokeRole: () => Promise.reject(new Error("not used")),
  };
}

function makeApp(roles: Role[] = []) {
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
    storage: {
      put: () => Promise.reject(new Error("storage not used in this suite")),
      signedGetUrl: () => Promise.reject(new Error("storage not used in this suite")),
      signedPutUrl: () => Promise.reject(new Error("storage not used in this suite")),
      delete: () => Promise.reject(new Error("storage not used in this suite")),
      head: () => Promise.reject(new Error("storage not used in this suite")),
    },
    authzStore: memoryStore({ [user]: roles }),
    notifyUsers: async () => {},
  });
  return { app, db, pool };
}

function post(app: Awaited<ReturnType<typeof makeApp>>["app"], body: unknown, source?: string) {
  return app.request("/api/errors", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(source === undefined ? {} : { "x-forwarded-for": source }),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe.skipIf(!databaseUrl)("error tracking kernel (#28, integration)", () => {
  const { app, db, pool } = makeApp(["owner"]);

  beforeAll(async () => {
    await runMigrations(db);
    // unhandled 500 的捕获要用一个必抛的路由：Hono 的 matcher 在首个请求后
    // 编译成型，路由必须在任何请求前注册
    app.get("/api/__boom", () => {
      throw new Error("kaboom: secret internals");
    });
  });

  afterEach(async () => {
    await db.delete(schema.errorEvents);
    await db.delete(schema.errorSpikes);
    await db
      .delete(schema.rateLimitCounters)
      .where(eq(schema.rateLimitCounters.action, ERROR_INGEST_RATE_LIMIT.action));
    await db
      .delete(schema.rateLimitDenials)
      .where(eq(schema.rateLimitDenials.action, ERROR_INGEST_RATE_LIMIT.action));
  });

  afterAll(async () => {
    await pool.end();
  });

  it("公开上报：无会话 202，行落库，指纹/UA/requestId 按服务端语义补齐", async () => {
    const stack = "Error: cart totals NaN\n    at Cart (cart.tsx:12:3)\n    at render";
    const res = await post(
      app,
      { message: "cart totals NaN", stack, url: "https://admin.example/invoices" },
      `ingest-${randomUUID()}`,
    );
    expect(res.status).toBe(202);

    const [row] = await db.select().from(schema.errorEvents);
    expect(row?.source).toBe("web");
    expect(row?.message).toBe("cart totals NaN");
    expect(row?.stack).toBe(stack);
    expect(row?.url).toBe("https://admin.example/invoices");
    expect(row?.fingerprint).toBe(
      computeErrorFingerprint({ source: "web", message: "cart totals NaN", stack }),
    );
    expect(row?.requestId).toBeTruthy();
  });

  it("UA 从请求头取（请求体声明不了），随行存储", async () => {
    const ua = "Mozilla/5.0 (test) error-reporter/1.0";
    const res = await app.request("/api/errors", {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": ua },
      body: JSON.stringify({ message: "boom" }),
    });
    expect(res.status).toBe(202);
    const [row] = await db.select().from(schema.errorEvents);
    expect(row?.userAgent).toBe(ua);
  });

  it("非法体 400：空 message / 超上限 message、stack / 坏 JSON", async () => {
    expect((await post(app, { message: "" })).status).toBe(400);
    expect((await post(app, { message: "x".repeat(ERROR_MESSAGE_MAX + 1) })).status).toBe(400);
    expect((await post(app, { message: "ok", stack: "y".repeat(ERROR_STACK_MAX + 1) })).status).toBe(400);
    expect((await post(app, "{not json")).status).toBe(400);
    const rows = await db.select().from(schema.errorEvents);
    expect(rows.length).toBe(0);
  });

  it(`限流：同源第 ${String(ERROR_INGEST_RATE_LIMIT.limit + 1)} 次 429 + Retry-After + 拒绝台账，换源不受牵连`, async () => {
    const src = `throttle-${randomUUID()}`;
    for (let i = 0; i < ERROR_INGEST_RATE_LIMIT.limit; i += 1) {
      const res = await post(app, { message: `err ${String(i)}` }, src);
      expect(res.status).toBe(202);
    }
    const denied = await post(app, { message: "over the line" }, src);
    expect(denied.status).toBe(429);
    expect(denied.headers.get("retry-after")).toBeTruthy();
    expect(await denied.json()).toEqual({ error: "rate_limited" });

    const denials = await db
      .select()
      .from(schema.rateLimitDenials)
      .where(eq(schema.rateLimitDenials.action, ERROR_INGEST_RATE_LIMIT.action));
    expect(denials.length).toBe(1);
    expect(denials[0]?.identifier).toBe(src);
    expect(denials[0]?.countAtDenial).toBe(ERROR_INGEST_RATE_LIMIT.limit + 1);

    const other = await post(app, { message: "different source" }, `other-${randomUUID()}`);
    expect(other.status).toBe(202);
  });

  it("不可归因（无来源头）不计数：超阈值也不会 429（#27 裁决 1）", async () => {
    for (let i = 0; i < ERROR_INGEST_RATE_LIMIT.limit + 3; i += 1) {
      const res = await post(app, { message: "no attribution" });
      expect(res.status).toBe(202);
    }
  });

  it("api 侧捕获：unhandled 500 进同一张表，requestId 与响应体一致，客户端只见 generic error", async () => {
    const res = await app.request("/api/__boom", {
      headers: { "x-test-user": "me" },
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; requestId: string };
    expect(body.error).toBe("internal_error");
    expect(body.requestId).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain("secret internals");

    const rows = await db.select().from(schema.errorEvents);
    expect(rows.length).toBe(1);
    expect(rows[0]?.source).toBe("api");
    expect(rows[0]?.message).toBe("kaboom: secret internals");
    expect(rows[0]?.url).toBe("/api/__boom");
    expect(rows[0]?.requestId).toBe(body.requestId);
    const apiStack = rows[0]?.stack;
    expect(rows[0]?.fingerprint).toBe(
      computeErrorFingerprint({
        source: "api",
        message: "kaboom: secret internals",
        ...(apiStack === null || apiStack === undefined ? {} : { stack: apiStack }),
      }),
    );
  });

  it("读面门禁：未登录 401，无 audit.read 403，owner 200", async () => {
    expect((await app.request("/api/error-events")).status).toBe(401);

    const { app: unprivileged, pool: unprivilegedPool } = makeApp([]);
    expect((await unprivileged.request("/api/error-events", { headers: { "x-test-user": "me" } })).status).toBe(
      403,
    );
    await unprivilegedPool.end();

    const ok = await app.request("/api/error-events", { headers: { "x-test-user": "me" } });
    expect(ok.status).toBe(200);
  });

  it("列表：最新在前、fingerprint/source 过滤、精确 total", async () => {
    const fpA = computeErrorFingerprint({ source: "web", message: "alpha" });
    const fpB = computeErrorFingerprint({ source: "api", message: "beta" });
    const t0 = new Date(Date.now() - 60_000);
    await db.insert(schema.errorEvents).values([
      { fingerprint: fpA, source: "web", message: "alpha", createdAt: t0 },
      { fingerprint: fpB, source: "api", message: "beta", createdAt: new Date(Date.now() - 30_000) },
      { fingerprint: fpA, source: "web", message: "alpha", createdAt: new Date() },
    ]);

    const all = await app.request("/api/error-events", { headers: { "x-test-user": "me" } });
    const allBody = (await all.json()) as { events: { message: string }[]; total: number };
    expect(allBody.total).toBe(3);
    expect(allBody.events.map((e) => e.message)).toEqual(["alpha", "beta", "alpha"]);

    const byFp = await app.request(`/api/error-events?fingerprint=${fpA}`, {
      headers: { "x-test-user": "me" },
    });
    const byFpBody = (await byFp.json()) as { total: number };
    expect(byFpBody.total).toBe(2);

    const bySource = await app.request("/api/error-events?source=api", {
      headers: { "x-test-user": "me" },
    });
    const bySourceBody = (await bySource.json()) as { total: number };
    expect(bySourceBody.total).toBe(1);

    const bad = await app.request("/api/error-events?source=carrier-pigeon", {
      headers: { "x-test-user": "me" },
    });
    expect(bad.status).toBe(400);
  });

  it("汇总：按指纹分组计数、最近样本、count 降序、窗口上限校验", async () => {
    const fpA = computeErrorFingerprint({ source: "web", message: "alpha" });
    const fpB = computeErrorFingerprint({ source: "api", message: "beta" });
    await db.insert(schema.errorEvents).values([
      { fingerprint: fpA, source: "web", message: "oldest alpha", createdAt: new Date(Date.now() - 120_000) },
      { fingerprint: fpA, source: "web", message: "alpha", createdAt: new Date(Date.now() - 60_000) },
      { fingerprint: fpA, source: "web", message: "newest alpha", createdAt: new Date() },
      { fingerprint: fpB, source: "api", message: "beta", createdAt: new Date() },
    ]);

    const res = await app.request("/api/error-events/summary?days=7&limit=10", {
      headers: { "x-test-user": "me" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      windowDays: number;
      groups: {
        fingerprint: string;
        source: string;
        count: number;
        firstSeen: string;
        lastSeen: string;
        sampleMessage: string;
      }[];
    };
    expect(body.windowDays).toBe(7);
    expect(body.groups.length).toBe(2);
    expect(body.groups[0]?.fingerprint).toBe(fpA);
    expect(body.groups[0]?.count).toBe(3);
    expect(body.groups[0]?.sampleMessage).toBe("newest alpha");
    expect(new Date(body.groups[0]?.firstSeen ?? "").getTime()).toBeLessThan(
      new Date(body.groups[0]?.lastSeen ?? "").getTime(),
    );
    expect(body.groups[1]?.count).toBe(1);

    expect(
      (await app.request("/api/error-events/summary?days=999", { headers: { "x-test-user": "me" } })).status,
    ).toBe(400);
  });
});
