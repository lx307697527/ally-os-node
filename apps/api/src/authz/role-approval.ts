import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@ally/db";
import { schema } from "@ally/db";
import { registerApprovalOutcome } from "../approval/outcomes.ts";
import { recordAudit } from "../audit/audit-log.ts";
import { SUBJECT_LOADERS } from "../subjects/registry.ts";
import type { Permission, Role } from "./permissions.ts";
import { OWNER_APPROVAL_ROLES, ROLE_PERMISSIONS, roleSchema } from "./permissions.ts";
import { createAuthzStore } from "./service.ts";

/**
 * R-16-6 的审批消费方（#221 切片 2）：管理员授予/撤销 owner/admin/finance 级
 * 角色走审批，老板终审批准即生效（#232 §12「分配权限（授予老板 / 财务 / 管理员
 * 级需老板确认）」）。审批内核只裁决不执行——本模块把 user_role 这个 subject
 * 接进内核的三个接缝：
 *
 * 1. **可见性门**（subjects/registry.ts）：审批详情必须给审批人看「批的是谁、
 *    什么角色」。user_role 的可见者 = 目标用户本人 + 持有 roles.assign 角色
 *    （owner/admin）的人——与角色管理端点同一扇权限门。
 * 2. **批准即生效**（approval/outcomes.ts）：终审批准的同一事务里执行角色变更
 *    并落 role.granted/role.revoked 审计（actor = 老板，detail 带 via/requestId
 *    ——「所有权限变更留审计」R-16-6）。终审前变更已被 owner 直接执行时幂等
 *    收场，不重复审计。
 * 3. **提交路径**：routes/user-roles.ts 进程内带 payload 提交（通用提交端点对
 *    带 outcome 的类型强制 payload_required，无参数死请求进不来）。进哪条线由
 *    注册表路由决策表 `approval.routing.user_role` 裁决（approval/routing.ts，
 *    #221 决策表进线）；种子表把 grant/revoke 都指向下面的 ROLE_APPROVAL_CONFIG_KEY。
 *
 * 审批线（approval_configs 里 subjectType=user_role、configKey=role_grant）由
 * 持 approval.configure 的人按需创建；线不存在或路由未命中时保持切片 1 前的
 * fail-closed 等价物（高权限变更只允许 owner 直接执行）——不预置线数据，配置
 * 工作室的归配置工作室（线定义不可改写，#226 前不替 owner 定终身）。
 */

export const ROLE_APPROVAL_SUBJECT_TYPE = "user_role";
/** 种子路由表（approval.routing.user_role）输出的线键；线的创建仍是配置面的事 */
export const ROLE_APPROVAL_CONFIG_KEY = "role_grant";

/** 请求参数：变更方向 + 目标角色。只服务高权限角色门——低权限不进审批线 */
export const roleApprovalPayloadSchema = z
  .object({ action: z.enum(["grant", "revoke"]), role: roleSchema })
  .refine((payload) => OWNER_APPROVAL_ROLES.includes(payload.role), {
    message: "only owner-approval roles go through the approval line",
  });

/** 持有 roles.assign 的角色（权限矩阵的推导，不硬编码两份） */
const ASSIGNER_ROLES: readonly Role[] = (
  Object.entries(ROLE_PERMISSIONS) as [Role, readonly Permission[]][]
)
  .filter(([, permissions]) => permissions.includes("roles.assign"))
  .map(([role]) => role);

SUBJECT_LOADERS.user_role = async (db: Db, subjectId: string) => {
  const rows = await db
    .select({ id: schema.authUser.id, name: schema.authUser.name })
    .from(schema.authUser)
    .where(eq(schema.authUser.id, subjectId))
    .limit(1);
  const user = rows[0];
  if (user === undefined) return null;
  const viewers = new Map<string, { id: string; name: string }>([
    [user.id, { id: user.id, name: user.name }],
  ]);
  const assigners = await db
    .select({ id: schema.authUser.id, name: schema.authUser.name })
    .from(schema.userRole)
    .innerJoin(schema.authUser, eq(schema.userRole.userId, schema.authUser.id))
    .where(inArray(schema.userRole.role, [...ASSIGNER_ROLES]));
  for (const person of assigners) {
    viewers.set(person.id, { id: person.id, name: person.name });
  }
  return { id: user.id, title: `Roles · ${user.name}`, viewers: [...viewers.values()] };
};

registerApprovalOutcome(ROLE_APPROVAL_SUBJECT_TYPE, async (tx, ctx) => {
  const parsed = roleApprovalPayloadSchema.safeParse(ctx.payload);
  if (!parsed.success) {
    // 提交时已过 zod；走到这里是库内数据被外力改歪——终审整体回滚（fail
    // closed），绝不批准一个解释不了的请求
    throw new Error(`approval outcome ${ctx.requestId}: user_role payload invalid`);
  }
  const store = createAuthzStore(tx);
  const changed =
    parsed.data.action === "grant"
      ? await store.grantRole(ctx.subjectId, parsed.data.role)
      : await store.revokeRole(ctx.subjectId, parsed.data.role);
  if (!changed) {
    // 终审前 owner 已直接执行同一变更：幂等收场（批准照常完成），审计只记真实变更
    return;
  }
  await recordAudit(tx, {
    actor: ctx.actorId,
    action: parsed.data.action === "grant" ? "role.granted" : "role.revoked",
    target: ctx.subjectId,
    detail: {
      role: parsed.data.role,
      via: "approval",
      requestId: ctx.requestId,
      submittedBy: ctx.submittedById,
    },
  });
});
