import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createDb, runMigrations, schema } from "@ally/db";
import { createApp } from "../app.ts";
import { createAuth, createSessionResolver } from "../auth/auth.ts";
import { createAuthzStore } from "../authz/service.ts";
import type { MailMessage } from "../mailer/mailer.ts";
import { SUBJECT_LOADERS } from "../subjects/registry.ts";
import { registerActionBlock, registerConditionBlock } from "../workflow/blocks.ts";
import { registerWorkflowSubject } from "../workflow/registry.ts";
import { applyTransition, findDueInstances, startWorkflow } from "../workflow/service.ts";

// 集成测试（#220 验收第 2、3 条：不满足门槛/不在允许流转内的变更被服务端拒绝、
// 进入动作被触发）。真实 PostgreSQL；未设 DATABASE_URL 跳过。独立临时库，跑完 drop。
//
// 夹具域经生产注册接缝注入（与生产属主域同一条路径）：flowtest_lead 同时注册进
// 可挂流程注册表（给产品类型）与可见性门（给可见者）。
const databaseUrl = process.env.DATABASE_URL;

const logger = pino({ level: "silent" });
const SECRET = "test-secret-0123456789abcdef0123456789abcdef";
const PASSWORD = "correct-horse-battery";

const SUBJECT_TYPE = "flowtest_lead";

/** subjectId → 产品类型；existence 集合管生死，本集合只管类型维度 */
const productTypeBySubject = new Map<string, string>();
const existingSubjects = new Set<string>();
/** subjectId → 可见者（创建人）集合 */
const viewersBySubject = new Map<string, string[]>();

registerWorkflowSubject(SUBJECT_TYPE, {
  load: (_db, subjectId) => {
    if (!existingSubjects.has(subjectId)) return Promise.resolve(null);
    const productType = productTypeBySubject.get(subjectId);
    return Promise.resolve({ ...(productType !== undefined ? { productType } : {}) });
  },
});

SUBJECT_LOADERS[SUBJECT_TYPE] = (_db, subjectId) =>
  Promise.resolve({
    id: subjectId,
    title: "flow fixture",
    viewers: (viewersBySubject.get(subjectId) ?? []).map((id) => ({ id, name: "Fixture Viewer" })),
  });

/** 门槛积木：config.pass 原样作为判定结果（false 的引用用于 gate_failed 断言） */
registerConditionBlock("flowtest_flag", (ctx) => {
  const parsed = z.object({ pass: z.boolean() }).safeParse(ctx.config);
  return Promise.resolve(parsed.success && parsed.data.pass);
});

const actionsFired: { instanceId: string; label: string }[] = [];
registerActionBlock("flowtest_record", (ctx) => {
  const parsed = z.object({ label: z.string().min(1) }).safeParse(ctx.config);
  if (!parsed.success) return Promise.reject(new Error("bad fixture action config"));
  actionsFired.push({ instanceId: ctx.instanceId, label: parsed.data.label });
  return Promise.resolve();
});

const FLOW = {
  initial: "new",
  states: {
    new: {
      timeoutAfterHours: 48,
      on: {
        CONTACT: "contacted",
        ESCALATE: { target: "escalated", roles: ["sales_lead"], requireNote: true },
        GATE_OK: { target: "contacted", gates: [{ name: "flowtest_flag", config: { pass: true } }] },
        GATE_NO: { target: "contacted", gates: [{ name: "flowtest_flag", config: { pass: false } }] },
      },
    },
    contacted: {
      entryActions: [{ name: "flowtest_record", config: { label: "entered_contacted" } }],
      on: { QUALIFY: { target: "qualified", requireNote: true } },
    },
    escalated: {},
    qualified: {},
  },
};

function must<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("unexpected missing value in test");
  return value;
}

describe.skipIf(!databaseUrl)("workflow instances (#220, integration)", () => {
  const dbName = `workflow_instances_test_${String(Date.now())}_${String(process.pid)}`;
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
    notifyUsers: async () => {},
  });

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("unreachable: suite is skipped without DATABASE_URL");
    await admin.pool.query(`create database "${dbName}"`);
    await runMigrations(db);
  });

  beforeEach(async () => {
    // 用户行不清（临时库整体生灭）；流程三表与审计按测试边界清空
    await db.execute(
      sql`truncate table ${schema.workflowTemplates}, ${schema.workflowInstances}, ${schema.workflowTransitions}`,
    );
    await db.execute(sql`truncate table ${schema.auditEvents}`);
    productTypeBySubject.clear();
    existingSubjects.clear();
    viewersBySubject.clear();
    actionsFired.length = 0;
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

  async function grantRole(userId: string, role: "owner" | "sales" | "sales_lead" | "customer") {
    await db.insert(schema.userRole).values({ userId, role }).onConflictDoNothing();
  }

  /** 夹具 subject：产品类型可选；默认创建人可见 */
  function fixtureSubject(opts?: { productType?: string; viewers?: string[] }): string {
    const subjectId = randomUUID();
    existingSubjects.add(subjectId);
    if (opts?.productType !== undefined) productTypeBySubject.set(subjectId, opts.productType);
    viewersBySubject.set(subjectId, opts?.viewers ?? []);
    return subjectId;
  }

  async function createTemplate(
    cookie: string,
    overrides?: { templateKey?: string; subjectType?: string; productType?: string; isDefault?: boolean },
  ) {
    const res = await app.request("/api/workflow-templates", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        subjectType: overrides?.subjectType ?? SUBJECT_TYPE,
        templateKey: overrides?.templateKey ?? "std",
        ...(overrides?.productType !== undefined ? { productType: overrides.productType } : {}),
        ...(overrides?.isDefault !== undefined ? { isDefault: overrides.isDefault } : {}),
        definition: FLOW,
      }),
    });
    expect(res.status).toBe(201);
  }

  it("runs the lifecycle: start → read state → transition → history → entry action → audit", async () => {
    const owner = await signUpVerified();
    await grantRole(owner, "owner");
    const cookie = await signInAs(owner);
    await createTemplate(cookie);

    const subjectId = fixtureSubject({ viewers: [owner] });
    const started = await startWorkflow(db, { subjectType: SUBJECT_TYPE, subjectId, startedById: owner });
    expect(started).toMatchObject({ status: "started", templateKey: "std", currentState: "new" });

    // 审计行：模板创建 + 启动（workflow.instance_started）
    expect(await auditActions()).toEqual(["workflow.template_created", "workflow.instance_started"]);

    // 读法：当前状态 + 允许事件（含各自的约束）+ 超时基准
    const view = await app.request(`/api/workflow-instances/${SUBJECT_TYPE}/${subjectId}`, {
      headers: { cookie },
    });
    expect(view.status).toBe(200);
    const flow = (await view.json() as { flow?: { currentState?: string; stateDueAt?: string | null; allowedEvents?: { event: string }[] } }).flow;
    expect(flow?.currentState).toBe("new");
    expect(flow?.stateDueAt).not.toBeNull();
    expect(flow?.allowedEvents?.map((e) => e.event).sort()).toEqual(["CONTACT", "ESCALATE", "GATE_NO", "GATE_OK"]);

    // 推进：CONTACT（无角色限制的流转，owner 在员工地板之上）
    const moved = await app.request(`/api/workflow-instances/${SUBJECT_TYPE}/${subjectId}/transitions`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ event: "CONTACT" }),
    });
    expect(moved.status).toBe(200);
    const movedBody = await moved.json() as { from?: string; to?: string; instanceId?: string };
    expect(movedBody).toMatchObject({ from: "new", to: "contacted" });

    // 进入后动作在提交后触发（contacted 的 entryActions）
    expect(actionsFired).toEqual([{ instanceId: must(movedBody.instanceId), label: "entered_contacted" }]);

    // 历史：新在前一行
    const history = await app.request(`/api/workflow-instances/${SUBJECT_TYPE}/${subjectId}/transitions`, {
      headers: { cookie },
    });
    expect(history.status).toBe(200);
    const rows = (await history.json() as { transitions?: { fromState: string; toState: string; event: string }[] }).transitions;
    expect(rows).toHaveLength(1);
    expect(rows?.[0]).toMatchObject({ fromState: "new", toState: "contacted", event: "CONTACT" });

    // 审计：模板创建 + 启动 + 状态变更（from/to 在 detail，进该对象的活动流投影）
    expect(await auditActions()).toEqual([
      "workflow.template_created",
      "workflow.instance_started",
      "workflow.state_changed",
    ]);

    // 超时扫描：contacted 没配超时 → stateDueAt 清空 → 不再到期
    const due = await findDueInstances(db, { now: new Date(Date.now() + 49 * 3600 * 1000), limit: 10 });
    expect(due).toEqual([]);
  });

  it("resolves templates by product type first and falls back to the default", async () => {
    const owner = await signUpVerified();
    await grantRole(owner, "owner");
    const cookie = await signInAs(owner);
    await createTemplate(cookie, { templateKey: "serum_flow", productType: "serum" });
    await createTemplate(cookie, { templateKey: "fallback", isDefault: true });

    const serumSubject = fixtureSubject({ productType: "serum", viewers: [owner] });
    const serumStart = await startWorkflow(db, { subjectType: SUBJECT_TYPE, subjectId: serumSubject, startedById: owner });
    expect(serumStart).toMatchObject({ status: "started", templateKey: "serum_flow" });

    const plainSubject = fixtureSubject({ viewers: [owner] });
    const plainStart = await startWorkflow(db, { subjectType: SUBJECT_TYPE, subjectId: plainSubject, startedById: owner });
    expect(plainStart).toMatchObject({ status: "started", templateKey: "fallback" });
  });

  it("rejects: unknown events 422, template roles 403, note required 422", async () => {
    const owner = await signUpVerified();
    const salesLead = await signUpVerified();
    await grantRole(owner, "owner");
    await grantRole(salesLead, "sales_lead");
    const cookie = await signInAs(owner);
    await createTemplate(cookie);

    const subjectId = fixtureSubject({ viewers: [owner, salesLead] });
    await startWorkflow(db, { subjectType: SUBJECT_TYPE, subjectId, startedById: owner });

    const base = { method: "POST", headers: { "content-type": "application/json", cookie: await signInAs(salesLead) } } as const;
    const strayed = await app.request(`/api/workflow-instances/${SUBJECT_TYPE}/${subjectId}/transitions`, {
      ...base,
      body: JSON.stringify({ event: "STRAY" }),
    });
    expect(strayed.status).toBe(422);
    expect(await strayed.json()).toMatchObject({ error: "event_not_allowed" });

    // ESCALATE 限 sales_lead：sales_lead 无 note → 422 note_required（角色先过）
    const noNote = await app.request(`/api/workflow-instances/${SUBJECT_TYPE}/${subjectId}/transitions`, {
      ...base,
      body: JSON.stringify({ event: "ESCALATE" }),
    });
    expect(noNote.status).toBe(422);
    expect(await noNote.json()).toMatchObject({ error: "note_required" });

    const withNote = await app.request(`/api/workflow-instances/${SUBJECT_TYPE}/${subjectId}/transitions`, {
      ...base,
      body: JSON.stringify({ event: "ESCALATE", note: "客户停线，需要主管介入" }),
    });
    expect(withNote.status).toBe(200);

    // 历史行带 note（§4.7 人工推进写原因）
    const history = await app.request(`/api/workflow-instances/${SUBJECT_TYPE}/${subjectId}/transitions`, {
      headers: { cookie },
    });
    const rows = await history.json() as { transitions?: { event: string; note: string | null }[] };
    expect(rows.transitions?.[0]).toMatchObject({ event: "ESCALATE", note: "客户停线，需要主管介入" });
  });

  it("gates: pass → 200, fail → 422 gate_failed with the block name", async () => {
    const owner = await signUpVerified();
    await grantRole(owner, "owner");
    const cookie = await signInAs(owner);
    await createTemplate(cookie);
    const subjectId = fixtureSubject({ viewers: [owner] });
    await startWorkflow(db, { subjectType: SUBJECT_TYPE, subjectId, startedById: owner });

    const failed = await app.request(`/api/workflow-instances/${SUBJECT_TYPE}/${subjectId}/transitions`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ event: "GATE_NO" }),
    });
    expect(failed.status).toBe(422);
    expect(await failed.json()).toMatchObject({ error: "gate_failed", gate: "flowtest_flag" });

    const passed = await app.request(`/api/workflow-instances/${SUBJECT_TYPE}/${subjectId}/transitions`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ event: "GATE_OK" }),
    });
    expect(passed.status).toBe(200);
  });

  it("customer-role callers can never transition (kernel floor)", async () => {
    const owner = await signUpVerified();
    const customer = await signUpVerified();
    await grantRole(owner, "owner");
    await grantRole(customer, "customer");
    const cookie = await signInAs(owner);
    await createTemplate(cookie);
    const subjectId = fixtureSubject({ viewers: [owner, customer] });
    await startWorkflow(db, { subjectType: SUBJECT_TYPE, subjectId, startedById: owner });

    const denied = await app.request(`/api/workflow-instances/${SUBJECT_TYPE}/${subjectId}/transitions`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: await signInAs(customer) },
      body: JSON.stringify({ event: "CONTACT" }),
    });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: "role_required" });
  });

  it("gates fail closed when the referenced block is not registered at runtime", async () => {
    const owner = await signUpVerified();
    await grantRole(owner, "owner");
    const cookie = await signInAs(owner);
    const subjectId = fixtureSubject({ viewers: [owner] });
    // 绕过模板保存校验直接插实例（模拟「代码回退/库被外力改」——运行时地板）
    await db.insert(schema.workflowInstances).values({
      subjectType: SUBJECT_TYPE,
      subjectId,
      templateKey: "handwritten",
      definition: {
        initial: "new",
        states: {
          new: { on: { GO: { target: "done", gates: [{ name: "vanished_gate" }] } } },
          done: {},
        },
      },
      currentState: "new",
    });
    const res = await app.request(`/api/workflow-instances/${SUBJECT_TYPE}/${subjectId}/transitions`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ event: "GO" }),
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: "gate_unavailable", gate: "vanished_gate" });
  });

  it("visibility: unregistered type 400, invisible/missing subject 404, anti-probe", async () => {
    const stranger = await signUpVerified();
    const strangerCookie = await signInAs(stranger);

    const unregistered = await app.request(`/api/workflow-instances/nobody_type/${randomUUID()}`, {
      headers: { cookie: strangerCookie },
    });
    expect(unregistered.status).toBe(400);

    const subjectId = fixtureSubject({ viewers: [] }); // 存在但无人可见
    const invisible = await app.request(`/api/workflow-instances/${SUBJECT_TYPE}/${subjectId}`, {
      headers: { cookie: strangerCookie },
    });
    expect(invisible.status).toBe(404);

    const ghost = await app.request(`/api/workflow-instances/${SUBJECT_TYPE}/${randomUUID()}`, {
      headers: { cookie: strangerCookie },
    });
    expect(ghost.status).toBe(404);
  });

  it("start rejections: unregistered type, missing subject, no template, double start", async () => {
    const owner = await signUpVerified();
    await grantRole(owner, "owner");

    expect(await startWorkflow(db, { subjectType: "nobody_type", subjectId: randomUUID(), startedById: owner }))
      .toMatchObject({ status: "rejected", reason: "subject_unregistered" });

    expect(await startWorkflow(db, { subjectType: SUBJECT_TYPE, subjectId: randomUUID(), startedById: owner }))
      .toMatchObject({ status: "rejected", reason: "subject_not_found" });

    const noTemplate = fixtureSubject({ viewers: [owner] });
    expect(await startWorkflow(db, { subjectType: SUBJECT_TYPE, subjectId: noTemplate, startedById: owner }))
      .toMatchObject({ status: "rejected", reason: "no_template" });

    const cookie = await signInAs(owner);
    await createTemplate(cookie);
    const subjectId = fixtureSubject({ viewers: [owner] });
    expect(await startWorkflow(db, { subjectType: SUBJECT_TYPE, subjectId, startedById: owner }))
      .toMatchObject({ status: "started" });
    const again = await startWorkflow(db, { subjectType: SUBJECT_TYPE, subjectId, startedById: owner });
    expect(again).toMatchObject({ status: "rejected", reason: "already_started" });
    expect(again.status === "rejected" && again.instanceId !== undefined).toBe(true);
  });

  it("concurrent transitions: exactly one wins, the loser answers concurrent_conflict", async () => {
    const owner = await signUpVerified();
    const salesLead = await signUpVerified();
    await grantRole(owner, "owner");
    await grantRole(salesLead, "sales_lead");
    const cookie = await signInAs(owner);
    await createTemplate(cookie);
    const subjectId = fixtureSubject({ viewers: [owner, salesLead] });
    await startWorkflow(db, { subjectType: SUBJECT_TYPE, subjectId, startedById: owner });

    // 两个流转都从 new 出发且都合法；同一时刻提交，CAS 只允许一个改写 current_state
    const [a, b] = await Promise.all([
      applyTransition(db, { subjectType: SUBJECT_TYPE, subjectId, actorId: owner, actorRoles: ["owner"], event: "CONTACT" }),
      applyTransition(db, {
        subjectType: SUBJECT_TYPE,
        subjectId,
        actorId: salesLead,
        actorRoles: ["sales_lead"],
        event: "ESCALATE",
        note: "并行推进",
      }),
    ]);
    const outcomes = [a.status, b.status].sort();
    expect(outcomes).toEqual(["applied", "rejected"]);
    const loser = a.status === "rejected" ? a : b;
    expect(loser.status === "rejected" && loser.reason === "concurrent_conflict").toBe(true);
    // 历史只有一行：输家不落历史
    const history = await transitionCount(subjectId);
    expect(history).toBe(1);
  });

  async function auditActions(): Promise<string[]> {
    const rows = await db
      .select({ action: schema.auditEvents.action })
      .from(schema.auditEvents)
      .orderBy(schema.auditEvents.createdAt);
    return rows.map((r) => r.action);
  }

  async function transitionCount(subjectId: string): Promise<number> {
    const rows = await db
      .select({ id: schema.workflowTransitions.id })
      .from(schema.workflowTransitions)
      .innerJoin(schema.workflowInstances, and(
        eq(schema.workflowTransitions.instanceId, schema.workflowInstances.id),
        eq(schema.workflowInstances.subjectId, subjectId),
      ));
    return rows.length;
  }
});

function adminUrl(databaseUrl: string | undefined): string {
  if (databaseUrl === undefined) return "";
  const url = new URL(databaseUrl);
  url.pathname = "/postgres";
  return url.toString();
}
