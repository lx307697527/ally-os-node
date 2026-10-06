import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, runMigrations, schema } from "@ally/db";
import { registerActionBlock } from "../workflow/blocks.ts";
import { createApp } from "../app.ts";
import { createAuth, createSessionResolver } from "../auth/auth.ts";
import { createAuthzStore } from "../authz/service.ts";
import type { MailMessage } from "@ally/mailer";

// 集成测试（#220 验收：「能为线索、商机、订单履约、偏差分别配置流程」的配置面）。
// 真实 PostgreSQL；未设 DATABASE_URL 跳过。本文件用独立的临时库（每次运行新建、
// 跑完 drop），断言模板行与审计行（纪律见 docs/audit.md「测试清库的唯一通道」）。
const databaseUrl = process.env.DATABASE_URL;

const logger = pino({ level: "silent" });
const SECRET = "test-secret-0123456789abcdef0123456789abcdef";
const PASSWORD = "correct-horse-battery";

const LEAD_FLOW = {
  initial: "new",
  states: {
    new: { on: { CONTACT: "contacted", DISQUALIFY: "disqualified" } },
    contacted: { on: { QUALIFY: "qualified" } },
    qualified: {},
    disqualified: {},
  },
};

// 夹具动作积木：保存路径用它断言「注册表里有的积木可被引用」（注册接缝与生产同路）
registerActionBlock("templates_fixture_action", () => Promise.resolve());

function must<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("unexpected missing value in test");
  return value;
}

describe.skipIf(!databaseUrl)("workflow templates route (#220, integration)", () => {
  const dbName = `workflow_templates_test_${String(Date.now())}_${String(process.pid)}`;
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
    authzStore: createAuthzStore(db),
    notifyUsers: async () => {},
  });

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("unreachable: suite is skipped without DATABASE_URL");
    await admin.pool.query(`create database "${dbName}"`);
    await runMigrations(db);
  });

  beforeEach(async () => {
    // 每条测试从空表开始（整库是本文件的；用户行不清——临时库整体生灭）。
    // 三张流程表一起清（instances 引用 templates，TRUNCATE 要求同语句）
    await db.execute(sql`truncate table ${schema.workflowTemplates}, ${schema.workflowInstances}, ${schema.workflowTransitions}`);
    await db.execute(sql`truncate table ${schema.auditEvents}`);
  });

  afterAll(async () => {
    await pool.end();
    await admin.pool.query(`drop database if exists "${dbName}" with (force)`);
    await admin.pool.end();
  });

  async function signUpVerified(): Promise<string> {
    const email = `${randomUUID()}@example.com`;
    const res = await app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: PASSWORD, name: "Test User" }),
    });
    expect(res.status).toBe(200);
    const userId = must((await res.json() as { user?: { id?: string } }).user?.id);
    // 邮箱验证：better-auth 默认拒绝未验证邮箱登录（403）——点邮件里的验证链接
    const message = must(mailer.sent[mailer.sent.length - 1]);
    const token = must(/token=([^"&\s<]+)/.exec(message.html)?.[1]);
    const confirm = await app.request(`/api/auth/verify-email?token=${encodeURIComponent(token)}`);
    expect(confirm.status).toBe(200);
    return userId;
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

  function cookiesNamed(res: Response, prefix: string): string[] {
    return res.headers.getSetCookie().filter((c) => c.startsWith(prefix)).map((c) => must(c.split(";")[0]));
  }

  async function signInAs(userId: string): Promise<string> {
    const rows = await db
      .select({ email: schema.authUser.email })
      .from(schema.authUser)
      .where(eq(schema.authUser.id, userId))
      .limit(1);
    const res = await app.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: must(rows[0]?.email), password: PASSWORD }),
    });
    expect(res.status).toBe(200);
    return must(cookiesNamed(res, "better-auth.session_token=")[0]);
  }

  async function grantRole(userId: string, role: "owner" | "sales") {
    await db.insert(schema.userRole).values({ userId, role }).onConflictDoNothing();
  }

  it("403s a plain user and 201s an owner creating a template", async () => {
    const plain = await signUpVerified();
    const plainCookie = await signInAs(plain);
    const denied = await app.request("/api/workflow-templates", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: plainCookie },
      body: JSON.stringify({ subjectType: "lead", templateKey: "standard", definition: LEAD_FLOW }),
    });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: "forbidden" });

    const owner = await signUpVerified();
    await grantRole(owner, "owner");
    const ownerCookie = await signInAs(owner);
    const created = await app.request("/api/workflow-templates", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: ownerCookie },
      body: JSON.stringify({ subjectType: "lead", templateKey: "standard", definition: LEAD_FLOW }),
    });
    expect(created.status).toBe(201);
    const id = must((await created.json() as { id?: string }).id);

    // 审计行同事务落库（workflow.template_created）
    const audits = await db
      .select({ action: schema.auditEvents.action, detail: schema.auditEvents.detail })
      .from(schema.auditEvents);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: "workflow.template_created" });
    expect(audits[0]?.detail).toMatchObject({ subjectType: "lead", templateKey: "standard" });

    const fetched = await app.request(`/api/workflow-templates/${id}`, {
      headers: { cookie: ownerCookie },
    });
    expect(fetched.status).toBe(200);
    expect((await fetched.json() as { template?: { definition?: unknown } }).template?.definition)
      .toEqual(LEAD_FLOW);
  });

  it("rejects invalid definitions and unregistered blocks with 422", async () => {
    const owner = await signUpVerified();
    await grantRole(owner, "owner");
    const cookie = await signInAs(owner);

    const badTopology = await app.request("/api/workflow-templates", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        subjectType: "lead",
        templateKey: "broken",
        definition: { initial: "new", states: { new: { on: { GO: "ghost" } } } },
      }),
    });
    expect(badTopology.status).toBe(422);
    expect(await badTopology.json()).toMatchObject({ error: "invalid_definition" });

    const unknownBlock = await app.request("/api/workflow-templates", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        subjectType: "lead",
        templateKey: "ghostly",
        definition: {
          initial: "new",
          states: {
            new: {
              entryActions: [{ name: "templates_fixture_action" }],
              on: { GO: { target: "done", gates: [{ name: "no_such_gate" }] } },
            },
            done: {},
          },
        },
      }),
    });
    expect(unknownBlock.status).toBe(422);
    expect(await unknownBlock.json()).toMatchObject({ error: "unknown_block", detail: { gates: ["no_such_gate"] } });
  });

  it("409s duplicate template keys and a second default per subject type", async () => {
    const owner = await signUpVerified();
    await grantRole(owner, "owner");
    const cookie = await signInAs(owner);

    const first = await app.request("/api/workflow-templates", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ subjectType: "lead", templateKey: "standard", definition: LEAD_FLOW }),
    });
    expect(first.status).toBe(201);
    const dup = await app.request("/api/workflow-templates", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ subjectType: "lead", templateKey: "standard", definition: LEAD_FLOW }),
    });
    expect(dup.status).toBe(409);
    expect(await dup.json()).toMatchObject({ error: "template_exists" });

    const defaultOne = await app.request("/api/workflow-templates", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ subjectType: "deviation", templateKey: "std_dev", isDefault: true, definition: LEAD_FLOW }),
    });
    expect(defaultOne.status).toBe(201);
    const defaultTwo = await app.request("/api/workflow-templates", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ subjectType: "deviation", templateKey: "other_dev", isDefault: true, definition: LEAD_FLOW }),
    });
    expect(defaultTwo.status).toBe(409);
    expect(await defaultTwo.json()).toMatchObject({ error: "default_template_exists" });

    // 结构不变式直接查库复核：deviation 的默认模板只有一行
    const defaults = await db
      .select({ key: schema.workflowTemplates.templateKey })
      .from(schema.workflowTemplates)
      .where(eq(schema.workflowTemplates.subjectType, "deviation"));
    expect(defaults).toHaveLength(1);
  });

  it("lists templates filtered by subject type", async () => {
    const owner = await signUpVerified();
    await grantRole(owner, "owner");
    const cookie = await signInAs(owner);
    for (const [subjectType, key] of [["lead", "std_lead"], ["order", "std_order"]] as const) {
      const res = await app.request("/api/workflow-templates", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ subjectType, templateKey: key, definition: LEAD_FLOW }),
      });
      expect(res.status).toBe(201);
    }
    const list = await app.request("/api/workflow-templates?subjectType=lead", {
      headers: { cookie },
    });
    expect(list.status).toBe(200);
    const body = await list.json() as { templates?: { subjectType: string }[] };
    expect(body.templates?.map((t) => t.subjectType)).toEqual(["lead"]);
  });
});

function adminUrl(databaseUrl: string | undefined): string {
  if (databaseUrl === undefined) return "";
  const url = new URL(databaseUrl);
  url.pathname = "/postgres";
  return url.toString();
}
