import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, runMigrations, schema } from "@ally/db";
import { resolveApprovalRoute } from "../approval/routing.ts";
import {
  assertDecisionTableCompiles,
  decisionTableValueSchema,
  InvalidDecisionTableError,
} from "./decision-table-schema.ts";
import { evaluateDecisionTableRule } from "./decision-table.ts";
import {
  changeRuleValue,
  InvalidRuleValueError,
  RuleNotFoundError,
  RuleNotSetError,
  RuleShapeError,
} from "./service.ts";

const databaseUrl = process.env.DATABASE_URL;

function must<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("unexpected missing value in test");
  return value;
}

function adminUrl(url: string | undefined): string {
  if (url === undefined) return "";
  const parsed = new URL(url);
  parsed.pathname = "/postgres";
  return parsed.toString();
}

/** 种子路由表（0023）：grant/revoke → role_grant。测试里改写它来验证路由语义 */
const seededRoutingTable = {
  hitPolicy: "first",
  inputs: [{ id: "in_action", field: "action", name: "Action" }],
  outputs: [{ id: "out_config", field: "configKey", name: "Approval line" }],
  rules: [
    { _id: "r-grant", in_action: "== 'grant'", out_config: "'role_grant'" },
    { _id: "r-revoke", in_action: "== 'revoke'", out_config: "'role_grant'" },
  ],
} as const;

/** 一张与种子无关的最小表（挂在自己的规则行上，不污染 approval.routing.*） */
const minimalTable = {
  hitPolicy: "first",
  inputs: [{ id: "in_amount", field: "amount" }],
  outputs: [{ id: "out_tier", field: "tier" }],
  rules: [{ _id: "r-big", in_amount: "> 100", out_tier: "'bulk'" }],
};

describe("decision table value shape (#233, pure)", () => {
  it("accepts a well-formed table", () => {
    const parsed = decisionTableValueSchema.safeParse(seededRoutingTable);
    expect(parsed.success).toBe(true);
  });

  it("rejects unknown hit policy, unknown top-level keys and non-string cells", () => {
    expect(
      decisionTableValueSchema.safeParse({ ...seededRoutingTable, hitPolicy: "Z" }).success,
    ).toBe(false);
    expect(
      decisionTableValueSchema.safeParse({ ...seededRoutingTable, transform: {} }).success,
    ).toBe(false);
    const nonStringCell = {
      ...minimalTable,
      rules: [{ _id: "r", in_amount: 42, out_tier: "'x'" }],
    };
    expect(decisionTableValueSchema.safeParse(nonStringCell).success).toBe(false);
  });

  it("rejects duplicate column ids, duplicate output fields and duplicate rule ids", () => {
    const dupColumn = {
      ...minimalTable,
      inputs: [{ id: "in_amount", field: "amount" }, { id: "in_amount", field: "other" }],
    };
    expect(decisionTableValueSchema.safeParse(dupColumn).success).toBe(false);
    const dupOutput = {
      ...minimalTable,
      outputs: [{ id: "o1", field: "tier" }, { id: "o2", field: "tier" }],
    };
    expect(decisionTableValueSchema.safeParse(dupOutput).success).toBe(false);
    const dupRule = {
      ...minimalTable,
      rules: [
        { _id: "r-big", in_amount: "> 100", out_tier: "'bulk'" },
        { _id: "r-big", in_amount: "< 10", out_tier: "'small'" },
      ],
    };
    expect(decisionTableValueSchema.safeParse(dupRule).success).toBe(false);
  });

  it("rejects rule cells referencing undeclared columns and rules without _id", () => {
    const unknownColumn = {
      ...minimalTable,
      rules: [{ _id: "r", nope: "== 1", out_tier: "'x'" }],
    };
    expect(decisionTableValueSchema.safeParse(unknownColumn).success).toBe(false);
    const noRuleId = {
      ...minimalTable,
      rules: [{ in_amount: "> 100", out_tier: "'bulk'" }],
    };
    expect(decisionTableValueSchema.safeParse(noRuleId).success).toBe(false);
  });

  it("requires at least one output column; empty rules is a legal (route-nothing) table", () => {
    const noOutputs = { hitPolicy: "first", inputs: [], outputs: [], rules: [] };
    expect(decisionTableValueSchema.safeParse(noOutputs).success).toBe(false);
    const emptyRules = { ...minimalTable, rules: [] };
    expect(decisionTableValueSchema.safeParse(emptyRules).success).toBe(true);
  });
});

describe("decision table compile gate (#233, pure)", () => {
  it("accepts the seeded table and empty cells (match-all semantics)", async () => {
    await expect(assertDecisionTableCompiles(seededRoutingTable)).resolves.toBeUndefined();
    await expect(
      assertDecisionTableCompiles({
        ...minimalTable,
        rules: [{ _id: "r", out_tier: "'x'" }],
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects syntax errors in input and output cells (ZEN would silently never match)", async () => {
    await expect(
      assertDecisionTableCompiles({
        ...minimalTable,
        rules: [{ _id: "r", in_amount: "(((", out_tier: "'x'" }],
      }),
    ).rejects.toBeInstanceOf(InvalidDecisionTableError);
    await expect(
      assertDecisionTableCompiles({
        ...minimalTable,
        rules: [{ _id: "r", in_amount: "> 100", out_tier: "(((" }],
      }),
    ).rejects.toBeInstanceOf(InvalidDecisionTableError);
    await expect(assertDecisionTableCompiles({ nonsense: true })).rejects.toBeInstanceOf(
      InvalidDecisionTableError,
    );
  });

  it("lets type mismatches through (runtime data question, not config validity)", async () => {
    await expect(
      assertDecisionTableCompiles({
        ...minimalTable,
        rules: [{ _id: "r", in_amount: "> 100", out_tier: "'x'" }],
      }),
    ).resolves.toBeUndefined();
  });
});

describe.skipIf(!databaseUrl)("decision table rule evaluation (#233, integration)", () => {
  const dbName = `decision_table_test_${String(Date.now())}_${String(process.pid)}`;
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

  const actorId = randomUUID();

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("unreachable: suite is skipped without DATABASE_URL");
    await admin.pool.query(`create database "${dbName}"`);
    await runMigrations(db);
    // 0023（ALTER TYPE ADD VALUE）+ 0024（COMMIT 边界 + 种子）跑通本身就是断言面：
    // drizzle 单事务跑全部迁移，新枚举值必须先提交后使用，routing 行带着
    // decision_table 值在 = 边界处理正确
    const seeded = await db
      .select({ value: schema.registryRules.value, valueType: schema.registryRules.valueType })
      .from(schema.registryRules)
      .where(eq(schema.registryRules.key, "approval.routing.user_role"))
      .limit(1);
    const seededRow = must(seeded[0]);
    expect(seededRow.valueType).toBe("decision_table");
    expect(seededRow.value).toEqual(seededRoutingTable);
    await db.insert(schema.authUser).values({
      id: actorId,
      name: "Steward",
      email: "steward@example.com",
      emailVerified: true,
    });
  });

  afterAll(async () => {
    await pool.end();
    await admin.pool.query(`drop database if exists "${dbName}" with (force)`);
    await admin.pool.end();
  });

  async function insertRule(key: string, value: unknown): Promise<string> {
    const id = randomUUID();
    await db.insert(schema.registryRules).values({
      id,
      key,
      label: `Test rule ${key}`,
      category: "param",
      valueType: "decision_table",
      value,
      changeableBy: ["admin"],
      adjudicationRefs: ["R-233-TEST"],
    });
    return id;
  }

  async function deleteRule(key: string): Promise<void> {
    await db.delete(schema.registryRules).where(eq(schema.registryRules.key, key));
  }

  it("evaluates the seeded routing table: grant/revoke match, unknown action does not", async () => {
    await expect(
      evaluateDecisionTableRule(db, "approval.routing.user_role", { action: "grant", role: "finance" }),
    ).resolves.toEqual({ configKey: "role_grant" });
    await expect(
      evaluateDecisionTableRule(db, "approval.routing.user_role", { action: "revoke", role: "admin" }),
    ).resolves.toEqual({ configKey: "role_grant" });
    await expect(
      evaluateDecisionTableRule(db, "approval.routing.user_role", { action: "whatever" }),
    ).resolves.toEqual({});
  });

  it("fails loud on missing rule, unset value and corrupt value", async () => {
    await expect(evaluateDecisionTableRule(db, "approval.routing.nobody", {})).rejects.toBeInstanceOf(
      RuleNotFoundError,
    );
    const unsetKey = "approval.routing.unset_test";
    await insertRule(unsetKey, null);
    await expect(evaluateDecisionTableRule(db, unsetKey, {})).rejects.toBeInstanceOf(RuleNotSetError);
    await deleteRule(unsetKey);

    const corruptKey = "approval.routing.corrupt_test";
    await insertRule(corruptKey, { hitPolicy: "first", inputs: [], outputs: [], rules: [] });
    await expect(evaluateDecisionTableRule(db, corruptKey, {})).rejects.toBeInstanceOf(RuleShapeError);
    await deleteRule(corruptKey);
  });

  it("resolveApprovalRoute folds all failure shapes into unmatched reasons", async () => {
    // 种子表：命中
    await expect(resolveApprovalRoute(db, "user_role", { action: "grant" })).resolves.toEqual({
      status: "matched",
      configKey: "role_grant",
    });
    // 表不存在
    await expect(resolveApprovalRoute(db, "nonsense_subject", {})).resolves.toEqual({
      status: "unmatched",
      reason: "no_route_rule",
    });
    // 值未设 / 坏表
    const unsetKey = "approval.routing.route_unset";
    await insertRule(unsetKey, null);
    await expect(resolveApprovalRoute(db, "route_unset", {})).resolves.toEqual({
      status: "unmatched",
      reason: "route_not_set",
    });
    await deleteRule(unsetKey);
    const corruptKey = "approval.routing.route_corrupt";
    await insertRule(corruptKey, { nope: true });
    await expect(resolveApprovalRoute(db, "route_corrupt", {})).resolves.toEqual({
      status: "unmatched",
      reason: "invalid_route_table",
    });
    await deleteRule(corruptKey);
    // 输出列不叫 configKey
    const renamedKey = "approval.routing.route_renamed";
    await insertRule(renamedKey, {
      hitPolicy: "first",
      inputs: [{ id: "i", field: "action" }],
      outputs: [{ id: "o", field: "target" }],
      rules: [{ _id: "r", i: "== 'x'", o: "'y'" }],
    });
    await expect(resolveApprovalRoute(db, "route_renamed", { action: "x" })).resolves.toEqual({
      status: "unmatched",
      reason: "invalid_route_output",
    });
    await deleteRule(renamedKey);
  });

  it("changeRuleValue repoints routes by ruling; compile gate rejects syntax-broken tables", async () => {
    const key = "approval.routing.user_role";
    const repointed = {
      ...seededRoutingTable,
      rules: [
        { _id: "r-grant", in_action: "== 'grant'", out_config: "'role_grant'" },
        { _id: "r-revoke", in_action: "== 'revoke'", out_config: "'escrow_line'" },
      ],
    };
    const result = await changeRuleValue(db, { roles: ["admin"] }, {
      key,
      actorId,
      value: repointed,
      rationale: { refs: ["R-16-6"], note: "revoke goes to escrow" },
    });
    expect(result).toEqual({ mode: "immediate", changed: true, version: 2 });
    await expect(resolveApprovalRoute(db, "user_role", { action: "revoke" })).resolves.toEqual({
      status: "matched",
      configKey: "escrow_line",
    });
    await expect(resolveApprovalRoute(db, "user_role", { action: "grant" })).resolves.toEqual({
      status: "matched",
      configKey: "role_grant",
    });

    await expect(
      changeRuleValue(db, { roles: ["admin"] }, {
        key,
        actorId,
        value: {
          ...seededRoutingTable,
          rules: [{ _id: "r", in_action: "(((", out_config: "'x'" }],
        },
        rationale: { refs: ["R-16-6"] },
      }),
    ).rejects.toBeInstanceOf(InvalidDecisionTableError);
    // 形状错被 zod 收口（InvalidRuleValueError），不是编译探针的锅
    await expect(
      changeRuleValue(db, { roles: ["admin"] }, {
        key,
        actorId,
        value: { nonsense: true },
        rationale: { refs: ["R-16-6"] },
      }),
    ).rejects.toBeInstanceOf(InvalidRuleValueError);
    // 定时变更过同一扇编译门：坏表即使定在未来也进不了注册表
    await expect(
      changeRuleValue(db, { roles: ["admin"] }, {
        key,
        actorId,
        value: {
          ...seededRoutingTable,
          rules: [{ _id: "r", in_action: "== 'grant'", out_config: "(((" }],
        },
        rationale: { refs: ["R-16-6"] },
        effectiveAt: new Date(Date.now() + 86_400_000),
      }),
    ).rejects.toBeInstanceOf(InvalidDecisionTableError);
    // 合法的定时变更正常落在待生效字段上（前滚由 applyDueRuleChanges 负责，已在
    // 注册表内核测试覆盖；这里钉的是「编译门不挡定时路径」）
    const scheduled = await changeRuleValue(db, { roles: ["admin"] }, {
      key,
      actorId,
      value: seededRoutingTable,
      rationale: { refs: ["R-16-6"] },
      effectiveAt: new Date(Date.now() + 86_400_000),
    });
    expect(scheduled).toMatchObject({ mode: "scheduled", changed: true });
  });

  it("evaluates a standalone decision-table rule beyond the routing seed", async () => {
    const key = "pricing.tier_rehearsal";
    const id = await insertRule(key, minimalTable);
    await expect(evaluateDecisionTableRule(db, key, { amount: 500 })).resolves.toEqual({
      tier: "bulk",
    });
    await expect(evaluateDecisionTableRule(db, key, { amount: 5 })).resolves.toEqual({});
    await db.delete(schema.registryRules).where(eq(schema.registryRules.id, id));
  });

  it("routes through a fresh table with a numeric threshold (amount-line rehearsal for #229/#231)", async () => {
    const key = "approval.routing.rehearsal";
    await insertRule(key, {
      hitPolicy: "first",
      inputs: [
        { id: "in_amount", field: "amount" },
        { id: "in_kind", field: "kind" },
      ],
      outputs: [{ id: "out_line", field: "configKey" }],
      rules: [
        { _id: "r-boss", in_amount: "> 10000", in_kind: "== 'po'", out_line: "'boss_line'" },
        { _id: "r-lead", in_amount: ">= 0", in_kind: "== 'po'", out_line: "'lead_line'" },
      ],
    });
    await expect(
      resolveApprovalRoute(db, "rehearsal", { amount: 25000, kind: "po" }),
    ).resolves.toEqual({ status: "matched", configKey: "boss_line" });
    await expect(
      resolveApprovalRoute(db, "rehearsal", { amount: 100, kind: "po" }),
    ).resolves.toEqual({ status: "matched", configKey: "lead_line" });
    await expect(
      resolveApprovalRoute(db, "rehearsal", { amount: 100, kind: "refund" }),
    ).resolves.toEqual({ status: "unmatched", reason: "no_matching_rule" });
    await deleteRule(key);
  });
});
