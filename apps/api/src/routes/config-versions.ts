import { Hono } from "hono";
import type { Logger } from "pino";
import { z } from "zod";
import type { Db } from "@ally/db";
import type { AppEnv } from "../auth/session.ts";
import { recordAudit } from "../audit/audit-log.ts";
import {
  configSubjectSpec,
  registeredConfigSubjects,
} from "../config-versions/registry.ts";
import { permissionFailure } from "../config-versions/http.ts";
import {
  ConfigRevisionNotFoundError,
  ConfigSubjectNotFoundError,
  diffSnapshots,
  getConfigRevision,
  listConfigRevisions,
  RollbackNoChangeError,
  rollbackConfig,
  type RollbackResult,
  RollbackUnsupportedError,
} from "../config-versions/service.ts";

/**
 * 配置版本读面与回滚（#226 切片 1：配置版本台账内核）。
 *
 * 权限不走单一权限点：台账跨五族配置，每族的读史/回滚跟各族配置面同一扇门
 * （workflow.configure / approval.configure / …，族注册时声明）——回滚 = 改那族
 * 的配置，不能比配置面本身更宽松。未注册的 subject_type 与不存在的版本同答
 * 404（不向无权者多透露一个字），但族内权限不足答 403 带所需权限点——配置
 * 工作室的管理者需要「我缺哪个权限」的可诊断性（与 requirePermission 同形）。
 *
 * 回滚是写操作：事务里 applyRevision + 记一版 rolled_back，提交后写审计
 * （config.rolled_back，带 reason 可选）——审计失败照全局纪律让操作失败。
 */

const subjectIdParam = z.uuid();

const diffQuery = z
  .object({
    from: z.coerce.number().int().min(1),
    to: z.coerce.number().int().min(1),
  })
  .refine((q) => q.from !== q.to, { message: "from and to must differ" });

const rollbackBody = z
  .object({
    toVersion: z.number().int().min(1),
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

/** 回滚内核的领域错误 → HTTP 语义（不在事务闭包里碰 Response，保持内核无 HTTP 面） */
function rollbackErrorStatus(err: unknown): { status: 404 | 409; error: string } | undefined {
  if (err instanceof RollbackUnsupportedError) return { status: 409, error: "rollback_unsupported" };
  if (err instanceof ConfigRevisionNotFoundError) return { status: 404, error: "revision_not_found" };
  if (err instanceof ConfigSubjectNotFoundError) return { status: 404, error: "subject_not_found" };
  if (err instanceof RollbackNoChangeError) return { status: 409, error: "rollback_no_change" };
  return undefined;
}

export function configVersionsRoutes(deps: { db: Db; logger: Logger }) {
  const app = new Hono<AppEnv>();

  // 已注册配置族清单：配置工作室 UI 的入口数据源 + 「为什么 X 查不到版本史」
  // 的第一诊断口（登录即可见——只有族名与展示名，无任何配置内容）
  app.get("/api/config-versions/subjects", (c) => {
    return c.json({ subjects: registeredConfigSubjects() });
  });

  app.get("/api/config-versions/:subjectType/:subjectId", async (c) => {
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
    const revisions = await listConfigRevisions(deps.db, subjectType, subjectId.data);
    // 快照不入列表（一版可能是一整个流程定义，列表只回答「有哪些版、谁改的」）；
    // 内容看 detail 与 diff
    return c.json({
      subjectType,
      subjectId: subjectId.data,
      revisions: revisions.map((rev) => ({
        version: rev.version,
        source: rev.source,
        changes: rev.changes,
        changedById: rev.changedById,
        createdAt: rev.createdAt,
      })),
    });
  });

  app.get("/api/config-versions/:subjectType/:subjectId/revisions/:version", async (c) => {
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
    const version = z.coerce.number().int().min(1).safeParse(c.req.param("version"));
    if (!subjectId.success || !version.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const revision = await getConfigRevision(deps.db, subjectType, subjectId.data, version.data);
    if (revision === undefined) {
      return c.json({ error: "revision_not_found" }, 404);
    }
    return c.json({ subjectType, subjectId: subjectId.data, revision });
  });

  app.get("/api/config-versions/:subjectType/:subjectId/diff", async (c) => {
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
    const query = diffQuery.safeParse(c.req.query());
    if (!subjectId.success || !query.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const from = await getConfigRevision(deps.db, subjectType, subjectId.data, query.data.from);
    const to = await getConfigRevision(deps.db, subjectType, subjectId.data, query.data.to);
    if (from === undefined || to === undefined) {
      return c.json({ error: "revision_not_found" }, 404);
    }
    return c.json({
      subjectType,
      subjectId: subjectId.data,
      from: from.version,
      to: to.version,
      changes: diffSnapshots(from.snapshot, to.snapshot),
    });
  });

  app.post("/api/config-versions/:subjectType/:subjectId/rollback", async (c) => {
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
    const parsed = rollbackBody.safeParse(await c.req.json().catch(() => undefined));
    if (!subjectId.success || !parsed.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const actorId = c.get("user").id;
    let outcome: RollbackResult;
    try {
      outcome = await deps.db.transaction(async (tx) =>
        rollbackConfig(tx, {
          subjectType,
          subjectId: subjectId.data,
          toVersion: parsed.data.toVersion,
          actorId,
        }),
      );
    } catch (err) {
      const mapped = rollbackErrorStatus(err);
      if (mapped === undefined) throw err;
      return c.json({ error: mapped.error }, mapped.status);
    }
    await recordAudit(deps.db, {
      actor: actorId,
      action: "config.rolled_back",
      target: subjectId.data,
      detail: {
        subjectType,
        restoredVersion: outcome.restoredVersion,
        fromVersion: outcome.fromVersion,
        newVersion: outcome.newVersion,
        ...(parsed.data.reason !== undefined ? { reason: parsed.data.reason } : {}),
      },
    });
    deps.logger.info(
      {
        subjectType,
        subjectId: subjectId.data,
        restoredVersion: outcome.restoredVersion,
        newVersion: outcome.newVersion,
        actorId,
      },
      "config revision rolled back",
    );
    return c.json({
      subjectType,
      subjectId: subjectId.data,
      restoredVersion: outcome.restoredVersion,
      newVersion: outcome.newVersion,
      changes: outcome.changes,
    });
  });

  return app;
}
