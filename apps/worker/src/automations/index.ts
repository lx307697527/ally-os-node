import { randomUUID } from "node:crypto";
import type { PgBoss } from "pg-boss";
import type { Logger } from "pino";
import { z } from "zod";
import type { Db } from "@ally/db";
import type { JobDefinition } from "../jobs/index.ts";
import type { ActionDeps } from "./actions.ts";
import { AUTOMATION_DUE_SCAN_JOB, runAutomationDueScan } from "./due-scanner.ts";
import { AUTOMATION_RUN_JOB, runAutomationRun } from "./runner.ts";
import { AUTOMATION_SCAN_JOB, runAutomationScan } from "./scanner.ts";

/**
 * 自动化任务登记（#224）：scan 每分钟扫审计事件尾窗命中规则落 run 行，due-scan
 * 每分钟扫 due 触发的到期时刻带（切片 2），run 逐动作执行并写回结果。扫描任务
 * 的队列配置走 runner.ts 默认值（重试 3 次、60s 指数退避、失败告警），收紧为
 * 重试 1 次——下一轮扫描本身就是兜底，多侧重试只会放大重复扫描。
 *
 * db/pool 由 worker 引导（index.ts）注入：动作与扫描都只要 SQL 通道；铃铛「催」
 * 用 pool 当 pg_notify 发布执行器（与 API 的 RealtimeBus.publish 同一条 SQL）。
 */
export interface AutomationJobsDeps {
  db: Db;
  /** pg_notify 发布执行器（worker 自己的连接池） */
  pool: { query(text: string, values?: unknown[]): Promise<unknown> };
  boss: PgBoss;
  logger: Logger;
}

const runJobData = z.object({ runId: z.uuid() });

export function automationJobs(deps: AutomationJobsDeps): JobDefinition[] {
  const actionDeps: ActionDeps = {
    db: deps.db,
    publishExecutor: deps.pool,
    logger: deps.logger,
    instanceId: `automation-worker-${randomUUID()}`,
  };
  const sendRunJob = async (runId: string): Promise<void> => {
    // singletonKey 去重：同一 run 的执行任务在排队/在途时，重复发送自动忽略
    // （扫描器滞留重发靠它安全地每分钟再发一次）
    await deps.boss.send(AUTOMATION_RUN_JOB, { runId }, { singletonKey: runId });
  };
  const scan: JobDefinition = {
    name: AUTOMATION_SCAN_JOB,
    cron: "* * * * *",
    queue: { retryLimit: 1, retryDelay: 30, expireInSeconds: 300 },
    handler: async (_data, { logger }) => {
      await runAutomationScan({ ...actionDeps, sendRunJob, logger });
    },
  };
  const dueScan: JobDefinition = {
    name: AUTOMATION_DUE_SCAN_JOB,
    // 与事件扫描同周期同策略：重叠窗的重复命中靠 (rule, subject 行) 唯一约束
    // 吸收，下一轮扫描是兜底
    cron: "* * * * *",
    queue: { retryLimit: 1, retryDelay: 30, expireInSeconds: 300 },
    handler: async (_data, { logger }) => {
      await runAutomationDueScan({ ...actionDeps, sendRunJob, logger });
    },
  };
  const run: JobDefinition = {
    name: AUTOMATION_RUN_JOB,
    // pg-boss 的 payload 是边界外输入：zod 收口（不认识就失败进重试/告警，
    // 不静默吞）
    handler: async (data) => {
      const parsed = runJobData.safeParse(data);
      if (!parsed.success) {
        throw new Error(`automation-run payload invalid: ${parsed.error.message}`);
      }
      await runAutomationRun(actionDeps, parsed.data);
    },
  };
  return [scan, dueScan, run];
}

export { AUTOMATION_DUE_SCAN_JOB, AUTOMATION_RUN_JOB, AUTOMATION_SCAN_JOB };
