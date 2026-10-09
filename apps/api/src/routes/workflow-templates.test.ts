import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, runMigrations, schema } from "@ally/db";
import { registerActionBlock } from "../workflow/blocks.ts";
import { registerWorkflowSubject } from "../workflow/registry.ts";
import { applyTransition, startWorkflow } from "../workflow/service.ts";
import { createApp } from "../app.ts";
import { createAuth, createSessionResolver } from "../auth/auth.ts";
import { createAuthzStore } from "../authz/service.ts";
import type { MailMessage } from "@ally/mailer";

// 集成测试（#220 验收：「能为线索、商机、订单履约、偏差分别配置流程」的配置面）。
// 真实 PostgreSQL；未设 DATABASE_URL 跳过。本文件用独立的临时库（每次运行新建、
// 跑完 drop），断言模板行与审计行（纪律见 docs/audit.md「测试清库的唯一通道」）。
const databaseUrl = process.env.DATABASE_URL;

const logger = pino({ level: "silent" });
const SECRET = "test-secret-0123456789abcdef0123456789abcdef";
const PASSWORD = "correct-horse-battery";

const LEAD_FLOW = {
  initial: "new",
  states: {
    new: { on: { CONTACT: "contacted", DISQUALIFY: "disqualified" } },
    contacted: { on: { QUALIFY: "qualified" } },
    qualified: {},
    disqualified: {},
  },
};

// v2 定义：多一个 waiting 状态与 WAIT 事件（草稿发布/在飞实例快照测试用）
const LEAD_FLOW_V2 = {
  initial: "new",
  states: {
    new: { on: { CONTACT: "contacted", DISQUALIFY: "disqualified", WAIT: "waiting" } },
    contacted: { on: { QUALIFY: "qualified" } },
    qualified: {},
    disqualified: {},
    waiting: { on: { CONTACT: "contacted" } },
  },
};

// 夹具动作积木：保存路径用它断言「注册表里有的积木可被引用」（注册接缝与生产同路）
registerActionBlock("templates_fixture_action", () => Promise.resolve());

// 夹具流程域：实例启动/推进的服务路径需要「记录存在 + 产品类型」（与生产同一条
// 注册接缝；行存在性对模板改版测试无关紧要，恒存在即可）
registerWorkflowSubject("lead", { load: () => Promise.resolve({ productType: null }) });

function must<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("unexpected missing value in test");
  return value;
}

describe.skipIf(!databaseUrl)("workflow templates route (#220, integration)", () => {
  const dbName = `workflow_templates_test_${String(Date.now())}_${String(process.pid)}`;
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
    await admin.pool.query(`create database "${dbName}"`);
    await runMigrations(db);
  });

  beforeEach(async () => {
    // 每条测试从空表开始（整库是本文件的；用户行不清——临时库整体生灭）。
    // 单语句 TRUNCATE：三张流程表（instances 引用 templates）+ 本文件的断言面
    // 台账与草稿（PATCH/发布/回滚测试记账），audit_events 一并清
    await db.execute(
      sql`truncate table ${schema.workflowTemplates}, ${schema.workflowInstances}, ${schema.workflowTransitions}, ${schema.configRevisions}, ${schema.configDrafts}, ${schema.auditEvents}`,
    );
  });

  afterAll(async () => {
    await pool.end();
    await admin.pool.query(`drop database if exists "${dbName}" with (force)`);
    await admin.pool.end();
  });

  async function signUpVerified(): Promise<string> {
    const email = `${randomUUID()}@example.com`;
    const res = await app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: PASSWORD, name: "Test User" }),
    });
    expect(res.status).toBe(200);
    const userId = must((await res.json() as { user?: { id?: string } }).user?.id);
    // 邮箱验证：better-auth 默认拒绝未验证邮箱登录（403）——点邮件里的验证链接
    const message = must(mailer.sent[mailer.sent.length - 1]);
    const token = must(/token=([^"&\s<]+)/.exec(message.html)?.[1]);
    const confirm = await app.request(`/api/auth/verify-email?token=${encodeURIComponent(token)}`);
    expect(confirm.status).toBe(200);
    return userId;
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

  function cookiesNamed(res: Response, prefix: string): string[] {
    return res.headers.getSetCookie().filter((c) => c.startsWith(prefix)).map((c) => must(c.split(";")[0]));
  }

  async function signInAs(userId: string): Promise<string> {
    const rows = await db
      .select({ email: schema.authUser.email })
      .from(schema.authUser)
      .where(eq(schema.authUser.id, userId))
      .limit(1);
    const res = await app.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: must(rows[0]?.email), password: PASSWORD }),
    });
    expect(res.status).toBe(200);
    return must(cookiesNamed(res, "better-auth.session_token=")[0]);
  }

  async function grantRole(userId: string, role: "owner" | "sales") {
    await db.insert(schema.userRole).values({ userId, role }).onConflictDoNothing();
  }

  async function createTemplate(
    cookie: string,
    body: Record<string, unknown>,
  ): Promise<string> {
    const res = await app.request("/api/workflow-templates", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(201);
    return must((await res.json() as { id?: string }).id);
  }

  async function templateRow(id: string): Promise<typeof schema.workflowTemplates.$inferSelect> {
    const rows = await db
      .select()
      .from(schema.workflowTemplates)
      .where(eq(schema.workflowTemplates.id, id))
      .limit(1);
    return must(rows[0]);
  }

  /** 台账版本史（新在前）；断言面走 HTTP 读面 */
  async function revisions(id: string, cookie: string) {
    const res = await app.request(`/api/config-versions/workflow_template/${id}`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      revisions?: { version: number; source: string; changes: Record<string, { from: unknown; to: unknown }> | null }[];
    };
    return must(body.revisions);
  }

  /** 草稿内容 = 快照同一形状（模板创建未带 productType → null、非默认、生效） */
  function draftContent(definition: unknown): Record<string, unknown> {
    return { productType: null, isDefault: false, active: true, definition };
  }

  it("403s a plain user and 201s an owner creating a template", async () => {
    const plain = await signUpVerified();
    const plainCookie = await signInAs(plain);
    const denied = await app.request("/api/workflow-templates", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: plainCookie },
      body: JSON.stringify({ subjectType: "lead", templateKey: "standard", definition: LEAD_FLOW }),
    });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: "forbidden" });

    const owner = await signUpVerified();
    await grantRole(owner, "owner");
    const ownerCookie = await signInAs(owner);
    const created = await app.request("/api/workflow-templates", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: ownerCookie },
      body: JSON.stringify({ subjectType: "lead", templateKey: "standard", definition: LEAD_FLOW }),
    });
    expect(created.status).toBe(201);
    const id = must((await created.json() as { id?: string }).id);

    // 审计行同事务落库（workflow.template_created）
    const audits = await db
      .select({ action: schema.auditEvents.action, detail: schema.auditEvents.detail })
      .from(schema.auditEvents);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: "workflow.template_created" });
    expect(audits[0]?.detail).toMatchObject({ subjectType: "lead", templateKey: "standard" });

    const fetched = await app.request(`/api/workflow-templates/${id}`, {
      headers: { cookie: ownerCookie },
    });
    expect(fetched.status).toBe(200);
    expect((await fetched.json() as { template?: { definition?: unknown } }).template?.definition)
      .toEqual(LEAD_FLOW);
  });

  it("rejects invalid definitions and unregistered blocks with 422", async () => {
    const owner = await signUpVerified();
    await grantRole(owner, "owner");
    const cookie = await signInAs(owner);

    const badTopology = await app.request("/api/workflow-templates", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        subjectType: "lead",
        templateKey: "broken",
        definition: { initial: "new", states: { new: { on: { GO: "ghost" } } } },
      }),
    });
    expect(badTopology.status).toBe(422);
    expect(await badTopology.json()).toMatchObject({ error: "invalid_definition" });

    const unknownBlock = await app.request("/api/workflow-templates", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        subjectType: "lead",
        templateKey: "ghostly",
        definition: {
          initial: "new",
          states: {
            new: {
              entryActions: [{ name: "templates_fixture_action" }],
              on: { GO: { target: "done", gates: [{ name: "no_such_gate" }] } },
            },
            done: {},
          },
        },
      }),
    });
    expect(unknownBlock.status).toBe(422);
    expect(await unknownBlock.json()).toMatchObject({ error: "unknown_block", detail: { gates: ["no_such_gate"] } });
  });

  it("409s duplicate template keys and a second default per subject type", async () => {
    const owner = await signUpVerified();
    await grantRole(owner, "owner");
    const cookie = await signInAs(owner);

    const first = await app.request("/api/workflow-templates", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ subjectType: "lead", templateKey: "standard", definition: LEAD_FLOW }),
    });
    expect(first.status).toBe(201);
    const dup = await app.request("/api/workflow-templates", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ subjectType: "lead", templateKey: "standard", definition: LEAD_FLOW }),
    });
    expect(dup.status).toBe(409);
    expect(await dup.json()).toMatchObject({ error: "template_exists" });

    const defaultOne = await app.request("/api/workflow-templates", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ subjectType: "deviation", templateKey: "std_dev", isDefault: true, definition: LEAD_FLOW }),
    });
    expect(defaultOne.status).toBe(201);
    const defaultTwo = await app.request("/api/workflow-templates", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ subjectType: "deviation", templateKey: "other_dev", isDefault: true, definition: LEAD_FLOW }),
    });
    expect(defaultTwo.status).toBe(409);
    expect(await defaultTwo.json()).toMatchObject({ error: "default_template_exists" });

    // 结构不变式直接查库复核：deviation 的默认模板只有一行
    const defaults = await db
      .select({ key: schema.workflowTemplates.templateKey })
      .from(schema.workflowTemplates)
      .where(eq(schema.workflowTemplates.subjectType, "deviation"));
    expect(defaults).toHaveLength(1);
  });

  it("lists templates filtered by subject type", async () => {
    const owner = await signUpVerified();
    await grantRole(owner, "owner");
    const cookie = await signInAs(owner);
    for (const [subjectType, key] of [["lead", "std_lead"], ["order", "std_order"]] as const) {
      const res = await app.request("/api/workflow-templates", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ subjectType, templateKey: key, definition: LEAD_FLOW }),
      });
      expect(res.status).toBe(201);
    }
    const list = await app.request("/api/workflow-templates?subjectType=lead", {
      headers: { cookie },
    });
    expect(list.status).toBe(200);
    const body = await list.json() as { templates?: { subjectType: string }[] };
    expect(body.templates?.map((t) => t.subjectType)).toEqual(["lead"]);
  });

  it("PATCH rewrites content in place with a ledger version and audit; no-change PATCH is idempotent", async () => {
    const owner = await signUpVerified();
    await grantRole(owner, "owner");
    const cookie = await signInAs(owner);
    const id = await createTemplate(cookie, { subjectType: "lead", templateKey: "standard", definition: LEAD_FLOW });

    // strict body：键是身份不是内容，打进来必须 400 而不是被静默剥掉
    const keyAttempt = await app.request(`/api/workflow-templates/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ templateKey: "renamed" }),
    });
    expect(keyAttempt.status).toBe(400);

    const patched = await app.request(`/api/workflow-templates/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ active: false, definition: LEAD_FLOW_V2 }),
    });
    expect(patched.status).toBe(200);
    const patchedBody = await patched.json() as { template?: { active?: boolean; version?: number; definition?: unknown } };
    expect(patchedBody.template).toMatchObject({ active: false, version: 2 });
    expect(patchedBody.template?.definition).toEqual(LEAD_FLOW_V2);

    const revs = await revisions(id, cookie);
    expect(revs.map((r) => r.version)).toEqual([2, 1]);
    expect(must(revs[0])).toMatchObject({
      version: 2,
      source: "updated",
      changes: { active: { from: true, to: false }, definition: { from: LEAD_FLOW, to: LEAD_FLOW_V2 } },
    });

    // 审计与记账同变更（created + updated 各一行）
    const audits = await db.select({ action: schema.auditEvents.action }).from(schema.auditEvents);
    expect(audits.map((a) => a.action).sort()).toEqual(["workflow.template_created", "workflow.template_updated"]);

    // 无实效变更：幂等返回现状，不记账不写审计（真变更纪律）
    const noChange = await app.request(`/api/workflow-templates/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ active: false }),
    });
    expect(noChange.status).toBe(200);
    expect((await noChange.json() as { template?: { version?: number } }).template?.version).toBe(2);
    expect(await revisions(id, cookie)).toHaveLength(2);
    expect(await db.select({ action: schema.auditEvents.action }).from(schema.auditEvents)).toHaveLength(2);

    // 校验失败不落任何版：坏拓扑 422、未知积木 422、404
    const badTopology = await app.request(`/api/workflow-templates/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ definition: { initial: "new", states: { new: { on: { GO: "ghost" } } } } }),
    });
    expect(badTopology.status).toBe(422);
    expect(await badTopology.json()).toMatchObject({ error: "invalid_definition" });
    const ghostBlock = await app.request(`/api/workflow-templates/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        definition: {
          initial: "new",
          states: {
            new: { on: { GO: { target: "done", gates: [{ name: "no_such_gate" }] } } },
            done: {},
          },
        },
      }),
    });
    expect(ghostBlock.status).toBe(422);
    expect(await ghostBlock.json()).toMatchObject({ error: "unknown_block", detail: { gates: ["no_such_gate"] } });
    const missing = await app.request(`/api/workflow-templates/${randomUUID()}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ active: false }),
    });
    expect(missing.status).toBe(404);
    expect(await revisions(id, cookie)).toHaveLength(2);
  });

  it("403s a plain user on the in-place write faces", async () => {
    const owner = await signUpVerified();
    await grantRole(owner, "owner");
    const ownerCookie = await signInAs(owner);
    const id = await createTemplate(ownerCookie, { subjectType: "lead", templateKey: "standard", definition: LEAD_FLOW });

    const plain = await signUpVerified();
    const plainCookie = await signInAs(plain);
    const patch = await app.request(`/api/workflow-templates/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: plainCookie },
      body: JSON.stringify({ active: false }),
    });
    expect(patch.status).toBe(403);
    const draft = await app.request(`/api/config-drafts/workflow_template/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: plainCookie },
      body: JSON.stringify({ content: draftContent(LEAD_FLOW_V2) }),
    });
    expect(draft.status).toBe(403);
  });

  it("switching the default template is a two-step move, not a silent demotion", async () => {
    const owner = await signUpVerified();
    await grantRole(owner, "owner");
    const cookie = await signInAs(owner);
    const aId = await createTemplate(cookie, { subjectType: "deviation", templateKey: "std_a", isDefault: true, definition: LEAD_FLOW });
    const bId = await createTemplate(cookie, { subjectType: "deviation", templateKey: "std_b", definition: LEAD_FLOW });

    // 部分唯一索引在写入侧拒绝双默认：409 与 POST 面同一答案，失败的写不落账
    const doubleDefault = await app.request(`/api/workflow-templates/${bId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ isDefault: true }),
    });
    expect(doubleDefault.status).toBe(409);
    expect(await doubleDefault.json()).toMatchObject({ error: "default_template_exists" });
    expect(await revisions(bId, cookie)).toHaveLength(1);

    // 两步切换：先摘旧默认（各记各的台账版），再设新默认
    const demote = await app.request(`/api/workflow-templates/${aId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ isDefault: false }),
    });
    expect(demote.status).toBe(200);
    const promote = await app.request(`/api/workflow-templates/${bId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ isDefault: true }),
    });
    expect(promote.status).toBe(200);
    // 结构不变式直接查库复核：默认模板唯一且是 b
    const rows = await db
      .select({ key: schema.workflowTemplates.templateKey, isDefault: schema.workflowTemplates.isDefault })
      .from(schema.workflowTemplates)
      .where(eq(schema.workflowTemplates.subjectType, "deviation"));
    expect(rows.filter((t) => t.isDefault).map((t) => must(t.key))).toEqual(["std_b"]);
    expect(rows).toHaveLength(2);
  });

  it("draft → publish rewrites the definition while in-flight instances keep their start-time snapshot", async () => {
    const owner = await signUpVerified();
    await grantRole(owner, "owner");
    const cookie = await signInAs(owner);
    const id = await createTemplate(cookie, { subjectType: "lead", templateKey: "standard", definition: LEAD_FLOW });

    // 在飞实例：启动于 v1 定义
    const subjectId = randomUUID();
    const started = await startWorkflow(db, { subjectType: "lead", subjectId, startedById: owner });
    expect(started).toMatchObject({ status: "started", templateKey: "standard", currentState: "new" });

    // 草稿保存面与 POST/PATCH 同一道四门：坏定义与未知积木 400 带明细
    const badDraft = await app.request(`/api/config-drafts/workflow_template/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        content: draftContent({ initial: "new", states: { new: { on: { GO: "ghost" } } } }),
      }),
    });
    expect(badDraft.status).toBe(400);
    expect(await badDraft.json()).toMatchObject({ error: "invalid_content" });
    const ghostDraft = await app.request(`/api/config-drafts/workflow_template/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        content: draftContent({
          initial: "new",
          states: {
            new: { entryActions: [{ name: "no_such_action" }], on: { GO: "done" } },
            done: {},
          },
        }),
      }),
    });
    expect(ghostDraft.status).toBe(400);
    expect(((await ghostDraft.json()) as { issues?: string[] }).issues?.length).toBeGreaterThan(0);

    // 有效草稿（「测试环境」层：活配置读路径看不见它），发布前滚 published 新版
    const put = await app.request(`/api/config-drafts/workflow_template/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ content: draftContent(LEAD_FLOW_V2), note: "add waiting state" }),
    });
    expect(put.status).toBe(200);
    const got = await app.request(`/api/config-drafts/workflow_template/${id}`, { headers: { cookie } });
    expect(got.status).toBe(200);
    expect(await got.json()).toMatchObject({
      stale: false,
      changes: { definition: { from: LEAD_FLOW, to: LEAD_FLOW_V2 } },
    });

    const published = await app.request(`/api/config-drafts/workflow_template/${id}/publish`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ reason: "flow rework" }),
    });
    expect(published.status).toBe(200);
    expect(await published.json()).toMatchObject({ fromVersion: 1, publishedVersion: 2 });
    const publishedRow = await templateRow(id);
    expect(publishedRow.definition).toEqual(LEAD_FLOW_V2);
    expect(publishedRow.version).toBe(2);
    expect(
      (await app.request(`/api/config-drafts/workflow_template/${id}`, { headers: { cookie } })).status,
    ).toBe(404);

    // 审计 config.published 带 reason 与草稿 note
    const audits = await db
      .select({ action: schema.auditEvents.action, detail: schema.auditEvents.detail })
      .from(schema.auditEvents);
    const publishedAudit = must(audits.find((a) => a.action === "config.published"));
    expect(publishedAudit.detail).toMatchObject({ reason: "flow rework", note: "add waiting state" });

    // 在飞实例还是启动时刻的 v1：WAIT 不存在 → 拒绝；CONTACT 照常推进
    const duringV1 = await applyTransition(db, {
      subjectType: "lead",
      subjectId,
      actorId: owner,
      actorRoles: ["owner"],
      event: "WAIT",
    });
    expect(duringV1).toMatchObject({ status: "rejected", reason: "event_not_allowed" });
    const contact = await applyTransition(db, {
      subjectType: "lead",
      subjectId,
      actorId: owner,
      actorRoles: ["owner"],
      event: "CONTACT",
    });
    expect(contact).toMatchObject({ status: "applied", from: "new", to: "contacted" });

    // 发布之后的新实例吃新定义
    const subjectId2 = randomUUID();
    expect(await startWorkflow(db, { subjectType: "lead", subjectId: subjectId2, startedById: owner })).toMatchObject({
      status: "started",
    });
    const wait = await applyTransition(db, {
      subjectType: "lead",
      subjectId: subjectId2,
      actorId: owner,
      actorRoles: ["owner"],
      event: "WAIT",
    });
    expect(wait).toMatchObject({ status: "applied", from: "new", to: "waiting" });
  });

  it("gives draft staleness and no-op publish explicit semantics", async () => {
    const owner = await signUpVerified();
    await grantRole(owner, "owner");
    const cookie = await signInAs(owner);
    const id = await createTemplate(cookie, { subjectType: "lead", templateKey: "standard", definition: LEAD_FLOW });
    const draftUrl = `/api/config-drafts/workflow_template/${id}`;

    const put = await app.request(draftUrl, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ content: draftContent(LEAD_FLOW_V2) }),
    });
    expect(put.status).toBe(200);

    // 线上并发变更使草稿过期：409 draft_stale，重存（在新现状上重写）是唯一路径
    const patched = await app.request(`/api/workflow-templates/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ active: false }),
    });
    expect(patched.status).toBe(200);
    const stalePublish = await app.request(`${draftUrl}/publish`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({}),
    });
    expect(stalePublish.status).toBe(409);
    expect(await stalePublish.json()).toMatchObject({ error: "draft_stale", draftBaseVersion: 1, currentVersion: 2 });
    const got = await app.request(draftUrl, { headers: { cookie } });
    expect(await got.json()).toMatchObject({ stale: true });

    const rePut = await app.request(draftUrl, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ content: draftContent(LEAD_FLOW_V2) }),
    });
    expect(rePut.status).toBe(200);
    const publish = await app.request(`${draftUrl}/publish`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({}),
    });
    expect(publish.status).toBe(200);
    expect(await publish.json()).toMatchObject({ fromVersion: 2, publishedVersion: 3 });

    // 与现状一致的发布是 no-op：409 明确拒绝，不记假变更
    const noopPut = await app.request(draftUrl, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ content: draftContent(LEAD_FLOW_V2) }),
    });
    expect(noopPut.status).toBe(200);
    const noopPublish = await app.request(`${draftUrl}/publish`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({}),
    });
    expect(noopPublish.status).toBe(409);
    expect(await noopPublish.json()).toMatchObject({ error: "publish_no_change" });

    // 丢弃后发布 404（幂等丢弃不装成功）
    expect(
      (await app.request(draftUrl, { method: "DELETE", headers: { cookie } })).status,
    ).toBe(200);
    const gone = await app.request(`${draftUrl}/publish`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({}),
    });
    expect(gone.status).toBe(404);
    expect(await gone.json()).toMatchObject({ error: "draft_not_found" });
  });

  it("rolls back to a historical snapshot and refuses to double-take the default", async () => {
    const owner = await signUpVerified();
    await grantRole(owner, "owner");
    const cookie = await signInAs(owner);
    const aId = await createTemplate(cookie, { subjectType: "deviation", templateKey: "std_a", isDefault: true, definition: LEAD_FLOW });

    const patched = await app.request(`/api/workflow-templates/${aId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ isDefault: false, active: false }),
    });
    expect(patched.status).toBe(200);

    // 回滚 = 前滚 rolled_back 新版：内容恢复，历史一行不动
    const rolled = await app.request(`/api/config-versions/workflow_template/${aId}/rollback`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ toVersion: 1, reason: "revert rework" }),
    });
    expect(rolled.status).toBe(200);
    expect(await rolled.json()).toMatchObject({ restoredVersion: 1, newVersion: 3 });
    const restored = await templateRow(aId);
    expect(restored).toMatchObject({ isDefault: true, active: true, version: 3 });
    expect(restored.definition).toEqual(LEAD_FLOW);
    const revs = await revisions(aId, cookie);
    expect(revs.map((r) => r.version)).toEqual([3, 2, 1]);
    expect(must(revs[0])).toMatchObject({ version: 3, source: "rolled_back" });

    // 内容一致时回滚是 no-op：409；版本不存在 404
    const noop = await app.request(`/api/config-versions/workflow_template/${aId}/rollback`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ toVersion: 1 }),
    });
    expect(noop.status).toBe(409);
    expect(await noop.json()).toMatchObject({ error: "rollback_no_change" });
    const missing = await app.request(`/api/config-versions/workflow_template/${aId}/rollback`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ toVersion: 999 }),
    });
    expect(missing.status).toBe(404);

    // 默认位被别的模板接管后，回滚历史默认版撞结构不变式：409 rollback_conflict
    const demote = await app.request(`/api/workflow-templates/${aId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ isDefault: false }),
    });
    expect(demote.status).toBe(200);
    await createTemplate(cookie, { subjectType: "deviation", templateKey: "std_b", isDefault: true, definition: LEAD_FLOW });
    const conflict = await app.request(`/api/config-versions/workflow_template/${aId}/rollback`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ toVersion: 3 }),
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: "rollback_conflict" });
    // b 仍是唯一默认，a 的行未被半途改写
    const defaults = await db
      .select({ key: schema.workflowTemplates.templateKey, isDefault: schema.workflowTemplates.isDefault })
      .from(schema.workflowTemplates)
      .where(eq(schema.workflowTemplates.subjectType, "deviation"));
    expect(defaults.filter((t) => t.isDefault).map((t) => must(t.key))).toEqual(["std_b"]);
    expect((await templateRow(aId)).isDefault).toBe(false);
  });
});

function adminUrl(databaseUrl: string | undefined): string {
  if (databaseUrl === undefined) return "";
  const url = new URL(databaseUrl);
  url.pathname = "/postgres";
  return url.toString();
}
