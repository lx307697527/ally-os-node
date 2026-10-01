import { parseEnv } from "@ally/config";
import { PgBoss } from "pg-boss";
import pino from "pino";
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

const boss = new PgBoss(env.DATABASE_URL);
boss.on("error", (err) => {
  logger.error({ err }, "pg-boss error");
});

await boss.start();
await registerJobs(boss, jobs, { logger, onJobFailure });
logger.info({ alerting: Boolean(env.SLACK_WEBHOOK_URL) }, "worker started");

async function shutdown(signal: string) {
  logger.info({ signal }, "shutting down");
  await boss.stop({ graceful: true, timeout: 20_000 });
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
