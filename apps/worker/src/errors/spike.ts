import { desc, gte, sql } from "drizzle-orm";
import type { Db } from "@ally/db";
import { schema } from "@ally/db";

/**
 * 错误激增检测（#28 切片 1；issue #28 迁移要点「error-spike-alert 迁到 worker
 * 定时任务」的直系实现——老函数在老仓库迁移 HEAD 上已不存在，阈值与节奏按
 * 老语义重建：定时检测、30 分钟冷却、Slack 告警）。
 *
 * 检测 = 数行数：error_events 一行一次发生，最近一个窗口的行数过阈值即激增。
 * 判定与占位同一次调用完成：台账行（error_spikes，window_start 唯一）先落库
 * 后投递——cron 重试或双 worker 并发跑同一窗口，第二个撞唯一键放弃，「告警
 * 不重复」是结构保证而不是部署纪律（与限流计数同一形状的裁决）。
 *
 * 投递失败不失败任务：台账行已经证明「检测到并主张了这个窗口」，Slack 挂了
 * 是通道问题，下一轮窗口是新的判定——调用方 catch 后 warn（与 runner 的
 * onJobFailure 同一姿态：告警通道自身的故障不能掩盖任务本身）。
 */

/** 检测窗口：与 cron 周期对齐的 5 分钟 */
export const SPIKE_WINDOW_MS = 5 * 60_000;

/** 窗口内超过这个行数算激增：小团队的正常错误率以周计，5 分钟 20 行是「着火了」 */
export const SPIKE_THRESHOLD = 20;

/** 冷却：同一风暴只喊一嗓子，30 分钟（老 error-spike-alert 的节奏） */
export const SPIKE_COOLDOWN_MS = 30 * 60_000;

export type SpikeOutcome = "quiet" | "cooldown" | "claimed" | "already-claimed";

export interface SpikeDecision {
  outcome: SpikeOutcome;
  windowStart: Date;
  eventCount: number;
  /** 本次判定用的阈值：随决策返回，告警文案不再抄第二份常量 */
  threshold: number;
}

export interface DetectErrorSpikeArgs {
  threshold?: number | undefined;
  windowMs?: number | undefined;
  cooldownMs?: number | undefined;
}

export async function detectAndClaimErrorSpike(
  db: Db,
  now: Date,
  args: DetectErrorSpikeArgs = {},
): Promise<SpikeDecision> {
  const threshold = args.threshold ?? SPIKE_THRESHOLD;
  const windowMs = args.windowMs ?? SPIKE_WINDOW_MS;
  const cooldownMs = args.cooldownMs ?? SPIKE_COOLDOWN_MS;

  const since = new Date(now.getTime() - windowMs);
  const windowStart = new Date(Math.floor(now.getTime() / windowMs) * windowMs);

  const counts = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.errorEvents)
    .where(gte(schema.errorEvents.createdAt, since));
  const eventCount = counts[0]?.n ?? 0;
  if (eventCount < threshold) {
    return { outcome: "quiet", windowStart, eventCount, threshold };
  }

  const recent = await db
    .select({ alertedAt: schema.errorSpikes.alertedAt })
    .from(schema.errorSpikes)
    .orderBy(desc(schema.errorSpikes.alertedAt))
    .limit(1);
  const lastAlert = recent[0]?.alertedAt;
  if (lastAlert !== undefined && now.getTime() - lastAlert.getTime() < cooldownMs) {
    return { outcome: "cooldown", windowStart, eventCount, threshold };
  }

  const claimed = await db
    .insert(schema.errorSpikes)
    .values({ windowStart, eventCount, threshold, alertedAt: now })
    .onConflictDoNothing({ target: schema.errorSpikes.windowStart })
    .returning({ id: schema.errorSpikes.id });
  if (claimed.length === 0) {
    // 同窗口已被主张（并发 worker 或 cron 重试）：不重复告警
    return { outcome: "already-claimed", windowStart, eventCount, threshold };
  }
  return { outcome: "claimed", windowStart, eventCount, threshold };
}

/** Slack 告警文本（纯函数，便于测试）；文案面向值班的人：数字 + 窗口，不猜根因 */
export function formatErrorSpikeAlert(spike: {
  eventCount: number;
  windowMinutes: number;
  threshold: number;
  windowStart: Date;
}): string {
  return [
    `:rotating_light: *Ally OS error spike* — ${String(spike.eventCount)} errors in the last ${String(spike.windowMinutes)} min (threshold ${String(spike.threshold)})`,
    `window started \`${spike.windowStart.toISOString()}\` — group by fingerprint: GET /api/error-events/summary`,
  ].join("\n");
}
