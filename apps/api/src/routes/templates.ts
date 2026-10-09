import { and, asc, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Logger } from "pino";
import { z } from "zod";
import type { Db } from "@ally/db";
import { schema } from "@ally/db";
import {
  extractTemplateVariables,
  missingTemplateVariables,
  renderTemplate,
  templateBodySchema,
  templateChannelSchema,
  templateChannels,
  templateContentError,
  templateSubjectSchema,
  templateTypeSchema,
  templateVarsSchema,
} from "@ally/templates";
import type { AppEnv } from "../auth/session.ts";
import { requirePermission } from "../authz/middleware.ts";
import { recordAudit } from "../audit/audit-log.ts";

/** pg 的唯一约束冲突（23505）：形状收窄而不引依赖（numbering-rules.ts 同款） */
function isUniqueViolation(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 4 && typeof current === "object" && current !== null; depth++) {
    const candidate = current as { code?: unknown; cause?: unknown };
    if (candidate.code === "23505") return true;
    current = candidate.cause;
  }
  return false;
}

/**
 * 内容模板端点（#225 切片 2：配置工作室的模板配置面）。
 *
 * 全部在 `templates.configure` 权限点后面（owner/admin 默认持有，配置工作室
 * configure 族同批）——改一封全员会收到的信的措辞 = 改全公司的通信面；与
 * PDF 品牌配置（pdf-template-config.ts，invoices.manage）分立，见权限注册表
 * 的注释。模板的**消费**没有 HTTP 面：resolveAuthEmail（templates/service.ts）
 * 是进程内调用，发不发、发给谁由触发自己的业务门裁决——发号不设端点、
 * 分配不走 HTTP 的同一裁法。
 *
 * 语义：
 * - 行身份 = (channel, template_type) 唯一，POST 撞唯一索引与「已存在」同答
 *   409（并发建同用途模板是合法竞争，不能 500）。
 * - PATCH 收完整内容对象（strict，pdf-template-config 同纪律）：内容实效变更
 *   → 版本 +1 并落一行不可变版本史；只动 isActive 不起新版本（开关不是内容）；
 *   无实效变更幂等返回不留审计。停用（isActive=false）= 消费方回退内置文案，
 *   **没有 DELETE 端点**——可逆的停用比删除诚实，内容与版本史都留档。
 * - 回滚 = 旧版本内容落成一个**新**版本（config_revisions 的 rolled_back 同一
 *   语义：历史不改写，回滚本身可追溯、可再回滚）。
 * - 不进 config-revisions（#226）：与 pdf_template_config 同族裁决的延伸——
 *   版本化由本域的不可变版本表自己承担（#131 的「版本回滚」吃这张表）。
 */

const createBody = z
  .object({
    channel: templateChannelSchema,
    templateType: templateTypeSchema,
    subjectTemplate: templateSubjectSchema.nullable().default(null),
    bodyTemplate: templateBodySchema,
  })
  .strict();

// strict + 完整对象：内容三件套（主题/正文/开关）一口气交齐，没有「只发一个
// 字段」的部分更新——模板是给人读的整封信，逐字段 patch 容易拼出半封信
const patchBody = z
  .object({
    subjectTemplate: templateSubjectSchema.nullable(),
    bodyTemplate: templateBodySchema,
    isActive: z.boolean(),
  })
  .strict();

const rollbackBody = z.object({ version: z.number().int().positive() }).strict();

const previewBody = z
  .object({
    subjectTemplate: templateSubjectSchema.nullable().default(null),
    bodyTemplate: templateBodySchema,
    vars: templateVarsSchema.default({}),
  })
  .strict();

interface TemplateRow {
  id: string;
  channel: string;
  templateType: string;
  subjectTemplate: string | null;
  bodyTemplate: string;
  isActive: boolean;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

function presentTemplate(row: TemplateRow) {
  return {
    id: row.id,
    channel: row.channel,
    templateType: row.templateType,
    subjectTemplate: row.subjectTemplate,
    bodyTemplate: row.bodyTemplate,
    isActive: row.isActive,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function templatesRoutes(deps: { db: Db; logger: Logger }) {
  const app = new Hono<AppEnv>();
  const requireTemplatesConfigure = requirePermission("templates.configure");

  app.get("/api/templates", requireTemplatesConfigure, async (c) => {
    const rows = await deps.db
      .select()
      .from(schema.systemTemplates)
      .orderBy(asc(schema.systemTemplates.channel), asc(schema.systemTemplates.templateType));
    // 停用模板一并返回（留档可查，与编号规则停用行同一读法）
    return c.json({
      channels: templateChannels(),
      templates: rows.map(presentTemplate),
    });
  });

  app.post("/api/templates", requireTemplatesConfigure, async (c) => {
    const parsed = createBody.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const body = parsed.data;
    const contentError = templateContentError(body.channel, {
      subjectTemplate: body.subjectTemplate,
      bodyTemplate: body.bodyTemplate,
    });
    if (contentError !== null) {
      return c.json({ error: contentError }, 400);
    }
    const actorId = c.get("user").id;
    let inserted: { id: string }[];
    try {
      inserted = await deps.db.transaction(async (tx) => {
        const rows = await tx
          .insert(schema.systemTemplates)
          .values({
            channel: body.channel,
            templateType: body.templateType,
            subjectTemplate: body.subjectTemplate,
            bodyTemplate: body.bodyTemplate,
            createdById: actorId,
            updatedById: actorId,
          })
          .returning({ id: schema.systemTemplates.id });
        const row = rows[0];
        if (row !== undefined) {
          // v1 即创建时刻的内容：版本史从第一版起完整（回滚链没有空洞）
          await tx.insert(schema.systemTemplateVersions).values({
            templateId: row.id,
            version: 1,
            subjectTemplate: body.subjectTemplate,
            bodyTemplate: body.bodyTemplate,
            changedById: actorId,
          });
        }
        return rows;
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        return c.json({ error: "template_exists" }, 409);
      }
      throw err;
    }
    const row = inserted[0];
    if (row === undefined) {
      return c.json({ error: "internal_error" }, 500);
    }
    await recordAudit(deps.db, {
      actor: actorId,
      action: "template.created",
      target: row.id,
      detail: { channel: body.channel, templateType: body.templateType, version: 1 },
    });
    deps.logger.info(
      { actor: actorId, channel: body.channel, templateType: body.templateType },
      "system template created",
    );
    return c.json({ id: row.id }, 201);
  });

  app.get("/api/templates/:id", requireTemplatesConfigure, async (c) => {
    const id = z.uuid().safeParse(c.req.param("id"));
    if (!id.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const rows = await deps.db
      .select()
      .from(schema.systemTemplates)
      .where(eq(schema.systemTemplates.id, id.data));
    const row = rows[0];
    if (row === undefined) {
      return c.json({ error: "not_found" }, 404);
    }
    const versions = await deps.db
      .select({
        version: schema.systemTemplateVersions.version,
        subjectTemplate: schema.systemTemplateVersions.subjectTemplate,
        bodyTemplate: schema.systemTemplateVersions.bodyTemplate,
        changedById: schema.systemTemplateVersions.changedById,
        changedAt: schema.systemTemplateVersions.changedAt,
      })
      .from(schema.systemTemplateVersions)
      .where(eq(schema.systemTemplateVersions.templateId, id.data))
      .orderBy(desc(schema.systemTemplateVersions.version))
      .limit(100);
    return c.json({ template: presentTemplate(row), versions });
  });

  app.patch("/api/templates/:id", requireTemplatesConfigure, async (c) => {
    const id = z.uuid().safeParse(c.req.param("id"));
    if (!id.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const parsed = patchBody.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const body = parsed.data;
    const found = await deps.db
      .select()
      .from(schema.systemTemplates)
      .where(eq(schema.systemTemplates.id, id.data));
    const current = found[0];
    if (current === undefined) {
      return c.json({ error: "not_found" }, 404);
    }
    const contentError = templateContentError(current.channel, {
      subjectTemplate: body.subjectTemplate,
      bodyTemplate: body.bodyTemplate,
    });
    if (contentError !== null) {
      return c.json({ error: contentError }, 400);
    }
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    if (body.subjectTemplate !== current.subjectTemplate) {
      changes.subjectTemplate = { from: current.subjectTemplate, to: body.subjectTemplate };
    }
    if (body.bodyTemplate !== current.bodyTemplate) {
      changes.bodyTemplate = { from: current.bodyTemplate, to: body.bodyTemplate };
    }
    if (body.isActive !== current.isActive) {
      changes.isActive = { from: current.isActive, to: body.isActive };
    }
    if (Object.keys(changes).length === 0) {
      // 无实效变更：幂等返回现状，不留审计（comment edit / numbering PATCH 同纪律）
      return c.json({ template: presentTemplate(current), updated: false });
    }
    const contentChanged =
      changes.subjectTemplate !== undefined || changes.bodyTemplate !== undefined;
    const actorId = c.get("user").id;
    const updated = await deps.db.transaction(async (tx) => {
      const nextVersion = contentChanged ? current.version + 1 : current.version;
      const rows = await tx
        .update(schema.systemTemplates)
        .set({
          subjectTemplate: body.subjectTemplate,
          bodyTemplate: body.bodyTemplate,
          isActive: body.isActive,
          ...(contentChanged ? { version: nextVersion } : {}),
          updatedById: actorId,
          updatedAt: new Date(),
        })
        .where(eq(schema.systemTemplates.id, id.data))
        .returning();
      const row = rows[0];
      if (row !== undefined && contentChanged) {
        await tx.insert(schema.systemTemplateVersions).values({
          templateId: row.id,
          version: nextVersion,
          subjectTemplate: row.subjectTemplate,
          bodyTemplate: row.bodyTemplate,
          changedById: actorId,
        });
      }
      return row;
    });
    if (updated === undefined) {
      return c.json({ error: "internal_error" }, 500);
    }
    await recordAudit(deps.db, {
      actor: actorId,
      action: "template.updated",
      target: updated.id,
      detail: {
        channel: updated.channel,
        templateType: updated.templateType,
        changes,
        ...(contentChanged ? { newVersion: updated.version } : {}),
      },
    });
    deps.logger.info(
      { actor: actorId, templateType: updated.templateType, fields: Object.keys(changes) },
      "system template updated",
    );
    return c.json({ template: presentTemplate(updated), updated: true });
  });

  app.post("/api/templates/:id/rollback", requireTemplatesConfigure, async (c) => {
    const id = z.uuid().safeParse(c.req.param("id"));
    if (!id.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const parsed = rollbackBody.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const templateRows = await deps.db
      .select()
      .from(schema.systemTemplates)
      .where(eq(schema.systemTemplates.id, id.data));
    const current = templateRows[0];
    if (current === undefined) {
      return c.json({ error: "not_found" }, 404);
    }
    const targetRows = await deps.db
      .select()
      .from(schema.systemTemplateVersions)
      .where(
        and(
          eq(schema.systemTemplateVersions.templateId, id.data),
          eq(schema.systemTemplateVersions.version, parsed.data.version),
        ),
      );
    const target = targetRows[0];
    if (target === undefined) {
      return c.json({ error: "version_not_found" }, 404);
    }
    const actorId = c.get("user").id;
    const nextVersion = current.version + 1;
    const updated = await deps.db.transaction(async (tx) => {
      const rows = await tx
        .update(schema.systemTemplates)
        .set({
          subjectTemplate: target.subjectTemplate,
          bodyTemplate: target.bodyTemplate,
          version: nextVersion,
          updatedById: actorId,
          updatedAt: new Date(),
        })
        .where(eq(schema.systemTemplates.id, id.data))
        .returning();
      const row = rows[0];
      if (row !== undefined) {
        await tx.insert(schema.systemTemplateVersions).values({
          templateId: row.id,
          version: nextVersion,
          subjectTemplate: target.subjectTemplate,
          bodyTemplate: target.bodyTemplate,
          changedById: actorId,
        });
      }
      return row;
    });
    if (updated === undefined) {
      return c.json({ error: "internal_error" }, 500);
    }
    await recordAudit(deps.db, {
      actor: actorId,
      action: "template.rolled_back",
      target: updated.id,
      detail: {
        channel: updated.channel,
        templateType: updated.templateType,
        restoredVersion: parsed.data.version,
        newVersion: nextVersion,
      },
    });
    deps.logger.info(
      { actor: actorId, templateType: updated.templateType, restored: parsed.data.version },
      "system template rolled back",
    );
    return c.json({ template: presentTemplate(updated) });
  });

  app.post("/api/templates/preview", requireTemplatesConfigure, async (c) => {
    const parsed = previewBody.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const body = parsed.data;
    // 预览不落库、不校验 channel（渲染语义与 channel 无关）；missingVariables
    // 是「这封信发出去会带着 {{xxx}} 出门」的显性提示，不拦——拦了就看不到
    // 错在哪了（与渲染的「缺失保留原样」同一可诊断哲学）
    const subjectTemplate = body.subjectTemplate ?? "";
    const referenced = extractTemplateVariables(subjectTemplate, body.bodyTemplate);
    const missing = missingTemplateVariables(referenced, body.vars);
    return c.json({
      subject: body.subjectTemplate === null ? null : renderTemplate(subjectTemplate, body.vars),
      body: renderTemplate(body.bodyTemplate, body.vars),
      referencedVariables: referenced,
      missingVariables: missing,
    });
  });

  return app;
}
