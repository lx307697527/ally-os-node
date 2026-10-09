import type { Logger } from "pino";
import type { Db } from "@ally/db";
import type { JobDefinition } from "../jobs/index.ts";
import type { SlackAlerter } from "../slack.ts";
import { runErrorEventsCleanup } from "./cleanup.ts";
import { detectAndClaimErrorSpike, formatErrorSpikeAlert, SPIKE_WINDOW_MS } from "./spike.ts";

/**
 * 错误追踪域的任务登记（#28 切片 1）：激增检测（老 error-spike-alert 的
 * 后继，任务名沿用；老仓库迁移 HEAD 的任务表上没有它——issue 描述的是更早
 * 的状态，cron-migration 对照表按此注记）与错误事件的保留策略扫描。
 *
 * 检测每 5 分钟一次与窗口同长：窗口互不重叠、一个不漏。告警通道失败只 warn
 * 不失败任务——台账行已主张窗口，重试只会撞 already-claimed，没有可重试的
 * 东西（spike.ts 模块头）。
 */
export interface ErrorsJobsDeps {
  db: Db;
  logger: Logger;
  alerter: SlackAlerter;
}

export function errorJobs(deps: ErrorsJobsDeps): JobDefinition[] {
  const spike: JobDefinition = {
    name: "error-spike-alert",
    cron: "*/5 * * * *",
    handler: async (_data, { logger }) => {
      const decision = await detectAndClaimErrorSpike(deps.db, new Date());
      if (decision.outcome !== "claimed") {
        logger.debug({ outcome: decision.outcome, eventCount: decision.eventCount }, "error spike check");
        return;
      }
      logger.warn(
        { eventCount: decision.eventCount, windowStart: decision.windowStart.toISOString() },
        "error spike detected",
      );
      try {
        await deps.alerter.send(
          formatErrorSpikeAlert({
            eventCount: decision.eventCount,
            windowMinutes: SPIKE_WINDOW_MS / 60_000,
            threshold: decision.threshold,
            windowStart: decision.windowStart,
          }),
        );
      } catch (err) {
        logger.warn({ err }, "error spike alert delivery failed");
      }
    },
  };

  const cleanup: JobDefinition = {
    name: "error-events-cleanup",
    cron: "*/10 * * * *",
    handler: async (_data, { logger }) => {
      const summary = await runErrorEventsCleanup(deps.db, new Date());
      logger.info(summary, "error events cleanup finished");
    },
  };

  return [spike, cleanup];
}
