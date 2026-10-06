import { and, asc, eq, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { schema, type Db } from "@ally/db";
import { recordAudit } from "../audit/audit-log.ts";
import type { SubjectWriteDenial } from "../config-versions/registry.ts";
import { jsonEqual, nextConfigVersion, recordConfigRevision } from "../config-versions/service.ts";
import {
  assertDecisionTableCompiles,
  decisionTableValueSchema,
} from "./decision-table-schema.ts";

/**
 * 规则注册表内核（#233 切片 1：裁决即配置）。
 *
 * 注册表是配置工作室（#220~#226）的核心数据面：所有模块从这里读规则。本内核
 * 无 HTTP 语义（路由层在 routes/rules.ts），与 workflow 的 due scan 同一裁法：
 * - 读：getRule（消费方自带 zod 收口期望形状——消费方证明自己知道规则长什么样，
 *   RULE-007）/ isRuleEnabled；值未设（「待填」）或键不存在一律抛错，消费方
 *   fail closed，不猜默认值。
 * - 写：changeRuleValue（立即或定时；改值必填新依据；谁能改按行的角色数组，
 *   owner 恒可——R-16-5 的 owner 直通同源）；applyDueRuleChanges 到点前滚
 *   （定时变更不在调度时刻入台账，激活时刻才记版——台账记录的是「生效了什么」，
 *   调度意图由审计与行上字段承载）。
 * - 观测：recordRuleOutcome 累加运行数据（§4.8 触发/例外/越过），无 HTTP 面
 *   ——生产方（门槛、自动化、流程）在各自域内调用；周报属报表域（#225）。
 * - 例外：requestGateException——业务门槛例外的唯一合法通道（§4.7）：开关
 *   （gates.business_exception_enabled，默认关）打开后，仅 owner 可带原因一次
 *   性越过；质量门槛在任何开关下都不可越过（§4.7「质量门槛不适用」，代码强制，
 *   测试钉住）。
 */

export class RuleNotFoundError extends Error {
  constructor(key: string) {
    super(`rules: rule "${key}" does not exist`);
    this.name = "RuleNotFoundError";
  }
}

export class RuleNotSetError extends Error {
  constructor(key: string) {
    super(`rules: rule "${key}" is registered but its value is unset (pending fill-in)`);
    this.name = "RuleNotSetError";
  }
}

/** 消费方期望形状与存储值不符：写入面校验被绕过或跨类型漂移，当场炸给人看 */
export class RuleShapeError extends Error {
  constructor(key: string, issues: string) {
    super(`rules: value of "${key}" does not match the expected shape: ${issues}`);
    this.name = "RuleShapeError";
  }
}

export class InvalidRuleValueError extends Error {
  readonly issues: z.ZodError["issues"];
  constructor(key: string, issues: z.ZodError["issues"]) {
    super(`rules: invalid value for "${key}": ${issues.map((i) => i.message).join("; ")}`);
    this.name = "InvalidRuleValueError";
    this.issues = issues;
  }
}

export class ScheduledTimeInPastError extends Error {
  constructor(key: string) {
    super(`rules: effective time for "${key}" must be in the future`);
    this.name = "ScheduledTimeInPastError";
  }
}

/** 改权不足（路由层转 403；拒绝体与 config-versions 的 403 同构） */
export class RuleChangeForbiddenError extends Error {
  readonly denial: SubjectWriteDenial;
  constructor(key: string, denial: SubjectWriteDenial) {
    super(`rules: actor is not allowed to change "${key}"`);
    this.name = "RuleChangeForbiddenError";
    this.denial = denial;
  }
}

export class GateUnbypassableError extends Error {
  constructor(gate: string) {
    super(`rules: gate "${gate}" is a quality gate and can never be bypassed (R-15-4)`);
    this.name = "GateUnbypassableError";
  }
}

export class GateExceptionDisabledError extends Error {
  constructor() {
    super('rules: business gate exception is disabled (switch "gates.business_exception_enabled")');
    this.name = "GateExceptionDisabledError";
  }
}

export class GateExceptionForbiddenError extends Error {
  constructor() {
    super("rules: business gate exception can only be exercised by the owner");
    this.name = "GateExceptionForbiddenError";
  }
}

export class GateExceptionReasonRequiredError extends Error {
  constructor() {
    super("rules: a business gate exception requires a non-empty reason");
    this.name = "GateExceptionReasonRequiredError";
  }
}

// ── 值形状（按 valueType 收口；与 seeds 的类型一一对应）────────────────────────
const ruleValueSchemas = {
  number: z.number(),
  text: z.string().min(1).max(2000),
  boolean: z.boolean(),
  string_list: z.array(z.string().min(1).max(500)).min(1).max(200),
  number_list: z.array(z.number()).min(1).max(200),
  // json：结构由消费域收口（法规风险清单、费率表……），注册表只保证是对象
  json: z.record(z.string(), z.unknown()),
  // 决策表（#233 §4.9）：形状在这里收口，表达式语法错由写面编译探针另拒
  // （changeRuleValue 里的 assertDecisionTableCompiles——ZEN 对坏单元格是静默
  // 不命中，不校验 = 一张带错字的表「看着改好了、实际全部不命中」）
  decision_table: decisionTableValueSchema,
} as const;

export type RuleRow = typeof schema.registryRules.$inferSelect;

export type RuleOutcome = "triggered" | "exception" | "override";

/** 消费方的类型化读口：键不存在 / 值未设 / 形状不符都抛错，绝不猜默认值 */
export async function getRule<T>(
  db: Pick<Db, "select">,
  key: string,
  valueSchema: z.ZodType<T>,
): Promise<T> {
  const row = await getRuleRow(db, key);
  if (row === undefined) throw new RuleNotFoundError(key);
  if (row.value === null) throw new RuleNotSetError(key);
  const parsed = valueSchema.safeParse(row.value);
  if (!parsed.success) throw new RuleShapeError(key, parsed.error.message);
  return parsed.data;
}

/** 开关读口：仅 boolean 规则；严格 true = 开，false 都 = 关（关着时相关数据照样
 * 记录是消费方的纪律，内核不提供「关 = 停止记录」的开关语义） */
export async function isRuleEnabled(db: Pick<Db, "select">, key: string): Promise<boolean> {
  return getRule(db, key, ruleValueSchemas.boolean);
}

export async function getRuleRow(db: Pick<Db, "select">, key: string): Promise<RuleRow | undefined> {
  const rows = await db
    .select()
    .from(schema.registryRules)
    .where(eq(schema.registryRules.key, key))
    .limit(1);
  return rows[0];
}

export async function listRules(db: Pick<Db, "select">): Promise<RuleRow[]> {
  return db.select().from(schema.registryRules).orderBy(asc(schema.registryRules.key));
}

// ── 谁能改（§4.2）：owner 恒可（R-16-5 owner 直通同源），其余按行上角色数组 ──────
export function effectiveChangeableBy(rule: Pick<RuleRow, "changeableBy">): string[] {
  return [...new Set([...rule.changeableBy, "owner"])];
}

/** 开关的「启用」（关→开）额外门：enableBy 非空时启用需要其中角色（或 owner）；
 * 关闭与普通修改同权 */
export function effectiveEnableBy(rule: Pick<RuleRow, "enableBy">): string[] | null {
  if (rule.enableBy === null) return null;
  return [...new Set([...rule.enableBy, "owner"])];
}

interface RuleAuthzLike {
  roles: readonly string[];
}

/** 改权裁决 → 拒绝体（与 config-versions 的 403 同构）。enabling = 这次变更会
 * 把开关从关变开（立即或定时同一标准——定时启用同样过 enableBy 门） */
export function authorizeRuleChange(
  authz: RuleAuthzLike,
  rule: Pick<RuleRow, "category" | "value" | "changeableBy" | "enableBy">,
  targetValue: unknown,
): SubjectWriteDenial | undefined {
  const changeableBy = effectiveChangeableBy(rule);
  if (!authz.roles.some((role) => changeableBy.includes(role))) {
    return { error: "forbidden", code: "role_required", roles: changeableBy };
  }
  const enabling = rule.category === "switch" && targetValue === true && rule.value !== true;
  if (enabling) {
    const enableBy = effectiveEnableBy(rule);
    if (enableBy !== null && !authz.roles.some((role) => enableBy.includes(role))) {
      return { error: "forbidden", code: "role_required", roles: enableBy };
    }
  }
  return undefined;
}

/** config-versions 逐主体写面钩子的规则实现（回滚/草稿/发布 = 改那行配置，与
 * PATCH 面同扇）。回滚目标值的启用语义不按 enableBy 重裁：回滚恢复的是台账里的
 * 历史开启态，所需的角色与当时的修改者同权（changeableBy），启用经审计可查。 */
export function ruleWriteDenial(
  authz: RuleAuthzLike,
  rule: Pick<RuleRow, "changeableBy">,
): SubjectWriteDenial | undefined {
  const changeableBy = effectiveChangeableBy(rule);
  if (!authz.roles.some((role) => changeableBy.includes(role))) {
    return { error: "forbidden", code: "role_required", roles: changeableBy };
  }
  return undefined;
}

// ── 改值（立即 / 定时）────────────────────────────────────────────────────────
export interface ChangeRationale {
  refs: string[];
  note?: string;
}

export interface ChangeRuleValueInput {
  key: string;
  actorId: string;
  value: unknown;
  rationale: ChangeRationale;
  /** 缺省 = 立即生效；未来时刻 = 定时（先落在行上，到点由 applyDueRuleChanges 前滚） */
  effectiveAt?: Date;
}

export type ChangeRuleValueResult =
  | { mode: "immediate"; changed: true; version: number }
  | { mode: "immediate"; changed: false }
  | { mode: "scheduled"; changed: true; effectiveAt: Date }
  | { mode: "scheduled"; changed: false; effectiveAt: Date };

/**
 * 改一条规则的值。校验链：键存在 → 值过 valueType 形状（开关不接受 null——开关
 * 只有开/关两态；决策表另过编译探针，语法错的表进不来）→ 改权 → 实效变更才记版
 * 与审计。无实效变更不记账（与 #226 台账
 * 协议同一纪律）；立即变更不碰已有的待生效变更（先定下月改 8%、今天急改 9% 是
 * 两个都成立的意图）。定时变更的启用语义在调度时刻裁决（enableBy 门），不在
 * 激活时刻重裁——调度者过门后，激活是机械前滚。
 */
export async function changeRuleValue(
  db: Db,
  authz: RuleAuthzLike,
  input: ChangeRuleValueInput,
): Promise<ChangeRuleValueResult> {
  const rule = await getRuleRow(db, input.key);
  if (rule === undefined) throw new RuleNotFoundError(input.key);
  const valueSchema = ruleValueSchemas[rule.valueType];
  // 开关只有开/关两态（boolean 不接受 null）；其余类型 null = 清回「待填」
  const effectiveSchema = rule.category === "switch" ? valueSchema : valueSchema.nullable();
  const parsed = effectiveSchema.safeParse(input.value);
  if (!parsed.success) throw new InvalidRuleValueError(input.key, parsed.error.issues);
  // 决策表另有编译面：形状过了 zod 还要逐单元格可解析（语法错会让 ZEN 静默不
  // 命中——表必须「可执行」才配进注册表；立即与定时同一扇门，同一校验点）
  if (rule.valueType === "decision_table" && input.value !== null) {
    await assertDecisionTableCompiles(input.value);
  }
  const denial = authorizeRuleChange(authz, rule, input.value);
  if (denial !== undefined) throw new RuleChangeForbiddenError(input.key, denial);

  if (input.effectiveAt !== undefined) {
    if (input.effectiveAt.getTime() <= Date.now()) {
      throw new ScheduledTimeInPastError(input.key);
    }
    const samePending =
      rule.scheduledEffectiveAt !== null &&
      rule.scheduledEffectiveAt.getTime() === input.effectiveAt.getTime() &&
      jsonEqual(rule.scheduledValue ?? null, input.value ?? null);
    if (samePending) {
      return { mode: "scheduled", changed: false, effectiveAt: input.effectiveAt };
    }
    await db
      .update(schema.registryRules)
      .set({
        scheduledValue: input.value,
        scheduledEffectiveAt: input.effectiveAt,
        scheduledRationale: {
          refs: input.rationale.refs,
          ...(input.rationale.note !== undefined ? { note: input.rationale.note } : {}),
        },
        scheduledById: input.actorId,
        updatedAt: new Date(),
      })
      .where(eq(schema.registryRules.id, rule.id));
    await recordAudit(db, {
      actor: input.actorId,
      action: "rules.change_scheduled",
      target: rule.id,
      detail: {
        key: rule.key,
        scheduledValue: input.value ?? null,
        effectiveAt: input.effectiveAt.toISOString(),
        rationale: input.rationale,
      },
    });
    return { mode: "scheduled", changed: true, effectiveAt: input.effectiveAt };
  }

  if (jsonEqual(rule.value ?? null, input.value ?? null)) {
    return { mode: "immediate", changed: false };
  }
  const version = await db.transaction(async (tx) => {
    const nextVersion = await nextConfigVersion(tx, "registry_rule", rule.id);
    await tx
      .update(schema.registryRules)
      .set({
        value: input.value,
        adjudicationRefs: input.rationale.refs,
        version: nextVersion,
        updatedAt: new Date(),
      })
      .where(eq(schema.registryRules.id, rule.id));
    await recordConfigRevision(tx, {
      subjectType: "registry_rule",
      subjectId: rule.id,
      version: nextVersion,
      actorId: input.actorId,
      snapshot: {
        label: rule.label,
        category: rule.category,
        valueType: rule.valueType,
        value: input.value ?? null,
        changeableBy: rule.changeableBy,
        enableBy: rule.enableBy,
        adjudicationRefs: input.rationale.refs,
        riskFlag: rule.riskFlag,
        riskNote: rule.riskNote,
      },
      changes: {
        value: { from: rule.value ?? null, to: input.value ?? null },
        adjudicationRefs: { from: rule.adjudicationRefs, to: input.rationale.refs },
      },
      source: "updated",
    });
    return nextVersion;
  });
  await recordAudit(db, {
    actor: input.actorId,
    action: "rules.value_changed",
    target: rule.id,
    detail: {
      key: rule.key,
      from: rule.value ?? null,
      to: input.value ?? null,
      rationale: input.rationale,
      version,
    },
  });
  return { mode: "immediate", changed: true, version };
}

// ── 定时生效前滚（与 workflow 的 due scan 同裁法：内核纯函数，cron 接线归 worker 域）──
export interface DueActivation {
  key: string;
  ruleId: string;
  effectiveAt: Date;
}

/**
 * 把到点的待生效变更前滚为生效值：每条变更一个事务（SELECT FOR UPDATE 认领 →
 * 行更新 + 台账记一版 source='scheduled'），审计在提交后写（调度者为 actor，
 * detail 带调度信息——「生效了什么」在台账，「谁在什么时候定的」在两处都有）。
 * 并发扫描者靠行锁串行化：拿不到锁或已非到期即跳过。无到期变更 = 空数组。
 */
export async function applyDueRuleChanges(
  db: Db,
  opts: { now: Date; limit?: number },
): Promise<DueActivation[]> {
  const due = await db
    .select({ id: schema.registryRules.id })
    .from(schema.registryRules)
    .where(
      and(
        sql`${schema.registryRules.scheduledEffectiveAt} is not null`,
        lte(schema.registryRules.scheduledEffectiveAt, opts.now),
      ),
    )
    .orderBy(asc(schema.registryRules.scheduledEffectiveAt))
    .limit(opts.limit ?? 100);
  const applied: DueActivation[] = [];
  for (const candidate of due) {
    const outcome = await db.transaction(async (tx) => {
      const locked = await tx
        .select()
        .from(schema.registryRules)
        .where(eq(schema.registryRules.id, candidate.id))
        .for("update")
        .limit(1);
      const rule = locked[0];
      const dueAt = rule?.scheduledEffectiveAt ?? null;
      if (rule === undefined || dueAt === null || dueAt.getTime() > opts.now.getTime()) {
        return null; // 已被并发者处理，或待生效时间被改后不再到期
      }
      const rationale = rule.scheduledRationale ?? { refs: rule.adjudicationRefs };
      const effectiveAt: Date = dueAt;
      const version = await nextConfigVersion(tx, "registry_rule", rule.id);
      await tx
        .update(schema.registryRules)
        .set({
          value: rule.scheduledValue,
          adjudicationRefs: rationale.refs,
          scheduledValue: null,
          scheduledEffectiveAt: null,
          scheduledRationale: null,
          scheduledById: null,
          version,
          updatedAt: new Date(),
        })
        .where(eq(schema.registryRules.id, rule.id));
      await recordConfigRevision(tx, {
        subjectType: "registry_rule",
        subjectId: rule.id,
        version,
        actorId: rule.scheduledById,
        snapshot: {
          label: rule.label,
          category: rule.category,
          valueType: rule.valueType,
          value: rule.scheduledValue ?? null,
          changeableBy: rule.changeableBy,
          enableBy: rule.enableBy,
          adjudicationRefs: rationale.refs,
          riskFlag: rule.riskFlag,
          riskNote: rule.riskNote,
        },
        changes: {
          value: { from: rule.value ?? null, to: rule.scheduledValue ?? null },
          adjudicationRefs: { from: rule.adjudicationRefs, to: rationale.refs },
        },
        source: "scheduled",
      });
      return {
        key: rule.key,
        ruleId: rule.id,
        scheduledById: rule.scheduledById,
        from: rule.value ?? null,
        to: rule.scheduledValue ?? null,
        rationale,
        effectiveAt,
        version,
      };
    });
    if (outcome !== null) {
      await recordAudit(db, {
        actor: outcome.scheduledById,
        action: "rules.scheduled_change_applied",
        target: outcome.ruleId,
        detail: {
          key: outcome.key,
          from: outcome.from,
          to: outcome.to,
          effectiveAt: outcome.effectiveAt.toISOString(),
          rationale: outcome.rationale,
          version: outcome.version,
        },
      });
      applied.push({
        key: outcome.key,
        ruleId: outcome.ruleId,
        effectiveAt: outcome.effectiveAt,
      });
    }
  }
  return applied;
}

// ── 运行数据（§4.8）：触发 / 例外 / 越过计数；周报属 #225 ───────────────────────
export async function recordRuleOutcome(
  db: Pick<Db, "update">,
  key: string,
  outcome: RuleOutcome,
): Promise<void> {
  const patch =
    outcome === "triggered"
      ? { triggerCount: sql`${schema.registryRules.triggerCount} + 1` }
      : outcome === "exception"
        ? { exceptionCount: sql`${schema.registryRules.exceptionCount} + 1` }
        : { overrideCount: sql`${schema.registryRules.overrideCount} + 1` };
  const updated = await db
    .update(schema.registryRules)
    .set(patch)
    .where(eq(schema.registryRules.key, key))
    .returning({ id: schema.registryRules.id });
  if (updated.length === 0) throw new RuleNotFoundError(key);
}

// ── 业务门槛例外（§4.7）：唯一合法的越门通道 ────────────────────────────────────
export const BUSINESS_GATE_EXCEPTION_RULE_KEY = "gates.business_exception_enabled";

export interface GateExceptionInput {
  actorId: string;
  roles: readonly string[];
  /** 要越过的门槛种类；quality = 质量门槛 */
  kind: "business" | "quality";
  gate: string;
  reason: string;
  subjectType?: string;
  subjectId?: string;
}

/**
 * 越过一道流程门槛。质量门槛无条件拒绝（§4.7「质量门槛不适用」：质量放行只按
 * R-15-4，owner 也不例外——这是硬底线，不是开关）。业务门槛要求：例外开关已
 * 打开（默认关）+ 仅 owner + 非空原因；每次越过写审计并把该开关的 override
 * 计数 +1（进周报）。消费域在各自门槛判定处调用本函数，越过与否的语义（放行
 * 推进）由消费域落地。
 */
export async function requestGateException(db: Db, input: GateExceptionInput): Promise<void> {
  if (input.kind === "quality") throw new GateUnbypassableError(input.gate);
  if (input.reason.trim().length === 0) throw new GateExceptionReasonRequiredError();
  if (!input.roles.includes("owner")) throw new GateExceptionForbiddenError();
  const enabled = await isRuleEnabled(db, BUSINESS_GATE_EXCEPTION_RULE_KEY);
  if (!enabled) throw new GateExceptionDisabledError();
  await recordRuleOutcome(db, BUSINESS_GATE_EXCEPTION_RULE_KEY, "override");
  await recordAudit(db, {
    actor: input.actorId,
    action: "rules.gate_exception",
    target: input.subjectId ?? null,
    detail: {
      gate: input.gate,
      reason: input.reason,
      ...(input.subjectType !== undefined ? { subjectType: input.subjectType } : {}),
      ruleKey: BUSINESS_GATE_EXCEPTION_RULE_KEY,
    },
  });
}
