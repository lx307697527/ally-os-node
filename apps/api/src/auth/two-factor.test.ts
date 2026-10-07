import { randomUUID } from "node:crypto";
import { symmetricDecrypt } from "better-auth/crypto";
import { eq } from "drizzle-orm";
import pino from "pino";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb, runMigrations, schema } from "@ally/db";
import { createApp } from "../app.ts";
import type { MailMessage } from "@ally/mailer";
import { createAuth, createSessionResolver } from "./auth.ts";
import { createAuthzStore } from "../authz/service.ts";

// 集成测试（#24 验收：启用、校验、备份码登录、关闭都有测试；外加强制门）。
// 走真实 Better Auth（two-factor 插件）+ 真实 PostgreSQL；未设 DATABASE_URL 跳过。
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

describe.skipIf(!databaseUrl)("auth: two-factor (#24, integration)", () => {
  const { db, pool } = createDb(databaseUrl ?? "");
  const mailer = spyMailer();
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
    // 本套件不 exercise 附件端点；真被调到会在这里大声炸（AppDeps.storage 必选）
    storage: {
      put: () => Promise.reject(new Error("storage not used in this suite")),
      signedGetUrl: () => Promise.reject(new Error("storage not used in this suite")),
      signedPutUrl: () => Promise.reject(new Error("storage not used in this suite")),
      delete: () => Promise.reject(new Error("storage not used in this suite")),
    },
    authzStore: createAuthzStore(db),
  
    notifyUsers: async () => {},});

  const createdUserIds: string[] = [];

  beforeAll(async () => {
    await runMigrations(db);
  });

  afterEach(async () => {
    for (const id of createdUserIds.splice(0)) {
      await db.delete(schema.authUser).where(eq(schema.authUser.id, id));
    }
  });

  afterAll(async () => {
    await pool.end();
  });

  async function signUpVerified(): Promise<{ userId: string; email: string }> {
    const email = `${randomUUID()}@example.com`;
    const res = await app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: PASSWORD, name: "Test User" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user?: { id?: string } };
    const userId = must(body.user?.id);
    createdUserIds.push(userId);
    const message = must(mailer.sent[mailer.sent.length - 1]);
    const token = must(/token=([^"&\s<]+)/.exec(message.html)?.[1]);
    const confirm = await app.request(`/api/auth/verify-email?token=${encodeURIComponent(token)}`);
    expect(confirm.status).toBe(200);
    return { userId, email };
  }

  async function signIn(email: string, password: string): Promise<Response> {
    return app.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
  }

  function cookiesNamed(res: Response, prefix: string): string[] {
    return res.headers.getSetCookie().filter((c) => c.startsWith(prefix)).map((c) => must(c.split(";")[0]));
  }

  function sessionCookie(res: Response): string {
    return must(cookiesNamed(res, "better-auth.session_token=")[0]);
  }

  function twoFactorCookie(res: Response): string {
    return must(cookiesNamed(res, "better-auth.two_factor=")[0]);
  }

  /**
   * 给已验证用户绑 2FA：enable → 取原始密钥 → 生成真码 → verify。
   *
   * 密钥来源是库里那行密文（better-auth/crypto 用同一把 BETTER_AUTH_SECRET
   * 解开）：createOTP 直接用原始 secret 字符串做 HMAC，URI 里的 base32 只是
   * 认证器应用的传输编码——用 base32 串生成码永远 INVALID_CODE（第一轮跑挂
   * 的根因）。真实认证器等价物 = base32 解码回原字节，即这里解出的明文。
   */
  async function enrollTotp(userId: string, email: string): Promise<{ secret: string; backupCodes: string[]; session: string }> {
    const signInRes = await signIn(email, PASSWORD);
    expect(signInRes.status).toBe(200);
    const session = sessionCookie(signInRes);

    const enable = await app.request("/api/auth/two-factor/enable", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: session },
      body: JSON.stringify({ password: PASSWORD, method: "totp" }),
    });
    expect(enable.status).toBe(200);
    const enabled = (await enable.json()) as { totpURI?: string; backupCodes?: string[] };
    const uri = must(enabled.totpURI);
    expect(uri).toMatch(/^otpauth:\/\/totp\//);
    expect(uri).toContain("issuer=Ally+OS");
    const backupCodes = must(enabled.backupCodes);

    const rows = await db
      .select()
      .from(schema.authTwoFactor)
      .where(eq(schema.authTwoFactor.userId, userId));
    const secret = await symmetricDecrypt({
      key: SECRET,
      data: must(rows[0]?.secret),
    });

    const code = await generateTotpCode(secret);
    const verify = await app.request("/api/auth/two-factor/verify-totp", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: session },
      body: JSON.stringify({ code }),
    });
    expect(verify.status).toBe(200);
    // 完成绑定时 better-auth 换发会话（旧会话当场作废）：后续调用必须带新 cookie
    const rotated = cookiesNamed(verify, "better-auth.session_token=")[0];
    return { secret, backupCodes, session: rotated ?? session };
  }

  /** 用 better-auth 自己的 TOTP 实现生成当前码（测试不引入第二套实现） */
  async function generateTotpCode(secret: string): Promise<string> {
    const result = await auth.api.generateTOTP({ body: { secret } });
    return must(result.code);
  }

  it("enable returns an otpauth URI (issuer Ally OS) and ten backup codes; enabling alone does not turn 2FA on", async () => {
    const { userId, email } = await signUpVerified();
    const signInRes = await signIn(email, PASSWORD);
    const session = sessionCookie(signInRes);

    const enable = await app.request("/api/auth/two-factor/enable", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: session },
      body: JSON.stringify({ password: PASSWORD, method: "totp" }),
    });
    expect(enable.status).toBe(200);
    const enabled = (await enable.json()) as { totpURI?: string; backupCodes?: string[] };
    expect(enabled.totpURI).toMatch(/^otpauth:\/\/totp\//);
    expect(must(enabled.backupCodes)).toHaveLength(10);

    // 校验完成前不算启用：user 标志仍是 false，因子行 verified=false（半成品）
    const me = await app.request("/api/me", { headers: { cookie: session } });
    const meBody = (await me.json()) as { user: { twoFactorEnabled: boolean } };
    expect(meBody.user.twoFactorEnabled).toBe(false);
    const rows = await db
      .select()
      .from(schema.authTwoFactor)
      .where(eq(schema.authTwoFactor.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.verified).toBe(false);
  });

  it("enable requires the account password", async () => {
    const { email } = await signUpVerified();
    const session = sessionCookie(await signIn(email, PASSWORD));
    const res = await app.request("/api/auth/two-factor/enable", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: session },
      body: JSON.stringify({ method: "totp" }),
    });
    expect(res.status).toBe(400);
  });

  it("verifying a real code completes enrollment: flag on, factor verified, wrong code rejected", async () => {
    const { userId, email } = await signUpVerified();
    const { secret, session } = await enrollTotp(userId, email);

    const me = await app.request("/api/me", { headers: { cookie: session } });
    const meBody = (await me.json()) as { user: { twoFactorEnabled: boolean } };
    expect(meBody.user.twoFactorEnabled).toBe(true);

    const rows = await db
      .select()
      .from(schema.authTwoFactor)
      .where(eq(schema.authTwoFactor.userId, userId));
    expect(rows[0]?.verified).toBe(true);
    expect(rows[0]?.secret).not.toBe(secret); // 落库是密文，不是共享密钥明文

    // 已验证后重复 enable 是明确的 400（TOTP_ALREADY_ENABLED），不是静默重置
    const again = await app.request("/api/auth/two-factor/enable", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: session },
      body: JSON.stringify({ password: PASSWORD, method: "totp" }),
    });
    expect(again.status).toBe(400);
    expect(((await again.json()) as { code?: string }).code).toBe("TOTP_ALREADY_ENABLED");
  });

  it("an enrollment abandoned before verification can be restarted with a fresh secret", async () => {
    const { userId, email } = await signUpVerified();
    const signInRes = await signIn(email, PASSWORD);
    const session = sessionCookie(signInRes);

    const first = await app.request("/api/auth/two-factor/enable", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: session },
      body: JSON.stringify({ password: PASSWORD, method: "totp" }),
    });
    expect(first.status).toBe(200);

    const second = await app.request("/api/auth/two-factor/enable", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: session },
      body: JSON.stringify({ password: PASSWORD, method: "totp" }),
    });
    expect(second.status).toBe(200);

    const rows = await db
      .select()
      .from(schema.authTwoFactor)
      .where(eq(schema.authTwoFactor.userId, userId));
    expect(rows).toHaveLength(1); // 覆写同一行，不堆积半成品
  });

  it("sign-in with 2FA answers twoFactorRedirect, no session — then a real code signs in", async () => {
    const { userId, email } = await signUpVerified();
    const { secret } = await enrollTotp(userId, email);

    const challenge = await signIn(email, PASSWORD);
    expect(challenge.status).toBe(200);
    const body = (await challenge.json()) as { twoFactorRedirect?: boolean; twoFactorMethods?: string[] };
    expect(body.twoFactorRedirect).toBe(true);
    expect(body.twoFactorMethods).toEqual(["totp"]);
    // 密码对了也不发会话 cookie——挑战期唯一的凭证是 10 分钟的 two-factor
    // cookie（响应里只有一条用于清除旧 cookie 的过期空值，不算数）
    const issued = cookiesNamed(challenge, "better-auth.session_token=").filter(
      (c) => c.split("=")[1] !== "" && !c.includes("Expires=Thu, 01 Jan 1970"),
    );
    expect(issued).toHaveLength(0);
    const challengeCookie = twoFactorCookie(challenge);

    // 挑战 cookie 不是会话：业务路由仍然 401
    const meDuringChallenge = await app.request("/api/me", { headers: { cookie: challengeCookie } });
    expect(meDuringChallenge.status).toBe(401);

    const code = await generateTotpCode(secret);
    const verify = await app.request("/api/auth/two-factor/verify-totp", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: challengeCookie },
      body: JSON.stringify({ code }),
    });
    expect(verify.status).toBe(200);
    const session = sessionCookie(verify);

    const me = await app.request("/api/me", { headers: { cookie: session } });
    expect(me.status).toBe(200);
    expect(((await me.json()) as { user: { twoFactorEnabled: boolean } }).user.twoFactorEnabled).toBe(true);
  });

  it("a wrong code at the challenge is rejected and does not yield a session", async () => {
    const { userId, email } = await signUpVerified();
    await enrollTotp(userId, email);

    const challenge = await signIn(email, PASSWORD);
    const challengeCookie = twoFactorCookie(challenge);
    const verify = await app.request("/api/auth/two-factor/verify-totp", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: challengeCookie },
      body: JSON.stringify({ code: "000000" }),
    });
    expect(verify.status).toBe(401);
    expect(((await verify.json()) as { code?: string }).code).toBe("INVALID_CODE");
  });

  it("a backup code signs in once and is burned; other codes still work", async () => {
    const { userId, email } = await signUpVerified();
    const { backupCodes } = await enrollTotp(userId, email);
    const [first, second] = backupCodes;

    const challenge = await signIn(email, PASSWORD);
    const challengeCookie = twoFactorCookie(challenge);

    const spent = await app.request("/api/auth/two-factor/verify-backup-code", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: challengeCookie },
      body: JSON.stringify({ code: must(first) }),
    });
    expect(spent.status).toBe(200);
    const session = sessionCookie(spent);
    const me = await app.request("/api/me", { headers: { cookie: session } });
    expect(me.status).toBe(200);

    // 用过的码不能再登（且挑战 cookie 已消费，重放连同码一起无效）
    const replay = await signIn(email, PASSWORD);
    const replayCookie = twoFactorCookie(replay);
    const again = await app.request("/api/auth/two-factor/verify-backup-code", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: replayCookie },
      body: JSON.stringify({ code: must(first) }),
    });
    expect(again.status).toBe(401);

    // 没用过的码仍然可用
    const fresh = await app.request("/api/auth/two-factor/verify-backup-code", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: replayCookie },
      body: JSON.stringify({ code: must(second) }),
    });
    expect(fresh.status).toBe(200);
  });

  it("disable (with password) turns 2FA off and the next sign-in is a plain session", async () => {
    const { userId, email } = await signUpVerified();
    const { session } = await enrollTotp(userId, email);

    const disable = await app.request("/api/auth/two-factor/disable", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: session },
      body: JSON.stringify({ password: PASSWORD }),
    });
    expect(disable.status).toBe(200);

    const rows = await db
      .select()
      .from(schema.authTwoFactor)
      .where(eq(schema.authTwoFactor.userId, userId));
    expect(rows).toHaveLength(0);

    const plain = await signIn(email, PASSWORD);
    expect(plain.status).toBe(200);
    const body = (await plain.json()) as { twoFactorRedirect?: boolean };
    expect(body.twoFactorRedirect).toBeUndefined();
    const me = await app.request("/api/me", { headers: { cookie: sessionCookie(plain) } });
    expect(((await me.json()) as { user: { twoFactorEnabled: boolean } }).user.twoFactorEnabled).toBe(false);
  });

  it("disable requires the account password", async () => {
    const { userId, email } = await signUpVerified();
    const { session } = await enrollTotp(userId, email);
    const disable = await app.request("/api/auth/two-factor/disable", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: session },
      body: JSON.stringify({}),
    });
    expect(disable.status).toBe(400);
  });

  it("regenerating backup codes issues a fresh batch", async () => {
    const { userId, email } = await signUpVerified();
    const { backupCodes, session } = await enrollTotp(userId, email);

    const regen = await app.request("/api/auth/two-factor/generate-backup-codes", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: session },
      body: JSON.stringify({ password: PASSWORD }),
    });
    expect(regen.status).toBe(200);
    const fresh = ((await regen.json()) as { backupCodes?: string[] }).backupCodes;
    expect(fresh).toHaveLength(10);
    // 新批次与旧批次无交集（旧码全作废）
    expect(must(fresh).filter((c) => backupCodes.includes(c))).toHaveLength(0);
  });

  // ---- 强制门（#232 §12：管理员强制启用）----

  async function grantAdmin(userId: string): Promise<void> {
    await db.insert(schema.userRole).values({ userId, role: "admin" });
  }

  it("an admin without 2FA reads /api/me but is blocked on business routes with two_factor_required", async () => {
    const { userId, email } = await signUpVerified();
    await grantAdmin(userId);
    const session = sessionCookie(await signIn(email, PASSWORD));

    // /api/me 刻意豁免：未绑定的人靠它得知状态（roles + twoFactorEnabled）
    const me = await app.request("/api/me", { headers: { cookie: session } });
    expect(me.status).toBe(200);
    const meBody = (await me.json()) as {
      user: { twoFactorEnabled: boolean };
      authz: { roles: string[] };
    };
    expect(meBody.authz.roles).toContain("admin");
    expect(meBody.user.twoFactorEnabled).toBe(false);

    // 有 roles.assign（admin 默认集）的业务路由：先撞 2FA 门，而不是放行或 RBAC 拒绝
    const blocked = await app.request(`/api/users/${userId}/roles`, {
      headers: { cookie: session },
    });
    expect(blocked.status).toBe(403);
    expect((await blocked.json()) as { code?: string }).toEqual({
      error: "forbidden",
      code: "two_factor_required",
    });
  });

  it("after enrollment the same admin request passes the 2FA gate (RBAC decides from there)", async () => {
    const { userId, email } = await signUpVerified();
    await grantAdmin(userId);
    const { secret } = await enrollTotp(userId, email);

    const challenge = await signIn(email, PASSWORD);
    const code = await generateTotpCode(secret);
    const verify = await app.request("/api/auth/two-factor/verify-totp", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: twoFactorCookie(challenge) },
      body: JSON.stringify({ code }),
    });
    expect(verify.status).toBe(200);
    const session = sessionCookie(verify);

    const allowed = await app.request(`/api/users/${userId}/roles`, {
      headers: { cookie: session },
    });
    expect(allowed.status).toBe(200); // 门已过：正常走 RBAC 与路由逻辑
  });

  it("a non-admin without 2FA is not stopped by the gate", async () => {
    const { userId, email } = await signUpVerified();
    await db.insert(schema.userRole).values({ userId, role: "sales" });
    const session = sessionCookie(await signIn(email, PASSWORD));

    // sales 没有 roles.assign：若 2FA 门错拦会得到 403 two_factor_required，
    // 正确结果是门放行、由 RBAC 答 403 permission_required
    const res = await app.request(`/api/users/${userId}/roles`, {
      headers: { cookie: session },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code?: string }).code).toBe("permission_required");
  });

  it("disabling 2FA puts the admin right back behind the gate (enforcement is self-healing)", async () => {
    const { userId, email } = await signUpVerified();
    await grantAdmin(userId);
    const { session } = await enrollTotp(userId, email);

    const disable = await app.request("/api/auth/two-factor/disable", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: session },
      body: JSON.stringify({ password: PASSWORD }),
    });
    expect(disable.status).toBe(200);

    // disable 的响应刷新了会话 cookie（better-auth 换发），用最新的
    const freshSession = cookiesNamed(disable, "better-auth.session_token=")[0] ?? session;
    const blocked = await app.request(`/api/users/${userId}/roles`, {
      headers: { cookie: freshSession },
    });
    expect(blocked.status).toBe(403);
    expect(((await blocked.json()) as { code?: string }).code).toBe("two_factor_required");
  });

  it("the two-factor row is keyed by user and cascade-deleted with the account", async () => {
    const { userId, email } = await signUpVerified();
    await enrollTotp(userId, email);
    let rows = await db
      .select()
      .from(schema.authTwoFactor)
      .where(eq(schema.authTwoFactor.userId, userId));
    expect(rows).toHaveLength(1);

    await db.delete(schema.authUser).where(eq(schema.authUser.id, userId));
    rows = await db
      .select()
      .from(schema.authTwoFactor)
      .where(eq(schema.authTwoFactor.userId, userId));
    expect(rows).toHaveLength(0);
  });
});
