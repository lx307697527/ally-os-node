import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { Db } from "@ally/db";
import { schema } from "@ally/db";
import type { Logger } from "pino";
import { submitApprovalRequest } from "../approval/service.ts";
import { recordAudit } from "../audit/audit-log.ts";
import type { AppEnv } from "../auth/session.ts";
import { requirePermission } from "../authz/middleware.ts";
import { OWNER_APPROVAL_ROLES, roleSchema } from "../authz/permissions.ts";
import { ROLE_APPROVAL_CONFIG_KEY, ROLE_APPROVAL_SUBJECT_TYPE } from "../authz/role-approval.ts";
import type { AuthzStore } from "../authz/service.ts";

/**
 * 角色管理端点（#23）。对应老系统对 core.user_roles 的直写与 admin-create-user
 * edge function——新系统里授予/撤销一律走这里：权限点门（roles.assign，声明见
 * routes/registry.ts）→ R-16-6 高级角色门 → 写 user_role → 审计。每一次真实变更
 * 都落 audit_events（R-16-6：所有权限变更留审计；重复授予不记）。
 *
 * R-16-6 高级角色门（#221 切片 2 起）：owner/admin/finance 的授予与撤销——
 * - owner 本人直接执行（他就是确认人，R-16-5 业务审批可自批）；
 * - 其他 roles.assign 持有者走审批线（authz/role-approval.ts：owner 终审批准
 *   即生效）：审批线已配置 → 202 创建审批请求（payload 记 action/role）；已在飞
 *   → 409；审批线未配置 → 403 owner_approval_required（切片 1 的 fail-closed
 *   等价物保持不变：不预置配置数据，线由持 approval.configure 的人按需建）。
 * - 无变化的操作（已持有再授 / 本就没持有再撤）不进审批——没有可确认的变更。
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
    const userId = c.req.param("userId");
    if (!(await userExists(deps.db, userId))) {
      return c.json({ error: "not_found" }, 404);
    }
    const ownerConfirming = OWNER_APPROVAL_ROLES.includes(role) && !hasOwnerRole(c);
    if (!ownerConfirming) {
      const granted = await deps.authzStore.grantRole(userId, role);
      if (granted) {
        await recordAudit(deps.db, {
          actor: c.get("user").id,
          action: "role.granted",
          target: userId,
          detail: { role },
        });
      }
      deps.logger.info({ actor: c.get("user").id, userId, role, granted }, "role grant processed");
      return c.json({ role, granted }, granted ? 201 : 200);
    }
    // R-16-6 审批路径：无可确认的变更不进线（已持有 = 没有变更）
    if ((await deps.authzStore.getRoles(userId)).includes(role)) {
      return c.json({ role, granted: false }, 200);
    }
    const outcome = await submitApprovalRequest(deps.db, {
      subjectType: ROLE_APPROVAL_SUBJECT_TYPE,
      subjectId: userId,
      configKey: ROLE_APPROVAL_CONFIG_KEY,
      submitterId: c.get("user").id,
      payload: { action: "grant", role },
    });
    return approvalOutcomeResponse(c, deps, c.get("user").id, outcome, { role, granted: false }, "role grant");
  });

  app.delete("/api/users/:userId/roles/:role", requireAssign, async (c) => {
    const parsedRole = roleSchema.safeParse(c.req.param("role"));
    if (!parsedRole.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const role = parsedRole.data;
    const userId = c.req.param("userId");
    if (!(await userExists(deps.db, userId))) {
      return c.json({ error: "not_found" }, 404);
    }
    const ownerConfirming = OWNER_APPROVAL_ROLES.includes(role) && !hasOwnerRole(c);
    if (!ownerConfirming) {
      // 撤销与授予同门：撤掉一个 admin/finance/owner 与授予一样敏感
      const revoked = await deps.authzStore.revokeRole(userId, role);
      if (revoked) {
        await recordAudit(deps.db, {
          actor: c.get("user").id,
          action: "role.revoked",
          target: userId,
          detail: { role },
        });
      }
      deps.logger.info({ actor: c.get("user").id, userId, role, revoked }, "role revoke processed");
      return c.json({ role, revoked });
    }
    // R-16-6 审批路径：本就没持有 = 没有可确认的变更
    if (!(await deps.authzStore.getRoles(userId)).includes(role)) {
      return c.json({ role, revoked: false }, 200);
    }
    const outcome = await submitApprovalRequest(deps.db, {
      subjectType: ROLE_APPROVAL_SUBJECT_TYPE,
      subjectId: userId,
      configKey: ROLE_APPROVAL_CONFIG_KEY,
      submitterId: c.get("user").id,
      payload: { action: "revoke", role },
    });
    return approvalOutcomeResponse(c, deps, c.get("user").id, outcome, { role, revoked: false }, "role revoke");
  });

  return app;
}

/**
 * 审批提交的三种落点（授予/撤销共用一个形状）：
 * - 建 202：请求已建，payload 已带 action/role，等老板终审（批准即生效）；
 * - 已在飞 409：同单同线至多一个在飞请求（内核部分唯一索引背书）；
 * - 线不存在/停用/坏掉 403 owner_approval_required：切片 1 的 fail-closed 等价
 *   物——高级角色变更退回「只允许 owner 直接执行」，不因配置缺位而放开。
 */
function approvalOutcomeResponse(
  c: Context<AppEnv>,
  deps: { logger: Logger },
  actorId: string,
  outcome: Awaited<ReturnType<typeof submitApprovalRequest>>,
  noChangeBody: Record<string, unknown>,
  what: string,
): Response {
  if (outcome.status === "created") {
    deps.logger.info({ actor: actorId, requestId: outcome.requestId, what }, "role change sent to approval");
    return c.json({ ...noChangeBody, approval: { requestId: outcome.requestId } }, 202);
  }
  if (outcome.reason === "already_pending") {
    return c.json(
      { error: "conflict", code: "owner_approval_pending", requestId: outcome.requestId },
      409,
    );
  }
  if (outcome.reason === "payload_required") {
    // 进程内提交永远带 payload；走到这里是 role-approval 接线被改坏，按配置错误拒
    deps.logger.error({ what }, "role approval submitted without payload");
    return c.json({ error: "invalid_request" }, 400);
  }
  return c.json({ error: "forbidden", code: "owner_approval_required" }, 403);
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
