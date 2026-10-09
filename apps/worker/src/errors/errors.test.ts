import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createDb, schema } from "@ally/db";
import { runErrorEventsCleanup } from "./cleanup.ts";
import { detectAndClaimErrorSpike, formatErrorSpikeAlert } from "./spike.ts";

// 集成测试：真实 PG 上的判定与占位（数行数 → 冷却 → 唯一键主张）。
// 未设 DATABASE_URL 跳过。error_events / error_spikes 是本切片的新表，整表清。

const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)("error spike detection (#28, integration)", () => {
  const { db, pool } = createDb(databaseUrl ?? "");
  afterAll(async () => {
    await pool.end();
  });

  afterEach(async () => {
    await db.delete(schema.errorEvents);
    await db.delete(schema.errorSpikes);
  });

  async function seedEvents(count: number, ageMs = 0): Promise<void> {
    if (count === 0) return;
    await db.insert(schema.errorEvents).values(
      Array.from({ length: count }, () => ({
        fingerprint: randomUUID(),
        source: "web",
        message: `err-${randomUUID()}`,
        createdAt: new Date(Date.now() - ageMs),
      })),
    );
  }

  /** 种在指定时刻附近（1 秒前）的事件行：给注入时钟的判定用 */
  async function seedEventsAt(count: number, at: Date): Promise<void> {
    await db.insert(schema.errorEvents).values(
      Array.from({ length: count }, () => ({
        fingerprint: randomUUID(),
        source: "web",
        message: `err-${randomUUID()}`,
        createdAt: new Date(at.getTime() - 1_000),
      })),
    );
  }

  it("低于阈值 = quiet，不落台账", async () => {
    await seedEvents(3);
    const decision = await detectAndClaimErrorSpike(db, new Date(), { threshold: 5 });
    expect(decision.outcome).toBe("quiet");
    expect(decision.eventCount).toBe(3);
    const ledger = await db.select().from(schema.errorSpikes);
    expect(ledger.length).toBe(0);
  });

  it("窗口外的旧错误不计入（滚动窗口数行）", async () => {
    await seedEvents(10, 10 * 60_000);
    const decision = await detectAndClaimErrorSpike(db, new Date(), { threshold: 5 });
    expect(decision.outcome).toBe("quiet");
    expect(decision.eventCount).toBe(0);
  });

  it("过阈值 = claimed：台账行定格 eventCount/threshold；同刻重跑撞冷却不再喊", async () => {
    await seedEvents(5);
    const decision = await detectAndClaimErrorSpike(db, new Date(), { threshold: 5 });
    expect(decision.outcome).toBe("claimed");
    const [row] = await db.select().from(schema.errorSpikes);
    expect(row?.eventCount).toBe(5);
    expect(row?.threshold).toBe(5);
    expect(row?.windowStart).toEqual(decision.windowStart);

    // 同一窗口再跑（cron 重试视角）：冷却检查在主张之前，刚告警过 → cooldown，
    // 台账不新增第二行
    const again = await detectAndClaimErrorSpike(db, new Date(), { threshold: 5 });
    expect(again.outcome).toBe("cooldown");
    expect((await db.select().from(schema.errorSpikes)).length).toBe(1);
  });

  it("唯一键竞态：冷却已过但同窗口台账行已在（双 worker 同时主张）→ 后到的 already-claimed", async () => {
    await seedEvents(5);
    const now = new Date();
    const windowStart = new Date(Math.floor(now.getTime() / (5 * 60_000)) * (5 * 60_000));
    // 另一个 worker 31 分钟前主张了**同一个窗口**（并发下的台账现状）：
    // 冷却检查过线（alertedAt 老于冷却期），insert 撞 window_start 唯一键
    await db.insert(schema.errorSpikes).values({
      windowStart,
      eventCount: 99,
      threshold: 5,
      alertedAt: new Date(now.getTime() - 31 * 60_000),
    });
    const decision = await detectAndClaimErrorSpike(db, now, { threshold: 5 });
    expect(decision.outcome).toBe("already-claimed");
    expect((await db.select().from(schema.errorSpikes)).length).toBe(1);
  });

  it("冷却：刚告警过的新风暴只喊一嗓子，冷却过了才再主张", async () => {
    const first = new Date();
    await seedEventsAt(5, first);
    expect((await detectAndClaimErrorSpike(db, first, { threshold: 5 })).outcome).toBe("claimed");

    // 10 分钟后新窗口又过阈值：30 分钟冷却内 → cooldown，不新增台账行
    const withinCooldownAt = new Date(first.getTime() + 10 * 60_000);
    await seedEventsAt(5, withinCooldownAt);
    const withinCooldown = await detectAndClaimErrorSpike(db, withinCooldownAt, { threshold: 5 });
    expect(withinCooldown.outcome).toBe("cooldown");
    expect((await db.select().from(schema.errorSpikes)).length).toBe(1);

    // 冷却过后：新窗口重新主张
    const afterCooldownAt = new Date(first.getTime() + 31 * 60_000);
    await seedEventsAt(5, afterCooldownAt);
    const afterCooldown = await detectAndClaimErrorSpike(db, afterCooldownAt, { threshold: 5 });
    expect(afterCooldown.outcome).toBe("claimed");
    expect((await db.select().from(schema.errorSpikes)).length).toBe(2);
  });
});

describe.skipIf(!databaseUrl)("error events cleanup (#28, integration)", () => {
  const { db, pool } = createDb(databaseUrl ?? "");
  afterAll(async () => {
    await pool.end();
  });

  afterEach(async () => {
    await db.delete(schema.errorEvents);
    await db.delete(schema.errorSpikes);
  });

  it("删除过龄事件与台账，保留在期行", async () => {
    const now = new Date();
    await db.insert(schema.errorEvents).values([
      {
        fingerprint: "stale",
        source: "web",
        message: "old",
        createdAt: new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000),
      },
      { fingerprint: "fresh", source: "web", message: "new", createdAt: now },
    ]);
    await db.insert(schema.errorSpikes).values([
      {
        windowStart: new Date(now.getTime() - 91 * 24 * 60 * 60 * 1000),
        eventCount: 42,
        threshold: 20,
        alertedAt: new Date(now.getTime() - 91 * 24 * 60 * 60 * 1000),
      },
      { windowStart: now, eventCount: 7, threshold: 20, alertedAt: now },
    ]);

    const summary = await runErrorEventsCleanup(db, now);
    expect(summary.eventsDeleted).toBe(1);
    expect(summary.spikesDeleted).toBe(1);

    const events = await db.select().from(schema.errorEvents);
    expect(events.map((row) => row.fingerprint)).toEqual(["fresh"]);
    const spikes = await db.select().from(schema.errorSpikes);
    expect(spikes.length).toBe(1);
    expect(spikes[0]?.eventCount).toBe(7);
  });
});

describe("formatErrorSpikeAlert", () => {
  it("面向值班：数字、窗口、阈值、去汇总读法的指引", () => {
    const text = formatErrorSpikeAlert({
      eventCount: 42,
      windowMinutes: 5,
      threshold: 20,
      windowStart: new Date("2026-10-09T10:00:00Z"),
    });
    expect(text).toContain("42 errors");
    expect(text).toContain("threshold 20");
    expect(text).toContain("2026-10-09T10:00:00.000Z");
    expect(text).toContain("/api/error-events/summary");
  });
});
