import { getShortestPaths } from "@xstate/graph";
import { createActor, createMachine } from "xstate";
import { z } from "zod";
import { roleSchema, type Role } from "../authz/permissions.ts";

/**
 * 流程引擎（#220 切片 1：可配置内核）。
 *
 * 模板是 XState v5 的 JSON 定义（#232 §4.9），外挂本仓库的三个扩展字段：
 * 流转上的 `roles`（允许角色，ERPNext 工作流「状态+流转+允许角色」的直译）
 * 与 `gates`（进入门槛 = 具名条件积木列表）、`requireNote`（人工推进必须带
 * 原因，老系统 feat056「转 qualified/disqualified/waitlisted 必须带理由」的
 * 内核化）；状态上的 `timeoutAfterHours`（超时提醒基准）与 `entryActions`
 * （进入后动作 = 具名动作积木）。积木按名字在 workflow/blocks.ts 注册表解析，
 * 引擎只认拓扑——业务事实在积木里，不在流程 JSON 里。
 *
 * 服务端只用 XState 计算「当前状态 + 事件 → 下一状态」（无驻留 actor，每次
 * 从实例的 definition 快照重建），结果写数据库；@xstate/graph 在模板保存时
 * 做可达性验证，在测试里枚举全部路径生成接口测试（#212 的系统验证证据形态）。
 *
 * 引擎拒绝的三类语义（都在保存/推进时 fail closed）：
 * - 拓扑非法：initial 不存在、target 指向未知状态、不可达状态（保存时拒绝）
 * - 自环流转：`target === source` 一律不收——XState 对外自转移会重入本状态，
 *   「状态值不变」与「事件未被接受」在服务端无法区分，语义留给未来需要时再开
 * - 允许角色写不出闭集：roles 取 app_role 枚举（authz/permissions.ts），
 *   模板 JSON 里出现枚举外的角色名直接保存失败
 */

const STATE_NAME = /^[a-z][a-z0-9_]*$/;
const EVENT_NAME = /^[A-Z][A-Z0-9_]*$/;

const stateNameSchema = z
  .string()
  .trim()
  .max(64)
  .regex(STATE_NAME, "state names must be lower_snake_case");

const eventNameSchema = z
  .string()
  .trim()
  .max(64)
  .regex(EVENT_NAME, "event names must be UPPER_SNAKE_CASE");

/** 具名积木引用：名字在注册表解析，config 的形状由积木自己 zod 校验 */
export const blockRefSchema = z.object({
  name: z.string().trim().min(1).max(64),
  config: z.unknown().optional(),
});

const transitionSchema = z.union([
  // XState 的 JSON 惯例：流转可以写字符串简写（`CONTACT: "contacted"`），
  // 带角色/门槛/理由要求的写对象形态——两种在解析时归一
  stateNameSchema,
  z.object({
    target: stateNameSchema,
    roles: z.array(roleSchema).min(1).optional(),
    gates: z.array(blockRefSchema).optional(),
    requireNote: z.boolean().optional(),
  }),
]);

const stateSchema = z.object({
  on: z.record(eventNameSchema, transitionSchema).default({}),
  timeoutAfterHours: z.number().positive().max(24 * 365).optional(),
  entryActions: z.array(blockRefSchema).default([]),
});

export const workflowDefinitionSchema = z
  .object({
    initial: stateNameSchema,
    states: z.record(stateNameSchema, stateSchema),
  })
  .strict();

interface RawTransition {
  target: string;
  roles?: readonly Role[] | undefined;
  gates?: readonly { name: string; config?: unknown }[] | undefined;
  requireNote?: boolean | undefined;
}

interface RawState {
  on: Record<string, RawTransition>;
  timeoutAfterHours?: number | undefined;
  entryActions: readonly { name: string; config?: unknown }[];
}

interface RawTemplate {
  initial: string;
  states: Record<string, RawState>;
}

/** zod 放行后先把两种流转形态归一成对象形态，后续校验只看一种形状 */
function normalize(raw: z.infer<typeof workflowDefinitionSchema>): RawTemplate {
  return {
    initial: raw.initial,
    states: Object.fromEntries(
      Object.entries(raw.states).map(([name, state]) => [
        name,
        {
          on: Object.fromEntries(
            Object.entries(state.on).map(([event, transition]) => [
              event,
              typeof transition === "string" ? { target: transition } : transition,
            ]),
          ),
          entryActions: state.entryActions,
          ...(state.timeoutAfterHours !== undefined ? { timeoutAfterHours: state.timeoutAfterHours } : {}),
        },
      ]),
    ),
  };
}

export interface ParsedTransition {
  event: string;
  target: string;
  /** undefined = 不限角色（可见者中的员工皆可推，内核另有「至少一个非 customer 角色」的地板） */
  roles?: readonly Role[];
  gates?: readonly { name: string; config?: unknown }[];
  requireNote: boolean;
}

export interface ParsedState {
  on: Readonly<Record<string, ParsedTransition>>;
  timeoutAfterHours?: number;
  entryActions: readonly { name: string; config?: unknown }[];
}

export interface ParsedTemplate {
  initial: string;
  states: Readonly<Record<string, ParsedState>>;
}

export type ParseResult =
  | { ok: true; template: ParsedTemplate }
  | { ok: false; error: string };

/** zod 之后的语义校验：至少一个状态、initial/target 必须是已定义状态、禁止自环 */
function validateTopology(raw: RawTemplate): string | null {
  if (Object.keys(raw.states).length === 0) return "template has no states";
  if (!(raw.initial in raw.states)) {
    return `initial state "${raw.initial}" is not defined`;
  }
  for (const [name, state] of Object.entries(raw.states)) {
    for (const [event, transition] of Object.entries(state.on)) {
      if (!(transition.target in raw.states)) {
        return `"${name}" --${event}--> unknown target "${transition.target}"`;
      }
      if (transition.target === name) {
        return `"${name}" --${event}--> itself: self transitions are not supported`;
      }
    }
  }
  return null;
}

/** 状态值在引擎的输出里恒为扁平字符串（模板不允许嵌套/并行状态） */
function flatStateValue(snapshot: { readonly value: unknown }): string {
  const value = snapshot.value;
  if (typeof value !== "string") {
    throw new Error(`non-flat state value in workflow template: ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * 把（zod 已放行的）模板定义喂给 XState：createMachine 做结构校验，
 * getShortestPaths 做可达性校验——从 initial 走不到的状态属于模板写错，
 * 不是合法的「暂时不用的房间」（#232 §4.9 的系统验证证据面）。
 */
/**
 * 模板 → 无实现 XState 机器（纯拓扑：只有 `on` 的 target，扩展字段不进 XState）。
 * 导出给测试用：@xstate/graph 在它上面枚举全部路径生成接口测试（#212 证据面）。
 */
export function compileMachine(template: ParsedTemplate): ReturnType<typeof createMachine> {
  return createMachine({
    initial: template.initial,
    states: Object.fromEntries(
      Object.entries(template.states).map(([name, state]) => [
        name,
        {
          on: Object.fromEntries(
            Object.entries(state.on).map(([event, transition]) => [event, { target: transition.target }]),
          ),
        },
      ]),
    ),
  });
}

export function parseWorkflowTemplate(raw: unknown): ParseResult {
  const parsed = workflowDefinitionSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid definition" };
  }
  const normalized = normalize(parsed.data);
  const topologyError = validateTopology(normalized);
  if (topologyError !== null) {
    return { ok: false, error: topologyError };
  }
  const template: ParsedTemplate = {
    initial: normalized.initial,
    states: Object.fromEntries(
      Object.entries(normalized.states).map(([name, state]) => {
        const on: Record<string, ParsedTransition> = Object.fromEntries(
          Object.entries(state.on).map(([event, transition]) => [
            event,
            {
              event,
              target: transition.target,
              requireNote: transition.requireNote ?? false,
              ...(transition.roles !== undefined ? { roles: transition.roles } : {}),
              ...(transition.gates !== undefined ? { gates: transition.gates } : {}),
            },
          ]),
        );
        const entry: {
          on: Record<string, ParsedTransition>;
          entryActions: readonly { name: string; config?: unknown }[];
          timeoutAfterHours?: number;
        } = { on, entryActions: state.entryActions };
        if (state.timeoutAfterHours !== undefined) {
          entry.timeoutAfterHours = state.timeoutAfterHours;
        }
        return [name, entry];
      }),
    ),
  };
  try {
    const machine = compileMachine(template);
    const reachable = new Set<string>([template.initial]);
    for (const path of getShortestPaths(machine)) {
      reachable.add(flatStateValue(path.state));
    }
    const unreachable = Object.keys(template.states).filter((name) => !reachable.has(name));
    if (unreachable.length > 0) {
      return { ok: false, error: `unreachable states: ${unreachable.join(", ")}` };
    }
  } catch (err) {
    return { ok: false, error: `invalid state machine: ${err instanceof Error ? err.message : "unknown"}` };
  }
  return { ok: true, template };
}

/**
 * 「当前状态 + 事件 → 下一状态」的唯一裁决口：事件未被当前状态接受时 XState
 * 原地不动，引擎据此答 event_not_allowed。状态名不存在（实例快照与状态列被
 * 外力改歪）按 unknown_state 拒绝，不静默当作初始态。
 */
export function applyWorkflowEvent(
  template: ParsedTemplate,
  currentState: string,
  event: string,
): { ok: true; transition: ParsedTransition } | { ok: false; reason: "unknown_state" | "event_not_allowed" } {
  const state = template.states[currentState];
  if (state === undefined) {
    return { ok: false, reason: "unknown_state" };
  }
  const transition = state.on[event];
  if (transition === undefined) {
    return { ok: false, reason: "event_not_allowed" };
  }
  const machine = compileMachine(template);
  const actor = createActor(machine, {
    snapshot: machine.resolveState({ value: currentState }),
  });
  actor.start();
  const before = flatStateValue(actor.getSnapshot());
  actor.send({ type: event });
  const after = flatStateValue(actor.getSnapshot());
  actor.stop();
  // 自环在保存时已被拒绝；XState 语义下「被接受的事件」必然离开当前状态值，
  // 走到这里值不变 = 引擎与模板失配，按拒收处理而不是把状态写歪
  if (after === before || after !== transition.target) {
    return { ok: false, reason: "event_not_allowed" };
  }
  return { ok: true, transition };
}

/** 当前状态下 UI/调用方可发的事件清单（含各自的角色/门槛/理由要求） */
export function allowedEvents(template: ParsedTemplate, currentState: string): ParsedTransition[] {
  const state = template.states[currentState];
  if (state === undefined) return [];
  return Object.values(state.on);
}

/** 当前状态的到期时刻；状态没配超时返回 null（无提醒语义） */
export function stateDueAt(template: ParsedTemplate, currentState: string, enteredAt: Date): Date | null {
  const timeout = template.states[currentState]?.timeoutAfterHours;
  if (timeout === undefined) return null;
  return new Date(enteredAt.getTime() + timeout * 60 * 60 * 1000);
}

/** 模板引用的全部积木名（保存路径用它对注册表做存在性校验） */
export function referencedBlocks(template: ParsedTemplate): {
  gates: string[];
  actions: string[];
} {
  const gates = new Set<string>();
  const actions = new Set<string>();
  for (const state of Object.values(template.states)) {
    for (const action of state.entryActions) actions.add(action.name);
    for (const transition of Object.values(state.on)) {
      for (const gate of transition.gates ?? []) gates.add(gate.name);
    }
  }
  return { gates: [...gates], actions: [...actions] };
}
