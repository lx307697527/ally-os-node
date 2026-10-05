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

/**
 * #232 §12：「管理员和有电子签名权限的人强制启用双因素认证」。电子签名权限点
 * 尚不存在（#219 落地时把它的 Permission 加进这个集合即可）；今天的强制集合
 * 就是 admin。owner（老板）设计未列入强制名单，不擅自扩大——要改是一行的事，
 * 但那是设计裁决的修订，不是实现顺手做的决定。
 *
 * 拦截形状：403 { error: "forbidden", code: "two_factor_required" }。前端拿
 * code 路由去 /settings/two-factor；/api/me 刻意豁免（见 app.ts 挂载顺序），
 * 未绑定的人靠它查到自己的角色与 twoFactorEnabled，才知道该去绑定。
 */
export const TWO_FACTOR_REQUIRED_CODE = "two_factor_required";

export const TWO_FACTOR_ENFORCED_ROLES: readonly Role[] = ["admin"];

export function requireTwoFactorGate(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const user = c.get("user");
    const enforced = c.get("authz").roles.some((role) =>
      TWO_FACTOR_ENFORCED_ROLES.includes(role),
    );
    if (enforced && !user.twoFactorEnabled) {
      return c.json({ error: "forbidden", code: TWO_FACTOR_REQUIRED_CODE }, 403);
    }
    await next();
    return undefined;
  };
}
