import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, runMigrations, schema } from "@ally/db";
import { applyDueRuleChanges } from "./due-activation.ts";
import { recordConfigRevision } from "./ledger.ts";

// 集成测试：需要真实 PostgreSQL（行锁事务、台账版本、审计外的记账协议）。未设
// DATABASE_URL 时跳过。独立临时库（每次运行新建、跑完 drop，纪律同 worker 的
// rules.test.ts）。这里不做 beforeEach 清库：registry_rules 动的是自建的 fixture
// 规则（key 前缀 dueact_），隔离靠 key + 按 id 限定断言。
const databaseUrl = process.env.DATABASE_URL;

function adminUrl(url: string | undefined): string {
  if (url === undefined) return "";
  const parsed = new URL(url);
  parsed.pathname = "/postgres";
  return parsed.toString();
}

function must<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("unexpected missing value in test");
  return value;
}

describe.skipIf(!databaseUrl)("applyDueRuleChanges (#233, integration)", () => {
  const dbName = `rules_pkg_test_${String(Date.now())}_${String(process.pid)}`;
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

  const scheduler = randomUUID();

  /** 自建一条带待生效变更的规则（不走 api 改值面——那是 apps/api 的测试面）。
   * 生产行出生即带 v1 台账行（0021 种子先例，「行.version = 台账最新版」不变式），
   * fixture 照此办理，激活才从 v2 起算 */
  async function insertScheduledRule(values: {
    scheduledValue: unknown;
    scheduledEffectiveAt: Date;
  }): Promise<string> {
    const inserted = await db
      .insert(schema.registryRules)
      .values({
        key: `dueact.${randomUUID()}`,
        label: "Fixture scheduled rule",
        category: "param",
        valueType: "number",
        value: 3,
        changeableBy: ["owner"],
        adjudicationRefs: ["R-99-1"],
        scheduledValue: values.scheduledValue,
        scheduledEffectiveAt: values.scheduledEffectiveAt,
        scheduledRationale: { refs: ["R-99-2"], note: "governance change" },
        scheduledById: scheduler,
      })
      .returning({ id: schema.registryRules.id });
    const id = must(inserted[0]).id;
    await recordConfigRevision(db, {
      subjectType: "registry_rule",
      subjectId: id,
      version: 1,
      actorId: scheduler,
      snapshot: { value: 3, adjudicationRefs: ["R-99-1"] },
      changes: null,
      source: "created",
    });
    return id;
  }

  async function ruleById(id: string) {
    const rows = await db.select().from(schema.registryRules).where(eq(schema.registryRules.id, id));
    return must(rows[0]);
  }

  async function revisions(ruleId: string) {
    return db
      .select()
      .from(schema.configRevisions)
      .where(eq(schema.configRevisions.subjectId, ruleId));
  }

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("unreachable: suite is skipped without DATABASE_URL");
    await admin.pool.query(`create database "${dbName}"`);
    await runMigrations(db);
    await db.insert(schema.authUser).values({
      id: scheduler,
      name: "Scheduler",
      email: "scheduler@example.com",
      emailVerified: true,
    });
  });

  afterAll(async () => {
    await pool.end();
    await admin.pool.query(`drop database if exists "${dbName}"`);
    await admin.pool.end();
  });

  it("applies a due change: value in, scheduled fields out, ledger records source='scheduled'", async () => {
    const id = await insertScheduledRule({
      scheduledValue: 7,
      scheduledEffectiveAt: new Date(Date.now() - 60_000),
    });
    const applied = await applyDueRuleChanges(db, { now: new Date() });
    const mine = applied.filter((a) => a.ruleId === id);
    expect(mine).toHaveLength(1);
    const act = must(mine[0]);
    expect(act.key).toMatch(/^dueact\./);
    expect(act.scheduledById).toBe(scheduler);
    expect(act.from).toBe(3);
    expect(act.to).toBe(7);
    expect(act.version).toBe(2);
    expect(act.rationale).toEqual({ refs: ["R-99-2"], note: "governance change" });

    const rule = await ruleById(id);
    expect(rule.value).toBe(7);
    expect(rule.scheduledValue).toBeNull();
    expect(rule.scheduledEffectiveAt).toBeNull();
    expect(rule.scheduledRationale).toBeNull();
    expect(rule.scheduledById).toBeNull();
    expect(rule.version).toBe(2);
    expect(rule.adjudicationRefs).toEqual(["R-99-2"]);

    // 台账两行：fixture 的 v1（created）+ 激活记的 v2（scheduled）
    const ledger = await revisions(id);
    expect(ledger).toHaveLength(2);
    const rev = must(ledger.find((r) => r.version === 2));
    expect(rev.version).toBe(2);
    expect(rev.source).toBe("scheduled");
    expect(rev.changedById).toBe(scheduler);
    expect(rev.changes).toEqual({
      value: { from: 3, to: 7 },
      adjudicationRefs: { from: ["R-99-1"], to: ["R-99-2"] },
    });
  });

  it("leaves a future change alone", async () => {
    const id = await insertScheduledRule({
      scheduledValue: 9,
      scheduledEffectiveAt: new Date(Date.now() + 86_400_000),
    });
    const applied = await applyDueRuleChanges(db, { now: new Date() });
    expect(applied.filter((a) => a.ruleId === id)).toEqual([]);
    const rule = await ruleById(id);
    expect(rule.value).toBe(3);
    expect(rule.scheduledValue).toBe(9);
    expect(rule.version).toBe(1);
    expect((await revisions(id)).filter((r) => r.version > 1)).toEqual([]);
  });

  it("is idempotent: a second pass applies nothing", async () => {
    const id = await insertScheduledRule({
      scheduledValue: 5,
      scheduledEffectiveAt: new Date(Date.now() - 60_000),
    });
    expect((await applyDueRuleChanges(db, { now: new Date() })).filter((a) => a.ruleId === id)).toHaveLength(1);
    expect((await applyDueRuleChanges(db, { now: new Date() })).filter((a) => a.ruleId === id)).toEqual([]);
    expect((await revisions(id)).filter((r) => r.version > 1)).toHaveLength(1);
  });

  it("falls back to the row's adjudication refs when no scheduled rationale was stored", async () => {
    const inserted = await db
      .insert(schema.registryRules)
      .values({
        key: `dueact.${randomUUID()}`,
        label: "Fixture scheduled rule (no rationale)",
        category: "param",
        valueType: "number",
        value: 1,
        changeableBy: ["owner"],
        adjudicationRefs: ["R-99-9"],
        scheduledValue: 2,
        scheduledEffectiveAt: new Date(Date.now() - 60_000),
        scheduledById: scheduler,
      })
      .returning({ id: schema.registryRules.id });
    const id = must(inserted[0]).id;
    const applied = await applyDueRuleChanges(db, { now: new Date() });
    const act = must(applied.find((a) => a.ruleId === id));
    expect(act.rationale).toEqual({ refs: ["R-99-9"] });
    const rule = await ruleById(id);
    expect(rule.adjudicationRefs).toEqual(["R-99-9"]);
  });

  it("honors the limit and picks the earliest due first", async () => {
    const early = await insertScheduledRule({
      scheduledValue: 11,
      scheduledEffectiveAt: new Date(Date.now() - 120_000),
    });
    const late = await insertScheduledRule({
      scheduledValue: 12,
      scheduledEffectiveAt: new Date(Date.now() - 60_000),
    });
    const applied = await applyDueRuleChanges(db, { now: new Date(), limit: 1 });
    expect(applied.map((a) => a.ruleId)).toEqual([early]);
    const lateRule = await ruleById(late);
    expect(lateRule.value).toBe(3);
    expect(lateRule.scheduledValue).toBe(12);
  });

  it("versions consecutive activations: second due change lands as v3", async () => {
    const id = await insertScheduledRule({
      scheduledValue: 20,
      scheduledEffectiveAt: new Date(Date.now() - 60_000),
    });
    expect((await applyDueRuleChanges(db, { now: new Date() })).filter((a) => a.ruleId === id)).toHaveLength(1);
    await db
      .update(schema.registryRules)
      .set({
        scheduledValue: 21,
        scheduledEffectiveAt: new Date(Date.now() - 60_000),
        scheduledRationale: { refs: ["R-99-3"] },
        scheduledById: scheduler,
      })
      .where(eq(schema.registryRules.id, id));
    const applied = await applyDueRuleChanges(db, { now: new Date() });
    expect(applied.find((a) => a.ruleId === id)?.version).toBe(3);
    const rule = await ruleById(id);
    expect(rule.value).toBe(21);
    expect(rule.version).toBe(3);
    const ledger = await revisions(id);
    expect(ledger.filter((r) => r.version > 1).map((r) => r.version).sort((a, b) => a - b)).toEqual([2, 3]);
  });
});
