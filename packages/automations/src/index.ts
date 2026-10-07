import { z } from "zod";

/**
 * 自动化规则引擎的形状与纯求值（#224 切片 1，#232 §4.4「自动化规则」行）。
 *
 * 规则模型借鉴 Odoo：触发（新建、字段变化、进入阶段 → 本切片统一为「审计事件
 * action 精确命中」，域事件由各域写审计时产生）→ 过滤条件（对事件语境的点路径
 * 断言）→ 动作（建任务、发通知、发邮件；其余动作类型随所属域切片进场）。本包零依赖
 * （只有 zod）：API 的规则 CRUD 用同一份 schema 做保存时校验，worker 的扫描/
 * 执行用同一份 schema 做运行时解析——两端不会长出两套形状。
 *
 * 条件求值 fail closed：路径解析不到（detail 缺键、穿过非对象）一律不满足，
 * 只有 `exists` 显式表达「必须有/必须没有」。语境的根只有事件行自己的四列
 * （action/target/actor/detail），不外溢。
 */

/**
 * 触发（#224 切片 2 起为判别联合，`kind` 区分）：
 * - `event`：审计事件 action 精确命中（如 task.created、workflow.state_changed）
 *   ——事件扫描器（automation-scan）消费；
 * - `due`：记录上的日期字段到达锚点 ± 偏移（「预约前 N 小时」，Odoo 的
 *   based-on-date-field 触发）——到期扫描器（automation-due-scan）消费，锚点
 *   必须是注册过的 due subject 及其声明过的日期字段（worker 侧注册表裁决，
 *   未注册 = 规则永不触发并告警，fail closed）。
 *
 * 两种触发写进同一张 automation_rules 表（trigger 是 jsonb），执行日志、动作、
 * 条件、重试协议完全共用——差别只在「谁发现它该跑了」。
 */
export const eventTriggerSpecSchema = z.object({
  kind: z.literal("event"),
  action: z.string().trim().min(1).max(200),
});
export type EventTriggerSpec = z.infer<typeof eventTriggerSpecSchema>;

export const DUE_DIRECTIONS = ["before", "after"] as const;
export type DueDirection = (typeof DUE_DIRECTIONS)[number];

/** 偏移下界 5 分钟（更细的粒度是秒级调度的事，不是分钟级扫描器的事）；上界 90 天 */
export const DUE_OFFSET_MINUTES_MIN = 5;
export const DUE_OFFSET_MINUTES_MAX = 129_600;

export const dueTriggerSpecSchema = z.object({
  kind: z.literal("due"),
  subjectType: z.string().trim().min(1).max(100),
  anchorField: z.string().trim().min(1).max(100),
  direction: z.enum(DUE_DIRECTIONS),
  offsetMinutes: z.number().int().min(DUE_OFFSET_MINUTES_MIN).max(DUE_OFFSET_MINUTES_MAX),
});
export type DueTriggerSpec = z.infer<typeof dueTriggerSpecSchema>;

export const triggerSpecSchema = z.discriminatedUnion("kind", [
  eventTriggerSpecSchema,
  dueTriggerSpecSchema,
]);
export type TriggerSpec = z.infer<typeof triggerSpecSchema>;

export const CONDITION_OPS = ["eq", "ne", "in", "exists"] as const;
export type ConditionOp = (typeof CONDITION_OPS)[number];

/**
 * 条件：对事件语境的点路径断言。value 的形状随 op 收口——eq/ne 任意 JSON 值
 * （可 null）、in 非空数组、exists 布尔。路径解析不到时 eq/ne/in 一律不满足。
 */
export const conditionSpecSchema = z
  .object({
    path: z.string().trim().min(1).max(200),
    op: z.enum(CONDITION_OPS),
    value: z.unknown().optional(),
  })
  .refine(
    (c) =>
      c.op === "eq" || c.op === "ne"
        ? "value" in c
        : c.op === "in"
          ? Array.isArray(c.value) && c.value.length > 0 && c.value.length <= 100
          : typeof c.value === "boolean",
    { message: "value is required by op (eq/ne: any JSON value, in: 1..100 items, exists: boolean)" },
  );
export type ConditionSpec = z.infer<typeof conditionSpecSchema>;

export const createTaskActionSchema = z.object({
  type: z.literal("create_task"),
  config: z.object({
    title: z.string().trim().min(1).max(500),
    description: z.string().trim().max(5000).optional(),
    assigneeId: z.uuid().optional(),
    /** 相对触发时刻的到期小时数（1h ~ 90d）；不填 = 无到期 */
    dueInHours: z.number().int().min(1).max(2160).optional(),
  }),
});
export type CreateTaskAction = z.infer<typeof createTaskActionSchema>;

export const notifyActionSchema = z.object({
  type: z.literal("notify"),
  config: z.object({
    /** 收件人白名单在保存时点死（uuid 列表）——按角色圈人的展开随 RBAC 消费切片进场 */
    userIds: z.array(z.uuid()).min(1).max(50),
    title: z.string().trim().min(1).max(200),
    body: z.string().trim().max(1000).optional(),
  }),
});
export type NotifyAction = z.infer<typeof notifyActionSchema>;

export const sendEmailActionSchema = z.object({
  type: z.literal("send_email"),
  config: z.object({
    /**
     * 收件人是站内用户（保存时点死的 uuid 列表，发送时按 id 解析账号邮箱）。
     * 自动化无人值守地发信，不给规则作者任意外部地址的入口——对外邮件是属主域
     * 写路径与 #237 营销邮件审批面的事。收件人被删 = 动作失败进重试/告警，
     * 不静默跳过（与 notify 收件人的 FK 约束同一裁法）。
     */
    userIds: z.array(z.uuid()).min(1).max(50),
    subject: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(5000),
  }),
});
export type SendEmailAction = z.infer<typeof sendEmailActionSchema>;

export const actionSpecSchema = z.discriminatedUnion("type", [
  createTaskActionSchema,
  notifyActionSchema,
  sendEmailActionSchema,
]);
export type ActionSpec = z.infer<typeof actionSpecSchema>;

/** 一条规则的动作序列：至少一个，至多十个（防手滑配出连锁轰炸） */
export const ruleSpecSchema = z.object({
  trigger: triggerSpecSchema,
  conditions: z.array(conditionSpecSchema).max(20).default([]),
  actions: z.array(actionSpecSchema).min(1).max(10),
});
export type RuleSpec = z.infer<typeof ruleSpecSchema>;

/** 事件语境：审计事件行的投影，条件与动作唯一能看到的世界 */
export interface AutomationEventContext {
  action: string;
  target: string | null;
  actor: string | null;
  detail: Record<string, unknown> | null;
}

/** 自动化自身的写路径带 automation:<runId> 前缀 actor——扫描器靠它防自触发回路 */
export const AUTOMATION_ACTOR_PREFIX = "automation:";

export function eventMatchesTrigger(trigger: TriggerSpec, event: { action: string }): boolean {
  return trigger.kind === "event" && event.action === trigger.action;
}

/**
 * due 触发合成的事件语境：条件求值看到的形状与审计事件完全一致（同一份
 * resolvePath/evaluateConditions），但语境是扫描器从注册的 subject 行投影出来
 * 的，不写审计——「到期时刻到了」不是一次业务变更（docs/audit.md 的纪律），
 * 执行日志在 automation_runs。
 */
export function dueEventContext(args: {
  subjectType: string;
  subjectId: string;
  detail: Record<string, unknown>;
}): AutomationEventContext {
  return {
    action: `${args.subjectType}.due`,
    target: `${args.subjectType}:${args.subjectId}`,
    actor: null,
    detail: args.detail,
  };
}

/** 点路径取值：只允许穿过普通对象；数组下标、原型链、__proto__ 一律到不了 */
export function resolvePath(ctx: AutomationEventContext, path: string): unknown {
  const segments = path.split(".");
  const [root, ...rest] = segments;
  if (root === undefined) return undefined;
  let current: unknown;
  if (root === "action") current = ctx.action;
  else if (root === "target") current = ctx.target;
  else if (root === "actor") current = ctx.actor;
  else if (root === "detail") current = ctx.detail;
  else return undefined;
  for (const segment of rest) {
    if (typeof current !== "object" || current === null) return undefined;
    if (segment === "__proto__" || segment === "constructor" || segment === "prototype") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export interface ConditionOutcome {
  path: string;
  op: ConditionOp;
  passed: boolean;
}

export interface ConditionEvaluation {
  passed: boolean;
  outcomes: ConditionOutcome[];
}

/** 全部条件都满足才放行（AND）；空条件集恒真 */
export function evaluateConditions(
  conditions: ConditionSpec[],
  ctx: AutomationEventContext,
): ConditionEvaluation {
  const outcomes: ConditionOutcome[] = conditions.map((condition) => {
    const resolved = resolvePath(ctx, condition.path);
    let passed: boolean;
    if (condition.op === "exists") {
      passed = resolved !== undefined === condition.value;
    } else if (condition.op === "eq") {
      passed = resolved === condition.value;
    } else if (condition.op === "ne") {
      passed = resolved !== condition.value && resolved !== undefined;
    } else {
      passed =
        Array.isArray(condition.value) &&
        resolved !== undefined &&
        condition.value.some((item) => item === resolved);
    }
    return { path: condition.path, op: condition.op, passed };
  });
  return { passed: outcomes.every((o) => o.passed), outcomes };
}

/** 运行结果里的动作行（worker 落库形状，api 的 runs 读法原样展示） */
export interface ActionResult {
  type: ActionSpec["type"];
  status: "succeeded" | "failed";
  /** create_task 落任务的 id，便于从运行记录跳到产物 */
  ref?: string | undefined;
  error?: string | undefined;
}
