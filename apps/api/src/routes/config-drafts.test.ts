import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, runMigrations, schema } from "@ally/db";
import { createApp } from "../app.ts";
import type { SessionData } from "../auth/session.ts";
import { createAuthzStore } from "../authz/service.ts";
import { registerNumberedSubject } from "../numbering/registry.ts";

// 集成测试：需要真实 PostgreSQL（台账唯一索引、发布事务、草稿 FOR UPDATE 行锁、
// 审计行数断言）。未设 DATABASE_URL 时跳过。
//
// 独立临时库（每次运行新建、跑完 drop，纪律同 config-versions.test.ts）：台账
// 行数与版本号是断言面，共享库上并行文件的残行会随机干扰。TRUNCATE 是本文件
// 自己的清库通道（config_revisions append-only 触发器拒绝行级 DELETE；草稿表
// 一并 TRUNCATE 保持断言面干净）。
registerNumberedSubject("fixture_invoice", { label: "Fixture invoice" });

const databaseUrl = process.env.DATABASE_URL;

const logger = pino({ level: "silent" });

/** admin 持全部 configure 权限点；carol 只有 numbering.configure 的个人附加授权
 * （跨族动态权限的反例面）；alice 零角色——403 的反例。走真表 + 真 authzStore。 */
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
}

interface DraftResponse {
  draft: {
    content: Record<string, unknown>;
    baseVersion: number;
    note: string | null;
    updatedById: string;
  };
  stale: boolean;
  changes: Record<string, { from: unknown; to: unknown }>;
}

const notifyAction = (title: string) => [{ type: "notify", config: { userIds: [USERS.admin], title } }];

const automationContent = {
  name: "task follow-up",
  description: null,
  trigger: { action: "task.created" },
  conditions: [] as unknown[],
  actions: notifyAction("new task"),
  enabled: true,
};

describe.skipIf(!databaseUrl)("config drafts: draft → one-click publish (#226 slice 2, integration)", () => {
  const dbName = `config_drafts_test_${String(Date.now())}_${String(process.pid)}`;
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
    await db.insert(schema.userPermission).values({
      userId: USERS.carol,
      permission: "numbering.configure",
    });
  });

  beforeEach(async () => {
    // 单语句 TRUNCATE：五族配置 + 台账 + 草稿 + 审计都是本文件的断言面
    await db.execute(
      sql`truncate table ${schema.configDrafts}, ${schema.configRevisions}, ${schema.workflowInstances}, ${schema.workflowTransitions}, ${schema.workflowTemplates}, ${schema.approvalActions}, ${schema.approvalRequests}, ${schema.approvalConfigs}, ${schema.customFieldValues}, ${schema.customFieldDefs}, ${schema.automationRuns}, ${schema.automationRules}, ${schema.numberingSequences}, ${schema.numberingRules}, ${schema.auditEvents} cascade`,
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
      body: JSON.stringify({
        name: automationContent.name,
        trigger: automationContent.trigger,
        conditions: automationContent.conditions,
        actions: automationContent.actions,
      }),
    });
    expect(res.status).toBe(201);
    return must(((await res.json()) as { id?: string }).id);
  }

  async function history(subjectType: string, subjectId: string): Promise<RevisionSummary[]> {
    const res = await app.request(`/api/config-versions/${subjectType}/${subjectId}`, {
      headers: adminHeaders,
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { revisions: RevisionSummary[] }).revisions;
  }

  function draftUrl(subjectType: string, subjectId: string): string {
    return `/api/config-drafts/${subjectType}/${subjectId}`;
  }

  it("saves a validated draft on top of the current version and answers its diff", async () => {
    const ruleId = await createAutomation();

    const put = await app.request(draftUrl("automation_rule", ruleId), {
      method: "PUT",
      headers: { ...jsonHeaders, ...adminHeaders },
      body: JSON.stringify({
        content: { ...automationContent, name: "draft rename", enabled: false },
        note: "quiet the follow-up while we rework the trigger",
      }),
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ subjectType: "automation_rule", baseVersion: 1 });

    const got = await app.request(draftUrl("automation_rule", ruleId), { headers: adminHeaders });
    expect(got.status).toBe(200);
    const body = (await got.json()) as DraftResponse;
    expect(body.draft.baseVersion).toBe(1);
    expect(body.draft.note).toBe("quiet the follow-up while we rework the trigger");
    expect(body.stale).toBe(false);
    expect(body.changes).toMatchObject({
      name: { from: "task follow-up", to: "draft rename" },
      enabled: { from: true, to: false },
    });

    // 活配置面没有被草稿污染：规则还是旧名字（「试」不碰生产行为是结构性的）
    const rulesRes = await app.request("/api/automations", { headers: adminHeaders });
    const rules = (await rulesRes.json()) as { rules: { id: string; name: string; version: number }[] };
    expect(rules.rules.find((rule) => rule.id === ruleId)).toMatchObject({
      name: "task follow-up",
      version: 1,
    });
  });

  it("rejects draft content that fails the family contract (strict shape and business rules)", async () => {
    const ruleId = await createAutomation();

    // 未知顶层键：strict 契约不静默剥键（管理员会以为改上了）
    const unknownKey = await app.request(draftUrl("automation_rule", ruleId), {
      method: "PUT",
      headers: { ...jsonHeaders, ...adminHeaders },
      body: JSON.stringify({ content: { ...automationContent, triggerTypo: true } }),
    });
    expect(unknownKey.status).toBe(400);
    expect(await unknownKey.json()).toMatchObject({ error: "invalid_content" });

    // 业务校验与配置面同强度：actions 为空数组过不了 ruleSpecSchema
    const emptyActions = await app.request(draftUrl("automation_rule", ruleId), {
      method: "PUT",
      headers: { ...jsonHeaders, ...adminHeaders },
      body: JSON.stringify({ content: { ...automationContent, actions: [] } }),
    });
    expect(emptyActions.status).toBe(400);
    const issues = ((await emptyActions.json()) as { issues?: string[] }).issues ?? [];
    expect(issues.length).toBeGreaterThan(0);

    // 未注册族 404；无内容改写路径的族 409（不假装能存草稿）；不存在对象 404
    const unregistered = await app.request(draftUrl("not_a_family", randomUUID()), {
      method: "PUT",
      headers: { ...jsonHeaders, ...adminHeaders },
      body: JSON.stringify({ content: {} }),
    });
    expect(unregistered.status).toBe(404);
    expect(await unregistered.json()).toMatchObject({ error: "unregistered_subject" });

    const templateRes = await app.request("/api/workflow-templates", {
      method: "POST",
      headers: { ...jsonHeaders, ...adminHeaders },
      body: JSON.stringify({
        subjectType: "lead",
        templateKey: "standard_lead",
        definition: {
          initial: "new",
          states: { new: { on: { CONTACT: "contacted" } }, contacted: {} },
        },
      }),
    });
    expect(templateRes.status).toBe(201);
    const templateId = must(((await templateRes.json()) as { id?: string }).id);
    const unsupported = await app.request(draftUrl("workflow_template", templateId), {
      method: "PUT",
      headers: { ...jsonHeaders, ...adminHeaders },
      body: JSON.stringify({ content: { active: false } }),
    });
    expect(unsupported.status).toBe(409);
    expect(await unsupported.json()).toMatchObject({ error: "publish_unsupported" });

    const missing = await app.request(draftUrl("automation_rule", randomUUID()), {
      method: "PUT",
      headers: { ...jsonHeaders, ...adminHeaders },
      body: JSON.stringify({ content: automationContent }),
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: "subject_not_found" });

    // 请求体形状：strict，note 超长 / content 缺失都是 400
    const badBody = await app.request(draftUrl("automation_rule", ruleId), {
      method: "PUT",
      headers: { ...jsonHeaders, ...adminHeaders },
      body: JSON.stringify({ content: automationContent, note: "x".repeat(501) }),
    });
    expect(badBody.status).toBe(400);
  });

  it("gates every draft endpoint on the family configure permission", async () => {
    const ruleId = await createAutomation();
    const url = draftUrl("automation_rule", ruleId);
    const put = { method: "PUT", headers: { ...jsonHeaders }, body: JSON.stringify({ content: automationContent }) };

    const alicePut = await app.request(url, { ...put, headers: { ...jsonHeaders, ...aliceHeaders } });
    expect(alicePut.status).toBe(403);
    expect(await alicePut.json()).toMatchObject({
      code: "permission_required",
      permission: "automations.configure",
    });

    // carol 只有 numbering.configure：自动化族全 403，编号族全 200
    expect(
      (await app.request(url, { ...put, headers: { ...jsonHeaders, ...carolHeaders } })).status,
    ).toBe(403);
    expect((await app.request(url, { headers: carolHeaders })).status).toBe(403);

    const numberingRes = await app.request("/api/numbering-rules", {
      method: "POST",
      headers: { ...jsonHeaders, ...carolHeaders },
      body: JSON.stringify({ subject: "fixture_invoice", label: "Fixture invoice", prefix: "INV-" }),
    });
    expect(numberingRes.status).toBe(201);
    const numberingId = must(((await numberingRes.json()) as { id?: string }).id);
    const numberingUrl = draftUrl("numbering_rule", numberingId);
    const carolPut = await app.request(numberingUrl, {
      method: "PUT",
      headers: { ...jsonHeaders, ...carolHeaders },
      body: JSON.stringify({
        content: { label: "Fixture invoice", prefix: "IN-", dateFormat: null, padding: 4, active: true },
        note: "align prefix with the renamed series",
      }),
    });
    expect(carolPut.status).toBe(200);
    expect((await app.request(numberingUrl, { headers: carolHeaders })).status).toBe(200);
    expect(
      (
        await app.request(`${numberingUrl}/publish`, {
          method: "POST",
          headers: { ...jsonHeaders, ...carolHeaders },
          body: JSON.stringify({}),
        })
      ).status,
    ).toBe(200);
  });

  it("publishes a draft as a new revision with audit and clears the draft", async () => {
    const ruleId = await createAutomation();
    await app.request(draftUrl("automation_rule", ruleId), {
      method: "PUT",
      headers: { ...jsonHeaders, ...adminHeaders },
      body: JSON.stringify({
        content: { ...automationContent, name: "draft rename", enabled: false },
        note: "quiet while reworking",
      }),
    });

    const publish = await app.request(`${draftUrl("automation_rule", ruleId)}/publish`, {
      method: "POST",
      headers: { ...jsonHeaders, ...adminHeaders },
      body: JSON.stringify({ reason: "reviewed and ready" }),
    });
    expect(publish.status).toBe(200);
    const parsed = (await publish.json()) as {
      fromVersion: number;
      publishedVersion: number;
      changes: Record<string, { from: unknown; to: unknown }>;
    };
    expect(parsed.fromVersion).toBe(1);
    expect(parsed.publishedVersion).toBe(2);
    expect(parsed.changes).toMatchObject({
      name: { from: "task follow-up", to: "draft rename" },
      enabled: { from: true, to: false },
    });

    // 配置行已生效（活配置面读），行.version 与台账同步
    const rulesRes = await app.request("/api/automations", { headers: adminHeaders });
    const rules = (await rulesRes.json()) as { rules: { id: string; name: string; enabled: boolean; version: number }[] };
    expect(rules.rules.find((rule) => rule.id === ruleId)).toMatchObject({
      name: "draft rename",
      enabled: false,
      version: 2,
    });

    // 台账：v2 = published；草稿已清（GET 404）
    const revisions = await history("automation_rule", ruleId);
    expect(revisions.map((rev) => rev.version)).toEqual([2, 1]);
    expect(revisions[0]).toMatchObject({ source: "published" });
    const draftGone = await app.request(draftUrl("automation_rule", ruleId), { headers: adminHeaders });
    expect(draftGone.status).toBe(404);
    expect(await draftGone.json()).toMatchObject({ error: "draft_not_found" });

    // 审计：config.published 一行，带 reason 与草稿 note
    const audits = await db
      .select({ detail: schema.auditEvents.detail })
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.action, "config.published"));
    expect(audits).toHaveLength(1);
    expect(audits[0]?.detail).toMatchObject({
      subjectType: "automation_rule",
      fromVersion: 1,
      publishedVersion: 2,
      reason: "reviewed and ready",
      note: "quiet while reworking",
    });
  });

  it("refuses to publish stale drafts (live changed under the draft) — re-save is the only path", async () => {
    const ruleId = await createAutomation();
    await app.request(draftUrl("automation_rule", ruleId), {
      method: "PUT",
      headers: { ...jsonHeaders, ...adminHeaders },
      body: JSON.stringify({ content: { ...automationContent, name: "draft rename" } }),
    });

    // 线上在草稿保存后前进了一版（PATCH 直接生效的既有面）
    const patch = await app.request(`/api/automations/${ruleId}`, {
      method: "PATCH",
      headers: { ...jsonHeaders, ...adminHeaders },
      body: JSON.stringify({ enabled: false }),
    });
    expect(patch.status).toBe(200);

    const publish = await app.request(`${draftUrl("automation_rule", ruleId)}/publish`, {
      method: "POST",
      headers: { ...jsonHeaders, ...adminHeaders },
      body: JSON.stringify({}),
    });
    expect(publish.status).toBe(409);
    expect(await publish.json()).toMatchObject({ error: "draft_stale", draftBaseVersion: 1, currentVersion: 2 });

    // GET 标记 stale，摘要现算相对最新现状——重存决策要看「草稿想改什么、现状已变成什么」
    const got = await app.request(draftUrl("automation_rule", ruleId), { headers: adminHeaders });
    const body = (await got.json()) as DraftResponse;
    expect(body.stale).toBe(true);
    expect(body.changes).toMatchObject({
      name: { from: "task follow-up", to: "draft rename" },
      enabled: { from: false, to: true },
    });

    // 重存（在新现状之上）→ 发布成功，版本接在 v2 之后
    await app.request(draftUrl("automation_rule", ruleId), {
      method: "PUT",
      headers: { ...jsonHeaders, ...adminHeaders },
      body: JSON.stringify({ content: { ...automationContent, name: "draft rename", enabled: false } }),
    });
    const republish = await app.request(`${draftUrl("automation_rule", ruleId)}/publish`, {
      method: "POST",
      headers: { ...jsonHeaders, ...adminHeaders },
      body: JSON.stringify({}),
    });
    expect(republish.status).toBe(200);
    expect(await republish.json()).toMatchObject({ fromVersion: 2, publishedVersion: 3 });
    expect((await history("automation_rule", ruleId)).map((rev) => rev.source)).toEqual([
      "published",
      "updated",
      "created",
    ]);
  });

  it("refuses no-change publishes and answers 404 after discard", async () => {
    const ruleId = await createAutomation();
    await app.request(draftUrl("automation_rule", ruleId), {
      method: "PUT",
      headers: { ...jsonHeaders, ...adminHeaders },
      body: JSON.stringify({ content: automationContent }),
    });
    const noChange = await app.request(`${draftUrl("automation_rule", ruleId)}/publish`, {
      method: "POST",
      headers: { ...jsonHeaders, ...adminHeaders },
      body: JSON.stringify({}),
    });
    expect(noChange.status).toBe(409);
    expect(await noChange.json()).toMatchObject({ error: "publish_no_change" });

    const discard = await app.request(draftUrl("automation_rule", ruleId), {
      method: "DELETE",
      headers: adminHeaders,
    });
    expect(discard.status).toBe(200);
    expect(await discard.json()).toMatchObject({ ok: true });
    const discardAgain = await app.request(draftUrl("automation_rule", ruleId), {
      method: "DELETE",
      headers: adminHeaders,
    });
    expect(discardAgain.status).toBe(404);
    const publishAfterDiscard = await app.request(`${draftUrl("automation_rule", ruleId)}/publish`, {
      method: "POST",
      headers: { ...jsonHeaders, ...adminHeaders },
      body: JSON.stringify({}),
    });
    expect(publishAfterDiscard.status).toBe(404);
    expect(await publishAfterDiscard.json()).toMatchObject({ error: "draft_not_found" });
    // 台账没有假版本
    expect(await history("automation_rule", ruleId)).toHaveLength(1);
  });

  it("publishes numbering drafts through the family contract and stays rollback-compatible", async () => {
    const numberingRes = await app.request("/api/numbering-rules", {
      method: "POST",
      headers: { ...jsonHeaders, ...adminHeaders },
      body: JSON.stringify({ subject: "fixture_invoice", label: "Fixture invoice", prefix: "INV-" }),
    });
    expect(numberingRes.status).toBe(201);
    const numberingId = must(((await numberingRes.json()) as { id?: string }).id);

    await app.request(draftUrl("numbering_rule", numberingId), {
      method: "PUT",
      headers: { ...jsonHeaders, ...adminHeaders },
      body: JSON.stringify({
        content: { label: "Fixture invoice", prefix: "IN-", dateFormat: null, padding: 4, active: true },
      }),
    });
    const publish = await app.request(`${draftUrl("numbering_rule", numberingId)}/publish`, {
      method: "POST",
      headers: { ...jsonHeaders, ...adminHeaders },
      body: JSON.stringify({}),
    });
    expect(publish.status).toBe(200);
    const rulesRes = await app.request("/api/numbering-rules", { headers: adminHeaders });
    const rules = (await rulesRes.json()) as { rules: { id: string; prefix: string }[] };
    expect(rules.rules.find((rule) => rule.id === numberingId)).toMatchObject({ prefix: "IN-" });
    expect((await history("numbering_rule", numberingId)).map((rev) => rev.source)).toEqual([
      "published",
      "created",
    ]);

    // 发布过的版本照常可回滚（发布是版本史的一部分，不另立特殊通道）
    const rollback = await app.request(`/api/config-versions/numbering_rule/${numberingId}/rollback`, {
      method: "POST",
      headers: { ...jsonHeaders, ...adminHeaders },
      body: JSON.stringify({ toVersion: 1 }),
    });
    expect(rollback.status).toBe(200);
    expect(await rollback.json()).toMatchObject({ restoredVersion: 1, newVersion: 3 });

    // custom_field_def：草稿契约带 select 选项规则——select 无选项 400（与配置面同强度）
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
    const badSelect = await app.request(draftUrl("custom_field_def", fieldId), {
      method: "PUT",
      headers: { ...jsonHeaders, ...adminHeaders },
      body: JSON.stringify({
        content: {
          label: "PO number",
          fieldType: "select",
          options: null,
          required: true,
          viewableBy: ["admin"],
          editableBy: ["admin"],
          active: true,
        },
      }),
    });
    expect(badSelect.status).toBe(400);
    expect(await badSelect.json()).toMatchObject({ error: "invalid_content" });
    const goodDraft = await app.request(draftUrl("custom_field_def", fieldId), {
      method: "PUT",
      headers: { ...jsonHeaders, ...adminHeaders },
      body: JSON.stringify({
        content: {
          label: "PO number (renamed)",
          fieldType: "text",
          options: null,
          required: false,
          viewableBy: ["admin"],
          editableBy: ["admin"],
          active: true,
        },
      }),
    });
    expect(goodDraft.status).toBe(200);
    const fieldPublish = await app.request(`${draftUrl("custom_field_def", fieldId)}/publish`, {
      method: "POST",
      headers: { ...jsonHeaders, ...adminHeaders },
      body: JSON.stringify({}),
    });
    expect(fieldPublish.status).toBe(200);
    const fieldsRes = await app.request("/api/custom-fields", { headers: adminHeaders });
    const fields = (await fieldsRes.json()) as { fields: { id: string; label: string; required: boolean }[] };
    expect(fields.fields.find((field) => field.id === fieldId)).toMatchObject({
      label: "PO number (renamed)",
      required: false,
    });
  });
});
