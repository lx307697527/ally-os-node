import { randomUUID } from "node:crypto";
import { serve } from "@hono/node-server";
import { parseEnv } from "@ally/config";
import { createDb } from "@ally/db";
import { createMailer } from "@ally/mailer";
import { RealtimeBus, type RealtimeBusPayload, NOTIFICATIONS_CHANGED_EVENT, userChannel } from "@ally/realtime";
import pino from "pino";
import { createApp } from "./app.ts";
import { createAuth, createSessionResolver, createSessionTokenVerifier } from "./auth/auth.ts";
import { createAuthzStore } from "./authz/service.ts";
import { canSubscribeChannel } from "./realtime/channels.ts";
import { createRealtimeAuthenticator } from "./realtime/auth.ts";
import { RealtimeHub } from "./realtime/hub.ts";
import { createPresenceStore } from "./realtime/presence.ts";
import { attachRealtimeWs } from "./realtime/ws.ts";

const env = parseEnv(process.env);
const logger = pino({ level: env.LOG_LEVEL });
const { db, pool } = createDb(env.DATABASE_URL);

// 邮件发送（#22 邮件基建切片）：key 未配置时走日志模式，本地开发从日志拿验证链接
const mailer = createMailer({
  logger,
  resendApiKey: env.RESEND_API_KEY,
  from: env.EMAIL_FROM,
});

// Google OAuth（#22 切片 4）：env 层已校验成对出现，这里只做「配了就启用」。
// 未配置时 createAuth 不注册提供商、登录页拿不到 google，双方一致走密码登录。
const googleOAuth =
  env.GOOGLE_CLIENT_ID !== undefined && env.GOOGLE_CLIENT_SECRET !== undefined
    ? { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET }
    : undefined;

// 认证（#22）：Better Auth 处理 /api/auth/*，会话经中间件注入业务路由
const auth = createAuth({
  db,
  secret: env.BETTER_AUTH_SECRET,
  trustedOrigins: env.CORS_ORIGINS,
  baseURL: env.BETTER_AUTH_URL,
  webAppUrl: env.WEB_APP_URL,
  googleOAuth,
  mailer,
  logger,
});
const resolveSession = createSessionResolver(auth);

// 角色与授权数据（#23）：user_role / user_permission 两张表，同一连接池
const authzStore = createAuthzStore(db);

// 实时「催」信号（#110 切片 2）：通知落库的事务提交后，业务路由对拿到通知
// 的用户各发一次 notifications.changed。at-most-once：发布失败只降级回铃铛的
// 60s 轮询，不重试、不让业务请求失败（AppDeps.notifyUsers 的不 reject 合同）。
// bus 尚未接好时走 publishToBus 的占位拒绝，被同一 catch 吞掉。
// bus 创建前 hub 若真的发布（不可能：还没开始接连接），直接失败暴露问题。
let publishToBus: (payload: RealtimeBusPayload) => Promise<void> = () =>
  Promise.reject(new Error("realtime bus is not wired yet"));
const notifyUsers = async (userIds: string[]): Promise<void> => {
  const unique = [...new Set(userIds)];
  await Promise.all(
    unique.map((userId) =>
      publishToBus({
        type: "message",
        channel: userChannel(userId),
        event: NOTIFICATIONS_CHANGED_EVENT,
        data: {},
      }),
    ),
  ).catch((err: unknown) => {
    logger.warn({ err, recipients: unique.length }, "realtime notifications nudge failed");
  });
};

const app = createApp({
  logger,
  db,
  corsOrigins: env.CORS_ORIGINS,
  checkDatabase: async () => {
    await pool.query("select 1");
  },
  authHandler: (request) => auth.handler(request),
  resolveSession,
  socialProviders: googleOAuth === undefined ? [] : ["google"],
  authzStore,
  notifyUsers,
});

// 实时推送（#30）：hub ↔ bus 互相引用，用先声明再赋值的函数引用解决循环创建。
// 连接鉴权走 #22 的会话令牌校验；开发/测试保留 dev:<userId> 直通便于本地联调。
// 频道授权用 user: 私人频道规则（#110 切片 2）：user:<id> 只有本人能订阅。
const instanceId = randomUUID();
const hub = new RealtimeHub({
  logger,
  instanceId,
  publish: (payload) => publishToBus(payload),
  presence: createPresenceStore(db),
  authenticate: createRealtimeAuthenticator(env, logger, createSessionTokenVerifier(db)),
  authorize: canSubscribeChannel,
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
