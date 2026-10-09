import { lt } from "drizzle-orm";
import type { Db } from "@ally/db";
import { schema } from "@ally/db";

/**
 * 错误事件的保留策略（#28 切片 1；老系统 database-cleanup「清理过期的错误
 * 日志」职责的对应切片——老任务本体在老仓库迁移 HEAD 上已不存在，节奏沿用
 * #27 切片 1 的裁定：每日定点改高频小扫描，删除是纯年龄扫描，跑空了也只是
 * 白来一趟）。
 *
 * 两类行各按各的时钟过期：
 *   - 错误事件：分诊遥测，价值随时间衰减（回溯排查以周计），30 天后清——
 *     与限流拒绝台账同一保留期（同一性质的运维遥测，一个保留期就够，不发明
 *     第二个数）。
 *   - 激增台账：一行一次告警，体量天然极小；90 天是「季度回顾时还能对上
 *     告警历史」的取整。
 */

/** 错误事件保留：回溯排查以周计，30 天后清 */
export const ERROR_EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** 激增台账保留：季度回顾对得上告警史，90 天 */
export const ERROR_SPIKE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export interface ErrorEventsCleanupResult {
  eventsDeleted: number;
  spikesDeleted: number;
}

export async function runErrorEventsCleanup(db: Db, now: Date): Promise<ErrorEventsCleanupResult> {
  const eventCutoff = new Date(now.getTime() - ERROR_EVENT_RETENTION_MS);
  const spikeCutoff = new Date(now.getTime() - ERROR_SPIKE_RETENTION_MS);

  const events = await db
    .delete(schema.errorEvents)
    .where(lt(schema.errorEvents.createdAt, eventCutoff))
    .returning({ id: schema.errorEvents.id });
  const spikes = await db
    .delete(schema.errorSpikes)
    .where(lt(schema.errorSpikes.alertedAt, spikeCutoff))
    .returning({ id: schema.errorSpikes.id });

  return { eventsDeleted: events.length, spikesDeleted: spikes.length };
}
