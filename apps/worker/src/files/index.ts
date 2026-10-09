import type { Logger } from "pino";
import type { Db } from "@ally/db";
import type { Storage } from "@ally/storage";
import type { JobDefinition } from "../jobs/index.ts";
import { runPendingFileCleanup } from "./pending-cleanup.ts";

/**
 * 文件域的任务登记（#31 切片 1）：预签名直传 pending 行的保留策略扫描。
 *
 * 每 10 分钟一次：删除是纯年龄扫描，跑空了也只是白来一趟；pending 行 24 小时
 * 过期，10 分钟粒度让一个被放弃的占位至多阻塞该 subject 的名额一小时量级，
 * 而表长期停在「增量小时级」的体量。对账语义天然幂等（DELETE BY 年龄），
 * 重试用 runner 默认（3 次）即可：失败下一轮照补。
 */
export interface FilesJobsDeps {
  db: Db;
  storage: Storage;
  logger: Logger;
}

export function filesJobs(deps: FilesJobsDeps): JobDefinition[] {
  const cleanup: JobDefinition = {
    name: "file-uploads-cleanup",
    cron: "*/10 * * * *",
    handler: async (_data, { logger }) => {
      const summary = await runPendingFileCleanup(deps.db, deps.storage, logger, new Date());
      logger.info(summary, "pending file cleanup finished");
    },
  };
  return [cleanup];
}
