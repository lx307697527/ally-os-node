import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { Db } from "@ally/db";
import { schema } from "@ally/db";
import type { Storage } from "@ally/storage";
import type { Logger } from "pino";
import { recordAudit } from "../audit/audit-log.ts";
import type { AppEnv } from "../auth/session.ts";
import {
  countFilesForSubject,
  loadFileSubject,
  sanitizeFileName,
  type FileCaller,
  type FileSubjectContext,
  type FileSubjectDefinition,
} from "../files/registry.ts";

/**
 * 文件端点（#31 切片 1：预签名直传 + 权限签发下载）。
 *
 * 字节面与控制面的分界：老系统 12 处 storage.from(...) 直调让每个域自己跟桶
 * 打交道，桶策略与权限各自为政；这里把控制面收敛到 API——字节走预签名 URL
 * 直传（#31 迁移要点，不受请求体大小限制），权限全部在 API 层校验（验收第 2
 * 条）。「签名 URL 只发给有权限的用户」是唯一发口：列表响应不带 URL（列表会
 * 进日志，长时效 URL 不能跟着日志到处跑——评论附件的同一裁决），按需单独铸。
 *
 * 生命周期（与评论附件的「先落桶后记账」刻意相反）：直传做不到先替客户端落
 * 桶，顺序必须反转——presign 落 pending 行并发预签名 → 客户端 PUT → complete
 * 用 HEAD 确认对象真的在才转 ready。两头都诚实：presign 不审计（pending 不是
 * 发生过的事实，可能永远不发生），complete 落 file.added（对象已核实），删除
 * 落 file.deleted。客户端拿了预签名但永远没传的 pending 行由 worker 清扫
 * （file-uploads-cleanup：行按年龄删、对象尽力删）。
 *
 * 大小的两级裁决：presign 按声明值准入（注定超限的请求在动字节之前拿到答案，
 * 与评论附件同一意图），complete 用 HEAD 实测覆写（台账记的是 S3 里真实存在
 * 的大小，不是客户端说了什么）；实测仍超限 → 拒绝 complete，行留 pending 由
 * 清扫回收（桶里的超额对象随之尽力删）。S3 的预签名 PUT 不绑定 Content-Length，
 * 字节级硬上限是桶策略/生命周期的事——应用层两级裁决 + 清扫兜底是本切片的
 * 完整答案，不谎称应用层拦得住一切字节。
 *
 * 门序（与评论同一形态）：未注册类型 400；subject 不存在或调用者不可见 404
 * （反探测，visibleSubject 统一回答）；看得到但不是你的动词 403。complete 与
 * 删除都验 uploadedBy——老系统 submit_feedback_report 落库前重验 key 归属的
 * 同一裁决：谁能动这个 key，账上的行说了算，不只是 subject 说了算。
 */

/** 预签名 PUT 的时效：与下载 TTL 分开——上传窗口短，给了太久等于放宽准入 */
export const PRESIGN_TTL_SECONDS = 300;

const presignBody = z.object({
  subjectType: z.string().min(1).max(50),
  subjectId: z.uuid(),
  fileName: z.string().max(255),
  contentType: z.string().min(1).max(255),
  // 声明值先按 int 收口；与注册表上限的比较在白名单之后做（错误码更准）
  sizeBytes: z.number().int().min(1),
});

const listQuery = z.object({
  subjectType: z.string().min(1).max(50),
  subjectId: z.uuid(),
});

interface SubjectGate {
  definition: FileSubjectDefinition;
  subject: FileSubjectContext;
}

export function filesRoutes(deps: { db: Db; storage: Storage; logger: Logger }) {
  const app = new Hono<AppEnv>();

  // ── presign：记账先行（pending 行），预签名随后 ───────────────────────────
  app.post("/api/files/presign", async (c) => {
    const parsed = presignBody.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const { subjectType, subjectId } = parsed.data;
    const caller = fileCaller(c);
    const gate = await visibleSubject(deps.db, subjectType, subjectId, caller, c);
    if (gate instanceof Response) return gate;
    if (!gate.definition.canAttach(gate.subject, caller)) {
      return c.json({ error: "forbidden", code: "attach_not_allowed" }, 403);
    }
    const definition = gate.definition;
    const fileName = sanitizeFileName(parsed.data.fileName);
    if (fileName === null) {
      return c.json({ error: "invalid_request", code: "invalid_file_name" }, 400);
    }
    if (!definition.admittedContentTypes.has(parsed.data.contentType)) {
      return c.json({ error: "invalid_request", code: "unsupported_content_type" }, 400);
    }
    if (parsed.data.sizeBytes > definition.maxFileBytes) {
      return c.json({ error: "invalid_request", code: "file_too_large" }, 400);
    }
    // 快速预检：注定超限的请求在铸 URL 之前拿到答案（锁内还会再数一次）
    const preCount = await countFilesForSubject(deps.db, subjectType, subjectId);
    if (preCount + 1 > definition.maxFilesPerSubject) {
      return c.json({ error: "invalid_request", code: "too_many_files" }, 400);
    }
    const key = `${definition.keyPrefix}/${subjectId}/${randomUUID()}`;
    // 铸 URL 不进事务：本地签名是微秒级操作，没有理由握着行锁做；签名成了、
    // 记账失败只是浪费一个 URL（对象没人上传、行没人记账，字节面无痕迹），
    // 反过来（先记账再铸）才是事故
    const uploadUrl = await deps.storage.signedPutUrl(
      key,
      parsed.data.contentType,
      PRESIGN_TTL_SECONDS,
    );
    const fileId = await deps.db.transaction(async (tx) => {
      await definition.lockSubject(tx, subjectId);
      const locked = await countFilesForSubject(tx, subjectType, subjectId);
      if (locked + 1 > definition.maxFilesPerSubject) {
        return null;
      }
      const inserted = await tx
        .insert(schema.files)
        .values({
          subjectType,
          subjectId,
          status: "pending",
          fileName,
          contentType: parsed.data.contentType,
          sizeBytes: parsed.data.sizeBytes,
          storageKey: key,
          uploadedBy: caller.id,
        })
        .returning({ id: schema.files.id });
      const row = inserted[0];
      if (row === undefined) throw new Error("file insert returned no row");
      return row.id;
    });
    if (fileId === null) {
      return c.json({ error: "invalid_request", code: "too_many_files" }, 400);
    }
    return c.json({ fileId, key, uploadUrl, expiresInSeconds: PRESIGN_TTL_SECONDS }, 201);
  });

  // ── complete：HEAD 核实对象在，才从 pending 转 ready ──────────────────────
  app.post("/api/files/:id/complete", async (c) => {
    const id = z.uuid().safeParse(c.req.param("id"));
    if (!id.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const caller = fileCaller(c);
    const row = await loadFileRow(deps.db, id.data);
    if (row === null) {
      return c.json({ error: "not_found" }, 404);
    }
    const gate = await visibleSubject(deps.db, row.subjectType, row.subjectId, caller, c);
    if (gate instanceof Response) return gate;
    // 只有上传人能 complete（key 归属的账面裁决）。重试网络里丢掉的 complete
    // 是幂等成功：行已 ready 且是本人，原样回答，不再 HEAD 一遍
    if (row.uploadedBy !== caller.id) {
      return c.json({ error: "forbidden", code: "uploader_only" }, 403);
    }
    const definition = gate.definition;
    if (row.status === "ready") {
      return c.json({ file: fileJson(row) });
    }
    const head = await deps.storage.head(row.storageKey);
    if (head === null) {
      // 对象不在：行留 pending（清扫任务会按年龄回收），客户端修好上传再试
      return c.json({ error: "invalid_request", code: "object_missing" }, 400);
    }
    if (head.sizeBytes > definition.maxFileBytes) {
      // 实测超限：拒绝记账，行与对象都交给清扫任务回收
      return c.json({ error: "invalid_request", code: "file_too_large" }, 400);
    }
    const updated = await deps.db.transaction(async (tx) => {
      // 守住 pending：并发重复 complete 只有一方拿到行，另一方按幂等回答
      const rows = await tx
        .update(schema.files)
        .set({ status: "ready", readyAt: new Date(), sizeBytes: head.sizeBytes })
        .where(and(eq(schema.files.id, row.id), eq(schema.files.status, "pending")))
        .returning(fileColumns);
      const file = rows[0];
      if (file === undefined) return null;
      await recordAudit(tx, {
        actor: caller.id,
        action: "file.added",
        target: file.id,
        detail: {
          subjectType: row.subjectType,
          subjectId: row.subjectId,
          fileName: file.fileName,
          contentType: file.contentType,
          sizeBytes: file.sizeBytes,
        },
      });
      return file;
    });
    if (updated === null) {
      // 输给了并发的自己（同一上传人双击重试）：行已是 ready，幂等回答
      const fresh = await loadFileRow(deps.db, row.id);
      if (fresh?.status !== "ready") {
        throw new Error("file complete lost race but row is not ready");
      }
      return c.json({ file: fileJson(fresh) });
    }
    return c.json({ file: fileJson(updated) });
  });

  // ── 列表：只回答 ready（pending 不是文件，是占位）──────────────────────────
  app.get("/api/files", async (c) => {
    const parsed = listQuery.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const { subjectType, subjectId } = parsed.data;
    const caller = fileCaller(c);
    const gate = await visibleSubject(deps.db, subjectType, subjectId, caller, c);
    if (gate instanceof Response) return gate;
    const rows = await deps.db
      .select(fileColumns)
      .from(schema.files)
      .where(
        and(
          eq(schema.files.subjectType, subjectType),
          eq(schema.files.subjectId, subjectId),
          eq(schema.files.status, "ready"),
        ),
      )
      .orderBy(asc(schema.files.createdAt), asc(schema.files.id));
    return c.json({ files: rows.map(fileJson) });
  });

  // ── 下载面：按需铸短时效签名 URL，不进列表响应 ────────────────────────────
  app.get("/api/files/:id/url", async (c) => {
    const id = z.uuid().safeParse(c.req.param("id"));
    if (!id.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const caller = fileCaller(c);
    const row = await loadFileRow(deps.db, id.data);
    // pending 行没有可签的对象：与不存在同回答（文件尚不存在）
    if (row?.status !== "ready") {
      return c.json({ error: "not_found" }, 404);
    }
    const gate = await visibleSubject(deps.db, row.subjectType, row.subjectId, caller, c);
    if (gate instanceof Response) return gate;
    const ttl = gate.definition.urlTtlSeconds;
    const url = await deps.storage.signedGetUrl(row.storageKey, ttl);
    return c.json({
      url,
      fileName: row.fileName,
      contentType: row.contentType,
      sizeBytes: row.sizeBytes,
      expiresInSeconds: ttl,
    });
  });

  // ── 删除：上传人的动词；行删在事务里，字节清理提交后尽力 ──────────────────
  app.delete("/api/files/:id", async (c) => {
    const id = z.uuid().safeParse(c.req.param("id"));
    if (!id.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const caller = fileCaller(c);
    const row = await loadFileRow(deps.db, id.data);
    if (row === null) {
      return c.json({ error: "not_found" }, 404);
    }
    const gate = await visibleSubject(deps.db, row.subjectType, row.subjectId, caller, c);
    if (gate instanceof Response) return gate;
    if (
      !gate.definition.canAttach(gate.subject, caller) ||
      row.uploadedBy !== caller.id
    ) {
      return c.json({ error: "forbidden", code: "uploader_only" }, 403);
    }
    await deps.db.transaction(async (tx) => {
      await tx.delete(schema.files).where(eq(schema.files.id, row.id));
      await recordAudit(tx, {
        actor: caller.id,
        action: "file.deleted",
        target: row.id,
        detail: {
          subjectType: row.subjectType,
          subjectId: row.subjectId,
          fileName: row.fileName,
          sizeBytes: row.sizeBytes,
        },
      });
    });
    // 与评论附件同一裁决：行没了对象就不可达，清不掉的只占字节不可见
    await deps.storage.delete(row.storageKey).catch((err: unknown) => {
      deps.logger.warn({ err, key: row.storageKey }, "file object cleanup failed");
    });
    return c.json({ deleted: true });
  });

  return app;
}

/** 请求侧的调用者语境：会话用户 + authzMiddleware 算好的生效权限集 */
function fileCaller(c: Context<AppEnv>): FileCaller {
  const user = c.get("user");
  return { id: user.id, permissions: c.get("authz").permissions };
}

/**
 * 共同的门序：400（类型未注册）→ 404（subject 不存在**或**调用者不可见——
 * 不可见与不存在同回答，反探测）。通过则返回注册项与 subject 语境；被拦则
 * 返回 Response 直接回给客户端。
 */
async function visibleSubject(
  db: Db,
  subjectType: string,
  subjectId: string,
  caller: FileCaller,
  c: Context<AppEnv>,
): Promise<SubjectGate | Response> {
  const loaded = await loadFileSubject(db, subjectType, subjectId);
  if (loaded === "unregistered") {
    return c.json({ error: "invalid_request" }, 400);
  }
  if (loaded?.definition.canView(loaded.subject, caller) !== true) {
    return c.json({ error: "not_found" }, 404);
  }
  return loaded;
}

const fileColumns = {
  id: schema.files.id,
  subjectType: schema.files.subjectType,
  subjectId: schema.files.subjectId,
  status: schema.files.status,
  fileName: schema.files.fileName,
  contentType: schema.files.contentType,
  sizeBytes: schema.files.sizeBytes,
  storageKey: schema.files.storageKey,
  uploadedBy: schema.files.uploadedBy,
  createdAt: schema.files.createdAt,
  readyAt: schema.files.readyAt,
};

async function loadFileRow(db: Db, id: string) {
  const rows = await db
    .select(fileColumns)
    .from(schema.files)
    .where(eq(schema.files.id, id))
    .limit(1);
  return rows[0] ?? null;
}

function fileJson(row: {
  id: string;
  status: "pending" | "ready";
  fileName: string;
  contentType: string;
  sizeBytes: number;
  createdAt: Date;
  readyAt: Date | null;
}) {
  return {
    id: row.id,
    status: row.status,
    fileName: row.fileName,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    createdAt: row.createdAt.toISOString(),
    ...(row.readyAt === null ? {} : { readyAt: row.readyAt.toISOString() }),
  };
}
