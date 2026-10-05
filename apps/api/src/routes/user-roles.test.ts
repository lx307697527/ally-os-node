import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import pino from "pino";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb, runMigrations, schema } from "@ally/db";
import { createApp } from "../app.ts";
import { createAuth, createSessionResolver } from "../auth/auth.ts";
import type { MailMessage } from "../mailer/mailer.ts";
import { createAuthzStore } from "../authz/service.ts";
import type { Role } from "../authz/permissions.ts";

// 集成测试：需要真实 PostgreSQL（角色管理端点写 user_role + audit_events）。
// 未设 DATABASE_URL 时跳过。
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

describe.skipIf(!databaseUrl)("user roles routes (#23, integration)", () => {
  const { db, pool } = createDb(databaseUrl ?? "");
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
    logger,
    db,
    corsOrigins: ["http://localhost:5173"],
    checkDatabase: async () => {
      await pool.query("select 1");
    },
    authHandler: (request) => auth.handler(request),
    resolveSession: createSessionResolver(auth),
    socialProviders: [],
    authzStore,
  });

  const createdUserIds: string[] = [];

  beforeAll(async () => {
    await runMigrations(db);
  });

  afterEach(async () => {
    // 审计行没有外键，指向已删用户也只是历史记录；测试自清理，不留跨运行垃圾
    if (createdUserIds.length > 0) {
      await db
        .delete(schema.auditEvents)
        .where(inArray(schema.auditEvents.target, [...createdUserIds]));
    }
    for (const id of createdUserIds.splice(0)) {
      await db.delete(schema.authUser).where(eq(schema.authUser.id, id));
    }
  });

  afterAll(async () => {
    await pool.end();
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
    createdUserIds.push(userId);
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

  it("admin cannot grant owner-approval roles (R-16-6 gate), owner can", async () => {
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
