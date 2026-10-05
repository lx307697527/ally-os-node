import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { Db } from "@ally/db";
import { schema } from "@ally/db";
import type { Logger } from "pino";
import type { AppEnv } from "../auth/session.ts";
import { requirePermission } from "../authz/middleware.ts";
import { OWNER_APPROVAL_ROLES, roleSchema } from "../authz/permissions.ts";
import type { AuthzStore } from "../authz/service.ts";

/**
 * 角色管理端点（#23）。对应老系统对 core.user_roles 的直写与 admin-create-user
 * edge function——新系统里授予/撤销一律走这里：权限点门（roles.assign，声明见
 * routes/registry.ts）→ R-16-6 高级角色门 → 写 user_role → 审计。每一次真实变更
 * 都落 audit_events（R-16-6：所有权限变更留审计；重复授予不记）。
 */
export function userRolesRoutes(deps: { db: Db; authzStore: AuthzStore; logger: Logger }) {
  const app = new Hono<AppEnv>();

  // 三个端点同属团队管理（#144 并入范围：「团队管理仅管理员可做」）；
  // 声明（routes/registry.ts）与执行（每个路由行上的 requirePermission）成对出现
  const requireAssign = requirePermission("roles.assign");

  app.get("/api/users/:userId/roles", requireAssign, async (c) => {
    const userId = c.req.param("userId");
    if (!(await userExists(deps.db, userId))) {
      return c.json({ error: "not_found" }, 404);
    }
    return c.json({
      roles: await deps.authzStore.getRoles(userId),
      permissions: await deps.authzStore.getDirectPermissions(userId),
    });
  });

  const postBody = z.object({ role: roleSchema });

  app.post("/api/users/:userId/roles", requireAssign, async (c) => {
    const parsed = postBody.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const role = parsed.data.role;
    if (OWNER_APPROVAL_ROLES.includes(role) && !hasOwnerRole(c)) {
      // R-16-6（授予 owner/admin/finance 级需老板确认）：审批流（#221）落地前的
      // fail-closed 等价物——这类授予只允许 owner 本人执行，管理员不行。
      return c.json({ error: "forbidden", code: "owner_approval_required" }, 403);
    }
    const userId = c.req.param("userId");
    if (!(await userExists(deps.db, userId))) {
      return c.json({ error: "not_found" }, 404);
    }
    const granted = await deps.authzStore.grantRole(userId, role);
    if (granted) {
      await audit(deps.db, c.get("user").id, "role.granted", userId, { role });
    }
    deps.logger.info({ actor: c.get("user").id, userId, role, granted }, "role grant processed");
    return c.json({ role, granted }, granted ? 201 : 200);
  });

  app.delete("/api/users/:userId/roles/:role", requireAssign, async (c) => {
    const parsedRole = roleSchema.safeParse(c.req.param("role"));
    if (!parsedRole.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const role = parsedRole.data;
    if (OWNER_APPROVAL_ROLES.includes(role) && !hasOwnerRole(c)) {
      // 撤销与授予同门：撤掉一个 admin/finance/owner 至少和授予一样敏感
      return c.json({ error: "forbidden", code: "owner_approval_required" }, 403);
    }
    const userId = c.req.param("userId");
    if (!(await userExists(deps.db, userId))) {
      return c.json({ error: "not_found" }, 404);
    }
    const revoked = await deps.authzStore.revokeRole(userId, role);
    if (revoked) {
      await audit(deps.db, c.get("user").id, "role.revoked", userId, { role });
    }
    deps.logger.info({ actor: c.get("user").id, userId, role, revoked }, "role revoke processed");
    return c.json({ role, revoked });
  });

  return app;
}

function hasOwnerRole(c: { get: (key: "authz") => AppEnv["Variables"]["authz"] }): boolean {
  return c.get("authz").roles.includes("owner");
}

async function userExists(db: Db, userId: string): Promise<boolean> {
  const rows = await db
    .select({ id: schema.authUser.id })
    .from(schema.authUser)
    .where(eq(schema.authUser.id, userId))
    .limit(1);
  return rows.length > 0;
}

async function audit(
  db: Db,
  actor: string,
  action: string,
  target: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await db.insert(schema.auditEvents).values({ actor, action, target, detail });
}
