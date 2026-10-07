import { randomUUID } from "node:crypto";
import { File } from "node:buffer";
import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Hono } from "hono";
import { z } from "zod";
import type { Db } from "@ally/db";
import { schema } from "@ally/db";
import type { Storage } from "@ally/storage";
import type { Logger } from "pino";
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
 *
 * 关注扇出（#110 切片 4）：评论是关注者的第一个「动静」投递——同一事务里
 * 对本 subject 的关注者补发 comment.created 通知（标题「在关注对象上有新
 * 评论」，payload 与提及同构，铃铛同一渲染层）。扇出的两道闸：已收到提及
 * 通知的人不重复投（提及优先，一人一评论至多一条）；关注者必须仍在当前
 * 可见者集合里（关注不改变可见性——任务改派后，陈旧关注者不越过可见性门，
 * 与 follows.ts 同一裁法）。作者本人关注自己的对象也不收自己的评论。
 *
 * 编辑（#110 切片 5）：作者是编辑的唯一动词（与删除同一形态，403 带码）；
 * 门序与删除一致——id 定位行，subject 门在先，404 与不存在同回答。正文是
 * 事实的最新版：行内更新 body + edited_at（null = 从未编辑，只服务「(已编辑)」
 * 一个读者），编辑历史由审计行承载（comment.updated，detail 记 subject 引用
 * 与 fields，自动进对象活动流）。与 follows 内核同一纪律：**真变化才落审计**
 * ——正文没变（trim 后相等）的提交是幂等成功，不动 edited_at、不写审计。
 *
 * 编辑与提及：通知是衍生物，衍生物跟着事实的最新版走——编辑后重新解析提及，
 * 但只对 **新增** 提及的人补发 comment.mentioned（新正文 @ 了、旧正文没 @ 的
 * 当前可见者；创建时已通知过的人不二次打扰，作者本人永不自提自通知）。「新增」
 * 由两版正文各自解析后的差集得出，不查询历史通知——纯函数，重复编辑同一批
 * 名字不重复通知。编辑不向关注者重发扇出：编辑是对既有事实的更正，不是新的
 * 动静（关注者收的是「有新评论」，不是「有评论被改」）；已发出的通知里的
 * 摘要是发出时的事实快照，不随编辑重写。
 *
 * 附件（#110 收尾切片）：#232 §11 的最后一半。文件挂在**评论行**上，不直接挂
 * subject——评论是协作动静的承载，文件跟着说话走；行属 = 评论作者（谁写的
 * 评论谁贴文件，与编辑/删除同一动词家族），可见性不另设门——读面过
 * subjects/registry.ts 的同一扇 subject 门，看得到评论就看得到它的附件。
 *
 * 生命周期与老系统的两个教训：①BUG-325（询价附件上传成功、记账 RPC 丢了，
 * 对象在桶里永久孤儿）——这里的顺序是 **先落桶后记账**：put 失败干净地 502、
 * 无行无对象；记账事务失败则逐 key 尽力删（packages/storage 补的 delete），
 * 删不掉的残余只占字节不可见，回收属 worker 切片。②下载永远走**短时效签名
 * URL**（老系统 BUG-123 的 preview/download 之辨在此收敛为一个按需端点），
 * 签名 URL 不进列表响应——列表会进日志，长时效 URL 不能跟着日志到处跑。
 *
 * 准入是封闭词表（fail closed）：类型白名单 + 单文件 ≤10MiB + 每评论 ≤5 个 +
 * 文件名 sanity（长度/控制字符）。对象 key 不含任何用户输入
 * （comment-attachments/<commentId>/<uuid>）——uuid 既是唯一性也是防遍历，
 * 原文件名只活在 file_name 列里服务下载命名。附件不是新的动静：不通知、不
 * 扇出（与编辑同裁）；comment.attachment_added/removed 留审计，detail 带
 * subject 引用，活动流自动收录。
 */

/** 列表单页上限；分页语义与 tasks / audit-events 一致（limit/offset + 精确 total） */
export const COMMENTS_PAGE_MAX = 100;
const COMMENTS_PAGE_DEFAULT = 50;

/** 正文上限与任务 description 同档 */
const COMMENT_BODY_MAX = 5000;

/** 通知 payload 里正文的截断长度：铃铛一行 detail 的量级，不装全文 */
const EXCERPT_MAX = 140;

// ── 附件准入（#110 收尾切片）───────────────────────────────────────────────
// 数字承老系统先例：feedback ≤3 张 ≤5MiB、support 总预算 30MiB。评论是高频
// 协作面，单文件 10MiB、每评论 5 个——装得下截图与 PDF，装不下视频。

/** 每条评论的附件总数上限（含历史已附） */
export const MAX_FILES_PER_COMMENT = 5;

/** 单文件字节上限：10MiB */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** 下载签名 URL 的时效：足够一次下载，短到泄露了也很快失效 */
export const ATTACHMENT_URL_TTL_SECONDS = 900;

/** 附件对象 key 的命名空间前缀 */
export const ATTACHMENT_KEY_PREFIX = "comment-attachments";

/**
 * 内容类型封闭白名单：截图、PDF、文本/表格与 Office 文档。客户端声明的是
 * 外部输入，白名单即校验——不在表里的一律 400（fail closed），不猜扩展名、
 * 不做「先收下来再看看」。
 */
const ADMITTED_CONTENT_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
  "text/csv",
  "text/markdown",
  "application/json",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);

export function isAdmittedContentType(contentType: string): boolean {
  return ADMITTED_CONTENT_TYPES.has(contentType);
}

/**
 * 文件名 sanity：只服务展示与下载命名（进不了对象 key），所以只挡真正
 * 麻烦的——空名、超长、控制字符。路径分隔符不拦：名字不会被拼进任何路径。
 */
export function sanitizeFileName(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > 255) return null;
  // eslint-disable-next-line no-control-regex -- 控制字符就是这里要挡的东西
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  return trimmed;
}

const createBody = z.object({
  subjectType: z.string().min(1).max(50),
  subjectId: z.uuid(),
  body: z.string().trim().min(1).max(COMMENT_BODY_MAX),
});

const editBody = z.object({
  body: z.string().trim().min(1).max(COMMENT_BODY_MAX),
});

const listQuery = z.object({
  subjectType: z.string().min(1).max(50),
  subjectId: z.uuid(),
  limit: z.coerce.number().int().min(1).max(COMMENTS_PAGE_MAX).default(COMMENTS_PAGE_DEFAULT),
  offset: z.coerce.number().int().min(0).default(0),
});

export function commentsRoutes(
  deps: {
    db: Db;
    notifyUsers: (userIds: string[]) => Promise<void>;
    storage: Storage;
    logger: Logger;
  },
) {
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
    // 附件随列表一次带出（一条分组查询，不做每评论一次的 N+1）：签名 URL 不进
    // 列表——列表响应会进日志，短时效 URL 按需单独取
    const attachments = await attachmentsByComment(
      deps.db,
      rows.map((row) => row.id),
    );
    return c.json({
      comments: rows.map((row) =>
        commentJson({ ...row, attachments: attachments.get(row.id) ?? [] }),
      ),
      total: totalRows[0]?.n ?? 0,
    });
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
      // 关注扇出（#110 切片 4）：关注者 − 已被提及（提及优先，一人一评论至多
      // 一条）− 作者本人，且必须在**当前**可见者集合里（关注不改变可见性，
      // 任务改派后陈旧关注者不越过门）
      const followerRows = await tx
        .select({ userId: schema.follows.userId })
        .from(schema.follows)
        .where(
          and(
            eq(schema.follows.subjectType, parsed.data.subjectType),
            eq(schema.follows.subjectId, parsed.data.subjectId),
          ),
        );
      const mentionedIds = new Set(mentioned.map((v) => v.id));
      const watcherIds = followerRows
        .map((row) => row.userId)
        .filter(
          (userId) =>
            userId !== me.id && !mentionedIds.has(userId) && subject.viewers.some((v) => v.id === userId),
        );
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
      for (const userId of watcherIds) {
        await tx.insert(schema.notifications).values({
          userId,
          eventType: "comment.created",
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
      return { row, watcherIds };
    });
    // 提交后再对拿到新通知的人发实时「催」（#110 切片 2）：铃铛重读 summary，
    // 读到的就是已提交的数据；催失败只降级回轮询（实现方保证不 reject）
    const nudgedIds = [...mentioned.map((person) => person.id), ...created.watcherIds];
    if (nudgedIds.length > 0) {
      await deps.notifyUsers(nudgedIds);
    }
    return c.json(
      {
        comment: commentJson({
          id: created.row.id,
          subjectType: parsed.data.subjectType,
          subjectId: parsed.data.subjectId,
          body: parsed.data.body,
          author: { id: me.id, name: me.name },
          createdAt: created.row.createdAt,
          editedAt: null,
          attachments: [],
        }),
        mentioned,
        notifiedFollowers: created.watcherIds.length,
      },
      201,
    );
  });

  app.patch("/api/comments/:id", async (c) => {
    const id = z.uuid().safeParse(c.req.param("id"));
    if (!id.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const parsed = editBody.safeParse(await c.req.json().catch(() => undefined));
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
        body: schema.comments.body,
        createdAt: schema.comments.createdAt,
        editedAt: schema.comments.editedAt,
      })
      .from(schema.comments)
      .where(eq(schema.comments.id, id.data))
      .limit(1);
    const comment = rows[0];
    // 不存在与看不见同回答：404（先验 subject 门，与删除同序）
    if (comment === undefined) {
      return c.json({ error: "not_found" }, 404);
    }
    const visible = await loadVisibleSubject(deps.db, comment.subjectType, comment.subjectId, me.id);
    if (visible === null || visible === "unregistered") {
      return c.json({ error: "not_found" }, 404);
    }
    // 编辑是作者本人的动词：看得到但不是自己的 → 403 带码（与删除同一形态）
    if (comment.authorId !== me.id) {
      return c.json({ error: "forbidden", code: "author_only" }, 403);
    }
    // 真变化才动行（follows 内核同一纪律）：trim 后相等的提交是幂等成功，
    // 不动 edited_at、不写审计、不重新解析提及
    if (parsed.data.body === comment.body) {
      const attachments = await attachmentsByComment(deps.db, [comment.id]);
      return c.json({
        comment: commentJson({
          id: comment.id,
          subjectType: comment.subjectType,
          subjectId: comment.subjectId,
          body: comment.body,
          author: { id: me.id, name: me.name },
          createdAt: comment.createdAt,
          editedAt: comment.editedAt,
          attachments: attachments.get(comment.id) ?? [],
        }),
        mentioned: [],
      });
    }
    // 新增提及 = 新正文解析出的提及 − 旧正文已有的提及（两版都只认当前
    // 可见者、排除作者）；创建时通知过的人不在差集里，不二次打扰
    const oldMentioned = new Set(
      visible.viewers
        .filter((v) => v.id !== me.id && mentionsName(comment.body, v.name))
        .map((v) => v.id),
    );
    const newlyMentioned = visible.viewers.filter(
      (v) =>
        v.id !== me.id &&
        mentionsName(parsed.data.body, v.name) &&
        !oldMentioned.has(v.id),
    );
    const updated = await deps.db.transaction(async (tx) => {
      const written = await tx
        .update(schema.comments)
        .set({ body: parsed.data.body, editedAt: new Date() })
        .where(eq(schema.comments.id, comment.id))
        .returning({
          id: schema.comments.id,
          subjectType: schema.comments.subjectType,
          subjectId: schema.comments.subjectId,
          body: schema.comments.body,
          createdAt: schema.comments.createdAt,
          editedAt: schema.comments.editedAt,
        });
      const row = written[0];
      if (row === undefined) throw new Error("comment update returned no row");
      await recordAudit(tx, {
        actor: me.id,
        action: "comment.updated",
        target: row.id,
        detail: {
          subjectType: comment.subjectType,
          subjectId: comment.subjectId,
          fields: ["body"],
        },
      });
      for (const person of newlyMentioned) {
        await tx.insert(schema.notifications).values({
          userId: person.id,
          eventType: "comment.mentioned",
          aggregateType: comment.subjectType,
          aggregateId: comment.subjectId,
          payload: {
            taskTitle: visible.title,
            commentId: row.id,
            actorName: me.name,
            excerpt: parsed.data.body.slice(0, EXCERPT_MAX),
          },
        });
      }
      return row;
    });
    // 提交后对新提及者发实时「催」；催失败降级回轮询（实现方保证不 reject）
    if (newlyMentioned.length > 0) {
      await deps.notifyUsers(newlyMentioned.map((person) => person.id));
    }
    const attachments = await attachmentsByComment(deps.db, [updated.id]);
    return c.json({
      comment: commentJson({
        ...updated,
        author: { id: me.id, name: me.name },
        attachments: attachments.get(updated.id) ?? [],
      }),
      mentioned: newlyMentioned,
    });
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
    // 字节面先点名：行删（CASCADE 带走附件行）之后对象 key 就无从查起了
    const attachmentRows = await deps.db
      .select({ storageKey: schema.commentAttachments.storageKey })
      .from(schema.commentAttachments)
      .where(eq(schema.commentAttachments.commentId, comment.id));
    await deps.db.transaction(async (tx) => {
      await tx.delete(schema.comments).where(eq(schema.comments.id, comment.id));
      await recordAudit(tx, {
        actor: me.id,
        action: "comment.deleted",
        target: comment.id,
        detail: { subjectType: comment.subjectType, subjectId: comment.subjectId },
      });
    });
    // 事务提交后尽力清对象：行没了对象就不可达，清不掉的只占字节不可见
    // （宁留字节不留死链）；失败只告警，不拖垮已成立的删除
    for (const row of attachmentRows) {
      await deps.storage.delete(row.storageKey).catch((err: unknown) => {
        deps.logger.warn({ err, key: row.storageKey }, "comment attachment cleanup failed");
      });
    }
    return c.json({ deleted: true });
  });

  // ── 附件（#110 收尾切片）─────────────────────────────────────────────────

  /** 一条评论的附件名单：看得到评论就看得到（同一扇 subject 门，无第二套裁决） */
  app.get("/api/comments/:id/attachments", async (c) => {
    const id = z.uuid().safeParse(c.req.param("id"));
    if (!id.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const me = c.get("user").id;
    const rows = await deps.db
      .select({
        id: schema.comments.id,
        subjectType: schema.comments.subjectType,
        subjectId: schema.comments.subjectId,
      })
      .from(schema.comments)
      .where(eq(schema.comments.id, id.data))
      .limit(1);
    const comment = rows[0];
    if (comment === undefined) {
      return c.json({ error: "not_found" }, 404);
    }
    const visible = await loadVisibleSubject(deps.db, comment.subjectType, comment.subjectId, me);
    if (visible === null || visible === "unregistered") {
      return c.json({ error: "not_found" }, 404);
    }
    const attachments = await deps.db
      .select({
        id: schema.commentAttachments.id,
        fileName: schema.commentAttachments.fileName,
        contentType: schema.commentAttachments.contentType,
        sizeBytes: schema.commentAttachments.sizeBytes,
        createdAt: schema.commentAttachments.createdAt,
      })
      .from(schema.commentAttachments)
      .where(eq(schema.commentAttachments.commentId, comment.id))
      .orderBy(asc(schema.commentAttachments.createdAt), asc(schema.commentAttachments.id));
    return c.json({ attachments: attachments.map(attachmentJson) });
  });

  /**
   * 贴附件：作者是唯一动词主（与编辑/删除同一家族）。准入全在服务端——
   * 类型白名单、单文件大小、文件名 sanity、每评论总数（事务内锁行重数，
   * 并发的两个 attach 各自数出的余量不互相踩）。先落桶后记账（BUG-325 教训）：
   * put 失败无行无对象；记账失败逐 key 尽力删，删不掉的残余只占字节不可见。
   */
  app.post("/api/comments/:id/attachments", async (c) => {
    const id = z.uuid().safeParse(c.req.param("id"));
    if (!id.success) {
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
      .where(eq(schema.comments.id, id.data))
      .limit(1);
    const comment = rows[0];
    if (comment === undefined) {
      return c.json({ error: "not_found" }, 404);
    }
    const visible = await loadVisibleSubject(deps.db, comment.subjectType, comment.subjectId, me.id);
    if (visible === null || visible === "unregistered") {
      return c.json({ error: "not_found" }, 404);
    }
    if (comment.authorId !== me.id) {
      return c.json({ error: "forbidden", code: "author_only" }, 403);
    }
    const files = readUploadFiles(await c.req.parseBody({ all: true }).catch(() => null));
    if (typeof files === "string") {
      return c.json({ error: "invalid_request", code: files }, 400);
    }
    // 快速预检：注定超限的请求在动字节之前就拿到答案
    const preCount = await deps.db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.commentAttachments)
      .where(eq(schema.commentAttachments.commentId, comment.id));
    if ((preCount[0]?.n ?? 0) + files.length > MAX_FILES_PER_COMMENT) {
      return c.json({ error: "invalid_request", code: "too_many_files" }, 400);
    }

    const stagedKeys: string[] = [];
    try {
      const written = await deps.db.transaction(async (tx) => {
        // 锁评论行：准许名额在锁内裁决，并发的两个 attach 不会各自数出余量
        const locked = await tx
          .select({ id: schema.comments.id })
          .from(schema.comments)
          .where(eq(schema.comments.id, comment.id))
          .for("update");
        if (locked.length === 0) throw new Error("comment vanished during attachment upload");
        const countRows = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(schema.commentAttachments)
          .where(eq(schema.commentAttachments.commentId, comment.id));
        if ((countRows[0]?.n ?? 0) + files.length > MAX_FILES_PER_COMMENT) return null;
        const out: {
          id: string;
          fileName: string;
          contentType: string;
          sizeBytes: number;
          createdAt: Date;
        }[] = [];
        for (const { file, name } of files) {
          const key = `${ATTACHMENT_KEY_PREFIX}/${comment.id}/${randomUUID()}`;
          const bytes = new Uint8Array(await file.arrayBuffer());
          await deps.storage.put(key, bytes, file.type);
          stagedKeys.push(key);
          const inserted = await tx
            .insert(schema.commentAttachments)
            .values({
              commentId: comment.id,
              fileName: name,
              contentType: file.type,
              sizeBytes: file.size,
              storageKey: key,
              uploadedBy: me.id,
            })
            .returning({
              id: schema.commentAttachments.id,
              fileName: schema.commentAttachments.fileName,
              contentType: schema.commentAttachments.contentType,
              sizeBytes: schema.commentAttachments.sizeBytes,
              createdAt: schema.commentAttachments.createdAt,
            });
          const row = inserted[0];
          if (row === undefined) throw new Error("attachment insert returned no row");
          await recordAudit(tx, {
            actor: me.id,
            action: "comment.attachment_added",
            target: comment.id,
            detail: {
              subjectType: comment.subjectType,
              subjectId: comment.subjectId,
              attachmentId: row.id,
              fileName: row.fileName,
              sizeBytes: row.sizeBytes,
            },
          });
          out.push(row);
        }
        return out;
      });
      if (written === null) {
        return c.json({ error: "invalid_request", code: "too_many_files" }, 400);
      }
      return c.json({ attachments: written.map(attachmentJson) }, 201);
    } catch (err) {
      // 记账失败：把这次已落桶的对象尽力删掉，不留「有对象无行」的孤儿；
      // 删除自身失败只能留给 worker 回收（宁留字节不留死链的反面：宁留
      // 孤儿字节也不留指向不存在对象的死行）
      for (const key of stagedKeys) {
        await deps.storage.delete(key).catch(() => undefined);
      }
      throw err;
    }
  });

  /** 下载面：按需铸短时效签名 URL，不进列表响应（列表会进日志） */
  app.get("/api/comments/:id/attachments/:attachmentId/url", async (c) => {
    const id = z.uuid().safeParse(c.req.param("id"));
    const attachmentId = z.uuid().safeParse(c.req.param("attachmentId"));
    if (!id.success || !attachmentId.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const me = c.get("user").id;
    const rows = await deps.db
      .select({
        id: schema.comments.id,
        subjectType: schema.comments.subjectType,
        subjectId: schema.comments.subjectId,
      })
      .from(schema.comments)
      .where(eq(schema.comments.id, id.data))
      .limit(1);
    const comment = rows[0];
    if (comment === undefined) {
      return c.json({ error: "not_found" }, 404);
    }
    const visible = await loadVisibleSubject(deps.db, comment.subjectType, comment.subjectId, me);
    if (visible === null || visible === "unregistered") {
      return c.json({ error: "not_found" }, 404);
    }
    const attachmentRows = await deps.db
      .select({
        id: schema.commentAttachments.id,
        fileName: schema.commentAttachments.fileName,
        contentType: schema.commentAttachments.contentType,
        sizeBytes: schema.commentAttachments.sizeBytes,
        storageKey: schema.commentAttachments.storageKey,
      })
      .from(schema.commentAttachments)
      .where(
        and(
          eq(schema.commentAttachments.id, attachmentId.data),
          eq(schema.commentAttachments.commentId, comment.id),
        ),
      )
      .limit(1);
    const attachment = attachmentRows[0];
    if (attachment === undefined) {
      return c.json({ error: "not_found" }, 404);
    }
    const url = await deps.storage.signedGetUrl(attachment.storageKey, ATTACHMENT_URL_TTL_SECONDS);
    return c.json({
      url,
      fileName: attachment.fileName,
      contentType: attachment.contentType,
      sizeBytes: attachment.sizeBytes,
      expiresInSeconds: ATTACHMENT_URL_TTL_SECONDS,
    });
  });

  /** 摘掉附件：作者的动词（同一家族）；行删在事务里，字节清理提交后尽力 */
  app.delete("/api/comments/:id/attachments/:attachmentId", async (c) => {
    const id = z.uuid().safeParse(c.req.param("id"));
    const attachmentId = z.uuid().safeParse(c.req.param("attachmentId"));
    if (!id.success || !attachmentId.success) {
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
      .where(eq(schema.comments.id, id.data))
      .limit(1);
    const comment = rows[0];
    if (comment === undefined) {
      return c.json({ error: "not_found" }, 404);
    }
    const visible = await loadVisibleSubject(deps.db, comment.subjectType, comment.subjectId, me.id);
    if (visible === null || visible === "unregistered") {
      return c.json({ error: "not_found" }, 404);
    }
    if (comment.authorId !== me.id) {
      return c.json({ error: "forbidden", code: "author_only" }, 403);
    }
    const attachmentRows = await deps.db
      .select({
        id: schema.commentAttachments.id,
        fileName: schema.commentAttachments.fileName,
        storageKey: schema.commentAttachments.storageKey,
      })
      .from(schema.commentAttachments)
      .where(
        and(
          eq(schema.commentAttachments.id, attachmentId.data),
          eq(schema.commentAttachments.commentId, comment.id),
        ),
      )
      .limit(1);
    const attachment = attachmentRows[0];
    if (attachment === undefined) {
      return c.json({ error: "not_found" }, 404);
    }
    await deps.db.transaction(async (tx) => {
      await tx
        .delete(schema.commentAttachments)
        .where(eq(schema.commentAttachments.id, attachment.id));
      await recordAudit(tx, {
        actor: me.id,
        action: "comment.attachment_removed",
        target: comment.id,
        detail: {
          subjectType: comment.subjectType,
          subjectId: comment.subjectId,
          attachmentId: attachment.id,
          fileName: attachment.fileName,
        },
      });
    });
    await deps.storage.delete(attachment.storageKey).catch((err: unknown) => {
      deps.logger.warn({ err, key: attachment.storageKey }, "comment attachment cleanup failed");
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
      editedAt: schema.comments.editedAt,
    })
    .from(schema.comments)
    .leftJoin(author, eq(schema.comments.authorId, author.id))
    .where(where)
    .orderBy(asc(schema.comments.createdAt), asc(schema.comments.id));
}

/** 单行的 JSON 形态：列表、创建、编辑三个出口同一形状（作者可能已被删） */
function commentJson(row: {
  id: string;
  subjectType: string;
  subjectId: string;
  body: string;
  author: { id: string; name: string } | null;
  createdAt: Date;
  editedAt: Date | null;
  attachments: AttachmentJson[];
}) {
  return {
    id: row.id,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    body: row.body,
    author: row.author === null ? null : { id: row.author.id, name: row.author.name },
    createdAt: row.createdAt.toISOString(),
    editedAt: row.editedAt === null ? null : row.editedAt.toISOString(),
    attachments: row.attachments,
  };
}

/** 附件行的 JSON 形态：名单、上传两个出口同一形状（不含签名 URL，按需另取） */
function attachmentJson(row: {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  createdAt: Date;
}): AttachmentJson {
  return {
    id: row.id,
    fileName: row.fileName,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    createdAt: row.createdAt.toISOString(),
  };
}

interface AttachmentJson {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
}

/** 一页评论的附件一次带出（一条 in 查询，不做每评论一次的 N+1） */
async function attachmentsByComment(
  db: Db,
  commentIds: string[],
): Promise<Map<string, AttachmentJson[]>> {
  const map = new Map<string, AttachmentJson[]>();
  if (commentIds.length === 0) return map;
  const rows = await db
    .select({
      id: schema.commentAttachments.id,
      commentId: schema.commentAttachments.commentId,
      fileName: schema.commentAttachments.fileName,
      contentType: schema.commentAttachments.contentType,
      sizeBytes: schema.commentAttachments.sizeBytes,
      createdAt: schema.commentAttachments.createdAt,
    })
    .from(schema.commentAttachments)
    .where(inArray(schema.commentAttachments.commentId, commentIds))
    .orderBy(asc(schema.commentAttachments.createdAt), asc(schema.commentAttachments.id));
  for (const row of rows) {
    const list = map.get(row.commentId) ?? [];
    list.push(attachmentJson(row));
    map.set(row.commentId, list);
  }
  return map;
}

/**
 * multipart 里的附件准入（请求本地的部分：类型/大小/文件名；名额在事务里
 * 锁行裁决）。返回错误码字符串 = 400 的 code；每文件任一项不过即整单拒绝
 * （部分成功会让作者以为都贴上了）。
 */
function readUploadFiles(
  body: Record<string, string | File | (string | File)[]> | null,
): { file: File; name: string }[] | string {
  if (body === null) return "no_files";
  const raw = body.files;
  if (raw === undefined) return "no_files";
  const entries = Array.isArray(raw) ? raw : [raw];
  const files: { file: File; name: string }[] = [];
  for (const entry of entries) {
    if (typeof entry === "string" || !(entry instanceof File)) return "not_a_file";
    if (entry.size === 0) return "empty_file";
    if (entry.size > MAX_FILE_BYTES) return "file_too_large";
    if (!isAdmittedContentType(entry.type)) return "file_type_not_allowed";
    const name = sanitizeFileName(entry.name);
    if (name === null) return "invalid_file_name";
    files.push({ file: entry, name });
  }
  return files;
}
