import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { Db } from "@ally/db";
import type { JobDefinition } from "../jobs/index.ts";
import { WORKFLOW_TIMEOUT_REMINDERS_JOB, runWorkflowTimeoutScan } from "./reminder.ts";

/**
 * 流程域的任务登记（#220「超时后负责人收到提醒」的投递半边）：每小时一条超时
 * 对账扫描。
 *
 * db/pool 由 worker 引导（index.ts）注入——流程内核在 apps/api（worker 不跨 app
 * 依赖），worker 这边只做窄读取投影与通知落库（reminder.ts 模块注释）。
 *
 * cron 每小时 :50（与审批催办 :45 同锚错峰）：扫描便宜（超时在飞的实例是稀疏
 * 集），每小时跑让「刚超时」的实例当轮就被催到，而不是等到次日定点。对账语义
 * 幂等（台账在 workflow_instances.state_reminder_at），重试 1 次足够：下一轮扫描
 * 本身就是兜底（与 approval-reminders 同一裁法）。
 */
export interface WorkflowJobsDeps {
  db: Db;
  /** pg_notify 发布执行器（worker 自己的连接池） */
  pool: { query(text: string, values?: unknown[]): Promise<unknown> };
  logger: Logger;
}

export function workflowJobs(deps: WorkflowJobsDeps): JobDefinition[] {
  const services = {
    db: deps.db,
    publishExecutor: deps.pool,
    instanceId: `workflow-worker-${randomUUID()}`,
    logger: deps.logger,
  };
  const reminders: JobDefinition = {
    name: WORKFLOW_TIMEOUT_REMINDERS_JOB,
    cron: "50 * * * *",
    queue: { retryLimit: 1, retryDelay: 300, expireInSeconds: 600 },
    handler: async (_data, { logger }) => {
      const summary = await runWorkflowTimeoutScan({ ...services, logger });
      logger.info(summary, "workflow timeout reminder scan finished");
    },
  };
  return [reminders];
}
