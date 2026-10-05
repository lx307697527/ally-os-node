import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import pino from "pino";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb, runMigrations, schema } from "@ally/db";
import { createApp } from "../app.ts";
import type { MailMessage } from "../mailer/mailer.ts";
import { createAuth, createSessionResolver } from "./auth.ts";
import { createAuthzStore } from "../authz/service.ts";
import { importLegacyUsers, type LegacyUserRow } from "./legacy-import.ts";

// 集成测试：需要真实 PostgreSQL（导入写 auth_user/auth_account,登录走 Better Auth）。
// 未设 DATABASE_URL 时跳过。
const databaseUrl = process.env.DATABASE_URL;

const logger = pino({ level: "silent" });
const SECRET = "test-secret-0123456789abcdef0123456789abcdef";
const WEB_APP_URL = "https://admin.example";

/** 老系统向量：GoTrue（Rust bcrypt）/ pgcrypto gen_salt('bf', 10) 的 $2a$ 格式 */
const LEGACY_BCRYPT_HASH = "$2a$10$b5bN2E9SZp9sOLY6GLkwYOtFijXbv4EKCL4dhbseFP8qmELCINia2";
const LEGACY_PASSWORD = "s3cret-Passw0rd!";

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

/** 一行 GoTrue 导出形状的数据,默认为已确认邮箱、带 bcrypt 密码的用户 */
function legacyRow(overrides: Partial<LegacyUserRow> & { id?: string; email?: string }): LegacyUserRow {
  return {
    id: randomUUID(),
    email: `${randomUUID()}@example.com`,
    encrypted_password: LEGACY_BCRYPT_HASH,
    email_confirmed_at: "2026-08-01T10:00:00+00:00",
    confirmed_at: null,
    created_at: "2026-08-01T09:00:00+00:00",
    updated_at: "2026-08-01T10:00:00+00:00",
    last_sign_in_at: "2026-09-01T08:00:00+00:00",
    raw_user_meta_data: { name: "李雷" },
    ...overrides,
  };
}

describe.skipIf(!databaseUrl)("legacy user import (#22 slice 5, integration)", () => {
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

  function trackIds(rows: readonly LegacyUserRow[]): void {
    for (const row of rows) createdUserIds.push(row.id);
  }

  async function signIn(email: string, password: string): Promise<Response> {
    return app.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
  }

  function sessionCookie(res: Response): string {
    const cookies = res.headers.getSetCookie().filter((c) => c.startsWith("better-auth.session_token="));
    return must(must(cookies[0]).split(";")[0]);
  }

  async function credentialAccount(userId: string) {
    const accounts = await db
      .select()
      .from(schema.authAccount)
      .where(eq(schema.authAccount.userId, userId));
    expect(accounts).toHaveLength(1);
    return must(accounts[0]);
  }

  it("dry-run validates and reports without writing anything", async () => {
    const rows = [legacyRow({}), legacyRow({ raw_user_meta_data: {} })];
    trackIds(rows);

    const report = await importLegacyUsers(db, rows, { logger, apply: false });
    expect(report).toMatchObject({ total: 2, imported: 2, skipped: 0, errors: [], dryRun: true });

    for (const row of rows) {
      const users = await db.select().from(schema.authUser).where(eq(schema.authUser.id, row.id));
      expect(users).toHaveLength(0);
    }
  });

  it("apply imports the user under the original id with the legacy bcrypt hash", async () => {
    const row = legacyRow({});
    trackIds([row]);

    const report = await importLegacyUsers(db, [row], { logger, apply: true });
    expect(report).toMatchObject({ total: 1, imported: 1, skipped: 0, errors: [], dryRun: false });

    const users = await db.select().from(schema.authUser).where(eq(schema.authUser.id, row.id));
    expect(users).toHaveLength(1);
    const user = must(users[0]);
    // 原 uuid 保留、验证状态与展示名按导出数据、创建时间忠实迁移
    expect(user.id).toBe(row.id);
    expect(user.email).toBe(row.email);
    expect(user.emailVerified).toBe(true);
    expect(user.name).toBe("李雷");
    expect(user.createdAt.toISOString()).toBe("2026-08-01T09:00:00.000Z");

    const account = await credentialAccount(row.id);
    expect(account.providerId).toBe("credential");
    // better-auth 登录路径按 accountId === user.id 找 credential account
    expect(account.accountId).toBe(row.id);
    expect(account.password).toBe(LEGACY_BCRYPT_HASH);
  });

  it("an old user signs in with the original password — no reset needed (#22 AC 1)", async () => {
    const row = legacyRow({});
    trackIds([row]);
    await importLegacyUsers(db, [row], { logger, apply: true });

    const res = await signIn(row.email, LEGACY_PASSWORD);
    expect(res.status).toBe(200);

    const me = await app.request("/api/me", { headers: { cookie: sessionCookie(res) } });
    expect(me.status).toBe(200);
    const body = (await me.json()) as { user: { id: string; email: string } };
    expect(body.user.id).toBe(row.id);
    expect(body.user.email).toBe(row.email);

    const wrong = await signIn(row.email, "not-the-old-password");
    expect(wrong.status).toBe(401);
  });

  it("re-running the same export is idempotent — everything skipped, no duplicate rows", async () => {
    const row = legacyRow({});
    trackIds([row]);
    await importLegacyUsers(db, [row], { logger, apply: true });

    const report = await importLegacyUsers(db, [row], { logger, apply: true });
    expect(report).toMatchObject({ total: 1, imported: 0, skipped: 1, errors: [] });

    const users = await db.select().from(schema.authUser).where(eq(schema.authUser.id, row.id));
    expect(users).toHaveLength(1);
    const accounts = await db.select().from(schema.authAccount).where(eq(schema.authAccount.userId, row.id));
    expect(accounts).toHaveLength(1);
  });

  it("a user whose id exists but credential account was created later gets the imported hash backfilled", async () => {
    // 幂等重跑的补写分支:用户已在(account 缺失/密码为空)→ 导入补齐
    const row = legacyRow({ encrypted_password: null });
    trackIds([row]);
    await importLegacyUsers(db, [row], { logger, apply: true });
    expect((await credentialAccount(row.id)).password).toBeNull();

    const report = await importLegacyUsers(db, [legacyRow({ id: row.id, email: row.email })], {
      logger,
      apply: true,
    });
    expect(report).toMatchObject({ total: 1, imported: 1, skipped: 0, errors: [] });
    expect((await credentialAccount(row.id)).password).toBe(LEGACY_BCRYPT_HASH);
  });

  it("an unconfirmed legacy user imports as unverified and hits the 403 verification gate", async () => {
    const row = legacyRow({ email_confirmed_at: null, confirmed_at: null });
    trackIds([row]);
    await importLegacyUsers(db, [row], { logger, apply: true });

    const users = await db.select().from(schema.authUser).where(eq(schema.authUser.id, row.id));
    expect(must(users[0]).emailVerified).toBe(false);

    // 密码先验(对),验证门后拦:403 EMAIL_NOT_VERIFIED,不是 401
    const res = await signIn(row.email, LEGACY_PASSWORD);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code?: string }).code).toBe("EMAIL_NOT_VERIFIED");
  });

  it("an OAuth-only legacy user (empty encrypted_password) imports with a null password and cannot sign in", async () => {
    const row = legacyRow({ encrypted_password: null });
    trackIds([row]);
    const report = await importLegacyUsers(db, [row], { logger, apply: true });
    expect(report.errors).toHaveLength(0);

    expect((await credentialAccount(row.id)).password).toBeNull();
    // better-auth 对 null 密码短路 401;用户走重置流程或 Google 登录
    expect((await signIn(row.email, LEGACY_PASSWORD)).status).toBe(401);
  });

  it("a non-bcrypt password format is rejected — fail closed on unexpected exports", async () => {
    const row = legacyRow({ encrypted_password: "md5deadbeefdeadbeefdeadbeefdeadbeef" });
    const report = await importLegacyUsers(db, [row], { logger, apply: true });
    expect(report).toMatchObject({ total: 1, imported: 0, skipped: 0 });
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]?.reason).toContain("unsupported password format");

    const users = await db.select().from(schema.authUser).where(eq(schema.authUser.id, row.id));
    expect(users).toHaveLength(0);
  });

  it("a schema-violating row (bad uuid) is reported with its index and does not abort the batch", async () => {
    const good = legacyRow({});
    trackIds([good]);
    const bad = legacyRow({ id: "not-a-uuid" });

    const report = await importLegacyUsers(db, [bad, good], { logger, apply: true });
    expect(report.total).toBe(2);
    expect(report.imported).toBe(1);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]?.index).toBe(0);
    expect(report.errors[0]?.reason).toContain("schema");

    const users = await db.select().from(schema.authUser).where(eq(schema.authUser.id, good.id));
    expect(users).toHaveLength(1);
  });

  it("an email that already exists under a different id is an error — no silent merge", async () => {
    // 新系统在切换后自己注册了同邮箱用户(新 uuid)
    const email = `${randomUUID()}@example.com`;
    const signUp = await app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "local-user-passw0rd", name: "Local User" }),
    });
    expect(signUp.status).toBe(200);
    const localUser = must(((await signUp.json()) as { user?: { id?: string } }).user?.id);
    createdUserIds.push(localUser);

    const row = legacyRow({ email });
    const report = await importLegacyUsers(db, [row], { logger, apply: true });
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]?.reason).toContain("email already exists under a different user id");

    // 没有并排第二行、也没有动到已有用户
    const users = await db.select().from(schema.authUser).where(eq(schema.authUser.email, email));
    expect(users).toHaveLength(1);
    expect(must(users[0]).id).toBe(localUser);
    const accounts = await db.select().from(schema.authAccount).where(eq(schema.authAccount.userId, localUser));
    expect(accounts).toHaveLength(1);
  });

  it("after a password reset the imported user has a scrypt hash — both formats coexist until migration completes", async () => {
    const row = legacyRow({});
    trackIds([row]);
    await importLegacyUsers(db, [row], { logger, apply: true });

    const requestReset = await app.request("/api/auth/request-password-reset", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: row.email }),
    });
    expect(requestReset.status).toBe(200);
    const message = must(mailer.sent[mailer.sent.length - 1]);
    const token = must(/token=([^"&\s<]+)/.exec(message.html)?.[1]);

    const reset = await app.request("/api/auth/reset-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, newPassword: "brand-new-pass-phrase" }),
    });
    expect(reset.status).toBe(200);

    // 旧密码(bcrypt)死了,新密码(scrypt)能登录;hash 字段不再以 $2 开头
    expect((await signIn(row.email, LEGACY_PASSWORD)).status).toBe(401);
    expect((await signIn(row.email, "brand-new-pass-phrase")).status).toBe(200);
    const account = await credentialAccount(row.id);
    expect(account.password).not.toBeNull();
    expect(must(account.password).startsWith("$2")).toBe(false);
  });
});
