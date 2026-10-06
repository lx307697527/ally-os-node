import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { Db } from "@ally/db";
import type { JobDefinition } from "../jobs/index.ts";
import { RULES_PENDING_REMINDER_JOB, runRulesPendingReminderScan } from "./reminder.ts";

/**
 * 规则注册表域的任务登记（#233 切片 2）：每日一条「待填规则待办提醒」对账扫描。
 *
 * db/pool 由 worker 引导（index.ts）注入。刻不在此登记 applyDueRuleChanges 的
 * cron——内核在 apps/api（worker 不跨 app 依赖），按 docs/rules.md 的裁决，定时
 * 生效的接线随第一个消费域一起进场（同 workflow due scan 裁法：内核先行，交付
 * 归 worker）。
 *
 * cron 每日 13:00 UTC（美东上午 9 点）——提醒落进「早上一上班的待办」。对账语义
 * 幂等，重试 1 次足够：明天的扫描本身就是兜底，多侧重试只会放大重复告警（与
 * automation-scan 收紧同一裁法）。
 */
export interface RulesJobsDeps {
  db: Db;
  /** pg_notify 发布执行器（worker 自己的连接池） */
  pool: { query(text: string, values?: unknown[]): Promise<unknown> };
  logger: Logger;
}

export function rulesJobs(deps: RulesJobsDeps): JobDefinition[] {
  const services = {
    db: deps.db,
    publishExecutor: deps.pool,
    instanceId: `rules-worker-${randomUUID()}`,
    logger: deps.logger,
  };
  const reminder: JobDefinition = {
    name: RULES_PENDING_REMINDER_JOB,
    cron: "0 13 * * *",
    queue: { retryLimit: 1, retryDelay: 300, expireInSeconds: 600 },
    handler: async (_data, { logger }) => {
      const summary = await runRulesPendingReminderScan({ ...services, logger });
      logger.info(summary, "rules pending reminder scan finished");
    },
  };
  return [reminder];
}
