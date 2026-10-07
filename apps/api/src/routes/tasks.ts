import { and, asc, eq, isNull, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Hono } from "hono";
import { z } from "zod";
import type { Db } from "@ally/db";
import { schema } from "@ally/db";
import { recordAudit } from "../audit/audit-log.ts";
import type { AppEnv } from "../auth/session.ts";
import { isSubjectSigned } from "../esign/service.ts";
import { recordDeletion } from "../records/deleted-records.ts";

/**
 * 任务端点（#113 切片 1：任务内核）。
 *
 * 老系统三套任务表收敛为一套（裁决记录在 packages/db schema 的 tasks 注释与
 * PR 正文）；业务对象附着列随第一个业务域切片 expand-only 进场，本切片的任务
 * 都是独立任务。授权沿用「本人数据、登录即可」的既有先例（通知 #129、反馈
 * #129）：创建人或经办人可见可改，团队全局视图（老系统按成员开标签页的看板）
 * 需要权限点裁决，随 RBAC 模块切片再议。
 *
 * 可分配面 = 至少持有一个非 customer 角色的用户（老系统「每个可分配成员」；
 * 零角色账号与纯门户账号不可被派任务）。分配动作写站内通知（task.assigned，
 * 通知表的第一个真实生产者；统一通知服务与邮件渠道随 #116 落地）；真实状态
 * 流转再把 task.status_changed 投递给关注者（#110 关注内核的任务侧消费，
 * 名单与去重裁决见 PATCH 内注释）。每次真实变更在同一事务里写审计（#29 约
 * 定：状态变更带 from/to，审计失败则业务失败）。
 * 通知落库、事务提交后，再对被通知者发一次实时「催」（#110 切片 2）——催不
 * 携带数据，铃铛重读 summary；催失败只降级回轮询，实现方保证不 reject。
 */

/** 列表单页上限；分页语义与 audit-events 一致（limit/offset + 精确 total） */
export const TASKS_PAGE_MAX = 100;
const TASKS_PAGE_DEFAULT = 50;

const taskStatusSchema = z.enum(["open", "done", "cancelled"]);

/** 字段上限与反馈上报同一档：title 200、description 5000 */
const createBody = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(5000).optional(),
  dueAt: z.iso.datetime().optional(),
  assigneeId: z.uuid().optional(),
});

const patchBody = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().min(1).max(5000).nullable().optional(),
  dueAt: z.iso.datetime().nullable().optional(),
  status: taskStatusSchema.optional(),
  assigneeId: z.uuid().nullable().optional(),
});

const listQuery = z.object({
  scope: z.enum(["assigned", "created"]).default("assigned"),
  status: taskStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(TASKS_PAGE_MAX).default(TASKS_PAGE_DEFAULT),
  offset: z.coerce.number().int().min(0).default(0),
});

type Tx = Parameters<Db["transaction"]>[0] extends (tx: infer T) => unknown ? T : never;

export function tasksRoutes(deps: { db: Db; notifyUsers: (userIds: string[]) => Promise<void> }) {
  const app = new Hono<AppEnv>();

  // 字面路由先于 /:id 注册（Hono 按注册顺序匹配，"assignee-options" 不能落进 uuid 校验）
  app.get("/api/tasks/assignee-options", async (c) => {
    // 可分配面：至少一个非 customer 角色。存在多角色的行用 distinct 收敛
    const rows = await deps.db
      .selectDistinct({
        id: schema.authUser.id,
        name: schema.authUser.name,
        email: schema.authUser.email,
      })
      .from(schema.authUser)
      .innerJoin(schema.userRole, eq(schema.userRole.userId, schema.authUser.id))
      .where(sql`${schema.userRole.role} <> 'customer'`)
      .orderBy(asc(schema.authUser.name), asc(schema.authUser.id));
    return c.json({ assignees: rows });
  });

  app.get("/api/tasks", async (c) => {
    const parsed = listQuery.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const { scope, status, limit, offset } = parsed.data;
    const me = c.get("user").id;
    // 本人数据只按行属读：经办人是我的 / 是我建的两类，越权行不进结果集；
    // 软删行对一切读面不可见（删除后的任务连行属也看不到，恢复是 audit.read 面）
    const ownership = and(
      scope === "assigned" ? eq(schema.tasks.assigneeId, me) : eq(schema.tasks.createdById, me),
      isNull(schema.tasks.deletedAt),
    );
    const where = status === undefined ? ownership : and(ownership, eq(schema.tasks.status, status));
    const [rows, totalRows] = await Promise.all([
      selectTaskRows(deps.db, where)
        .limit(limit)
        .offset(offset),
      deps.db.select({ n: sql<number>`count(*)::int` }).from(schema.tasks).where(where),
    ]);
    return c.json({ tasks: rows, total: totalRows[0]?.n ?? 0 });
  });

  app.post("/api/tasks", async (c) => {
    const parsed = createBody.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const me = c.get("user");
    let assignee: AssigneeRef | null = null;
    if (parsed.data.assigneeId !== undefined) {
      const found = await findAssignableUser(deps.db, parsed.data.assigneeId);
      if (found === null) {
        return c.json({ error: "invalid_assignee" }, 400);
      }
      assignee = found;
    }
    const created = await deps.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(schema.tasks)
        .values({
          title: parsed.data.title,
          description: parsed.data.description,
          dueAt: parsed.data.dueAt === undefined ? undefined : new Date(parsed.data.dueAt),
          assigneeId: assignee?.id ?? null,
          createdById: me.id,
        })
        .returning({ id: schema.tasks.id });
      const task = inserted[0];
      if (task === undefined) throw new Error("task insert returned no row");
      await recordAudit(tx, {
        actor: me.id,
        action: "task.created",
        target: task.id,
        detail: { title: parsed.data.title, assignee: assignee?.id ?? null },
      });
      // 派给自己不通知自己（与 PATCH 同一裁定）
      let notifiedUserId: string | null = null;
      if (assignee !== null && assignee.id !== me.id) {
        await notifyAssignee(tx, task.id, parsed.data.title, assignee.id, me.name);
        notifiedUserId = assignee.id;
      }
      return { id: task.id, notifiedUserId };
    });
    // 通知已随事务落库，实时「催」在提交后发（#110 切片 2）：铃铛收到后重读
    // summary，读到的就是已提交的数据
    if (created.notifiedUserId !== null) {
      await deps.notifyUsers([created.notifiedUserId]);
    }
    const rows = await selectTaskRows(deps.db, eq(schema.tasks.id, created.id)).limit(1);
    const row = rows[0];
    if (row === undefined) throw new Error("task row missing right after insert");
    return c.json({ task: row }, 201);
  });

  app.get("/api/tasks/:id", async (c) => {
    const parsed = z.uuid().safeParse(c.req.param("id"));
    if (!parsed.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const me = c.get("user").id;
    // 不存在与不属于同回答：404，调用方拿不到探测结论
    const rows = await selectTaskRows(
      deps.db,
      and(eq(schema.tasks.id, parsed.data), taskVisibleTo(me)),
    ).limit(1);
    const task = rows[0];
    if (task === undefined) {
      return c.json({ error: "not_found" }, 404);
    }
    return c.json({ task });
  });

  app.patch("/api/tasks/:id", async (c) => {
    const idParse = z.uuid().safeParse(c.req.param("id"));
    if (!idParse.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const body = patchBody.safeParse(await c.req.json().catch(() => undefined));
    if (!body.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const me = c.get("user");
    const current = await selectTaskRows(
      deps.db,
      and(eq(schema.tasks.id, idParse.data), taskVisibleTo(me.id)),
    ).limit(1);
    const task = current[0];
    if (task === undefined) {
      return c.json({ error: "not_found" }, 404);
    }
    // 签名锁定（#219）：签过名的记录一律拒改——更正走新记录或变更流程，不走
    // 改写。可签名注册表（esign/registry.ts）为空时任务上不可能有签名，此处
    // 恒通过；首个把 task 注册为可签名的域进场那天，这行检查即生效。
    if (await isSubjectSigned(deps.db, "task", task.id)) {
      return c.json({ error: "record_signed" }, 409);
    }
    // 派给谁只有创建人能改；经办人改自己的任务内容与状态
    if (body.data.assigneeId !== undefined && task.createdBy?.id !== me.id) {
      return c.json({ error: "forbidden", code: "assignee_creator_only" }, 403);
    }
    let nextAssignee: AssigneeRef | null = task.assignee;
    if (body.data.assigneeId !== undefined) {
      if (body.data.assigneeId === null) {
        nextAssignee = null;
      } else {
        const found = await findAssignableUser(deps.db, body.data.assigneeId);
        if (found === null) {
          return c.json({ error: "invalid_assignee" }, 400);
        }
        nextAssignee = found;
      }
    }

    // 先算差异：真变化才写审计、才动行；no-op 的 PATCH 不碰 updatedAt
    const set: Partial<typeof schema.tasks.$inferInsert> = {};
    const changedFields: string[] = [];
    if (body.data.title !== undefined && body.data.title !== task.title) {
      set.title = body.data.title;
      changedFields.push("title");
    }
    if (body.data.description !== undefined && body.data.description !== task.description) {
      set.description = body.data.description;
      changedFields.push("description");
    }
    if (body.data.dueAt !== undefined) {
      const nextDue = body.data.dueAt === null ? null : new Date(body.data.dueAt);
      if (nextDue?.getTime() !== task.dueAt?.getTime()) {
        set.dueAt = nextDue;
        changedFields.push("dueAt");
      }
    }
    const statusChanged = body.data.status !== undefined && body.data.status !== task.status;
    const assigneeChanged = nextAssignee?.id !== task.assignee?.id;
    if (!statusChanged && !assigneeChanged && changedFields.length === 0) {
      return c.json({ task });
    }

    // 事务闭包里的赋值不参与外层窄化，用数组持有人选（length 判空）
    const nudgedTo: string[] = [];
    await deps.db.transaction(async (tx) => {
      if (statusChanged) {
        set.status = body.data.status;
        // 状态变更按 docs/audit.md 词表带 from/to
        await recordAudit(tx, {
          actor: me.id,
          action: "task.status_changed",
          target: task.id,
          detail: { from: task.status, to: body.data.status },
        });
      }
      if (assigneeChanged) {
        set.assigneeId = nextAssignee?.id ?? null;
        await recordAudit(tx, {
          actor: me.id,
          action: "task.assigned",
          target: task.id,
          detail: { assignee: nextAssignee?.id ?? null, assigneeName: nextAssignee?.name ?? null },
        });
      }
      if (changedFields.length > 0) {
        await recordAudit(tx, {
          actor: me.id,
          action: "task.updated",
          target: task.id,
          detail: { fields: changedFields },
        });
      }
      set.updatedAt = new Date();
      await tx.update(schema.tasks).set(set).where(eq(schema.tasks.id, task.id));
      // 分配通知只在真的换了人时发；派给自己不通知自己
      if (assigneeChanged && nextAssignee !== null && nextAssignee.id !== me.id) {
        const title = body.data.title ?? task.title;
        await notifyAssignee(tx, task.id, title, nextAssignee.id, me.name);
        nudgedTo.push(nextAssignee.id);
      }
      // 关注者投递（#110 切片 4 的任务侧，#113 域切片）：真实状态流转对关注者的
      // 「动静」。名单 = 关注者（含改派后复活的陈旧关注行）− 操作者 − 定向事件
      // 已覆盖的新经办人（一人一个 PATCH 至多一条，定向优先）− 不在**当前**可见
      // 者集合的人（关注不改变可见性，投递时按当前可见者收口，链接不指向看
      // 不到的行）。改派不另设关注者事件：改派把旧经办人移出可见者、创建人是
      // 操作者，可投递集合结构性为空——不为不可能的收件人立机制；改派的定向
      // 投递就是新经办人的 task.assigned。
      if (statusChanged) {
        const viewerIds = new Set<string>();
        if (task.createdBy !== null) viewerIds.add(task.createdBy.id);
        if (nextAssignee !== null) viewerIds.add(nextAssignee.id);
        const followerRows = await tx
          .select({ userId: schema.follows.userId })
          .from(schema.follows)
          .where(and(eq(schema.follows.subjectType, "task"), eq(schema.follows.subjectId, task.id)));
        const covered = new Set<string>([me.id]);
        if (assigneeChanged && nextAssignee !== null && nextAssignee.id !== me.id) {
          covered.add(nextAssignee.id);
        }
        const watcherIds = followerRows
          .map((row) => row.userId)
          .filter((userId) => !covered.has(userId) && viewerIds.has(userId));
        if (watcherIds.length > 0) {
          const payload = {
            taskTitle: body.data.title ?? task.title,
            actorName: me.name,
            from: task.status,
            to: body.data.status,
          };
          for (const userId of watcherIds) {
            await tx.insert(schema.notifications).values({
              userId,
              eventType: "task.status_changed",
              aggregateType: "task",
              aggregateId: task.id,
              payload,
            });
          }
          for (const userId of watcherIds) {
            if (!nudgedTo.includes(userId)) nudgedTo.push(userId);
          }
        }
      }
    });
    // 提交后再催（#110 切片 2）：铃铛重读 summary，读到的就是已提交的数据
    if (nudgedTo.length > 0) {
      await deps.notifyUsers(nudgedTo);
    }
    const rows = await selectTaskRows(deps.db, eq(schema.tasks.id, task.id)).limit(1);
    return c.json({ task: rows[0] ?? null });
  });

  // 删除（#29 切片 2）：软删 + 台账快照 + 审计，一个事务。任务内核的第一个删除
  // 动词——「删除操作统一改为软删除 + 快照」(#29) 从这里开始成立。
  //
  // 裁决三条：
  // - 动词属创建人。经办人是受托执行（改内容/状态、取消是经办人的逃生门），
  //   删除是行属对记录本身的处置——403 delete_creator_only，不静默放宽。
  // - 不投递通知。删除把可见性门关上，投递只能深链到 404 的详情页（给收件人
  //   一条点不开的通知比不通知更糟）；误删的即时面是 web 撤销窗（undo-window），
  //   事后面是恢复台（/system/deleted-records，audit.read 门）。
  // - 签名锁定与 PATCH 同门（#219）：签过名的记录一律拒改，删除是最彻底的改。
  app.delete("/api/tasks/:id", async (c) => {
    const idParse = z.uuid().safeParse(c.req.param("id"));
    if (!idParse.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const me = c.get("user");
    const rows = await deps.db
      .select()
      .from(schema.tasks)
      .where(and(eq(schema.tasks.id, idParse.data), taskVisibleTo(me.id)))
      .limit(1);
    const task = rows[0];
    // 不存在 / 不属于我 / 已删，同回答 404（反探测，与详情同一裁定）
    if (task === undefined) {
      return c.json({ error: "not_found" }, 404);
    }
    if (task.createdById !== me.id) {
      return c.json({ error: "forbidden", code: "delete_creator_only" }, 403);
    }
    if (await isSubjectSigned(deps.db, "task", task.id)) {
      return c.json({ error: "record_signed" }, 409);
    }
    const snapshot = {
      id: task.id,
      title: task.title,
      description: task.description,
      status: task.status,
      dueAt: task.dueAt === null ? null : task.dueAt.toISOString(),
      assigneeId: task.assigneeId,
      createdById: task.createdById,
      subjectType: task.subjectType,
      subjectId: task.subjectId,
      createdAt: task.createdAt.toISOString(),
      updatedAt: task.updatedAt.toISOString(),
    };
    const outcome = await deps.db.transaction(async (tx): Promise<"deleted" | "gone"> => {
      // 行锁内复查 deleted_at：并发的第二个 DELETE 在锁上排队，等到后读到已删
      // 行 → gone，两个请求同答 404，台账唯一部分索引兜住最后的缝隙
      const locked = await tx
        .select({ deletedAt: schema.tasks.deletedAt })
        .from(schema.tasks)
        .where(eq(schema.tasks.id, task.id))
        .for("update")
        .limit(1);
      const row = locked[0];
      // 行缺失或已被并发的第一个请求软删（undefined !== null 与 null !== null
      // 的分别刚好覆盖两种态），同答 gone
      if (row?.deletedAt !== null) {
        return "gone";
      }
      await tx
        .update(schema.tasks)
        .set({ deletedAt: new Date(), deletedBy: me.id })
        .where(eq(schema.tasks.id, task.id));
      await recordDeletion(tx, {
        subjectType: "task",
        subjectId: task.id,
        title: task.title,
        snapshot,
        deletedBy: me.id,
      });
      await recordAudit(tx, {
        actor: me.id,
        action: "task.deleted",
        target: task.id,
        detail: { title: task.title },
      });
      return "deleted";
    });
    if (outcome === "gone") {
      return c.json({ error: "not_found" }, 404);
    }
    return c.json({ deleted: true });
  });

  return app;
}

/** 行属判据：创建人或经办人可见（GET/PATCH 共用）；软删行一律不可见 */
function taskVisibleTo(userId: string) {
  return and(
    or(
      eq(schema.tasks.assigneeId, userId),
      eq(schema.tasks.createdById, userId),
    ),
    isNull(schema.tasks.deletedAt),
  );
}

interface AssigneeRef {
  id: string;
  name: string;
}

/** 可分配面校验：用户存在且至少持有一个非 customer 角色 */
async function findAssignableUser(db: Db, userId: string): Promise<AssigneeRef | null> {
  const rows = await db
    .select({ id: schema.authUser.id, name: schema.authUser.name })
    .from(schema.authUser)
    .innerJoin(schema.userRole, eq(schema.userRole.userId, schema.authUser.id))
    .where(and(eq(schema.authUser.id, userId), sql`${schema.userRole.role} <> 'customer'`))
    .limit(1);
  return rows[0] ?? null;
}

/** task.assigned 站内通知：通知表第一个真实生产者（#116 服务化时并入统一通道） */
async function notifyAssignee(
  tx: Tx,
  taskId: string,
  taskTitle: string,
  assigneeId: string,
  actorName: string,
): Promise<void> {
  await tx.insert(schema.notifications).values({
    userId: assigneeId,
    eventType: "task.assigned",
    aggregateType: "task",
    aggregateId: taskId,
    payload: { taskTitle, actorName },
  });
}

/** 行读法：经办人/创建人姓名随行带出（列表与详情共用同一投影） */
function selectTaskRows(db: Db, where: SQL | undefined) {
  const assignee = alias(schema.authUser, "assignee");
  const creator = alias(schema.authUser, "creator");
  return db
    .select({
      id: schema.tasks.id,
      title: schema.tasks.title,
      description: schema.tasks.description,
      status: schema.tasks.status,
      dueAt: schema.tasks.dueAt,
      assignee: {
        id: assignee.id,
        name: assignee.name,
      },
      createdBy: {
        id: creator.id,
        name: creator.name,
      },
      createdAt: schema.tasks.createdAt,
      updatedAt: schema.tasks.updatedAt,
    })
    .from(schema.tasks)
    .leftJoin(assignee, eq(schema.tasks.assigneeId, assignee.id))
    .leftJoin(creator, eq(schema.tasks.createdById, creator.id))
    .where(where)
    // 待办主读法：到期的在前（没填到期的不挤占），同批按新在前稳定排序
    .orderBy(sql`${schema.tasks.dueAt} asc nulls last`, sql`${schema.tasks.createdAt} desc`, sql`${schema.tasks.id} desc`);
}
