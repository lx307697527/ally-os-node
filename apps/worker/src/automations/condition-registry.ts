import { and, eq } from "drizzle-orm";
import {
  CONDITION_OPS,
  conditionValueFitsOp,
  subjectIdFromTarget,
  valueSatisfiesOp,
  type AutomationEventContext,
  type ConditionBlockEvaluator,
} from "@ally/automations";
import { z } from "zod";
import { schema, type Db } from "@ally/db";

/**
 * 条件积木注册表（#224 切片 7）。
 *
 * 条件积木回答「事件语境 JSON 里没有的事实」：自定义字段的值住在
 * custom_field_values（另一张表）、跨对象断言要查属主行——这些谓词需要数据库
 * 访问与领域知识，注定进不了 @ally/automations 的纯求值。与 workflow 积木
 * （api 的 workflow/blocks.ts）、due 锚点、可写字段（field-registry.ts）同一
 * 裁法：内核提供形状与求值接缝，积木由属主域切片在模块装载时注册，测试用同一
 * 条接缝注入夹具积木。
 *
 * fail closed 的分寸：积木是 worker 侧的，保存面（API）看不到注册表——未注册
 * 的积木名**存得进、求值必败并告警**（与 due 未注册锚点同一裁决）。求值不了
 * （未注册、配置坏、行解析不了）在 evaluator 接缝里收成 { passed: false,
 * error }：扫描不停摆、run 行 skipped、失败原因落在逐条件结果里随 runs 可查，
 * 扫描器再对带 error 的行打告警日志。「条件没满足」与「条件没法求值」在
 * runs 里是两种答案，规则读者分得清。
 */

/** 积木执行语境：连接由扫描器注入，积木不自己找；target 是触发语境的行引用 */
export interface ConditionBlockContext {
  db: Db;
  /** event 触发 = 审计 target 裸行 id；due 触发 = `subjectType:subjectId` 合成 */
  target: string | null;
  /** 完整事件语境（action/target/actor/detail），路径条件的同类 */
  event: AutomationEventContext;
  /** 规则 JSON 里该积木引用的 config（形状由积木自己校验，注册表不解读） */
  config: unknown;
}

/**
 * 返回 false = 条件不满足（正常裁决，不告警）；抛错 = 求值不了（配置坏、对象
 * 配错、字段不存在——这是规则作者的错，必须有人看见）。
 */
export type ConditionBlock = (ctx: ConditionBlockContext) => Promise<boolean>;

const CONDITION_BLOCKS: Record<string, ConditionBlock> = {};

/** 属主域切片在模块装载时注册；测试用同一条接缝注入夹具积木 */
export function registerConditionBlock(name: string, block: ConditionBlock): void {
  CONDITION_BLOCKS[name] = block;
}

export function conditionBlockSpec(name: string): ConditionBlock | undefined {
  return CONDITION_BLOCKS[name];
}

/** 扫描器求值用的接缝实现：注册表查询 + 抛错收编，未注册 fail closed */
export function blockConditionEvaluator(deps: { db: Db }): ConditionBlockEvaluator {
  return async (ref, ctx) => {
    const block = conditionBlockSpec(ref.block);
    if (block === undefined) {
      return { passed: false, error: `condition block is not registered: ${ref.block}` };
    }
    try {
      return {
        passed: await block({ db: deps.db, target: ctx.target, event: ctx, config: ref.config }),
      };
    } catch (err) {
      return {
        passed: false,
        error: err instanceof Error ? err.message : "condition block failed",
      };
    }
  };
}

// ── 第一个成员：custom_field（触发目标行的自定义字段值）──────────────────────
//
// 「自定义字段可在自动化规则中使用」是 #222 立项时的承诺（值表注释同文）：值住
// 在 custom_field_values（按 subjectType + subjectId + fieldDefId 一行），路径
// 条件够不着。本积木把「触发语境指向的那一行」当作 subject（event 触发的审计
// target 是裸行 id，due 触发的合成 target 自带前缀，subjectIdFromTarget 对
// 前缀不匹配 fail loud），按字段键查出值再走与路径条件同一份 op 裁决。

const customFieldConditionConfig = z
  .object({
    subjectType: z.string().trim().min(1).max(100),
    fieldKey: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9_]*$/, "field keys must be lower_snake_case"),
    op: z.enum(CONDITION_OPS),
    value: z.unknown().optional(),
  })
  .refine((c) => conditionValueFitsOp(c.op, "value" in c, c.value), {
    message: "value is required by op (eq/ne: any JSON value, in: 1..100 items, exists: boolean)",
  });

const customFieldConditionBlock: ConditionBlock = async (ctx) => {
  const parsed = customFieldConditionConfig.safeParse(ctx.config);
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? "invalid config";
    throw new Error(`custom_field config is invalid: ${message}`);
  }
  const config = parsed.data;
  const subject = subjectIdFromTarget(ctx.target, config.subjectType);
  if (!subject.ok) {
    throw new Error(`custom_field cannot resolve the subject row: ${subject.reason}`);
  }
  // 定义行存在即可（active 与否不拦）：停用冻结的是表单写入面，值与引用它的
  // 规则还在——规则作者明确点名了这条字段；定义行整个不在才是配置错误
  const defs = await ctx.db
    .select({ id: schema.customFieldDefs.id })
    .from(schema.customFieldDefs)
    .where(
      and(
        eq(schema.customFieldDefs.subjectType, config.subjectType),
        eq(schema.customFieldDefs.fieldKey, config.fieldKey),
      ),
    )
    .limit(1);
  const def = defs[0];
  if (def === undefined) {
    throw new Error(`custom field is not configured: ${config.subjectType}.${config.fieldKey}`);
  }
  const rows = await ctx.db
    .select({ value: schema.customFieldValues.value })
    .from(schema.customFieldValues)
    .where(
      and(
        eq(schema.customFieldValues.subjectType, config.subjectType),
        eq(schema.customFieldValues.subjectId, subject.subjectId),
        eq(schema.customFieldValues.fieldDefId, def.id),
      ),
    )
    .limit(1);
  const row = rows[0];
  // 没写过值 = 解析不到（与路径条件的「detail 缺键」同一档，eq/in/ne 不满足、
  // exists 表达「必须有/没有」）；值列 NOT NULL，行在场即有 JSON 值
  const resolved = row === undefined ? undefined : row.value;
  return valueSatisfiesOp(config.op, resolved, config.value);
};

registerConditionBlock("custom_field", customFieldConditionBlock);
