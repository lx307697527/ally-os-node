import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, runMigrations, schema, type Db } from "@ally/db";
import { recordConfigRevision } from "@ally/rules";
import { RULES_DUE_ACTIVATION_JOB, runRulesDueActivationScan } from "./due-activation.ts";
import { rulesJobs } from "./index.ts";

// 集成测试：需要真实 PostgreSQL（内核事务、台账行、审计行）。未设 DATABASE_URL
// 时跳过。独立临时库（每次运行新建、跑完 drop）。这里断言的是本任务自己的职责面：
// 前滚结果 → 提交后审计逐条落行（actor = 调度者）；内核的事务语义（行锁、台账
// 记账、limit）由 packages/rules 的套件钉住，不在这里重复。
const databaseUrl = process.env.DATABASE_URL;

const logger = pino({ level: "silent" });

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

describe.skipIf(!databaseUrl)("rules due activation job (#233, integration)", () => {
  const dbName = `rules_dueact_test_${String(Date.now())}_${String(process.pid)}`;
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

  async function insertScheduledRule(values: {
    scheduledValue: unknown;
    scheduledEffectiveAt: Date;
  }): Promise<string> {
    const inserted = await db
      .insert(schema.registryRules)
      .values({
        key: `dueactjob.${randomUUID()}`,
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
    // 生产行出生即带 v1 台账行（0021 种子先例），fixture 照此办理，激活从 v2 起算
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

  function appliedAudits(ruleId: string) {
    return db
      .select()
      .from(schema.auditEvents)
      .where(
        and(
          eq(schema.auditEvents.action, "rules.scheduled_change_applied"),
          eq(schema.auditEvents.target, ruleId),
        ),
      );
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

  it("applies a due change and writes the post-commit audit as the scheduler", async () => {
    const id = await insertScheduledRule({
      scheduledValue: 7,
      scheduledEffectiveAt: new Date(Date.now() - 60_000),
    });
    const summary = await runRulesDueActivationScan({ db });
    const key = must(
      (await db.select({ key: schema.registryRules.key }).from(schema.registryRules).where(eq(schema.registryRules.id, id)))[0],
    ).key;
    expect(summary.keys).toContain(key);

    const audits = await appliedAudits(id);
    expect(audits).toHaveLength(1);
    const audit = must(audits[0]);
    expect(audit.actor).toBe(scheduler);
    expect(audit.detail).toMatchObject({ key, from: 3, to: 7, version: 2 });
    const rule = must((await db.select().from(schema.registryRules).where(eq(schema.registryRules.id, id)))[0]);
    expect(rule.value).toBe(7);
    expect(rule.scheduledValue).toBeNull();
  });

  it("writes no audit for a future change", async () => {
    const id = await insertScheduledRule({
      scheduledValue: 9,
      scheduledEffectiveAt: new Date(Date.now() + 86_400_000),
    });
    const before = await appliedAudits(id);
    await runRulesDueActivationScan({ db });
    expect(await appliedAudits(id)).toHaveLength(before.length);
    const rule = must((await db.select().from(schema.registryRules).where(eq(schema.registryRules.id, id)))[0]);
    expect(rule.value).toBe(3);
    expect(rule.scheduledValue).toBe(9);
  });

  it("does not duplicate audits on a second pass", async () => {
    const id = await insertScheduledRule({
      scheduledValue: 5,
      scheduledEffectiveAt: new Date(Date.now() - 60_000),
    });
    await runRulesDueActivationScan({ db });
    await runRulesDueActivationScan({ db });
    expect(await appliedAudits(id)).toHaveLength(1);
  });
});

describe("rulesJobs registration", () => {
  it("registers the per-minute due-activation job", () => {
    const stubDb = {} as unknown as Db;
    const jobs = rulesJobs({
      db: stubDb,
      pool: { query: () => Promise.resolve(undefined) },
      mailer: { send: () => Promise.resolve() },
      webAppUrl: undefined,
      logger,
    });
    expect(jobs.map((job) => job.name)).toContain(RULES_DUE_ACTIVATION_JOB);
    const job = jobs.find((entry) => entry.name === RULES_DUE_ACTIVATION_JOB);
    expect(job?.cron).toBe("* * * * *");
  });
});
