import type { MiddlewareHandler } from "hono";
import type { AuthzContext } from "../authz/permissions.ts";

/**
 * 会话上下文的业务侧形状：刻意只暴露业务需要的字段，屏蔽 Better Auth 的
 * 完整模型——业务代码依赖这个接口而不是 better-auth 的类型，后续换实现
 * （或加插件字段）不至于扩散。
 */
export interface SessionUser {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
}

export interface SessionInfo {
  id: string;
  userId: string;
  expiresAt: Date;
}

export interface SessionData {
  user: SessionUser;
  session: SessionInfo;
}

/**
 * 从请求头解析会话。生产实现是 auth.api.getSession（Better Auth 读会话
 * cookie）；测试注入假实现即可覆盖鉴权路由，不需要真数据库。
 */
export type ResolveSession = (headers: Headers) => Promise<SessionData | null>;

export interface AppEnv {
  Variables: {
    user: SessionUser;
    session: SessionInfo;
    /** #23：authzMiddleware 对 /api/* 统一注入的角色与生效权限集 */
    authz: AuthzContext;
  };
}

/**
 * 会话中间件（#22 验收第 3 条）：/api/* 业务路由统一在这里拿当前用户，
 * 未登录一律 401。业务代码用 c.get("user")，不接触令牌。
 */
export function sessionMiddleware(resolveSession: ResolveSession): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const data = await resolveSession(c.req.raw.headers);
    if (!data) {
      return c.json({ error: "unauthorized" }, 401);
    }
    c.set("user", data.user);
    c.set("session", data.session);
    await next();
    return undefined;
  };
}
