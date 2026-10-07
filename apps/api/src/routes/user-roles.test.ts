import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, runMigrations, schema } from "@ally/db";
import { createApp } from "../app.ts";
import { createAuth, createSessionResolver } from "../auth/auth.ts";
import { ROLE_APPROVAL_CONFIG_KEY, ROLE_APPROVAL_SUBJECT_TYPE } from "../authz/role-approval.ts";
import { createAuthzStore } from "../authz/service.ts";
import type { Role } from "../authz/permissions.ts";
import type { MailMessage } from "@ally/mailer";

// 集成测试：需要真实 PostgreSQL（角色管理端点写 user_role + audit_events，R-16-6
// 审批路径写 approval_*）。未设 DATABASE_URL 跳过。
//
// 本文件用**独立的临时库**（每次运行新建、跑完 drop，纪律同 approvals.test.ts）：
// 审批请求的 submitted_by_id 对用户行是 no-action FK，且 approval_actions 行级
// 触发器拒删——共享库上「测完删用户」的清理会撞 FK，审计断言也吃并行文件的残行；
// 临时库整体生灭，beforeEach 一条 TRUNCATE 清出干净断言面（TRUNCATE 是 DDL，
// 不触发 append-only 行触发器，docs/approval.md「测试清库的唯一通道」）。
const databaseUrl = process.env.DATABASE_URL;

const logger = pino({ level: "silent" });
const SECRET = "test-secret-0123456789abcdef0123456789abcdef";
const WEB_APP_URL = "https://admin.example";
const PASSWORD = "correct-horse-battery";

function must<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("unexpected missing value in test");
  return value;
}

/** 邮件 spy：记录每一封（验证链接要从邮件里取） */
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

describe.skipIf(!databaseUrl)("user roles routes (#23, #221 slice 2, integration)", () => {
  // 管理连接连 maintenance 库建删临时库；测试连接指向本文件专属临时库
  const dbName = `user_roles_test_${String(Date.now())}_${String(process.pid)}`;
  const adminPool = createDb(adminUrl(databaseUrl));
  const scopedUrl =
    databaseUrl === undefined
      ? ""
      : (() => {
          const url = new URL(databaseUrl);
          url.pathname = `/${dbName}`;
          return url.toString();
        })();
  const { db, pool } = createDb(scopedUrl);
  // 拆库瞬间的空闲连接被 57P01 强杀时，pg Pool 会把 FATAL 重发到 pool 对象
  // （样板：routes/comments.test.ts）。预期的拆除错误，吞掉。
  pool.on("error", () => {});
  adminPool.pool.on("error", () => {});

  const mailer = spyMailer();
  const auth = createAuth({
    db,
    secret: SECRET,
    trustedOrigins: ["http://localhost:5173"],
    baseURL: undefined,
    webAppUrl: WEB_APP_URL,
    googleOAuth: undefined,
    mailer,
    logger,
  });
  const authzStore = createAuthzStore(db);
  const app = createApp({
    stripe: undefined,
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
    },
    authzStore,

    notifyUsers: async () => {},
  });

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("unreachable: suite is skipped without DATABASE_URL");
    await adminPool.pool.query(`create database "${dbName}"`);
    await runMigrations(db);
  });

  beforeEach(async () => {
    // 每条测试从空表开始（用户行与角色授予不清——临时库整体生灭）。一条语句：
    // approval_* 有 FK 相连，分开 TRUNCATE 会撞约束（gotcha：单语句 TRUNCATE）
    await db.execute(
      sql`truncate table ${schema.approvalConfigs}, ${schema.approvalRequests}, ${schema.approvalActions}, ${schema.esignSignatures}, ${schema.auditEvents}, ${schema.notifications} cascade`,
    );
  });

  afterAll(async () => {
    await pool.end();
    await adminPool.pool.query(`drop database if exists "${dbName}" with (force)`);
    await adminPool.pool.end();
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

  async function seedRole(userId: string, role: Role): Promise<void> {
    await db.insert(schema.userRole).values({ userId, role }).onConflictDoNothing();
  }

  /** #24 起管理员过不了 2FA 强制门：本文件的测试对象是 RBAC 不是绑定仪式，
   *  夹具直接把标志置位（绑定/校验的完整闭环在 auth/two-factor.test.ts）。 */
  async function enableTwoFactor(userId: string): Promise<void> {
    await db
      .update(schema.authUser)
      .set({ twoFactorEnabled: true })
      .where(eq(schema.authUser.id, userId));
  }

  /** 固定阵容：老板 / 管理员 / 销售 / 无角色，外加一个被管理的目标用户 */
  async function fixture(): Promise<{
    owner: Actor;
    admin: Actor;
    sales: Actor;
    plain: Actor;
    target: Actor;
    cookieFor: (actor: Actor) => Promise<string>;
  }> {
    const [owner, admin, sales, plain, target] = await Promise.all([
      signUpVerified(),
      signUpVerified(),
      signUpVerified(),
      signUpVerified(),
      signUpVerified(),
    ]);
    await seedRole(owner.userId, "owner");
    await seedRole(admin.userId, "admin");
    await seedRole(sales.userId, "sales");
    // #24 起带 twoFactorEnabled 的账号登录响应是 2FA 挑战,不再发会话 cookie。
    // 本文件测的是 RBAC,不走绑定仪式:置位前先把 admin 的会话签出来（直接
    // 置位不吊销既有会话）,cookieFor 记忆各 actor 的会话、不重复登录。
    const adminCookie = await signInCookie(admin);
    await enableTwoFactor(admin.userId);
    const cookies = new Map<Actor, string>([[admin, adminCookie]]);
    const cookieFor = async (actor: Actor): Promise<string> => {
      const hit = cookies.get(actor);
      if (hit !== undefined) return hit;
      const fresh = await signInCookie(actor);
      cookies.set(actor, fresh);
      return fresh;
    };
    return { owner, admin, sales, plain, target, cookieFor };
  }

  async function auditRows(target: string): Promise<
    { action: string; actor: string | null; detail: unknown }[]
  > {
    return db
      .select({
        action: schema.auditEvents.action,
        actor: schema.auditEvents.actor,
        detail: schema.auditEvents.detail,
      })
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.target, target));
  }

  /**
   * R-16-6 审批线夹具：直插配置行（配置面 API 的契约在 approvals.test.ts 覆盖）。
   * 老板终审一级：点名 owner 角色，不要求签名。
   */
  async function ensureRoleApprovalLine(active = true): Promise<void> {
    await db
      .insert(schema.approvalConfigs)
      .values({
        subjectType: ROLE_APPROVAL_SUBJECT_TYPE,
        configKey: ROLE_APPROVAL_CONFIG_KEY,
        name: "High-privilege role change",
        active,
        levels: [
          {
            name: "owner confirm",
            users: [],
            roles: ["owner"],
            requireSignature: false,
            signatureMeaning: "approved",
          },
        ],
      })
      .onConflictDoNothing();
    if (active) {
      await db
        .update(schema.approvalConfigs)
        .set({ active: true })
        .where(
          and(
            eq(schema.approvalConfigs.subjectType, ROLE_APPROVAL_SUBJECT_TYPE),
            eq(schema.approvalConfigs.configKey, ROLE_APPROVAL_CONFIG_KEY),
          ),
        );
    }
  }

  async function pendingRequestFor(
    targetId: string,
  ): Promise<{ id: string; status: string; payload: unknown } | undefined> {
    const rows = await db
      .select({
        id: schema.approvalRequests.id,
        status: schema.approvalRequests.status,
        payload: schema.approvalRequests.payload,
      })
      .from(schema.approvalRequests)
      .where(
        and(
          eq(schema.approvalRequests.subjectType, ROLE_APPROVAL_SUBJECT_TYPE),
          eq(schema.approvalRequests.subjectId, targetId),
        ),
      );
    return rows[0];
  }

  it("admin grants sales; /api/me reflects the role; audit records the change", async () => {
    const f = await fixture();
    const res = await app.request(`/api/users/${f.target.userId}/roles`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: await f.cookieFor(f.admin) },
      body: JSON.stringify({ role: "sales" }),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ role: "sales", granted: true });

    expect(await authzStore.getRoles(f.target.userId)).toEqual(["sales"]);

    const me = await app.request("/api/me", { headers: { cookie: await f.cookieFor(f.target) } });
    const body = (await me.json()) as { authz?: { roles?: string[] } };
    expect(body.authz?.roles).toEqual(["sales"]);

    const rows = await auditRows(f.target.userId);
    expect(rows).toEqual([
      { action: "role.granted", actor: f.admin.userId, detail: { role: "sales" } },
    ]);
  });

  it("repeated grant answers 200 granted:false and writes no audit row", async () => {
    const f = await fixture();
    await seedRole(f.target.userId, "sales");
    const res = await app.request(`/api/users/${f.target.userId}/roles`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: await f.cookieFor(f.admin) },
      body: JSON.stringify({ role: "sales" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ role: "sales", granted: false });
    expect(await auditRows(f.target.userId)).toEqual([]);
  });

  it("admin cannot grant owner-approval roles while the line is unconfigured (fail-closed), owner can", async () => {
    const f = await fixture();
    const adminCookie = await f.cookieFor(f.admin);
    for (const role of ["owner", "admin", "finance"] as const) {
      const res = await app.request(`/api/users/${f.target.userId}/roles`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: adminCookie },
        body: JSON.stringify({ role }),
      });
      expect([role, res.status]).toEqual([role, 403]);
      expect(await res.json()).toEqual({ error: "forbidden", code: "owner_approval_required" });
    }
    expect(await auditRows(f.target.userId)).toEqual([]);

    const ok = await app.request(`/api/users/${f.target.userId}/roles`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: await f.cookieFor(f.owner) },
      body: JSON.stringify({ role: "finance" }),
    });
    expect(ok.status).toBe(201);
    expect(await authzStore.getRoles(f.target.userId)).toEqual(["finance"]);
  });

  it("an inactive line keeps the same fail-closed gate", async () => {
    const f = await fixture();
    await ensureRoleApprovalLine(false);
    const res = await app.request(`/api/users/${f.target.userId}/roles`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: await f.cookieFor(f.admin) },
      body: JSON.stringify({ role: "finance" }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden", code: "owner_approval_required" });
    expect(await pendingRequestFor(f.target.userId)).toBeUndefined();
  });

  it("admin grant of a high-privilege role becomes an approval request, not a grant (#221 slice 2)", async () => {
    const f = await fixture();
    await ensureRoleApprovalLine();
    const res = await app.request(`/api/users/${f.target.userId}/roles`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: await f.cookieFor(f.admin) },
      body: JSON.stringify({ role: "finance" }),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      role: string;
      granted: boolean;
      approval: { requestId: string };
    };
    expect(body.role).toBe("finance");
    expect(body.granted).toBe(false);

    // 角色未生效；请求在飞、payload 记录了变更内容
    expect(await authzStore.getRoles(f.target.userId)).toEqual([]);
    const request = await pendingRequestFor(f.target.userId);
    expect(request).toMatchObject({
      status: "pending",
      payload: { action: "grant", role: "finance" },
    });

    // 提交审计：谁、给谁、提了什么（R-16-6「所有权限变更留审计」的申请侧）
    const submitted = await db
      .select({ actor: schema.auditEvents.actor, detail: schema.auditEvents.detail })
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.action, "approval.requested"));
    expect(submitted).toHaveLength(1);
    expect(must(submitted[0]).actor).toBe(f.admin.userId);
    expect(must(submitted[0]).detail).toMatchObject({
      subjectType: ROLE_APPROVAL_SUBJECT_TYPE,
      subjectId: f.target.userId,
      configKey: ROLE_APPROVAL_CONFIG_KEY,
      payload: { action: "grant", role: "finance" },
    });
  });

  it("owner approval makes the grant take effect in the same stroke, with the audit trail", async () => {
    const f = await fixture();
    await ensureRoleApprovalLine();
    const created = await app.request(`/api/users/${f.target.userId}/roles`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: await f.cookieFor(f.admin) },
      body: JSON.stringify({ role: "finance" }),
    });
    const requestId = ((await created.json()) as { approval: { requestId: string } }).approval
      .requestId;

    // 审批详情：老板（点名审批人）与目标用户看得见、带 payload；不相干的销售 404
    const ownerView = await app.request(`/api/approval-requests/${requestId}`, {
      headers: { cookie: await f.cookieFor(f.owner) },
    });
    expect(ownerView.status).toBe(200);
    const viewBody = (await ownerView.json()) as {
      request: { status: string; payload: unknown; currentLevel: { roles: string[] } | null };
    };
    expect(viewBody.request.status).toBe("pending");
    expect(viewBody.request.payload).toEqual({ action: "grant", role: "finance" });
    expect(viewBody.request.currentLevel).toMatchObject({ roles: ["owner"] });
    const targetView = await app.request(`/api/approval-requests/${requestId}`, {
      headers: { cookie: await f.cookieFor(f.target) },
    });
    expect(targetView.status).toBe(200);
    const salesView = await app.request(`/api/approval-requests/${requestId}`, {
      headers: { cookie: await f.cookieFor(f.sales) },
    });
    expect(salesView.status).toBe(404);

    // 老板终审批准：批准即生效（同一笔提交里角色生效 + 审计 + 发起人通知）
    const approved = await app.request(`/api/approval-requests/${requestId}/actions`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: await f.cookieFor(f.owner) },
      body: JSON.stringify({ decision: "approved" }),
    });
    expect(approved.status).toBe(200);
    expect(((await approved.json()) as { requestStatus: string }).requestStatus).toBe("approved");

    expect(await authzStore.getRoles(f.target.userId)).toEqual(["finance"]);
    const rows = await auditRows(f.target.userId);
    expect(rows).toEqual([
      {
        action: "role.granted",
        actor: f.owner.userId,
        detail: {
          role: "finance",
          via: "approval",
          requestId,
          submittedBy: f.admin.userId,
        },
      },
    ]);
    const notifications = await db
      .select({ eventType: schema.notifications.eventType })
      .from(schema.notifications)
      .where(eq(schema.notifications.userId, f.admin.userId));
    expect(notifications).toEqual([{ eventType: "approval.completed" }]);
  });

  it("owner rejection leaves the role ungranted, notifies the submitter, resubmission opens a new request", async () => {
    const f = await fixture();
    await ensureRoleApprovalLine();
    const created = await app.request(`/api/users/${f.target.userId}/roles`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: await f.cookieFor(f.admin) },
      body: JSON.stringify({ role: "admin" }),
    });
    const firstId = ((await created.json()) as { approval: { requestId: string } }).approval
      .requestId;

    const rejected = await app.request(`/api/approval-requests/${firstId}/actions`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: await f.cookieFor(f.owner) },
      body: JSON.stringify({ decision: "rejected", note: "not yet" }),
    });
    expect(rejected.status).toBe(200);
    expect(await authzStore.getRoles(f.target.userId)).toEqual([]);
    expect(await auditRows(f.target.userId)).toEqual([]);

    const notifications = await db
      .select({ eventType: schema.notifications.eventType })
      .from(schema.notifications)
      .where(eq(schema.notifications.userId, f.admin.userId));
    expect(notifications).toEqual([{ eventType: "approval.rejected" }]);

    // 驳回是终态：重新提交 = 新请求
    const again = await app.request(`/api/users/${f.target.userId}/roles`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: await f.cookieFor(f.admin) },
      body: JSON.stringify({ role: "admin" }),
    });
    expect(again.status).toBe(202);
    const againId = ((await again.json()) as { approval: { requestId: string } }).approval.requestId;
    expect(againId).not.toBe(firstId);
  });

  it("a second grant while one request is pending answers 409 with the pending id", async () => {
    const f = await fixture();
    await ensureRoleApprovalLine();
    const first = await app.request(`/api/users/${f.target.userId}/roles`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: await f.cookieFor(f.admin) },
      body: JSON.stringify({ role: "finance" }),
    });
    expect(first.status).toBe(202);
    const firstId = ((await first.json()) as { approval: { requestId: string } }).approval.requestId;

    const second = await app.request(`/api/users/${f.target.userId}/roles`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: await f.cookieFor(f.admin) },
      body: JSON.stringify({ role: "finance" }),
    });
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({
      error: "conflict",
      code: "owner_approval_pending",
      requestId: firstId,
    });
  });

  it("granting an already-held high-privilege role is a no-op without an approval request", async () => {
    const f = await fixture();
    await ensureRoleApprovalLine();
    await seedRole(f.target.userId, "finance");
    const res = await app.request(`/api/users/${f.target.userId}/roles`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: await f.cookieFor(f.admin) },
      body: JSON.stringify({ role: "finance" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ role: "finance", granted: false });
    expect(await pendingRequestFor(f.target.userId)).toBeUndefined();
    expect(await auditRows(f.target.userId)).toEqual([]);
  });

  it("owner grants a high-privilege role directly even with the line configured (R-16-5)", async () => {
    const f = await fixture();
    await ensureRoleApprovalLine();
    const res = await app.request(`/api/users/${f.target.userId}/roles`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: await f.cookieFor(f.owner) },
      body: JSON.stringify({ role: "finance" }),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ role: "finance", granted: true });
    expect(await pendingRequestFor(f.target.userId)).toBeUndefined();
    expect(await auditRows(f.target.userId)).toEqual([
      { action: "role.granted", actor: f.owner.userId, detail: { role: "finance" } },
    ]);
  });

  it("revoking a high-privilege role rides the same approval line", async () => {
    const f = await fixture();
    await ensureRoleApprovalLine();
    await seedRole(f.target.userId, "finance");
    const res = await app.request(`/api/users/${f.target.userId}/roles/finance`, {
      method: "DELETE",
      headers: { cookie: await f.cookieFor(f.admin) },
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      role: string;
      revoked: boolean;
      approval: { requestId: string };
    };
    expect(body).toMatchObject({ role: "finance", revoked: false });
    expect(await pendingRequestFor(f.target.userId)).toMatchObject({
      status: "pending",
      payload: { action: "revoke", role: "finance" },
    });

    const requestId = body.approval.requestId;
    const approved = await app.request(`/api/approval-requests/${requestId}/actions`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: await f.cookieFor(f.owner) },
      body: JSON.stringify({ decision: "approved" }),
    });
    expect(approved.status).toBe(200);
    expect(await authzStore.getRoles(f.target.userId)).toEqual([]);
    expect(await auditRows(f.target.userId)).toEqual([
      {
        action: "role.revoked",
        actor: f.owner.userId,
        detail: {
          role: "finance",
          via: "approval",
          requestId,
          submittedBy: f.admin.userId,
        },
      },
    ]);
  });

  it("revoking a not-held high-privilege role is a no-op without an approval request", async () => {
    const f = await fixture();
    await ensureRoleApprovalLine();
    const res = await app.request(`/api/users/${f.target.userId}/roles/finance`, {
      method: "DELETE",
      headers: { cookie: await f.cookieFor(f.admin) },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ role: "finance", revoked: false });
    expect(await pendingRequestFor(f.target.userId)).toBeUndefined();
    expect(await auditRows(f.target.userId)).toEqual([]);
  });

  // ── 审批路线决策表（#221 决策表进线 × #233 decision_table）─────────────────────
  // 「进哪条线」由注册表 approval.routing.user_role（0023 种子：grant/revoke →
  // role_grant）裁决。这里直写注册表行来改路线（写面 PATCH 契约在 rules.test.ts）。
  const seededRoutingTable = {
    hitPolicy: "first",
    inputs: [{ id: "in_action", field: "action", name: "Action" }],
    outputs: [{ id: "out_config", field: "configKey", name: "Approval line" }],
    rules: [
      { _id: "r-grant", in_action: "== 'grant'", out_config: "'role_grant'" },
      { _id: "r-revoke", in_action: "== 'revoke'", out_config: "'role_grant'" },
    ],
  } as const;

  async function setRoutingTable(value: unknown): Promise<void> {
    await db
      .update(schema.registryRules)
      .set({ value, scheduledValue: null, scheduledEffectiveAt: null })
      .where(eq(schema.registryRules.key, "approval.routing.user_role"));
  }

  it("seeded routing table sends revokes to the same line as grants (seed ≡ pre-table behavior)", async () => {
    const f = await fixture();
    await seedRole(f.target.userId, "finance");
    await ensureRoleApprovalLine();
    const res = await app.request(`/api/users/${f.target.userId}/roles/finance`, {
      method: "DELETE",
      headers: { cookie: await f.cookieFor(f.admin) },
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ role: "finance", revoked: false });
    expect(await pendingRequestFor(f.target.userId)).toMatchObject({
      status: "pending",
      payload: { action: "revoke", role: "finance" },
    });
    // 撤销回到原样 = 无可确认变更，不进线
  });

  it("the routing table decides which line a change enters; unrouted lines fail closed (#233)", async () => {
    const f = await fixture();
    await ensureRoleApprovalLine();
    await seedRole(f.target.userId, "finance");
    // 撤销改道到一条不存在的线：路由命中 ≠ 放行——线不存在仍是 403（与线缺失
    // 同一落点），且不产生审批请求
    await setRoutingTable({
      ...seededRoutingTable,
      rules: [
        { _id: "r-grant", in_action: "== 'grant'", out_config: "'role_grant'" },
        { _id: "r-revoke", in_action: "== 'revoke'", out_config: "'escrow_line'" },
      ],
    });
    const denied = await app.request(`/api/users/${f.target.userId}/roles/finance`, {
      method: "DELETE",
      headers: { cookie: await f.cookieFor(f.admin) },
    });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: "forbidden", code: "owner_approval_required" });
    expect(await authzStore.getRoles(f.target.userId)).toEqual(["finance"]);
    expect(await pendingRequestFor(f.target.userId)).toBeUndefined();
    expect(await auditRows(f.target.userId)).toEqual([]);
    // 授予仍走种子线：同一条路由表逐行动裁（admin 是目标未持有的高权角色）
    const granted = await app.request(`/api/users/${f.target.userId}/roles`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: await f.cookieFor(f.admin) },
      body: JSON.stringify({ role: "admin" }),
    });
    expect(granted.status).toBe(202);
    const rows = await db
      .select({ payload: schema.approvalRequests.payload })
      .from(schema.approvalRequests)
      .where(eq(schema.approvalRequests.subjectId, f.target.userId));
    expect(must(rows[0]).payload).toEqual({ action: "grant", role: "admin" });
  });

  it("an emptied routing table fails closed for non-owners while the owner stays direct (#233)", async () => {
    const f = await fixture();
    await ensureRoleApprovalLine();
    await setRoutingTable({ ...seededRoutingTable, rules: [] });
    const denied = await app.request(`/api/users/${f.target.userId}/roles`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: await f.cookieFor(f.admin) },
      body: JSON.stringify({ role: "finance" }),
    });
    expect(denied.status).toBe(403);
    expect(await pendingRequestFor(f.target.userId)).toBeUndefined();
    expect(await auditRows(f.target.userId)).toEqual([]);
    // owner 直通不查路由表（R-16-5）：空表只关非 owner 的门
    const direct = await app.request(`/api/users/${f.target.userId}/roles`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: await f.cookieFor(f.owner) },
      body: JSON.stringify({ role: "finance" }),
    });
    expect(direct.status).toBe(201);
    expect(await authzStore.getRoles(f.target.userId)).toEqual(["finance"]);
  });

  it("the generic approval submit endpoint refuses payload-less requests on outcome subjects", async () => {
    const f = await fixture();
    await ensureRoleApprovalLine();
    // admin 是 user_role 的可见者（roles.assign 持有者），可见性门放行；内核按
    // 「带 outcome 自动化的 subject 必须带 payload」拒 422——无参数死请求进不了
    // 在飞位，角色变更的唯一提交路径是本路由
    const res = await app.request("/api/approval-requests", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: await f.cookieFor(f.admin) },
      body: JSON.stringify({
        subjectType: ROLE_APPROVAL_SUBJECT_TYPE,
        subjectId: f.target.userId,
        configKey: ROLE_APPROVAL_CONFIG_KEY,
      }),
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "payload_required" });
  });

  it("users without roles.assign get 403 permission_required on every endpoint", async () => {
    const f = await fixture();
    for (const actor of [f.sales, f.plain]) {
      const cookie = await f.cookieFor(actor);
      const list = await app.request(`/api/users/${f.target.userId}/roles`, { headers: { cookie } });
      expect(list.status).toBe(403);
      const grant = await app.request(`/api/users/${f.target.userId}/roles`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ role: "sales" }),
      });
      expect(grant.status).toBe(403);
      const revoke = await app.request(`/api/users/${f.target.userId}/roles/sales`, {
        method: "DELETE",
        headers: { cookie },
      });
      expect(revoke.status).toBe(403);
    }
    expect(await auditRows(f.target.userId)).toEqual([]);
  });

  it("owner revokes a role; audit records it; revoking again is a no-op without audit", async () => {
    const f = await fixture();
    await seedRole(f.target.userId, "warehouse");
    const ownerCookie = await f.cookieFor(f.owner);
    const res = await app.request(`/api/users/${f.target.userId}/roles/warehouse`, {
      method: "DELETE",
      headers: { cookie: ownerCookie },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ role: "warehouse", revoked: true });
    expect(await authzStore.getRoles(f.target.userId)).toEqual([]);

    const again = await app.request(`/api/users/${f.target.userId}/roles/warehouse`, {
      method: "DELETE",
      headers: { cookie: ownerCookie },
    });
    expect(await again.json()).toEqual({ role: "warehouse", revoked: false });

    const rows = await auditRows(f.target.userId);
    expect(rows).toEqual([
      { action: "role.revoked", actor: f.owner.userId, detail: { role: "warehouse" } },
    ]);
  });

  it("admin can list roles but revoking finance needs the owner (same gate as granting)", async () => {
    const f = await fixture();
    await seedRole(f.target.userId, "finance");
    const adminCookie = await f.cookieFor(f.admin);
    const list = await app.request(`/api/users/${f.target.userId}/roles`, {
      headers: { cookie: adminCookie },
    });
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ roles: ["finance"], permissions: [] });

    const denied = await app.request(`/api/users/${f.target.userId}/roles/finance`, {
      method: "DELETE",
      headers: { cookie: adminCookie },
    });
    expect(denied.status).toBe(403);
    expect(await authzStore.getRoles(f.target.userId)).toEqual(["finance"]);
  });

  it("unknown target user answers 404; invalid role answers 400", async () => {
    const f = await fixture();
    const adminCookie = await f.cookieFor(f.admin);
    const missingId = randomUUID();
    const missingList = await app.request(`/api/users/${missingId}/roles`, {
      headers: { cookie: adminCookie },
    });
    expect(missingList.status).toBe(404);
    const missingGrant = await app.request(`/api/users/${missingId}/roles`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: adminCookie },
      body: JSON.stringify({ role: "sales" }),
    });
    expect(missingGrant.status).toBe(404);

    const badBody = await app.request(`/api/users/${f.target.userId}/roles`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: adminCookie },
      body: JSON.stringify({ role: "super_admin" }),
    });
    expect(badBody.status).toBe(400);
    const badParam = await app.request(`/api/users/${f.target.userId}/roles/super_admin`, {
      method: "DELETE",
      headers: { cookie: adminCookie },
    });
    expect(badParam.status).toBe(400);
  });

  it("deleting a user cascades their roles away (user_role FK)", async () => {
    const f = await fixture();
    await seedRole(f.target.userId, "sales");
    await db.delete(schema.authUser).where(eq(schema.authUser.id, f.target.userId));
    const roles = await db
      .select()
      .from(schema.userRole)
      .where(eq(schema.userRole.userId, f.target.userId));
    expect(roles).toEqual([]);
  });
});

function adminUrl(databaseUrl: string | undefined): string {
  if (databaseUrl === undefined) return "";
  const url = new URL(databaseUrl);
  url.pathname = "/postgres";
  return url.toString();
}
