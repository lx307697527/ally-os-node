import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { createDb, schema } from "@ally/db";
import { runRateLimitCleanup } from "./rate-limit-cleanup.ts";

/**
 * 限流台账保留策略的集成测试（#27 切片 1）：真实 PG 上的按年龄删除。
 * 标识随机、断言只看本套件自建的行——共库上其他运行的残留行年龄上属于
 * 「该清的」，被顺带清掉正是期望行为，不影响断言。
 */

const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)("rate limit cleanup (#27, integration)", () => {
  const { db, pool } = createDb(databaseUrl ?? "");
  afterAll(async () => {
    await pool.end();
  });

  it("deletes expired counters and denials, keeps the living rows", async () => {
    const now = new Date();
    const hour = 60 * 60 * 1000;
    const runTag = randomUUID();

    // 过期行：窗口起点 2 天前 / 拒绝 31 天前；在用行：本窗口 / 昨天的拒绝
    const staleWindow = new Date(now.getTime() - 48 * hour);
    const staleDenial = new Date(now.getTime() - 31 * 24 * hour);
    await db.insert(schema.rateLimitCounters).values([
      {
        identifierType: "ip",
        identifier: `${runTag}-stale`,
        action: "auth.sign-in",
        windowStart: staleWindow,
        requestCount: 5,
      },
      {
        identifierType: "ip",
        identifier: `${runTag}-fresh`,
        action: "auth.sign-in",
        windowStart: now,
        requestCount: 1,
      },
    ]);
    await db.insert(schema.rateLimitDenials).values([
      {
        identifierType: "ip",
        identifier: `${runTag}-stale`,
        action: "auth.sign-in",
        windowStart: staleWindow,
        countAtDenial: 31,
        limitValue: 30,
        deniedAt: staleDenial,
      },
      {
        identifierType: "ip",
        identifier: `${runTag}-fresh`,
        action: "auth.sign-in",
        windowStart: now,
        countAtDenial: 31,
        limitValue: 30,
        deniedAt: now,
      },
    ]);

    const summary = await runRateLimitCleanup(db, now);
    expect(summary.countersDeleted).toBeGreaterThanOrEqual(1);
    expect(summary.denialsDeleted).toBeGreaterThanOrEqual(1);

    // 本套件自己的行：stale 必须没了，fresh 必须还在
    const staleCounters = await db
      .select()
      .from(schema.rateLimitCounters)
      .where(eq(schema.rateLimitCounters.identifier, `${runTag}-stale`));
    const freshCounters = await db
      .select()
      .from(schema.rateLimitCounters)
      .where(eq(schema.rateLimitCounters.identifier, `${runTag}-fresh`));
    const staleDenials = await db
      .select()
      .from(schema.rateLimitDenials)
      .where(eq(schema.rateLimitDenials.identifier, `${runTag}-stale`));
    const freshDenials = await db
      .select()
      .from(schema.rateLimitDenials)
      .where(eq(schema.rateLimitDenials.identifier, `${runTag}-fresh`));
    expect(staleCounters).toHaveLength(0);
    expect(freshCounters).toHaveLength(1);
    expect(staleDenials).toHaveLength(0);
    expect(freshDenials).toHaveLength(1);
  });

  it("keeps living rows across repeated passes (delete key is age only)", async () => {
    const now = new Date();
    const runTag = randomUUID();
    await db.insert(schema.rateLimitCounters).values({
      identifierType: "ip",
      identifier: runTag,
      action: "auth.sign-up",
      windowStart: now,
      requestCount: 1,
    });

    await runRateLimitCleanup(db, now);
    await runRateLimitCleanup(db, now);

    const remaining = await db
      .select()
      .from(schema.rateLimitCounters)
      .where(eq(schema.rateLimitCounters.identifier, runTag));
    expect(remaining).toHaveLength(1);
  });
});
