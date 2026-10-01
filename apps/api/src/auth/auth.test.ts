import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import pino from "pino";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb, runMigrations, schema } from "@ally/db";
import { createApp } from "../app.ts";
import { createAuth, createSessionResolver, createSessionTokenVerifier } from "./auth.ts";

// 集成测试：需要真实 PostgreSQL（Better Auth 走库读写 user/session/account）。
// 未设 DATABASE_URL 时跳过。
const databaseUrl = process.env.DATABASE_URL;

const logger = pino({ level: "silent" });
const SECRET = "test-secret-0123456789abcdef0123456789abcdef";

/** 测试里替代非空断言：取不到就直接失败 */
function must<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("unexpected missing value in test");
  return value;
}

describe.skipIf(!databaseUrl)("auth: credential login (#22, integration)", () => {
  const { db, pool } = createDb(databaseUrl ?? "");
  const auth = createAuth({
    db,
    secret: SECRET,
    trustedOrigins: ["http://localhost:5173"],
    baseURL: undefined,
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

  async function signUpUser(): Promise<{ userId: string; email: string }> {
    const email = `${randomUUID()}@example.com`;
    const res = await app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "correct-horse-battery", name: "Test User" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user?: { id?: string } };
    const userId = must(body.user?.id);
    expect(userId).toMatch(/^[0-9a-f-]{36}$/);
    createdUserIds.push(userId);
    return { userId, email };
  }

  /** 从响应的 Set-Cookie 里取出会话 cookie 的 "name=value" 对 */
  function sessionCookie(res: Response): string {
    const cookies = res.headers.getSetCookie().filter((c) =>
      c.startsWith("better-auth.session_token="),
    );
    return must(must(cookies[0]).split(";")[0]);
  }

  it("sign-up creates a user with a uuid id and a credential account", async () => {
    const { userId, email } = await signUpUser();

    const users = await db.select().from(schema.authUser).where(eq(schema.authUser.id, userId));
    expect(users).toHaveLength(1);
    expect(users[0]?.email).toBe(email);
    expect(users[0]?.emailVerified).toBe(false);

    const accounts = await db
      .select()
      .from(schema.authAccount)
      .where(eq(schema.authAccount.userId, userId));
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.providerId).toBe("credential");
    // 哈希落库,不是明文
    expect(accounts[0]?.password).toBeTruthy();
    expect(accounts[0]?.password).not.toContain("correct-horse");
  });

  it("sign-in with the wrong password is rejected with 401", async () => {
    const { email } = await signUpUser();
    const res = await app.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "wrong-password" }),
    });
    expect(res.status).toBe(401);
  });

  it("sign-in sets the session cookie and /api/me resolves the user through the middleware", async () => {
    const { userId, email } = await signUpUser();

    const signIn = await app.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "correct-horse-battery" }),
    });
    expect(signIn.status).toBe(200);

    // 带会话 cookie:中间件解析会话,业务路由拿到当前用户
    const me = await app.request("/api/me", {
      headers: { cookie: sessionCookie(signIn) },
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

  it("sign-out invalidates the session server-side", async () => {
    const { email } = await signUpUser();
    const signIn = await app.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "correct-horse-battery" }),
    });
    const cookie = sessionCookie(signIn);

    const signOut = await app.request("/api/auth/sign-out", {
      method: "POST",
      headers: { cookie },
    });
    expect(signOut.status).toBe(200);

    const me = await app.request("/api/me", { headers: { cookie } });
    expect(me.status).toBe(401);
  });

  it("session token verifier resolves live sessions and rejects tampered ones", async () => {
    const { userId, email } = await signUpUser();
    const signIn = await app.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "correct-horse-battery" }),
    });
    const cookieValue = must(sessionCookie(signIn).split("=")[1]);
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
    const { userId } = await signUpUser();
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
