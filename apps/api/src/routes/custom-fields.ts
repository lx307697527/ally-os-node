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
import { customFieldDefSnapshot } from "../config-versions/families.ts";
import { jsonEqual, nextConfigVersion, recordConfigRevision } from "../config-versions/service.ts";
import {
  CUSTOM_FIELD_TYPES,
  canViewField,
  composeFormSchema,
  parseValueSubmission,
} from "../custom-fields/service.ts";

/**
 * 自定义字段端点（#222 切片 1：配置工作室的字段配置面 + 表单引擎的读写面；
 * 就地改写随本切片进场，#226 后续切片的「内容改写端点」。
 *
 * 分两层：/api/custom-fields* 在 `custom_fields.configure` 权限点后面（owner/admin
 * 默认持有，与 workflow.configure / approval.configure 同一批配置工作室管理者）
 * ——加字段 = 改所有人的表单；/api/subjects/:subjectType/:subjectId/custom-fields
 * 是字段值的读写面，登录即可，能不能看/写某个字段由 subject 可见性门
 * （subjects/registry.ts，与评论/活动/关注同一扇门）和字段级 viewableBy /
 * editableBy 逐字段裁决——配置权和填写权分离。
 *
 * fieldKey/subjectType 是身份，创建后不改写（键停用后不复用，同 workflow
 * template_key 纪律）；其余内容走就地 PATCH（strict、真变更才动行）——每次真
 * 变更同事务 bump 版本 + 记 #226 台账，与 approval/numbering PATCH 同纪律。
 * 改型（fieldType/options）不改写既有值：值行保留写入时的 JSON，读方按定义
 * 现值解析；内容校验对「改后的 (fieldType, options) 有效对」收口，不允许把
 * select 改成没有选项、也不允许给非 select 字段挂选项。
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

// strict PATCH：fieldKey/subjectType 是身份不在内容里；其余就地可改。options
// 的合法性（select 非空无重复、其余类型无选项）对「改后的有效对」统一收口，
// 不在形状层单独判——见 PATCH handler 内的 optionsRule
const patchBody = z
  .object({
    label: z.string().trim().min(1).max(200).optional(),
    fieldType: z.enum(CUSTOM_FIELD_TYPES).optional(),
    options: z.array(z.string().trim().min(1).max(100)).max(100).nullable().optional(),
    required: z.boolean().optional(),
    viewableBy: z.array(roleSchema).max(20).optional(),
    editableBy: z.array(roleSchema).max(20).optional(),
    active: z.boolean().optional(),
  })
  .strict();

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
    const actorId = c.get("user").id;
    const options = body.fieldType === "select" ? (body.options ?? []) : null;
    const row = await deps.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(schema.customFieldDefs)
        .values({
          subjectType: body.subjectType,
          fieldKey: body.fieldKey,
          label: body.label,
          fieldType: body.fieldType,
          ...(options !== null ? { options } : {}),
          required: body.required,
          viewableBy: [...body.viewableBy],
          editableBy: [...body.editableBy],
          createdById: actorId,
        })
        .onConflictDoNothing({
          target: [schema.customFieldDefs.subjectType, schema.customFieldDefs.fieldKey],
        })
        .returning({ id: schema.customFieldDefs.id, version: schema.customFieldDefs.version });
      const insertedRow = inserted[0];
      if (insertedRow !== undefined) {
        // 台账 v1（#226）：创建即第一版事实，与配置行同一个事务
        await recordConfigRevision(tx, {
          subjectType: "custom_field_def",
          subjectId: insertedRow.id,
          version: insertedRow.version,
          actorId,
          snapshot: customFieldDefSnapshot({
            label: body.label,
            fieldType: body.fieldType,
            options,
            required: body.required,
            viewableBy: [...body.viewableBy],
            editableBy: [...body.editableBy],
            active: true,
          }),
          changes: null,
          source: "created",
        });
      }
      return insertedRow;
    });
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

  // 就地改写/停用（#222 配置面，#226 台账）：strict PATCH、真变更才 bump 版本
  // 记台账——无实效变更幂等返回现状，审计和台账不被 no-op 刷屏（approval/numbering
  // PATCH 同纪律）。纯 active 翻转沿用 field_activated/field_deactivated 的既有
  // 审计词；内容变更（含与 active 同时改）记 field_updated，changes 全量进 detail
  app.patch("/api/custom-fields/:id", requireCustomFieldsConfigure, async (c) => {
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
      .from(schema.customFieldDefs)
      .where(eq(schema.customFieldDefs.id, id.data))
      .limit(1);
    const current = found[0];
    if (current === undefined) {
      return c.json({ error: "not_found" }, 404);
    }
    // 有效对 = 请求补过缺省的行内容；选项规则按改后的 (fieldType, options) 收口
    const effective = {
      label: body.label ?? current.label,
      fieldType: body.fieldType ?? current.fieldType,
      options: body.options !== undefined ? body.options : (current.options ?? null),
      required: body.required ?? current.required,
      viewableBy: body.viewableBy ?? current.viewableBy,
      editableBy: body.editableBy ?? current.editableBy,
      active: body.active ?? current.active,
    };
    if (effective.fieldType === "select") {
      if (
        effective.options === null ||
        effective.options.length === 0 ||
        new Set(effective.options).size !== effective.options.length
      ) {
        return c.json({ error: "invalid_options" }, 422);
      }
    } else if (effective.options !== null && effective.options.length > 0) {
      return c.json({ error: "invalid_options" }, 422);
    }
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    if (effective.label !== current.label) {
      changes.label = { from: current.label, to: effective.label };
    }
    if (effective.fieldType !== current.fieldType) {
      changes.fieldType = { from: current.fieldType, to: effective.fieldType };
    }
    if (!jsonEqual(effective.options, current.options ?? null)) {
      changes.options = { from: current.options ?? null, to: effective.options };
    }
    if (effective.required !== current.required) {
      changes.required = { from: current.required, to: effective.required };
    }
    if (!jsonEqual(effective.viewableBy, current.viewableBy)) {
      changes.viewableBy = { from: current.viewableBy, to: effective.viewableBy };
    }
    if (!jsonEqual(effective.editableBy, current.editableBy)) {
      changes.editableBy = { from: current.editableBy, to: effective.editableBy };
    }
    if (effective.active !== current.active) {
      changes.active = { from: current.active, to: effective.active };
    }
    if (Object.keys(changes).length === 0) {
      return c.json({ field: current });
    }
    const actorId = c.get("user").id;
    const row = await deps.db.transaction(async (tx) => {
      // 停用/恢复/改内容都是一次内容变更：版本号从台账取（行.version = 台账最新
      // 版的不变式，#226）
      const nextVersion = await nextConfigVersion(tx, "custom_field_def", id.data);
      const updated = await tx
        .update(schema.customFieldDefs)
        .set({
          label: effective.label,
          fieldType: effective.fieldType,
          options: effective.options,
          required: effective.required,
          viewableBy: [...effective.viewableBy],
          editableBy: [...effective.editableBy],
          active: effective.active,
          version: nextVersion,
        })
        .where(eq(schema.customFieldDefs.id, id.data))
        .returning({
          id: schema.customFieldDefs.id,
          subjectType: schema.customFieldDefs.subjectType,
          fieldKey: schema.customFieldDefs.fieldKey,
          label: schema.customFieldDefs.label,
          fieldType: schema.customFieldDefs.fieldType,
          options: schema.customFieldDefs.options,
          required: schema.customFieldDefs.required,
          viewableBy: schema.customFieldDefs.viewableBy,
          editableBy: schema.customFieldDefs.editableBy,
          active: schema.customFieldDefs.active,
          version: schema.customFieldDefs.version,
          createdById: schema.customFieldDefs.createdById,
          createdAt: schema.customFieldDefs.createdAt,
        });
      const updatedRow = updated[0];
      if (updatedRow === undefined) {
        return undefined;
      }
      await recordConfigRevision(tx, {
        subjectType: "custom_field_def",
        subjectId: id.data,
        version: nextVersion,
        actorId,
        snapshot: customFieldDefSnapshot({
          label: updatedRow.label,
          fieldType: updatedRow.fieldType,
          options: updatedRow.options,
          required: updatedRow.required,
          viewableBy: updatedRow.viewableBy,
          editableBy: updatedRow.editableBy,
          active: updatedRow.active,
        }),
        changes,
        source: "updated",
      });
      return updatedRow;
    });
    if (row === undefined) {
      return c.json({ error: "not_found" }, 404);
    }
    const contentChanged = Object.keys(changes).some((key) => key !== "active");
    if (contentChanged) {
      await recordAudit(deps.db, {
        actor: actorId,
        action: "custom_fields.field_updated",
        target: row.id,
        detail: { subjectType: row.subjectType, fieldKey: row.fieldKey, changes },
      });
    } else {
      await recordAudit(deps.db, {
        actor: actorId,
        action: row.active ? "custom_fields.field_activated" : "custom_fields.field_deactivated",
        target: row.id,
      });
    }
    return c.json({ field: row });
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
      const clearedFieldKeys: string[] = [];
      for (const write of result.writes) {
        if (write.action === "clear") {
          // 显式 null 清值 = 删值行，不是写 SQL NULL：值列 NOT NULL（worker 的
          // custom_field 条件块依赖「行在场即有 JSON 值」），行不在场 = 未填或已清
          await tx
            .delete(schema.customFieldValues)
            .where(
              and(
                eq(schema.customFieldValues.subjectType, subjectType),
                eq(schema.customFieldValues.subjectId, subjectId.data),
                eq(schema.customFieldValues.fieldDefId, write.def.id),
              ),
            );
          clearedFieldKeys.push(write.def.fieldKey);
          continue;
        }
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
          ...(clearedFieldKeys.length > 0 ? { clearedFieldKeys } : {}),
        },
      });
      return result.writes.length;
    });
    return c.json({ updated });
  });

  return app;
}
