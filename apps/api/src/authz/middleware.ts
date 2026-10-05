import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../auth/session.ts";
import {
  effectivePermissions,
  type AuthzContext,
  type Permission,
  type Role,
} from "./permissions.ts";
import type { AuthzStore } from "./service.ts";

export type { AuthzContext };

/**
 * 授权上下文中间件（#23）：紧跟 sessionMiddleware 之后挂载，把当前用户的角色与
 * 生效权限集（角色默认集 + 个人附加授权）算好放进 context。老系统每个请求里反复
 * 调 has_role() 的等价物；新系统一个请求只查一次库。
 */
export function authzMiddleware(store: AuthzStore): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const user = c.get("user");
    const [roles, directPermissions] = await Promise.all([
      store.getRoles(user.id),
      store.getDirectPermissions(user.id),
    ]);
    c.set("authz", {
      roles,
      permissions: effectivePermissions(roles, directPermissions),
    });
    await next();
    return undefined;
  };
}

/**
 * 要求持有任一列出角色，否则 403。语义对应老系统 has_any_role（角色之间是 OR）。
 */
export function requireRole(...roles: readonly Role[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const authz = c.get("authz");
    if (!roles.some((role) => authz.roles.includes(role))) {
      return c.json({ error: "forbidden", code: "role_required", required: roles }, 403);
    }
    await next();
    return undefined;
  };
}

/** 要求持有某权限点（角色默认集或个人附加授权皆可），否则 403 */
export function requirePermission(permission: Permission): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!c.get("authz").permissions.has(permission)) {
      return c.json({ error: "forbidden", code: "permission_required", permission }, 403);
    }
    await next();
    return undefined;
  };
}
