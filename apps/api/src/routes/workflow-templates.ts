import { asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { Db } from "@ally/db";
import { schema } from "@ally/db";
import type { AppEnv } from "../auth/session.ts";
import { requirePermission } from "../authz/middleware.ts";
import { recordAudit } from "../audit/audit-log.ts";
import { parseWorkflowTemplate, referencedBlocks, type ParsedTemplate } from "../workflow/engine.ts";
import { actionBlock, conditionBlock } from "../workflow/blocks.ts";
import { workflowTemplateSnapshot } from "../config-versions/families.ts";
import { jsonEqual, nextConfigVersion, recordConfigRevision, type ConfigChanges } from "../config-versions/service.ts";

/**
 * 流程模板端点（#220：配置工作室的流程配置面）。
 *
 * 模板管理在 `workflow.configure` 权限点后面（owner/admin 默认持有）——改流程
 * = 改全员的工作方式。definition 在保存时过四道校验：zod 结构 → 拓扑语义
 * （initial/target/自环）→ XState 可达性 → 积木存在性（gates/entryActions 引用
 * 的名字必须在注册表里）。
 *
 * 写路径两条（#226）：POST 创建（记台账 v1）与 PATCH 就地改写（productType/
 * isDefault/active/definition 四个内容字段，实效变更经配置版本台账记新版并留
 * 审计，无实效变更幂等返回不记账）。templateKey/subjectType 是身份不是内容，
 * 不在可改清单（strict body 拒绝，同 custom_field_defs.fieldKey 的裁法）。
 * 在飞实例持有启动时刻的 definition 快照，模板改版不改写在飞语义。
 *
 * 默认模板切换是两步：部分唯一索引（每 subjectType 至多一个默认）在写入侧拒绝
 * 双默认——先把旧默认摘掉（各记各的台账版），再把新模板设默认；不做静默降级
 * （降级是另一行的内容变更，必须走它自己的台账）。subject_type 是开集 text：
 * 四个对象（线索/商机/订单履约/偏差）的流程可以在各自的业务域落地前先行配置；
 * 「能不能真的启动」由实例侧的属主域注册表（workflow/registry.ts）裁决，两层
 * 各说各的话。
 */

type TemplateRow = typeof schema.workflowTemplates.$inferSelect;

const createBody = z.object({
  subjectType: z.string().trim().min(1).max(64),
  templateKey: z
    .string()
    .trim()
    .max(64)
    .regex(/^[a-z][a-z0-9_]*$/, "template keys must be lower_snake_case"),
  productType: z.string().trim().min(1).max(64).optional(),
  isDefault: z.boolean().default(false),
  definition: z.unknown(),
});

// strict：templateKey/subjectType 打进来必须显式 400 而不是被静默剥掉（键是
// 身份，改键 = 换一个模板，语义误导）
const patchBody = z
  .object({
    productType: z.string().trim().min(1).max(64).nullable().optional(),
    isDefault: z.boolean().optional(),
    active: z.boolean().optional(),
    definition: z.unknown().optional(),
  })
  .strict();

/** definition 的保存面校验（POST 与 PATCH 同一道四门）：不通过时给出 422 响应体 */
function definitionSave(
  definition: unknown,
): { ok: true; template: ParsedTemplate } | { ok: false; body: { error: "invalid_definition"; detail: string } | { error: "unknown_block"; detail: { gates: string[]; actions: string[] } } } {
  const parsed = parseWorkflowTemplate(definition);
  if (!parsed.ok) {
    return { ok: false, body: { error: "invalid_definition", detail: parsed.error } };
  }
  // 积木存在性在保存时收口：引用不存在的积木，模板当场拒绝——不带病入库
  const blocks = referencedBlocks(parsed.template);
  const missingGates = blocks.gates.filter((name) => conditionBlock(name) === undefined);
  const missingActions = blocks.actions.filter((name) => actionBlock(name) === undefined);
  if (missingGates.length > 0 || missingActions.length > 0) {
    return {
      ok: false,
      body: { error: "unknown_block", detail: { gates: missingGates, actions: missingActions } },
    };
  }
  return { ok: true, template: parsed.template };
}

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

export function workflowTemplatesRoutes(deps: { db: Db }) {
  const app = new Hono<AppEnv>();
  const requireWorkflowConfigure = requirePermission("workflow.configure");

  app.post("/api/workflow-templates", requireWorkflowConfigure, async (c) => {
    const parsed = createBody.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const body = parsed.data;
    const saved = definitionSave(body.definition);
    if (!saved.ok) {
      return c.json(saved.body, 422);
    }
    // 部分唯一索引（每类型至多一个默认模板）不在 onConflictDoNothing 的目标里，
    // 撞上它说明这个 subjectType 已有默认模板——结构不变式的 409，不是意外
    const actorId = c.get("user").id;
    let inserted: { id: string; version: number }[];
    try {
      inserted = await deps.db.transaction(async (tx) => {
        const rows = await tx
          .insert(schema.workflowTemplates)
          .values({
            subjectType: body.subjectType,
            templateKey: body.templateKey,
            ...(body.productType !== undefined ? { productType: body.productType } : {}),
            isDefault: body.isDefault,
            definition: body.definition,
            createdById: actorId,
          })
          .onConflictDoNothing({
            target: [schema.workflowTemplates.subjectType, schema.workflowTemplates.templateKey],
          })
          .returning({ id: schema.workflowTemplates.id, version: schema.workflowTemplates.version });
        const insertedRow = rows[0];
        if (insertedRow !== undefined) {
          // 台账 v1（#226）：创建即第一版事实，与配置行同一个事务
          await recordConfigRevision(tx, {
            subjectType: "workflow_template",
            subjectId: insertedRow.id,
            version: insertedRow.version,
            actorId,
            snapshot: workflowTemplateSnapshot({
              productType: body.productType ?? null,
              isDefault: body.isDefault,
              active: true,
              definition: body.definition,
            }),
            changes: null,
            source: "created",
          });
        }
        return rows;
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        return c.json({ error: "default_template_exists" }, 409);
      }
      throw err;
    }
    const row = inserted[0];
    if (row === undefined) {
      return c.json({ error: "template_exists" }, 409);
    }
    await recordAudit(deps.db, {
      actor: c.get("user").id,
      action: "workflow.template_created",
      target: row.id,
      detail: {
        subjectType: body.subjectType,
        templateKey: body.templateKey,
        ...(body.productType !== undefined ? { productType: body.productType } : {}),
        isDefault: body.isDefault,
        states: Object.keys(saved.template.states),
      },
    });
    return c.json({ id: row.id }, 201);
  });

  app.get("/api/workflow-templates", requireWorkflowConfigure, async (c) => {
    const subjectType = c.req.query("subjectType")?.trim();
    const rows = await deps.db
      .select()
      .from(schema.workflowTemplates)
      .where(subjectType !== undefined && subjectType !== "" ? eq(schema.workflowTemplates.subjectType, subjectType) : undefined)
      .orderBy(asc(schema.workflowTemplates.subjectType), asc(schema.workflowTemplates.templateKey));
    return c.json({ templates: rows });
  });

  app.get("/api/workflow-templates/:id", requireWorkflowConfigure, async (c) => {
    const id = z.uuid().safeParse(c.req.param("id"));
    if (!id.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const rows = await deps.db
      .select()
      .from(schema.workflowTemplates)
      .where(eq(schema.workflowTemplates.id, id.data))
      .limit(1);
    const row = rows[0];
    if (row === undefined) {
      return c.json({ error: "not_found" }, 404);
    }
    return c.json({ template: row });
  });

  // 就地改写（#226）：实效变更经台账记新版 + 审计同扇；definition 四门校验
  // 与 POST 同一道；无实效变更幂等返回现状（不记账不写审计，与 numbering
  // PATCH 同一纪律——审计只记真变更）。默认翻转撞部分唯一索引 → 409，两步
  // 切换是唯一路径（先摘旧默认再设新默认，各记各的台账版，无静默降级）。
  app.patch("/api/workflow-templates/:id", requireWorkflowConfigure, async (c) => {
    const id = z.uuid().safeParse(c.req.param("id"));
    if (!id.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const parsed = patchBody.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const body = parsed.data;
    if (body.definition !== undefined) {
      const saved = definitionSave(body.definition);
      if (!saved.ok) {
        return c.json(saved.body, 422);
      }
    }
    const found = await deps.db
      .select()
      .from(schema.workflowTemplates)
      .where(eq(schema.workflowTemplates.id, id.data))
      .limit(1);
    const current = found[0];
    if (current === undefined) {
      return c.json({ error: "not_found" }, 404);
    }
    const changes: ConfigChanges = {};
    if (body.productType !== undefined && body.productType !== current.productType) {
      changes.productType = { from: current.productType ?? null, to: body.productType };
    }
    if (body.isDefault !== undefined && body.isDefault !== current.isDefault) {
      changes.isDefault = { from: current.isDefault, to: body.isDefault };
    }
    if (body.active !== undefined && body.active !== current.active) {
      changes.active = { from: current.active, to: body.active };
    }
    if (body.definition !== undefined && !jsonEqual(body.definition, current.definition)) {
      changes.definition = { from: current.definition ?? null, to: body.definition };
    }
    if (Object.keys(changes).length === 0) {
      return c.json({ template: current });
    }
    const actorId = c.get("user").id;
    let updated: { template: TemplateRow } | undefined;
    try {
      updated = await deps.db.transaction(async (tx) => {
        // 版本号从台账取（行.version = 台账最新版的不变式，#226）
        const nextVersion = await nextConfigVersion(tx, "workflow_template", id.data);
        const rows = await tx
          .update(schema.workflowTemplates)
          .set({
            ...(body.productType !== undefined ? { productType: body.productType } : {}),
            ...(body.isDefault !== undefined ? { isDefault: body.isDefault } : {}),
            ...(body.active !== undefined ? { active: body.active } : {}),
            ...(body.definition !== undefined ? { definition: body.definition } : {}),
            version: nextVersion,
          })
          .where(eq(schema.workflowTemplates.id, id.data))
          .returning();
        const row = rows[0];
        if (row === undefined) {
          return undefined;
        }
        await recordConfigRevision(tx, {
          subjectType: "workflow_template",
          subjectId: id.data,
          version: nextVersion,
          actorId,
          snapshot: workflowTemplateSnapshot({
            productType: row.productType,
            isDefault: row.isDefault,
            active: row.active,
            definition: row.definition,
          }),
          changes,
          source: "updated",
        });
        return { template: row };
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        return c.json({ error: "default_template_exists" }, 409);
      }
      throw err;
    }
    if (updated === undefined) {
      return c.json({ error: "internal_error" }, 500);
    }
    await recordAudit(deps.db, {
      actor: c.get("user").id,
      action: "workflow.template_updated",
      target: updated.template.id,
      detail: {
        subjectType: updated.template.subjectType,
        templateKey: updated.template.templateKey,
        changes,
      },
    });
    return c.json({ template: updated.template });
  });

  return app;
}
