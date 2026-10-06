import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, runMigrations, schema } from "@ally/db";
import { createApp } from "../app.ts";
import type { SessionData } from "../auth/session.ts";
import { createAuthzStore } from "../authz/service.ts";
import { registerNumberedSubject } from "../numbering/registry.ts";
import { allocateDocumentNumber, NoActiveRuleError } from "../numbering/service.ts";

// 集成测试：需要真实 PostgreSQL（部分唯一索引、计数器行锁、审计同事务）。
// 未设 DATABASE_URL 时跳过。
//
// 本文件用**独立的临时库**（每次运行新建、跑完 drop，纪律同 custom-fields.test.ts）：
// 计数器状态、部分唯一索引、审计行数断言都要求干净的断言面，共享库上并行文件的
// 残行会随机干扰。TRUNCATE 是本文件自己的清库通道（单语句，sequences → rules 有 FK）。
//
// 可编号 subject 注册表是模块级的：本文件注册夹具域（与生产同一条接缝），vitest
// 按文件隔离模块，不会泄漏到其他文件；生产注册表仍为空（单据域在 phase-2+）。
const FIXTURE_SUBJECT = "fixture_invoice";
registerNumberedSubject(FIXTURE_SUBJECT, { label: "夹具发票" });

const databaseUrl = process.env.DATABASE_URL;

const logger = pino({ level: "silent" });

/** admin 持配置权限点（owner/admin 默认持有 numbering.configure）；alice 零角色
 * ——403 的反例。角色走真 user_role 表 + 真 authzStore（权限链端到端），不做桩。 */
const USERS = {
  admin: randomUUID(),
  alice: randomUUID(),
} as const;

type UserName = keyof typeof USERS;

const USER_ROLES: Partial<Record<UserName, "admin">> = { admin: "admin" };

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

function adminUrl(databaseUrl: string | undefined): string {
  if (databaseUrl === undefined) return "";
  const url = new URL(databaseUrl);
  url.pathname = "/postgres";
  return url.toString();
}

function must<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("unexpected missing value in test");
  return value;
}

const CLOCK = new Date(Date.UTC(2026, 9, 6, 12)); // 2026-10-06 12:00 UTC，测试统一时钟

describe.skipIf(!databaseUrl)("numbering rule endpoints (#225 slice 1, integration)", () => {
  const dbName = `numbering_test_${String(Date.now())}_${String(process.pid)}`;
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
  pool.on("error", () => {});
  admin.pool.on("error", () => {});

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
    authzStore: createAuthzStore(db),
    notifyUsers: () => Promise.resolve(),
  });

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("unreachable: suite is skipped without DATABASE_URL");
    await admin.pool.query(`create database "${dbName}"`);
    await runMigrations(db);
    await db.insert(schema.authUser).values(
      (Object.keys(USERS) as UserName[]).map((name) => ({
        id: USERS[name],
        name: name.charAt(0).toUpperCase() + name.slice(1),
        email: `${name}@example.com`,
        emailVerified: true,
      })),
    );
    await db.insert(schema.userRole).values(
      (Object.entries(USER_ROLES) as [UserName, "admin"][]).map(([name, role]) => ({
        userId: USERS[name],
        role,
      })),
    );
  });

  beforeEach(async () => {
    // 单语句 TRUNCATE：sequences → rules 有 FK；审计是本文件的断言面
    await db.execute(
      sql`truncate table ${schema.numberingSequences}, ${schema.numberingRules}, ${schema.auditEvents} cascade`,
    );
  });

  afterAll(async () => {
    await pool.end();
    await admin.pool.query(`drop database if exists "${dbName}" with (force)`);
    await admin.pool.end();
  });

  const adminHeaders = { "x-test-user": "admin" };
  const aliceHeaders = { "x-test-user": "alice" };
  const jsonHeaders = { "content-type": "application/json" };

  async function createRule(headers: Record<string, string>, body: Record<string, unknown>) {
    return app.request("/api/numbering-rules", {
      method: "POST",
      headers: { ...jsonHeaders, ...headers },
      body: JSON.stringify(body),
    });
  }

  async function createRuleOk(body: Record<string, unknown>): Promise<string> {
    const res = await createRule(adminHeaders, body);
    expect(res.status).toBe(201);
    const parsed = (await res.json()) as { id?: string };
    return must(parsed.id);
  }

  it("403 for a caller without numbering.configure on every config route", async () => {
    const post = await createRule(aliceHeaders, { subject: FIXTURE_SUBJECT, label: "发票" });
    expect(post.status).toBe(403);
    const list = await app.request("/api/numbering-rules", { headers: aliceHeaders });
    expect(list.status).toBe(403);
    const subjects = await app.request("/api/numbering-rules/subjects", { headers: aliceHeaders });
    expect(subjects.status).toBe(403);
    const patch = await app.request(`/api/numbering-rules/${randomUUID()}`, {
      method: "PATCH",
      headers: { ...jsonHeaders, ...aliceHeaders },
      body: JSON.stringify({ active: false }),
    });
    expect(patch.status).toBe(403);
  });

  it("creates a rule, audits it, and exposes it on the list with counter state", async () => {
    const id = await createRuleOk({
      subject: FIXTURE_SUBJECT,
      label: "销售发票",
      prefix: "INV-",
      dateFormat: "YYYYMM",
      padding: 4,
      startNumber: 1000,
    });
    const audit = await db
      .select({ action: schema.auditEvents.action, detail: schema.auditEvents.detail })
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.action, "numbering.rule_created"));
    expect(audit).toHaveLength(1);
    expect(must(audit[0]).detail).toMatchObject({ subject: FIXTURE_SUBJECT, prefix: "INV-" });

    const list = await app.request("/api/numbering-rules", { headers: adminHeaders });
    expect(list.status).toBe(200);
    const body = (await list.json()) as {
      rules: { id: string; subject: string; label: string; prefix: string; dateFormat: string | null; active: boolean; lastIssued: number | null }[];
    };
    expect(body.rules).toHaveLength(1);
    const rule = must(body.rules[0]);
    expect(rule.id).toBe(id);
    expect(rule).toMatchObject({
      subject: FIXTURE_SUBJECT,
      label: "销售发票",
      prefix: "INV-",
      dateFormat: "YYYYMM",
      active: true,
      lastIssued: null,
    });
  });

  it("rejects unregistered subjects and duplicate active rules", async () => {
    const unregistered = await createRule(adminHeaders, { subject: "never_registered", label: "死配置" });
    expect(unregistered.status).toBe(400);
    expect(await unregistered.json()).toMatchObject({ error: "unregistered_subject" });

    await createRuleOk({ subject: FIXTURE_SUBJECT, label: "第一套" });
    const dup = await createRule(adminHeaders, { subject: FIXTURE_SUBJECT, label: "第二套" });
    expect(dup.status).toBe(409);
    expect(await dup.json()).toMatchObject({ error: "rule_exists" });
  });

  it("lists registered subjects from the registry seam", async () => {
    const res = await app.request("/api/numbering-rules/subjects", { headers: adminHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { subjects: { subject: string; label: string }[] };
    expect(body.subjects).toContainEqual({ subject: FIXTURE_SUBJECT, label: "夹具发票" });
  });

  it("patches format fields with a real-change-only audit trail", async () => {
    const id = await createRuleOk({ subject: FIXTURE_SUBJECT, label: "报价", prefix: "QT-", padding: 4 });
    const patch = await app.request(`/api/numbering-rules/${id}`, {
      method: "PATCH",
      headers: { ...jsonHeaders, ...adminHeaders },
      body: JSON.stringify({ prefix: "QT2-", dateFormat: "YYYY" }),
    });
    expect(patch.status).toBe(200);
    const updated = (await patch.json()) as { prefix: string; dateFormat: string | null };
    expect(updated).toMatchObject({ prefix: "QT2-", dateFormat: "YYYY" });

    const audit = await db
      .select({ detail: schema.auditEvents.detail })
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.action, "numbering.rule_updated"));
    expect(audit).toHaveLength(1);
    expect(must(audit[0]).detail).toMatchObject({
      subject: FIXTURE_SUBJECT,
      changes: {
        prefix: { from: "QT-", to: "QT2-" },
        dateFormat: { from: null, to: "YYYY" },
      },
    });

    // 无实效变更：幂等 200，不留审计行
    const noop = await app.request(`/api/numbering-rules/${id}`, {
      method: "PATCH",
      headers: { ...jsonHeaders, ...adminHeaders },
      body: JSON.stringify({ prefix: "QT2-", dateFormat: "YYYY" }),
    });
    expect(noop.status).toBe(200);
    const after = await db
      .select({ id: schema.auditEvents.id })
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.action, "numbering.rule_updated"));
    expect(after).toHaveLength(1);
  });

  it("refuses to patch startNumber (immutable after create) and 404s unknown rules", async () => {
    const id = await createRuleOk({ subject: FIXTURE_SUBJECT, label: "报价" });
    const res = await app.request(`/api/numbering-rules/${id}`, {
      method: "PATCH",
      headers: { ...jsonHeaders, ...adminHeaders },
      body: JSON.stringify({ startNumber: 5000 }),
    });
    expect(res.status).toBe(400);
    const missing = await app.request(`/api/numbering-rules/${randomUUID()}`, {
      method: "PATCH",
      headers: { ...jsonHeaders, ...adminHeaders },
      body: JSON.stringify({ active: false }),
    });
    expect(missing.status).toBe(404);
  });

  it("deactivating the rule fails allocation closed; reactivating resumes the same series", async () => {
    const id = await createRuleOk({ subject: FIXTURE_SUBJECT, label: "发票", prefix: "INV-", padding: 4 });
    const first = await allocateDocumentNumber(db, FIXTURE_SUBJECT, { now: CLOCK });
    expect(first.number).toBe("INV-0001");

    await app.request(`/api/numbering-rules/${id}`, {
      method: "PATCH",
      headers: { ...jsonHeaders, ...adminHeaders },
      body: JSON.stringify({ active: false }),
    });
    await expect(allocateDocumentNumber(db, FIXTURE_SUBJECT, { now: CLOCK })).rejects.toBeInstanceOf(
      NoActiveRuleError,
    );

    await app.request(`/api/numbering-rules/${id}`, {
      method: "PATCH",
      headers: { ...jsonHeaders, ...adminHeaders },
      body: JSON.stringify({ active: true }),
    });
    const resumed = await allocateDocumentNumber(db, FIXTURE_SUBJECT, { now: CLOCK });
    expect(resumed.sequence).toBe(2);
  });

  it("#225 AC3: numbers issued after a format edit use the new format without repetition", async () => {
    const id = await createRuleOk({ subject: FIXTURE_SUBJECT, label: "报价", prefix: "QT-", padding: 4 });
    const before = await allocateDocumentNumber(db, FIXTURE_SUBJECT, { now: CLOCK });
    expect(before.number).toBe("QT-0001");

    await app.request(`/api/numbering-rules/${id}`, {
      method: "PATCH",
      headers: { ...jsonHeaders, ...adminHeaders },
      body: JSON.stringify({ prefix: "QT-", dateFormat: "YYYYMM", padding: 6 }),
    });
    const after = await allocateDocumentNumber(db, FIXTURE_SUBJECT, { now: CLOCK });
    expect(after.number).toBe("QT-202610-000002");
    expect(after.number).not.toBe(before.number);
  });

  it("first issued number equals startNumber exactly (BUG-054 regression guard)", async () => {
    await createRuleOk({ subject: FIXTURE_SUBJECT, label: "发票", prefix: "INV-", startNumber: 1000 });
    const first = await allocateDocumentNumber(db, FIXTURE_SUBJECT, { now: CLOCK });
    expect(first.sequence).toBe(1000);
    expect(first.number).toBe("INV-1000");
    const second = await allocateDocumentNumber(db, FIXTURE_SUBJECT, { now: CLOCK });
    expect(second.sequence).toBe(1001);
  });

  it("concurrent allocations hand out distinct numbers (row-lock serialization)", async () => {
    await createRuleOk({ subject: FIXTURE_SUBJECT, label: "发票", prefix: "INV-", padding: 4 });
    const issued = await Promise.all(
      Array.from({ length: 8 }, () => allocateDocumentNumber(db, FIXTURE_SUBJECT, { now: CLOCK })),
    );
    const sequences = issued.map((i) => i.sequence).sort((a, b) => a - b);
    expect(sequences).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(new Set(issued.map((i) => i.number)).size).toBe(8);
  });

  it("a rolled-back creation returns its number (transactional counter: no gaps, no burns)", async () => {
    await createRuleOk({ subject: FIXTURE_SUBJECT, label: "发票", prefix: "INV-" });
    // 属主域创建失败：单据事务连同已分配的号一起回滚（抛错即回滚，预期内）
    await expect(
      db.transaction(async (tx) => {
        await allocateDocumentNumber(tx, FIXTURE_SUBJECT, { now: CLOCK });
        throw new Error("business failure after numbering");
      }),
    ).rejects.toThrow("business failure");
    const next = await allocateDocumentNumber(db, FIXTURE_SUBJECT, { now: CLOCK });
    // 计数器是普通表行、随事务回滚：回滚的单据从未存在，0001 归还后可复用——
    // 已提交的单据之间编号无 gap 不重复（与老 nextval「回滚烧号」刻意不同，
    // 见 docs/numbering.md 的差异说明）
    expect(next.sequence).toBe(1);
    expect(next.number).toBe("INV-0001");
  });

  it("date segment follows the injected clock, not wall time", async () => {
    await createRuleOk({
      subject: FIXTURE_SUBJECT,
      label: "报价",
      prefix: "QT-",
      dateFormat: "YYYYMM",
      padding: 4,
    });
    const issued = await allocateDocumentNumber(db, FIXTURE_SUBJECT, { now: new Date(Date.UTC(2027, 0, 9, 12)) });
    expect(issued.number).toBe("QT-202701-0001");
  });
});
