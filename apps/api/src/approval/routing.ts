import type { Db } from "@ally/db";
import {
  DecisionTableEvaluationError,
  evaluateDecisionTableRule,
} from "../rules/decision-table.ts";
import { RuleNotFoundError, RuleNotSetError, RuleShapeError } from "../rules/service.ts";

/**
 * 审批路线（#221 v2.2：「审批路线（金额区间 → 谁批）用 GoRules 决策表，存进规则
 * 注册表」）。「哪个动作进哪条审批线」不再由属主域代码硬编码 configKey——属主域
 * 把动作事实交给注册表里的路由表（`approval.routing.<subjectType>`，decision_table
 * 值类型），命中哪行就提交到哪条线；不命中/表缺失/表坏了都不是「不用审批」，
 * 而是调用方可见的未匹配原因，由调用方 fail closed。
 *
 * 输出约定：路由表的输出列 field 必须是 `configKey`（字符串单值，hitPolicy
 * first）。collect 命中给数组、输出缺失或非字符串都算路线坏表——审批的路线
 * 必须是确定的一条线。
 */

/** 路由表键约定：每个 subjectType 一张表（治理随行上的 changeableBy，互不掺和） */
export function approvalRoutingRuleKey(subjectType: string): string {
  return `approval.routing.${subjectType}`;
}

export type ApprovalRouteResolution =
  | { status: "matched"; configKey: string }
  | {
      status: "unmatched";
      reason:
        | "no_route_rule"
        | "route_not_set"
        | "invalid_route_table"
        | "route_evaluation_failed"
        | "no_matching_rule"
        | "invalid_route_output";
    };

/**
 * 用注册表里的路由决策表解析「这个动作进哪条审批线」。绝不抛业务错——四种坏表
 * 形态都折叠成 unmatched 的 reason（审批调用方对 unmatched 一律 fail closed，
 * reason 供日志与审计辨认「为什么没进线」）。
 */
export async function resolveApprovalRoute(
  db: Pick<Db, "select">,
  subjectType: string,
  facts: Record<string, unknown>,
): Promise<ApprovalRouteResolution> {
  const key = approvalRoutingRuleKey(subjectType);
  let output: Record<string, unknown>;
  try {
    output = await evaluateDecisionTableRule(db, key, facts);
  } catch (err) {
    if (err instanceof RuleNotFoundError) return { status: "unmatched", reason: "no_route_rule" };
    if (err instanceof RuleNotSetError) return { status: "unmatched", reason: "route_not_set" };
    if (err instanceof RuleShapeError) {
      return { status: "unmatched", reason: "invalid_route_table" };
    }
    if (err instanceof DecisionTableEvaluationError) {
      return { status: "unmatched", reason: "route_evaluation_failed" };
    }
    throw err;
  }
  const configKey = output.configKey;
  if (Object.keys(output).length === 0) {
    return { status: "unmatched", reason: "no_matching_rule" };
  }
  if (typeof configKey !== "string" || configKey.trim().length === 0) {
    return { status: "unmatched", reason: "invalid_route_output" };
  }
  return { status: "matched", configKey };
}
