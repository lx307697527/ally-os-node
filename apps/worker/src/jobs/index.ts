import type { Logger } from "pino";

// 每个任务 = 名字 + 可选 cron + 处理函数。替代 Supabase 的 pg_cron + pg_net
// （数据库定时发 HTTP 调 edge function）。任务队列和定时都存在 PostgreSQL 里，
// 不需要额外的 Redis / SQS，换云时不受影响。
export interface JobDefinition<TData extends object = object> {
  name: string;
  /** 5 段 cron 表达式，UTC；不填 = 只能手动或由代码投递 */
  cron?: string;
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

// 从 ally-nutra 迁移定时任务时在这里登记，例如 fx-rate-sync、process-email-sequences
export const jobs: JobDefinition[] = [heartbeat];
