import { and, desc, eq, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Hono } from "hono";
import { z } from "zod";
import type { Db } from "@ally/db";
import { schema } from "@ally/db";
import type { AppEnv } from "../auth/session.ts";
import { loadVisibleSubject } from "../subjects/registry.ts";

/**
 * 活动流端点（#110 切片 3：每个业务对象的活动时间线）。
 *
 * 老系统对应物 crm.activities（subject_type/subject_id 多态活动表，业务写入
 * 时手工落一行）——不照搬。新系统的每个业务变更**已经在同一事务里落了审计**
 * （#29：task.created/updated/status_changed/assigned、comment.created/deleted，
 * 全部由真实生产者写入），活动流若再立一张表，等于每个域把同一事实写两遍、
 * 且两条写路径早晚会分叉。裁决：**活动流是 audit_events 的按对象读投影**——
 * 一条事实流，两个读者（系统审计页 audit.read 门，管理面向；本端点 subject
 * 可见者门，协作面向）。审计行的「不可变」正好是活动史需要的语义：发生过的
 * 事不会被改写。
 *
 * 行 → subject 的归属约定（docs/audit.md 同步）：一行审计属于 subject (T, ID)
 * 当且仅当 target = ID（动作直接落在该对象上），或 detail.subjectType = T 且
 * detail.subjectId = ID（多态子对象挂在 subject 上，如评论）。target 列的
 * 语义就是「被操作的业务对象 id」，不是发明新约定。不匹配任何 subject 的行
 * （role.granted 等）不出现在任何活动流里。
 *
 * 授权：subject 可见者即可读（与评论同一扇门，subjects/registry.ts），不新增
 * 权限点——投影只含该 subject 自己的行，看得到对象就看得到对象的历史；全公司
 * 的日志仍走 audit.read（#29）。排序最新在前（与审计日志页同一读法），分页
 * limit/offset + 精确 total（与 comments/tasks/audit-events 一致）。
 */

/** 单页默认与上限：与评论列表同档 */
export const ACTIVITY_PAGE_MAX = 100;
const ACTIVITY_PAGE_DEFAULT = 50;

const querySchema = z.object({
  subjectType: z.string().min(1).max(50),
  subjectId: z.uuid(),
  limit: z.coerce.number().int().min(1).max(ACTIVITY_PAGE_MAX).default(ACTIVITY_PAGE_DEFAULT),
  offset: z.coerce.number().int().min(0).default(0),
});

export function activityRoutes(deps: { db: Db }) {
  const app = new Hono<AppEnv>();

  app.get("/api/activity", async (c) => {
    const parsed = querySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const { subjectType, subjectId, limit, offset } = parsed.data;
    const me = c.get("user").id;
    const subject = await loadVisibleSubject(deps.db, subjectType, subjectId, me);
    if (subject === "unregistered") {
      return c.json({ error: "invalid_request" }, 400);
    }
    if (subject === null) {
      return c.json({ error: "not_found" }, 404);
    }

    const where = subjectFilter(subjectType, subjectId);
    const actorUser = alias(schema.authUser, "actor_user");
    const [rows, totalRows] = await Promise.all([
      deps.db
        .select({
          id: schema.auditEvents.id,
          action: schema.auditEvents.action,
          target: schema.auditEvents.target,
          detail: schema.auditEvents.detail,
          actor: { id: actorUser.id, name: actorUser.name },
          createdAt: schema.auditEvents.createdAt,
        })
        .from(schema.auditEvents)
        .leftJoin(actorUser, sql`${actorUser.id}::text = ${schema.auditEvents.actor}`)
        .where(where)
        .orderBy(desc(schema.auditEvents.createdAt), desc(schema.auditEvents.id))
        .limit(limit)
        .offset(offset),
      deps.db
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.auditEvents)
        .where(where),
    ]);

    return c.json({
      events: rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
      total: totalRows[0]?.n ?? 0,
    });
  });

  return app;
}

/**
 * 行 → subject 的归属条件（裁决见模块注释）：target 直指该对象，或 detail
 * 带多态 subject 引用。detail 为 NULL 时 `->>` 得 NULL，比较自然为假。
 */
function subjectFilter(subjectType: string, subjectId: string): SQL {
  return (
    or(
      eq(schema.auditEvents.target, subjectId),
      and(
        sql`${schema.auditEvents.detail} ->> 'subjectType' = ${subjectType}`,
        sql`${schema.auditEvents.detail} ->> 'subjectId' = ${subjectId}`,
      ),
    ) ?? sql`false`
  );
}
