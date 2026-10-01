import { Hono } from "hono";
import type { AppEnv } from "../auth/session.ts";

/**
 * 当前登录用户（#22）。前端拿会话信息、realtime 客户端取 userId 都走这里；
 * 会话由 sessionMiddleware 统一解析，路由本身不碰令牌。
 */
export function meRoutes() {
  const app = new Hono<AppEnv>();

  app.get("/api/me", (c) => {
    return c.json({ user: c.get("user") });
  });

  return app;
}
