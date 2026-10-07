import { eq } from "drizzle-orm";
import {
  dueEventContext,
  evaluateConditions,
  ruleSpecSchema,
} from "@ally/automations";
import { schema } from "@ally/db";
import type { ActionDeps } from "./actions.ts";
import { blockConditionEvaluator } from "./condition-registry.ts";
import { dueSubjectSpec } from "./due-registry.ts";

/**
 * automation-due-scan 任务（#224 切片 2）：每分钟把「due 触发的启用规则 × 到期
 * 时刻落进扫描带的 subject 行」过一遍。与事件扫描器（scanner.ts，读审计流）是
 * 并列的两个发现通道：触发形状、条件、动作、执行日志、重试协议完全共用（同一
 * 张 automation_rules / automation_runs、同一个 automation-run 执行器），差别只在
 * 「谁发现它该跑了」——这里由 worker 侧 due-subject 注册表（due-registry.ts）
 * 逐域取数。
 *
 * 到期时刻带 [now - 90s, now]，与事件扫描器同一尾窗语义（60s 周期 × 1.5 重叠）：
 * 重复命中由 automation_runs 的 (rule_id, source_event_id) 唯一约束吸收
 * （onConflictDoNothing，只有新插的行才发执行任务）。语义是「(规则, 行) 一次性」
 * ——一条任务的到期提醒只发一次；锚点改期不重报（要支持需把锚点值纳入去重键，
 * 留给真实域需求进场时再议）。停摆超过窗长的到期不追——与事件扫描器「不追停摆
 * 缺口」同一裁决（docs/automations.md）。
 *
 * fail closed：spec 坏了、subjectType 未注册、anchorField 未声明——逐条跳过并
 * 告警，不拖垮整个扫描（配置写得出、机制不装跑）。loadDueRows 抛错不接：取数
 * 代码是内核注册的（不是配置），坏了是部署 bug，让任务失败进重试与告警。
 *
 * 滞留清障不在此复刻：automation-scan 的 sweeper 扫的是全表 pending run，不问
 * 来源——两个扫描器都在场，一处清障。
 */

export const AUTOMATION_DUE_SCAN_JOB = "automation-due-scan";

/** 扫描尾窗；必须大于扫描周期（60s），重叠部分靠唯一约束去重 */
export const DUE_SCAN_WINDOW_SECONDS = 90;

export interface DueScanDeps extends ActionDeps {
  /** 发执行任务（生产 = boss.send + singletonKey 去重；测试收集调用） */
  sendRunJob: (runId: string) => Promise<void>;
}

export async function runAutomationDueScan(deps: DueScanDeps): Promise<void> {
  const { db } = deps;
  const rules = await db
    .select()
    .from(schema.automationRules)
    .where(eq(schema.automationRules.enabled, true));
  const now = new Date();
  const from = new Date(now.getTime() - DUE_SCAN_WINDOW_SECONDS * 1000);
  for (const row of rules) {
    const parsed = ruleSpecSchema.safeParse({
      trigger: row.trigger,
      conditions: row.conditions,
      actions: row.actions,
    });
    if (!parsed.success) {
      // 保存时校验过；库里的行坏了不能拖垮整个扫描，记日志跳过
      deps.logger.warn({ ruleId: row.id }, "automation rule spec is invalid, skipped");
      continue;
    }
    const trigger = parsed.data.trigger;
    if (trigger.kind !== "due") continue; // 事件触发归 automation-scan
    const spec = dueSubjectSpec(trigger.subjectType);
    if (spec === undefined) {
      deps.logger.warn(
        { ruleId: row.id, subjectType: trigger.subjectType },
        "due trigger subject is not registered, rule skipped",
      );
      continue;
    }
    if (!spec.anchorFields.includes(trigger.anchorField)) {
      deps.logger.warn(
        { ruleId: row.id, subjectType: trigger.subjectType, anchorField: trigger.anchorField },
        "due trigger anchor field is not declared, rule skipped",
      );
      continue;
    }
    const dueRows = await spec.loadDueRows(db, {
      anchorField: trigger.anchorField,
      direction: trigger.direction,
      offsetMinutes: trigger.offsetMinutes,
      from,
      to: now,
    });
    for (const dueRow of dueRows) {
      const ctx = dueEventContext({
        subjectType: trigger.subjectType,
        subjectId: dueRow.id,
        detail: dueRow.detail,
      });
      const evaluation = await evaluateConditions(
        parsed.data.conditions,
        ctx,
        blockConditionEvaluator({ db }),
      );
      // 与事件扫描器同一纪律：求值不了的条件积木落 error + 告警，扫描不停摆
      for (const outcome of evaluation.outcomes) {
        if ("error" in outcome && outcome.error !== undefined) {
          deps.logger.warn(
            { ruleId: row.id, block: outcome.block, error: outcome.error },
            "automation condition block could not be evaluated, rule skipped",
          );
        }
      }
      const inserted = await db
        .insert(schema.automationRuns)
        .values({
          ruleId: row.id,
          ruleName: row.name,
          sourceEventId: dueRow.id,
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
