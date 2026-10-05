import { and, asc, eq, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Hono } from "hono";
import { z } from "zod";
import type { Db } from "@ally/db";
import { schema } from "@ally/db";
import { recordAudit } from "../audit/audit-log.ts";
import type { AppEnv } from "../auth/session.ts";
import { loadVisibleSubject } from "../subjects/registry.ts";

/**
 * 评论端点（#110 切片 1：评论内核）。
 *
 * 老系统（这一代）没有可移植的评论/@实现（workspace_comments 属于更老一代，
 * 已不可考）；形态依据 #232 §11「评论、@、关注与附件：每个业务对象都有」。
 * 评论是内核机制：多态附着 subjectType/subjectId，合法类型与「谁能看/评」由
 * subjects/registry.ts 的注册表逐域裁决——task 是第一个注册的 subject，行属 =
 * 创建人或经办人（与 #113 的任务行属同一先例）；未注册类型 400，subject 不
 * 存在或不可见一律 404（反探测，与任务详情同一裁定）。活动流（#110 切片 3）
 * 是同一扇门的第二套读法。
 *
 * @提及（验收「被 @ 的人收到通知」）：提及从正文文本解析，对 **subject 的
 * 可见者** 精确匹配「@全名」（大小写不敏感、词边界收口）——不可见者永不匹配，
 * 文本里的 @名字只是行文。解析只认可见者不是偷懒：评论者本来就是可见者之一
 * （任务的可见集 = 创建人 + 经办人，至多两人），提到圈外人要么是行文要么是
 * 该先拉人进任务，那属于可见性裁决，不在评论内核顺手发明。每个被提及者一条
 * comment.mentioned 站内通知（聚合指向 subject，深链由前端计算），作者本人
 * 提到自己不通知（与 task.assigned 同裁）；通知与评论、审计在同一事务，
 * 提交后对被提及者发一次实时「催」（#110 切片 2，铃铛据此即时重读）。
 */

/** 列表单页上限；分页语义与 tasks / audit-events 一致（limit/offset + 精确 total） */
export const COMMENTS_PAGE_MAX = 100;
const COMMENTS_PAGE_DEFAULT = 50;

/** 正文上限与任务 description 同档 */
const COMMENT_BODY_MAX = 5000;

/** 通知 payload 里正文的截断长度：铃铛一行 detail 的量级，不装全文 */
const EXCERPT_MAX = 140;

const createBody = z.object({
  subjectType: z.string().min(1).max(50),
  subjectId: z.uuid(),
  body: z.string().trim().min(1).max(COMMENT_BODY_MAX),
});

const listQuery = z.object({
  subjectType: z.string().min(1).max(50),
  subjectId: z.uuid(),
  limit: z.coerce.number().int().min(1).max(COMMENTS_PAGE_MAX).default(COMMENTS_PAGE_DEFAULT),
  offset: z.coerce.number().int().min(0).default(0),
});

export function commentsRoutes(deps: { db: Db; notifyUsers: (userIds: string[]) => Promise<void> }) {
  const app = new Hono<AppEnv>();

  app.get("/api/comments", async (c) => {
    const parsed = listQuery.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const me = c.get("user").id;
    const subject = await loadVisibleSubject(
      deps.db,
      parsed.data.subjectType,
      parsed.data.subjectId,
      me,
    );
    if (subject === "unregistered") {
      return c.json({ error: "invalid_request" }, 400);
    }
    if (subject === null) {
      return c.json({ error: "not_found" }, 404);
    }
    const where = and(
      eq(schema.comments.subjectType, parsed.data.subjectType),
      eq(schema.comments.subjectId, parsed.data.subjectId),
    );
    const [rows, totalRows] = await Promise.all([
      selectCommentRows(deps.db, where)
        .limit(parsed.data.limit)
        .offset(parsed.data.offset),
      deps.db.select({ n: sql<number>`count(*)::int` }).from(schema.comments).where(where),
    ]);
    return c.json({ comments: rows, total: totalRows[0]?.n ?? 0 });
  });

  app.post("/api/comments", async (c) => {
    const parsed = createBody.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const me = c.get("user");
    const subject = await loadVisibleSubject(deps.db, parsed.data.subjectType, parsed.data.subjectId, me.id);
    if (subject === "unregistered") {
      return c.json({ error: "invalid_request" }, 400);
    }
    if (subject === null) {
      return c.json({ error: "not_found" }, 404);
    }
    // 提及解析：只对可见者精确匹配「@全名」；正文是不可变事实，通知是衍生物
    const mentioned = subject.viewers.filter(
      (v) => v.id !== me.id && mentionsName(parsed.data.body, v.name),
    );
    const created = await deps.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(schema.comments)
        .values({
          subjectType: parsed.data.subjectType,
          subjectId: parsed.data.subjectId,
          authorId: me.id,
          body: parsed.data.body,
        })
        .returning({ id: schema.comments.id, createdAt: schema.comments.createdAt });
      const row = inserted[0];
      if (row === undefined) throw new Error("comment insert returned no row");
      await recordAudit(tx, {
        actor: me.id,
        action: "comment.created",
        target: row.id,
        detail: {
          subjectType: parsed.data.subjectType,
          subjectId: parsed.data.subjectId,
          mentioned: mentioned.map((v) => v.id),
        },
      });
      for (const person of mentioned) {
        await tx.insert(schema.notifications).values({
          userId: person.id,
          eventType: "comment.mentioned",
          aggregateType: parsed.data.subjectType,
          aggregateId: parsed.data.subjectId,
          payload: {
            taskTitle: subject.title,
            commentId: row.id,
            actorName: me.name,
            excerpt: parsed.data.body.slice(0, EXCERPT_MAX),
          },
        });
      }
      return row;
    });
    // 提交后再对被提及者发实时「催」（#110 切片 2）：铃铛重读 summary，读到
    // 的就是已提交的数据；催失败只降级回轮询（实现方保证不 reject）
    if (mentioned.length > 0) {
      await deps.notifyUsers(mentioned.map((person) => person.id));
    }
    return c.json(
      {
        comment: {
          id: created.id,
          subjectType: parsed.data.subjectType,
          subjectId: parsed.data.subjectId,
          body: parsed.data.body,
          author: { id: me.id, name: me.name },
          createdAt: created.createdAt.toISOString(),
        },
        mentioned,
      },
      201,
    );
  });

  app.delete("/api/comments/:id", async (c) => {
    const parsed = z.uuid().safeParse(c.req.param("id"));
    if (!parsed.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const me = c.get("user");
    const rows = await deps.db
      .select({
        id: schema.comments.id,
        authorId: schema.comments.authorId,
        subjectType: schema.comments.subjectType,
        subjectId: schema.comments.subjectId,
      })
      .from(schema.comments)
      .where(eq(schema.comments.id, parsed.data))
      .limit(1);
    const comment = rows[0];
    // 不存在与看不见同回答：404（评论者集合 = subject 行属，先验 subject 门）
    if (comment === undefined) {
      return c.json({ error: "not_found" }, 404);
    }
    const visible = await loadVisibleSubject(deps.db, comment.subjectType, comment.subjectId, me.id);
    if (visible === null || visible === "unregistered") {
      return c.json({ error: "not_found" }, 404);
    }
    // 删除是作者本人的动词：看得到但不是自己的 → 403（与任务改派同一形态）
    if (comment.authorId !== me.id) {
      return c.json({ error: "forbidden", code: "author_only" }, 403);
    }
    await deps.db.transaction(async (tx) => {
      await tx.delete(schema.comments).where(eq(schema.comments.id, comment.id));
      await recordAudit(tx, {
        actor: me.id,
        action: "comment.deleted",
        target: comment.id,
        detail: { subjectType: comment.subjectType, subjectId: comment.subjectId },
      });
    });
    return c.json({ deleted: true });
  });

  return app;
}

/**
 * 「@全名」的精确匹配：大小写不敏感；命中后必须停在词边界（字母/数字紧随其
 * 后 = 更长的名字在正文里，不算命中），正文多处出现任一处命中即算。
 */
export function mentionsName(body: string, name: string): boolean {
  const needle = `@${name.trim().toLowerCase()}`;
  if (needle.length < 2) return false;
  const haystack = body.toLowerCase();
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    const after = haystack[at + needle.length];
    if (after === undefined || !/[a-z0-9]/.test(after)) return true;
    at = haystack.indexOf(needle, at + 1);
  }
  return false;
}

/** 行读法：作者姓名随行带出；评论的主读法是时间正序（对话顺序） */
function selectCommentRows(db: Db, where: SQL | undefined) {
  const author = alias(schema.authUser, "author");
  return db
    .select({
      id: schema.comments.id,
      subjectType: schema.comments.subjectType,
      subjectId: schema.comments.subjectId,
      body: schema.comments.body,
      author: {
        id: author.id,
        name: author.name,
      },
      createdAt: schema.comments.createdAt,
    })
    .from(schema.comments)
    .leftJoin(author, eq(schema.comments.authorId, author.id))
    .where(where)
    .orderBy(asc(schema.comments.createdAt), asc(schema.comments.id));
}
