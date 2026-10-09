import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import pino from "pino";
import { afterAll, describe, expect, it } from "vitest";
import { createDb, schema, type Db } from "@ally/db";
import { createApp } from "../app.ts";
import { clientIpFromHeaders, consumeRateLimit, resolveAuthRateLimitRule, windowStartFor } from "./rate-limit.ts";

/**
 * 限流内核测试（#27 切片 1）。纯函数单测离库；集成部分用真实 PG——多实例
 * 共享计数（验收第 1 条）的结构前提就是同一张表，两个 createApp 实例共库
 * 交替发请求是最接近部署形态的证法。标识用每次运行随机的「IP」，套件之间
 * 互不污染（计数行按标识 + 窗口分键）。
 */

const logger = pino({ level: "silent" });

function headersOf(entries: Record<string, string>): Headers {
  const h = new Headers();
  for (const [k, v] of Object.entries(entries)) h.set(k, v);
  return h;
}

describe("clientIpFromHeaders (header trust rule)", () => {
  it("cf-connecting-ip wins over x-forwarded-for", () => {
    expect(
      clientIpFromHeaders(headersOf({ "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "198.51.100.1, 10.0.0.2" })),
    ).toBe("203.0.113.7");
  });

  it("takes the LAST x-forwarded-for element (closest trusted hop)", () => {
    expect(clientIpFromHeaders(headersOf({ "x-forwarded-for": "198.51.100.1, 198.51.100.2, 10.0.0.9" }))).toBe(
      "10.0.0.9",
    );
  });

  it("trims whitespace", () => {
    expect(clientIpFromHeaders(headersOf({ "x-forwarded-for": "  198.51.100.5  " }))).toBe("198.51.100.5");
  });

  it("missing and empty headers are unattributable", () => {
    expect(clientIpFromHeaders(headersOf({}))).toBeUndefined();
    expect(clientIpFromHeaders(headersOf({ "x-forwarded-for": "" }))).toBeUndefined();
    expect(clientIpFromHeaders(headersOf({ "x-forwarded-for": ", ," }))).toBeUndefined();
    expect(clientIpFromHeaders(headersOf({ "cf-connecting-ip": "  " }))).toBeUndefined();
  });

  it("binds identifier length at 100 chars (verbatim storage, no normalization)", () => {
    const long = "a".repeat(140);
    expect(clientIpFromHeaders(headersOf({ "cf-connecting-ip": long }))).toHaveLength(100);
  });
});

describe("windowStartFor (fixed window bucketing)", () => {
  it("aligns buckets to the epoch", () => {
    const nowMs = 1_700_000_012_345;
    const start = windowStartFor(nowMs, 60_000).getTime();
    expect(start % 60_000).toBe(0);
    expect(start).toBeLessThanOrEqual(nowMs);
    expect(nowMs - start).toBeLessThan(60_000);
  });

  it("two times in one window share a bucket; adjacent windows differ", () => {
    const windowMs = 5 * 60_000;
    const a = windowStartFor(0, windowMs);
    const b = windowStartFor(windowMs - 1, windowMs);
    const c = windowStartFor(windowMs, windowMs);
    expect(a.getTime()).toBe(b.getTime());
    expect(c.getTime()).toBe(a.getTime() + windowMs);
  });
});

describe("resolveAuthRateLimitRule (auth surface rule registry)", () => {
  it("maps credential-stuffing and email-bombing surfaces to their own actions", () => {
    expect(resolveAuthRateLimitRule("POST", "/api/auth/sign-in/email")?.action).toBe("auth.sign-in");
    expect(resolveAuthRateLimitRule("POST", "/api/auth/sign-in/social")?.action).toBe("auth.sign-in");
    expect(resolveAuthRateLimitRule("POST", "/api/auth/sign-up/email")?.action).toBe("auth.sign-up");
    expect(resolveAuthRateLimitRule("POST", "/api/auth/request-password-reset")?.action).toBe("auth.password-reset");
    expect(resolveAuthRateLimitRule("POST", "/api/auth/reset-password/some-token")?.action).toBe("auth.password-reset");
    expect(resolveAuthRateLimitRule("POST", "/api/auth/two-factor/verify-totp")?.action).toBe("auth.two-factor");
  });

  it("unmatched auth POSTs fall through to the backstop", () => {
    expect(resolveAuthRateLimitRule("POST", "/api/auth/whatever-else")?.action).toBe("auth.other");
  });

  it("GETs and non-auth paths are unlimited here", () => {
    expect(resolveAuthRateLimitRule("GET", "/api/auth/get-session")).toBeUndefined();
    expect(resolveAuthRateLimitRule("POST", "/api/tasks")).toBeUndefined();
  });
});

describe.skipIf(!process.env.DATABASE_URL)("consumeRateLimit (integration)", () => {
  const { db, pool } = createDb(process.env.DATABASE_URL ?? "");
  afterAll(async () => {
    await pool.end();
  });

  it("counts atomically and denies past the limit; fresh window starts over", async () => {
    const action = `test.consume.${randomUUID()}`;
    const identifier = randomUUID();
    const windowStart = windowStartFor(Date.now(), 60_000);
    const args = { identifierType: "ip", identifier, action, windowStart, limit: 2 };

    const first = await consumeRateLimit(db, { ...args, now: new Date() });
    const second = await consumeRateLimit(db, { ...args, now: new Date() });
    const third = await consumeRateLimit(db, { ...args, now: new Date() });

    expect(first).toEqual({ allowed: true, count: 1 });
    expect(second).toEqual({ allowed: true, count: 2 });
    expect(third).toEqual({ allowed: false, count: 3 });

    const nextWindow = await consumeRateLimit(db, {
      ...args,
      windowStart: new Date(windowStart.getTime() + 60_000),
      now: new Date(),
    });
    expect(nextWindow).toEqual({ allowed: true, count: 1 });
  });
});

describe.skipIf(!process.env.DATABASE_URL)("auth surface rate limiting (#27, integration)", () => {
  const { db, pool } = createDb(process.env.DATABASE_URL ?? "");
  afterAll(async () => {
    await pool.end();
  });

  /** 两个共享同一 PG 的 app 实例：部署里两台机器的替身（验收第 1 条） */
  function fakeAppDeps(sharedDb: Db, handlerCalls: string[]) {
    return {
      logger,
      corsOrigins: ["http://localhost:5173"],
      db: sharedDb,
      checkDatabase: async () => {},
      authHandler: (request: Request) => {
        handlerCalls.push(new URL(request.url).pathname);
        return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      },
      resolveSession: () => Promise.resolve(null),
      socialProviders: [],
      authzStore: {
        getRoles: () => Promise.resolve([]),
        getDirectPermissions: () => Promise.resolve([]),
        grantRole: () => Promise.reject(new Error("not used")),
        revokeRole: () => Promise.reject(new Error("not used")),
      },
      notifyUsers: () => Promise.resolve(),
      storage: {
        put: () => Promise.reject(new Error("storage not used in this suite")),
        signedGetUrl: () => Promise.reject(new Error("storage not used in this suite")),
        signedPutUrl: () => Promise.reject(new Error("storage not used in this suite")),
        delete: () => Promise.reject(new Error("storage not used in this suite")),
      },
      stripe: undefined,
      paypal: undefined,
      sendPasswordSetupEmail: () => Promise.resolve(),
    };
  }

  async function signIn(app: ReturnType<typeof createApp>, ip: string): Promise<Response> {
    return app.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "x-forwarded-for": ip },
    });
  }

  it("counts across instances on one shared window: 30 in, the 31st from either is 429", async () => {
    const handlerCalls: string[] = [];
    const appA = createApp(fakeAppDeps(db, handlerCalls));
    const appB = createApp(fakeAppDeps(db, handlerCalls));
    const ip = `10.77.1.${randomUUID().slice(0, 8)}`; // 每次运行唯一，套件间零污染
    const neighborIp = `10.77.2.${randomUUID().slice(0, 8)}`;

    // 30 个请求在两个实例间交替：共享窗口累计到阈值，全部放行
    const responses: Response[] = [];
    for (let i = 0; i < 30; i += 1) {
      responses.push(await signIn(i % 2 === 0 ? appA : appB, ip));
    }
    expect(responses.every((r) => r.status === 200)).toBe(true);

    // 第 31 个：无论打在哪个实例上都被拒——实例间没有各自的「30」
    const denied = await signIn(appB, ip);
    expect(denied.status).toBe(429);
    expect(await denied.json()).toEqual({ error: "rate_limited" });
    const retryAfter = denied.headers.get("retry-after");
    expect(retryAfter).not.toBeNull();
    expect(Number(retryAfter)).toBeGreaterThanOrEqual(1);
    expect(Number(retryAfter)).toBeLessThanOrEqual(300);

    // 换一个可归因来源：同一动作同一窗口，别的 IP 不受牵连
    expect((await signIn(appA, neighborIp)).status).toBe(200);

    // GET 不在限内：阈值耗尽后照常穿透到认证处理器
    const before = handlerCalls.length;
    const getSession = await appA.request("/api/auth/get-session", {
      method: "GET",
      headers: { "x-forwarded-for": ip },
    });
    expect(getSession.status).toBe(200);
    expect(handlerCalls).toHaveLength(before + 1);

    // 拒绝台账（app 层限流器才有的持久拒绝记录）：一行事实 + request_id 可对账
    const denials = await db
      .select()
      .from(schema.rateLimitDenials)
      .where(and(eq(schema.rateLimitDenials.identifier, ip), eq(schema.rateLimitDenials.action, "auth.sign-in")));
    expect(denials).toHaveLength(1);
    expect(denials[0]?.countAtDenial).toBe(31);
    expect(denials[0]?.limitValue).toBe(30);
    expect(denials[0]?.requestId).not.toBeNull();
    expect(denials[0]?.requestId).not.toBe("");

    // 无可归因 IP 的请求不计数、照常通过（fail open 的老裁决）：该来源的
    // 计数在请求前后零变化——不会长出「unknown」之类的共享桶
    const window = windowStartFor(Date.now(), 5 * 60_000);
    const countForIp = async () => {
      const rows = await db
        .select({ requestCount: schema.rateLimitCounters.requestCount })
        .from(schema.rateLimitCounters)
        .where(and(eq(schema.rateLimitCounters.identifier, ip), eq(schema.rateLimitCounters.windowStart, window)));
      return rows[0]?.requestCount;
    };
    const countBefore = await countForIp();
    expect(countBefore).toBe(31); // 30 放行 + 1 拒绝照计数
    const unattributable = await appA.request("/api/auth/sign-in/email", { method: "POST", headers: {} });
    expect(unattributable.status).toBe(200);
    expect(await countForIp()).toBe(countBefore);
  });
});
