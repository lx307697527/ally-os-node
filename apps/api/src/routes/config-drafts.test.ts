import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, runMigrations, schema } from "@ally/db";
import { createApp } from "../app.ts";
import type { SessionData } from "../auth/session.ts";
import { createAuthzStore } from "../authz/service.ts";
import { registerNumberedSubject } from "../numbering/registry.ts";
import { SUBJECT_LOADERS } from "../subjects/registry.ts";

// 集成测试：需要真实 PostgreSQL（台账唯一索引、发布事务、草稿 FOR UPDATE 行锁、
// 审计行数断言）。未设 DATABASE_URL 时跳过。
//
// 独立临时库（每次运行新建、跑完 drop，纪律同 config-versions.test.ts）：台账
// 行数与版本号是断言面，共享库上并行文件的残行会随机干扰。TRUNCATE 是本文件
// 自己的清库通道（config_revisions append-only 触发器拒绝行级 DELETE；草稿表
// 一并 TRUNCATE 保持断言面干净）。
registerNumberedSubject("fixture_invoice", { label: "Fixture invoice" });

// 夹具单据域（在飞快照隔离测试的提交面）：存在性与可见者集合都在内存里，
// 与 approvals.test.ts 的 approval-doc 同一裁法——审批内核对单据域的唯一依赖
// 是可见性门 subjects/registry.ts。
const fixtureDocs = new Map<string, { title: string; viewerIds: string[] }>();

SUBJECT_LOADERS["draft-doc"] = (_db, subjectId) => {
  const doc = fixtureDocs.get(subjectId);
  if (doc === undefined) return Promise.resolve(null);
  return Promise.resolve({
    id: subjectId,
    title: doc.title,
    viewers: doc.viewerIds.map((id) => ({ id, name: id })),
  });
};

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
  trigger: { kind: "event", action: "task.created" },
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
    stripe: undefined,
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
    // 本套件不 exercise 附件端点；真被调到会在这里大声炸（AppDeps.storage 必选）
    storage: {
      put: () => Promise.reject(new Error("storage not used in this suite")),
      signedGetUrl: () => Promise.reject(new Error("storage not used in this suite")),
      signedPutUrl: () => Promise.reject(new Error("storage not used in this suite")),
      delete: () => Promise.reject(new Error("storage not used in this suite")),
    },
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
    // 单语句 TRUNCATE：六族配置 + 台账 + 草稿 + 审计都是本文件的断言面
    // （registry_rules 在「409 无草稿面」反例里种行）
    await db.execute(
      sql`truncate table ${schema.configDrafts}, ${schema.configRevisions}, ${schema.workflowInstances}, ${schema.workflowTransitions}, ${schema.workflowTemplates}, ${schema.approvalActions}, ${schema.approvalRequests}, ${schema.approvalConfigs}, ${schema.customFieldValues}, ${schema.customFieldDefs}, ${schema.automationRuns}, ${schema.automationRules}, ${schema.numberingSequences}, ${schema.numberingRules}, ${schema.registryRules}, ${schema.auditEvents} cascade`,
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

    // registry_rule 刻意没有草稿面（#233：「先试后上」由定时生效承担，草稿会
    // 与待生效变更长出两套同一机制）——草稿面对它 409，409 钉随 approval 草稿
    // 契约进场（#226 切片 3）从 approval 挪到这；不存在对象 404
    await db.insert(schema.registryRules).values({
      key: "fixture.draft_unsupported",
      label: "Fixture rule without a draft face",
      category: "param",
      valueType: "number",
      value: 10,
      changeableBy: ["admin"],
      adjudicationRefs: ["R-06-4"],
    });
    const ruleRow = await db
      .select({ id: schema.registryRules.id })
      .from(schema.registryRules)
      .where(eq(schema.registryRules.key, "fixture.draft_unsupported"))
      .limit(1);
    const unsupported = await app.request(draftUrl("registry_rule", must(ruleRow[0]?.id)), {
      method: "PUT",
      headers: { ...jsonHeaders, ...adminHeaders },
      body: JSON.stringify({ content: { value: 8 } }),
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

  // ── approval_config 草稿契约（#226 切片 3：定义改写面 #289 之后的草稿半边）──

  async function createApprovalConfig(input: {
    subjectType: string;
    configKey: string;
    name?: string;
    levels: unknown;
  }): Promise<string> {
    const res = await app.request("/api/approval-configs", {
      method: "POST",
      headers: { ...jsonHeaders, ...adminHeaders },
      body: JSON.stringify({
        subjectType: input.subjectType,
        configKey: input.configKey,
        name: input.name ?? `Line ${input.configKey}`,
        levels: input.levels,
      }),
    });
    expect(res.status).toBe(201);
    return must(((await res.json()) as { id?: string }).id);
  }

  const singleLevel = (userId: string) => [{ name: "step-1", users: [userId], roles: [] }];

  it("carries approval lines through the draft contract: try offline, publish, ledger and audit", async () => {
    const configId = await createApprovalConfig({
      subjectType: "quote_discount",
      configKey: "discount_line",
      name: "Discount line",
      levels: singleLevel(USERS.admin),
    });

    const put = await app.request(draftUrl("approval_config", configId), {
      method: "PUT",
      headers: { ...jsonHeaders, ...adminHeaders },
      body: JSON.stringify({
        content: {
          name: "Discount line v2",
          levels: [...singleLevel(USERS.admin), { name: "step-2", users: [], roles: ["admin"] }],
          active: true,
        },
        note: "add a second gate before discount lines go live",
      }),
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ subjectType: "approval_config", baseVersion: 1 });

    const got = await app.request(draftUrl("approval_config", configId), { headers: adminHeaders });
    expect(got.status).toBe(200);
    const body = (await got.json()) as DraftResponse;
    expect(body.stale).toBe(false);
    expect(body.changes).toMatchObject({
      name: { from: "Discount line", to: "Discount line v2" },
    });
    expect(body.draft.note).toBe("add a second gate before discount lines go live");

    // 活配置面没有被草稿污染：线还是单级、旧名（「试」不碰生产行为是结构性的）
    const listRes = await app.request("/api/approval-configs", { headers: adminHeaders });
    const configs = (await listRes.json()) as {
      configs: { id: string; name: string; levels: unknown[]; version: number }[];
    };
    expect(configs.configs.find((config) => config.id === configId)).toMatchObject({
      name: "Discount line",
      version: 1,
    });

    const publish = await app.request(`${draftUrl("approval_config", configId)}/publish`, {
      method: "POST",
      headers: { ...jsonHeaders, ...adminHeaders },
      body: JSON.stringify({ reason: "reviewed with sales lead" }),
    });
    expect(publish.status).toBe(200);
    const parsed = (await publish.json()) as {
      fromVersion: number;
      publishedVersion: number;
      changes: Record<string, { from: unknown; to: unknown }>;
    };
    expect(parsed.fromVersion).toBe(1);
    expect(parsed.publishedVersion).toBe(2);
    expect(Object.keys(parsed.changes)).toEqual(["name", "levels"]);

    // 配置行已生效、行.version 与台账同步；台账 v2 = published；草稿已清
    const after = (await (
      await app.request("/api/approval-configs", { headers: adminHeaders })
    ).json()) as { configs: { id: string; name: string; levels: unknown[]; version: number }[] };
    const published = must(after.configs.find((config) => config.id === configId));
    expect(published.name).toBe("Discount line v2");
    expect(published.levels).toHaveLength(2);
    expect(published.version).toBe(2);
    expect((await history("approval_config", configId)).map((rev) => rev.source)).toEqual([
      "published",
      "created",
    ]);
    const draftGone = await app.request(draftUrl("approval_config", configId), { headers: adminHeaders });
    expect(draftGone.status).toBe(404);

    const audits = await db
      .select({ detail: schema.auditEvents.detail })
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.action, "config.published"));
    expect(audits).toHaveLength(1);
    expect(audits[0]?.detail).toMatchObject({
      subjectType: "approval_config",
      fromVersion: 1,
      publishedVersion: 2,
      reason: "reviewed with sales lead",
      note: "add a second gate before discount lines go live",
    });
  });

  it("rejects approval draft content that fails the family contract (same strength as the save face)", async () => {
    const configId = await createApprovalConfig({
      subjectType: "quote_discount",
      configKey: "contract_line",
      levels: singleLevel(USERS.admin),
    });

    const put = async (content: Record<string, unknown>): Promise<{ status: number; issues: string[] }> => {
      const res = await app.request(draftUrl("approval_config", configId), {
        method: "PUT",
        headers: { ...jsonHeaders, ...adminHeaders },
        body: JSON.stringify({ content }),
      });
      return { status: res.status, issues: ((await res.json()) as { issues?: string[] }).issues ?? [] };
    };

    // 空级别数组、customer 角色、quorum 缺票数、未知顶层键——与 POST/PATCH 面
    // 同一道 approvalLevelsSchema，语义不合格的内容不能借草稿面绕过 422
    for (const levels of [
      [],
      [{ name: "step-1", users: [], roles: ["customer"] }],
      [{ name: "step-1", users: [], roles: ["admin"], mode: "quorum" }],
    ]) {
      const bad = await put({ name: "x", levels, active: true });
      expect(bad.status).toBe(400);
      expect(bad.issues.length).toBeGreaterThan(0);
    }
    const unknownKey = await put({ name: "x", levels: singleLevel(USERS.admin), active: true, keys: 1 });
    expect(unknownKey.status).toBe(400);
    // 存坏的没写进去：草稿面仍是 404（无草稿）
    expect((await app.request(draftUrl("approval_config", configId), { headers: adminHeaders })).status).toBe(404);
  });

  it("publishing approval drafts rewrites future routing but not in-flight requests (snapshot at submit)", async () => {
    const docId = randomUUID();
    fixtureDocs.set(docId, {
      title: "Isolation doc",
      viewerIds: [USERS.admin, USERS.carol, USERS.alice],
    });
    const configId = await createApprovalConfig({
      subjectType: "draft-doc",
      configKey: "isolation_line",
      levels: singleLevel(USERS.carol),
    });

    const submit = await app.request("/api/approval-requests", {
      method: "POST",
      headers: { ...jsonHeaders, ...adminHeaders },
      body: JSON.stringify({ subjectType: "draft-doc", subjectId: docId, configKey: "isolation_line" }),
    });
    expect(submit.status).toBe(201);
    const { requestId } = (await submit.json()) as { requestId: string };

    // 草稿换审批人（carol → alice）并发布：线上路线就此改变
    const put = await app.request(draftUrl("approval_config", configId), {
      method: "PUT",
      headers: { ...jsonHeaders, ...adminHeaders },
      body: JSON.stringify({
        content: { name: "Line isolation_line", levels: singleLevel(USERS.alice), active: true },
      }),
    });
    expect(put.status).toBe(200);
    const publish = await app.request(`${draftUrl("approval_config", configId)}/publish`, {
      method: "POST",
      headers: { ...jsonHeaders, ...adminHeaders },
      body: JSON.stringify({}),
    });
    expect(publish.status).toBe(200);

    // 在飞请求带着提交时刻的级别快照：carol 仍在待办、alice 不在；carol 照常可裁
    const carolTodo = (await (
      await app.request("/api/approval-requests/todo", { headers: carolHeaders })
    ).json()) as { requests: { requestId: string }[] };
    expect(carolTodo.requests.map((row) => row.requestId)).toContain(requestId);
    const aliceTodo = (await (
      await app.request("/api/approval-requests/todo", { headers: aliceHeaders })
    ).json()) as { requests: { requestId: string }[] };
    expect(aliceTodo.requests.map((row) => row.requestId)).not.toContain(requestId);
    const act = await app.request(`/api/approval-requests/${requestId}/actions`, {
      method: "POST",
      headers: { ...jsonHeaders, ...carolHeaders },
      body: JSON.stringify({ decision: "approved" }),
    });
    expect(act.status).toBe(200);

    // 新提交走发布后的路线：alice 在待办、carol 不在
    const docId2 = randomUUID();
    fixtureDocs.set(docId2, { title: "Post-publish doc", viewerIds: [USERS.admin, USERS.carol, USERS.alice] });
    const second = await app.request("/api/approval-requests", {
      method: "POST",
      headers: { ...jsonHeaders, ...adminHeaders },
      body: JSON.stringify({ subjectType: "draft-doc", subjectId: docId2, configKey: "isolation_line" }),
    });
    expect(second.status).toBe(201);
    const secondId = ((await second.json()) as { requestId: string }).requestId;
    const aliceTodoAfter = (await (
      await app.request("/api/approval-requests/todo", { headers: aliceHeaders })
    ).json()) as { requests: { requestId: string }[] };
    expect(aliceTodoAfter.requests.map((row) => row.requestId)).toContain(secondId);
    const carolTodoAfter = (await (
      await app.request("/api/approval-requests/todo", { headers: carolHeaders })
    ).json()) as { requests: { requestId: string }[] };
    expect(carolTodoAfter.requests.map((row) => row.requestId)).not.toContain(secondId);
  });
});
