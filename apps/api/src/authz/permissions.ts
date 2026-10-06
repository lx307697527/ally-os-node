import { z } from "zod";

/**
 * 角色与权限点注册表（#23）。
 *
 * 与老系统的对应：老系统 `core.app_role` 枚举（16 个值）+ `core.user_roles` 表 +
 * `has_role()`/`has_any_role()` SECURITY DEFINER 函数支撑 679 条 RLS 策略；新系统
 * 按 #232 §12 收敛为 14 个员工角色 + 客户门户（枚举见 packages/db schema 的
 * app_role），授权挪到 API 层，这里就是服务端的单一真相源。
 *
 * 「权限点 = 一组角色」的默认矩阵是裁决原文的代码化（docs/permissions.md 有对照表）：
 * 大多数权限点随业务模块切片逐个进场（quotes.*、orders.*…），当前只有管理 RBAC
 * 自身所需的两个。角色默认集之外还能给人单独授权限点（如「标签设计」授给任意
 * 角色的人，或给外部设计师开无员工角色的受限账号），存 user_permission 表。
 */

export const ROLES = [
  "owner",
  "admin",
  "sales_lead",
  "sales",
  "customer_service",
  "sales_assistant",
  "ops_assistant",
  "formulator",
  "purchaser",
  "warehouse",
  "production_lead",
  "qa",
  "lab_technician",
  "finance",
  "customer",
] as const;

export type Role = (typeof ROLES)[number];

export const roleSchema = z.enum(ROLES);

/** 请求上下文里的授权快照：authzMiddleware 每请求加载一次，链上的 requireX 直接读 */
export interface AuthzContext {
  roles: readonly Role[];
  permissions: ReadonlySet<Permission>;
}

/** 权限点清单；随业务模块切片增加，新增必须先进这个注册表 */
export const PERMISSIONS = ["roles.assign", "label_design", "audit.read", "workflow.configure", "approval.configure", "custom_fields.configure"] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const permissionSchema = z.enum(PERMISSIONS);

/**
 * 角色的默认权限点。刻意让矩阵「缺省为空」：一个权限点要么写在这里有出处，
 * 要么不存在——不存在「隐式全员」。
 *
 * - roles.assign：管理员（#232 §12「管理员：分配权限」）。owner 也持有：R-16-6
 *   要求授予 owner/admin/finance 级需老板确认，在审批流（#221）落地前，这类
 *   授予直接只允许 owner 本人执行（fail closed，见 routes/user-roles.ts）。
 * - label_design：无角色默认携带——裁决原文「标签设计是独立权限点，不新增角色，
 *   管理员可授予任意角色的人」，只能单独授人。
 * - audit.read：老板与管理员（#29；#232 §12 老板「全部查看」+ 管理员是系统
 *   操作者）。审计日志含全公司人员操作记录，不给其余角色默认开。
 * - workflow.configure：老板与管理员（#220）。流程模板属配置工作室（#232 §4.4
 *   「灵活性集中做在一个公共的配置工作室里」），改流程 = 改全员的工作方式，
 *   与规则注册表的管理者同一批人（§12 管理员「维护规则注册表中的管理员项」）；
 *   实例的推进不在此权限点后面——能推进谁由属主域的可见性门与模板 roles 裁决。
 * - approval.configure：老板与管理员（#221）。审批线属配置工作室——改审批路线
 *   = 改「谁有权裁决什么」（#221「配置审批人（指定人员或角色）」），与流程/规则
 *   的管理者同一批人；请求的提交与裁决不在此权限点后面——单据可见性门与配置
 *   点名（users/roles）各裁各的，审批自批合法（R-16-5）。
 * - custom_fields.configure：老板与管理员（#222）。自定义字段属配置工作室——
 *   给对象加字段 = 改所有人的表单与详情页，与流程/审批的管理者同一批人；字段
 *   值的填写不在此权限点后面——能不能写某个字段由字段级 viewableBy/editableBy
 *   与 subject 可见性门裁决，配置权和填写权分离。
 */
export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  owner: ["roles.assign", "audit.read", "workflow.configure", "approval.configure", "custom_fields.configure"],
  admin: ["roles.assign", "audit.read", "workflow.configure", "approval.configure", "custom_fields.configure"],
  sales_lead: [],
  sales: [],
  customer_service: [],
  sales_assistant: [],
  ops_assistant: [],
  formulator: [],
  purchaser: [],
  warehouse: [],
  production_lead: [],
  qa: [],
  lab_technician: [],
  finance: [],
  customer: [],
};

/**
 * R-16-6：授予/撤销这几个角色需要老板确认。审批线（authz/role-approval.ts 的
 * user_role/role_grant）已配置时走审批——老板终审批准即生效；线未配置时保持
 * fail-closed 等价物：只允许 owner 本人直接执行（routes/user-roles.ts）。
 */
export const OWNER_APPROVAL_ROLES: readonly Role[] = ["owner", "admin", "finance"];

/** 角色默认集 + 个人附加授权 = 生效权限集（user_permission 表存个人附加授权） */
export function effectivePermissions(
  roles: readonly Role[],
  directGrants: readonly Permission[],
): Set<Permission> {
  const granted = new Set<Permission>(directGrants);
  for (const role of roles) {
    for (const permission of ROLE_PERMISSIONS[role]) granted.add(permission);
  }
  return granted;
}
