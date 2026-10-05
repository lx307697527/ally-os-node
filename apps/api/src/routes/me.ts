import { Hono } from "hono";
import type { AppEnv } from "../auth/session.ts";

/**
 * 当前登录用户（#22）。前端拿会话信息、realtime 客户端取 userId 都走这里；
 * 会话由 sessionMiddleware 统一解析，路由本身不碰令牌。#23 起同时返回角色与
 * 生效权限集——前端据此做渲染层裁剪（真正的访问控制在服务端，这里只是展示）。
 */
export function meRoutes() {
  const app = new Hono<AppEnv>();

  app.get("/api/me", (c) => {
    const authz = c.get("authz");
    return c.json({
      user: c.get("user"),
      authz: { roles: authz.roles, permissions: [...authz.permissions] },
    });
  });

  return app;
}
