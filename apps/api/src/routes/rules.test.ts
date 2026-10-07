import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import pino from "pino";
import { z } from "zod";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, runMigrations, schema } from "@ally/db";
import { createApp } from "../app.ts";
import type { SessionData } from "../auth/session.ts";
import { createAuthzStore } from "../authz/service.ts";
import { applyDueRuleChanges } from "@ally/rules";
import {
  changeRuleValue,
  GateExceptionDisabledError,
  GateExceptionForbiddenError,
  GateExceptionReasonRequiredError,
  GateUnbypassableError,
  getRule,
  getRuleRow,
  isRuleEnabled,
  recordRuleOutcome,
  requestGateException,
  RuleNotFoundError,
  RuleNotSetError,
} from "../rules/service.ts";

// 集成测试：需要真实 PostgreSQL（迁移种子、台账版本、回滚、审计行断言）。未设
// DATABASE_URL 时跳过。
//
// 独立临时库（每次运行新建、跑完 drop，纪律同 config-drafts.test.ts）。与其它
// 套件不同，这里**不做 beforeEach 清库**：58 条种子规则与它们的 v1 台账行是断言
// 面（回滚测试依赖种子建的 v1 快照），清了就得重放种子 SQL。隔离靠「每个测试动
// 自己的那条规则」+ 按规则 id / key 限定断言（台账与审计是追加型表，行数本身
// 不是断言面）。

const databaseUrl = process.env.DATABASE_URL;

const logger = pino({ level: "silent" });

/** owner/admin 持 rules.configure（回滚的族门）；lead 是 sales_lead（多条规则的
 * 谁能改）；sage 零角色——403 的反例面。走真表 + 真 authzStore。 */
const USERS = {
  owner: randomUUID(),
  admin: randomUUID(),
  lead: randomUUID(),
  sage: randomUUID(),
} as const;

type UserName = keyof typeof USERS;

const USER_ROLES: Partial<Record<UserName, "owner" | "admin" | "sales_lead">> = {
  owner: "owner",
  admin: "admin",
  lead: "sales_lead",
};

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

interface RuleView {
  id: string;
  key: string;
  label: string;
  category: string;
  valueType: string;
  value: unknown;
  isSet: boolean;
  changeableBy: string[];
  enableBy: string[] | null;
  adjudicationRefs: string[];
  riskFlag: boolean;
  riskNote: string | null;
  scheduled: { value: unknown; effectiveAt: string; rationale: { refs: string[] } | null } | null;
  counts: { triggers: number; exceptions: number; overrides: number };
  version: number;
}

describe.skipIf(!databaseUrl)("rule registry: adjudication as configuration (#233 slice 1, integration)", () => {
  const dbName = `rules_test_${String(Date.now())}_${String(process.pid)}`;
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
    // 本套件不 exercise 附件端点；真被调到会在这里大声炸（AppDeps.storage 必选）
    storage: {
      put: () => Promise.reject(new Error("storage not used in this suite")),
      signedGetUrl: () => Promise.reject(new Error("storage not used in this suite")),
      signedPutUrl: () => Promise.reject(new Error("storage not used in this suite")),
      delete: () => Promise.reject(new Error("storage not used in this suite")),
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
      Object.entries(USER_ROLES).map(([name, role]) => ({
        userId: USERS[name as UserName],
        role: must(role),
      })),
    );
  });

  afterAll(async () => {
    await pool.end();
    await admin.pool.query(`drop database if exists "${dbName}" with (force)`);
    await admin.pool.end();
  });

  const ownerHeaders = { "x-test-user": "owner" };
  const adminHeaders = { "x-test-user": "admin" };
  const leadHeaders = { "x-test-user": "lead" };
  const sageHeaders = { "x-test-user": "sage" };
  const jsonHeaders = { "content-type": "application/json" };

  async function patch(key: string, body: unknown, headers: Record<string, string>): Promise<Response> {
    return app.request(`/api/rules/${key}`, {
      method: "PATCH",
      headers: { ...jsonHeaders, ...headers },
      body: JSON.stringify(body),
    });
  }

  async function getRuleView(key: string): Promise<RuleView> {
    const res = await app.request(`/api/rules/${key}`, { headers: adminHeaders });
    expect(res.status).toBe(200);
    return (await res.json() as { rule: RuleView }).rule;
  }

  async function revisionRows(ruleId: string): Promise<{ version: number; source: string }[]> {
    const rows = await db
      .select({ version: schema.configRevisions.version, source: schema.configRevisions.source })
      .from(schema.configRevisions)
      .where(
        and(
          eq(schema.configRevisions.subjectType, "registry_rule"),
          eq(schema.configRevisions.subjectId, ruleId),
        ),
      );
    return rows.sort((a, b) => a.version - b.version);
  }

  async function auditsByKey(action: string, key: string): Promise<typeof schema.auditEvents.$inferSelect[]> {
    return db
      .select()
      .from(schema.auditEvents)
      .where(
        and(
          eq(schema.auditEvents.action, action),
          sql`${schema.auditEvents.detail} ->> 'key' = ${key}`,
        ),
      );
  }

  it("seeds the full first batch with ledger v1 rows", async () => {
    const res = await app.request("/api/rules", { headers: sageHeaders });
    expect(res.status).toBe(200);
    const parsed = (await res.json()) as { rules: RuleView[] };
    expect(parsed.rules).toHaveLength(58);
    const keys = new Set(parsed.rules.map((r) => r.key));
    // 参数默认值来自裁决
    const waste = must(parsed.rules.find((r) => r.key === "pricing.waste_rate_pct"));
    expect(waste.value).toBe(10);
    expect(waste.category).toBe("param");
    expect(waste.adjudicationRefs).toEqual(["R-06-4"]);
    // 开关默认关 + 启用需老板确认（R-01-6）
    const reclaim = must(parsed.rules.find((r) => r.key === "crm.lead_auto_reclaim_enabled"));
    expect(reclaim.value).toBe(false);
    expect(reclaim.changeableBy).toEqual(["sales_lead"]);
    expect(reclaim.enableBy).toEqual(["owner"]);
    // 业务门槛例外默认关；风险开关默认关且带 ⚠；可插拔模块默认不启用
    expect(must(keys.has("gates.business_exception_enabled"))).toBe(true);
    const gate = must(parsed.rules.find((r) => r.key === "gates.business_exception_enabled"));
    expect(gate.value).toBe(false);
    const undercost = must(parsed.rules.find((r) => r.key === "alerts.undercost_quote_enabled"));
    expect(undercost.value).toBe(false);
    expect(undercost.riskFlag).toBe(true);
    expect(undercost.riskNote).not.toBeNull();
    const sop = must(parsed.rules.find((r) => r.key === "modules.sop_enabled"));
    expect(sop.value).toBe(false);
    // 决策表首种子（#221 审批路线）：gate 类别、decision_table 值、grant/revoke →
    // role_grant（与 #221 切片 2 的硬编码行为逐条等价——「进哪条线」从代码搬进配置）
    const routing = must(parsed.rules.find((r) => r.key === "approval.routing.user_role"));
    expect(routing.category).toBe("gate");
    expect(routing.valueType).toBe("decision_table");
    expect(routing.value).toEqual({
      hitPolicy: "first",
      inputs: [{ id: "in_action", field: "action", name: "Action" }],
      outputs: [{ id: "out_config", field: "configKey", name: "Approval line" }],
      rules: [
        { _id: "r-grant", in_action: "== 'grant'", out_config: "'role_grant'" },
        { _id: "r-revoke", in_action: "== 'revoke'", out_config: "'role_grant'" },
      ],
    });
    expect(routing.changeableBy).toEqual(["admin"]);
    expect(routing.adjudicationRefs).toEqual(["R-16-6"]);
    // 待填规则 value = null
    const refund = must(parsed.rules.find((r) => r.key === "refunds.owner_approval_threshold_usd"));
    expect(refund.value).toBeNull();
    expect(refund.isSet).toBe(false);
    // 种子规则的 v1 台账行（0019 补账先例：行.version = 台账最新版从第一行成立）
    const wasteId = waste.id;
    const history = await app.request(`/api/config-versions/registry_rule/${wasteId}`, {
      headers: adminHeaders,
    });
    expect(history.status).toBe(200);
    const parsedHistory = (await history.json()) as {
      revisions: { version: number; source: string; changedById: string | null }[];
    };
    expect(parsedHistory.revisions).toHaveLength(1);
    expect(parsedHistory.revisions[0]?.source).toBe("created");
    expect(parsedHistory.revisions[0]?.changedById).toBeNull();
  });

  it("keeps hard bottom lines out of the registry", async () => {
    const res = await app.request("/api/rules", { headers: sageHeaders });
    const parsed = (await res.json()) as { rules: RuleView[] };
    const keys = parsed.rules.map((r) => r.key);
    // §4.5：营销短信禁发、STOP、一键退订、Part 11、质量放行职责分离、数据隔离
    // 都是代码里的硬底线，任何配置都关不掉——注册表里没有也不允许有这些键
    for (const banned of [
      "hardline.marketing_sms",
      "hardline.sms_stop",
      "hardline.email_unsubscribe",
      "hardline.part11_signature",
      "hardline.qa_release_separation",
      "hardline.data_isolation",
    ]) {
      expect(keys).not.toContain(banned);
      const attempt = await app.request(`/api/rules/${banned}`, {
        method: "PATCH",
        headers: { ...jsonHeaders, ...ownerHeaders },
        body: JSON.stringify({ value: false, rationale: { refs: ["R-99-9"] } }),
      });
      expect(attempt.status).toBe(404);
    }
  });

  it("answers detail for a single rule and 404 for unknown keys", async () => {
    const waste = await getRuleView("pricing.waste_rate_pct");
    expect(waste.changeableBy).toEqual(["admin"]);
    expect(waste.enableBy).toBeNull();
    expect(waste.counts).toEqual({ triggers: 0, exceptions: 0, overrides: 0 });
    expect(waste.scheduled).toBeNull();
    const missing = await app.request("/api/rules/nonexistent.rule", { headers: adminHeaders });
    expect(missing.status).toBe(404);
    expect((await missing.json() as { error: string }).error).toBe("rule_not_found");
  });

  it("requires a fresh adjudication ref on every change", async () => {
    const noRationale = await patch("pricing.waste_rate_pct", { value: 8 }, adminHeaders);
    expect(noRationale.status).toBe(400);
    const emptyRefs = await patch(
      "pricing.waste_rate_pct",
      { value: 8, rationale: { refs: [] } },
      adminHeaders,
    );
    expect(emptyRefs.status).toBe(400);
    const missingValue = await app.request("/api/rules/pricing.waste_rate_pct", {
      method: "PATCH",
      headers: { ...jsonHeaders, ...adminHeaders },
      body: JSON.stringify({ rationale: { refs: ["R-06-4"] } }),
    });
    expect(missingValue.status).toBe(400);
    const waste = await getRuleRow(db, "pricing.waste_rate_pct");
    expect(waste?.version).toBe(1);
  });

  it("rejects changes from users outside the rule's changeable roles", async () => {
    const sales = await patch(
      "pricing.waste_rate_pct",
      { value: 8, rationale: { refs: ["R-06-4"] } },
      sageHeaders,
    );
    expect(sales.status).toBe(403);
    expect(await sales.json()).toEqual({
      error: "forbidden",
      code: "role_required",
      roles: ["admin", "owner"],
    });
    // owner 直通：changeableBy 只写裁决里的角色，owner 由代码强制恒可
    const leadOnOwnerRule = await patch(
      "orders.deposit_min_pct",
      { value: 40, rationale: { refs: ["R-08-2"] } },
      leadHeaders,
    );
    expect(leadOnOwnerRule.status).toBe(403);
    expect(await leadOnOwnerRule.json()).toEqual({
      error: "forbidden",
      code: "role_required",
      roles: ["owner"],
    });
  });

  it("answers 404 for unknown keys on change", async () => {
    const res = await patch("no.such_key", { value: 1, rationale: { refs: ["R-00-1"] } }, adminHeaders);
    expect(res.status).toBe(404);
  });

  it("validates the value against the rule's value type", async () => {
    const wrongType = await patch(
      "pricing.waste_rate_pct",
      { value: "eight", rationale: { refs: ["R-06-4"] } },
      adminHeaders,
    );
    expect(wrongType.status).toBe(400);
    expect((await wrongType.json() as { error: string }).error).toBe("invalid_value");
    const nullOnSwitch = await patch(
      "crm.lead_cooldown_enabled",
      { value: null, rationale: { refs: ["R-01-8"] } },
      adminHeaders,
    );
    expect(nullOnSwitch.status).toBe(400);
  });

  it("patches a decision table by ruling and rejects syntax-broken cells at the write face (#233)", async () => {
    const repointed = {
      hitPolicy: "first",
      inputs: [{ id: "in_action", field: "action", name: "Action" }],
      outputs: [{ id: "out_config", field: "configKey", name: "Approval line" }],
      rules: [
        { _id: "r-grant", in_action: "== 'grant'", out_config: "'role_grant'" },
        { _id: "r-revoke", in_action: "== 'revoke'", out_config: "'escrow_line'" },
      ],
    };
    const ok = await patch(
      "approval.routing.user_role",
      { value: repointed, rationale: { refs: ["R-16-6"], note: "revoke routed to escrow" } },
      adminHeaders,
    );
    expect(ok.status).toBe(200);
    const parsed = (await ok.json() as { changed: boolean; mode: string; rule: RuleView });
    expect(parsed.changed).toBe(true);
    expect(parsed.rule.value).toEqual(repointed);
    expect(parsed.rule.version).toBe(2);

    // 形状错（未知列/未知键/非字符串单元格）与语法错都在 400，进不了注册表
    const badCell = await patch(
      "approval.routing.user_role",
      {
        value: { ...repointed, rules: [{ _id: "r", in_action: "(((", out_config: "'x'" }] },
        rationale: { refs: ["R-16-6"] },
      },
      adminHeaders,
    );
    expect(badCell.status).toBe(400);
    expect(await badCell.json()).toMatchObject({ error: "invalid_value" });
    const badShape = await patch(
      "approval.routing.user_role",
      { value: { nonsense: true }, rationale: { refs: ["R-16-6"] } },
      adminHeaders,
    );
    expect(badShape.status).toBe(400);
    // 定时变更过同一扇编译门（输出单元格语法错——裸词能解析成 null 会被放行，
    // 静默空输出由消费域的 fail closed 兜底；这里钉的是真语法错）
    const scheduledBad = await patch(
      "approval.routing.user_role",
      {
        value: { ...repointed, rules: [{ _id: "r", in_action: "== 'x'", out_config: "(((" }] },
        rationale: { refs: ["R-16-6"] },
        effectiveAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
      adminHeaders,
    );
    expect(scheduledBad.status).toBe(400);
    // 库里的生效值未被失败的请求动过
    expect((await getRuleView("approval.routing.user_role")).version).toBe(2);
  });

  it("rolls a decision-table rule back through the ledger to the seeded table (#233)", async () => {
    const routing = await getRuleView("approval.routing.user_role");
    const rollback = await app.request(
      `/api/config-versions/registry_rule/${routing.id}/rollback`,
      {
        method: "POST",
        headers: { ...jsonHeaders, ...adminHeaders },
        body: JSON.stringify({ toVersion: 1, reason: "restore seeded routing" }),
      },
    );
    expect(rollback.status).toBe(200);
    const after = await getRuleView("approval.routing.user_role");
    expect(after.version).toBe(3);
    expect(after.value).toEqual({
      hitPolicy: "first",
      inputs: [{ id: "in_action", field: "action", name: "Action" }],
      outputs: [{ id: "out_config", field: "configKey", name: "Approval line" }],
      rules: [
        { _id: "r-grant", in_action: "== 'grant'", out_config: "'role_grant'" },
        { _id: "r-revoke", in_action: "== 'revoke'", out_config: "'role_grant'" },
      ],
    });
    const rows = await revisionRows(routing.id);
    expect(rows.map((r) => r.source)).toEqual(["created", "updated", "rolled_back"]);
  });

  it("applies an immediate change with ledger revision and audit", async () => {
    const res = await patch(
      "pricing.waste_rate_pct",
      { value: 8, rationale: { refs: ["R-06-4", "OWNER-DECISION-2026-10-06"], note: "yield improved" } },
      adminHeaders,
    );
    expect(res.status).toBe(200);
    const parsed = (await res.json()) as { changed: boolean; mode: string; rule: RuleView };
    expect(parsed.changed).toBe(true);
    expect(parsed.mode).toBe("immediate");
    expect(parsed.rule.value).toBe(8);
    expect(parsed.rule.version).toBe(2);
    expect(parsed.rule.adjudicationRefs).toEqual(["R-06-4", "OWNER-DECISION-2026-10-06"]);
    // 台账：v2 updated + changes.value from/to
    const wasteId = parsed.rule.id;
    const detail = await app.request(`/api/config-versions/registry_rule/${wasteId}/revisions/2`, {
      headers: adminHeaders,
    });
    expect(detail.status).toBe(200);
    const revision = (await detail.json()) as {
      revision: { source: string; changes: Record<string, { from: unknown; to: unknown }> };
    };
    expect(revision.revision.source).toBe("updated");
    expect(revision.revision.changes.value).toEqual({ from: 10, to: 8 });
    // 审计带 key 与依据
    const audits = await auditsByKey("rules.value_changed", "pricing.waste_rate_pct");
    expect(audits).toHaveLength(1);
    expect(audits[0]?.actor).toBe(USERS.admin);
    // 已发出的单据不受影响是消费域纪律（报价/合同记录当时的规则版本）——内核
    // 只保证「现在读注册表拿到新值」
    expect((await getRuleView("pricing.waste_rate_pct")).value).toBe(8);
  });

  it("treats a same-value change as a no-op without ledger or audit", async () => {
    const res = await patch(
      "pricing.fx_buffer_pct",
      { value: 3, rationale: { refs: ["R-06-5"] } },
      adminHeaders,
    );
    expect(res.status).toBe(200);
    const parsed = (await res.json()) as { changed: boolean };
    expect(parsed.changed).toBe(false);
    const rule = await getRuleRow(db, "pricing.fx_buffer_pct");
    expect(must(rule).version).toBe(1);
    expect(await revisionRows(must(rule).id)).toHaveLength(1);
    expect(await auditsByKey("rules.value_changed", "pricing.fx_buffer_pct")).toHaveLength(0);
  });

  it("gates switch enabling behind enableBy while disabling follows changeableBy", async () => {
    // 销售主管改参数可以，启用 R-01-6 需老板确认
    const enable = await patch(
      "crm.lead_auto_reclaim_enabled",
      { value: true, rationale: { refs: ["R-01-6"] } },
      leadHeaders,
    );
    expect(enable.status).toBe(403);
    expect(await enable.json()).toEqual({
      error: "forbidden",
      code: "role_required",
      roles: ["owner"],
    });
    const ownerEnable = await patch(
      "crm.lead_auto_reclaim_enabled",
      { value: true, rationale: { refs: ["R-01-6"] } },
      ownerHeaders,
    );
    expect(ownerEnable.status).toBe(200);
    expect((await ownerEnable.json() as { rule: RuleView }).rule.value).toBe(true);
    // 关掉回到销售主管的普通改权（enableBy 只管关→开）
    const disable = await patch(
      "crm.lead_auto_reclaim_enabled",
      { value: false, rationale: { refs: ["R-01-6"] } },
      leadHeaders,
    );
    expect(disable.status).toBe(200);
    expect((await disable.json() as { rule: RuleView }).rule.value).toBe(false);
  });

  it("schedules a change for a future date and applies it when due", async () => {
    const effectiveAt = new Date(Date.now() + 86_400_000);
    const schedule = await patch(
      "contracts.sign_reminder_interval_days",
      { value: 7, rationale: { refs: ["R-08-4"], note: "monthly cadence" }, effectiveAt: effectiveAt.toISOString() },
      adminHeaders,
    );
    expect(schedule.status).toBe(200);
    const parsed = (await schedule.json()) as { mode: string; changed: boolean; rule: RuleView };
    expect(parsed.mode).toBe("scheduled");
    expect(parsed.changed).toBe(true);
    // 生效前现值不变，待生效可见
    expect(parsed.rule.value).toBe(3);
    expect(parsed.rule.version).toBe(1);
    expect(parsed.rule.scheduled).not.toBeNull();
    expect(parsed.rule.scheduled?.value).toBe(7);
    expect(parsed.rule.scheduled?.effectiveAt).toBe(effectiveAt.toISOString());
    const scheduledAudit = await auditsByKey("rules.change_scheduled", "contracts.sign_reminder_interval_days");
    expect(scheduledAudit).toHaveLength(1);
    // 不到点不前滚
    const early = await applyDueRuleChanges(db, { now: new Date() });
    expect(early).toEqual([]);
    expect((await getRuleView("contracts.sign_reminder_interval_days")).value).toBe(3);
    // 到点前滚：值生效、待生效清空、台账 source='scheduled'（提交后审计归 worker
    // 的 rules-due-activation，见 apps/worker/src/rules/due-activation.test.ts）
    const applied = await applyDueRuleChanges(db, { now: new Date(Date.now() + 2 * 86_400_000) });
    expect(applied.map((a) => a.key)).toEqual(["contracts.sign_reminder_interval_days"]);
    const after = await getRuleView("contracts.sign_reminder_interval_days");
    expect(after.value).toBe(7);
    expect(after.version).toBe(2);
    expect(after.scheduled).toBeNull();
    const detail = await app.request(`/api/config-versions/registry_rule/${after.id}/revisions/2`, {
      headers: adminHeaders,
    });
    expect((await detail.json() as { revision: { source: string } }).revision.source).toBe("scheduled");
    // 再扫一遍无事可做
    expect(await applyDueRuleChanges(db, { now: new Date(Date.now() + 3 * 86_400_000) })).toEqual([]);
  });

  it("rejects an effective time in the past", async () => {
    const res = await patch(
      "contracts.sign_followup_days",
      { value: 21, rationale: { refs: ["R-08-4"] }, effectiveAt: new Date(Date.now() - 1000).toISOString() },
      adminHeaders,
    );
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe("invalid_effective_time");
  });

  it("rolls a rule back through the ledger and clears a pending scheduled change", async () => {
    // 先改一版（v2），再挂一个待生效变更，然后回滚到 v1
    const change = await patch(
      "procurement.po_receipt_variance_alert_pct",
      { value: 7, rationale: { refs: ["R-09-5"] } },
      adminHeaders,
    );
    expect(change.status).toBe(200);
    const changed = (await change.json() as { rule: RuleView }).rule;
    const schedule = await patch(
      "procurement.po_receipt_variance_alert_pct",
      { value: 9, rationale: { refs: ["R-09-5"] }, effectiveAt: new Date(Date.now() + 86_400_000).toISOString() },
      adminHeaders,
    );
    expect(schedule.status).toBe(200);
    // 回滚 = 改那行配置：先过族门（rules.configure），再过逐主体门（谁能改）
    const rollback = await app.request(
      `/api/config-versions/registry_rule/${changed.id}/rollback`,
      {
        method: "POST",
        headers: { ...jsonHeaders, ...adminHeaders },
        body: JSON.stringify({ toVersion: 1, reason: "revert trial" }),
      },
    );
    expect(rollback.status).toBe(200);
    const rolled = (await rollback.json()) as { restoredVersion: number; newVersion: number };
    expect(rolled.restoredVersion).toBe(1);
    expect(rolled.newVersion).toBe(3);
    const after = await getRuleView("procurement.po_receipt_variance_alert_pct");
    expect(after.value).toBe(5);
    expect(after.version).toBe(3);
    // 待生效变更从未入台账——回滚后的生效配置就是 v1 那份，定时改回 9 的暗门不存在
    expect(after.scheduled).toBeNull();
    const rows = await revisionRows(changed.id);
    expect(rows.map((r) => r.source)).toEqual(["created", "updated", "rolled_back"]);
  });

  it("enforces per-rule roles on the rollback face too", async () => {
    // 销售主管可改首联时限，但回滚先撞族门（rules.configure 是配置工作室面）
    const change = await patch(
      "crm.first_contact_sla_hours",
      { value: 20, rationale: { refs: ["R-01-4"] } },
      leadHeaders,
    );
    expect(change.status).toBe(200);
    const changed = (await change.json() as { rule: RuleView }).rule;
    const leadRollback = await app.request(
      `/api/config-versions/registry_rule/${changed.id}/rollback`,
      {
        method: "POST",
        headers: { ...jsonHeaders, ...leadHeaders },
        body: JSON.stringify({ toVersion: 1 }),
      },
    );
    expect(leadRollback.status).toBe(403);
    expect(await leadRollback.json()).toEqual({
      error: "forbidden",
      code: "permission_required",
      permission: "rules.configure",
    });
    // 管理员过族门，但预约提前量的谁能改只有销售主管——逐主体门把 admin 挡下
    const adminChange = await patch(
      "booking.lead_time_hours",
      { value: 2, rationale: { refs: ["R-04-9"] } },
      adminHeaders,
    );
    expect(adminChange.status).toBe(403);
    expect(await adminChange.json()).toEqual({
      error: "forbidden",
      code: "role_required",
      roles: ["sales_lead", "owner"],
    });
    const bookingRule = await getRuleRow(db, "booking.lead_time_hours");
    const adminRollback = await app.request(
      `/api/config-versions/registry_rule/${must(bookingRule).id}/rollback`,
      {
        method: "POST",
        headers: { ...jsonHeaders, ...adminHeaders },
        body: JSON.stringify({ toVersion: 1 }),
      },
    );
    expect(adminRollback.status).toBe(403);
    expect(await adminRollback.json()).toEqual({
      error: "forbidden",
      code: "role_required",
      roles: ["sales_lead", "owner"],
    });
  });

  it("answers 409 publish_unsupported for rule drafts", async () => {
    const rule = await getRuleRow(db, "pricing.quote_valid_days");
    const res = await app.request(`/api/config-drafts/registry_rule/${must(rule).id}`, {
      method: "PUT",
      headers: { ...jsonHeaders, ...adminHeaders },
      body: JSON.stringify({ content: { label: "Quote validity (days)" } }),
    });
    expect(res.status).toBe(409);
    expect((await res.json() as { error: string }).error).toBe("publish_unsupported");
  });

  it("lets the owner bypass a business gate with a reason once the switch is on", async () => {
    const gateKey = "gates.business_exception_enabled";
    // 默认关：owner 带原因也不行
    await expect(
      requestGateException(db, {
        actorId: USERS.owner,
        roles: ["owner"],
        kind: "business",
        gate: "workflow.gate:contract_signed",
        reason: "customer is strategic",
      }),
    ).rejects.toBeInstanceOf(GateExceptionDisabledError);
    // 质量门槛无条件拒绝——硬底线，开关与角色都救不了（§4.7「质量门槛不适用」）
    await expect(
      requestGateException(db, {
        actorId: USERS.owner,
        roles: ["owner"],
        kind: "quality",
        gate: "workflow.gate:qa_release",
        reason: "even the owner",
      }),
    ).rejects.toBeInstanceOf(GateUnbypassableError);
    // owner 打开例外开关（enableBy 未设 = changeableBy 裁决，owner-only）
    const enabled = await changeRuleValue(
      db,
      { roles: ["owner"] },
      { key: gateKey, actorId: USERS.owner, value: true, rationale: { refs: ["OWNER-DECISION-2026-09-30"] } },
    );
    expect(enabled).toEqual({ mode: "immediate", changed: true, version: 2 });
    // 无原因不行；非 owner 不行
    await expect(
      requestGateException(db, {
        actorId: USERS.owner,
        roles: ["owner"],
        kind: "business",
        gate: "workflow.gate:contract_signed",
        reason: "  ",
      }),
    ).rejects.toBeInstanceOf(GateExceptionReasonRequiredError);
    await expect(
      requestGateException(db, {
        actorId: USERS.admin,
        roles: ["admin"],
        kind: "business",
        gate: "workflow.gate:contract_signed",
        reason: "admins cannot bypass",
      }),
    ).rejects.toBeInstanceOf(GateExceptionForbiddenError);
    // owner 带原因越过：审计 + override 计数进运行数据（周报的数据源）
    await requestGateException(db, {
      actorId: USERS.owner,
      roles: ["owner"],
      kind: "business",
      gate: "workflow.gate:contract_signed",
      reason: "contract signature still in courier, PO is urgent",
      subjectType: "purchase_order",
    });
    const audits = await db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.action, "rules.gate_exception"));
    expect(audits).toHaveLength(1);
    expect(audits[0]?.actor).toBe(USERS.owner);
    const gateRule = await getRuleRow(db, gateKey);
    expect(must(gateRule).overrideCount).toBe(1);
    expect((await getRuleView(gateKey)).counts.overrides).toBe(1);
  });

  it("counts rule outcomes and fails loud on unknown keys", async () => {
    await recordRuleOutcome(db, "crm.first_contact_sla_hours", "triggered");
    await recordRuleOutcome(db, "crm.first_contact_sla_hours", "triggered");
    await recordRuleOutcome(db, "crm.first_contact_sla_hours", "exception");
    const rule = await getRuleRow(db, "crm.first_contact_sla_hours");
    expect(must(rule).triggerCount).toBe(2);
    expect(must(rule).exceptionCount).toBe(1);
    await expect(recordRuleOutcome(db, "no.such_key", "triggered")).rejects.toBeInstanceOf(
      RuleNotFoundError,
    );
  });

  it("reads rules through typed accessors that fail closed", async () => {
    expect(await getRule(db, "pricing.waste_rate_pct", z.number())).toBe(8);
    // 「待填」规则：值未设 = 抛错，消费方不猜默认值
    await expect(getRule(db, "refunds.owner_approval_threshold_usd", z.number())).rejects.toBeInstanceOf(
      RuleNotSetError,
    );
    await expect(getRule(db, "no.such_key", z.number())).rejects.toBeInstanceOf(RuleNotFoundError);
    expect(await isRuleEnabled(db, "crm.lead_cooldown_enabled")).toBe(false);
  });
});
