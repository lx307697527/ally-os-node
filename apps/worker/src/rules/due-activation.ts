import { schema, type Db } from "@ally/db";
import { applyDueRuleChanges } from "@ally/rules";
import type { JobDefinition } from "../jobs/index.ts";

/**
 * 规则定时生效任务（#233 切片：docs/rules.md「定时生效的 cron 接线」）。
 *
 * 每分钟把到点的待生效变更前滚为生效值（内核 applyDueRuleChanges，居
 * packages/rules——worker 不跨 app 依赖，内核随本切片下沉共享包）。语义是机械
 * 前滚：改值面（形状、改权、enableBy 门、调度审计）在调度时刻已经裁决过，这里
 * 只负责「到点就生效」，下一轮扫描本身就是兜底（worker 错过一分钟，下一分钟把
 * 同一批到期变更补上前滚，漏扫不丢变更）。
 *
 * 审计归属（切片裁决）：`rules.scheduled_change_applied` 由本任务在提交后逐条落
 * （内核返回富结果，这里不复算字段）——前滚事实在台账（source='scheduled'），
 * 「谁在什么时候定的」由审计携带（actor = 调度者）。插入与 apps/api 的
 * recordAudit 同形（worker 不跨 app 依赖，schema 直插，同 reminder.ts 纪律）。
 * 已知窗口与内核自带审计时相同：前滚提交后、审计落行前进程死掉，该条审计丢失
 * （重试时变更已不再到期）——台账仍是完整事实，审计缺「调度者」一行，可由台账
 * changedById 补答。
 */

export const RULES_DUE_ACTIVATION_JOB = "rules-due-activation";

export interface DueActivationServices {
  db: Db;
}

export interface DueActivationRunSummary {
  /** 本轮前滚的变更数 */
  applied: number;
  /** 按生效顺序的规则 key（日志与测试断言面） */
  keys: string[];
}

export async function runRulesDueActivationScan(
  services: DueActivationServices,
): Promise<DueActivationRunSummary> {
  const applied = await applyDueRuleChanges(services.db, { now: new Date() });
  for (const act of applied) {
    await services.db.insert(schema.auditEvents).values({
      actor: act.scheduledById,
      action: "rules.scheduled_change_applied",
      target: act.ruleId,
      detail: {
        key: act.key,
        from: act.from,
        to: act.to,
        effectiveAt: act.effectiveAt.toISOString(),
        rationale: act.rationale,
        version: act.version,
      },
    });
  }
  return { applied: applied.length, keys: applied.map((a) => a.key) };
}

export function dueActivationJob(services: DueActivationServices): JobDefinition {
  return {
    // 每分钟（与 automations 的两个扫描同锚）：定时的治理变更按调度时刻生效，
    // 粒度到分钟足够（调度面的最小单位是「某一天」）；registry_rules 当前是
    // 几十行的小表，逐分钟顺序扫描无害，索引随表长大再裁（与 reminder 的
    // value IS NULL 扫描同一取舍）
    name: RULES_DUE_ACTIVATION_JOB,
    cron: "* * * * *",
    queue: { retryLimit: 1, retryDelay: 30, expireInSeconds: 300 },
    handler: async (_data, { logger }) => {
      const summary = await runRulesDueActivationScan(services);
      // 安静分钟不进日志：每分钟一行的「applied: 0」是把信号埋进噪声
      if (summary.applied > 0) {
        logger.info(summary, "rules due activation finished");
      }
    },
  };
}
