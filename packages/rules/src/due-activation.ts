import { and, asc, eq, lte, sql } from "drizzle-orm";
import { schema, type Db } from "@ally/db";
import { nextConfigVersion, recordConfigRevision } from "./ledger.ts";

/**
 * 规则注册表·定时生效前滚内核（#233）。
 *
 * 从 apps/api/rules/service.ts 下沉（cron 接线切片）：worker 侧的
 * rules-due-activation 任务（apps/worker/src/rules/due-activation.ts）到点调用，
 * worker 不跨 app 依赖，内核随消费域一起进共享包（automations 内核居
 * packages/automations 同一先例）。apps/api 的改值面（changeRuleValue：zod 形状、
 * 编译探针、改权裁决、调度时刻审计）留在 api——那些是 HTTP 面的职责。
 *
 * 职责切分（切片裁决）：内核 owns 事务——SELECT FOR UPDATE 认领 → 行更新 + 台账
 * 记一版 source='scheduled' 必须原子（记账协议见 ledger.ts）。提交后的审计
 * （rules.scheduled_change_applied）归投递层（worker job）：审计本来就写在事务外
 * （崩溃窗口与内核自带审计时相同），job 逐条写、job 测试钉「前滚了 ⇒ 有审计行，
 * actor = 调度者」——为此内核返回富结果（from/to/rationale/version/scheduledById），
 * 投递层不复算任何字段。
 */

/** 到点前滚的一条结果：台账与审计（由 job 落）共用的全部事实 */
export interface DueActivation {
  key: string;
  ruleId: string;
  effectiveAt: Date;
  /** 调度者（审计 actor；行上 FK on delete set null，历史调度可能是 null） */
  scheduledById: string | null;
  from: unknown;
  to: unknown;
  rationale: { refs: string[]; note?: string };
  version: number;
}

/**
 * 把到点的待生效变更前滚为生效值：每条变更一个事务（SELECT FOR UPDATE 认领 →
 * 行更新 + 台账记一版 source='scheduled'）。并发扫描者靠行锁串行化：已被并发者
 * 处理、或待生效时间被改后不再到期，即跳过。无到期变更 = 空数组。
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
      applied.push({
        key: outcome.key,
        ruleId: outcome.ruleId,
        scheduledById: outcome.scheduledById,
        from: outcome.from,
        to: outcome.to,
        rationale: outcome.rationale,
        effectiveAt: outcome.effectiveAt,
        version: outcome.version,
      });
    }
  }
  return applied;
}
