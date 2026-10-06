import { ZenEngine } from "@gorules/zen-engine";
import type { Db } from "@ally/db";
import { decisionTableValueSchema, type DecisionTableValue } from "./decision-table-schema.ts";
import { getRuleRow, RuleNotFoundError, RuleNotSetError, RuleShapeError } from "./service.ts";

/**
 * 决策表求值（#233 §4.9）：注册表里的 decision_table 值 → 单节点 JDM 图 → 输出。
 * 值形状与写面编译校验在 decision-table-schema.ts；这里是消费方的类型化读口。
 *
 * **读面 fail loud**：键不存在 / 值未设 / 形状不符沿用注册表内核三错
 * （RuleNotFoundError / RuleNotSetError / RuleShapeError），引擎求值失败包成
 * DecisionTableEvaluationError——坏表绝不能被读成「没有路线」（fail closed 的
 * 语义归消费域，但它必须由消费域在拿到明确失败后自己裁决，而不是把坏表伪装成
 * 正常的无命中）。
 */

export class DecisionTableEvaluationError extends Error {
  constructor(key: string, cause: unknown) {
    super(`rules: decision table evaluation failed for "${key}": ${String(cause)}`);
    this.name = "DecisionTableEvaluationError";
  }
}

/** 单表 JDM 图：input 原样透传事实，table 求值，output 把表输出作为最终结果 */
function wrapAsDecisionGraph(key: string, table: DecisionTableValue): object {
  return {
    nodes: [
      { id: "input", type: "inputNode", name: "input", position: { x: 0, y: 0 } },
      {
        id: "table",
        type: "decisionTableNode",
        name: key,
        position: { x: 200, y: 0 },
        content: table,
      },
      { id: "output", type: "outputNode", name: "output", position: { x: 400, y: 0 } },
    ],
    edges: [
      { id: "input-table", sourceId: "input", targetId: "table" },
      { id: "table-output", sourceId: "table", targetId: "output" },
    ],
  };
}

/**
 * 读一张决策表规则并对事实求值，返回输出字段的 map（按输出列的 field 键）。
 * 无命中 = `{}`（空对象）；hitPolicy=collect 时输出是数组——消费域自己收口
 * （审批路线只接受 first 的单值输出）。输入单元格是 unary 测试（按列 id 取
 * 事实，空串 = 恒真），解析不了的单元格静默不命中——写面编译校验
 * （assertDecisionTableCompiles）挡新写入，库里被外力改歪的旧值在这里炸给人看。
 */
export async function evaluateDecisionTableRule(
  db: Pick<Db, "select">,
  key: string,
  facts: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const row = await getRuleRow(db, key);
  if (row === undefined) throw new RuleNotFoundError(key);
  if (row.value === null) throw new RuleNotSetError(key);
  const parsed = decisionTableValueSchema.safeParse(row.value);
  if (!parsed.success) {
    throw new RuleShapeError(key, parsed.error.issues.map((i) => i.message).join("; "));
  }
  const engine = new ZenEngine();
  let decision;
  try {
    decision = engine.createDecision(wrapAsDecisionGraph(key, parsed.data));
  } catch (cause) {
    throw new DecisionTableEvaluationError(key, cause);
  }
  let result: unknown;
  try {
    result = (await decision.evaluate(facts)).result;
  } catch (cause) {
    throw new DecisionTableEvaluationError(key, cause);
  }
  if (result === null || result === undefined) return {};
  if (typeof result !== "object" || Array.isArray(result)) {
    throw new DecisionTableEvaluationError(key, `expected an output object, got ${typeof result}`);
  }
  return result as Record<string, unknown>;
}
