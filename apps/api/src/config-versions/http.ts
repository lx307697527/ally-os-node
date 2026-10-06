import type { AuthzContext } from "../authz/middleware.ts";
import type { Permission } from "../authz/permissions.ts";
import type { ConfigRevisionTx, ConfigSubjectSpec, SubjectWriteDenial } from "./registry.ts";

/**
 * 配置版本的 HTTP 面共用件（#226）：台账读面/回滚（routes/config-versions.ts）
 * 与草稿/发布（routes/config-drafts.ts）两个路由文件共用「族内动态权限检查」
 * ——台账与草稿都跨五族，每族的门 = 各族配置面的同一权限点（族注册时声明），
 * 形状与 authz/requirePermission 的 403 逐字段同形（配置工作室管理者的「我缺
 * 哪个权限」可诊断性）。
 */

export function permissionFailure(
  authz: AuthzContext,
  spec: ConfigSubjectSpec,
): { error: "forbidden"; code: "permission_required"; permission: Permission } | undefined {
  if (authz.permissions.has(spec.configurePermission)) return undefined;
  return { error: "forbidden", code: "permission_required", permission: spec.configurePermission };
}

/**
 * 逐主体写面门（#233）：族权限点之后的第二扇门（规则注册表的「谁能改」按行的
 * 角色数组裁决）。只挂在写面上（回滚 / 草稿保存与发布）；族未声明钩子 = 只有族
 * 级权限点。
 */
export async function authorizeSubjectWrite(
  spec: ConfigSubjectSpec,
  ctx: {
    db: Pick<ConfigRevisionTx, "select">;
    authz: AuthzContext;
    subjectId: string;
  },
): Promise<SubjectWriteDenial | undefined> {
  if (spec.authorizeWrite === undefined) return undefined;
  return spec.authorizeWrite(ctx);
}
