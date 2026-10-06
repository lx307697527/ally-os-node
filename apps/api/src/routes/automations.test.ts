import { randomUUID } from "node:crypto";
import { desc, eq, sql } from "drizzle-orm";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, runMigrations, schema } from "@ally/db";
import { createApp } from "../app.ts";
import type { SessionData } from "../auth/session.ts";
import { createAuthzStore } from "../authz/service.ts";

// 集成测试：需要真实 PostgreSQL（规则行、runs 行、审计写、runs 的 FK
// ON DELETE SET NULL 行为）。未设 DATABASE_URL 时跳过。
//
// 本文件用**独立的临时库**（每次运行新建、跑完 drop，纪律同 tasks.test.ts）。
// 规则 CRUD 与 runs 读法是纯配置面，没有跨表不变式，单语句 TRUNCATE 清本文件
// 的断言面。
const databaseUrl = process.env.DATABASE_URL;

const logger = pino({ level: "silent" });

/** admin 持 automations.configure（角色默认集）；alice 零角色（403 面）。 */
const USERS = {
  admin: randomUUID(),
  alice: randomUUID(),
} as const;

type UserName = keyof typeof USERS;

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

/** 验收第 3 条的规则形状：进入 review 阶段 → 建任务 + 发通知（worker 侧另有端到端） */
const STAGE_RULE = {
  name: "进入审阅自动跟进",
  description: "流程实例进入 review 时给负责人建跟进任务",
  trigger: { kind: "event", action: "workflow.state_changed" },
  conditions: [{ path: "detail.to", op: "eq", value: "review" }],
  actions: [
    { type: "create_task", config: { title: "跟进审阅", dueInHours: 24 } },
    {
      type: "notify",
      config: { userIds: [USERS.alice], title: "有实例进入审阅" },
    },
  ],
};

function must<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("unexpected missing value in test");
  return value;
}

describe.skipIf(!databaseUrl)("automation rule endpoints (#224 slice 1, integration)", () => {
  const dbName = `automations_test_${String(Date.now())}_${String(process.pid)}`;
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
    await db.insert(schema.userRole).values({ userId: USERS.admin, role: "admin" });
  });

  beforeEach(async () => {
    // 单语句 TRUNCATE：runs → rules 有 FK；audit 是本文件的审计断言面
    await db.execute(
      sql`truncate table ${schema.automationRuns}, ${schema.automationRules}, ${schema.auditEvents} cascade`,
    );
  });

  afterAll(async () => {
    await pool.end();
    await admin.pool.query(`drop database if exists "${dbName}"`);
    await admin.pool.end();
  });

  async function createRule(name: string = STAGE_RULE.name): Promise<string> {
    const res = await app.request("/api/automations", {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-user": "admin" },
      body: JSON.stringify({ ...STAGE_RULE, name }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    return body.id;
  }

  it("denies non-configure users on every endpoint", async () => {
    const create = await app.request("/api/automations", {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-user": "alice" },
      body: JSON.stringify(STAGE_RULE),
    });
    expect(create.status).toBe(403);
    const list = await app.request("/api/automations", { headers: { "x-test-user": "alice" } });
    expect(list.status).toBe(403);
    const runs = await app.request("/api/automations/runs", { headers: { "x-test-user": "alice" } });
    expect(runs.status).toBe(403);
    expect(await db.select().from(schema.automationRules)).toHaveLength(0);
  });

  it("rejects unauthenticated calls", async () => {
    const res = await app.request("/api/automations");
    expect(res.status).toBe(401);
  });

  it("creates a rule, lists it, and leaves an audit trail", async () => {
    const ruleId = await createRule();
    const list = await app.request("/api/automations", { headers: { "x-test-user": "admin" } });
    expect(list.status).toBe(200);
    const body = (await list.json()) as {
      rules: { id: string; name: string; enabled: boolean; version: number; trigger: unknown }[];
    };
    expect(body.rules).toHaveLength(1);
    const rule = must(body.rules[0]);
    expect(rule.id).toBe(ruleId);
    expect(rule.enabled).toBe(true);
    expect(rule.version).toBe(1);
    expect(rule.trigger).toEqual({ kind: "event", action: "workflow.state_changed" });

    const audits = await db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.action, "automations.rule_created"));
    expect(audits).toHaveLength(1);
    expect(must(audits[0]).target).toBe(ruleId);
  });

  it("rejects malformed specs with 400", async () => {
    const res = await app.request("/api/automations", {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-user": "admin" },
      body: JSON.stringify({ ...STAGE_RULE, actions: [] }),
    });
    expect(res.status).toBe(400);
    const badCondition = await app.request("/api/automations", {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-user": "admin" },
      body: JSON.stringify({
        ...STAGE_RULE,
        conditions: [{ path: "detail.to", op: "eq" }],
      }),
    });
    expect(badCondition.status).toBe(400);
  });

  it("accepts a due trigger and rejects due shapes the kernel does not define (#224 slice 2)", async () => {
    const create = await app.request("/api/automations", {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-user": "admin" },
      body: JSON.stringify({
        name: "任务到期前 1 小时提醒",
        trigger: { kind: "due", subjectType: "task", anchorField: "dueAt", direction: "before", offsetMinutes: 60 },
        actions: [{ type: "notify", config: { userIds: [USERS.alice], title: "任务快到期" } }],
      }),
    });
    expect(create.status).toBe(201);
    const rows = await db.select().from(schema.automationRules);
    const rule = must(rows[0]);
    expect(rule.trigger).toEqual({
      kind: "due",
      subjectType: "task",
      anchorField: "dueAt",
      direction: "before",
      offsetMinutes: 60,
    });

    const badOffset = await app.request("/api/automations", {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-user": "admin" },
      body: JSON.stringify({
        name: "偏移越界",
        trigger: { kind: "due", subjectType: "task", anchorField: "dueAt", direction: "before", offsetMinutes: 4 },
        actions: STAGE_RULE.actions,
      }),
    });
    expect(badOffset.status).toBe(400);
    // 无 kind 的切片 1 旧形状不再收：规则是上线前数据，不留双形状
    const legacy = await app.request("/api/automations", {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-user": "admin" },
      body: JSON.stringify({ ...STAGE_RULE, trigger: { action: "task.created" } }),
    });
    expect(legacy.status).toBe(400);
  });

  it("versions every real change through the ledger and stays idempotent on no-ops (#226)", async () => {
    const ruleId = await createRule();
    // 改名/启停也是内容变更：各记一版（#226 台账，行.version = 台账最新版）
    const rename = await app.request(`/api/automations/${ruleId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-test-user": "admin" },
      body: JSON.stringify({ name: "新名字", enabled: false }),
    });
    expect(rename.status).toBe(200);
    expect(((await rename.json()) as { version: number }).version).toBe(2);

    const specChange = await app.request(`/api/automations/${ruleId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-test-user": "admin" },
      body: JSON.stringify({
        spec: { trigger: { kind: "event", action: "task.created" }, actions: STAGE_RULE.actions },
      }),
    });
    expect(specChange.status).toBe(200);
    expect(((await specChange.json()) as { version: number }).version).toBe(3);

    // 无实效变更：幂等返回现状，不记账不留审计
    const noop = await app.request(`/api/automations/${ruleId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-test-user": "admin" },
      body: JSON.stringify({ name: "新名字", enabled: false }),
    });
    expect(noop.status).toBe(200);
    expect(((await noop.json()) as { version: number }).version).toBe(3);

    const audits = await db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.action, "automations.rule_updated"))
      .orderBy(desc(schema.auditEvents.createdAt));
    expect(audits).toHaveLength(2);
    const specAudit = must(audits[0]);
    expect((specAudit.detail as { version?: number }).version).toBe(3);
    // 审计 changes 与台账 changes 同形：spec 变更带 trigger 的 from/to（conditions
    // 与现状一致则不在列）
    const specChanges = (specAudit.detail as { changes?: Record<string, unknown> }).changes;
    expect(specChanges).toMatchObject({ trigger: { from: { kind: "event", action: "workflow.state_changed" } } });
    const renameAudit = must(audits[1]);
    expect(renameAudit.detail).toMatchObject({
      changes: { name: { from: "进入审阅自动跟进", to: "新名字" }, enabled: { from: true, to: false } },
    });

    // 台账：3 版（v1 created + 两次 updated），行.version 同步
    const revisions = await db
      .select({ version: schema.configRevisions.version, source: schema.configRevisions.source })
      .from(schema.configRevisions)
      .where(eq(schema.configRevisions.subjectId, ruleId))
      .orderBy(desc(schema.configRevisions.version));
    expect(revisions).toEqual([
      { version: 3, source: "updated" },
      { version: 2, source: "updated" },
      { version: 1, source: "created" },
    ]);

    const rows = await db.select().from(schema.automationRules);
    const rule = must(rows[0]);
    expect(rule.name).toBe("新名字");
    expect(rule.enabled).toBe(false);
    expect(rule.trigger).toEqual({ kind: "event", action: "task.created" });
    expect(rule.version).toBe(3);
  });

  it("404s patches and deletes on unknown ids", async () => {
    const patch = await app.request(`/api/automations/${randomUUID()}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-test-user": "admin" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(patch.status).toBe(404);
    const del = await app.request(`/api/automations/${randomUUID()}`, {
      method: "DELETE",
      headers: { "x-test-user": "admin" },
    });
    expect(del.status).toBe(404);
  });

  it("deleting a rule keeps its runs (rule_id null, name snapshot) and audits the delete", async () => {
    const ruleId = await createRule("会留历史的规则");
    const sourceEventId = randomUUID();
    await db.insert(schema.automationRuns).values({
      ruleId,
      ruleName: "会留历史的规则",
      sourceEventId,
      status: "succeeded",
      actionResults: [{ type: "create_task", status: "succeeded" }],
    });
    const del = await app.request(`/api/automations/${ruleId}`, {
      method: "DELETE",
      headers: { "x-test-user": "admin" },
    });
    expect(del.status).toBe(200);
    expect(await db.select().from(schema.automationRules)).toHaveLength(0);
    const runs = await db.select().from(schema.automationRuns);
    const run = must(runs[0]);
    expect(run.ruleId).toBeNull();
    expect(run.ruleName).toBe("会留历史的规则");
    const audits = await db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.action, "automations.rule_deleted"));
    expect(audits).toHaveLength(1);
  });

  it("lists runs newest-first with ruleId/status filters", async () => {
    const ruleId = await createRule();
    for (const status of ["succeeded", "failed", "skipped"] as const) {
      await db.insert(schema.automationRuns).values({
        ruleId,
        ruleName: STAGE_RULE.name,
        sourceEventId: randomUUID(),
        status,
      });
    }
    const all = await app.request("/api/automations/runs", { headers: { "x-test-user": "admin" } });
    expect(all.status).toBe(200);
    const allBody = (await all.json()) as { runs: { status: string }[] };
    expect(allBody.runs).toHaveLength(3);
    expect(allBody.runs.map((r) => r.status)).toContain("failed");

    const onlyFailed = await app.request("/api/automations/runs?status=failed", {
      headers: { "x-test-user": "admin" },
    });
    const failedBody = (await onlyFailed.json()) as { runs: { status: string }[] };
    expect(failedBody.runs).toHaveLength(1);
    expect(must(failedBody.runs[0]).status).toBe("failed");

    const otherRule = randomUUID();
    const byRule = await app.request(`/api/automations/runs?ruleId=${otherRule}`, {
      headers: { "x-test-user": "admin" },
    });
    expect(((await byRule.json()) as { runs: unknown[] }).runs).toHaveLength(0);

    const badQuery = await app.request("/api/automations/runs?status=nope", {
      headers: { "x-test-user": "admin" },
    });
    expect(badQuery.status).toBe(400);
  });
});
