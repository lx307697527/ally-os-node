import type { PgBoss, JobWithMetadata } from "pg-boss";
import type { Logger } from "pino";
import type { JobDefinition, JobQueueOptions } from "./jobs/index.ts";

// 定时任务全生命周期的默认值。周期任务失败多半是暂时性故障（外部 API 抖动、
// 数据库瞬断），等下一轮 cron 可能是一天之后，所以默认立即重试：3 次、60 秒起
// 指数退避（≈ 1min → 2min → 4min）。单任务可在 JobDefinition.queue 覆盖。
export const DEFAULT_QUEUE_OPTIONS: Required<JobQueueOptions> = {
  retryLimit: 3,
  retryDelay: 60,
  retryBackoff: true,
  expireInSeconds: 900,
};

export type JobFailureAlerter = (failure: {
  job: string;
  jobId: string;
  attempt: number;
  retryLimit: number;
  error: string;
}) => Promise<void>;

export interface RegisterJobsDeps {
  logger: Logger;
  /** 任务失败时告警（如 Slack）；不填 = 只记日志（显式 | undefined 以兼容 exactOptionalPropertyTypes） */
  onJobFailure?: JobFailureAlerter | undefined;
}

export async function registerJobs(boss: PgBoss, jobs: JobDefinition[], deps: RegisterJobsDeps) {
  const { logger } = deps;
  const names = new Set<string>();
  for (const job of jobs) {
    if (names.has(job.name)) throw new Error(`duplicate job name: ${job.name}`);
    names.add(job.name);

    await boss.createQueue(job.name, { ...DEFAULT_QUEUE_OPTIONS, ...job.queue });
    await boss.work(
      job.name,
      { includeMetadata: true },
      async (batch: JobWithMetadata[]) => {
        for (const item of batch) {
          await runJob(job, item, deps);
        }
      },
    );
    if (job.cron) {
      await boss.schedule(job.name, job.cron);
    }
    logger.info({ job: job.name, cron: job.cron }, "job registered");
  }
}

/** 执行单个任务实例：失败记日志、告警，然后向上抛给 pg-boss 走重试 */
async function runJob(
  job: JobDefinition,
  item: JobWithMetadata,
  deps: RegisterJobsDeps,
): Promise<void> {
  const jobLogger = deps.logger.child({ job: job.name, jobId: item.id });
  const retryLimit = item.retryLimit;
  const attempt = item.retryCount + 1;
  try {
    await job.handler(item.data, { logger: jobLogger });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    jobLogger.error(
      { err, attempt, retryLimit, willRetry: attempt <= retryLimit },
      "job failed",
    );
    if (deps.onJobFailure) {
      // 告警通道自身的故障不能掩盖任务失败，吞掉并记日志即可
      try {
        await deps.onJobFailure({
          job: job.name,
          jobId: item.id,
          attempt,
          retryLimit,
          error: message,
        });
      } catch (alertErr) {
        jobLogger.error({ err: alertErr }, "job failure alerting failed");
      }
    }
    throw err;
  }
}
