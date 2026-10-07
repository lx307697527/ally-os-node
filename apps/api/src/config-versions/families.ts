import { eq } from "drizzle-orm";
import { z } from "zod";
import { schema } from "@ally/db";
import { ruleSpecSchema } from "@ally/automations";
import { approvalLevelsSchema } from "../approval/service.ts";
import { NUMBERING_DATE_FORMATS } from "../numbering/service.ts";
import { roleSchema } from "../authz/permissions.ts";
import { ruleWriteDenial } from "../rules/service.ts";
import { actionBlock, conditionBlock } from "../workflow/blocks.ts";
import { parseWorkflowTemplate, referencedBlocks } from "../workflow/engine.ts";
import { registerConfigSubject, type ConfigSubjectSpec } from "./registry.ts";

/**
 * 六族配置的台账契约（#226 切片 1；第六族 registry_rule 随 #233 进场）：快照
 * 形状、回滚落列、注册；切片 2 加草稿内容契约（draftContentSchema，draft →
 * publish 的保存面校验）。
 *
 * 本文件是「快照长什么样」的唯一事实来源：配置面写入时用这里的 snapshotXxx
 * 建快照（0019 迁移的存量补账 SQL 与这些形状逐一同构），回滚时用同一形状的
 * zod 收口后落列。快照只含用户可编辑内容——id/键/时间戳/审计元数据不在内：
 * 键是身份不是内容（custom_field_defs 的 fieldKey 唯一、停用后不复用，回滚一
 * 个「别的键」是语义错误），numbering 的 startNumber 刻意不可恢复（对已在发
 * 的系列无效果，同 PATCH 面的拒绝理由）。
 *
 * 回滚能力随内容改写路径走：六族现都带就地改写端点与 applyRevision（approval
 * 的 PATCH 随 #221 配置 UI 切片进场，workflow_template 的定义改写面随
 * #220/#226 进场）。没有改写路径的族（夹具、未来新族未接前）注册时不带
 * applyRevision，回滚端点对其答 409 rollback_unsupported。
 *
 * 草稿内容契约（切片 2 起，逐族进场）只随 applyRevision 走：草稿校验对齐各族
 * 配置面的**业务**校验（strict + approvalLevelsSchema + select 选项规则 +
 * ruleSpecSchema），存进去的必须是「发布后能直接生效」的内容——发布面不做比
 * 保存面更弱的第二次放行。现覆盖五族（automation_rule / custom_field_def /
 * numbering_rule / workflow_template / approval_config）；registry_rule 刻意
 * 不带——它的「先试后上」由待生效变更（定时生效）承担，草稿会长出第二套同一
 * 机制（#233），草稿面对它答 409 publish_unsupported。
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

// 草稿内容 = 快照同一形状（整体替换，四键必填）；definition 过与 POST/PATCH 面
// 同一道四门校验（zod 结构 → 拓扑语义 → XState 可达性 → 积木存在性）——发布后
// 要能直接被实例启动/推进读，引用不存在积木的定义不能借草稿面绕过保存面的拒绝
export const workflowTemplateDraftContentSchema = z
  .object({
    productType: z.string().trim().min(1).max(64).nullable(),
    isDefault: z.boolean(),
    active: z.boolean(),
    definition: z.unknown(),
  })
  .strict()
  .superRefine((content, ctx) => {
    const parsed = parseWorkflowTemplate(content.definition);
    if (!parsed.ok) {
      ctx.addIssue({ code: "custom", message: parsed.error });
      return;
    }
    const blocks = referencedBlocks(parsed.template);
    const missing = [
      ...blocks.gates.filter((name) => conditionBlock(name) === undefined),
      ...blocks.actions.filter((name) => actionBlock(name) === undefined),
    ];
    if (missing.length > 0) {
      ctx.addIssue({ code: "custom", message: `unknown blocks: ${missing.join(", ")}` });
    }
  });

// ── 审批线（#221）──────────────────────────────────────────────────────────
export function approvalConfigSnapshot(row: {
  name: string;
  levels: unknown;
  active: boolean;
}): Record<string, unknown> {
  return { name: row.name, levels: row.levels, active: row.active };
}

// 快照收口用保存面同一道 zod（approvalLevelsSchema）:subjectType/configKey 是
// 身份不在快照里（键不复用,回滚「别的键」是语义错误）;PATCH 面落库的 levels
// 已过同 schema,默认值已物化,重解析幂等
const approvalConfigSnapshotSchema = z.object({
  name: z.string().min(1).max(200),
  levels: approvalLevelsSchema,
  active: z.boolean(),
});

// 草稿内容 = 快照同一形状（整体替换，三键必填）；levels 过与 POST/PATCH 面同一道
// approvalLevelsSchema——发布后要能直接被提交面解析成审批路线，语义不合格的
// levels 不能借草稿面绕过保存面的 422；name 与 PATCH 面同一收口（trim）。在飞
// 请求不受发布影响（级别快照在提交时刻），草稿试的是「之后的提交」走的路线。
export const approvalConfigDraftContentSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    levels: approvalLevelsSchema,
    active: z.boolean(),
  })
  .strict();

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

// 草稿内容 = 行内容形状（options 按行规则存：select 是数组、其余类型是 null），
// 校验强度对齐配置写入面：strict + roleSchema + 「select 必须带非空、无重复选项，
// 其余类型不带选项」——不带病入库的同一裁决（值校验的 z.enum 依赖选项存在）
export const customFieldDefDraftContentSchema = z
  .object({
    label: z.string().trim().min(1).max(200),
    fieldType: z.enum(schema.customFieldType.enumValues),
    options: z.array(z.string().trim().min(1).max(100)).max(100).nullable(),
    required: z.boolean(),
    viewableBy: z.array(roleSchema).max(20),
    editableBy: z.array(roleSchema).max(20),
    active: z.boolean(),
  })
  .strict()
  .refine(
    (content) =>
      content.fieldType === "select"
        ? content.options !== null &&
          content.options.length > 0 &&
          new Set(content.options).size === content.options.length
        : content.options === null,
    {
      message:
        "select fields require non-empty unique options; other field types require no options",
    },
  );

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

// 草稿内容与配置面同一业务校验（ruleSpecSchema 的 trigger/conditions/actions）：
// 草稿发布后要直接被 worker 执行，语义不合格的内容不能借草稿面绕过 PATCH 的校验
export const automationRuleDraftContentSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000).nullable(),
    trigger: ruleSpecSchema.shape.trigger,
    conditions: ruleSpecSchema.shape.conditions,
    actions: ruleSpecSchema.shape.actions,
    enabled: z.boolean(),
  })
  .strict();

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

// 草稿内容 = 就地可改的格式字段（同 PATCH 面：起始号不在内容契约里）
export const numberingRuleDraftContentSchema = z
  .object({
    label: z.string().trim().min(1).max(200),
    prefix: z.string().trim().max(16),
    dateFormat: z.enum(NUMBERING_DATE_FORMATS).nullable(),
    padding: z.number().int().min(0).max(10),
    active: z.boolean(),
  })
  .strict();

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
  draftContentSchema: customFieldDefDraftContentSchema,
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
  draftContentSchema: automationRuleDraftContentSchema,
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
  draftContentSchema: numberingRuleDraftContentSchema,
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

// ── 规则注册表（#233）──────────────────────────────────────────────────────
// 键是身份不是内容（消费方按字面量引用），故不在快照里——回滚「别的键」是语义
// 错误，同 custom_field_defs.fieldKey 的裁法。快照含改权数组（changeableBy/
// enableBy 是这份配置的治理内容，回滚要一并恢复）；待生效变更不在快照也不在
// 台账（它不是「当时的现状」），回滚落列时一并清空——回滚后的生效配置就是快照
// 那一份，不存在「回滚了还定时改回去」的暗门。
const registryRuleSnapshotSchema = z.object({
  label: z.string().min(1).max(500),
  category: z.enum(schema.ruleCategory.enumValues),
  valueType: z.enum(schema.ruleValueType.enumValues),
  value: z.unknown(),
  changeableBy: z.array(roleSchema),
  enableBy: z.array(roleSchema).nullable(),
  adjudicationRefs: z.array(z.string().min(1)),
  riskFlag: z.boolean(),
  riskNote: z.string().nullable(),
});

export function registryRuleSnapshot(row: {
  label: string;
  category: (typeof schema.ruleCategory.enumValues)[number];
  valueType: (typeof schema.ruleValueType.enumValues)[number];
  value: unknown;
  changeableBy: string[];
  enableBy: string[] | null;
  adjudicationRefs: string[];
  riskFlag: boolean;
  riskNote: string | null;
}): Record<string, unknown> {
  return {
    label: row.label,
    category: row.category,
    valueType: row.valueType,
    value: row.value,
    changeableBy: row.changeableBy,
    enableBy: row.enableBy,
    adjudicationRefs: row.adjudicationRefs,
    riskFlag: row.riskFlag,
    riskNote: row.riskNote,
  };
}

const registryRuleSpec: ConfigSubjectSpec = {
  label: "规则",
  configurePermission: "rules.configure",
  // 逐主体写面门（#233）：谁能改按行的角色数组（owner 恒可）——族的
  // rules.configure 之外的第二扇门，与 PATCH 面同扇（同一裁决在两个写面各自强制）
  authorizeWrite: async ({ db, authz, subjectId }) => {
    const rows = await db
      .select({ changeableBy: schema.registryRules.changeableBy })
      .from(schema.registryRules)
      .where(eq(schema.registryRules.id, subjectId))
      .limit(1);
    const rule = rows[0];
    if (rule === undefined) return undefined; // 行已不存在 → 让流程走到 404 subject_not_found
    return ruleWriteDenial({ roles: authz.roles }, rule);
  },
  applyRevision: async (tx, subjectId, snapshot, version) => {
    const data = parseSnapshotOrThrow("registry_rule", registryRuleSnapshotSchema, snapshot);
    const updated = await tx
      .update(schema.registryRules)
      .set({
        label: data.label,
        category: data.category,
        valueType: data.valueType,
        value: data.value,
        changeableBy: data.changeableBy,
        enableBy: data.enableBy,
        adjudicationRefs: data.adjudicationRefs,
        riskFlag: data.riskFlag,
        riskNote: data.riskNote,
        scheduledValue: null,
        scheduledEffectiveAt: null,
        scheduledRationale: null,
        scheduledById: null,
        version,
        updatedAt: new Date(),
      })
      .where(eq(schema.registryRules.id, subjectId))
      .returning({ id: schema.registryRules.id });
    return updated.length > 0;
  },
};

// workflow：定义改写面随 #220/#226 进场（PATCH + 草稿发布 + 回滚）；快照回写
// 只做结构收口（四门业务校验在写入面/草稿面已完成，回滚的职责是把台账里的字节
// 原样写回去，同 automation/numbering/approval 的裁法）。
const workflowTemplateSnapshotSchema = z.object({
  productType: z.string().nullable(),
  isDefault: z.boolean(),
  active: z.boolean(),
  definition: z.unknown(),
});

const workflowTemplateSpec: ConfigSubjectSpec = {
  label: "流程模板",
  configurePermission: "workflow.configure",
  draftContentSchema: workflowTemplateDraftContentSchema,
  applyRevision: async (tx, subjectId, snapshot, version) => {
    const data = parseSnapshotOrThrow("workflow_template", workflowTemplateSnapshotSchema, snapshot);
    const updated = await tx
      .update(schema.workflowTemplates)
      .set({
        productType: data.productType,
        isDefault: data.isDefault,
        active: data.active,
        definition: data.definition,
        version,
      })
      .where(eq(schema.workflowTemplates.id, subjectId))
      .returning({ id: schema.workflowTemplates.id });
    return updated.length > 0;
  },
};

const approvalConfigSpec: ConfigSubjectSpec = {
  label: "审批线",
  configurePermission: "approval.configure",
  // 就地改写面随 #221 配置 UI 进场（PATCH + 回滚）:快照回写只做结构收口
  // (levels 的业务校验在保存面已完成,回滚的职责是把台账里的字节原样写回去,
  // 同 automation/numbering 的裁法)
  applyRevision: async (tx, subjectId, snapshot, version) => {
    const data = parseSnapshotOrThrow("approval_config", approvalConfigSnapshotSchema, snapshot);
    const updated = await tx
      .update(schema.approvalConfigs)
      .set({
        name: data.name,
        levels: data.levels,
        active: data.active,
        version,
      })
      .where(eq(schema.approvalConfigs.id, subjectId))
      .returning({ id: schema.approvalConfigs.id });
    return updated.length > 0;
  },
  // 草稿契约随 #226 切片 3 进场：审批线的「先试后上」= 在旧线上离线改一版
  // levels，看得见差异、发布才生效；在飞请求带提交时刻的级别快照，发布只改
  // 之后的提交走的路线
  draftContentSchema: approvalConfigDraftContentSchema,
};

// 模块装载时注册（生产路径：app.ts 的 side-effect import；测试注入夹具族走
// registerConfigSubject 同一条接缝）
registerConfigSubject("workflow_template", workflowTemplateSpec);
registerConfigSubject("approval_config", approvalConfigSpec);
registerConfigSubject("custom_field_def", customFieldDefSpec);
registerConfigSubject("automation_rule", automationRuleSpec);
registerConfigSubject("numbering_rule", numberingRuleSpec);
registerConfigSubject("registry_rule", registryRuleSpec);
