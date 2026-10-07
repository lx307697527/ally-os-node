import { randomUUID } from "node:crypto";
import { symmetricDecrypt } from "better-auth/crypto";
import { and, eq, sql } from "drizzle-orm";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, runMigrations, schema } from "@ally/db";
import { registerApprovalOutcome } from "../approval/outcomes.ts";
import { submitApprovalRequest } from "../approval/service.ts";
import { SUBJECT_LOADERS } from "../subjects/registry.ts";
import { registerWorkflowSubject } from "../workflow/registry.ts";
import { startWorkflow } from "../workflow/service.ts";
import { createApp } from "../app.ts";
import { createAuth, createSessionResolver } from "../auth/auth.ts";
import { createAuthzStore } from "../authz/service.ts";
import type { MailMessage } from "@ally/mailer";

// 集成测试（#221 验收：满足条件的单据不批不放行、多级按序流转驳回回发起人、
// 审批记录审计可查）。真实 Better Auth（密码哈希、TOTP）+ 真实 PostgreSQL；
// 未设 DATABASE_URL 跳过。
//
// 本文件用**独立的临时库**（每次运行新建、跑完 drop）：断言审计行与通知行的
// 精确数量，共享库上并行文件的 TRUNCATE 会让它随机红（纪律见 docs/audit.md
// 「测试清库的唯一通道」）。
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

// 夹具单据域：无表，存在性与可见者集合都在内存里（审批内核对单据域的唯一
// 依赖是可见性门 subjects/registry.ts——与生产属主域同一扇门）。同时注册进
// 可挂流程注册表：门槛积木测试要从这条单据起步一个流程实例。
const docs = new Map<string, { title: string; viewerIds: string[] }>();
const userNameById = new Map<string, string>();

SUBJECT_LOADERS["approval-doc"] = (_db, subjectId) => {
  const doc = docs.get(subjectId);
  if (doc === undefined) return Promise.resolve(null);
  return Promise.resolve({
    id: subjectId,
    title: doc.title,
    viewers: doc.viewerIds.map((id) => ({ id, name: userNameById.get(id) ?? id })),
  });
};

registerWorkflowSubject("approval-doc", {
  load: (_db, subjectId) => Promise.resolve(docs.has(subjectId) ? { productType: null } : null),
});

// 批准即生效的夹具域：payload 透传与 outcome 调用的断言面（调用记录在闭包数组，
// subjectType 独立于生产注册——模块注册表是进程级全局，夹具用专属名字）
interface OutcomeCall {
  requestId: string;
  subjectId: string;
  payload: unknown;
  submittedById: string;
  actorId: string;
}
const outcomeCalls: OutcomeCall[] = [];
let outcomeFailNext = false;

SUBJECT_LOADERS["outcome-doc"] = (_db, subjectId) => {
  const doc = docs.get(subjectId);
  if (doc === undefined) return Promise.resolve(null);
  return Promise.resolve({
    id: subjectId,
    title: "Outcome doc",
    viewers: doc.viewerIds.map((id) => ({ id, name: userNameById.get(id) ?? id })),
  });
};

registerApprovalOutcome("outcome-doc", (_tx, ctx) => {
  outcomeCalls.push({
    requestId: ctx.requestId,
    subjectId: ctx.subjectId,
    payload: ctx.payload,
    submittedById: ctx.submittedById,
    actorId: ctx.actorId,
  });
  if (outcomeFailNext) {
    return Promise.reject(new Error("outcome fixture failure"));
  }
  return Promise.resolve();
});

describe.skipIf(!databaseUrl)("approvals route (#221, integration)", () => {
  // 管理连接连 maintenance 库建删临时库；测试连接指向本文件专属临时库
  const dbName = `approvals_test_${String(Date.now())}_${String(process.pid)}`;
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
  // 实时「催」的记录面（#221 多级扇出）：铃铛 nudge 的收件人序列，逐测试清空。
  // 通知行是权威事实（事务内落库），nudge 只是 at-most-once 的加速器——两者都断言。
  const bellNudges: string[][] = [];
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
    },
    authzStore: createAuthzStore(db),
    notifyUsers: (userIds: string[]) => {
      bellNudges.push([...userIds]);
      return Promise.resolve();
    },
  });

  // owner（配置管理 + 审计读法 + 流程模板，无需 2FA：强制门只盯 admin）/
  // alice（发起人）/ bob、carol（点名审批人）/ dave（sales_lead 角色审批人）/
  // erin（签名审批人，绑 2FA）/ mallory（无角色无权限）
  let ownerId: string;
  let aliceId: string;
  let bobId: string;
  let carolId: string;
  let daveId: string;
  let erinId: string;
  let malloryId: string;
  const session = new Map<string, string>();
  const emails = new Map<string, string>();

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("unreachable: suite is skipped without DATABASE_URL");
    await admin.pool.query(`create database "${dbName}"`);
    await runMigrations(db);
    ownerId = (await makeUser("owner")).userId;
    aliceId = (await makeUser("alice")).userId;
    bobId = (await makeUser("bob")).userId;
    carolId = (await makeUser("carol")).userId;
    daveId = (await makeUser("dave")).userId;
    erinId = (await makeUser("erin")).userId;
    malloryId = (await makeUser("mallory")).userId;
    await db.insert(schema.userRole).values([
      { userId: ownerId, role: "owner" },
      { userId: daveId, role: "sales_lead" },
    ]);
    // erin 绑 2FA（要求签名的级别：Part 11 的签名用户必须双因素）
    session.set("erin", await enrollTotp(erinId, must(emails.get("erin")), "erin"));
  });

  beforeEach(async () => {
    // 每条测试从空表开始（用户行与角色授予不清——临时库整体生灭；单据夹具在内存）
    await db.execute(
      sql`truncate table ${schema.approvalConfigs}, ${schema.approvalRequests}, ${schema.approvalActions}, ${schema.esignSignatures}, ${schema.auditEvents}, ${schema.notifications}, ${schema.workflowTemplates}, ${schema.workflowInstances}, ${schema.workflowTransitions} cascade`,
    );
    docs.clear();
    outcomeCalls.length = 0;
    outcomeFailNext = false;
    bellNudges.length = 0;
  });

  afterAll(async () => {
    await pool.end();
    await admin.pool.query(`drop database if exists "${dbName}" with (force)`);
    await admin.pool.end();
  });

  async function makeUser(name: string): Promise<{ userId: string; email: string }> {
    const email = `${name}-${randomUUID()}@example.com`;
    const res = await app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: PASSWORD, name: `User ${name}` }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user?: { id?: string } };
    const userId = must(body.user?.id);
    const message = must(mailer.sent[mailer.sent.length - 1]);
    const token = must(/token=([^"&\s<]+)/.exec(message.html)?.[1]);
    const confirm = await app.request(`/api/auth/verify-email?token=${encodeURIComponent(token)}`);
    expect(confirm.status).toBe(200);
    const signInRes = await app.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    expect(signInRes.status).toBe(200);
    const cookie = must(
      signInRes.headers
        .getSetCookie()
        .filter((c) => c.startsWith("better-auth.session_token="))
        .map((c) => must(c.split(";")[0]))[0],
    );
    session.set(name, cookie);
    userNameById.set(userId, `User ${name}`);
    emails.set(name, email);
    return { userId, email };
  }

  /** 给已验证用户绑 2FA（与 two-factor.test.ts 同一条路径），返回换发后的会话 */
  async function enrollTotp(userId: string, email: string, name: string): Promise<string> {
    const signInRes = await app.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    expect(signInRes.status).toBe(200);
    const cookie = must(
      signInRes.headers
        .getSetCookie()
        .filter((c) => c.startsWith("better-auth.session_token="))
        .map((c) => must(c.split(";")[0]))[0],
    );
    const enable = await app.request("/api/auth/two-factor/enable", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ password: PASSWORD, method: "totp" }),
    });
    expect(enable.status).toBe(200);
    const rows = await db.select().from(schema.authTwoFactor).where(eq(schema.authTwoFactor.userId, userId));
    const secret = await symmetricDecrypt({ key: SECRET, data: must(rows[0]?.secret) });
    const code = must((await auth.api.generateTOTP({ body: { secret } })).code);
    const verify = await app.request("/api/auth/two-factor/verify-totp", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ code }),
    });
    expect(verify.status).toBe(200);
    const rotated = verify.headers
      .getSetCookie()
      .filter((c) => c.startsWith("better-auth.session_token="))
      .map((c) => must(c.split(";")[0]))[0];
    session.set(name, rotated ?? cookie);
    return must(session.get(name));
  }

  function makeDoc(viewerIds: string[]): string {
    const id = randomUUID();
    docs.set(id, { title: "Doc fixture", viewerIds });
    return id;
  }

  interface LevelSpec {
    name: string;
    users?: string[];
    roles?: string[];
    mode?: "any" | "all" | "quorum";
    quorum?: number;
    requireSignature?: boolean;
    signatureMeaning?: "reviewed" | "approved";
  }

  async function createConfig(
    configKey: string,
    levels: LevelSpec[],
    subjectType = "approval-doc",
  ): Promise<string> {
    const res = await app.request("/api/approval-configs", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: must(session.get("owner")) },
      body: JSON.stringify({ subjectType, configKey, name: `Config ${configKey}`, levels }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id?: string };
    return must(body.id);
  }

  async function submit(docId: string, configKey: string, who = "alice"): Promise<Response> {
    return app.request("/api/approval-requests", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: must(session.get(who)) },
      body: JSON.stringify({ subjectType: "approval-doc", subjectId: docId, configKey }),
    });
  }

  async function act(
    requestId: string,
    who: string,
    body: Record<string, unknown>,
  ): Promise<Response> {
    return app.request(`/api/approval-requests/${requestId}/actions`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: must(session.get(who)) },
      body: JSON.stringify(body),
    });
  }

  // ── 配置面 ──────────────────────────────────────────────────────────────

  it("creates an approval config and lists it by subject type", async () => {
    const configId = await createConfig("doc_release", [
      { name: "lead review", users: [bobId] },
      { name: "final sign-off", users: [carolId], requireSignature: true, signatureMeaning: "reviewed" },
    ]);
    const res = await app.request("/api/approval-configs?subjectType=approval-doc", {
      headers: { cookie: must(session.get("owner")) },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      configs: { id: string; configKey: string; levels: LevelSpec[]; version: number }[];
    };
    const config = body.configs.find((c) => c.id === configId);
    expect(config).toBeDefined();
    expect(must(config).configKey).toBe("doc_release");
    expect(must(config).levels).toHaveLength(2);
    expect(must(config).levels[0]).toMatchObject({ name: "lead review", users: [bobId] });
    expect(must(config).levels[1]).toMatchObject({ requireSignature: true, signatureMeaning: "reviewed" });
  });

  it("rejects config management without approval.configure", async () => {
    const res = await app.request("/api/approval-configs", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: must(session.get("mallory")) },
      body: JSON.stringify({
        subjectType: "approval-doc",
        configKey: "nope",
        name: "Nope",
        levels: [{ name: "only", users: [malloryId] }],
      }),
    });
    expect(res.status).toBe(403);
    const list = await app.request("/api/approval-configs", {
      headers: { cookie: must(session.get("mallory")) },
    });
    expect(list.status).toBe(403);
  });

  it("rejects invalid levels and duplicate keys at save time", async () => {
    const ownerCookie = must(session.get("owner"));
    const post = (body: Record<string, unknown>) =>
      app.request("/api/approval-configs", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: ownerCookie },
        body: JSON.stringify(body),
      });
    const noApprover = await post({
      subjectType: "approval-doc",
      configKey: "empty_line",
      name: "Empty",
      levels: [{ name: "only", users: [], roles: [] }],
    });
    expect(noApprover.status).toBe(422);
    const customerApprover = await post({
      subjectType: "approval-doc",
      configKey: "customer_line",
      name: "Customer",
      levels: [{ name: "only", users: [], roles: ["customer"] }],
    });
    expect(customerApprover.status).toBe(422);
    const badKey = await post({
      subjectType: "approval-doc",
      configKey: "Bad-Key",
      name: "Bad",
      levels: [{ name: "only", users: [bobId] }],
    });
    expect(badKey.status).toBe(400);
    // 会签/票签的形状（#221）：票签必须带票数、票数只属于票签、下限 2（1/N =
    // any 模式，不是第三种语义）
    const quorumWithoutCount = await post({
      subjectType: "approval-doc",
      configKey: "quorum_no_count",
      name: "Quorum",
      levels: [{ name: "only", users: [bobId, carolId], mode: "quorum" }],
    });
    expect(quorumWithoutCount.status).toBe(422);
    const quorumOfOne = await post({
      subjectType: "approval-doc",
      configKey: "quorum_one",
      name: "Quorum",
      levels: [{ name: "only", users: [bobId, carolId], mode: "quorum", quorum: 1 }],
    });
    expect(quorumOfOne.status).toBe(422);
    const countWithoutQuorum = await post({
      subjectType: "approval-doc",
      configKey: "any_with_count",
      name: "Any",
      levels: [{ name: "only", users: [bobId], mode: "any", quorum: 2 }],
    });
    expect(countWithoutQuorum.status).toBe(422);
    await createConfig("twice", [{ name: "only", users: [bobId] }]);
    const duplicate = await post({
      subjectType: "approval-doc",
      configKey: "twice",
      name: "Twice",
      levels: [{ name: "only", users: [carolId] }],
    });
    expect(duplicate.status).toBe(409);
    const body = (await duplicate.json()) as { error?: string };
    expect(body.error).toBe("config_exists");
  });

  // ── 配置改写/停用（#221 配置 UI:就地 PATCH + #226 台账）──────────────────

  it("patches name/levels/active in place: version bumps, ledger and audit record the change", async () => {
    const configId = await createConfig("patch_line", [{ name: "only", users: [bobId] }]);
    const res = await app.request(`/api/approval-configs/${configId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: must(session.get("owner")) },
      body: JSON.stringify({
        name: "Patched line",
        levels: [
          { name: "lead", users: [bobId] },
          { name: "final", users: [carolId], requireSignature: true, signatureMeaning: "reviewed" },
        ],
        active: false,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      config: { version: number; active: boolean; name: string; levels: LevelSpec[] };
    };
    expect(body.config.version).toBe(2);
    expect(body.config.active).toBe(false);
    expect(body.config.name).toBe("Patched line");
    expect(body.config.levels).toHaveLength(2);
    // 台账 v2(source updated)带 changes 摘要;审计行同发,行.version = 台账最新版
    const history = await app.request(`/api/config-versions/approval_config/${configId}`, {
      headers: { cookie: must(session.get("owner")) },
    });
    expect(history.status).toBe(200);
    const revisions = (await history.json()) as {
      revisions: { version: number; source: string; changes: Record<string, { from: unknown; to: unknown }> | null }[];
    };
    expect(revisions.revisions).toHaveLength(2);
    expect(revisions.revisions[0]).toMatchObject({ version: 2, source: "updated" });
    expect(Object.keys(must(revisions.revisions[0]?.changes))).toEqual(
      expect.arrayContaining(["name", "levels", "active"]),
    );
    const audits = await db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.action, "approval.config_updated"));
    expect(audits).toHaveLength(1);
  });

  it("answers an idempotent PATCH without a revision or audit row", async () => {
    const configId = await createConfig("noop_line", [{ name: "only", users: [bobId] }]);
    const res = await app.request(`/api/approval-configs/${configId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: must(session.get("owner")) },
      body: JSON.stringify({
        name: `Config noop_line`,
        levels: [{ name: "only", users: [bobId] }],
        active: true,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { config: { version: number } };
    expect(body.config.version).toBe(1);
    const history = await app.request(`/api/config-versions/approval_config/${configId}`, {
      headers: { cookie: must(session.get("owner")) },
    });
    const revisions = (await history.json()) as { revisions: unknown[] };
    expect(revisions.revisions).toHaveLength(1);
    const audits = await db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.action, "approval.config_updated"));
    expect(audits).toHaveLength(0);
  });

  it("rejects bad levels on PATCH with 422 and an unknown config with 404; guards the face with approval.configure", async () => {
    const configId = await createConfig("guard_line", [{ name: "only", users: [bobId] }]);
    const badLevels = await app.request(`/api/approval-configs/${configId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: must(session.get("owner")) },
      body: JSON.stringify({ levels: [{ name: "only", users: [], roles: [] }] }),
    });
    expect(badLevels.status).toBe(422);
    expect((await badLevels.json()) as { error?: string }).toMatchObject({ error: "invalid_levels" });
    const missing = await app.request(`/api/approval-configs/${randomUUID()}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: must(session.get("owner")) },
      body: JSON.stringify({ active: false }),
    });
    expect(missing.status).toBe(404);
    const forbidden = await app.request(`/api/approval-configs/${configId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: must(session.get("mallory")) },
      body: JSON.stringify({ active: false }),
    });
    expect(forbidden.status).toBe(403);
  });

  it("stops routing new submissions to a deactivated line", async () => {
    const configId = await createConfig("retire_line", [{ name: "only", users: [bobId] }]);
    const docId = randomUUID();
    docs.set(docId, { title: "Retire me", viewerIds: [aliceId, bobId] });
    expect((await submit(docId, "retire_line")).status).toBe(201);
    const deactivate = await app.request(`/api/approval-configs/${configId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: must(session.get("owner")) },
      body: JSON.stringify({ active: false }),
    });
    expect(deactivate.status).toBe(200);
    const docId2 = randomUUID();
    docs.set(docId2, { title: "After retirement", viewerIds: [aliceId, bobId] });
    const refused = await submit(docId2, "retire_line");
    expect(refused.status).toBe(404);
    expect((await refused.json()) as { error?: string }).toMatchObject({ error: "config_inactive" });
  });

  // ── 提交 ────────────────────────────────────────────────────────────────

  it("gates submission on subject visibility and records approval.requested", async () => {
    await createConfig("doc_release", [{ name: "only", users: [bobId] }]);
    const docId = makeDoc([aliceId, bobId, carolId]);
    const unregistered = await app.request("/api/approval-requests", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: must(session.get("alice")) },
      body: JSON.stringify({ subjectType: "not-a-thing", subjectId: docId, configKey: "doc_release" }),
    });
    expect(unregistered.status).toBe(400);
    expect(((await unregistered.json()) as { error: string }).error).toBe("invalid_subject");
    const invisible = await app.request("/api/approval-requests", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: must(session.get("mallory")) },
      body: JSON.stringify({ subjectType: "approval-doc", subjectId: docId, configKey: "doc_release" }),
    });
    expect(invisible.status).toBe(404);
    const unknownKey = await submit(docId, "no_such_line");
    expect(unknownKey.status).toBe(404);
    const created = await submit(docId, "doc_release");
    expect(created.status).toBe(201);
    const audits = await db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.action, "approval.requested"));
    expect(audits).toHaveLength(1);
    expect(must(audits[0]).actor).toBe(aliceId);
    expect(must(audits[0]).detail).toMatchObject({ configKey: "doc_release", subjectId: docId });
  });

  it("refuses a second pending request and allows resubmit after rejection", async () => {
    await createConfig("doc_release", [{ name: "only", users: [bobId] }]);
    const docId = makeDoc([aliceId, bobId]);
    const first = await submit(docId, "doc_release");
    expect(first.status).toBe(201);
    const firstId = ((await first.json()) as { requestId: string }).requestId;
    const second = await submit(docId, "doc_release");
    expect(second.status).toBe(409);
    const secondBody = (await second.json()) as { error: string; requestId: string };
    expect(secondBody.error).toBe("already_pending");
    expect(secondBody.requestId).toBe(firstId);
    // 驳回后单据回到发起人：重新提交 = 新请求
    const rejected = await act(firstId, "bob", { decision: "rejected", note: "not ready" });
    expect(rejected.status).toBe(200);
    const again = await submit(docId, "doc_release");
    expect(again.status).toBe(201);
    const againId = ((await again.json()) as { requestId: string }).requestId;
    expect(againId).not.toBe(firstId);
  });

  // ── 多级流转 ────────────────────────────────────────────────────────────

  it("routes a two-level approval in order and refuses out-of-turn approvers", async () => {
    await createConfig("doc_release", [
      { name: "lead review", users: [bobId] },
      { name: "final sign-off", users: [carolId] },
    ]);
    const docId = makeDoc([aliceId, bobId, carolId]);
    const requestId = ((await (await submit(docId, "doc_release")).json()) as { requestId: string }).requestId;

    const outOfTurn = await act(requestId, "carol", { decision: "approved" });
    expect(outOfTurn.status).toBe(403);
    expect(((await outOfTurn.json()) as { error: string }).error).toBe("not_approver");

    const step1 = await act(requestId, "bob", { decision: "approved" });
    expect(step1.status).toBe(200);
    const step1Body = (await step1.json()) as { requestStatus: string; currentStep: number };
    expect(step1Body.requestStatus).toBe("pending");
    expect(step1Body.currentStep).toBe(1);

    const stillWrong = await act(requestId, "bob", { decision: "approved" });
    expect(stillWrong.status).toBe(403);

    const step2 = await act(requestId, "carol", { decision: "approved" });
    expect(step2.status).toBe(200);
    expect(((await step2.json()) as { requestStatus: string }).requestStatus).toBe("approved");

    const view = await app.request(`/api/approval-requests/${requestId}`, {
      headers: { cookie: must(session.get("alice")) },
    });
    expect(view.status).toBe(200);
    const viewBody = (await view.json()) as {
      request: {
        status: string;
        completedAt: string | null;
        currentLevel: unknown;
        actions: { decision: string; actor: { id: string } }[];
      };
    };
    expect(viewBody.request.status).toBe("approved");
    expect(viewBody.request.completedAt).not.toBeNull();
    expect(viewBody.request.currentLevel).toBeNull();
    expect(viewBody.request.actions.map((a) => a.actor.id)).toEqual([bobId, carolId]);

    // 终态再裁决：请求已关
    const closed = await act(requestId, "carol", { decision: "approved" });
    expect(closed.status).toBe(409);
    expect(((await closed.json()) as { error: string }).error).toBe("request_closed");
  });

  it("todo lists only requests waiting on the caller — named and by role", async () => {
    await createConfig("named_line", [{ name: "only", users: [bobId] }]);
    await createConfig("role_line", [{ name: "only", roles: ["sales_lead"] }]);
    const docA = makeDoc([aliceId, bobId]);
    const docB = makeDoc([aliceId, daveId]);
    const requestA = ((await (await submit(docA, "named_line")).json()) as { requestId: string }).requestId;
    const requestB = ((await (await submit(docB, "role_line")).json()) as { requestId: string }).requestId;

    const bobTodo = await app.request("/api/approval-requests/todo", {
      headers: { cookie: must(session.get("bob")) },
    });
    const bobBody = (await bobTodo.json()) as { requests: { requestId: string }[] };
    expect(bobBody.requests.map((r) => r.requestId)).toEqual([requestA]);

    const carolTodo = await app.request("/api/approval-requests/todo", {
      headers: { cookie: must(session.get("carol")) },
    });
    expect(((await carolTodo.json()) as { requests: unknown[] }).requests).toHaveLength(0);

    const daveTodo = await app.request("/api/approval-requests/todo", {
      headers: { cookie: must(session.get("dave")) },
    });
    const daveBody = (await daveTodo.json()) as { requests: { requestId: string }[] };
    expect(daveBody.requests.map((r) => r.requestId)).toEqual([requestB]);

    await act(requestA, "bob", { decision: "approved" });
    const bobTodoAfter = await app.request("/api/approval-requests/todo", {
      headers: { cookie: must(session.get("bob")) },
    });
    expect(((await bobTodoAfter.json()) as { requests: unknown[] }).requests).toHaveLength(0);
  });

  // 待办行带着裁决语境（#221 切片 3：待办页的读法）：提交人、请求参数（批的
  // 到底是什么）、当前级要不要签名仪式——配置点名的裁决人不需要恰好是单据
  // 可见者，行本身就得够裁（422 signature_required 仍是服务端底线，不是 UI
  // 的发现路径）
  it("todo rows carry the decision context: submitter, payload, signature requirement", async () => {
    await createConfig("sig_paid_line", [
      { name: "sign-off", users: [bobId], requireSignature: true, signatureMeaning: "reviewed" },
    ]);
    await createConfig("plain_line", [{ name: "only", users: [carolId] }]);
    const docA = makeDoc([aliceId, bobId]);
    const docB = makeDoc([aliceId, carolId]);
    // 带 payload 的提交走进程内（与生产属主域同一形态；通用端点不收 payload）
    const created = await submitApprovalRequest(db, {
      subjectType: "approval-doc",
      subjectId: docA,
      configKey: "sig_paid_line",
      submitterId: aliceId,
      payload: { amount: 42 },
    });
    expect(created.status).toBe("created");
    const plain = ((await (await submit(docB, "plain_line")).json()) as { requestId: string }).requestId;

    const bobTodo = await app.request("/api/approval-requests/todo", {
      headers: { cookie: must(session.get("bob")) },
    });
    const bobBody = (await bobTodo.json()) as {
      requests: {
        requestId: string;
        submittedBy: { id: string; name: string };
        payload: unknown;
        requireSignature: boolean;
        signatureMeaning: string;
      }[];
    };
    expect(bobBody.requests).toHaveLength(1);
    const row = must(bobBody.requests[0]);
    expect(row.requestId).toBe(must(created.requestId));
    expect(row.submittedBy).toEqual({ id: aliceId, name: "User alice" });
    expect(row.payload).toEqual({ amount: 42 });
    expect(row.requireSignature).toBe(true);
    expect(row.signatureMeaning).toBe("reviewed");

    const carolTodo = await app.request("/api/approval-requests/todo", {
      headers: { cookie: must(session.get("carol")) },
    });
    const carolBody = (await carolTodo.json()) as {
      requests: { requestId: string; payload: unknown; requireSignature: boolean }[];
    };
    expect(carolBody.requests.map((r) => r.requestId)).toEqual([plain]);
    expect(must(carolBody.requests[0]).payload).toBeNull();
    expect(must(carolBody.requests[0]).requireSignature).toBe(false);
  });

  it("rejection closes the request, notifies the submitter, and allows a fresh submit", async () => {
    await createConfig("doc_release", [{ name: "only", users: [bobId] }]);
    const docId = makeDoc([aliceId, bobId]);
    const requestId = ((await (await submit(docId, "doc_release")).json()) as { requestId: string }).requestId;

    const rejected = await act(requestId, "bob", { decision: "rejected", note: "numbers look wrong" });
    expect(rejected.status).toBe(200);
    expect(((await rejected.json()) as { requestStatus: string }).requestStatus).toBe("rejected");

    const notifications = await db
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.userId, aliceId));
    expect(notifications).toHaveLength(1);
    expect(must(notifications[0]).eventType).toBe("approval.rejected");
    expect(must(notifications[0]).aggregateId).toBe(requestId);

    const view = await app.request(`/api/approval-requests/${requestId}`, {
      headers: { cookie: must(session.get("alice")) },
    });
    expect(view.status).toBe(200);
    const viewBody = (await view.json()) as {
      request: { status: string; actions: { decision: string; note: string | null }[] };
    };
    expect(viewBody.request.status).toBe("rejected");
    expect(viewBody.request.actions[0]).toMatchObject({ decision: "rejected", note: "numbers look wrong" });
  });

  // ── 多级通知扇出（#221：轮到谁审，谁就在铃铛里）───────────────────────────

  it("fans approval.pending out to the first level's named and role adjudicators on submit", async () => {
    await createConfig("doc_release", [{ name: "lead review", users: [bobId], roles: ["sales_lead"] }]);
    const docId = makeDoc([aliceId, bobId, carolId]);
    const created = await submit(docId, "doc_release");
    expect(created.status).toBe(201);

    const rows = await db.select().from(schema.notifications).where(eq(schema.notifications.eventType, "approval.pending"));
    expect(rows.map((r) => r.userId).sort()).toEqual([bobId, daveId].sort());
    const first = must(rows[0]);
    expect(first.aggregateType).toBe("approval_request");
    expect(first.aggregateId).toBe(((await created.json()) as { requestId: string }).requestId);
    expect(first.payload).toMatchObject({
      subjectType: "approval-doc",
      configKey: "doc_release",
      configName: "Config doc_release",
      levelName: "lead review",
      actorName: "User alice",
    });
    // 发起人自己不在收件人里（自批线不给自己报信）；实时「催」与行同名单
    expect(rows.map((r) => r.userId)).not.toContain(aliceId);
    expect(bellNudges).toHaveLength(1);
    expect(bellNudges[0]?.sort()).toEqual([bobId, daveId].sort());

    // 已在飞的第二次提交不重复扇出（409 语义，行数不变）
    const again = await submit(docId, "doc_release");
    expect(again.status).toBe(409);
    const after = await db.select().from(schema.notifications).where(eq(schema.notifications.eventType, "approval.pending"));
    expect(after).toHaveLength(rows.length);
    expect(bellNudges).toHaveLength(1);
  });

  it("notifies the next level on advance and the submitter only at a terminal state", async () => {
    await createConfig("doc_release", [
      { name: "lead review", users: [bobId] },
      { name: "final sign-off", users: [carolId] },
    ]);
    const docId = makeDoc([aliceId, bobId, carolId]);
    const requestId = ((await (await submit(docId, "doc_release")).json()) as { requestId: string }).requestId;

    // 提交只扇出首级：carol（第二级）此刻没有通知
    const carolRows = await db.select().from(schema.notifications).where(eq(schema.notifications.userId, carolId));
    expect(carolRows).toHaveLength(0);

    const step1 = await act(requestId, "bob", { decision: "approved" });
    expect(step1.status).toBe(200);
    const advanced = await db.select().from(schema.notifications).where(eq(schema.notifications.userId, carolId));
    expect(advanced).toHaveLength(1);
    expect(must(advanced[0]).eventType).toBe("approval.pending");
    expect(must(advanced[0]).payload).toMatchObject({
      configName: "Config doc_release",
      levelName: "final sign-off",
      actorName: "User bob",
    });
    expect(bellNudges.at(-1)).toEqual([carolId]);

    // 中间级推进不通知发起人：发起人的铃铛只在终态响
    const aliceMid = await db.select().from(schema.notifications).where(eq(schema.notifications.userId, aliceId));
    expect(aliceMid).toHaveLength(0);

    const step2 = await act(requestId, "carol", { decision: "approved" });
    expect(step2.status).toBe(200);
    const terminal = await db.select().from(schema.notifications).where(eq(schema.notifications.userId, aliceId));
    expect(terminal).toHaveLength(1);
    expect(must(terminal[0]).eventType).toBe("approval.completed");
    expect(must(terminal[0]).payload).toMatchObject({
      configName: "Config doc_release",
      actorName: "User carol",
    });
    expect(bellNudges.at(-1)).toEqual([aliceId]);
  });

  it("does not notify the submitter of their own self-approval line", async () => {
    await createConfig("self_line", [{ name: "own call", users: [aliceId] }]);
    const docId = makeDoc([aliceId]);
    const created = await submit(docId, "self_line");
    expect(created.status).toBe(201);
    const rows = await db.select().from(schema.notifications);
    expect(rows).toHaveLength(0);
    expect(bellNudges).toHaveLength(0);
    // 请求照常在飞，发起人兼审批人照常可裁（R-16-5 业务自批）
    const todo = await app.request("/api/approval-requests/todo", {
      headers: { cookie: must(session.get("alice")) },
    });
    expect(((await todo.json()) as { requests: unknown[] }).requests).toHaveLength(1);
  });

  // ── 签名仪式 ────────────────────────────────────────────────────────────

  it("enforces the signature ceremony on signature levels and rolls back on refusal", async () => {
    await createConfig("sig_release", [
      { name: "sign-off", users: [erinId, bobId], requireSignature: true, signatureMeaning: "reviewed" },
    ]);
    const docId = makeDoc([aliceId, erinId, bobId]);
    const requestId = ((await (await submit(docId, "sig_release")).json()) as { requestId: string }).requestId;

    // 缺仪式输入：422 signature_required
    const missing = await act(requestId, "erin", { decision: "approved" });
    expect(missing.status).toBe(422);
    expect(((await missing.json()) as { error: string }).error).toBe("signature_required");

    // 未绑 2FA 的审批人：403 先于密码判定（连「密码对不对」都探不到）
    const noTotp = await act(requestId, "bob", {
      decision: "approved",
      password: PASSWORD,
      clientToken: randomUUID(),
    });
    expect(noTotp.status).toBe(403);
    expect(((await noTotp.json()) as { error: string }).error).toBe("two_factor_required");

    // 密码错：401 且整包回滚——裁决行、签名行、推进全都不存在
    const wrongPassword = await act(requestId, "erin", {
      decision: "approved",
      password: "not-my-password",
      clientToken: randomUUID(),
    });
    expect(wrongPassword.status).toBe(401);
    expect(((await wrongPassword.json()) as { error: string }).error).toBe("invalid_credentials");
    const actionsAfterFailure = await db.select().from(schema.approvalActions);
    expect(actionsAfterFailure).toHaveLength(0);
    const requestRows = await db.select().from(schema.approvalRequests).where(eq(schema.approvalRequests.id, requestId));
    expect(must(requestRows[0]).status).toBe("pending");
    expect(must(requestRows[0]).currentStep).toBe(0);

    // 正确仪式：批准 + 签名（meaning 来自配置）落 esign_signatures，绑定裁决行
    const signed = await act(requestId, "erin", {
      decision: "approved",
      password: PASSWORD,
      clientToken: randomUUID(),
    });
    expect(signed.status).toBe(200);
    const signedBody = (await signed.json()) as { actionId: string; requestStatus: string };
    expect(signedBody.requestStatus).toBe("approved");

    const signatures = await db
      .select()
      .from(schema.esignSignatures)
      .where(
        and(eq(schema.esignSignatures.subjectType, "approval_action"), eq(schema.esignSignatures.subjectId, signedBody.actionId)),
      );
    expect(signatures).toHaveLength(1);
    expect(must(signatures[0]).meaning).toBe("reviewed");
    expect(must(signatures[0]).signerId).toBe(erinId);

    // 签名墙经 approval_action 的可见性门可读（参与者看得到）
    const wall = await app.request(
      `/api/esignatures?subjectType=approval_action&subjectId=${signedBody.actionId}`,
      { headers: { cookie: must(session.get("erin")) } },
    );
    expect(wall.status).toBe(200);
    const wallBody = (await wall.json()) as { signatures: { meaning: string }[] };
    expect(wallBody.signatures.map((s) => s.meaning)).toEqual(["reviewed"]);
  });

  it("rejects a half-specified ceremony input", async () => {
    await createConfig("sig_release", [{ name: "sign-off", users: [erinId], requireSignature: true }]);
    const docId = makeDoc([aliceId, erinId]);
    const requestId = ((await (await submit(docId, "sig_release")).json()) as { requestId: string }).requestId;
    const half = await act(requestId, "erin", { decision: "approved", password: PASSWORD });
    expect(half.status).toBe(400);
  });

  // ── 工作流门槛（approval.passed 积木）───────────────────────────────────

  it("gate block approval.passed holds the transition until the approval completes", async () => {
    await createConfig("doc_release", [
      { name: "lead review", users: [bobId] },
      { name: "final sign-off", users: [carolId] },
    ]);
    const templateRes = await app.request("/api/workflow-templates", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: must(session.get("owner")) },
      body: JSON.stringify({
        subjectType: "approval-doc",
        templateKey: "doc_flow",
        isDefault: true,
        definition: {
          initial: "draft",
          states: {
            draft: {
              on: {
                RELEASE: {
                  target: "released",
                  gates: [{ name: "approval.passed", config: { key: "doc_release" } }],
                },
              },
            },
            released: {},
          },
        },
      }),
    });
    expect(templateRes.status).toBe(201);

    const docId = makeDoc([aliceId, bobId, carolId, ownerId]);
    const started = await startWorkflow(db, {
      subjectType: "approval-doc",
      subjectId: docId,
      startedById: ownerId,
    });
    expect(started.status).toBe("started");
    const requestId = ((await (await submit(docId, "doc_release")).json()) as { requestId: string }).requestId;

    // 未批：门槛不过（422 gate_failed 带积木名）
    const blocked = await app.request(`/api/workflow-instances/approval-doc/${docId}/transitions`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: must(session.get("owner")) },
      body: JSON.stringify({ event: "RELEASE" }),
    });
    expect(blocked.status).toBe(422);
    expect((await blocked.json()) as { error: string; gate: string }).toMatchObject({
      error: "gate_failed",
      gate: "approval.passed",
    });

    // 驳回也不过门（fail closed：没有 approved 就没有 RELEASE）
    await act(requestId, "bob", { decision: "rejected" });
    const stillBlocked = await app.request(`/api/workflow-instances/approval-doc/${docId}/transitions`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: must(session.get("owner")) },
      body: JSON.stringify({ event: "RELEASE" }),
    });
    expect(stillBlocked.status).toBe(422);

    // 重新提交并通过两级审批 → 门槛放行
    const retryId = ((await (await submit(docId, "doc_release")).json()) as { requestId: string }).requestId;
    expect((await act(retryId, "bob", { decision: "approved" })).status).toBe(200);
    expect((await act(retryId, "carol", { decision: "approved" })).status).toBe(200);
    const released = await app.request(`/api/workflow-instances/approval-doc/${docId}/transitions`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: must(session.get("owner")) },
      body: JSON.stringify({ event: "RELEASE" }),
    });
    expect(released.status).toBe(200);
    expect((await released.json()) as { to: string }).toMatchObject({ to: "released" });
  });

  // ── 批准即生效（payload + outcome，#221 切片 2）──────────────────────────

  it("carries payload to the approver and runs the outcome exactly at final approval", async () => {
    await createConfig("auto_line", [
      { name: "lead review", users: [bobId] },
      { name: "final sign-off", users: [carolId] },
    ], "outcome-doc");
    const docId = makeDoc([aliceId, bobId, carolId]);

    // 带 outcome 自动化的 subject 走通用端点（不收 payload）：422 挡住无参数死请求
    const generic = await app.request("/api/approval-requests", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: must(session.get("alice")) },
      body: JSON.stringify({ subjectType: "outcome-doc", subjectId: docId, configKey: "auto_line" }),
    });
    expect(generic.status).toBe(422);
    expect(((await generic.json()) as { error: string }).error).toBe("payload_required");

    // 属主域进程内带参数提交：payload 进请求、给审批人看
    const created = await submitApprovalRequest(db, {
      subjectType: "outcome-doc",
      subjectId: docId,
      configKey: "auto_line",
      submitterId: aliceId,
      payload: { amount: 42 },
    });
    expect(created.status).toBe("created");
    const requestId = must(created.status === "created" ? created.requestId : undefined);

    // 中间级通过不触发 outcome
    expect((await act(requestId, "bob", { decision: "approved" })).status).toBe(200);
    expect(outcomeCalls).toEqual([]);

    // 审批人看得见「批的到底是什么」
    const view = await app.request(`/api/approval-requests/${requestId}`, {
      headers: { cookie: must(session.get("carol")) },
    });
    expect(((await view.json()) as { request: { payload: unknown } }).request.payload).toEqual({
      amount: 42,
    });

    // 终审批准的同一笔事务里 outcome 拿到全部语境
    const final = await act(requestId, "carol", { decision: "approved" });
    expect(final.status).toBe(200);
    expect(outcomeCalls).toEqual([
      {
        requestId,
        subjectId: docId,
        payload: { amount: 42 },
        submittedById: aliceId,
        actorId: carolId,
      },
    ]);
  });

  it("an outcome failure rolls the whole decision back (fail closed)", async () => {
    await createConfig("fragile_line", [{ name: "only", users: [bobId] }], "outcome-doc");
    const docId = makeDoc([aliceId, bobId]);
    const created = await submitApprovalRequest(db, {
      subjectType: "outcome-doc",
      subjectId: docId,
      configKey: "fragile_line",
      submitterId: aliceId,
      payload: { fragile: true },
    });
    const requestId = must(created.status === "created" ? created.requestId : undefined);
    outcomeFailNext = true;

    const response = await act(requestId, "bob", { decision: "approved" });
    expect(response.status).toBe(500);

    // 裁决没发生：请求仍在飞、无裁决行、无终态审计——属主域修好数据后可重裁
    const requestRows = await db
      .select({ status: schema.approvalRequests.status, currentStep: schema.approvalRequests.currentStep })
      .from(schema.approvalRequests)
      .where(eq(schema.approvalRequests.id, requestId));
    expect(requestRows[0]).toMatchObject({ status: "pending", currentStep: 0 });
    expect(await db.select().from(schema.approvalActions)).toHaveLength(0);
    const lifecycle = await db
      .select({ action: schema.auditEvents.action })
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.target, requestId));
    expect(lifecycle.map((row) => row.action)).toEqual(["approval.requested"]);

    // 修好后再裁：放行
    outcomeFailNext = false;
    expect((await act(requestId, "bob", { decision: "approved" })).status).toBe(200);
    const after = await db
      .select({ status: schema.approvalRequests.status })
      .from(schema.approvalRequests)
      .where(eq(schema.approvalRequests.id, requestId));
    expect(must(after[0]).status).toBe("approved");
  });

  // ── 并发 ────────────────────────────────────────────────────────────────

  it("serializes concurrent approvals of the same step to a single winner", async () => {
    await createConfig("anyof_line", [{ name: "any of two", users: [bobId, carolId] }]);
    const docId = makeDoc([aliceId, bobId, carolId]);
    const requestId = ((await (await submit(docId, "anyof_line")).json()) as { requestId: string }).requestId;

    const [first, second] = await Promise.all([
      act(requestId, "bob", { decision: "approved" }),
      act(requestId, "carol", { decision: "approved" }),
    ]);
    const outcomes = [first.status, second.status].sort();
    expect(outcomes).toEqual([200, 409]);
    // 输家的 409 有两种合法语义：真撞车（concurrent_conflict）或晚到读到终态
    // （request_closed）——不变式是只有一个赢家，不是拒绝理由的唯一性
    const loser = first.status === 409 ? first : second;
    const loserBody = (await loser.json()) as { error: string };
    expect(["concurrent_conflict", "request_closed"]).toContain(loserBody.error);
    // 恰好一行裁决：输家不落行、不推进、不落审计
    const actions = await db.select().from(schema.approvalActions);
    expect(actions).toHaveLength(1);
    const requestRows = await db.select().from(schema.approvalRequests).where(eq(schema.approvalRequests.id, requestId));
    expect(must(requestRows[0]).status).toBe("approved");
  });

  // ── 会签/票签（#221 多人裁决形态）───────────────────────────────────────

  it("countersign level passes only when every adjudicator has approved", async () => {
    await createConfig("all_line", [{ name: "unanimous", users: [bobId, carolId], mode: "all" }]);
    const docId = makeDoc([aliceId, bobId, carolId]);
    const requestId = ((await (await submit(docId, "all_line")).json()) as { requestId: string }).requestId;

    // 第一票：级别不推进（currentStep 不动、请求仍在飞），下一级不收通知
    const first = await act(requestId, "bob", { decision: "approved" });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { requestStatus: string; currentStep: number };
    expect(firstBody.requestStatus).toBe("pending");
    expect(firstBody.currentStep).toBe(0);
    const requestRows = await db.select().from(schema.approvalRequests).where(eq(schema.approvalRequests.id, requestId));
    expect(must(requestRows[0]).status).toBe("pending");
    expect(must(requestRows[0]).currentStep).toBe(0);

    // 待办行自带进度：carol 看 1/2 未表决，bob 看自己已表决
    const carolTodo = await app.request("/api/approval-requests/todo", {
      headers: { cookie: must(session.get("carol")) },
    });
    const carolRow = must(
      ((await carolTodo.json()) as {
        requests: {
          requestId: string;
          levelMode: string;
          approvedCount: number;
          neededApprovals: number;
          viewerAlreadyActed: boolean;
        }[];
      }).requests.find((r) => r.requestId === requestId),
    );
    expect(carolRow.levelMode).toBe("all");
    expect(carolRow.approvedCount).toBe(1);
    expect(carolRow.neededApprovals).toBe(2);
    expect(carolRow.viewerAlreadyActed).toBe(false);
    const bobTodo = await app.request("/api/approval-requests/todo", {
      headers: { cookie: must(session.get("bob")) },
    });
    const bobRow = must(
      ((await bobTodo.json()) as { requests: { requestId: string; viewerAlreadyActed: boolean }[] }).requests.find(
        (r) => r.requestId === requestId,
      ),
    );
    expect(bobRow.viewerAlreadyActed).toBe(true);

    // 已表决的人再裁 → 409（「你已表决」，不落第二行）
    const again = await act(requestId, "bob", { decision: "approved" });
    expect(again.status).toBe(409);
    expect(await db.select().from(schema.approvalActions)).toHaveLength(1);

    // 第二票凑齐：单级请求终审通过
    const second = await act(requestId, "carol", { decision: "approved" });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { requestStatus: string };
    expect(secondBody.requestStatus).toBe("approved");
  });

  it("one rejection in a countersign level is terminal and returns the doc to the submitter", async () => {
    await createConfig("all_reject_line", [{ name: "unanimous", users: [bobId, carolId], mode: "all" }]);
    const docId = makeDoc([aliceId, bobId, carolId]);
    const requestId = ((await (await submit(docId, "all_reject_line")).json()) as { requestId: string }).requestId;
    expect((await act(requestId, "bob", { decision: "approved" })).status).toBe(200);
    const rejection = await act(requestId, "carol", { decision: "rejected", note: "not yet" });
    expect(rejection.status).toBe(200);
    expect(((await rejection.json()) as { requestStatus: string }).requestStatus).toBe("rejected");
    const requestRows = await db.select().from(schema.approvalRequests).where(eq(schema.approvalRequests.id, requestId));
    expect(must(requestRows[0]).status).toBe("rejected");
    // 两行裁决都留痕：会签的历史是逐人的（append-only，不改写）
    expect(await db.select().from(schema.approvalActions)).toHaveLength(2);
    // 发起人收终态通知（驳回回到发起人的「回到」是真的递到手上）
    const notes = await db
      .select({ eventType: schema.notifications.eventType })
      .from(schema.notifications)
      .where(eq(schema.notifications.userId, aliceId));
    expect(notes.map((n) => n.eventType)).toContain("approval.rejected");
  });

  it("vote level passes at quorum without every adjudicator", async () => {
    await createConfig("vote_line", [
      { name: "two of three", users: [bobId, carolId, daveId], mode: "quorum", quorum: 2 },
    ]);
    const docId = makeDoc([aliceId, bobId, carolId, daveId]);
    const requestId = ((await (await submit(docId, "vote_line")).json()) as { requestId: string }).requestId;

    const first = await act(requestId, "bob", { decision: "approved" });
    expect(first.status).toBe(200);
    expect(((await first.json()) as { requestStatus: string }).requestStatus).toBe("pending");
    // carol 的待办行：票签 1/2
    const carolTodo = await app.request("/api/approval-requests/todo", {
      headers: { cookie: must(session.get("carol")) },
    });
    const carolRow = must(
      ((await carolTodo.json()) as { requests: { requestId: string; levelMode: string; approvedCount: number; neededApprovals: number }[] })
        .requests.find((r) => r.requestId === requestId),
    );
    expect(carolRow.levelMode).toBe("quorum");
    expect(carolRow.approvedCount).toBe(1);
    expect(carolRow.neededApprovals).toBe(2);

    // 第二票到数即过：dave 从未裁决，行数停在 2
    const second = await act(requestId, "carol", { decision: "approved" });
    expect(second.status).toBe(200);
    expect(((await second.json()) as { requestStatus: string }).requestStatus).toBe("approved");
    expect(await db.select().from(schema.approvalActions)).toHaveLength(2);
  });

  it("countersign signatures bind each approver's own action row", async () => {
    // 会签 × 签名级：每个同意的人各自走仪式、各绑各的裁决行（Part 11 的联结
    // 签名逐人成立，不是一张级级共享的签名）
    await createConfig("sig_all_line", [
      { name: "signed unanimous", users: [bobId, erinId], mode: "all", requireSignature: true },
    ]);
    // bob 补 2FA（签名级要求双因素，与 erin 同门）
    session.set("bob", await enrollTotp(bobId, must(emails.get("bob")), "bob"));
    const docId = makeDoc([aliceId, bobId, erinId]);
    const requestId = ((await (await submit(docId, "sig_all_line")).json()) as { requestId: string }).requestId;

    const first = await act(requestId, "erin", {
      decision: "approved",
      password: PASSWORD,
      clientToken: randomUUID(),
    });
    expect(first.status).toBe(200);
    expect(((await first.json()) as { requestStatus: string }).requestStatus).toBe("pending");
    const second = await act(requestId, "bob", {
      decision: "approved",
      password: PASSWORD,
      clientToken: randomUUID(),
    });
    expect(second.status).toBe(200);
    expect(((await second.json()) as { requestStatus: string }).requestStatus).toBe("approved");

    // 两行签名、各指一行裁决、meaning 同级配置
    const signatures = await db.select().from(schema.esignSignatures);
    expect(signatures).toHaveLength(2);
    const actions = await db.select().from(schema.approvalActions);
    expect(actions).toHaveLength(2);
    const signedActions = new Set(signatures.map((s) => s.subjectId));
    expect(signedActions).toEqual(new Set(actions.map((a) => a.id)));
    expect(new Set(signatures.map((s) => s.signerId))).toEqual(new Set([bobId, erinId]));
    for (const signature of signatures) {
      expect(signature.meaning).toBe("approved");
    }
  });

  it("countersign progress rides the audit trail for every partial vote", async () => {
    await createConfig("all_audit_line", [{ name: "unanimous", users: [bobId, carolId], mode: "all" }]);
    const docId = makeDoc([aliceId, bobId, carolId]);
    const requestId = ((await (await submit(docId, "all_audit_line")).json()) as { requestId: string }).requestId;
    expect((await act(requestId, "bob", { decision: "approved" })).status).toBe(200);
    expect((await act(requestId, "carol", { decision: "approved" })).status).toBe(200);

    const res = await app.request("/api/audit-events?action=approval.action_recorded", {
      headers: { cookie: must(session.get("owner")) },
    });
    const body = (await res.json()) as { events: { detail: Record<string, unknown> | null }[] };
    const votes = body.events
      .filter((e) => e.detail?.requestId === requestId)
      .map((e) => e.detail)
      .sort((a, b) => Number(must(a).approvedCount) - Number(must(b).approvedCount));
    expect(votes).toHaveLength(2);
    expect(must(votes[0])).toMatchObject({
      mode: "all",
      approvedCount: 1,
      neededApprovals: 2,
      levelSatisfied: false,
    });
    expect(must(votes[1])).toMatchObject({
      mode: "all",
      approvedCount: 2,
      neededApprovals: 2,
      levelSatisfied: true,
    });
  });

  // ── 审计验收 ────────────────────────────────────────────────────────────

  it("audit log records approver, decision and signature meaning for every action (#221 acceptance 3)", async () => {
    await createConfig("mixed_line", [
      { name: "review", users: [bobId] },
      { name: "approve", users: [erinId], requireSignature: true },
    ]);
    const docId = makeDoc([aliceId, bobId, erinId]);
    const requestId = ((await (await submit(docId, "mixed_line")).json()) as { requestId: string }).requestId;
    expect((await act(requestId, "bob", { decision: "approved", note: "checked" })).status).toBe(200);
    expect(
      (await act(requestId, "erin", { decision: "approved", password: PASSWORD, clientToken: randomUUID() })).status,
    ).toBe(200);

    const res = await app.request("/api/audit-events?action=approval.action_recorded", {
      headers: { cookie: must(session.get("owner")) },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events: { actor: string | null; detail: Record<string, unknown> | null }[];
    };
    const review = body.events.find((e) => e.detail?.level === "review");
    const approve = body.events.find((e) => e.detail?.level === "approve");
    expect(review).toBeDefined();
    expect(must(review).actor).toBe(bobId);
    expect(must(review).detail).toMatchObject({
      requestId,
      decision: "approved",
      stepIndex: 0,
      note: "checked",
    });
    expect(must(review).detail).not.toHaveProperty("signatureMeaning");
    expect(approve).toBeDefined();
    expect(must(approve).actor).toBe(erinId);
    expect(must(approve).detail).toMatchObject({
      requestId,
      decision: "approved",
      stepIndex: 1,
      signatureMeaning: "approved",
    });
    // 请求级事件也在：发起 + 完成
    const lifecycle = await db
      .select({ action: schema.auditEvents.action })
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.target, requestId));
    expect(lifecycle.map((row) => row.action)).toContain("approval.requested");
    expect(lifecycle.map((row) => row.action)).toContain("approval.completed");
  });
});

function adminUrl(databaseUrl: string | undefined): string {
  if (databaseUrl === undefined) return "";
  const url = new URL(databaseUrl);
  url.pathname = "/postgres";
  return url.toString();
}
