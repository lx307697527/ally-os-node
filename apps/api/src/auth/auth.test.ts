import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import pino from "pino";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb, runMigrations, schema } from "@ally/db";
import { createApp } from "../app.ts";
import type { MailMessage } from "@ally/mailer";
import { createAuth, createSessionResolver, createSessionTokenVerifier } from "./auth.ts";
import { ensureShadowAccount } from "./shadow-account.ts";
import { createAuthzStore } from "../authz/service.ts";

// 集成测试：需要真实 PostgreSQL（Better Auth 走库读写 user/session/account）。
// 未设 DATABASE_URL 时跳过。
const databaseUrl = process.env.DATABASE_URL;

const logger = pino({ level: "silent" });
const SECRET = "test-secret-0123456789abcdef0123456789abcdef";
const WEB_APP_URL = "https://admin.example";
const PASSWORD = "correct-horse-battery";

/** 测试里替代非空断言：取不到就直接失败 */
function must<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("unexpected missing value in test");
  return value;
}

/** 邮件 spy：记录每一封；可设置为下一封直接抛错（模拟 Resend 故障） */
function spyMailer() {
  const sent: MailMessage[] = [];
  let failNext = false;
  return {
    sent,
    failNext() {
      failNext = true;
    },
    async send(message: MailMessage): Promise<void> {
      await Promise.resolve();
      if (failNext) {
        failNext = false;
        throw new Error("resend send failed: HTTP 500 (simulated)");
      }
      sent.push(message);
    },
  };
}

describe.skipIf(!databaseUrl)("auth: credential login (#22, integration)", () => {
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

  /** 注册：响应 200、不建会话（FEAT-634），用户落库为未验证 */
  async function signUpUnverified(): Promise<{ userId: string; email: string }> {
    const email = `${randomUUID()}@example.com`;
    const res = await app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: PASSWORD, name: "Test User" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token?: string | null; user?: { id?: string } };
    expect(body.token).toBeNull();
    const userId = must(body.user?.id);
    expect(userId).toMatch(/^[0-9a-f-]{36}$/);
    createdUserIds.push(userId);
    return { userId, email };
  }

  /** 从 spy 邮件正文里取出验证令牌（链接：{WEB_APP_URL}/verify-email?token=…） */
  function tokenFromLastMail(): string {
    const message = must(mailer.sent[mailer.sent.length - 1]);
    const match = /token=([^"&\s<]+)/.exec(message.html);
    return must(match?.[1]);
  }

  /** 注册 + 点击验证链接等价的确认请求，返回验证端点的响应 */
  async function confirmFromLastMail(): Promise<Response> {
    const token = tokenFromLastMail();
    return app.request(`/api/auth/verify-email?token=${encodeURIComponent(token)}`);
  }

  /** 注册并完成邮箱验证，可正常登录 */
  async function signUpVerified(): Promise<{ userId: string; email: string }> {
    const user = await signUpUnverified();
    const confirm = await confirmFromLastMail();
    expect(confirm.status).toBe(200);
    return user;
  }

  async function signIn(email: string, password: string): Promise<Response> {
    return app.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
  }

  /** 从响应的 Set-Cookie 里取出会话 cookie 的 "name=value" 对 */
  function sessionCookie(res: Response): string {
    const cookies = res.headers.getSetCookie().filter((c) =>
      c.startsWith("better-auth.session_token="),
    );
    return must(must(cookies[0]).split(";")[0]);
  }

  it("sign-up creates an unverified user with a credential account and mails a console confirmation link", async () => {
    const sendsBefore = mailer.sent.length;
    const { userId, email } = await signUpUnverified();

    const users = await db.select().from(schema.authUser).where(eq(schema.authUser.id, userId));
    expect(users).toHaveLength(1);
    expect(users[0]?.email).toBe(email);
    // FEAT-634：注册不等于确认
    expect(users[0]?.emailVerified).toBe(false);

    const accounts = await db
      .select()
      .from(schema.authAccount)
      .where(eq(schema.authAccount.userId, userId));
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.providerId).toBe("credential");
    // 哈希落库,不是明文
    expect(accounts[0]?.password).toBeTruthy();
    expect(accounts[0]?.password).not.toContain(PASSWORD);

    // 恰好一封验证邮件，链接指向控制台确认页并携带令牌
    expect(mailer.sent.length).toBe(sendsBefore + 1);
    const message = must(mailer.sent[mailer.sent.length - 1]);
    expect(message.to).toBe(email);
    expect(message.subject).toBe("Confirm your Ally OS account");
    expect(message.html).toContain(`${WEB_APP_URL}/verify-email?token=`);
    expect(message.html).toContain("24 hours");
  });

  it("sign-in is forbidden with 403 until the email is verified", async () => {
    const { email } = await signUpUnverified();

    const res = await signIn(email, PASSWORD);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code?: string; message?: string };
    expect(body.code).toBe("EMAIL_NOT_VERIFIED");
  });

  it("confirming the link marks the email verified and sign-in then works end to end", async () => {
    const { userId, email } = await signUpUnverified();

    const confirm = await confirmFromLastMail();
    expect(confirm.status).toBe(200);

    const users = await db.select().from(schema.authUser).where(eq(schema.authUser.id, userId));
    expect(users[0]?.emailVerified).toBe(true);

    const signInRes = await signIn(email, PASSWORD);
    expect(signInRes.status).toBe(200);

    // 带会话 cookie:中间件解析会话,业务路由拿到当前用户
    const me = await app.request("/api/me", {
      headers: { cookie: sessionCookie(signInRes) },
    });
    expect(me.status).toBe(200);
    const body = (await me.json()) as { user: { id: string; email: string } };
    expect(body.user.id).toBe(userId);
    expect(body.user.email).toBe(email);

    // 不带 cookie:一律 401
    const anonymous = await app.request("/api/me");
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toEqual({ error: "unauthorized" });
  });

  it("a wrong password is 401 — checked before the verification gate", async () => {
    const { email } = await signUpUnverified();
    const res = await signIn(email, "wrong-password");
    expect(res.status).toBe(401);
  });

  it("a tampered token does not verify the email", async () => {
    const { userId } = await signUpUnverified();
    const token = tokenFromLastMail();

    const res = await app.request(
      `/api/auth/verify-email?token=${encodeURIComponent(`${token}x`)}`,
    );
    expect(res.status).toBe(401); // 无 callbackURL 时拒绝直接落在状态码上

    const users = await db.select().from(schema.authUser).where(eq(schema.authUser.id, userId));
    expect(users[0]?.emailVerified).toBe(false);
  });

  it("duplicate sign-up gets the same generic response, no second email, no second user", async () => {
    const { email } = await signUpUnverified();
    const sendsBefore = mailer.sent.length;

    const res = await app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: PASSWORD, name: "Test User" }),
    });
    // 防枚举：与成功注册同形（token null + 合成 user），老系统 GoTrue 的
    // identities 空数组怪癖不照搬
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token?: string | null };
    expect(body.token).toBeNull();
    expect(mailer.sent.length).toBe(sendsBefore);

    const users = await db
      .select()
      .from(schema.authUser)
      .where(eq(schema.authUser.email, email));
    expect(users).toHaveLength(1);
  });

  it("a mailer failure never blocks sign-up (old system: the flow outlives the mail)", async () => {
    mailer.failNext();
    const sendsBefore = mailer.sent.length;
    const { userId } = await signUpUnverified();

    expect(mailer.sent.length).toBe(sendsBefore);
    const users = await db.select().from(schema.authUser).where(eq(schema.authUser.id, userId));
    expect(users).toHaveLength(1);
  });

  it("the resend endpoint re-mails the link, and answers 200 without leaking whether an address exists", async () => {
    const { email } = await signUpUnverified();
    const sendsBefore = mailer.sent.length;

    const known = await app.request("/api/auth/send-verification-email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
    expect(known.status).toBe(200);
    expect(mailer.sent.length).toBe(sendsBefore + 1);
    expect(mailer.sent[mailer.sent.length - 1]?.to).toBe(email);

    const unknown = await app.request("/api/auth/send-verification-email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `${randomUUID()}@example.com` }),
    });
    expect(unknown.status).toBe(200);
    expect(mailer.sent.length).toBe(sendsBefore + 1);
  });

  it("sign-out invalidates the session server-side", async () => {
    const { email } = await signUpVerified();
    const signInRes = await signIn(email, PASSWORD);
    const cookie = sessionCookie(signInRes);

    const signOut = await app.request("/api/auth/sign-out", {
      method: "POST",
      headers: { cookie },
    });
    expect(signOut.status).toBe(200);

    const me = await app.request("/api/me", { headers: { cookie } });
    expect(me.status).toBe(401);
  });

  it("session token verifier resolves live sessions and rejects tampered ones", async () => {
    const { userId, email } = await signUpVerified();
    const signInRes = await signIn(email, PASSWORD);
    const cookieValue = must(sessionCookie(signInRes).split("=")[1]);
    expect(cookieValue).toBeTruthy();

    const verify = createSessionTokenVerifier(db);

    // cookie 形式(带 .signature 后缀)与裸 token 都能解析
    const signed = await verify(`${cookieValue}.somesignature`);
    expect(signed).toEqual({ userId });
    const raw = await verify(cookieValue);
    expect(raw).toEqual({ userId });

    // 篡改 token 段 / 未知令牌 → null(签名段变化不影响比对,token 段变化才影响)
    expect(await verify(`tampered.${cookieValue}`)).toBeNull();
    expect(await verify("")).toBeNull();
  });

  it("session token verifier rejects expired sessions", async () => {
    const { userId } = await signUpVerified();
    const expiredToken = `expired-${randomUUID()}`;
    await db.insert(schema.authSession).values({
      userId,
      token: expiredToken,
      expiresAt: new Date(Date.now() - 1_000),
    });

    const verify = createSessionTokenVerifier(db);
    expect(await verify(expiredToken)).toBeNull();
  });

  // ---- 密码重置(#22 切片 3;老系统 resetPasswordForEmail + recovery 模板)----

  /** 请求重置链接,返回响应;链接令牌可从最后一封邮件取回 */
  async function requestReset(email: string): Promise<Response> {
    return app.request("/api/auth/request-password-reset", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
  }

  async function resetPassword(token: string, newPassword: string): Promise<Response> {
    return app.request("/api/auth/reset-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, newPassword }),
    });
  }

  it("request-password-reset mails a console set-password link and the answer never discloses existence", async () => {
    const { email } = await signUpVerified();
    const sendsBefore = mailer.sent.length;

    const res = await requestReset(email);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status?: boolean; message?: string };
    expect(body.status).toBe(true);

    // 邮件链接落控制台 /reset-password 页(由用户点击后再提交新密码,
    // 邮件扫描器预取消耗不了令牌——与验证邮件同款裁定),24h 有效期文案
    const message = must(mailer.sent[mailer.sent.length - 1]);
    expect(mailer.sent.length).toBe(sendsBefore + 1);
    expect(message.to).toBe(email);
    expect(message.html).toContain(`${WEB_APP_URL}/reset-password?token=`);
    expect(message.html).toContain("24 hours");

    // 未知地址得到逐字相同的响应(反枚举,better-auth 内置时序仿真)
    const unknown = await requestReset(`${randomUUID()}@example.com`);
    expect(unknown.status).toBe(200);
    expect(await unknown.json()).toEqual(body);
    expect(mailer.sent.length).toBe(sendsBefore + 1);
  });

  it("the reset link sets a new password: old one dies, new one signs in, token cannot be reused", async () => {
    const { email } = await signUpVerified();
    await requestReset(email);
    const token = tokenFromLastMail();

    const reset = await resetPassword(token, "brand-new-pass-phrase");
    expect(reset.status).toBe(200);

    // 旧密码失效
    expect((await signIn(email, PASSWORD)).status).toBe(401);
    // 新密码可登录,且 /api/me 走会话中间件拿到用户
    const fresh = await signIn(email, "brand-new-pass-phrase");
    expect(fresh.status).toBe(200);
    const me = await app.request("/api/me", { headers: { cookie: sessionCookie(fresh) } });
    expect(me.status).toBe(200);

    // 令牌一次性:重放被拒
    const replay = await resetPassword(token, "another-pass-phrase");
    expect(replay.status).toBe(400);
  });

  it("resetting the password revokes the sessions the operator already holds", async () => {
    const { email } = await signUpVerified();
    const cookie = sessionCookie(await signIn(email, PASSWORD));
    expect((await app.request("/api/me", { headers: { cookie } })).status).toBe(200);

    await requestReset(email);
    const reset = await resetPassword(tokenFromLastMail(), "rotated-pass-phrase");
    expect(reset.status).toBe(200);

    // 旧会话 cookie 随之作废(改密码必须踢掉既有会话)
    const me = await app.request("/api/me", { headers: { cookie } });
    expect(me.status).toBe(401);
  });

  it("an unknown token is rejected with 400", async () => {
    const res = await resetPassword(`not-a-real-token-${randomUUID()}`, "whatever-pass-phrase");
    expect(res.status).toBe(400);
  });

  it("a mailer failure never blocks the reset request (old system: the hook always answers 200)", async () => {
    const { email } = await signUpVerified();
    mailer.failNext();

    const res = await requestReset(email);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status?: boolean };
    expect(body.status).toBe(true);
  });

  // ---- 邀请与停用(#26;员工建号/停用的认证面)----

  it("a passwordless account gets the invite wording, and the reset wording once a password exists", async () => {
    // 无密码账号 = 管理员建号/影子账号的形状(#25):credential 密码为 null
    const invited = await ensureShadowAccount(db, { email: `${randomUUID()}@example.com`, name: "Invited Staff" }, { logger });
    createdUserIds.push(invited.user.id);

    await requestReset(invited.user.email);
    const invite = must(mailer.sent[mailer.sent.length - 1]);
    expect(invite.subject).toBe("Set up your Ally OS account");
    expect(invite.html).toContain(`${WEB_APP_URL}/reset-password?token=`);

    // 激活 = 设一次密码;同一通道此后就是重置语义
    const setup = await resetPassword(tokenFromLastMail(), "first-pass-phrase");
    expect(setup.status).toBe(200);
    expect((await signIn(invited.user.email, "first-pass-phrase")).status).toBe(200);

    await requestReset(invited.user.email);
    const reset = must(mailer.sent[mailer.sent.length - 1]);
    expect(reset.subject).toBe("Reset your Ally OS password");
  });

  it("a disabled account cannot sign in and its live session dies; enabling restores both", async () => {
    const { userId, email } = await signUpVerified();
    const cookie = sessionCookie(await signIn(email, PASSWORD));
    expect((await app.request("/api/me", { headers: { cookie } })).status).toBe(200);

    // 停用直接落库(端到端的授权面在 routes/users.test.ts):旧会话当场失效、
    // 新登录被拒
    await db
      .update(schema.authUser)
      .set({ disabledAt: new Date() })
      .where(eq(schema.authUser.id, userId));
    expect(
      (await app.request("/api/me", { headers: { cookie } })).status,
    ).toBe(401);
    const blocked = await signIn(email, PASSWORD);
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toMatchObject({ code: "account_disabled" });

    // 启用后恢复:登录照常(会话行已删,重新登一条)
    await db.update(schema.authUser).set({ disabledAt: null }).where(eq(schema.authUser.id, userId));
    expect((await signIn(email, PASSWORD)).status).toBe(200);
  });
});

describe.skipIf(!databaseUrl)("auth: google oauth (#22 slice 4, integration)", () => {
  const GOOGLE_CLIENT_ID = "test-client-id.apps.googleusercontent.com";
  const GOOGLE_CLIENT_SECRET = "test-client-secret";
  const { db, pool } = createDb(databaseUrl ?? "");
  const mailer = spyMailer();
  // 同一部署的两种形态:配了 Google 的与只开密码的。共享一个库连接池。
  const authWithGoogle = createAuth({
    db,
    secret: SECRET,
    trustedOrigins: ["http://localhost:5173"],
    baseURL: undefined,
    webAppUrl: WEB_APP_URL,
    googleOAuth: { clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET },
    mailer,
    logger,
  });
  const authWithoutGoogle = createAuth({
    db,
    secret: SECRET,
    trustedOrigins: ["http://localhost:5173"],
    baseURL: undefined,
    webAppUrl: WEB_APP_URL,
    googleOAuth: undefined,
    mailer,
    logger,
  });
  const appFactory = (auth: ReturnType<typeof createAuth>) =>
    createApp({
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
      socialProviders: auth === authWithGoogle ? ["google"] : [],
      authzStore: createAuthzStore(db),
      storage: {
        put: () => Promise.reject(new Error("storage not used in this suite")),
        signedGetUrl: () => Promise.reject(new Error("storage not used in this suite")),
        signedPutUrl: () => Promise.reject(new Error("storage not used in this suite")),
        delete: () => Promise.reject(new Error("storage not used in this suite")),
      head: () => Promise.reject(new Error("storage not used in this suite")),
      },
    notifyUsers: async () => {},});
  const app = appFactory(authWithGoogle);

  beforeAll(async () => {
    await runMigrations(db);
  });

  afterAll(async () => {
    await pool.end();
  });

  async function startSocial(provider: string, auth?: ReturnType<typeof createAuth>): Promise<Response> {
    const target = auth === undefined ? app : appFactory(auth);
    return await target.request("/api/auth/sign-in/social", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider, callbackURL: "/" }),
    });
  }

  it("sign-in/social builds the Google authorize URL locally — our client id, our callback, a state", async () => {
    const res = await startSocial("google");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url?: string; redirect?: boolean };
    expect(body.redirect).toBe(true);

    // URL 由 better-auth 本地构造(测试不发网络请求):端点是 accounts.google.com,
    // redirect_uri 指回我们的回调端点(回调交换由 better-auth 托管,需要真实
    // 凭据才能端到端——此处钉住的是「请求长什么样」,不是「Google 答应什么」)。
    const url = new URL(must(body.url));
    expect(`${url.origin}${url.pathname}`).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe(GOOGLE_CLIENT_ID);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBeTruthy();
    expect(url.searchParams.get("scope")).toContain("email");
    expect(must(url.searchParams.get("redirect_uri"))).toMatch(/\/api\/auth\/callback\/google$/);
  });

  it("a provider this deployment has not configured is a 404 naming the mistake — not a 500", async () => {
    // apple 是 better-auth 认识的提供商,但本部署没配凭据
    const knownButUnconfigured = await startSocial("apple");
    expect(knownButUnconfigured.status).toBe(404);
    const body = (await knownButUnconfigured.json()) as { code?: string };
    expect(body.code).toBe("PROVIDER_NOT_FOUND");

    // 只开密码的部署对 google 同样 404:按钮不会渲染,直接打端点也拿不到授权 URL
    const passwordOnly = await startSocial("google", authWithoutGoogle);
    expect(passwordOnly.status).toBe(404);
    expect(((await passwordOnly.json()) as { code?: string }).code).toBe("PROVIDER_NOT_FOUND");

    // better-auth 不认识的提供商名也是同一个 404(无单独的入参校验分支)
    const unknown = await startSocial("not-a-provider");
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { code?: string }).code).toBe("PROVIDER_NOT_FOUND");
  });
});
