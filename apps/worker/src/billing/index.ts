import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { Db } from "@ally/db";
import type { JobDefinition } from "../jobs/index.ts";
import { INVOICE_OVERDUE_REMINDERS_JOB, runInvoiceOverdueScan } from "./overdue.ts";

/**
 * billing 域的任务登记（#192 due 扫描半边）：每日一条发票逾期对账扫描。
 *
 * db/pool 由 worker 引导（index.ts）注入——billing 内核在 apps/api（worker 不
 * 跨 app 依赖），worker 这边只做候选集窄读取与通知落库（overdue.ts 模块注释）。
 *
 * cron 每日 13:10 UTC：排在 rules 每日扫描（13:00）之后、通知摘要（13:30）
 * 之前——逾期的铃铛当天进摘要。对账语义幂等（台账在
 * invoices.overdue_reminder_at + dedupe_key 日粒度双保险），重试 1 次足够：
 * 次日扫描本身就是兜底（approval/workflow reminders 同一裁法）。
 */
export interface BillingJobsDeps {
  db: Db;
  /** pg_notify 发布执行器（worker 自己的连接池） */
  pool: { query(text: string, values?: unknown[]): Promise<unknown> };
  logger: Logger;
}

export function billingJobs(deps: BillingJobsDeps): JobDefinition[] {
  const services = {
    db: deps.db,
    publishExecutor: deps.pool,
    instanceId: `billing-worker-${randomUUID()}`,
    logger: deps.logger,
  };
  const reminders: JobDefinition = {
    name: INVOICE_OVERDUE_REMINDERS_JOB,
    cron: "10 13 * * *",
    queue: { retryLimit: 1, retryDelay: 300, expireInSeconds: 600 },
    handler: async (_data, { logger }) => {
      const summary = await runInvoiceOverdueScan({ ...services, logger });
      logger.info(summary, "invoice overdue reminder scan finished");
    },
  };
  return [reminders];
}
