import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { Db } from "@ally/db";
import { schema } from "@ally/db";
import type { Logger } from "pino";
import { recordAudit } from "../audit/audit-log.ts";
import { ensureShadowAccount, ShadowAccountInputError } from "../auth/shadow-account.ts";
import type { AppEnv } from "../auth/session.ts";
import { requirePermission } from "../authz/middleware.ts";
import { OWNER_APPROVAL_ROLES, roleSchema, type Role } from "../authz/permissions.ts";
import type { AuthzStore } from "../authz/service.ts";

/**
 * 用户生命周期管理（#26）：花名册、创建邀请、改名、停用/启用。
 *
 * 与老系统的对应：老系统没有这套面——staff-invite edge function（super_admin
 * 专属）管建号，core.users.status 枚举定义了 active|suspended|disabled 却没有
 * 任何实现路径，删除从未落地；issue #26「老系统现状」描述的 admin-create-user /
 * AdminUsers 页面在老库中不存在（写 issue 时凭记忆引用了更早的系统）。新系统按
 * #232 §12 + #144 裁决自建：团队管理（users.manage 权限点，owner/admin 默认）
 * 在服务端 API，前端不持有任何管理权限。
 *
 * 裁决（docs/teams.md 有全文）：
 * - **创建 = 影子账号服务 + 初始角色 + 激活邮件**。#25「所有新增账号代码路径
 *   都调同一个服务函数」——管理员建员工号与 CRM 预建客户号是同一条 insert 路径
 *   （无密码 credential，emailVerified=true：激活邮件本身发往该地址，地址在
 *   激活那一刻自证；老 staff-invite 的 email_confirm: true 同款）。激活链接走
 *   密码重置通道（better-auth 对无凭据账号当场建 credential，#25 源码确认），
 *   邮件措辞由回调按「有没有设过密码」分流成邀请（#26）或重置（#22）。
 * - **创建面不收特权角色**。owner/admin/finance 的授予必须走 user-roles 端点的
 *   R-16-6 门（审批线或 owner 亲执）——建号面不开第二条通道；带特权角色的请求
 *   整单 400 拒绝，先建后授是唯一顺序。
 * - **停用是除名的唯一入口，删除没有端点**。审计 append-only（#29）+ 业务外键
 *   级联会毁记录，硬删除不提供；将来的极端情形（如监管要求的记录抹除）走独立
 *   的匿名化流程，不冒充成「删用户」。停用 = 盖 disabledAt + 同事务删全部会话
 *   （拿着旧 cookie 的请求当场失效）+ 审计；登录面在 better-auth 钩子拒绝新
 *   会话，会话解析器兜竞态（auth/auth.ts）。幂等：已是目标态 200 不审计
 *   （real-change-only 纪律，同 role.granted）。
 * - **老板的账号只有老板能动**。停用/启用 owner 角色的用户要求操作者本人持有
 *   owner 角色（403 owner_required，R-16-6 同族裁决：下级不能动老板的账号）。
 *   「停用最后一个 owner」由此结构性不可能：停 owner 需要操作者是另一个在职
 *   owner，自己停自己被 409 挡住——任何时刻至少剩操作者本人在职。角色本身的
 *   撤销另有 grant-role CLI 作运维恢复通道（#23）。
 */
export function usersRoutes(deps: {
  db: Db;
  authzStore: AuthzStore;
  logger: Logger;
  /**
   * 给指定邮箱发「设密码激活」邮件（#26）：生产走 better-auth 的
   * requestPasswordReset（复用 sendResetPassword 回调——它按凭据存在性把措辞
   * 分流成邀请或重置）。与认证回调同一裁定：发送失败不阻塞建号、不抛出
   * （失败只记日志，用户可自助再走一次忘记密码）。测试注入记录器。
   */
  sendPasswordSetupEmail: (email: string) => Promise<void>;
}) {
  const app = new Hono<AppEnv>();
  const requireUsersManage = requirePermission("users.manage");

  // 创建面的角色词表 = 全部角色 − R-16-6 特权角色，从注册表派生：注册表增删
  // 角色时这里自动跟随，不会长出第二份手抄清单。
  const creatableRoles = roleSchema.options.filter(
    (role) => !(OWNER_APPROVAL_ROLES as readonly string[]).includes(role),
  ) as Exclude<Role, (typeof OWNER_APPROVAL_ROLES)[number]>[];

  const uuidParam = z.uuid();

  // 花名册（#26；老 security.team_role_grants_read 视图的后继读法）：全量用户
  // （含客户影子账号——它们在同一个账号池里，roles 列让人一眼分辨），角色聚合
  // 随行。停用筛选是管理员的主读法（离职即停用，active 是默认视角）。
  const listQuery = z.object({
    status: z.enum(["active", "disabled"]).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
    offset: z.coerce.number().int().min(0).default(0),
  });

  app.get("/api/users", requireUsersManage, async (c) => {
    const parsed = listQuery.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const { status, limit, offset } = parsed.data;
    const where =
      status === "active"
        ? isNull(schema.authUser.disabledAt)
        : status === "disabled"
          ? isNotNull(schema.authUser.disabledAt)
          : undefined;
    // ::text cast：app_role 的数组类型没有 node-pg 解析器，原样返回会是一段
    // "{sales}" 字符串；cast 成 text[] 让驱动还原成 JS 数组
    const rolesAgg = sql<string[]>`coalesce(array_agg(${schema.userRole.role}::text) filter (where ${schema.userRole.role} is not null), '{}')`;
    const [rows, totalRows] = await Promise.all([
      deps.db
        .select({
          id: schema.authUser.id,
          name: schema.authUser.name,
          email: schema.authUser.email,
          emailVerified: schema.authUser.emailVerified,
          disabledAt: schema.authUser.disabledAt,
          createdAt: schema.authUser.createdAt,
          roles: rolesAgg,
        })
        .from(schema.authUser)
        .leftJoin(schema.userRole, eq(schema.userRole.userId, schema.authUser.id))
        .where(where)
        .groupBy(schema.authUser.id)
        .orderBy(asc(schema.authUser.name), asc(schema.authUser.id))
        .limit(limit)
        .offset(offset),
      deps.db.select({ n: sql<number>`count(*)::int` }).from(schema.authUser).where(where),
    ]);
    return c.json({ users: rows, total: totalRows[0]?.n ?? 0 });
  });

  const createBody = z
    .object({
      // 邮箱与名字的归一化、格式校验都在 ensureShadowAccount（唯一 insert 路径
      // 自带同一道门）；这里只收形状，避免两份规则漂移。
      email: z.string(),
      name: z.string().optional(),
      roles: z.array(z.enum(creatableRoles)).optional(),
    })
    .strict();

  app.post("/api/users", requireUsersManage, async (c) => {
    const parsed = createBody.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    // 特权角色不在创建面：R-16-6 的授予门（审批线 / owner 亲执）在 user-roles
    // 端点，zod 词表里就没有这三个值——形状层即策略，连 owner 本人也不能在建号
    // 请求里夹带（先建后授，审批记录里才有一个「谁授的」可追溯动作）。
    const requestedRoles: Role[] = parsed.data.roles ?? [];
    const granted: Role[] = [];
    let shadow: Awaited<ReturnType<typeof ensureShadowAccount>>;
    try {
      shadow = await ensureShadowAccount(deps.db, { email: parsed.data.email, name: parsed.data.name }, { logger: deps.logger });
    } catch (err) {
      // 邮箱/名字不合法：4xx 语义，别落进 500（ShadowAccountInputError 就是
      // 为调用方转客户报错设计的）
      if (err instanceof ShadowAccountInputError) {
        return c.json({ error: "invalid_request" }, 400);
      }
      throw err;
    }
    if (!shadow.created) {
      return c.json({ error: "conflict", code: "user_exists", userId: shadow.user.id }, 409);
    }
    for (const role of requestedRoles) {
      if (await deps.authzStore.grantRole(shadow.user.id, role)) {
        granted.push(role);
        await recordAudit(deps.db, {
          actor: c.get("user").id,
          action: "role.granted",
          target: shadow.user.id,
          detail: { role, via: "user_created" },
        });
      }
    }
    await recordAudit(deps.db, {
      actor: c.get("user").id,
      action: "user.created",
      target: shadow.user.id,
      detail: { email: shadow.user.email, name: shadow.user.name, roles: granted, invited: true },
    });
    // 激活邮件最后发：失败不抛（回调内部已降级日志），建号不回滚——账号是事实，
    // 邮件可以重触发（用户自助走忘记密码）。
    await deps.sendPasswordSetupEmail(shadow.user.email);
    deps.logger.info(
      { actor: c.get("user").id, userId: shadow.user.id, roles: granted },
      "user created with invite",
    );
    return c.json({ user: shadow.user, roles: granted, inviteRequested: true }, 201);
  });

  const renameBody = z.object({ name: z.string().trim().min(1).max(200) }).strict();

  app.patch("/api/users/:userId", requireUsersManage, async (c) => {
    const parsedId = uuidParam.safeParse(c.req.param("userId"));
    if (!parsedId.success) {
      return c.json({ error: "not_found" }, 404);
    }
    const parsed = renameBody.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const userId = parsedId.data;
    const target = await loadUser(deps.db, userId);
    if (target === undefined) {
      return c.json({ error: "not_found" }, 404);
    }
    // real-change-only：同名幂等返回，不留审计、不动行（role.granted 同纪律）
    if (target.name === parsed.data.name) {
      return c.json({ user: { id: target.id, name: target.name } });
    }
    await deps.db
      .update(schema.authUser)
      .set({ name: parsed.data.name, updatedAt: new Date() })
      .where(eq(schema.authUser.id, userId));
    await recordAudit(deps.db, {
      actor: c.get("user").id,
      action: "user.updated",
      target: userId,
      detail: { field: "name", from: target.name, to: parsed.data.name },
    });
    return c.json({ user: { id: userId, name: parsed.data.name } });
  });

  for (const verb of ["disable", "enable"] as const) {
    const disabling = verb === "disable";
    app.post(`/api/users/:userId/${verb}`, requireUsersManage, async (c) => {
      const parsedId = uuidParam.safeParse(c.req.param("userId"));
      if (!parsedId.success) {
        return c.json({ error: "not_found" }, 404);
      }
      const userId = parsedId.data;
      const target = await loadUser(deps.db, userId);
      if (target === undefined) {
        return c.json({ error: "not_found" }, 404);
      }
      if (disabling && userId === c.get("user").id) {
        return c.json({ error: "conflict", code: "self_disable" }, 409);
      }
      // 老板的账号只有老板能动（含停用与启用两个方向）；owner 之外的管理员
      // 碰 owner 角色的用户 403。self_disable 已挡「owner 停自己」，所以这条
      // 门后任何时刻都还有至少一个在职 owner（操作者本人）。门在幂等短路
      // 之前：对碰不得的目标，连「它已是目标态吗」都不回答（信息纪律）。
      if (target.roles.includes("owner") && !c.get("authz").roles.includes("owner")) {
        return c.json({ error: "forbidden", code: "owner_required" }, 403);
      }
      // 幂等：已是目标态 = 没有可审计的变更（第二个停用者不产生第二行审计）
      const already = disabling ? target.disabledAt != null : target.disabledAt == null;
      if (already) {
        return c.json({ disabled: disabling });
      }
      const stamped = await deps.db.transaction(async (tx) => {
        // 条件盖戳：并发同动词时只有一个事务盖到（另一边 returning 空事务即空转）
        const rows = await tx
          .update(schema.authUser)
          .set({ disabledAt: disabling ? new Date() : null, updatedAt: new Date() })
          .where(
            and(
              eq(schema.authUser.id, userId),
              disabling ? isNull(schema.authUser.disabledAt) : isNotNull(schema.authUser.disabledAt),
            ),
          )
          .returning({ id: schema.authUser.id });
        if (rows.length === 0) return false;
        if (disabling) {
          // 停用即全端登出：会话行与盖戳同事务——旧 cookie 当场失效，不等自然过期
          const sessions = await tx
            .delete(schema.authSession)
            .where(eq(schema.authSession.userId, userId))
            .returning({ id: schema.authSession.id });
          deps.logger.info({ userId, revokedSessions: sessions.length }, "sessions revoked on disable");
        }
        await recordAudit(tx, {
          actor: c.get("user").id,
          action: disabling ? "user.disabled" : "user.enabled",
          target: userId,
          detail: { email: target.email },
        });
        return true;
      });
      if (!stamped) {
        // 并发对手赢了：重读一次给出现状（幂等语义，不报错）
        const now = await loadUser(deps.db, userId);
        return c.json({ disabled: now?.disabledAt != null });
      }
      deps.logger.info({ actor: c.get("user").id, userId, action: verb }, "user lifecycle change");
      return c.json({ disabled: disabling });
    });
  }

  return app;
}

async function loadUser(
  db: Db,
  userId: string,
): Promise<{ id: string; email: string; name: string; disabledAt: Date | null; roles: Role[] } | undefined> {
  const rows = await db
    .select({
      id: schema.authUser.id,
      email: schema.authUser.email,
      name: schema.authUser.name,
      disabledAt: schema.authUser.disabledAt,
    })
    .from(schema.authUser)
    .where(eq(schema.authUser.id, userId))
    .limit(1);
  const row = rows[0];
  if (row === undefined) return undefined;
  const roles = await db
    .select({ role: schema.userRole.role })
    .from(schema.userRole)
    .where(eq(schema.userRole.userId, userId));
  return { ...row, roles: roles.map((r) => r.role) };
}
