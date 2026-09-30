import type { PgBoss } from "pg-boss";
import type { Logger } from "pino";
import type { JobDefinition } from "./jobs/index.ts";

export async function registerJobs(boss: PgBoss, jobs: JobDefinition[], logger: Logger) {
  const names = new Set<string>();
  for (const job of jobs) {
    if (names.has(job.name)) throw new Error(`duplicate job name: ${job.name}`);
    names.add(job.name);

    await boss.createQueue(job.name);
    await boss.work<object>(job.name, async (batch) => {
      for (const item of batch) {
        const jobLogger = logger.child({ job: job.name, jobId: item.id });
        await job.handler(item.data, { logger: jobLogger });
      }
    });
    if (job.cron) {
      await boss.schedule(job.name, job.cron);
    }
    logger.info({ job: job.name, cron: job.cron }, "job registered");
  }
}
