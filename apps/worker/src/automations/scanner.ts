import { and, eq, lt, sql } from "drizzle-orm";
import {
  AUTOMATION_ACTOR_PREFIX,
  evaluateConditions,
  eventMatchesTrigger,
  ruleSpecSchema,
} from "@ally/automations";
import { schema } from "@ally/db";
import type { ActionDeps } from "./actions.ts";

/**
 * automation-scan 任务：每分钟把「新审计事件 × 启用规则」过一遍（#224 取代老系统
 * 数据库触发器的接缝——事件源是审计流，条件与动作形状由 @ally/automations 收口）。
 *
 * 取数模型：90 秒尾窗（60s 周期 × 1.5 重叠），重叠窗口的重复命中由
 * automation_runs 的 (rule_id, source_event_id) 唯一约束吸收（onConflictDoNothing，
 * 只有新插的行才发执行任务）。服务停摆超过窗长的缺口本切片不追（切换期各域任务
 * 逐个迁移时再评估游标硬化，见 docs/automations.md）。
 *
 * 回路防护：actor 带 automation:<runId> 前缀的审计事件（自动化自己的动作产物）
 * 不进匹配——规则触发规则会在一个窗口内连环爆炸。
 *
 * 滞留清障（本任务兼任）：pending 超过 RESEND 阈值的 run 重发执行任务（补扫描器
 * 插行后崩溃的缺口；pg-boss singletonKey 让在途重复发送自动去重）；pending 超过
 * GIVE_UP 阈值（大于执行任务 4 次尝试的最坏总时长）终判 failed。
 */

export const AUTOMATION_SCAN_JOB = "automation-scan";

/** 扫描尾窗；必须大于扫描周期（60s），重叠部分靠唯一约束去重 */
export const SCAN_WINDOW_SECONDS = 90;
/** pending 超过这个时长就重发执行任务（补「插了行没发出任务」的缺口） */
export const RESEND_PENDING_AFTER_SECONDS = 120;
/**
 * pending 超过这个时长终判 failed。下界 = 执行任务最坏总时长：
 * 4 次尝试 × 900s 超时 + 60/120/240s 退避 ≈ 66 分钟，取 90 分钟留余量。
 */
export const GIVE_UP_AFTER_SECONDS = 5400;

export interface ScanDeps extends ActionDeps {
  /** 发执行任务（生产 = boss.send + singletonKey 去重；测试收集调用） */
  sendRunJob: (runId: string) => Promise<void>;
}

export async function runAutomationScan(deps: ScanDeps): Promise<void> {
  const { db } = deps;
  const rules = await db
    .select()
    .from(schema.automationRules)
    .where(eq(schema.automationRules.enabled, true));
  if (rules.length > 0) {
    const parsedRules = rules.map((row) => ({
      row,
      spec: ruleSpecSchema.safeParse({
        trigger: row.trigger,
        conditions: row.conditions,
        actions: row.actions,
      }),
    }));
    const events = await db
      .select()
      .from(schema.auditEvents)
      .where(
        and(
          sql`${schema.auditEvents.createdAt} > now() - ${`${SCAN_WINDOW_SECONDS} seconds`}::interval`,
          // 回路防护：自动化动作产物（automation:<runId> actor）不触发规则
          sql`(${schema.auditEvents.actor} is null or ${schema.auditEvents.actor} not like ${`${AUTOMATION_ACTOR_PREFIX}%`})`,
        ),
      );
    for (const event of events) {
      const ctx = {
        action: event.action,
        target: event.target,
        actor: event.actor,
        detail: event.detail ?? null,
      };
      for (const { row, spec } of parsedRules) {
        if (!spec.success) {
          // 保存时校验过；库里的行坏了不能拖垮整个扫描，记日志跳过
          deps.logger.warn({ ruleId: row.id }, "automation rule spec is invalid, skipped");
          continue;
        }
        if (!eventMatchesTrigger(spec.data.trigger, event)) continue;
        const evaluation = evaluateConditions(spec.data.conditions, ctx);
        const inserted = await db
          .insert(schema.automationRuns)
          .values({
            ruleId: row.id,
            ruleName: row.name,
            sourceEventId: event.id,
            status: evaluation.passed ? "pending" : "skipped",
            conditionResults: evaluation.outcomes,
          })
          .onConflictDoNothing({
            target: [schema.automationRuns.ruleId, schema.automationRuns.sourceEventId],
          })
          .returning({ id: schema.automationRuns.id });
        const runRow = inserted[0];
        if (runRow !== undefined && evaluation.passed) {
          await deps.sendRunJob(runRow.id);
        }
      }
    }
  }
  await sweepStaleRuns(deps);
}

/** 滞留清障：重发卡住的 pending（补丢发缺口），终判超过 give-up 阈值的 pending */
async function sweepStaleRuns(deps: ScanDeps): Promise<void> {
  const resendCutoff = new Date(Date.now() - RESEND_PENDING_AFTER_SECONDS * 1000);
  const giveUpCutoff = new Date(Date.now() - GIVE_UP_AFTER_SECONDS * 1000);
  const stale = await deps.db
    .select({
      id: schema.automationRuns.id,
      createdAt: schema.automationRuns.createdAt,
    })
    .from(schema.automationRuns)
    .where(and(eq(schema.automationRuns.status, "pending"), lt(schema.automationRuns.createdAt, resendCutoff)));
  for (const run of stale) {
    if (run.createdAt < giveUpCutoff) {
      const updated = await deps.db
        .update(schema.automationRuns)
        .set({ status: "failed", error: "run job gave up after retries", finishedAt: new Date() })
        .where(and(eq(schema.automationRuns.id, run.id), eq(schema.automationRuns.status, "pending")))
        .returning({ id: schema.automationRuns.id });
      if (updated.length > 0) {
        deps.logger.warn({ runId: run.id }, "automation run finalized as failed by sweeper");
      }
    } else {
      await deps.sendRunJob(run.id);
    }
  }
}
