import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Mailer, MailMessage } from "@ally/mailer";
import { createDb, runMigrations, schema } from "@ally/db";
import { rulesJobs } from "./index.ts";
import {
  RULES_EFFECT_DIGEST_JOB,
  computeDigestEntries,
  renderEffectDigest,
  runRulesEffectDigestScan,
  type EffectDigestServices,
  type RuleCountersRow,
} from "./effect-digest.ts";

// 集成测试：需要真实 PostgreSQL（run 行状态迁移、快照差分、收件人去重）。
// 未设 DATABASE_URL 时跳过。独立临时库（每次运行新建、跑完 drop）。
//
// 清库纪律：auth_user 与 registry_rules 不在 beforeEach 里清（与 rules.test.ts
// 同一裁法——种子与人保留）。周报的断言面是「增量」不是绝对值：每条测试只消费
// 自己新加的计数（上一条测试的计数已被它的 scan 吃进快照），所以
// rules_effect_digest_runs 进 beforeEach 清空即可，规则计数跨测试累积是安全的。

const databaseUrl = process.env.DATABASE_URL;

const logger = pino({ level: "silent" });

const USERS = {
  owner1: randomUUID(),
  lead1: randomUUID(),
  both1: randomUUID(), // 同时持有 owner 与 sales_lead：去重后只该收到一封
  sales1: randomUUID(), // 普通销售：不在周报收件人词表里
} as const;

const USER_ROLES = {
  owner1: ["owner"],
  lead1: ["sales_lead"],
  both1: ["owner", "sales_lead"], // 同时持有两角色：去重后只该收到一封
  sales1: ["sales"], // 普通销售：不在周报收件人词表里
} as const;

/** 0021 种 57 条、0023 种 1 条审批路线；本套件 beforeAll 再插 1 条夹具规则。
 * 断言不用硬编码总数：种子数随已合并迁移演化，写死只会制造无意义的红；
 * 周报的「N of M」按扫描时刻的在册数说话，测试里实时数。 */
const FIXTURE_RULE_KEY = "fixture.digest.waste_rate_pct";

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

/** 假 mailer：记录每次发送；throwOn >= 0 时第 N 封（0 起）抛错模拟渠道故障 */
function makeFakeMailer(throwOn = -1): { mailer: Mailer; sent: MailMessage[] } {
  const sent: MailMessage[] = [];
  return {
    sent,
    mailer: {
      send(message) {
        if (sent.length === throwOn) return Promise.reject(new Error("smtp unavailable (fixture)"));
        sent.push(message);
        return Promise.resolve();
      },
    },
  };
}

describe.skipIf(!databaseUrl)("rules effect digest scan (#225, integration)", () => {
  const dbName = `rules_digest_test_${String(Date.now())}_${String(process.pid)}`;
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

  let fake = makeFakeMailer();
  let clock = new Date("2026-10-05T14:00:00Z"); // 周一 14:00 UTC：首个扫描时刻

  const services = (): EffectDigestServices => ({
    db,
    mailer: fake.mailer,
    webAppUrl: "https://app.example.com",
    logger,
    now: () => clock,
  });

  /** 给夹具规则的三个计数加增量（对齐 recordRuleOutcome 的 SQL 自增形态） */
  async function bumpRule(delta: { triggered?: number; exception?: number; override?: number }): Promise<void> {
    await db
      .update(schema.registryRules)
      .set({
        triggerCount: sql`${schema.registryRules.triggerCount} + ${delta.triggered ?? 0}`,
        exceptionCount: sql`${schema.registryRules.exceptionCount} + ${delta.exception ?? 0}`,
        overrideCount: sql`${schema.registryRules.overrideCount} + ${delta.override ?? 0}`,
      })
      .where(eq(schema.registryRules.key, FIXTURE_RULE_KEY));
  }

  async function runs(): Promise<
    {
      id: string;
      status: string;
      entries: schema.RuleEffectDigestEntry[];
      recipients: { userId: string; email: string }[];
      totalRules: number;
      weekStart: Date;
      weekEnd: Date;
    }[]
  > {
    const rows = await db
      .select({
        id: schema.rulesEffectDigestRuns.id,
        status: schema.rulesEffectDigestRuns.status,
        entries: schema.rulesEffectDigestRuns.entries,
        recipients: schema.rulesEffectDigestRuns.recipients,
        totalRules: schema.rulesEffectDigestRuns.totalRules,
        weekStart: schema.rulesEffectDigestRuns.weekStart,
        weekEnd: schema.rulesEffectDigestRuns.weekEnd,
      })
      .from(schema.rulesEffectDigestRuns)
      .orderBy(schema.rulesEffectDigestRuns.weekEnd);
    return rows;
  }

  /** 扫描时刻的在册规则总数（周报「N of M」的 M；不硬编码——种子随已合并迁移演化） */
  async function totalRulesCount(): Promise<number> {
    const rows = await db.select({ n: sql<number>`count(*)::int` }).from(schema.registryRules);
    return must(rows[0]).n;
  }

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("unreachable: suite is skipped without DATABASE_URL");
    await admin.pool.query(`create database "${dbName}"`);
    await runMigrations(db);
    await db.insert(schema.authUser).values(
      Object.entries(USERS).map(([name, id]) => ({
        id,
        name: name.charAt(0).toUpperCase() + name.slice(1),
        email: `${name}@example.com`,
        emailVerified: true,
      })),
    );
    const roleRows = Object.entries(USER_ROLES).flatMap(([name, roles]) =>
      roles.map((role) => ({ userId: USERS[name as keyof typeof USERS], role })),
    );
    await db.insert(schema.userRole).values(roleRows);
    await db.insert(schema.registryRules).values({
      key: FIXTURE_RULE_KEY,
      label: "Digest fixture waste rate",
      category: "param",
      valueType: "number",
      value: 10,
      changeableBy: ["owner"],
      adjudicationRefs: ["R-99-1"],
    });
  });

  beforeEach(async () => {
    fake = makeFakeMailer();
    clock = new Date(clock.getTime() + 7 * 24 * 60 * 60 * 1000); // 每条测试推进一周
    await db.execute(
      sql`truncate table ${schema.rulesEffectDigestRuns}, ${schema.tasks}, ${schema.notifications}, ${schema.auditEvents}`,
    );
  });

  afterAll(async () => {
    await pool.end();
    await admin.pool.query(`drop database if exists "${dbName}"`);
    await admin.pool.end();
  });

  it("first scan reports full counters as deltas, sends one mail per role holder (deduped), stamps the run sent", async () => {
    await bumpRule({ triggered: 3, override: 1 });

    const summary = await runRulesEffectDigestScan(services());

    expect(summary.mode).toBe("sent");
    expect(summary.recipients).toBe(3); // owner1 + lead1 + both1（双角色一封）
    expect(summary.entries).toBe(1);

    expect(fake.sent.length).toBe(3);
    expect(new Set(fake.sent.map((mail) => mail.to))).toEqual(
      new Set(["owner1@example.com", "lead1@example.com", "both1@example.com"]),
    );
    expect(fake.sent[0]?.subject).toBe(
      `Ally OS weekly rules digest: 1 of ${String(await totalRulesCount())} rules active`,
    );
    expect(fake.sent[0]?.text).toContain("- Digest fixture waste rate (fixture.digest.waste_rate_pct): +3 triggered, +1 override — totals 3 triggered / 0 exception / 1 override");
    expect(fake.sent[0]?.text).toContain("first report — totals since launch");
    expect(fake.sent[0]?.text).toContain("Open the rules registry: https://app.example.com/system/rules");

    const stored = await runs();
    expect(stored.length).toBe(1);
    expect(must(stored[0]).status).toBe("sent");
    expect(must(stored[0]).recipients.map((r) => r.email).sort()).toEqual([
      "both1@example.com",
      "lead1@example.com",
      "owner1@example.com",
    ]);
    const fixtureEntry = must(stored[0]).entries.find((entry) => entry.key === FIXTURE_RULE_KEY);
    expect(fixtureEntry?.delta).toEqual({ triggered: 3, exception: 0, override: 1 });
  });

  it("second scan reports only the delta since the previous snapshot", async () => {
    await bumpRule({ triggered: 3 });
    await runRulesEffectDigestScan(services());

    fake = makeFakeMailer();
    await bumpRule({ triggered: 2, exception: 1 });
    clock = new Date(clock.getTime() + 7 * 24 * 60 * 60 * 1000);
    const summary = await runRulesEffectDigestScan(services());

    expect(summary.mode).toBe("sent");
    expect(summary.entries).toBe(1);

    const stored = await runs();
    expect(stored.length).toBe(2);
    expect(stored.every((run) => run.status === "sent")).toBe(true);
    // 第二期的条目 = 相对上一期快照的纯增量（套件里规则计数跨测试累积，
    // 所以 totals 从 run 行取，不做测试内算术）
    const second = must(stored[1]);
    const fixtureEntry = must(second.entries.find((entry) => entry.key === FIXTURE_RULE_KEY));
    expect(fixtureEntry.delta).toEqual({ triggered: 2, exception: 1, override: 0 });
    expect(fake.sent[0]?.text).toContain("+2 triggered, +1 exception");
    // 邮件就是 run 行的渲染：内容一致，且不再是首报措辞
    expect(fake.sent[0]?.text).toBe(
      renderEffectDigest({
        entries: second.entries,
        totalRules: second.totalRules,
        weekStart: second.weekStart,
        weekEnd: second.weekEnd,
        webAppUrl: "https://app.example.com",
      }).text,
    );
    expect(fake.sent[0]?.text).not.toContain("first report");
  });

  it("quiet week still sends a short heartbeat mail with no entries", async () => {
    await bumpRule({ triggered: 1 });
    await runRulesEffectDigestScan(services());

    fake = makeFakeMailer();
    clock = new Date(clock.getTime() + 7 * 24 * 60 * 60 * 1000);
    const summary = await runRulesEffectDigestScan(services());

    expect(summary.mode).toBe("sent");
    expect(summary.entries).toBe(0);
    expect(fake.sent.length).toBe(3);
    expect(fake.sent[0]?.subject).toBe("Ally OS weekly rules digest: no activity");
    expect(fake.sent[0]?.text).toContain(
      `No rule activity this period (${String(await totalRulesCount())} rules watched)`,
    );
  });

  it("send failure keeps the run pending; next scan resends the frozen content instead of recomputing", async () => {
    await bumpRule({ triggered: 5 });
    fake = makeFakeMailer(0); // 第一封就抛
    await expect(runRulesEffectDigestScan(services())).rejects.toThrow("rules effect digest");
    expect(fake.sent.length).toBe(0);

    let stored = await runs();
    expect(stored.length).toBe(1);
    expect(must(stored[0]).status).toBe("pending");
    const frozen = must(stored[0]);

    // 失败期间计数继续走：重发的是冻结内容，新数字进下一期
    await bumpRule({ triggered: 9 });
    fake = makeFakeMailer();
    clock = new Date(clock.getTime() + 7 * 24 * 60 * 60 * 1000);
    const summary = await runRulesEffectDigestScan(services());

    expect(summary.mode).toBe("resent");
    expect(fake.sent.length).toBe(3);
    // 重发邮件 = 冻结行的逐字渲染；截断后的套件里冻结期多半就是首报，
    // 「first report」出现与否不是这里的断言点，逐字相等才是
    const expected = renderEffectDigest({
      entries: frozen.entries,
      totalRules: frozen.totalRules,
      weekStart: frozen.weekStart,
      weekEnd: frozen.weekEnd,
      webAppUrl: "https://app.example.com",
    });
    expect(fake.sent[0]?.text).toBe(expected.text);
    expect(fake.sent[0]?.subject).toBe(expected.subject);
    stored = await runs();
    expect(stored.length).toBe(1); // 没有新建期，重发即了结
    expect(must(stored[0]).status).toBe("sent");
  });

  it("recipients are frozen at compute time; role added after a pending run does not change the resend list", async () => {
    await bumpRule({ triggered: 2 });
    fake = makeFakeMailer(0);
    await expect(runRulesEffectDigestScan(services())).rejects.toThrow("rules effect digest");

    // 计算之后才进场的 owner：挂起期的重发名单不该有他
    const lateOwnerId = randomUUID();
    await db.insert(schema.authUser).values({
      id: lateOwnerId,
      name: "Late owner",
      email: "late-owner@example.com",
      emailVerified: true,
    });
    await db.insert(schema.userRole).values({ userId: lateOwnerId, role: "owner" });

    fake = makeFakeMailer();
    const summary = await runRulesEffectDigestScan(services());
    expect(summary.mode).toBe("resent");
    expect(new Set(fake.sent.map((mail) => mail.to))).toEqual(
      new Set(["owner1@example.com", "lead1@example.com", "both1@example.com"]),
    );
  });

  it("scan with no owner or sales_lead anywhere builds nothing and sends nothing", async () => {
    // 唯一一套没有收件人的场景需要一张没有角色持有者的库：借用主库前先把
    // 角色行挪走，测试内恢复（本 describe 顺序执行，恢复失败会让后续用例红，
    // 不会静默）
    const savedRoles = await db.select().from(schema.userRole);
    await db.delete(schema.userRole);

    try {
      fake = makeFakeMailer();
      const summary = await runRulesEffectDigestScan(services());
      expect(summary.mode).toBe("skipped");
      expect(fake.sent.length).toBe(0);
      expect((await runs()).length).toBe(0);
    } finally {
      await db.insert(schema.userRole).values(savedRoles.map((row) => ({ userId: row.userId, role: row.role })));
    }
  });

  it("worker job registration exposes the weekly cron", () => {
    const jobList = rulesJobs({
      db,
      pool,
      mailer: fake.mailer,
      webAppUrl: undefined,
      logger,
    });
    const digest = jobList.find((job) => job.name === RULES_EFFECT_DIGEST_JOB);
    expect(digest).toBeDefined();
    expect(must(digest).cron).toBe("0 14 * * 1");
    expect(jobList.some((job) => job.name === "rules-pending-reminder")).toBe(true);
  });
});

describe("rules effect digest pure functions (#225)", () => {
  const rule = (over: Partial<RuleCountersRow>): RuleCountersRow => ({
    key: "k1",
    label: "Rule one",
    category: "param",
    triggerCount: 0,
    exceptionCount: 0,
    overrideCount: 0,
    ...over,
  });

  it("computeDigestEntries: unknown rules start from zero, zero-delta rules are excluded, snapshot covers everyone", () => {
    const { entries, snapshot } = computeDigestEntries(
      { k1: [5, 0, 0] },
      [rule({ key: "k1", triggerCount: 5 }), rule({ key: "k2", label: "Rule two", triggerCount: 2, overrideCount: 1 })],
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.key).toBe("k2");
    expect(entries[0]?.delta).toEqual({ triggered: 2, exception: 0, override: 1 });
    expect(snapshot).toEqual({ k1: [5, 0, 0], k2: [2, 0, 1] });
  });

  it("computeDigestEntries: counters never decrease in practice — if data says otherwise the digest says so", () => {
    const { entries } = computeDigestEntries(
      { k1: [5, 0, 0] },
      [rule({ key: "k1", triggerCount: 3 })],
    );
    expect(entries[0]?.delta).toEqual({ triggered: -2, exception: 0, override: 0 });
  });

  it("renderEffectDigest: active week lists nonzero delta segments and totals only", () => {
    const rendered = renderEffectDigest({
      entries: [
        {
          key: "pricing.x",
          label: "Pricing X <b>",
          category: "param",
          delta: { triggered: 3, exception: 0, override: 1 },
          totals: { triggered: 10, exception: 0, override: 2 },
        },
      ],
      totalRules: 57,
      weekStart: new Date("2026-09-28T14:00:00Z"),
      weekEnd: new Date("2026-10-05T14:00:00Z"),
      webAppUrl: "https://app.example.com",
    });
    expect(rendered.subject).toBe("Ally OS weekly rules digest: 1 of 57 rules active");
    expect(rendered.text).toContain(
      "- Pricing X <b> (pricing.x): +3 triggered, +1 override — totals 10 triggered / 0 exception / 2 override",
    );
    expect(rendered.text).toContain("2026-09-28 14:00 UTC – 2026-10-05 14:00 UTC");
    expect(rendered.html).toContain("Pricing X &lt;b&gt;");
    expect(rendered.html).toContain('href="https://app.example.com/system/rules"');
  });

  it("renderEffectDigest: zero-delta kinds stay out of the line", () => {
    const rendered = renderEffectDigest({
      entries: [
        {
          key: "gates.y",
          label: "Gate Y",
          category: "gate",
          delta: { triggered: 0, exception: 0, override: 4 },
          totals: { triggered: 0, exception: 1, override: 4 },
        },
      ],
      totalRules: 57,
      weekStart: new Date("2026-09-28T14:00:00Z"),
      weekEnd: new Date("2026-10-05T14:00:00Z"),
      webAppUrl: undefined,
    });
    expect(rendered.text).toContain("(gates.y): +4 override — totals 0 triggered / 1 exception / 4 override");
    expect(rendered.text).not.toContain("+0");
    expect(rendered.text).not.toContain("Open the rules registry");
  });

  it("renderEffectDigest: quiet week and first-report period are said out loud", () => {
    const quiet = renderEffectDigest({
      entries: [],
      totalRules: 57,
      weekStart: new Date("2026-09-28T14:00:00Z"),
      weekEnd: new Date("2026-10-05T14:00:00Z"),
      webAppUrl: undefined,
    });
    expect(quiet.subject).toBe("Ally OS weekly rules digest: no activity");
    expect(quiet.text).toContain("No rule activity this period (57 rules watched)");

    const first = renderEffectDigest({
      entries: [
        {
          key: "k",
          label: "K",
          category: "param",
          delta: { triggered: 1, exception: 0, override: 0 },
          totals: { triggered: 1, exception: 0, override: 0 },
        },
      ],
      totalRules: 57,
      weekStart: new Date(0),
      weekEnd: new Date("2026-10-05T14:00:00Z"),
      webAppUrl: undefined,
    });
    expect(first.text).toContain("first report — totals since launch");
    expect(first.text).toContain("through 2026-10-05 14:00 UTC");
  });
});
