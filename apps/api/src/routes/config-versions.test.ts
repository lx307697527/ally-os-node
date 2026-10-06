import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, runMigrations, schema } from "@ally/db";
import { createApp } from "../app.ts";
import type { SessionData } from "../auth/session.ts";
import { createAuthzStore } from "../authz/service.ts";
import { registerNumberedSubject } from "../numbering/registry.ts";

// 集成测试：需要真实 PostgreSQL（append-only 触发器、审计行数断言、同事务记账）。
// 未设 DATABASE_URL 时跳过。
//
// 本文件用**独立的临时库**（每次运行新建、跑完 drop，纪律同 numbering-rules
// 测试）：台账行数与版本号是断言面，共享库上并行文件的残行会随机干扰。TRUNCATE
// 是本文件自己的清库通道（config_revisions 是 append-only，行级 DELETE 被触发器
// 拒绝，TRUNCATE 是 DDL 不触发行触发器——生产代码没有这条路）。
//
// 五族配置的注册在 families.ts 模块装载时发生（createApp → app.ts 的 side-effect
// import），与生产同一条路径；夹具族不需要另注。可编号 subject 注册表生产为空
// （单据域 phase-2+），本文件注入夹具域——vitest 按文件隔离模块，不外溢。
registerNumberedSubject("fixture_invoice", { label: "Fixture invoice" });

const databaseUrl = process.env.DATABASE_URL;

const logger = pino({ level: "silent" });

/** admin 持全部 configure 权限点（owner/admin 默认集）；carol 只有
 * numbering.configure 的个人附加授权（跨族动态权限的反例面）；alice 零角色——
 * 403 的反例。角色/授权走真表 + 真 authzStore（权限链端到端），不做桩。 */
const USERS = {
  admin: randomUUID(),
  carol: randomUUID(),
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

interface RevisionSummary {
  version: number;
  source: string;
  changes: Record<string, { from: unknown; to: unknown }> | null;
  changedById: string | null;
  createdAt: string;
}

interface RevisionDetail extends RevisionSummary {
  snapshot: Record<string, unknown>;
}

const automationBody = {
  name: "task follow-up",
  description: "follow up created tasks",
  trigger: { action: "task.created" },
  conditions: [{ path: "detail.title", op: "exists", value: true }],
  actions: [{ type: "notify", config: { userIds: [USERS.admin], title: "new task" } }],
};

describe.skipIf(!databaseUrl)("config version ledger (#226 slice 1, integration)", () => {
  const dbName = `config_versions_test_${String(Date.now())}_${String(process.pid)}`;
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
    // carol 的个人附加授权：只有编号规则的配置权限（跨族动态权限的反例面）
    await db.insert(schema.userPermission).values({
      userId: USERS.carol,
      permission: "numbering.configure",
    });
  });

  beforeEach(async () => {
    // 单语句 TRUNCATE：五族配置 + 台账 + 审计都是本文件的断言面
    await db.execute(
      sql`truncate table ${schema.configRevisions}, ${schema.workflowInstances}, ${schema.workflowTransitions}, ${schema.workflowTemplates}, ${schema.approvalActions}, ${schema.approvalRequests}, ${schema.approvalConfigs}, ${schema.customFieldValues}, ${schema.customFieldDefs}, ${schema.automationRuns}, ${schema.automationRules}, ${schema.numberingSequences}, ${schema.numberingRules}, ${schema.auditEvents} cascade`,
    );
  });

  afterAll(async () => {
    await pool.end();
    await admin.pool.query(`drop database if exists "${dbName}" with (force)`);
    await admin.pool.end();
  });

  const adminHeaders = { "x-test-user": "admin" };
  const carolHeaders = { "x-test-user": "carol" };
  const aliceHeaders = { "x-test-user": "alice" };
  const jsonHeaders = { "content-type": "application/json" };

  async function createAutomation(): Promise<string> {
    const res = await app.request("/api/automations", {
      method: "POST",
      headers: { ...jsonHeaders, ...adminHeaders },
      body: JSON.stringify(automationBody),
    });
    expect(res.status).toBe(201);
    return must(((await res.json()) as { id?: string }).id);
  }

  async function history(subjectType: string, subjectId: string, headers = adminHeaders) {
    const res = await app.request(`/api/config-versions/${subjectType}/${subjectId}`, {
      headers,
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { revisions: RevisionSummary[] }).revisions;
  }

  it("lists the six registered config families", async () => {
    const res = await app.request("/api/config-versions/subjects", { headers: adminHeaders });
    expect(res.status).toBe(200);
    const parsed = (await res.json()) as { subjects: { subjectType: string; label: string }[] };
    expect(parsed.subjects.map((s) => s.subjectType)).toEqual([
      "approval_config",
      "automation_rule",
      "custom_field_def",
      "numbering_rule",
      "registry_rule",
      "workflow_template",
    ]);
  });

  it("answers 404 for unregistered subject types and 403 for family permissions", async () => {
    const missing = await app.request(
      `/api/config-versions/not_a_family/${randomUUID()}`,
      { headers: adminHeaders },
    );
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: "unregistered_subject" });

    // alice 零权限：任何族都 403；carol 只有 numbering.configure：编号族 200、
    // 自动化族 403——动态按族裁决，不是单一权限点一刀切
    const automationId = await createAutomation();
    const aliceView = await app.request(`/api/config-versions/automation_rule/${automationId}`, {
      headers: aliceHeaders,
    });
    expect(aliceView.status).toBe(403);
    expect(await aliceView.json()).toMatchObject({
      code: "permission_required",
      permission: "automations.configure",
    });
    const carolDenied = await app.request(`/api/config-versions/automation_rule/${automationId}`, {
      headers: carolHeaders,
    });
    expect(carolDenied.status).toBe(403);

    const numberingRes = await app.request("/api/numbering-rules", {
      method: "POST",
      headers: { ...jsonHeaders, ...carolHeaders },
      body: JSON.stringify({ subject: "fixture_invoice", label: "Fixture invoice" }),
    });
    expect(numberingRes.status).toBe(201);
    const numberingId = must(((await numberingRes.json()) as { id?: string }).id);
    const carolAllowed = await app.request(`/api/config-versions/numbering_rule/${numberingId}`, {
      headers: carolHeaders,
    });
    expect(carolAllowed.status).toBe(200);
    expect(((await carolAllowed.json()) as { revisions: RevisionSummary[] }).revisions).toHaveLength(1);
  });

  it("records v1 on create and every real change on patch (automation lifecycle)", async () => {
    const ruleId = await createAutomation();

    const v1 = await history("automation_rule", ruleId);
    expect(v1).toHaveLength(1);
    expect(v1[0]).toMatchObject({ version: 1, source: "created", changes: null });

    // 改名 → v2（changes 只带 name）
    const rename = await app.request(`/api/automations/${ruleId}`, {
      method: "PATCH",
      headers: { ...jsonHeaders, ...adminHeaders },
      body: JSON.stringify({ name: "task follow-up v2" }),
    });
    expect(rename.status).toBe(200);
    expect(await rename.json()).toMatchObject({ version: 2 });

    // 换 spec → v3（changes 带 trigger/conditions/actions 各自的 from/to）
    const respec = await app.request(`/api/automations/${ruleId}`, {
      method: "PATCH",
      headers: { ...jsonHeaders, ...adminHeaders },
      body: JSON.stringify({
        spec: {
          trigger: { action: "comment.created" },
          conditions: [],
          actions: [{ type: "notify", config: { userIds: [USERS.admin], title: "new comment" } }],
        },
      }),
    });
    expect(respec.status).toBe(200);
    expect(await respec.json()).toMatchObject({ version: 3 });

    const v3 = await history("automation_rule", ruleId);
    expect(v3.map((rev) => rev.version)).toEqual([3, 2, 1]);
    expect(v3[0]?.changes).toMatchObject({ trigger: { from: { action: "task.created" } } });
    expect(v3[1]?.changes).toMatchObject({ name: { from: "task follow-up", to: "task follow-up v2" } });

    // 无实效变更：幂等返回现状，不记账（台账仍是 3 版）
    const noop = await app.request(`/api/automations/${ruleId}`, {
      method: "PATCH",
      headers: { ...jsonHeaders, ...adminHeaders },
      body: JSON.stringify({ name: "task follow-up v2" }),
    });
    expect(noop.status).toBe(200);
    expect(await noop.json()).toMatchObject({ version: 3 });
    expect(await history("automation_rule", ruleId)).toHaveLength(3);

    // 行.version 与台账同步（「行.version = 台账最新版」不变式）
    const rowVersion = await db
      .select({ version: schema.automationRules.version })
      .from(schema.automationRules)
      .where(eq(schema.automationRules.id, ruleId));
    expect(rowVersion[0]?.version).toBe(3);
  });

  it("serves revision detail and path-level diff between two versions", async () => {
    const ruleId = await createAutomation();
    await app.request(`/api/automations/${ruleId}`, {
      method: "PATCH",
      headers: { ...jsonHeaders, ...adminHeaders },
      body: JSON.stringify({ name: "renamed rule" }),
    });

    const detailRes = await app.request(`/api/config-versions/automation_rule/${ruleId}/revisions/1`, {
      headers: adminHeaders,
    });
    expect(detailRes.status).toBe(200);
    const detail = ((await detailRes.json()) as { revision: RevisionDetail }).revision;
    expect(detail.snapshot).toMatchObject({ name: "task follow-up", enabled: true });
    expect(detail.snapshot).toHaveProperty("trigger");

    const diffRes = await app.request(
      `/api/config-versions/automation_rule/${ruleId}/diff?from=1&to=2`,
      { headers: adminHeaders },
    );
    expect(diffRes.status).toBe(200);
    const diff = (await diffRes.json()) as { changes: { path: string; from: unknown; to: unknown }[] };
    expect(diff.changes).toEqual([{ path: "name", from: "task follow-up", to: "renamed rule" }]);

    // 嵌套路径：换 spec 后 trigger.action 是路径级差异，不是整棵 trigger 子树
    await app.request(`/api/automations/${ruleId}`, {
      method: "PATCH",
      headers: { ...jsonHeaders, ...adminHeaders },
      body: JSON.stringify({
        spec: {
          trigger: { action: "comment.created" },
          conditions: [],
          actions: [{ type: "notify", config: { userIds: [USERS.admin], title: "new comment" } }],
        },
      }),
    });
    const nestedDiffRes = await app.request(
      `/api/config-versions/automation_rule/${ruleId}/diff?from=2&to=3`,
      { headers: adminHeaders },
    );
    expect(nestedDiffRes.status).toBe(200);
    const nestedDiff = (await nestedDiffRes.json()) as {
      changes: { path: string }[];
    };
    expect(nestedDiff.changes.map((change) => change.path)).toContain("trigger.action");
    expect(nestedDiff.changes.map((change) => change.path)).not.toContain("trigger");

    const badDiff = await app.request(
      `/api/config-versions/automation_rule/${ruleId}/diff?from=2&to=2`,
      { headers: adminHeaders },
    );
    expect(badDiff.status).toBe(400);
    const missingVersion = await app.request(
      `/api/config-versions/automation_rule/${ruleId}/diff?from=1&to=99`,
      { headers: adminHeaders },
    );
    expect(missingVersion.status).toBe(404);
  });

  it("rolls an automation rule back to a historical version as a new revision", async () => {
    const ruleId = await createAutomation();
    await app.request(`/api/automations/${ruleId}`, {
      method: "PATCH",
      headers: { ...jsonHeaders, ...adminHeaders },
      body: JSON.stringify({ name: "renamed rule", enabled: false }),
    });

    const rollback = await app.request(`/api/config-versions/automation_rule/${ruleId}/rollback`, {
      method: "POST",
      headers: { ...jsonHeaders, ...adminHeaders },
      body: JSON.stringify({ toVersion: 1, reason: "spec review" }),
    });
    expect(rollback.status).toBe(200);
    const parsed = (await rollback.json()) as {
      restoredVersion: number;
      newVersion: number;
      changes: Record<string, { from: unknown; to: unknown }>;
    };
    expect(parsed.restoredVersion).toBe(1);
    expect(parsed.newVersion).toBe(3);
    expect(parsed.changes).toMatchObject({
      name: { from: "renamed rule", to: "task follow-up" },
      enabled: { from: false, to: true },
    });

    // 配置行内容已恢复（读配置面验证，不读行）
    const rulesRes = await app.request("/api/automations", { headers: adminHeaders });
    const rules = (await rulesRes.json()) as {
      rules: { id: string; name: string; enabled: boolean; version: number }[];
    };
    const restored = rules.rules.find((rule) => rule.id === ruleId);
    expect(restored).toMatchObject({ name: "task follow-up", enabled: true, version: 3 });

    // 台账：v3 = rolled_back，快照与 v1 同内容；历史行未被改写（4 行递增）
    const revisions = await history("automation_rule", ruleId);
    expect(revisions.map((rev) => rev.version)).toEqual([3, 2, 1]);
    expect(revisions[0]).toMatchObject({ source: "rolled_back" });
    const v1Detail = await app.request(
      `/api/config-versions/automation_rule/${ruleId}/revisions/1`,
      { headers: adminHeaders },
    );
    const v3Detail = await app.request(
      `/api/config-versions/automation_rule/${ruleId}/revisions/3`,
      { headers: adminHeaders },
    );
    expect(((await v3Detail.json()) as { revision: RevisionDetail }).revision.snapshot).toEqual(
      ((await v1Detail.json()) as { revision: RevisionDetail }).revision.snapshot,
    );

    // 审计：config.rolled_back 一行，带 reason
    const audits = await db
      .select({ detail: schema.auditEvents.detail })
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.action, "config.rolled_back"));
    expect(audits).toHaveLength(1);
    expect(audits[0]?.detail).toMatchObject({
      subjectType: "automation_rule",
      restoredVersion: 1,
      newVersion: 3,
      reason: "spec review",
    });

    // 回滚到现状内容 = no-op，409；回滚到不存在的版本 = 404
    const noChange = await app.request(`/api/config-versions/automation_rule/${ruleId}/rollback`, {
      method: "POST",
      headers: { ...jsonHeaders, ...adminHeaders },
      body: JSON.stringify({ toVersion: 3 }),
    });
    expect(noChange.status).toBe(409);
    expect(await noChange.json()).toMatchObject({ error: "rollback_no_change" });
    const missing = await app.request(`/api/config-versions/automation_rule/${ruleId}/rollback`, {
      method: "POST",
      headers: { ...jsonHeaders, ...adminHeaders },
      body: JSON.stringify({ toVersion: 99 }),
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: "revision_not_found" });
  });

  it("rolls numbering rules and custom field defs back through their family contracts", async () => {
    // 编号规则：格式就地改 → 回滚恢复格式（#225 的就地改纪律 × #226 的回滚）
    const numberingRes = await app.request("/api/numbering-rules", {
      method: "POST",
      headers: { ...jsonHeaders, ...adminHeaders },
      body: JSON.stringify({ subject: "fixture_invoice", label: "Fixture invoice", prefix: "INV-" }),
    });
    expect(numberingRes.status).toBe(201);
    const numberingId = must(((await numberingRes.json()) as { id?: string }).id);
    await app.request(`/api/numbering-rules/${numberingId}`, {
      method: "PATCH",
      headers: { ...jsonHeaders, ...adminHeaders },
      body: JSON.stringify({ prefix: "IN-" }),
    });
    const numberingRollback = await app.request(
      `/api/config-versions/numbering_rule/${numberingId}/rollback`,
      {
        method: "POST",
        headers: { ...jsonHeaders, ...adminHeaders },
        body: JSON.stringify({ toVersion: 1 }),
      },
    );
    expect(numberingRollback.status).toBe(200);
    const rulesRes = await app.request("/api/numbering-rules", { headers: adminHeaders });
    const rules = (await rulesRes.json()) as { rules: { id: string; prefix: string }[] };
    expect(rules.rules.find((rule) => rule.id === numberingId)?.prefix).toBe("INV-");
    // 起始号不在快照契约里：回滚不改 startNumber（号码系列的连续性是事实，不是配置）
    const numberingRevisions = await history("numbering_rule", numberingId);
    expect(numberingRevisions).toHaveLength(3);

    // 自定义字段：停用 → 回滚恢复；翻到现状 = 幂等（不记账）
    const fieldRes = await app.request("/api/custom-fields", {
      method: "POST",
      headers: { ...jsonHeaders, ...adminHeaders },
      body: JSON.stringify({
        subjectType: "fixture_object",
        fieldKey: "po_number",
        label: "PO number",
        fieldType: "text",
        required: true,
        viewableBy: ["admin"],
        editableBy: ["admin"],
      }),
    });
    expect(fieldRes.status).toBe(201);
    const fieldId = must(((await fieldRes.json()) as { id?: string }).id);
    await app.request(`/api/custom-fields/${fieldId}`, {
      method: "PATCH",
      headers: { ...jsonHeaders, ...adminHeaders },
      body: JSON.stringify({ active: false }),
    });
    const idempotentFlip = await app.request(`/api/custom-fields/${fieldId}`, {
      method: "PATCH",
      headers: { ...jsonHeaders, ...adminHeaders },
      body: JSON.stringify({ active: false }),
    });
    expect(idempotentFlip.status).toBe(200);
    expect(await history("custom_field_def", fieldId)).toHaveLength(2);
    const fieldRollback = await app.request(
      `/api/config-versions/custom_field_def/${fieldId}/rollback`,
      {
        method: "POST",
        headers: { ...jsonHeaders, ...adminHeaders },
        body: JSON.stringify({ toVersion: 1 }),
      },
    );
    expect(fieldRollback.status).toBe(200);
    const fieldsRes = await app.request("/api/custom-fields", { headers: adminHeaders });
    const fields = (await fieldsRes.json()) as { fields: { id: string; active: boolean }[] };
    expect(fields.fields.find((field) => field.id === fieldId)?.active).toBe(true);
  });

  it("records v1 for create-only families and refuses their rollback", async () => {
    const templateRes = await app.request("/api/workflow-templates", {
      method: "POST",
      headers: { ...jsonHeaders, ...adminHeaders },
      body: JSON.stringify({
        subjectType: "lead",
        templateKey: "standard_lead",
        definition: {
          initial: "new",
          states: {
            new: { on: { CONTACT: "contacted", DISQUALIFY: "disqualified" } },
            contacted: { on: { QUALIFY: "qualified" } },
            qualified: {},
            disqualified: {},
          },
        },
      }),
    });
    expect(templateRes.status).toBe(201);
    const templateId = must(((await templateRes.json()) as { id?: string }).id);
    const templateRevisions = await history("workflow_template", templateId);
    expect(templateRevisions).toHaveLength(1);
    expect(templateRevisions[0]).toMatchObject({ version: 1, source: "created" });

    const levels = [{ name: "step-1", users: [USERS.admin], roles: [] }];
    const configRes = await app.request("/api/approval-configs", {
      method: "POST",
      headers: { ...jsonHeaders, ...adminHeaders },
      body: JSON.stringify({
        subjectType: "quote_discount",
        configKey: "discount_line",
        name: "Discount line",
        levels,
      }),
    });
    expect(configRes.status).toBe(201);
    const configId = must(((await configRes.json()) as { id?: string }).id);
    expect(await history("approval_config", configId)).toHaveLength(1);

    // 定义改写端点未进场：回滚 409（明确说「这族还回滚不了」，不假装成功）
    const templateRollback = await app.request(
      `/api/config-versions/workflow_template/${templateId}/rollback`,
      {
        method: "POST",
        headers: { ...jsonHeaders, ...adminHeaders },
        body: JSON.stringify({ toVersion: 1 }),
      },
    );
    expect(templateRollback.status).toBe(409);
    expect(await templateRollback.json()).toMatchObject({ error: "rollback_unsupported" });
    const configRollback = await app.request(
      `/api/config-versions/approval_config/${configId}/rollback`,
      {
        method: "POST",
        headers: { ...jsonHeaders, ...adminHeaders },
        body: JSON.stringify({ toVersion: 1 }),
      },
    );
    expect(configRollback.status).toBe(409);
  });

  it("keeps the ledger append-only at the database level", async () => {
    const ruleId = await createAutomation();
    // 台账行级 UPDATE/DELETE 被触发器拒绝（与 audit_events 同一裁决）；测试清库
    // 走 TRUNCATE（beforeEach 已在用），生产代码没有改写台账的路
    await expect(
      db.execute(
        sql`update ${schema.configRevisions} set version = 99 where subject_type = 'automation_rule' and subject_id = ${ruleId}`,
      ),
    ).rejects.toThrow();
    await expect(
      db.execute(
        sql`delete from ${schema.configRevisions} where subject_type = 'automation_rule' and subject_id = ${ruleId}`,
      ),
    ).rejects.toThrow();
    // 快照原样未动
    expect(await history("automation_rule", ruleId)).toHaveLength(1);
    const rowCount = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.configRevisions)
      .where(
        and(
          eq(schema.configRevisions.subjectType, "automation_rule"),
          eq(schema.configRevisions.subjectId, ruleId),
        ),
      );
    expect(rowCount[0]?.count).toBe(1);
  });
});
