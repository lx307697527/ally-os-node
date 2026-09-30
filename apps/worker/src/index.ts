import { parseEnv } from "@ally/config";
import { PgBoss } from "pg-boss";
import pino from "pino";
import { jobs } from "./jobs/index.ts";
import { registerJobs } from "./runner.ts";

const env = parseEnv(process.env);
const logger = pino({ level: env.LOG_LEVEL });

const boss = new PgBoss(env.DATABASE_URL);
boss.on("error", (err) => {
  logger.error({ err }, "pg-boss error");
});

await boss.start();
await registerJobs(boss, jobs, logger);
logger.info("worker started");

async function shutdown(signal: string) {
  logger.info({ signal }, "shutting down");
  await boss.stop({ graceful: true, timeout: 20_000 });
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
