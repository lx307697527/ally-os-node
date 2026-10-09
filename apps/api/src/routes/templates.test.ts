import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, runMigrations, schema } from "@ally/db";
import type { MailMessage } from "@ally/mailer";
import { renderAccountInviteEmail } from "@ally/mailer";
import { createApp } from "../app.ts";
import { createAuth, createSessionResolver } from "../auth/auth.ts";
import type { SessionData } from "../auth/session.ts";
import { createAuthzStore } from "../authz/service.ts";
import { resolveAuthEmail } from "../templates/service.ts";

// 集成测试：需要真实 PostgreSQL（唯一索引 409、版本史行、审计同事务、
// Better Auth 的邀请分流）。未设 DATABASE_URL 时跳过。
//
// 本文件用独立的临时库（纪律同 numbering-rules.test.ts）；TRUNCATE 是清库通道。
// 邀请端到端需要一个**真实 better-auth handler** 的 app 实例（authApp，spyMailer），
// 与配置面用的 app 共用同一个库——模板行由配置面写入，邀请链路读它，两端对上。
const databaseUrl = process.env.DATABASE_URL;

const logger = pino({ level: "silent" });
const SECRET = "test-secret-0123456789abcdef0123456789abcdef";
const WEB_APP_URL = "https://admin.example";

const USERS = {
  admin: randomUUID(),
  alice: randomUUID(),
  shadow: randomUUID(),
} as const;

type UserName = keyof typeof USERS;

// admin 持 templates.configure（owner/admin 默认）；alice 零角色——403 反例；
// shadow 无角色无凭据：邀请路径的收件人。角色走真 user_role 表 + 真 authzStore。
const USER_ROLES: Partial<Record<UserName, "admin">> = { admin: "admin" };

function sessionFor(userId: string, name: string): SessionData {
  const displayName = name.charAt(0).toUpperCase() + name.slice(1);
  return {
    user: {
      id: userId,
      email: `${name}@example.com`,
      name: displayName,
      emailVerified: true,
      twoFactorEnabled: true,
    },
    session: { id: `s-${userId}`, userId, expiresAt: new Date(Date.now() + 3_600_000) },
  };
}

function adminUrl(databaseUrl: string | undefined): string {
  if (databaseUrl === undefined) return "";
  const url = new URL(databaseUrl);
  url.pathname = "/postgres";
  return url.toString();
}

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

describe.skipIf(!databaseUrl)("system template endpoints (#225 slice 2, integration)", () => {
  const dbName = `templates_test_${String(Date.now())}_${String(process.pid)}`;
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
  pool.on("error", () => {});
  admin.pool.on("error", () => {});

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
    authHandler: () => Promise.reject(new Error("auth handler should not be called")),
    resolveSession: (headers) => {
      const who = headers.get("x-test-user");
      if (who === null || !(who in USERS)) return Promise.resolve(null);
      const name = who as UserName;
      return Promise.resolve(sessionFor(USERS[name], name));
    },
    socialProviders: [],
    storage: {
      put: () => Promise.reject(new Error("storage not used in this suite")),
      signedGetUrl: () => Promise.reject(new Error("storage not used in this suite")),
      signedPutUrl: () => Promise.reject(new Error("storage not used in this suite")),
      delete: () => Promise.reject(new Error("storage not used in this suite")),
      head: () => Promise.reject(new Error("storage not used in this suite")),
    },
    authzStore: createAuthzStore(db),
    notifyUsers: () => Promise.resolve(),
  });

  // 邀请端到端：真 better-auth（request-password-reset 按凭据存在性分流邀请措辞）
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
  const authApp = createApp({
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
    storage: {
      put: () => Promise.reject(new Error("storage not used in this suite")),
      signedGetUrl: () => Promise.reject(new Error("storage not used in this suite")),
      signedPutUrl: () => Promise.reject(new Error("storage not used in this suite")),
      delete: () => Promise.reject(new Error("storage not used in this suite")),
      head: () => Promise.reject(new Error("storage not used in this suite")),
    },
    authzStore: createAuthzStore(db),
    notifyUsers: () => Promise.resolve(),
  });

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("unreachable: suite is skipped without DATABASE_URL");
    await admin.pool.query(`create database "${dbName}"`);
    await runMigrations(db);
    await db.insert(schema.authUser).values(
      (Object.keys(USERS) as UserName[]).map((name) => ({
        id: USERS[name],
        name: name.charAt(0).toUpperCase() + name.slice(1),
        email: `${name}@example.com`,
        emailVerified: true,
      })),
    );
    await db.insert(schema.userRole).values(
      (Object.entries(USER_ROLES) as [UserName, "admin"][]).map(([name, role]) => ({
        userId: USERS[name],
        role,
      })),
    );
  });

  beforeEach(async () => {
    await db.execute(
      sql`truncate table ${schema.systemTemplateVersions}, ${schema.systemTemplates}, ${schema.auditEvents} cascade`,
    );
  });

  afterAll(async () => {
    await pool.end();
    await admin.pool.query(`drop database if exists "${dbName}" with (force)`);
    await admin.pool.end();
  });

  const adminHeaders = { "x-test-user": "admin" };
  const aliceHeaders = { "x-test-user": "alice" };
  const jsonHeaders = { "content-type": "application/json" };

  async function createTemplate(headers: Record<string, string>, body: Record<string, unknown>) {
    return app.request("/api/templates", {
      method: "POST",
      headers: { ...headers, ...jsonHeaders },
      body: JSON.stringify(body),
    });
  }

  async function createInviteTemplate(): Promise<string> {
    const res = await createTemplate(adminHeaders, {
      channel: "email",
      templateType: "account_invite",
      subjectTemplate: "Custom invite for {{name}}",
      bodyTemplate: "<p>Welcome {{name}} — activate: {{link}}</p>",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    return body.id;
  }

  it("creates a template with version 1, a version row, and an audit entry", async () => {
    const res = await createTemplate(adminHeaders, {
      channel: "email",
      templateType: "account_invite",
      subjectTemplate: "Welcome, {{name}}",
      bodyTemplate: "<p>Hi {{name}}, set up your account: {{link}}</p>",
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };

    const detailRes = await app.request(`/api/templates/${id}`, { headers: adminHeaders });
    expect(detailRes.status).toBe(200);
    const detail = (await detailRes.json()) as {
      template: { version: number; isActive: boolean; channel: string; templateType: string };
      versions: { version: number }[];
    };
    expect(detail.template.version).toBe(1);
    expect(detail.template.isActive).toBe(true);
    expect(detail.versions).toHaveLength(1);
    expect(detail.versions[0]?.version).toBe(1);

    const audits = await db.select().from(schema.auditEvents);
    expect(audits.some((a) => a.action === "template.created" && a.target === id)).toBe(true);
  });

  it("answers 409 template_exists on a duplicate (channel, templateType)", async () => {
    await createInviteTemplate();
    const res = await createTemplate(adminHeaders, {
      channel: "email",
      templateType: "account_invite",
      subjectTemplate: "Another",
      bodyTemplate: "<p>x</p>",
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("template_exists");
  });

  it("rejects unregistered channels and subject-less email templates (fail closed)", async () => {
    const unknown = await createTemplate(adminHeaders, {
      channel: "emale",
      templateType: "x",
      subjectTemplate: "s",
      bodyTemplate: "b",
    });
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as { error: string }).error).toBe("unknown_channel");

    const noSubject = await createTemplate(adminHeaders, {
      channel: "email",
      templateType: "account_invite",
      bodyTemplate: "<p>no subject</p>",
    });
    expect(noSubject.status).toBe(400);
    expect(((await noSubject.json()) as { error: string }).error).toBe("subject_required");
  });

  it("lists templates with the registered channel catalog", async () => {
    await createInviteTemplate();
    const res = await app.request("/api/templates", { headers: adminHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      channels: { channel: string }[];
      templates: { templateType: string }[];
    };
    expect(body.channels.some((c) => c.channel === "email")).toBe(true);
    expect(body.templates.some((t) => t.templateType === "account_invite")).toBe(true);
  });

  it("PATCH with content change bumps the version and appends an immutable version row", async () => {
    const id = await createInviteTemplate();
    const res = await app.request(`/api/templates/${id}`, {
      method: "PATCH",
      headers: { ...adminHeaders, ...jsonHeaders },
      body: JSON.stringify({
        subjectTemplate: "Welcome, {{name}}!",
        bodyTemplate: "<p>Hi {{name}}, set up your account: {{link}}</p>",
        isActive: true,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { template: { version: number }; updated: boolean };
    expect(body.updated).toBe(true);
    expect(body.template.version).toBe(2);

    const detail = (await (
      await app.request(`/api/templates/${id}`, { headers: adminHeaders })
    ).json()) as { versions: { version: number }[] };
    expect(detail.versions.map((v) => v.version)).toEqual([2, 1]);

    const audits = await db.select().from(schema.auditEvents);
    const update = audits.find((a) => a.action === "template.updated");
    expect(update).toBeDefined();
    const detail_ = update?.detail as { changes: Record<string, unknown>; newVersion: number };
    expect(detail_.newVersion).toBe(2);
    // jsonb 会重排键序：比集合不比顺序
    expect(Object.keys(detail_.changes).sort()).toEqual(["bodyTemplate", "subjectTemplate"]);
  });

  it("PATCH with only the active flag keeps the version (a toggle is not content)", async () => {
    const id = await createInviteTemplate();
    const res = await app.request(`/api/templates/${id}`, {
      method: "PATCH",
      headers: { ...adminHeaders, ...jsonHeaders },
      body: JSON.stringify({
        subjectTemplate: "Custom invite for {{name}}",
        bodyTemplate: "<p>Welcome {{name}} — activate: {{link}}</p>",
        isActive: false,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { template: { version: number; isActive: boolean } };
    expect(body.template.version).toBe(1);
    expect(body.template.isActive).toBe(false);

    const detail = (await (
      await app.request(`/api/templates/${id}`, { headers: adminHeaders })
    ).json()) as { versions: { version: number }[] };
    expect(detail.versions).toHaveLength(1);
  });

  it("PATCH with no effective change is idempotent and leaves no audit row", async () => {
    const id = await createInviteTemplate();
    const res = await app.request(`/api/templates/${id}`, {
      method: "PATCH",
      headers: { ...adminHeaders, ...jsonHeaders },
      body: JSON.stringify({
        subjectTemplate: "Custom invite for {{name}}",
        bodyTemplate: "<p>Welcome {{name}} — activate: {{link}}</p>",
        isActive: true,
      }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { updated: boolean }).updated).toBe(false);
    const audits = await db.select().from(schema.auditEvents);
    expect(audits.filter((a) => a.action === "template.updated")).toHaveLength(0);
  });

  it("rollback restores old content as a NEW version (history is never rewritten)", async () => {
    const id = await createInviteTemplate();
    await app.request(`/api/templates/${id}`, {
      method: "PATCH",
      headers: { ...adminHeaders, ...jsonHeaders },
      body: JSON.stringify({
        subjectTemplate: "V2 subject",
        bodyTemplate: "<p>v2</p>",
        isActive: true,
      }),
    });
    const res = await app.request(`/api/templates/${id}/rollback`, {
      method: "POST",
      headers: { ...adminHeaders, ...jsonHeaders },
      body: JSON.stringify({ version: 1 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      template: { version: number; subjectTemplate: string };
    };
    expect(body.template.version).toBe(3);
    expect(body.template.subjectTemplate).toBe("Custom invite for {{name}}");

    const detail = (await (
      await app.request(`/api/templates/${id}`, { headers: adminHeaders })
    ).json()) as { versions: { version: number; bodyTemplate: string }[] };
    expect(detail.versions.map((v) => v.version)).toEqual([3, 2, 1]);
    expect(detail.versions[2]?.bodyTemplate).toBe("<p>Welcome {{name}} — activate: {{link}}</p>");

    const audits = await db.select().from(schema.auditEvents);
    const rollback = audits.find((a) => a.action === "template.rolled_back");
    expect(rollback).toBeDefined();

    const missing = await app.request(`/api/templates/${id}/rollback`, {
      method: "POST",
      headers: { ...adminHeaders, ...jsonHeaders },
      body: JSON.stringify({ version: 99 }),
    });
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: string }).error).toBe("version_not_found");
  });

  it("preview renders without persisting and reports missing variables", async () => {
    const res = await app.request("/api/templates/preview", {
      method: "POST",
      headers: { ...adminHeaders, ...jsonHeaders },
      body: JSON.stringify({
        subjectTemplate: "Hi {{name}}",
        bodyTemplate: "<p>Hello {{name}}, go to {{link}} — from {{company}}</p>",
        vars: { name: "Ada" },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      subject: string;
      body: string;
      referencedVariables: string[];
      missingVariables: string[];
    };
    expect(body.subject).toBe("Hi Ada");
    expect(body.body).toBe("<p>Hello Ada, go to {{link}} — from {{company}}</p>");
    expect(body.referencedVariables).toEqual(["name", "link", "company"]);
    expect(body.missingVariables).toEqual(["link", "company"]);
  });

  it("answers 403 for a user without templates.configure on every mutation", async () => {
    const create = await createTemplate(aliceHeaders, {
      channel: "email",
      templateType: "account_invite",
      subjectTemplate: "s",
      bodyTemplate: "b",
    });
    expect(create.status).toBe(403);
    const list = await app.request("/api/templates", { headers: aliceHeaders });
    expect(list.status).toBe(403);
    const preview = await app.request("/api/templates/preview", {
      method: "POST",
      headers: { ...aliceHeaders, ...jsonHeaders },
      body: JSON.stringify({ bodyTemplate: "b" }),
    });
    expect(preview.status).toBe(403);
  });

  it("resolveAuthEmail: active template overrides, inactive/missing falls back to builtin", async () => {
    const content = {
      to: "newhire@example.com",
      name: "Grace <b>Hopper</b>",
      link: "https://admin.example/reset-password?token=t1&a=b",
      expiry: "24 hours",
    };
    const builtin = renderAccountInviteEmail(content);

    // 行不在 → 内置
    const fallback = await resolveAuthEmail(db, logger, "account_invite", content, renderAccountInviteEmail);
    expect(fallback.subject).toBe(builtin.subject);

    await createInviteTemplate();

    // 行在且启用 → 模板接管：name 在正文里转义（BUG-285），link 原样，主题未转义
    const overridden = await resolveAuthEmail(db, logger, "account_invite", content, renderAccountInviteEmail);
    expect(overridden.subject).toBe("Custom invite for Grace <b>Hopper</b>");
    expect(overridden.html).toContain("Grace &lt;b&gt;Hopper&lt;/b&gt;");
    expect(overridden.html).toContain("https://admin.example/reset-password?token=t1&a=b");
    expect(overridden.html).not.toContain("{{link}}");

    // 停用 → 回内置
    const rows = await db.select().from(schema.systemTemplates);
    const templateId = must(rows[0]?.id);
    await app.request(`/api/templates/${templateId}`, {
      method: "PATCH",
      headers: { ...adminHeaders, ...jsonHeaders },
      body: JSON.stringify({
        subjectTemplate: "Custom invite for {{name}}",
        bodyTemplate: "<p>Welcome {{name}} — activate: {{link}}</p>",
        isActive: false,
      }),
    });
    const afterDisable = await resolveAuthEmail(db, logger, "account_invite", content, renderAccountInviteEmail);
    expect(afterDisable.subject).toBe(builtin.subject);

    await db.delete(schema.systemTemplates).where(eq(schema.systemTemplates.id, templateId));
    const afterDelete = await resolveAuthEmail(db, logger, "account_invite", content, renderAccountInviteEmail);
    expect(afterDelete.subject).toBe(builtin.subject);
  });

  it("invite email end to end: admin-authored template reaches the mail, disable restores builtin", async () => {
    await createInviteTemplate();

    const request = () =>
      authApp.request("/api/auth/request-password-reset", {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ email: "shadow@example.com" }),
      });
    let res = await request();
    expect(res.status).toBe(200);
    expect(mailer.sent.length).toBe(1);
    const invited = must(mailer.sent[0]);
    expect(invited.subject).toBe("Custom invite for Shadow");
    expect(invited.html).toContain("Welcome Shadow — activate: https://admin.example/reset-password?token=");

    // 停用模板 → 同一条重置链路回内置邀请文案（isActive=false 的真实语义）
    const rows = await db.select().from(schema.systemTemplates);
    const templateId = must(rows[0]?.id);
    await app.request(`/api/templates/${templateId}`, {
      method: "PATCH",
      headers: { ...adminHeaders, ...jsonHeaders },
      body: JSON.stringify({
        subjectTemplate: "Custom invite for {{name}}",
        bodyTemplate: "<p>Welcome {{name}} — activate: {{link}}</p>",
        isActive: false,
      }),
    });
    res = await request();
    expect(res.status).toBe(200);
    expect(mailer.sent.length).toBe(2);
    expect(must(mailer.sent[1]).subject).toBe("Set up your Ally OS account");
  });
});
