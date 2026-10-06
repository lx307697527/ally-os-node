import { and, asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Logger } from "pino";
import { z } from "zod";
import type { Db } from "@ally/db";
import { schema } from "@ally/db";
import type { AppEnv } from "../auth/session.ts";
import { requirePermission } from "../authz/middleware.ts";
import { roleSchema } from "../authz/permissions.ts";
import { recordAudit } from "../audit/audit-log.ts";
import { loadVisibleSubject } from "../subjects/registry.ts";
import { formSubjectSpec } from "../custom-fields/registry.ts";
import {
  CUSTOM_FIELD_TYPES,
  canViewField,
  composeFormSchema,
  parseValueSubmission,
} from "../custom-fields/service.ts";

/**
 * 自定义字段端点（#222 切片 1：配置工作室的字段配置面 + 表单引擎的读写面）。
 *
 * 分两层：/api/custom-fields* 在 `custom_fields.configure` 权限点后面（owner/admin
 * 默认持有，与 workflow.configure / approval.configure 同一批配置工作室管理者）
 * ——加字段 = 改所有人的表单；/api/subjects/:subjectType/:subjectId/custom-fields
 * 是字段值的读写面，登录即可，能不能看/写某个字段由 subject 可见性门
 * （subjects/registry.ts，与评论/活动/关注同一扇门）和字段级 viewableBy /
 * editableBy 逐字段裁决——配置权和填写权分离。
 *
 * 定义一经创建不改写（与 workflow/approval 配置同一最小纪律，版本化随 #226 进场）：
 * 停用 = active 翻转。表单 schema 端点要求 subject 类型已在 custom-fields/registry.ts
 * 注册（内置字段由属主域提供），未注册回 400——机制先行不留产线。
 */

const createBody = z.object({
  subjectType: z.string().trim().min(1).max(64),
  fieldKey: z
    .string()
    .trim()
    .max(64)
    .regex(/^[a-z][a-z0-9_]*$/, "field keys must be lower_snake_case"),
  label: z.string().trim().min(1).max(200),
  fieldType: z.enum(CUSTOM_FIELD_TYPES),
  options: z.array(z.string().trim().min(1).max(100)).max(100).optional(),
  required: z.boolean().default(false),
  viewableBy: z.array(roleSchema).max(20).default([]),
  editableBy: z.array(roleSchema).max(20).default([]),
});

const patchBody = z.object({ active: z.boolean() });

const valuesBody = z.object({ values: z.record(z.string(), z.unknown()) });

async function loadActiveDefs(db: Db, subjectType: string) {
  return db
    .select()
    .from(schema.customFieldDefs)
    .where(
      and(eq(schema.customFieldDefs.subjectType, subjectType), eq(schema.customFieldDefs.active, true)),
    )
    .orderBy(asc(schema.customFieldDefs.createdAt), asc(schema.customFieldDefs.id));
}

export function customFieldsRoutes(deps: { db: Db; logger: Logger }) {
  const app = new Hono<AppEnv>();
  const requireCustomFieldsConfigure = requirePermission("custom_fields.configure");

  app.post("/api/custom-fields", requireCustomFieldsConfigure, async (c) => {
    const parsed = createBody.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const body = parsed.data;
    // select 必须带非空、无重复的选项；其余类型不带选项——形状在保存时收口，
    // 不带病入库（值校验的 z.enum 依赖选项存在）
    if (body.fieldType === "select") {
      const options = body.options ?? [];
      if (options.length === 0 || new Set(options).size !== options.length) {
        return c.json({ error: "invalid_options" }, 422);
      }
    } else if (body.options !== undefined && body.options.length > 0) {
      return c.json({ error: "invalid_options" }, 422);
    }
    // 内置键冲突在保存时收口：注册表里有该对象的内置字段形状时，同键自定义字段
    // 当场拒绝（合成时兜底的同一不变式，提前到写入侧）
    const spec = formSubjectSpec(body.subjectType);
    if (spec !== undefined && body.fieldKey in spec.builtin) {
      return c.json({ error: "builtin_key_conflict" }, 422);
    }
    const inserted = await deps.db
      .insert(schema.customFieldDefs)
      .values({
        subjectType: body.subjectType,
        fieldKey: body.fieldKey,
        label: body.label,
        fieldType: body.fieldType,
        ...(body.fieldType === "select" ? { options: body.options ?? [] } : {}),
        required: body.required,
        viewableBy: [...body.viewableBy],
        editableBy: [...body.editableBy],
        createdById: c.get("user").id,
      })
      .onConflictDoNothing({
        target: [schema.customFieldDefs.subjectType, schema.customFieldDefs.fieldKey],
      })
      .returning({ id: schema.customFieldDefs.id });
    const row = inserted[0];
    if (row === undefined) {
      return c.json({ error: "field_exists" }, 409);
    }
    await recordAudit(deps.db, {
      actor: c.get("user").id,
      action: "custom_fields.field_created",
      target: row.id,
      detail: {
        subjectType: body.subjectType,
        fieldKey: body.fieldKey,
        fieldType: body.fieldType,
        required: body.required,
        viewableBy: body.viewableBy,
        editableBy: body.editableBy,
      },
    });
    return c.json({ id: row.id }, 201);
  });

  app.get("/api/custom-fields", requireCustomFieldsConfigure, async (c) => {
    const subjectType = c.req.query("subjectType")?.trim();
    const rows = await deps.db
      .select()
      .from(schema.customFieldDefs)
      .where(
        subjectType !== undefined && subjectType !== ""
          ? eq(schema.customFieldDefs.subjectType, subjectType)
          : undefined,
      )
      .orderBy(asc(schema.customFieldDefs.subjectType), asc(schema.customFieldDefs.fieldKey));
    return c.json({ fields: rows });
  });

  // 停用/恢复 = active 翻转，定义不改写（#226 版本化进场前的最小纪律）
  app.patch("/api/custom-fields/:id", requireCustomFieldsConfigure, async (c) => {
    const id = z.uuid().safeParse(c.req.param("id"));
    if (!id.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const parsed = patchBody.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const updated = await deps.db
      .update(schema.customFieldDefs)
      .set({ active: parsed.data.active })
      .where(eq(schema.customFieldDefs.id, id.data))
      .returning({ id: schema.customFieldDefs.id, active: schema.customFieldDefs.active });
    const row = updated[0];
    if (row === undefined) {
      return c.json({ error: "not_found" }, 404);
    }
    await recordAudit(deps.db, {
      actor: c.get("user").id,
      action: row.active ? "custom_fields.field_activated" : "custom_fields.field_deactivated",
      target: row.id,
    });
    return c.json({ id: row.id, active: row.active });
  });

  // 表单引擎的合成 schema：内置字段（属主域注册的 zod）+ 生效自定义字段，一份
  // JSON Schema 同时供前端渲染与服务端校验。不在权限点后面——填表人是全体登录者
  app.get("/api/custom-fields/schema", async (c) => {
    const subjectType = c.req.query("subjectType")?.trim();
    if (subjectType === undefined || subjectType === "") {
      return c.json({ error: "invalid_request" }, 400);
    }
    const spec = formSubjectSpec(subjectType);
    if (spec === undefined) {
      return c.json({ error: "unregistered_subject" }, 400);
    }
    const defs = await loadActiveDefs(deps.db, subjectType);
    let jsonSchema: Record<string, unknown>;
    try {
      jsonSchema = composeFormSchema(spec.builtin, defs);
    } catch (err) {
      // 自定义字段键与内置键撞名：写入侧已拦（builtin_key_conflict），这里是
      // 注册表晚于字段配置进场的兜底——配置事故要响，不能悄悄盖掉内置字段
      deps.logger.error({ err, subjectType }, "custom field schema composition failed");
      return c.json({ error: "schema_conflict" }, 409);
    }
    return c.json({
      subjectType,
      schema: jsonSchema,
      fields: defs.map((def) => ({
        id: def.id,
        fieldKey: def.fieldKey,
        label: def.label,
        fieldType: def.fieldType,
        required: def.required,
      })),
    });
  });

  // 字段值读取：subject 必须对调用者可见（与评论/活动/关注同一扇门），逐字段过
  // viewableBy——看不见的字段连「存在」都不出现在响应里
  app.get("/api/subjects/:subjectType/:subjectId/custom-fields", async (c) => {
    const subjectType = c.req.param("subjectType");
    const subjectId = z.uuid().safeParse(c.req.param("subjectId"));
    if (!subjectId.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const user = c.get("user");
    const subject = await loadVisibleSubject(deps.db, subjectType, subjectId.data, user.id);
    if (subject === "unregistered") {
      return c.json({ error: "unregistered_subject" }, 400);
    }
    if (subject === null) {
      return c.json({ error: "not_found" }, 404);
    }
    const { roles } = c.get("authz");
    const defs = await loadActiveDefs(deps.db, subjectType);
    const visible = defs.filter((def) => canViewField(def, roles));
    const valueRows =
      visible.length > 0
        ? await deps.db
            .select({
              fieldDefId: schema.customFieldValues.fieldDefId,
              value: schema.customFieldValues.value,
            })
            .from(schema.customFieldValues)
            .where(
              and(
                eq(schema.customFieldValues.subjectType, subjectType),
                eq(schema.customFieldValues.subjectId, subjectId.data),
              ),
            )
        : [];
    const byDefId = new Map(valueRows.map((row) => [row.fieldDefId, row.value]));
    return c.json({
      fields: visible.map((def) => ({
        id: def.id,
        fieldKey: def.fieldKey,
        label: def.label,
        fieldType: def.fieldType,
        required: def.required,
        value: byDefId.get(def.id) ?? null,
      })),
    });
  });

  // 字段值提交（完整提交语义，见 parseValueSubmission）：subject 可见 + 逐字段
  // editableBy + 类型/必填校验，全部通过才在一个事务里 upsert 并写审计
  app.put("/api/subjects/:subjectType/:subjectId/custom-fields", async (c) => {
    const subjectType = c.req.param("subjectType");
    const subjectId = z.uuid().safeParse(c.req.param("subjectId"));
    if (!subjectId.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const parsed = valuesBody.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const user = c.get("user");
    const subject = await loadVisibleSubject(deps.db, subjectType, subjectId.data, user.id);
    if (subject === "unregistered") {
      return c.json({ error: "unregistered_subject" }, 400);
    }
    if (subject === null) {
      return c.json({ error: "not_found" }, 404);
    }
    const { roles } = c.get("authz");
    const defs = await loadActiveDefs(deps.db, subjectType);
    const result = parseValueSubmission(defs, roles, parsed.data.values);
    if (!result.ok) {
      return c.json({ error: "invalid_values", issues: result.issues }, 422);
    }
    const updated = await deps.db.transaction(async (tx) => {
      for (const write of result.writes) {
        await tx
          .insert(schema.customFieldValues)
          .values({
            subjectType,
            subjectId: subjectId.data,
            fieldDefId: write.def.id,
            value: write.value,
            updatedById: user.id,
          })
          .onConflictDoUpdate({
            target: [
              schema.customFieldValues.subjectType,
              schema.customFieldValues.subjectId,
              schema.customFieldValues.fieldDefId,
            ],
            set: {
              value: write.value,
              updatedById: user.id,
              updatedAt: new Date(),
            },
          });
      }
      await recordAudit(tx, {
        actor: user.id,
        action: "custom_fields.values_updated",
        target: subjectId.data,
        detail: {
          subjectType,
          subjectId: subjectId.data,
          title: subject.title,
          fieldKeys: result.writes.map((write) => write.def.fieldKey),
        },
      });
      return result.writes.length;
    });
    return c.json({ updated });
  });

  return app;
}
