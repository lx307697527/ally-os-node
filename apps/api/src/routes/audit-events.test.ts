import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, runMigrations, schema } from "@ally/db";
import { recordAudit } from "../audit/audit-log.ts";
import { createApp } from "../app.ts";
import { createAuth, createSessionResolver } from "../auth/auth.ts";
import type { MailMessage } from "@ally/mailer";
import { createAuthzStore } from "../authz/service.ts";
import { AUDIT_PAGE_MAX } from "./audit-events.ts";

// 集成测试：需要真实 PostgreSQL（查询 audit_events + 权限点走真实 authz）。
// 未设 DATABASE_URL 时跳过。
//
// 本文件用**独立的临时库**（每次运行新建、跑完 drop）：vitest 并行跑测试文件，
// 其他文件的 afterEach 会 TRUNCATE 共享库里的 audit_events（#29 起行级 DELETE
// 被拒，TRUNCATE 是唯一清库通道）——本文件断言的是精确 total，共享库上的并行
// 清理会让它随机红。独立库是 hermetic 的唯一办法。
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

describe.skipIf(!databaseUrl)("audit events route (#29, integration)", () => {
  // 管理连接连 maintenance 库（postgres），负责临时库的建与删；测试连接指向
  // 本文件专属的临时库。所有句柄都在 describe 作用域创建——pg.Pool 是惰性的，
  // 构造不发 I/O；beforeAll 只做建库与迁移，跳过的套件（无 DATABASE_URL）里
  // 它们永远不会被真正连上。
  const dbName = `audit_events_test_${String(Date.now())}_${String(process.pid)}`;
  const admin = createDb(adminUrl(databaseUrl));
  const scopedUrl =
    databaseUrl === undefined ? "" : (() => {
      const url = new URL(databaseUrl);
      url.pathname = `/${dbName}`;
      return url.toString();
    })();
  const { db, pool } = createDb(scopedUrl);
  // 并行套件 drop … with (force) 的 57P01 会以 unhandled error 形式炸掉整个
  // vitest 进程（测试全绿也挂，main 的 deploy CI 跑到过）；其它 scratch-DB
  // 套件都有这道护栏，本文件漏了
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
    logger,
    db,
    corsOrigins: ["http://localhost:5173"],
    checkDatabase: async () => {
      await pool.query("select 1");
    },
    authHandler: (request) => auth.handler(request),
    resolveSession: createSessionResolver(auth),
    socialProviders: [],
    authzStore: createAuthzStore(db),
  
    notifyUsers: async () => {},});

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("unreachable: suite is skipped without DATABASE_URL");
    // 标识符不能走参数绑定，名字是本进程拼出来的固定格式，注入面可控
    await admin.pool.query(`create database "${dbName}"`);
    await runMigrations(db);
  });

  beforeEach(async () => {
    // 每条测试从空表开始（整库是本文件的，TRUNCATE 不与并行文件互相干扰）；
    // 用户行不清——临时库整体生灭，不跨运行留垃圾
    await db.execute(sql`truncate table ${schema.auditEvents}`);
  });

  afterAll(async () => {
    await pool.end();
    // 库随测试生灭：即便断言中途失败也不留跨运行垃圾
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

  /** 播种确定的审计行：actor-1 三行（两行 target-a、一行 target-b），actor-2 一行 */
  async function seedAuditRows(): Promise<void> {
    await recordAudit(db, { actor: "actor-1", action: "role.granted", target: "target-a", detail: { role: "admin" } });
    await recordAudit(db, { actor: "actor-1", action: "role.revoked", target: "target-a", detail: { role: "sales" } });
    await recordAudit(db, { actor: "actor-1", action: "lead.status_changed", target: "target-b", detail: { from: "new", to: "contacted" } });
    await recordAudit(db, { actor: "actor-2", action: "role.granted", target: "target-c", detail: null });
  }

  it("401 without a session — the log is not public", async () => {
    const res = await app.request("/api/audit-events");
    expect(res.status).toBe(401);
  });

  it("403 without audit.read — sales sees no company-wide audit trail", async () => {
    const f = await fixture();
    const res = await app.request("/api/audit-events", {
      headers: { cookie: await f.cookieFor(f.sales) },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string; code?: string };
    expect(body.error).toBe("forbidden");
    expect(body.code).toBe("permission_required");
  });

  it("200 for owner: newest first, exact total, ISO timestamps, detail verbatim", async () => {
    const f = await fixture();
    await seedAuditRows();
    const res = await app.request("/api/audit-events", {
      headers: { cookie: await f.cookieFor(f.owner) },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events: {
        id: string;
        actor: string | null;
        action: string;
        target: string | null;
        detail: unknown;
        createdAt: string;
      }[];
      total: number;
    };
    expect(body.total).toBe(4);
    expect(body.events).toHaveLength(4);
    // 同批播种的 created_at 可能同秒：排序按 (created_at desc, id desc) 稳定
    const actions = body.events.map((e) => e.action);
    expect(actions).toContain("role.granted");
    expect(actions).toContain("lead.status_changed");
    for (const event of body.events) {
      expect(event.id).toBeTruthy();
      expect(() => new Date(event.createdAt).toISOString()).not.toThrow();
      expect(event.createdAt).toBe(new Date(event.createdAt).toISOString());
    }
    const statusChange = body.events.find((e) => e.action === "lead.status_changed");
    expect(statusChange?.detail).toEqual({ from: "new", to: "contacted" });
  });

  it("filters by actor / action / target with exact match and consistent total", async () => {
    const f = await fixture();
    await seedAuditRows();
    const cookie = await f.cookieFor(f.owner);

    const byActor = await app.request("/api/audit-events?actor=actor-1", {
      headers: { cookie },
    });
    expect((await byActor.json()) as { total: number }).toMatchObject({ total: 3 });

    const byAction = await app.request("/api/audit-events?action=role.granted", {
      headers: { cookie },
    });
    const actionBody = (await byAction.json()) as {
      events: { action: string }[];
      total: number;
    };
    expect(actionBody.total).toBe(2);
    expect(actionBody.events.every((e) => e.action === "role.granted")).toBe(true);

    const byTarget = await app.request("/api/audit-events?target=target-a", {
      headers: { cookie },
    });
    expect((await byTarget.json()) as { total: number }).toMatchObject({ total: 2 });

    const combined = await app.request("/api/audit-events?actor=actor-2&action=role.granted", {
      headers: { cookie },
    });
    expect((await combined.json()) as { total: number }).toMatchObject({ total: 1 });
  });

  it("paginates with limit/offset; limit above the cap is 400", async () => {
    const f = await fixture();
    await seedAuditRows();
    const cookie = await f.cookieFor(f.owner);

    const page1 = await app.request("/api/audit-events?limit=3&offset=0", {
      headers: { cookie },
    });
    const page1Body = (await page1.json()) as {
      events: { target: string | null }[];
      total: number;
    };
    expect(page1Body.events).toHaveLength(3);
    expect(page1Body.total).toBe(4);

    const page2 = await app.request("/api/audit-events?limit=3&offset=3", {
      headers: { cookie },
    });
    const page2Body = (await page2.json()) as { events: unknown[]; total: number };
    expect(page2Body.events).toHaveLength(1);

    const overCap = await app.request(`/api/audit-events?limit=${AUDIT_PAGE_MAX + 1}`, {
      headers: { cookie },
    });
    expect(overCap.status).toBe(400);

    const negative = await app.request("/api/audit-events?offset=-1", { headers: { cookie } });
    expect(negative.status).toBe(400);
  });

  it("reading the log writes no audit rows — queries are not governed actions", async () => {
    const f = await fixture();
    await seedAuditRows();
    const cookie = await f.cookieFor(f.owner);
    const before = await db.select({ n: sql<number>`count(*)::int` }).from(schema.auditEvents);
    const res = await app.request("/api/audit-events?limit=1", { headers: { cookie } });
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
