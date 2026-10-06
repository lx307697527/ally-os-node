import { evaluateExpression, evaluateUnaryExpression } from "@gorules/zen-engine";
import { z } from "zod";

/**
 * 决策表值类型（#233 §4.9：GoRules ZEN JSON，引擎锁主版本 ^2）。
 *
 * 值 = 一张 ZEN 决策表（v2 扁平形状）：hitPolicy + 列定义（inputs/outputs，各带
 * id/field）+ rules（每行是「列 id → 单元格表达式」的 map）。输入单元格是 unary
 * 测试（按列 id 取事实、在 `$` 上做 `== 'x'` / `> 100` 这类比较，空串 = 恒真），
 * 输出单元格是标准表达式（字符串字面量带引号）。求值走 input → table → output
 * 的单节点 JDM 图，无命中返回 `{}`（空对象 = 没有输出，**不是**错误——路由语义
 * 由消费域裁决，审批路线对无命中一律 fail closed）。
 *
 * 两条硬纪律：
 * - **写面编译校验**（assertDecisionTableCompiles）：ZEN 引擎对解析不了的单元格
 *   是「静默不命中」——一张带错字的表不报错、只是永远走不到那一行，对路由是
 *   「配置看着改好了、实际全部 fail closed」。所以 PATCH 面逐单元格跑编译探针
 *   （unary 用 `{$: null}` 探针、输出用空上下文），只拒 parserError（语法错）；
 *   类型不匹配是运行期数据问题（如 `> 100` 对字符串），不在写面代裁。
 * - **读面 fail loud**（evaluateDecisionTableRule）：键不存在 / 值未设 / 形状不符
 *   沿用注册表内核三错（RuleNotFoundError / RuleNotSetError / RuleShapeError），
 *   引擎求值失败包成 DecisionTableEvaluationError——坏表绝不能被读成「没有路线」。
 */

// ── 值形状（写入面按 valueType 收口的第一道门）────────────────────────────────
const decisionTableColumn = z
  .object({
    /** 规则行里单元格的键（zen 的 trace 也按它对行）；全表唯一 */
    id: z.string().trim().min(1).max(100),
    /** 事实上的取值路径（顶层字段名或点分路径），输出列同时是结果键 */
    field: z.string().trim().min(1).max(200),
    name: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

/** 规则行：列 id（或 _id）→ 单元格表达式；全部值必须是字符串 */
const decisionTableRow = z.record(z.string(), z.string());

export const decisionTableValueSchema = z
  .object({
    hitPolicy: z.enum(["first", "collect"]),
    inputs: z.array(decisionTableColumn).max(20),
    outputs: z.array(decisionTableColumn).min(1).max(20),
    /** 空表合法 = 什么都不命中（路由语义：临时全部 fail closed） */
    rules: z.array(decisionTableRow).max(500),
  })
  .strict()
  .superRefine((table, ctx) => {
    const columnIds = new Set<string>();
    for (const column of [...table.inputs, ...table.outputs]) {
      if (columnIds.has(column.id)) {
        ctx.addIssue({ code: "custom", message: `duplicate column id "${column.id}"` });
      }
      columnIds.add(column.id);
    }
    const outputFields = new Set<string>();
    for (const column of table.outputs) {
      if (outputFields.has(column.field)) {
        ctx.addIssue({ code: "custom", message: `duplicate output field "${column.field}"` });
      }
      outputFields.add(column.field);
    }
    const ruleIds = new Set<string>();
    for (const rule of table.rules) {
      const ruleId = rule._id;
      if (ruleId === undefined || ruleId.trim().length === 0) {
        ctx.addIssue({ code: "custom", message: "every rule needs a non-empty _id" });
        continue;
      }
      if (ruleIds.has(ruleId)) {
        ctx.addIssue({ code: "custom", message: `duplicate rule _id "${ruleId}"` });
      }
      ruleIds.add(ruleId);
      for (const key of Object.keys(rule)) {
        if (key === "_id") continue;
        if (!columnIds.has(key)) {
          ctx.addIssue({
            code: "custom",
            message: `rule "${ruleId}" references unknown column "${key}"`,
          });
        }
      }
    }
  });

export type DecisionTableValue = z.infer<typeof decisionTableValueSchema>;

// ── 写面编译校验：拒语法错，静默不命中不允许进注册表 ─────────────────────────────

/** ZEN 引擎的错误消息是一段 JSON（{"type":"parserError",...}）；只认语法错，
 * 类型/运行期错不在写面代裁（那取决于求值时的事实形状）。返回 null = 不是语法错 */
function zenParserMessage(err: unknown): string | null {
  if (!(err instanceof Error)) return null;
  try {
    const parsed: unknown = JSON.parse(err.message);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "type" in parsed &&
      parsed.type === "parserError"
    ) {
      return err.message;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 逐单元格编译探针：输入单元格是 unary 测试（探针上下文 `{$: null}`——引用值
 * 的类型只影响类型错不影响语法判定），输出单元格是标准表达式（空上下文足够）。
 * 空串单元格跳过（决策表语义 = 恒真 / 不产出，不是语法错）。非语法错（类型
 * 不匹配等）放行——写面只保证「表是可执行的」，不保证「对任意事实都命中」。
 */
export async function assertDecisionTableCompiles(value: unknown): Promise<void> {
  const parsed = decisionTableValueSchema.safeParse(value);
  if (!parsed.success) {
    throw new InvalidDecisionTableError(parsed.error.issues.map((i) => i.message).join("; "));
  }
  const { inputs, outputs, rules } = parsed.data;
  for (const rule of rules) {
    for (const column of inputs) {
      const cell = rule[column.id];
      if (cell === undefined || cell.trim().length === 0) continue;
      try {
        await evaluateUnaryExpression(cell, { $: null });
      } catch (err) {
        const message = zenParserMessage(err);
        if (message !== null) {
          throw new InvalidDecisionTableError(
            `rule "${rule._id}" input cell "${column.id}" does not parse: ${message}`,
          );
        }
      }
    }
    for (const column of outputs) {
      const cell = rule[column.id];
      if (cell === undefined || cell.trim().length === 0) continue;
      try {
        await evaluateExpression(cell, {});
      } catch (err) {
        const message = zenParserMessage(err);
        if (message !== null) {
          throw new InvalidDecisionTableError(
            `rule "${rule._id}" output cell "${column.id}" does not parse: ${message}`,
          );
        }
      }
    }
  }
}

export class InvalidDecisionTableError extends Error {
  constructor(issues: string) {
    super(`rules: invalid decision table: ${issues}`);
    this.name = "InvalidDecisionTableError";
  }
}

