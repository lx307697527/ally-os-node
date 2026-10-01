import type { Logger } from "pino";

// 每个任务 = 名字 + 可选 cron + 处理函数。替代 Supabase 的 pg_cron + pg_net
// （数据库定时发 HTTP 调 edge function）。任务队列和定时都存在 PostgreSQL 里，
// 不需要额外的 Redis / SQS，换云时不受影响。

/** 队列级重试/超时配置，缺省用 runner.ts 的 DEFAULT_QUEUE_OPTIONS */
export interface JobQueueOptions {
  /** 失败后最多重试几次（不含首次执行） */
  retryLimit?: number;
  /** 重试间隔基数（秒）；retryBackoff 时按指数增长 */
  retryDelay?: number;
  /** 指数退避 */
  retryBackoff?: boolean;
  /** 单次执行超时（秒），超时按失败处理进入重试 */
  expireInSeconds?: number;
}

export interface JobDefinition<TData extends object = object> {
  name: string;
  /** 5 段 cron 表达式，UTC；不填 = 只能手动或由代码投递 */
  cron?: string;
  queue?: JobQueueOptions;
  handler: (data: TData, ctx: { logger: Logger }) => Promise<void>;
}

export const heartbeat: JobDefinition = {
  name: "heartbeat",
  cron: "*/5 * * * *",
  handler(_data, { logger }) {
    logger.info("heartbeat");
    return Promise.resolve();
  },
};

// 从 ally-nutra 迁移定时任务时在这里登记，例如 fx-rate-sync、comms-sequence-advance-cron。
// 全量对照表（老任务 → 新任务 / 废弃原因）见 docs/cron-migration.md；
// 任务随各自的领域模块迁移时登记，不要在这里登记只有空壳的处理函数。
export const jobs: JobDefinition[] = [heartbeat];
