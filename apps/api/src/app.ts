import { Hono } from "hono";
import { cors } from "hono/cors";
import { requestId } from "hono/request-id";
import type { Logger } from "pino";
import type { AppEnv, ResolveSession } from "./auth/session.ts";
import { sessionMiddleware } from "./auth/session.ts";
import { healthRoutes } from "./routes/health.ts";
import { meRoutes } from "./routes/me.ts";

// 依赖通过参数注入，测试时可以传假的实现，不需要真数据库。
export interface AppDeps {
  logger: Logger;
  corsOrigins: string[];
  checkDatabase: () => Promise<void>;
  /** Better Auth 的入口：处理 /api/auth/*（登录、注册、登出…），返回完整 Response */
  authHandler: (request: Request) => Promise<Response>;
  /** 会话解析：生产是 auth.api.getSession，测试注入假实现 */
  resolveSession: ResolveSession;
}

export function createApp(deps: AppDeps) {
  const app = new Hono<AppEnv>();

  app.use("*", requestId());
  app.use("/api/*", cors({ origin: deps.corsOrigins, credentials: true }));

  app.onError((err, c) => {
    deps.logger.error({ err, requestId: c.get("requestId") }, "unhandled error");
    // 不把内部错误细节返回给客户端
    return c.json({ error: "internal_error", requestId: c.get("requestId") }, 500);
  });

  app.notFound((c) => c.json({ error: "not_found" }, 404));

  app.route("/", healthRoutes(deps));

  // 认证端点自己管理会话（未登录也要能登录），先于会话中间件注册
  app.on(["POST", "GET"], "/api/auth/*", (c) => deps.authHandler(c.req.raw));

  // 其余 /api/* 一律要求已登录会话（#22 验收：业务代码统一经中间件拿当前用户）
  app.use("/api/*", sessionMiddleware(deps.resolveSession));

  app.route("/", meRoutes());

  return app;
}

export type App = ReturnType<typeof createApp>;
