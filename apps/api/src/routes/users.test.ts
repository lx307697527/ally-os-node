import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, runMigrations, schema } from "@ally/db";
import type { MailMessage } from "@ally/mailer";
import { createApp } from "../app.ts";
import { createAuth, createSessionResolver } from "../auth/auth.ts";
import { createAuthzStore } from "../authz/service.ts";
import type { Role } from "../authz/permissions.ts";

// 集成测试：真实 PostgreSQL（用户/会话/审计都走库）。未设 DATABASE_URL 时跳过。
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

describe.skipIf(!databaseUrl)("user lifecycle routes (#26, integration)", () => {
  // 每文件一个临时库：用户行与角色授予跨用例保留（花名册断言按邮箱定位行，
  // 不数总数——套件先前的用例会留下用户），审计/通知每例清空
  const dbName = `users_test_${String(Date.now())}_${String(process.pid)}`;
  const adminUrl =
    databaseUrl === undefined
      ? ""
      : (() => {
          const url = new URL(databaseUrl);
          url.pathname = "/postgres";
          return url.toString();
        })();
  const adminPool = createDb(adminUrl);
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
  adminPool.pool.on("error", () => {});

  const mailer = spyMailer();
  const setupEmails: string[] = [];
  const auth = createAuth({
    db,
    secret: SECRET,
    trustedOrigins: ["http://localhost:5173"],
    baseURL: undefined,
    webAppUrl: undefined,
    googleOAuth: undefined,
    mailer,
    logger,
  });
  const authzStore = createAuthzStore(db);
  const app = createApp({
    stripe: undefined,
    sendPasswordSetupEmail: (email) => {
      setupEmails.push(email);
      return Promise.resolve();
    },
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
    // 审计与通知每例清空（TRUNCATE 单语句：append-only 触发器不拦 DDL）
    await db.execute(sql`truncate table ${schema.auditEvents}, ${schema.notifications}`);
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

  const cookieCache = new Map<string, string>();

  async function cookieFor(actor: Actor): Promise<string> {
    const cached = cookieCache.get(actor.userId);
    if (cached !== undefined) return cached;
    const res = await app.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: actor.email, password: PASSWORD }),
    });
    expect(res.status).toBe(200);
    const cookies = res.headers.getSetCookie().filter((c) =>
      c.startsWith("better-auth.session_token="),
    );
    const cookie = must(must(cookies[0]).split(";")[0]);
    cookieCache.set(actor.userId, cookie);
    return cookie;
  }

  async function seedRole(userId: string, role: Role): Promise<void> {
    await db.insert(schema.userRole).values({ userId, role }).onConflictDoNothing();
  }

  /** #24 起管理员过不了 2FA 强制门：夹具直接置位（绑定仪式在 two-factor.test.ts） */
  async function enableTwoFactor(userId: string): Promise<void> {
    await db.update(schema.authUser).set({ twoFactorEnabled: true }).where(eq(schema.authUser.id, userId));
  }

  /** 固定阵容：老板 / 管理员 / 销售 / 无角色 */
  async function fixture(): Promise<{
    owner: Actor;
    admin: Actor;
    sales: Actor;
    plain: Actor;
  }> {
    const owner = await signUpVerified();
    const admin = await signUpVerified();
    const sales = await signUpVerified();
    const plain = await signUpVerified();
    await seedRole(owner.userId, "owner");
    await seedRole(admin.userId, "admin");
    await seedRole(sales.userId, "sales");
    // #24 起带 twoFactorEnabled 的账号登录响应是 2FA 挑战,不再发会话 cookie。
    // 本文件测的是用户生命周期,不走绑定仪式:置位前先把 admin 的会话签出来。
    await cookieFor(admin);
    await enableTwoFactor(admin.userId);
    return { owner, admin, sales, plain };
  }

  function auditRows(action: string): Promise<{ actor: string | null; target: string | null; detail: Record<string, unknown> | null }[]> {
    return db
      .select({ actor: schema.auditEvents.actor, target: schema.auditEvents.target, detail: schema.auditEvents.detail })
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.action, action));
  }

  it("roster lists every account with aggregated roles and filters by status", async () => {
    const { owner, admin, sales, plain } = await fixture();
    const cookie = await cookieFor(owner);

    const all = await app.request("/api/users", { headers: { cookie } });
    expect(all.status).toBe(200);
    const allBody = (await all.json()) as {
      users: { id: string; email: string; roles: string[]; disabledAt: string | null }[];
      total: number;
    };
    expect(allBody.total).toBeGreaterThanOrEqual(4);
    const byEmail = (email: string) => allBody.users.find((u) => u.email === email);
    expect(byEmail(owner.email)?.roles).toContain("owner");
    expect(byEmail(admin.email)?.roles).toEqual(["admin"]);
    expect(byEmail(sales.email)?.roles).toEqual(["sales"]);
    expect(byEmail(plain.email)?.roles).toEqual([]);

    // 停用 plain 后：disabled 筛选只见它，active 筛选不再有它
    const disable = await app.request(`/api/users/${plain.userId}/disable`, { method: "POST", headers: { cookie } });
    expect(disable.status).toBe(200);
    const disabledList = await app.request("/api/users?status=disabled", { headers: { cookie } });
    const disabledBody = (await disabledList.json()) as { users: { email: string }[] };
    expect(disabledBody.users.some((u) => u.email === plain.email)).toBe(true);
    const activeList = await app.request("/api/users?status=active", { headers: { cookie } });
    const activeBody = (await activeList.json()) as { users: { email: string }[] };
    expect(activeBody.users.some((u) => u.email === plain.email)).toBe(false);
    expect(activeBody.users.some((u) => u.email === owner.email)).toBe(true);
  });

  it("the roster is behind users.manage: sales is 403, anonymous is 401", async () => {
    const { sales } = await fixture();
    const forbidden = await app.request("/api/users", { headers: { cookie: await cookieFor(sales) } });
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({ error: "forbidden", code: "permission_required" });
    const anonymous = await app.request("/api/users");
    expect(anonymous.status).toBe(401);
  });

  it("create invites a staff member: passwordless verified account, initial roles, audit, setup email", async () => {
    const { owner } = await fixture();
    const cookie = await cookieFor(owner);
    const email = `${randomUUID()}@example.com`;

    const res = await app.request("/api/users", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ email: `  ${email.toUpperCase()} `, name: "New Sales", roles: ["sales"] }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      user: { id: string; email: string; emailVerified: boolean };
      roles: string[];
      inviteRequested: boolean;
    };
    // 邮箱归一化（trim + lower，影子账号同一条规则）；emailVerified 预建 true
    // ——激活邮件本身发往该地址，地址在激活那一刻自证（老 staff-invite 的
    // email_confirm: true 同款）
    expect(body.user.email).toBe(email);
    expect(body.user.emailVerified).toBe(true);
    expect(body.roles).toEqual(["sales"]);
    expect(body.inviteRequested).toBe(true);
    expect(setupEmails).toContain(email);

    const created = await auditRows("user.created");
    expect(created).toHaveLength(1);
    expect(created[0]?.actor).toBe(owner.userId);
    expect(created[0]?.target).toBe(body.user.id);
    expect(created[0]?.detail).toMatchObject({ email, roles: ["sales"], invited: true });
    const grantRows = await auditRows("role.granted");
    expect(grantRows).toHaveLength(1);
    expect(grantRows[0]?.detail).toMatchObject({ role: "sales", via: "user_created" });
  });

  it("create refuses privileged roles, duplicate emails, bad input, unknown keys, and non-managers", async () => {
    const { owner, sales } = await fixture();
    const cookie = await cookieFor(owner);

    // 特权角色不在创建面——连 owner 本人也不能在建号请求里夹带（先建后授，
    // R-16-6 门才有「谁授的」可追溯动作）
    const privileged = await app.request("/api/users", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ email: `${randomUUID()}@example.com`, roles: ["owner"] }),
    });
    expect(privileged.status).toBe(400);

    const good = await app.request("/api/users", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ email: `${randomUUID()}@example.com` }),
    });
    expect(good.status).toBe(201);
    const goodBody = (await good.json()) as { user: { email: string; id: string } };

    const duplicate = await app.request("/api/users", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ email: goodBody.user.email }),
    });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({ error: "conflict", code: "user_exists", userId: goodBody.user.id });

    const badEmail = await app.request("/api/users", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ email: "not-an-email" }),
    });
    expect(badEmail.status).toBe(400);

    const unknownKey = await app.request("/api/users", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ email: `${randomUUID()}@example.com`, admin: true }),
    });
    expect(unknownKey.status).toBe(400);

    const forbidden = await app.request("/api/users", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: await cookieFor(sales) },
      body: JSON.stringify({ email: `${randomUUID()}@example.com` }),
    });
    expect(forbidden.status).toBe(403);
  });

  it("rename is audited from/to, idempotent on the same name, 404 on unknown ids, and gated", async () => {
    const { owner, sales } = await fixture();
    const cookie = await cookieFor(owner);

    const rename = await app.request(`/api/users/${sales.userId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "Renamed Sales" }),
    });
    expect(rename.status).toBe(200);
    const updates = await auditRows("user.updated");
    expect(updates).toHaveLength(1);
    expect(updates[0]?.detail).toMatchObject({ field: "name", from: "Test User", to: "Renamed Sales" });

    const again = await app.request(`/api/users/${sales.userId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "Renamed Sales" }),
    });
    expect(again.status).toBe(200);
    expect(await auditRows("user.updated")).toHaveLength(1);

    const garbage = await app.request("/api/users/not-a-uuid", {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "X" }),
    });
    expect(garbage.status).toBe(404);
    const unknown = await app.request(`/api/users/${randomUUID()}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "X" }),
    });
    expect(unknown.status).toBe(404);

    const forbidden = await app.request(`/api/users/${sales.userId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: await cookieFor(sales) },
      body: JSON.stringify({ name: "Self Rename" }),
    });
    expect(forbidden.status).toBe(403);
  });

  it("disable revokes live sessions, blocks sign-in, and is idempotent without duplicate audit", async () => {
    const { owner, sales } = await fixture();
    const ownerCookie = await cookieFor(owner);
    const salesCookie = await cookieFor(sales);
    expect((await app.request("/api/me", { headers: { cookie: salesCookie } })).status).toBe(200);

    const disable = await app.request(`/api/users/${sales.userId}/disable`, {
      method: "POST",
      headers: { cookie: ownerCookie },
    });
    expect(disable.status).toBe(200);
    expect(await disable.json()).toEqual({ disabled: true });

    // 旧会话当场失效（停用即全端登出，会话行与盖戳同事务）
    expect((await app.request("/api/me", { headers: { cookie: salesCookie } })).status).toBe(401);
    // 新登录被拒，答复说清去向
    const blocked = await app.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: sales.email, password: PASSWORD }),
    });
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toMatchObject({ code: "account_disabled" });

    expect(await auditRows("user.disabled")).toHaveLength(1);

    // 幂等：第二个停用者不产生第二行审计
    const repeat = await app.request(`/api/users/${sales.userId}/disable`, {
      method: "POST",
      headers: { cookie: ownerCookie },
    });
    expect(repeat.status).toBe(200);
    expect(await auditRows("user.disabled")).toHaveLength(1);
  });

  it("self-disable is refused and owner-role targets require the owner in both directions", async () => {
    const { owner, admin } = await fixture();
    const ownerCookie = await cookieFor(owner);
    const adminCookie = await cookieFor(admin);

    const self = await app.request(`/api/users/${owner.userId}/disable`, {
      method: "POST",
      headers: { cookie: ownerCookie },
    });
    expect(self.status).toBe(409);
    expect(await self.json()).toMatchObject({ error: "conflict", code: "self_disable" });

    // 管理员碰 owner 角色的账号：停用与启用都 403 owner_required（老板的账号
    // 只有老板能动）
    const adminDisable = await app.request(`/api/users/${owner.userId}/disable`, {
      method: "POST",
      headers: { cookie: adminCookie },
    });
    expect(adminDisable.status).toBe(403);
    expect(await adminDisable.json()).toMatchObject({ error: "forbidden", code: "owner_required" });
    const adminEnable = await app.request(`/api/users/${owner.userId}/enable`, {
      method: "POST",
      headers: { cookie: adminCookie },
    });
    expect(adminEnable.status).toBe(403);

    // owner 停另一个 owner 可行（自我停用已被挡，任何时刻至少剩操作者本人在职）
    const second = await signUpVerified();
    await seedRole(second.userId, "owner");
    const ownerDisable = await app.request(`/api/users/${second.userId}/disable`, {
      method: "POST",
      headers: { cookie: ownerCookie },
    });
    expect(ownerDisable.status).toBe(200);
    expect(await ownerDisable.json()).toEqual({ disabled: true });
  });

  it("enable restores sign-in and is audited", async () => {
    const { owner, sales } = await fixture();
    const ownerCookie = await cookieFor(owner);
    await app.request(`/api/users/${sales.userId}/disable`, { method: "POST", headers: { cookie: ownerCookie } });
    expect(
      (await app.request("/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: sales.email, password: PASSWORD }),
      })).status,
    ).toBe(403);

    const enable = await app.request(`/api/users/${sales.userId}/enable`, {
      method: "POST",
      headers: { cookie: ownerCookie },
    });
    expect(enable.status).toBe(200);
    expect(await enable.json()).toEqual({ disabled: false });

    expect(
      (await app.request("/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: sales.email, password: PASSWORD }),
      })).status,
    ).toBe(200);
    expect(await auditRows("user.enabled")).toHaveLength(1);
  });
});
