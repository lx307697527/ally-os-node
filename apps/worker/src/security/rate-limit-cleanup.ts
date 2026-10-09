import { lt } from "drizzle-orm";
import type { Db } from "@ally/db";
import { schema } from "@ally/db";

/**
 * 限流台账的保留策略（#27 切片 1；老系统 FEAT-043 任务表 A22
 * platform-rate-limits-cleanup 的后继，cron-migration 对照表同源）。
 *
 * 两类行各按各的时钟过期：
 *   - 计数器行：窗口最多一小时（规则册上限），窗口关过就是死数据——保守取
 *     1 天兜住「未来出现更长窗口」的规则而不必记得回来改这里。
 *   - 拒绝台账行：安全遥测，价值随时间衰减（回溯排查以周计），30 天后清。
 *     「被拦截的请求」的管理面读法（#27 验收第 3 条）随可见性切片消费这张
 *     表；台账不是审计（不是合规记录），保留期是运维取舍得起的。
 */

/** 计数器保留：窗口最长 1 小时，1 天 = 足够保守的死线 */
const COUNTER_RETENTION_MS = 24 * 60 * 60 * 1000;

/** 拒绝台账保留：回溯排查以周计，30 天后清 */
const DENIAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface RateLimitCleanupResult {
  countersDeleted: number;
  denialsDeleted: number;
}

export async function runRateLimitCleanup(db: Db, now: Date): Promise<RateLimitCleanupResult> {
  const counterCutoff = new Date(now.getTime() - COUNTER_RETENTION_MS);
  const denialCutoff = new Date(now.getTime() - DENIAL_RETENTION_MS);

  const counters = await db
    .delete(schema.rateLimitCounters)
    .where(lt(schema.rateLimitCounters.windowStart, counterCutoff))
    .returning({ windowStart: schema.rateLimitCounters.windowStart });
  const denials = await db
    .delete(schema.rateLimitDenials)
    .where(lt(schema.rateLimitDenials.deniedAt, denialCutoff))
    .returning({ id: schema.rateLimitDenials.id });

  return { countersDeleted: counters.length, denialsDeleted: denials.length };
}
