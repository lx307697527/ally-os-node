import { Hono } from "hono";
import { cors } from "hono/cors";
import { requestId } from "hono/request-id";
import type { Logger } from "pino";
import { healthRoutes } from "./routes/health.ts";

// 依赖通过参数注入，测试时可以传假的实现，不需要真数据库。
export interface AppDeps {
  logger: Logger;
  corsOrigins: string[];
  checkDatabase: () => Promise<void>;
}

export function createApp(deps: AppDeps) {
  const app = new Hono();

  app.use("*", requestId());
  app.use("/api/*", cors({ origin: deps.corsOrigins, credentials: true }));

  app.onError((err, c) => {
    deps.logger.error({ err, requestId: c.get("requestId") }, "unhandled error");
    // 不把内部错误细节返回给客户端
    return c.json({ error: "internal_error", requestId: c.get("requestId") }, 500);
  });

  app.notFound((c) => c.json({ error: "not_found" }, 404));

  app.route("/", healthRoutes(deps));

  return app;
}

export type App = ReturnType<typeof createApp>;
