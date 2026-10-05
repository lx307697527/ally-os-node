import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import pino from "pino";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb, runMigrations, schema } from "@ally/db";
import { createApp } from "../app.ts";
import type { MailMessage } from "../mailer/mailer.ts";
import { createAuth, createSessionResolver } from "./auth.ts";
import { createAuthzStore } from "../authz/service.ts";
import { ensureShadowAccount, ShadowAccountInputError } from "./shadow-account.ts";

// 集成测试：需要真实 PostgreSQL（影子账号写 auth_user/auth_account，认领走
// Better Auth 的重置流程）。未设 DATABASE_URL 时跳过。
const databaseUrl = process.env.DATABASE_URL;

const logger = pino({ level: "silent" });
const SECRET = "test-secret-0123456789abcdef0123456789abcdef";
const WEB_APP_URL = "https://admin.example";

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

describe.skipIf(!databaseUrl)("shadow account: CRM 预建用户 (#25, integration)", () => {
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

  async function credentialAccountCount(userId: string): Promise<number> {
    const rows = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.authAccount)
      .where(eq(schema.authAccount.userId, userId));
    return must(rows[0]).n;
  }

  /** 从响应的 Set-Cookie 里取出会话 cookie 的 "name=value" 对 */
  function sessionCookie(res: Response): string {
    const cookies = res.headers.getSetCookie().filter((c) =>
      c.startsWith("better-auth.session_token="),
    );
    return must(must(cookies[0]).split(";")[0]);
  }

  function tokenFromLastMail(): string {
    const message = must(mailer.sent[mailer.sent.length - 1]);
    const match = /token=([^"&\s<]+)/.exec(message.html);
    return must(match?.[1]);
  }

  async function signIn(email: string, password: string): Promise<Response> {
    return app.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
  }

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

  // ---- 预建：无密码账号，落库即影子态 ----

  it("provisioning creates a verified, passwordless account with the CRM display name", async () => {
    const sendsBefore = mailer.sent.length;
    const email = `${randomUUID()}@Example.com`;

    const result = await ensureShadowAccount(db, { email: `  ${email}  `, name: "王影子" }, { logger });
    expect(result.created).toBe(true);
    createdUserIds.push(result.user.id);

    // 存储即归一化（trim + lowercase），emailVerified 直接为 true：
    // CRM 邮箱来自真实往来，认领邮件发往该地址即自证（老系统 email_confirm: true）
    const users = await db.select().from(schema.authUser).where(eq(schema.authUser.id, result.user.id));
    expect(users).toHaveLength(1);
    expect(users[0]?.email).toBe(email.toLowerCase());
    expect(users[0]?.emailVerified).toBe(true);
    expect(users[0]?.name).toBe("王影子");

    // credential account 占位但密码为 null：登录 401，认领时原地覆盖
    const accounts = await db
      .select()
      .from(schema.authAccount)
      .where(eq(schema.authAccount.userId, result.user.id));
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.providerId).toBe("credential");
    expect(accounts[0]?.accountId).toBe(result.user.id);
    expect(accounts[0]?.password).toBeNull();

    // 建号永远静默（老系统裁定：创建不触发邮件，邀请/重发才发）
    expect(mailer.sent.length).toBe(sendsBefore);
  });

  it("falls back to the email local part when no display name is given", async () => {
    const email = `${randomUUID()}@example.com`;
    const result = await ensureShadowAccount(db, { email }, { logger });
    createdUserIds.push(result.user.id);
    expect(result.user.name).toBe(email.split("@")[0]);
  });

  it("is idempotent: same email returns the same user and writes nothing", async () => {
    const email = `${randomUUID()}@example.com`;
    const first = await ensureShadowAccount(db, { email, name: "第一次" }, { logger });
    createdUserIds.push(first.user.id);

    const second = await ensureShadowAccount(db, { email, name: "第二次" }, { logger });
    expect(second.created).toBe(false);
    expect(second.user.id).toBe(first.user.id);
    // first-write-wins：既有行的展示名不被后到的调用改写
    expect(second.user.name).toBe("第一次");
    expect(await credentialAccountCount(first.user.id)).toBe(1);
  });

  it("treats case and whitespace variants as the same mailbox (no duplicate accounts)", async () => {
    const local = randomUUID();
    const first = await ensureShadowAccount(db, { email: `${local}@example.com` }, { logger });
    createdUserIds.push(first.user.id);

    const variant = await ensureShadowAccount(
      db,
      { email: `  ${local.toUpperCase()}@EXAMPLE.COM ` },
      { logger },
    );
    expect(variant.created).toBe(false);
    expect(variant.user.id).toBe(first.user.id);

    const rows = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.authUser)
      .where(sql`lower(${schema.authUser.email}) = ${`${local}@example.com`}`);
    expect(must(rows[0]).n).toBe(1);
  });

  it("rejects malformed input with a typed error before touching the database", async () => {
    await expect(ensureShadowAccount(db, { email: "not-an-email" }, { logger })).rejects.toThrow(
      ShadowAccountInputError,
    );
    await expect(ensureShadowAccount(db, { email: "" }, { logger })).rejects.toThrow(
      ShadowAccountInputError,
    );
  });

  it("concurrent provisioning of one mailbox yields exactly one account", async () => {
    const email = `${randomUUID()}@example.com`;
    const [a, b] = await Promise.all([
      ensureShadowAccount(db, { email }, { logger }),
      ensureShadowAccount(db, { email }, { logger }),
    ]);
    createdUserIds.push(a.user.id, b.user.id);

    expect(a.user.id).toBe(b.user.id);
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1);
    expect(await credentialAccountCount(a.user.id)).toBe(1);
  });

  // ---- 认领前：不能登录，也不能走注册表单 ----

  it("sign-in with any password is 401 before the account is claimed", async () => {
    const email = `${randomUUID()}@example.com`;
    const result = await ensureShadowAccount(db, { email }, { logger });
    createdUserIds.push(result.user.id);

    const res = await signIn(email, "some-guessed-password");
    expect(res.status).toBe(401);
  });

  it("the sign-up form answers the anti-enumeration generic response and leaves the shadow account untouched", async () => {
    const email = `${randomUUID()}@example.com`;
    const result = await ensureShadowAccount(db, { email }, { logger });
    createdUserIds.push(result.user.id);

    const res = await app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "whatever-pass-phrase", name: "路人" }),
    });
    // 防枚举：重复注册与成功注册同形 200（切片 2 裁定），不会因「邮箱已存在」
    // 泄漏影子账号的存在——认领只走重置链接（老系统接管不走重新注册，同源）
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token?: string | null };
    expect(body.token).toBeNull();

    // 影子行原封不动：没有第二个用户，credential 密码仍是 null（注册表单
    // 拿不到这个账号）
    const rows = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.authUser)
      .where(sql`lower(${schema.authUser.email}) = ${email}`);
    expect(must(rows[0]).n).toBe(1);
    expect(await credentialAccountCount(result.user.id)).toBe(1);
    const accounts = await db
      .select()
      .from(schema.authAccount)
      .where(eq(schema.authAccount.userId, result.user.id));
    expect(accounts[0]?.password).toBeNull();
  });

  // ---- 认领：重置链接设密码，原邮箱原账号接管 ----

  it("claim: request-reset mails the console set-password link, reset sets a scrypt password, sign-in then works", async () => {
    const email = `${randomUUID()}@example.com`;
    const result = await ensureShadowAccount(db, { email, name: "王接管" }, { logger });
    createdUserIds.push(result.user.id);

    // 重置请求对影子账号照常发信（better-auth 不要求已有凭据）
    const req = await requestReset(email);
    expect(req.status).toBe(200);
    const message = must(mailer.sent[mailer.sent.length - 1]);
    expect(message.to).toBe(email);
    expect(message.html).toContain(`${WEB_APP_URL}/reset-password?token=`);

    const reset = await resetPassword(tokenFromLastMail(), "claimed-pass-phrase");
    expect(reset.status).toBe(200);

    // 同一行原地认领：不是新建用户；密码落为 scrypt（better-auth 哈希，非 bcrypt 前缀）
    const accounts = await db
      .select()
      .from(schema.authAccount)
      .where(eq(schema.authAccount.userId, result.user.id));
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.password).toBeTruthy();
    expect(accounts[0]?.password).not.toContain("claimed-pass-phrase");

    // 原邮箱 + 新密码登录成功，/api/me 拿到的就是这个预建 id
    const signInRes = await signIn(email, "claimed-pass-phrase");
    expect(signInRes.status).toBe(200);
    const me = await app.request("/api/me", { headers: { cookie: sessionCookie(signInRes) } });
    expect(me.status).toBe(200);
    const body = (await me.json()) as { user: { id: string; name: string } };
    expect(body.user.id).toBe(result.user.id);
    expect(body.user.name).toBe("王接管");

    // 令牌一次性（老系统 recovery 同款）
    expect((await resetPassword(tokenFromLastMail(), "again-pass-phrase")).status).toBe(400);
  });
});
