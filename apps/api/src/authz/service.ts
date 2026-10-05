import { and, eq } from "drizzle-orm";
import type { Db } from "@ally/db";
import { schema } from "@ally/db";
import type { Permission, Role } from "./permissions.ts";
import { permissionSchema } from "./permissions.ts";

/**
 * 授权数据的读写口（#23）。中间件按请求加载，角色管理端点写；生产实现查
 * user_role / user_permission 两张表，测试注入内存假实现。
 */
export interface AuthzStore {
  /** 一个用户持有的全部登录角色（多角色是设计明文：一个人可以同时有多个角色） */
  getRoles(userId: string): Promise<Role[]>;
  /** 单独授予该用户的权限点（不含角色默认集） */
  getDirectPermissions(userId: string): Promise<Permission[]>;
  /** @returns 是否真的写入了（已持有 = false）；审计只记真实变更 */
  grantRole(userId: string, role: Role): Promise<boolean>;
  /** @returns 是否真的删除了（本就没持有 = false）；审计只记真实变更 */
  revokeRole(userId: string, role: Role): Promise<boolean>;
}

export function createAuthzStore(db: Db): AuthzStore {
  return {
    async getRoles(userId) {
      const rows = await db
        .select({ role: schema.userRole.role })
        .from(schema.userRole)
        .where(eq(schema.userRole.userId, userId));
      return rows.map((r) => r.role);
    },

    async getDirectPermissions(userId) {
      const rows = await db
        .select({ permission: schema.userPermission.permission })
        .from(schema.userPermission)
        .where(eq(schema.userPermission.userId, userId));
      // permission 列是 text（开集），注册表才是合法性来源：库里出现注册表不认识的
      // 值（如权限点改名后的残留）时不授予、不报错——fail closed 且不炸用户
      return rows.flatMap((r) => {
        const parsed = permissionSchema.safeParse(r.permission);
        return parsed.success ? [parsed.data] : [];
      });
    },

    async grantRole(userId, role) {
      const inserted = await db
        .insert(schema.userRole)
        .values({ userId, role })
        .onConflictDoNothing()
        .returning({ userId: schema.userRole.userId });
      return inserted.length > 0;
    },

    async revokeRole(userId, role) {
      const deleted = await db
        .delete(schema.userRole)
        .where(and(eq(schema.userRole.userId, userId), eq(schema.userRole.role, role)))
        .returning({ userId: schema.userRole.userId });
      return deleted.length > 0;
    },
  };
}
