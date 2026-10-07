import { randomUUID } from "node:crypto";
import { symmetricDecrypt } from "better-auth/crypto";
import { and, eq, sql } from "drizzle-orm";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, runMigrations, schema, type Db } from "@ally/db";
import { registerSignableSubject } from "../esign/registry.ts";
import { SUBJECT_LOADERS } from "../subjects/registry.ts";
import { createApp } from "../app.ts";
import { createAuth, createSessionResolver } from "../auth/auth.ts";
import { createAuthzStore } from "../authz/service.ts";
import type { MailMessage } from "@ally/mailer";

// 集成测试（#219 验收：密码/2FA 拒签、签名后拒改、审计可查、离线补同步）。
// 真实 Better Auth（密码哈希、TOTP）+ 真实 PostgreSQL；未设 DATABASE_URL 跳过。
//
// 本文件用**独立的临时库**（每次运行新建、跑完 drop）：断言审计行的精确数量
// 与签名墙内容，共享库上并行文件的 TRUNCATE 会让它随机红（纪律见
// docs/audit.md「测试清库的唯一通道」）。
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

// 夹具可签名域：task 记账在 tasks 表上（版本 = updated_at，快照 = 行内容）——
// 与生产属主域要写的 load 同构：给出版本标 + 内容快照。经生产注册接缝注入。
registerSignableSubject("task", {
  load: async (db: Db, subjectId: string) => {
    const rows = await db
      .select({
        id: schema.tasks.id,
        title: schema.tasks.title,
        description: schema.tasks.description,
        status: schema.tasks.status,
        dueAt: schema.tasks.dueAt,
        assigneeId: schema.tasks.assigneeId,
        updatedAt: schema.tasks.updatedAt,
      })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, subjectId))
      .limit(1);
    const row = rows[0];
    if (row === undefined) return null;
    return { recordVersion: row.updatedAt.toISOString(), snapshot: { ...row } };
  },
});

// 夹具「可见但不可签」域：注册进共享可见性门、不注册进签名注册表，
// 用于断言 subject_not_signable 的 400（两扇门各说各话）
const gadgetViewerIds: string[] = [];
SUBJECT_LOADERS["esign-test-gadget"] = (_db, subjectId) =>
  Promise.resolve({
    id: subjectId,
    title: "gadget fixture",
    viewers: gadgetViewerIds.map((id) => ({ id, name: "Gadget Viewer" })),
  });

describe.skipIf(!databaseUrl)("esignatures route (#219, integration)", () => {
  // 管理连接连 maintenance 库建删临时库；测试连接指向本文件专属临时库
  const dbName = `esignatures_test_${String(Date.now())}_${String(process.pid)}`;
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
    notifyUsers: async () => {},
  });

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("unreachable: suite is skipped without DATABASE_URL");
    await admin.pool.query(`create database "${dbName}"`);
    await runMigrations(db);
  });

  beforeEach(async () => {
    // 每条测试从空表开始（整库是本文件的；用户行不清——临时库整体生灭）
    await db.execute(sql`truncate table ${schema.esignSignatures}`);
    await db.execute(sql`truncate table ${schema.tasks}`);
    await db.execute(sql`truncate table ${schema.auditEvents}`);
  });

  afterAll(async () => {
    await pool.end();
    await admin.pool.query(`drop database if exists "${dbName}" with (force)`);
    await admin.pool.end();
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
    const message = must(mailer.sent[mailer.sent.length - 1]);
    const token = must(/token=([^"&\s<]+)/.exec(message.html)?.[1]);
    const confirm = await app.request(`/api/auth/verify-email?token=${encodeURIComponent(token)}`);
    expect(confirm.status).toBe(200);
    return { userId, email };
  }

  function cookiesNamed(res: Response, prefix: string): string[] {
    return res.headers.getSetCookie().filter((c) => c.startsWith(prefix)).map((c) => must(c.split(";")[0]));
  }

  function sessionCookie(res: Response): string {
    return must(cookiesNamed(res, "better-auth.session_token=")[0]);
  }

  async function signIn(email: string, password: string): Promise<Response> {
    return app.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
  }

  /**
   * 给已验证用户绑 2FA（与 two-factor.test.ts 同一条路径）：enable → 解出库里
   * 的原始密钥 → better-auth 自己的 TOTP 实现生成真码 → verify；完成绑定时
   * better-auth 换发会话，后续调用带换发后的 cookie。
   */
  async function enrollTotp(userId: string, email: string): Promise<string> {
    const signInRes = await signIn(email, PASSWORD);
    expect(signInRes.status).toBe(200);
    const session = sessionCookie(signInRes);
    const enable = await app.request("/api/auth/two-factor/enable", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: session },
      body: JSON.stringify({ password: PASSWORD, method: "totp" }),
    });
    expect(enable.status).toBe(200);
    const rows = await db
      .select()
      .from(schema.authTwoFactor)
      .where(eq(schema.authTwoFactor.userId, userId));
    const secret = await symmetricDecrypt({ key: SECRET, data: must(rows[0]?.secret) });
    const code = must((await auth.api.generateTOTP({ body: { secret } })).code);
    const verify = await app.request("/api/auth/two-factor/verify-totp", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: session },
      body: JSON.stringify({ code }),
    });
    expect(verify.status).toBe(200);
    const rotated = cookiesNamed(verify, "better-auth.session_token=")[0];
    return rotated ?? session;
  }

  /** 建一个绑好 2FA 的用户，返回会话 cookie 与 id */
  async function twoFactorUser(): Promise<{ userId: string; session: string }> {
    const { userId, email } = await signUpVerified();
    const session = await enrollTotp(userId, email);
    gadgetViewerIds.push(userId);
    return { userId, session };
  }

  async function createTask(session: string, title: string): Promise<string> {
    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: session },
      body: JSON.stringify({ title }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { task?: { id?: string } };
    return must(body.task?.id);
  }

  interface SignOverrides {
    subjectType?: string;
    subjectId?: string;
    meaning?: "performed" | "reviewed" | "approved";
    password?: string;
    clientToken?: string;
    signedAt?: string;
  }

  async function sign(
    session: string,
    subjectId: string,
    overrides: SignOverrides = {},
  ): Promise<Response> {
    return app.request("/api/esignatures", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: session },
      body: JSON.stringify({
        subjectType: overrides.subjectType ?? "task",
        subjectId,
        meaning: overrides.meaning ?? "performed",
        password: overrides.password ?? PASSWORD,
        clientToken: overrides.clientToken ?? randomUUID(),
        ...(overrides.signedAt === undefined ? {} : { signedAt: overrides.signedAt }),
      }),
    });
  }

  it("rejects a signature when the signing password is wrong — even with 2FA on (#219 acceptance 1)", async () => {
    const { userId, session } = await twoFactorUser();
    const taskId = await createTask(session, "Batch record entry");
    const res = await sign(session, taskId, { password: "not-my-password" });
    expect(res.status).toBe(401);
    // 拒签必须是真的：签名行与审计行都没有
    const rows = await db
      .select()
      .from(schema.esignSignatures)
      .where(eq(schema.esignSignatures.signerId, userId));
    expect(rows).toHaveLength(0);
    const audits = await db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.action, "esignature.created"));
    expect(audits).toHaveLength(0);
  });

  it("rejects a signature from a user who has not enabled 2FA (#219 acceptance 1)", async () => {
    const { userId, email } = await signUpVerified();
    const signInRes = await signIn(email, PASSWORD);
    expect(signInRes.status).toBe(200);
    const session = sessionCookie(signInRes);
    const res = await sign(session, randomUUID(), { subjectType: "esign-test-gadget" });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("two_factor_required");
    expect(
      (await db.select().from(schema.esignSignatures).where(eq(schema.esignSignatures.signerId, userId)))
        .length,
    ).toBe(0);
  });

  it("rejects modification of a signed record server-side (#219 acceptance 2)", async () => {
    const { session } = await twoFactorUser();
    const taskId = await createTask(session, "Deviation review");
    const signed = await sign(session, taskId);
    expect(signed.status).toBe(201);
    // 任何字段、任何意图的修改都被服务端拒绝——包括经办人自己的例行编辑
    const patch = await app.request(`/api/tasks/${taskId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: session },
      body: JSON.stringify({ title: "rewritten after signing" }),
    });
    expect(patch.status).toBe(409);
    const body = (await patch.json()) as { error?: string };
    expect(body.error).toBe("record_signed");
    // 状态流转同样算修改
    const done = await app.request(`/api/tasks/${taskId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: session },
      body: JSON.stringify({ status: "done" }),
    });
    expect(done.status).toBe(409);
    // 记录内容原样未动
    const get = await app.request(`/api/tasks/${taskId}`, { headers: { cookie: session } });
    expect(get.status).toBe(200);
    const task = (await get.json()) as { task: { title: string; status: string } };
    expect(task.task.title).toBe("Deviation review");
    expect(task.task.status).toBe("open");
  });

  it("audit log shows signer, time, meaning and record version for every signature (#219 acceptance 3)", async () => {
    const { userId, session } = await twoFactorUser();
    const taskId = await createTask(session, "Release review");
    const signed = await sign(session, taskId, { meaning: "approved" });
    expect(signed.status).toBe(201);
    const signature = (await signed.json()) as { signature: { id: string; recordVersion: string } };
    await db.insert(schema.userRole).values({ userId, role: "owner" });
    const res = await app.request("/api/audit-events?action=esignature.created", {
      headers: { cookie: session },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events: { actor: string | null; target: string | null; detail: Record<string, unknown> | null }[];
    };
    const event = body.events.find((e) => e.target === signature.signature.id);
    expect(event).toBeDefined();
    expect(must(event).actor).toBe(userId);
    expect(must(event).detail).toMatchObject({
      subjectType: "task",
      subjectId: taskId,
      meaning: "approved",
      recordVersion: signature.signature.recordVersion,
    });
  });

  it("offline sync preserves the original signing time and replays idempotently (#219 acceptance 4)", async () => {
    const { userId, session } = await twoFactorUser();
    const taskId = await createTask(session, "Offline weighing step");
    // 平板离线时的签名时刻：3 小时前（联网后才补同步上来）
    const offlineAt = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const clientToken = randomUUID();
    const first = await sign(session, taskId, { clientToken, signedAt: offlineAt.toISOString() });
    expect(first.status).toBe(201);
    const body = (await first.json()) as {
      signature: { id: string; signedAt: string; receivedAt: string };
      replayed: boolean;
    };
    expect(body.replayed).toBe(false);
    // 服务端记录与离线时一致：原签名时间被保留，收到时刻是补同步的时刻
    expect(new Date(body.signature.signedAt).toISOString()).toBe(offlineAt.toISOString());
    expect(new Date(body.signature.receivedAt).getTime()).toBeGreaterThan(offlineAt.getTime());
    // 弱网重试：同一个 clientToken 重放 → 同一行、幂等 200，不重复落审计
    const retry = await sign(session, taskId, { clientToken, signedAt: offlineAt.toISOString() });
    expect(retry.status).toBe(200);
    const retryBody = (await retry.json()) as { signature: { id: string }; replayed: boolean };
    expect(retryBody.replayed).toBe(true);
    expect(retryBody.signature.id).toBe(body.signature.id);
    const audits = await db
      .select()
      .from(schema.auditEvents)
      .where(and(eq(schema.auditEvents.action, "esignature.created"), eq(schema.auditEvents.target, body.signature.id)));
    expect(audits).toHaveLength(1);
    expect(userId).toBeTruthy();
  });

  it("rejects a signedAt in the future beyond clock skew", async () => {
    const { session } = await twoFactorUser();
    const taskId = await createTask(session, "Clock skew");
    const future = new Date(Date.now() + 60 * 60 * 1000);
    const res = await sign(session, taskId, { signedAt: future.toISOString() });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("signed_at_future");
  });

  it("rejects the same person signing the same record with the same meaning twice", async () => {
    const { session } = await twoFactorUser();
    const taskId = await createTask(session, "Double signature");
    expect((await sign(session, taskId)).status).toBe(201);
    // 换一个 clientToken（不是重放，是真的再签一次）→ 业务冲突
    const res = await sign(session, taskId, { clientToken: randomUUID() });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("already_signed");
  });

  it("rejects unregistered subject types and invisible subjects", async () => {
    const { session } = await twoFactorUser();
    const unregistered = await sign(session, randomUUID(), { subjectType: "not-a-thing" });
    expect(unregistered.status).toBe(400);
    const notSignable = await sign(session, randomUUID(), { subjectType: "esign-test-gadget" });
    expect(notSignable.status).toBe(400);
    const body = (await notSignable.json()) as { error?: string };
    expect(body.error).toBe("subject_not_signable");
    // 别人的任务不可见：不存在与不可见同答 404（反探测）
    const other = await twoFactorUser();
    const otherTaskId = await createTask(other.session, "Not yours");
    const invisible = await sign(session, otherTaskId);
    expect(invisible.status).toBe(404);
  });

  it("signature wall lists signer, time, meaning and version in signing order", async () => {
    const { userId, session } = await twoFactorUser();
    const second = await twoFactorUser();
    // 把第二人拉进可见者集合（经办人），两个不同的人先后签两种含义
    const taskId = await createTask(session, "Two signatures");
    await db.update(schema.tasks).set({ assigneeId: second.userId }).where(eq(schema.tasks.id, taskId));
    await sign(session, taskId, { meaning: "performed" });
    await sign(second.session, taskId, { meaning: "reviewed" });
    const res = await app.request(`/api/esignatures?subjectType=task&subjectId=${taskId}`, {
      headers: { cookie: session },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      signatures: { meaning: string; signer: { id: string; name: string }; recordVersion: string; signedAt: string }[];
    };
    expect(body.signatures).toHaveLength(2);
    expect(body.signatures.map((s) => s.meaning)).toEqual(["performed", "reviewed"]);
    expect(body.signatures[0]?.signer.id).toBe(userId);
    expect(body.signatures.every((s) => s.recordVersion.length > 0)).toBe(true);
  });
});

function adminUrl(databaseUrl: string | undefined): string {
  if (databaseUrl === undefined) return "";
  const url = new URL(databaseUrl);
  url.pathname = "/postgres";
  return url.toString();
}
