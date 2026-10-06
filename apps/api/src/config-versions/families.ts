import { eq } from "drizzle-orm";
import { z } from "zod";
import { schema } from "@ally/db";
import { NUMBERING_DATE_FORMATS } from "../numbering/service.ts";
import { registerConfigSubject, type ConfigSubjectSpec } from "./registry.ts";

/**
 * 五族配置的台账契约（#226 切片 1）：快照形状、回滚落列、注册。
 *
 * 本文件是「快照长什么样」的唯一事实来源：配置面写入时用这里的 snapshotXxx
 * 建快照（0019 迁移的存量补账 SQL 与这些形状逐一同构），回滚时用同一形状的
 * zod 收口后落列。快照只含用户可编辑内容——id/键/时间戳/审计元数据不在内：
 * 键是身份不是内容（custom_field_defs 的 fieldKey 唯一、停用后不复用，回滚一
 * 个「别的键」是语义错误），numbering 的 startNumber 刻意不可恢复（对已在发
 * 的系列无效果，同 PATCH 面的拒绝理由）。
 *
 * 回滚能力随内容改写路径走：workflow / approval 本切片没有定义改写端点（行
 * 内容恒等于 v1，无可回滚的差异），注册时不带 applyRevision，回滚端点对其答
 * 409——定义改写端点进场（#226 后续切片）时同步补 applyRevision。
 */

// ── 流程模板（#220）────────────────────────────────────────────────────────
export function workflowTemplateSnapshot(row: {
  productType: string | null;
  isDefault: boolean;
  active: boolean;
  definition: unknown;
}): Record<string, unknown> {
  return {
    productType: row.productType,
    isDefault: row.isDefault,
    active: row.active,
    definition: row.definition,
  };
}

// ── 审批线（#221）──────────────────────────────────────────────────────────
export function approvalConfigSnapshot(row: {
  name: string;
  levels: unknown;
  active: boolean;
}): Record<string, unknown> {
  return { name: row.name, levels: row.levels, active: row.active };
}

// ── 自定义字段（#222）──────────────────────────────────────────────────────
const customFieldDefSnapshotSchema = z.object({
  label: z.string().min(1).max(200),
  fieldType: z.enum(schema.customFieldType.enumValues),
  options: z.array(z.string()).nullable(),
  required: z.boolean(),
  viewableBy: z.array(z.string()),
  editableBy: z.array(z.string()),
  active: z.boolean(),
});

export function customFieldDefSnapshot(row: {
  label: string;
  fieldType: (typeof schema.customFieldType.enumValues)[number];
  options: string[] | null;
  required: boolean;
  viewableBy: string[];
  editableBy: string[];
  active: boolean;
}): Record<string, unknown> {
  return {
    label: row.label,
    fieldType: row.fieldType,
    options: row.options,
    required: row.required,
    viewableBy: row.viewableBy,
    editableBy: row.editableBy,
    active: row.active,
  };
}

// ── 自动化规则（#224）──────────────────────────────────────────────────────
// trigger/conditions/actions 在写入面已过 @ally/automations 的 ruleSpecSchema；
// 这里的收口是 JSONB 边界的结构形状（回滚要把同一份字节写回去，业务语义复核
// 不是回滚的职责——账里的快照来自上一道校验之后的落库形态）
const automationRuleSnapshotSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().nullable(),
  trigger: z.record(z.string(), z.unknown()),
  conditions: z.array(z.unknown()),
  actions: z.array(z.unknown()),
  enabled: z.boolean(),
});

export function automationRuleSnapshot(row: {
  name: string;
  description: string | null;
  trigger: Record<string, unknown>;
  conditions: unknown[];
  actions: unknown[];
  enabled: boolean;
}): Record<string, unknown> {
  return {
    name: row.name,
    description: row.description,
    trigger: row.trigger,
    conditions: row.conditions,
    actions: row.actions,
    enabled: row.enabled,
  };
}

// ── 编号规则（#225）────────────────────────────────────────────────────────
const numberingRuleSnapshotSchema = z.object({
  label: z.string().min(1).max(200),
  prefix: z.string().max(16),
  dateFormat: z.enum(NUMBERING_DATE_FORMATS).nullable(),
  padding: z.number().int().min(0).max(10),
  active: z.boolean(),
});

export function numberingRuleSnapshot(row: {
  label: string;
  prefix: string;
  dateFormat: (typeof NUMBERING_DATE_FORMATS)[number] | null;
  padding: number;
  active: boolean;
}): Record<string, unknown> {
  return {
    label: row.label,
    prefix: row.prefix,
    dateFormat: row.dateFormat,
    padding: row.padding,
    active: row.active,
  };
}

// ── 回滚落列 ───────────────────────────────────────────────────────────────
// 快照过不了族 schema = 台账内容被绕过写入面动过（或跨版本形状漂移），当场炸
// 成 500 让人来看，绝不静默把不可信形状写进配置行。返回 false = 配置行已不存在
// （规则被删、定义被替换），内核答 404。

function parseSnapshotOrThrow<S extends z.ZodType>(
  subjectType: string,
  familySchema: S,
  snapshot: Record<string, unknown>,
): z.output<S> {
  const parsed = familySchema.safeParse(snapshot);
  if (!parsed.success) {
    throw new Error(
      `config-versions: snapshot of ${subjectType} does not match its family contract: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

const customFieldDefSpec: ConfigSubjectSpec = {
  label: "自定义字段",
  configurePermission: "custom_fields.configure",
  applyRevision: async (tx, subjectId, snapshot, version) => {
    const data = parseSnapshotOrThrow("custom_field_def", customFieldDefSnapshotSchema, snapshot);
    const updated = await tx
      .update(schema.customFieldDefs)
      .set({
        label: data.label,
        fieldType: data.fieldType,
        options: data.options,
        required: data.required,
        viewableBy: data.viewableBy,
        editableBy: data.editableBy,
        active: data.active,
        version,
      })
      .where(eq(schema.customFieldDefs.id, subjectId))
      .returning({ id: schema.customFieldDefs.id });
    return updated.length > 0;
  },
};

const automationRuleSpec: ConfigSubjectSpec = {
  label: "自动化规则",
  configurePermission: "automations.configure",
  applyRevision: async (tx, subjectId, snapshot, version) => {
    const data = parseSnapshotOrThrow("automation_rule", automationRuleSnapshotSchema, snapshot);
    const updated = await tx
      .update(schema.automationRules)
      .set({
        name: data.name,
        description: data.description,
        trigger: data.trigger,
        conditions: data.conditions,
        actions: data.actions,
        enabled: data.enabled,
        version,
        updatedAt: new Date(),
      })
      .where(eq(schema.automationRules.id, subjectId))
      .returning({ id: schema.automationRules.id });
    return updated.length > 0;
  },
};

const numberingRuleSpec: ConfigSubjectSpec = {
  label: "编号规则",
  configurePermission: "numbering.configure",
  applyRevision: async (tx, subjectId, snapshot, version) => {
    const data = parseSnapshotOrThrow("numbering_rule", numberingRuleSnapshotSchema, snapshot);
    const updated = await tx
      .update(schema.numberingRules)
      .set({
        label: data.label,
        prefix: data.prefix,
        dateFormat: data.dateFormat,
        padding: data.padding,
        active: data.active,
        version,
        updatedAt: new Date(),
      })
      .where(eq(schema.numberingRules.id, subjectId))
      .returning({ id: schema.numberingRules.id });
    return updated.length > 0;
  },
};

// workflow / approval：本切片没有定义改写路径，行内容恒等于 v1，回滚无意义
// （409 rollback_unsupported）；快照照记（创建即第一版事实），史与差异可读。
const workflowTemplateSpec: ConfigSubjectSpec = {
  label: "流程模板",
  configurePermission: "workflow.configure",
};

const approvalConfigSpec: ConfigSubjectSpec = {
  label: "审批线",
  configurePermission: "approval.configure",
};

// 模块装载时注册（生产路径：app.ts 的 side-effect import；测试注入夹具族走
// registerConfigSubject 同一条接缝）
registerConfigSubject("workflow_template", workflowTemplateSpec);
registerConfigSubject("approval_config", approvalConfigSpec);
registerConfigSubject("custom_field_def", customFieldDefSpec);
registerConfigSubject("automation_rule", automationRuleSpec);
registerConfigSubject("numbering_rule", numberingRuleSpec);
