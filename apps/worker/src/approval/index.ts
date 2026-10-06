import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { Db } from "@ally/db";
import type { JobDefinition } from "../jobs/index.ts";
import { APPROVAL_REMINDERS_JOB, runApprovalReminderScan } from "./reminder.ts";

/**
 * 审批域的任务登记（#221「pg-boss 催办」）：每小时一条「停满 24h 未裁」对账扫描。
 *
 * db/pool 由 worker 引导（index.ts）注入——审批内核在 apps/api（worker 不跨 app
 * 依赖），worker 这边只做读投影与通知落库（reminder.ts 模块注释）。
 *
 * cron 每小时 :45（与规则待办提醒 13:00、邮件摘要 13:30 同锚错峰）：扫描便宜
 * （在飞请求是稀疏集），每小时跑让「刚停满 24h」的请求当轮就被催到，而不是等到
 * 次日定点。对账语义幂等（台账在 approval_requests.last_reminder_*），重试 1 次
 * 足够：下一轮扫描本身就是兜底（与 rules-pending-reminder 同一裁法）。
 */
export interface ApprovalJobsDeps {
  db: Db;
  /** pg_notify 发布执行器（worker 自己的连接池） */
  pool: { query(text: string, values?: unknown[]): Promise<unknown> };
  logger: Logger;
}

export function approvalJobs(deps: ApprovalJobsDeps): JobDefinition[] {
  const services = {
    db: deps.db,
    publishExecutor: deps.pool,
    instanceId: `approval-worker-${randomUUID()}`,
    logger: deps.logger,
  };
  const reminders: JobDefinition = {
    name: APPROVAL_REMINDERS_JOB,
    cron: "45 * * * *",
    queue: { retryLimit: 1, retryDelay: 300, expireInSeconds: 600 },
    handler: async (_data, { logger }) => {
      const summary = await runApprovalReminderScan({ ...services, logger });
      logger.info(summary, "approval reminder scan finished");
    },
  };
  return [reminders];
}
