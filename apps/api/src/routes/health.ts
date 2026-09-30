import { Hono } from "hono";
import type { AppDeps } from "../app.ts";

// /health：进程活着就返回 200，给负载均衡做存活检查
// /ready：数据库可用才返回 200，给滚动发布判断新实例能否接流量
export function healthRoutes(deps: Pick<AppDeps, "checkDatabase" | "logger">) {
  return new Hono()
    .get("/health", (c) => c.json({ status: "ok" }))
    .get("/ready", async (c) => {
      try {
        await deps.checkDatabase();
        return c.json({ status: "ready" });
      } catch (err) {
        deps.logger.warn({ err }, "readiness check failed");
        return c.json({ status: "unavailable" }, 503);
      }
    });
}
