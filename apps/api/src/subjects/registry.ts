import { and, eq, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@ally/db";
import { schema } from "@ally/db";

/**
 * 多态 subject 注册表（#232 §11「评论、@、关注与附件：每个业务对象都有」）。
 *
 * 评论（#110 切片 1）与活动流（#110 切片 3）是两套读法、同一扇门：合法的
 * subject 类型与「谁能看」由每个业务域切片在此注册自己的加载器裁决——加载器
 * 同时回答可见性（viewers）、提及名单与通知/活动标题（title）。text 列不用
 * 枚举，新域注册不动数据库（与 notifications.event_type 同一裁法）。未注册
 * 类型由路由回 400，subject 不存在或调用者不可见一律 404（反探测，与任务
 * 详情同一裁定）。
 */

/** 一个 subject 的语境：可见者集合 + 通知/活动语境的展示名 */
export interface SubjectContext {
  id: string;
  title: string;
  viewers: { id: string; name: string }[];
}

export type SubjectLoader = (db: Db, subjectId: string) => Promise<SubjectContext | null>;

/** task 的语境 = 行本身 + 行属两人（创建人/经办人，去重、去空） */
async function loadTaskContext(db: Db, taskId: string): Promise<SubjectContext | null> {
  const assignee = alias(schema.authUser, "assignee");
  const creator = alias(schema.authUser, "creator");
  const rows = await db
    .select({
      id: schema.tasks.id,
      title: schema.tasks.title,
      assignee: { id: assignee.id, name: assignee.name },
      creator: { id: creator.id, name: creator.name },
    })
    .from(schema.tasks)
    .leftJoin(assignee, eq(schema.tasks.assigneeId, assignee.id))
    .leftJoin(creator, eq(schema.tasks.createdById, creator.id))
    // 软删行不再是可见 subject（#29 切片 2）：评论/活动流/关注/自定义字段共用
    // 这扇门，任务删了整条记录的时间线一起对行属关闭——恢复后原样回来
    .where(and(eq(schema.tasks.id, taskId), isNull(schema.tasks.deletedAt)))
    .limit(1);
  const row = rows[0];
  if (row === undefined) return null;
  const viewers: { id: string; name: string }[] = [];
  for (const person of [row.assignee, row.creator]) {
    if (person !== null && !viewers.some((v) => v.id === person.id)) {
      viewers.push({ id: person.id, name: person.name });
    }
  }
  return { id: row.id, title: row.title, viewers };
}

export const SUBJECT_LOADERS: Record<string, SubjectLoader> = {
  task: loadTaskContext,
};

/**
 * subject 可见性门的统一入口：类型未注册返回 "unregistered"（路由回 400），
 * 行不存在或调用者不在可见者集合返回 null（路由回 404），否则返回语境。
 * 评论与活动流共用，两套读法不会长出两套可见性裁决。
 */
export async function loadVisibleSubject(
  db: Db,
  subjectType: string,
  subjectId: string,
  userId: string,
): Promise<SubjectContext | null | "unregistered"> {
  const loader = SUBJECT_LOADERS[subjectType];
  if (loader === undefined) return "unregistered";
  const subject = await loader(db, subjectId);
  if (subject?.viewers.some((v) => v.id === userId) !== true) return null;
  return subject;
}
