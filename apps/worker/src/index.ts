import { parseEnv } from "@ally/config";
import { createDb } from "@ally/db";
import { PgBoss } from "pg-boss";
import pino from "pino";
import { automationJobs } from "./automations/index.ts";
import { jobs } from "./jobs/index.ts";
import { registerJobs, type JobFailureAlerter } from "./runner.ts";
import { createSlackAlerter, formatJobFailure } from "./slack.ts";

const env = parseEnv(process.env);
const logger = pino({ level: env.LOG_LEVEL });

const alerter = createSlackAlerter({ webhookUrl: env.SLACK_WEBHOOK_URL });
const onJobFailure: JobFailureAlerter | undefined = env.SLACK_WEBHOOK_URL
  ? async (failure) => {
      await alerter.send(formatJobFailure(failure));
    }
  : undefined;

// 自动化域的 SQL 通道（#224）：扫描与动作都要读写业务表，连接池兼作铃铛
// 「催」的 pg_notify 发布执行器
const { db, pool } = createDb(env.DATABASE_URL);
pool.on("error", (err) => {
  logger.error({ err }, "worker pool error");
});

const boss = new PgBoss(env.DATABASE_URL);
boss.on("error", (err) => {
  logger.error({ err }, "pg-boss error");
});

await boss.start();
await registerJobs(boss, [...jobs, ...automationJobs({ db, pool, boss, logger })], {
  logger,
  onJobFailure,
});
logger.info({ alerting: Boolean(env.SLACK_WEBHOOK_URL) }, "worker started");

async function shutdown(signal: string) {
  logger.info({ signal }, "shutting down");
  await boss.stop({ graceful: true, timeout: 20_000 });
  await pool.end();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
