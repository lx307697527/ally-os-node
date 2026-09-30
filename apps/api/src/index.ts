import { serve } from "@hono/node-server";
import { parseEnv } from "@ally/config";
import { createDb } from "@ally/db";
import pino from "pino";
import { createApp } from "./app.ts";

const env = parseEnv(process.env);
const logger = pino({ level: env.LOG_LEVEL });
const { pool } = createDb(env.DATABASE_URL);

const app = createApp({
  logger,
  corsOrigins: env.CORS_ORIGINS,
  checkDatabase: async () => {
    await pool.query("select 1");
  },
});

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  logger.info({ port: info.port }, "api listening");
});

// 滚动发布时 ECS / K8s 会先发 SIGTERM：停止接新请求，处理完再退出
function shutdown(signal: string) {
  logger.info({ signal }, "shutting down");
  server.close(() => {
    void pool.end().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => {
  shutdown("SIGTERM");
});
process.on("SIGINT", () => {
  shutdown("SIGINT");
});
