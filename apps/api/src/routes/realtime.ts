import { and, eq, gt } from "drizzle-orm";
import { Hono } from "hono";
import type { Db } from "@ally/db";
import { schema } from "@ally/db";
import type { AppEnv } from "../auth/session.ts";

/**
 * WS 实时连接的令牌端点（#110 切片 2）。会话 cookie 是 HttpOnly，浏览器里的
 * RealtimeClient 拿不到令牌填 auth 帧 —— 这里把**调用者自己当前会话**的令牌
 * 发还给它（docs/realtime.md「auth 帧的 token 是 Better Auth 会话令牌」的
 * 取数通道）。
 *
 * 交出去的是持有者已拥有的秘密（cookie 里那份），不构成提权；它随会话过期
 * 而死，客户端只在每次连接尝试时取一次、只存内存。真正的访问控制在 hub 的
 * 会话校验 + 频道授权（realtime/channels.ts）。
 */
export function realtimeRoutes(deps: { db: Db }) {
  const app = new Hono<AppEnv>();

  app.get("/api/realtime/token", async (c) => {
    const sessionId = c.get("session").id;
    const rows = await deps.db
      .select({ token: schema.authSession.token })
      .from(schema.authSession)
      .where(and(eq(schema.authSession.id, sessionId), gt(schema.authSession.expiresAt, new Date())))
      .limit(1);
    const row = rows[0];
    // 会话在中间件解析后、这一查前刚好过期/被删：对客户端就是未登录
    if (row === undefined) {
      return c.json({ error: "unauthorized" }, 401);
    }
    return c.json({ token: row.token });
  });

  return app;
}
