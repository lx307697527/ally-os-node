import type { Logger } from "pino";
import type { Db } from "@ally/db";
import type { JobDefinition } from "../jobs/index.ts";
import { runRateLimitCleanup } from "./rate-limit-cleanup.ts";

/**
 * 反滥用域的任务登记（#27 切片 1）：限流台账的保留策略扫描。
 *
 * 每 10 分钟一次：删除是纯年龄扫描，跑空了也只是白来一趟；窗口
 * 数据一天后过期、拒绝台账 30 天，10 分钟粒度让表长期停在「增量小时级」
 * 的体量。对账语义天然幂等（DELETE BY 年龄），重试用 runner 默认（3 次）
 * 即可：失败下一轮照补。
 */
export interface SecurityJobsDeps {
  db: Db;
  logger: Logger;
}

export function securityJobs(deps: SecurityJobsDeps): JobDefinition[] {
  const cleanup: JobDefinition = {
    name: "rate-limit-cleanup",
    cron: "*/10 * * * *",
    handler: async (_data, { logger }) => {
      const summary = await runRateLimitCleanup(deps.db, new Date());
      logger.info(summary, "rate limit cleanup finished");
    },
  };
  return [cleanup];
}
