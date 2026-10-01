import { randomUUID } from "node:crypto";
import { serve } from "@hono/node-server";
import { parseEnv } from "@ally/config";
import { createDb } from "@ally/db";
import { RealtimeBus, type RealtimeBusPayload } from "@ally/realtime";
import pino from "pino";
import { createRealtimeAuthenticator } from "./realtime/auth.ts";
import { RealtimeHub } from "./realtime/hub.ts";
import { createPresenceStore } from "./realtime/presence.ts";
import { attachRealtimeWs } from "./realtime/ws.ts";
import { createApp } from "./app.ts";

const env = parseEnv(process.env);
const logger = pino({ level: env.LOG_LEVEL });
const { db, pool } = createDb(env.DATABASE_URL);

const app = createApp({
  logger,
  corsOrigins: env.CORS_ORIGINS,
  checkDatabase: async () => {
    await pool.query("select 1");
  },
});

// 实时推送（#30）：hub ↔ bus 互相引用，用先声明再赋值的函数引用解决循环创建。
// 完整鉴权等 #22 落地；在那之前开发环境接受 dev:<userId> 令牌，生产拒绝所有连接。
const instanceId = randomUUID();
// bus 创建前 hub 若真的发布（不可能：还没开始接连接），直接失败暴露问题
let publishToBus: (payload: RealtimeBusPayload) => Promise<void> = () =>
  Promise.reject(new Error("realtime bus is not wired yet"));
const hub = new RealtimeHub({
  logger,
  instanceId,
  publish: (payload) => publishToBus(payload),
  presence: createPresenceStore(db),
  authenticate: createRealtimeAuthenticator(env, logger),
});
const bus = new RealtimeBus({
  databaseUrl: env.DATABASE_URL,
  publishExecutor: pool,
  logger,
  instanceId,
  onMessage: (payload) => { hub.onBusMessage(payload); },
});
publishToBus = (payload) => bus.publish(payload);
await bus.start();

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  logger.info({ port: info.port }, "api listening");
});
const realtime = attachRealtimeWs(server, { hub, logger });

// 滚动发布时 ECS / K8s 会先发 SIGTERM：停止接新请求，处理完再退出
function shutdown(signal: string) {
  logger.info({ signal }, "shutting down");
  hub.stop();
  void realtime.close();
  server.close(() => {
    void bus
      .stop()
      .catch((err: unknown) => { logger.warn({ err }, "realtime bus stop failed"); })
      .finally(() => pool.end().finally(() => process.exit(0)));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => {
  shutdown("SIGTERM");
});
process.on("SIGINT", () => {
  shutdown("SIGINT");
});
