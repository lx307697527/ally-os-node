import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, runMigrations, schema } from "@ally/db";
import { createApp } from "../app.ts";
import { createAuth, createSessionResolver } from "../auth/auth.ts";
import type { MailMessage } from "@ally/mailer";
import { createAuthzStore } from "../authz/service.ts";
import {
  RATE_LIMIT_DENIALS_PAGE_MAX,
  RATE_LIMIT_SUMMARY_DAYS_MAX,
} from "./rate-limit-denials.ts";

// 集成测试：需要真实 PostgreSQL（查询 rate_limit_denials + 权限点走真实 authz）。
// 未设 DATABASE_URL 时跳过。
//
// 本文件用**独立的临时库**（每次运行新建、跑完 drop）：断言精确 total，共享库
// 上并行文件的 TRUNCATE 会让它随机红（audit-events 同款裁决）。
const databaseUrl = process.env.DATABASE_URL;

const logger = pino({ level: "silent" });
const SECRET = "test-secret-0123456789abcdef0123456789abcdef";
const PASSWORD = "correct-horse-battery";

function must<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("unexpected missing value in test");
  return value;
}

function spyMailer() {
  const sent: MailMessage[] = [];
  return {
    sent,
    async send(message: MailMessage): Promise<void> {
      await Promise.resolve();
      sent.push(message);
    },
  };
}

interface Actor {
  userId: string;
  email: string;
}

describe.skipIf(!databaseUrl)("rate limit denials route (#27, integration)", () => {
  const dbName = `rate_limit_denials_test_${String(Date.now())}_${String(process.pid)}`;
  const admin = createDb(adminUrl(databaseUrl));
  const scopedUrl =
    databaseUrl === undefined ? "" : (() => {
      const url = new URL(databaseUrl);
      url.pathname = `/${dbName}`;
      return url.toString();
    })();
  const { db, pool } = createDb(scopedUrl);
  // 并行套件 drop … with (force) 的 57P01 会以 unhandled error 形式炸掉整个
  // vitest 进程；所有 scratch-DB 套件都带这道护栏
  pool.on("error", () => {});
  admin.pool.on("error", () => {});

  const mailer = spyMailer();
  const auth = createAuth({
    db,
    secret: SECRET,
    trustedOrigins: ["http://localhost:5173"],
    baseURL: undefined,
    webAppUrl: "https://admin.example",
    googleOAuth: undefined,
    mailer,
    logger,
  });
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
    authHandler: (request) => auth.handler(request),
    resolveSession: createSessionResolver(auth),
    socialProviders: [],
    // 本套件不 exercise 附件端点；真被调到会在这里大声炸（AppDeps.storage 必选）
    storage: {
      put: () => Promise.reject(new Error("storage not used in this suite")),
      signedGetUrl: () => Promise.reject(new Error("storage not used in this suite")),
      signedPutUrl: () => Promise.reject(new Error("storage not used in this suite")),
      delete: () => Promise.reject(new Error("storage not used in this suite")),
      head: () => Promise.reject(new Error("storage not used in this suite")),
    },
    authzStore: createAuthzStore(db),

    notifyUsers: async () => {},
  });

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("unreachable: suite is skipped without DATABASE_URL");
    // 标识符不能走参数绑定，名字是本进程拼出来的固定格式，注入面可控
    await admin.pool.query(`create database "${dbName}"`);
    await runMigrations(db);
  });

  beforeEach(async () => {
    await db.execute(sql`truncate table ${schema.rateLimitDenials}`);
  });

  afterAll(async () => {
    await pool.end();
    await admin.pool.query(`drop database if exists "${dbName}" with (force)`);
    await admin.pool.end();
  });

  async function signUpVerified(): Promise<Actor> {
    const email = `${randomUUID()}@example.com`;
    const signUp = await app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: PASSWORD, name: "Test User" }),
    });
    expect(signUp.status).toBe(200);
    const body = (await signUp.json()) as { user?: { id?: string } };
    const userId = must(body.user?.id);
    const token = must(/token=([^"&\s<]+)/.exec(must(mailer.sent.at(-1)).html)?.[1]);
    const confirm = await app.request(`/api/auth/verify-email?token=${encodeURIComponent(token)}`);
    expect(confirm.status).toBe(200);
    return { userId, email };
  }

  async function signInCookie(actor: Actor): Promise<string> {
    const res = await app.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: actor.email, password: PASSWORD }),
    });
    expect(res.status).toBe(200);
    const cookies = res.headers.getSetCookie().filter((c) =>
      c.startsWith("better-auth.session_token="),
    );
    return must(must(cookies[0]).split(";")[0]);
  }

  async function fixture(): Promise<{
    owner: Actor;
    sales: Actor;
    cookieFor: (actor: Actor) => Promise<string>;
  }> {
    const [owner, sales] = await Promise.all([signUpVerified(), signUpVerified()]);
    await db
      .insert(schema.userRole)
      .values([
        { userId: owner.userId, role: "owner" },
        { userId: sales.userId, role: "sales" },
      ])
      .onConflictDoNothing();
    const cookies = new Map<Actor, string>();
    const cookieFor = async (actor: Actor): Promise<string> => {
      const hit = cookies.get(actor);
      if (hit !== undefined) return hit;
      const fresh = await signInCookie(actor);
      cookies.set(actor, fresh);
      return fresh;
    };
    return { owner, sales, cookieFor };
  }

  /**
   * 播种确定的拒绝行：ip-1 三行（两行 sign-in、一行 sign-up），ip-2 两行
   * sign-in（其中一行落在 8 天前——汇总的 7 天窗口之外）。每行的
   * countAtDenial > limitValue（拒绝行自证「为什么拒」），阈值按各自动作的
   * 真实规则（sign-in 30/5min、sign-up 10/h）。直接插表而非走
   * recordRateLimitDenial：读面套件要控制 deniedAt（汇总窗口的时间轴），
   * 而生产写入方的 deniedAt 是列默认值（写库即现在），倒填不进去；生产方
   * 本身的形状由切片 1 的套件证明，这里只管给读面喂确定的事实。
   */
  async function seedDenials(): Promise<void> {
    const now = Date.now();
    const row = (
      identifier: string,
      action: string,
      count: number,
      limit: number,
      deniedAt: Date,
      requestId: string | undefined,
    ) =>
      db.insert(schema.rateLimitDenials).values({
        identifierType: "ip",
        identifier,
        action,
        windowStart: new Date(Math.floor(deniedAt.getTime() / (5 * 60_000)) * 5 * 60_000),
        countAtDenial: count,
        limitValue: limit,
        deniedAt,
        ...(requestId === undefined ? {} : { requestId }),
      });
    await row("203.0.113.10", "auth.sign-in", 31, 30, new Date(now - 60_000), "req-aaa");
    await row("203.0.113.10", "auth.sign-in", 32, 30, new Date(now - 30_000), undefined);
    await row("203.0.113.10", "auth.sign-up", 11, 10, new Date(now - 20_000), "req-ccc");
    await row("198.51.100.22", "auth.sign-in", 45, 30, new Date(now - 10_000), "req-ddd");
    await row("198.51.100.22", "auth.sign-in", 46, 30, new Date(now - 8 * 24 * 60 * 60 * 1000), undefined);
  }

  it("401 without a session — the ledger is not public", async () => {
    const res = await app.request("/api/rate-limit-denials");
    expect(res.status).toBe(401);
  });

  it("403 without audit.read — sales sees no abuse telemetry (list and summary)", async () => {
    const f = await fixture();
    const cookie = await f.cookieFor(f.sales);
    const list = await app.request("/api/rate-limit-denials", { headers: { cookie } });
    expect(list.status).toBe(403);
    const listBody = (await list.json()) as { error?: string; code?: string };
    expect(listBody.error).toBe("forbidden");
    expect(listBody.code).toBe("permission_required");

    const summary = await app.request("/api/rate-limit-denials/summary", { headers: { cookie } });
    expect(summary.status).toBe(403);
  });

  it("200 for owner: newest first, exact total, ISO timestamps, request id verbatim", async () => {
    const f = await fixture();
    await seedDenials();
    const res = await app.request("/api/rate-limit-denials", {
      headers: { cookie: await f.cookieFor(f.owner) },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      denials: {
        id: string;
        identifierType: string;
        identifier: string;
        action: string;
        windowStart: string;
        countAtDenial: number;
        limitValue: number;
        requestId: string | null;
        deniedAt: string;
      }[];
      total: number;
    };
    expect(body.total).toBe(5);
    expect(body.denials).toHaveLength(5);
    // 最新在前：最近播种的一行（10 秒前）打头；8 天前的那行收尾
    expect(body.denials[0]?.countAtDenial).toBe(45);
    expect(body.denials[0]?.identifier).toBe("198.51.100.22");
    expect(body.denials.at(-1)?.countAtDenial).toBe(46);
    for (const denial of body.denials) {
      expect(denial.id).toBeTruthy();
      expect(denial.identifierType).toBe("ip");
      expect(denial.deniedAt).toBe(new Date(denial.deniedAt).toISOString());
      expect(denial.windowStart).toBe(new Date(denial.windowStart).toISOString());
      expect(denial.countAtDenial).toBeGreaterThan(denial.limitValue);
    }
    const withRequest = body.denials.find((d) => d.countAtDenial === 31);
    expect(withRequest?.requestId).toBe("req-aaa");
    // 台账行自证「为什么拒」：拒绝时刻的计数与当时阈值同行
    expect(withRequest?.limitValue).toBe(30);
  });

  it("filters by action / identifier with exact match and consistent total", async () => {
    const f = await fixture();
    await seedDenials();
    const cookie = await f.cookieFor(f.owner);

    const byAction = await app.request("/api/rate-limit-denials?action=auth.sign-in", {
      headers: { cookie },
    });
    const actionBody = (await byAction.json()) as {
      denials: { action: string }[];
      total: number;
    };
    expect(actionBody.total).toBe(4);
    expect(actionBody.denials.every((d) => d.action === "auth.sign-in")).toBe(true);

    const byIdentifier = await app.request("/api/rate-limit-denials?identifier=203.0.113.10", {
      headers: { cookie },
    });
    const identifierBody = (await byIdentifier.json()) as {
      denials: { identifier: string }[];
      total: number;
    };
    expect(identifierBody.total).toBe(3);
    expect(identifierBody.denials.every((d) => d.identifier === "203.0.113.10")).toBe(true);

    const combined = await app.request(
      "/api/rate-limit-denials?identifier=203.0.113.10&action=auth.sign-up",
      { headers: { cookie } },
    );
    expect((await combined.json()) as { total: number }).toMatchObject({ total: 1 });

    const miss = await app.request("/api/rate-limit-denials?identifier=10.0.0.1", {
      headers: { cookie },
    });
    const missBody = (await miss.json()) as { denials: unknown[]; total: number };
    expect(missBody.total).toBe(0);
    expect(missBody.denials).toHaveLength(0);
  });

  it("paginates with limit/offset; over-cap limit and negative offset are 400", async () => {
    const f = await fixture();
    await seedDenials();
    const cookie = await f.cookieFor(f.owner);

    const page1 = await app.request("/api/rate-limit-denials?limit=3&offset=0", {
      headers: { cookie },
    });
    const page1Body = (await page1.json()) as { denials: unknown[]; total: number };
    expect(page1Body.denials).toHaveLength(3);
    expect(page1Body.total).toBe(5);

    const page2 = await app.request("/api/rate-limit-denials?limit=3&offset=3", {
      headers: { cookie },
    });
    const page2Body = (await page2.json()) as { denials: unknown[]; total: number };
    expect(page2Body.denials).toHaveLength(2);

    const overCap = await app.request(
      `/api/rate-limit-denials?limit=${String(RATE_LIMIT_DENIALS_PAGE_MAX + 1)}`,
      { headers: { cookie } },
    );
    expect(overCap.status).toBe(400);

    const negative = await app.request("/api/rate-limit-denials?offset=-1", { headers: { cookie } });
    expect(negative.status).toBe(400);
  });

  it("summary groups by action with distinct sources, ordered by volume, inside the day window", async () => {
    const f = await fixture();
    await seedDenials();
    const res = await app.request("/api/rate-limit-denials/summary", {
      headers: { cookie: await f.cookieFor(f.owner) },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      windowDays: number;
      groups: {
        action: string;
        count: number;
        distinctIdentifiers: number;
        lastDeniedAt: string;
      }[];
    };
    expect(body.windowDays).toBe(7);
    // 8 天前的那行不在 7 天窗口里：sign-in 只剩 3 行（ip-1 两行 + ip-2 一行），
    // 来自 2 个 distinct 来源
    expect(body.groups).toHaveLength(2);
    expect(body.groups[0]).toMatchObject({
      action: "auth.sign-in",
      count: 3,
      distinctIdentifiers: 2,
    });
    expect(body.groups[1]).toMatchObject({
      action: "auth.sign-up",
      count: 1,
      distinctIdentifiers: 1,
    });
    for (const group of body.groups) {
      expect(group.lastDeniedAt).toBe(new Date(group.lastDeniedAt).toISOString());
    }

    const wide = await app.request(
      `/api/rate-limit-denials/summary?days=${String(RATE_LIMIT_SUMMARY_DAYS_MAX)}`,
      { headers: { cookie: await f.cookieFor(f.owner) } },
    );
    const wideBody = (await wide.json()) as {
      windowDays: number;
      groups: { action: string; count: number }[];
    };
    expect(wideBody.windowDays).toBe(RATE_LIMIT_SUMMARY_DAYS_MAX);
    expect(wideBody.groups.find((g) => g.action === "auth.sign-in")?.count).toBe(4);

    const overCap = await app.request(
      `/api/rate-limit-denials/summary?days=${String(RATE_LIMIT_SUMMARY_DAYS_MAX + 1)}`,
      { headers: { cookie: await f.cookieFor(f.owner) } },
    );
    expect(overCap.status).toBe(400);
  });

  it("reading the ledger writes no audit rows — queries are not governed actions", async () => {
    const f = await fixture();
    await seedDenials();
    const cookie = await f.cookieFor(f.owner);
    const before = await db.select({ n: sql<number>`count(*)::int` }).from(schema.auditEvents);
    const res = await app.request("/api/rate-limit-denials?limit=1", { headers: { cookie } });
    expect(res.status).toBe(200);
    const after = await db.select({ n: sql<number>`count(*)::int` }).from(schema.auditEvents);
    expect(after[0]?.n).toBe(before[0]?.n);
  });
});

/** 同一实例上连 maintenance 库（postgres）用的管理连接串 */
function adminUrl(databaseUrl: string | undefined): string {
  if (!databaseUrl) return ""; // 套件被跳过时不会被用到
  const url = new URL(databaseUrl);
  url.pathname = "/postgres";
  return url.toString();
}
