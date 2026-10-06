import { and, asc, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Hono } from "hono";
import { z } from "zod";
import type { Db } from "@ally/db";
import { schema } from "@ally/db";
import { recordAudit } from "../audit/audit-log.ts";
import type { AppEnv } from "../auth/session.ts";
import { loadVisibleSubject } from "../subjects/registry.ts";

/**
 * 关注端点（#110 切片 4：关注内核）。
 *
 * 老系统没有可移植的关注实现（没有任何对应表/函数，与评论同一处境）；形态
 * 依据 #232 §11「评论、@、关注与附件：每个业务对象都有」。关注是内核机制：
 * 多态附着（subjectType/subjectId，与 comments 同一形态），合法的 subject
 * 类型与「谁能关注」由 subjects/registry.ts 的**同一扇可见性门**裁决——看
 * 得到才能关注，未注册类型 400，subject 不存在或不可见一律 404（反探测，
 * 与评论/任务详情同一裁定）。关注不改变可见性：关注者集合永远是可见者集合
 * 的子集，可见者后来缩小（任务改派）时陈旧关注者不越过门——通知扇出按当前
 * 可见者过滤（comments.ts），本路由的读端点也只回得出可见者名单。
 *
 * 幂等语义：PUT 是「确保已关注」（重复关注不报错、不重复落审计——审计只记
 * 真实变更，#29 约定）；DELETE 是「确保未关注」（没关注过也 200）。关注/
 * 取关在同一事务里写审计（follow.created / follow.deleted，detail 记
 * subjectType/subjectId——无行 id，行的身份就是三元组本身；两行按 docs/
 * audit.md 的多态子对象约定进对象活动流，开始/停止关注是协作事实）。
 *
 * 本切片不引入生产者侧约定以外的自动关注（创建人/经办人在任务上本就全员
 * 可见，自动关注是冗余状态）；关注的通知价值由 comments.ts 落地：评论扇出
 * 给关注者（comment.created 通知），这是关注者有的第一个「动静」投递。
 */

/** 关注者名单一次带回的上限：subject 的关注者是行属级小集合，超出封顶 */
export const FOLLOWERS_MAX = 200;

const subjectParams = z.object({
  subjectType: z.string().min(1).max(50),
  subjectId: z.uuid(),
});

export function followsRoutes(deps: { db: Db }) {
  const app = new Hono<AppEnv>();

  app.get("/api/follows/:subjectType/:subjectId", async (c) => {
    const parsed = subjectParams.safeParse(c.req.param());
    if (!parsed.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const { subjectType, subjectId } = parsed.data;
    const me = c.get("user").id;
    const subject = await loadVisibleSubject(deps.db, subjectType, subjectId, me);
    if (subject === "unregistered") {
      return c.json({ error: "invalid_request" }, 400);
    }
    if (subject === null) {
      return c.json({ error: "not_found" }, 404);
    }
    const where = and(
      eq(schema.follows.subjectType, subjectType),
      eq(schema.follows.subjectId, subjectId),
    );
    // 关注者名单不带分页：行属级小集合，FOLLOWERS_MAX 封顶 + 精确 total
    const follower = alias(schema.authUser, "follower");
    const [rows, totalRows] = await Promise.all([
      deps.db
        .select({
          id: follower.id,
          name: follower.name,
          createdAt: schema.follows.createdAt,
        })
        .from(schema.follows)
        .innerJoin(follower, eq(schema.follows.userId, follower.id))
        .where(where)
        .orderBy(asc(schema.follows.createdAt), asc(schema.follows.userId))
        .limit(FOLLOWERS_MAX),
      deps.db.select({ n: sql<number>`count(*)::int` }).from(schema.follows).where(where),
    ]);
    return c.json({
      followers: rows,
      total: totalRows[0]?.n ?? 0,
      meFollowing: rows.some((row) => row.id === me),
    });
  });

  app.put("/api/follows/:subjectType/:subjectId", async (c) => {
    const parsed = subjectParams.safeParse(c.req.param());
    if (!parsed.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const { subjectType, subjectId } = parsed.data;
    const me = c.get("user").id;
    const subject = await loadVisibleSubject(deps.db, subjectType, subjectId, me);
    if (subject === "unregistered") {
      return c.json({ error: "invalid_request" }, 400);
    }
    if (subject === null) {
      return c.json({ error: "not_found" }, 404);
    }
    await deps.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(schema.follows)
        .values({ subjectType, subjectId, userId: me })
        .onConflictDoNothing()
        .returning({ userId: schema.follows.userId });
      // 幂等：已关注时 inserted 为空，无真实变更不落审计
      if (inserted.length === 0) return;
      await recordAudit(tx, {
        actor: me,
        action: "follow.created",
        target: null,
        detail: { subjectType, subjectId },
      });
    });
    return c.json({ meFollowing: true });
  });

  app.delete("/api/follows/:subjectType/:subjectId", async (c) => {
    const parsed = subjectParams.safeParse(c.req.param());
    if (!parsed.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const { subjectType, subjectId } = parsed.data;
    const me = c.get("user").id;
    const subject = await loadVisibleSubject(deps.db, subjectType, subjectId, me);
    if (subject === "unregistered") {
      return c.json({ error: "invalid_request" }, 400);
    }
    if (subject === null) {
      return c.json({ error: "not_found" }, 404);
    }
    await deps.db.transaction(async (tx) => {
      const deleted = await tx
        .delete(schema.follows)
        .where(
          and(
            eq(schema.follows.subjectType, subjectType),
            eq(schema.follows.subjectId, subjectId),
            eq(schema.follows.userId, me),
          ),
        )
        .returning({ userId: schema.follows.userId });
      // 幂等：本来就没关注时 deleted 为空，无真实变更不落审计
      if (deleted.length === 0) return;
      await recordAudit(tx, {
        actor: me,
        action: "follow.deleted",
        target: null,
        detail: { subjectType, subjectId },
      });
    });
    return c.json({ meFollowing: false });
  });

  return app;
}
