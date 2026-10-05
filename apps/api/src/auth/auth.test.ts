import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import pino from "pino";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb, runMigrations, schema } from "@ally/db";
import { createApp } from "../app.ts";
import type { MailMessage } from "../mailer/mailer.ts";
import { createAuth, createSessionResolver, createSessionTokenVerifier } from "./auth.ts";

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
    mailer,
    logger,
  });
  const app = createApp({
    logger,
    corsOrigins: ["http://localhost:5173"],
    checkDatabase: async () => {
      await pool.query("select 1");
    },
    authHandler: (request) => auth.handler(request),
    resolveSession: createSessionResolver(auth),
  });

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
});
