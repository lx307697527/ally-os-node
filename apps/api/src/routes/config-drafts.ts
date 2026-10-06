import { Hono } from "hono";
import type { Logger } from "pino";
import { z } from "zod";
import type { Db } from "@ally/db";
import type { AppEnv } from "../auth/session.ts";
import { recordAudit } from "../audit/audit-log.ts";
import { configSubjectSpec } from "../config-versions/registry.ts";
import { authorizeSubjectWrite, permissionFailure } from "../config-versions/http.ts";
import {
  ConfigDraftNotFoundError,
  deleteConfigDraft,
  describeConfigDraft,
  DraftContentInvalidError,
  DraftStaleError,
  DraftUnsupportedError,
  PublishNoChangeError,
  publishBody,
  publishConfigDraft,
  draftSaveBody,
  saveConfigDraft,
  type PublishDraftResult,
} from "../config-versions/drafts.ts";
import { ConfigSubjectNotFoundError } from "../config-versions/service.ts";

/**
 * 配置草稿与一键发布（#226 切片 2：先在测试环境试，再一键发布到生产）。
 *
 * 草稿是配置对象上的 overlay（config_drafts，活配置读路径在发布前看不见它），
 * 端点全部在「各族配置面的同一权限点」后面（与 config-versions 的动态按族裁
 * 决共用 config-versions/http.ts 的检查）——存草稿/发发布 = 改那族的配置。
 *
 * 错误码与回滚面同一风格：未注册族 404 unregistered_subject；无内容改写路径的
 * 族（approval）409 publish_unsupported——宁可明说「这族还不能」，
 * 不假装成功；草稿过期 409 draft_stale（重存后再发，无盲发）；发布内容与现状
 * 一致 409 publish_no_change（不记假变更）；台账唯一索引兜住的并发发布撞号转
 * 409 publish_conflict（fail loud 的竞态给可重试的语义）。
 *
 * 发布是写操作：事务里 applyRevision + 记一版 published + 删草稿，提交后写审计
 * （config.published，带 reason/草稿 note 可选）——审计失败照全局纪律让操作失败。
 */

const subjectIdParam = z.uuid();

/** pg 的唯一约束冲突（23505）：形状收窄而不引依赖（pg 是 @ally/db 的传递依赖）。
 * drizzle 会把驱动错误包进 DrizzleQueryError.cause，沿因果链找码 */
function isUniqueViolation(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 4 && typeof current === "object" && current !== null; depth++) {
    const candidate = current as { code?: unknown; cause?: unknown };
    if (candidate.code === "23505") return true;
    current = candidate.cause;
  }
  return false;
}

/** 发布内核的领域错误 → HTTP 语义（不在事务闭包里碰 Response，保持内核无 HTTP 面） */
function publishErrorStatus(err: unknown): { status: 400 | 404 | 409; body: Record<string, unknown> } | undefined {
  if (err instanceof DraftUnsupportedError) {
    return { status: 409, body: { error: "publish_unsupported" } };
  }
  if (err instanceof ConfigDraftNotFoundError) {
    return { status: 404, body: { error: "draft_not_found" } };
  }
  if (err instanceof DraftStaleError) {
    return {
      status: 409,
      body: {
        error: "draft_stale",
        draftBaseVersion: err.draftBaseVersion,
        currentVersion: err.currentVersion,
      },
    };
  }
  if (err instanceof PublishNoChangeError) {
    return { status: 409, body: { error: "publish_no_change" } };
  }
  if (err instanceof ConfigSubjectNotFoundError) {
    return { status: 404, body: { error: "subject_not_found" } };
  }
  if (err instanceof DraftContentInvalidError) {
    return { status: 400, body: { error: "invalid_content", issues: err.issues } };
  }
  return undefined;
}

export function configDraftsRoutes(deps: { db: Db; logger: Logger }) {
  const app = new Hono<AppEnv>();

  app.get("/api/config-drafts/:subjectType/:subjectId", async (c) => {
    const subjectType = c.req.param("subjectType");
    const spec = configSubjectSpec(subjectType);
    if (spec === undefined) {
      return c.json({ error: "unregistered_subject" }, 404);
    }
    const permissionDenial = permissionFailure(c.get("authz"), spec);
    if (permissionDenial !== undefined) {
      return c.json(permissionDenial, 403);
    }
    const subjectId = subjectIdParam.safeParse(c.req.param("subjectId"));
    if (!subjectId.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const described = await describeConfigDraft(deps.db, subjectType, subjectId.data);
    if (described === undefined) {
      return c.json({ error: "draft_not_found" }, 404);
    }
    return c.json({
      subjectType,
      subjectId: subjectId.data,
      draft: {
        content: described.draft.content,
        baseVersion: described.draft.baseVersion,
        note: described.draft.note,
        updatedById: described.draft.updatedById,
        updatedAt: described.draft.updatedAt,
      },
      stale: described.stale,
      changes: described.changes,
    });
  });

  app.put("/api/config-drafts/:subjectType/:subjectId", async (c) => {
    const subjectType = c.req.param("subjectType");
    const spec = configSubjectSpec(subjectType);
    if (spec === undefined) {
      return c.json({ error: "unregistered_subject" }, 404);
    }
    const permissionDenial = permissionFailure(c.get("authz"), spec);
    if (permissionDenial !== undefined) {
      return c.json(permissionDenial, 403);
    }
    const subjectId = subjectIdParam.safeParse(c.req.param("subjectId"));
    const parsed = draftSaveBody.safeParse(await c.req.json().catch(() => undefined));
    if (!subjectId.success || !parsed.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    // 逐主体写面门（#233）：与回滚同扇——存草稿是「以该主体的名义写下一版内容」
    const writeDenial = await authorizeSubjectWrite(spec, {
      db: deps.db,
      authz: c.get("authz"),
      subjectId: subjectId.data,
    });
    if (writeDenial !== undefined) {
      return c.json(writeDenial, 403);
    }
    const actorId = c.get("user").id;
    try {
      const saved = await saveConfigDraft(deps.db, {
        subjectType,
        subjectId: subjectId.data,
        content: parsed.data.content,
        note: parsed.data.note,
        actorId,
      });
      deps.logger.info(
        { subjectType, subjectId: subjectId.data, baseVersion: saved.baseVersion, actorId },
        "config draft saved",
      );
      return c.json({
        subjectType,
        subjectId: subjectId.data,
        baseVersion: saved.baseVersion,
        note: saved.note,
        updatedAt: saved.updatedAt,
      });
    } catch (err) {
      const mapped = publishErrorStatus(err);
      if (mapped === undefined) throw err;
      return c.json(mapped.body, mapped.status);
    }
  });

  app.delete("/api/config-drafts/:subjectType/:subjectId", async (c) => {
    const subjectType = c.req.param("subjectType");
    const spec = configSubjectSpec(subjectType);
    if (spec === undefined) {
      return c.json({ error: "unregistered_subject" }, 404);
    }
    const permissionDenial = permissionFailure(c.get("authz"), spec);
    if (permissionDenial !== undefined) {
      return c.json(permissionDenial, 403);
    }
    const subjectId = subjectIdParam.safeParse(c.req.param("subjectId"));
    if (!subjectId.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const existed = await deleteConfigDraft(deps.db, subjectType, subjectId.data);
    if (!existed) {
      return c.json({ error: "draft_not_found" }, 404);
    }
    deps.logger.info(
      { subjectType, subjectId: subjectId.data, actorId: c.get("user").id },
      "config draft discarded",
    );
    return c.json({ ok: true });
  });

  app.post("/api/config-drafts/:subjectType/:subjectId/publish", async (c) => {
    const subjectType = c.req.param("subjectType");
    const spec = configSubjectSpec(subjectType);
    if (spec === undefined) {
      return c.json({ error: "unregistered_subject" }, 404);
    }
    const permissionDenial = permissionFailure(c.get("authz"), spec);
    if (permissionDenial !== undefined) {
      return c.json(permissionDenial, 403);
    }
    const subjectId = subjectIdParam.safeParse(c.req.param("subjectId"));
    const parsed = publishBody.safeParse(await c.req.json().catch(() => undefined));
    if (!subjectId.success || !parsed.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    // 逐主体写面门（#233）：与回滚/存草稿同扇——发布 = 改那行配置
    const writeDenial = await authorizeSubjectWrite(spec, {
      db: deps.db,
      authz: c.get("authz"),
      subjectId: subjectId.data,
    });
    if (writeDenial !== undefined) {
      return c.json(writeDenial, 403);
    }
    const actorId = c.get("user").id;
    let outcome: PublishDraftResult;
    try {
      outcome = await deps.db.transaction(async (tx) =>
        publishConfigDraft(tx, {
          subjectType,
          subjectId: subjectId.data,
          actorId,
        }),
      );
    } catch (err) {
      if (isUniqueViolation(err)) {
        // 并发发布/线上 PATCH 与发布同时在飞：后到者撞台账唯一索引（23505），
        // 整个事务已回滚——转 409 让发布者重读现状再试，绝不静默盖掉别人的变更
        return c.json({ error: "publish_conflict" }, 409);
      }
      const mapped = publishErrorStatus(err);
      if (mapped === undefined) throw err;
      return c.json(mapped.body, mapped.status);
    }
    await recordAudit(deps.db, {
      actor: actorId,
      action: "config.published",
      target: subjectId.data,
      detail: {
        subjectType,
        fromVersion: outcome.fromVersion,
        publishedVersion: outcome.publishedVersion,
        ...(parsed.data.reason !== undefined ? { reason: parsed.data.reason } : {}),
        ...(outcome.note !== null ? { note: outcome.note } : {}),
      },
    });
    deps.logger.info(
      {
        subjectType,
        subjectId: subjectId.data,
        fromVersion: outcome.fromVersion,
        publishedVersion: outcome.publishedVersion,
        actorId,
      },
      "config draft published",
    );
    return c.json({
      subjectType,
      subjectId: subjectId.data,
      fromVersion: outcome.fromVersion,
      publishedVersion: outcome.publishedVersion,
      changes: outcome.changes,
    });
  });

  return app;
}
