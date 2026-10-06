import { and, asc, desc, eq, lte, sql } from "drizzle-orm";
import type { Db } from "@ally/db";
import { schema } from "@ally/db";
import { recordAudit } from "../audit/audit-log.ts";
import type { Role } from "../authz/permissions.ts";
import { actionBlock, conditionBlock } from "./blocks.ts";
import {
  applyWorkflowEvent,
  parseWorkflowTemplate,
  stateDueAt,
  type ParsedTemplate,
  type ParsedTransition,
} from "./engine.ts";
import { workflowSubjectSpec } from "./registry.ts";

/**
 * 流程内核服务（#220 切片 1）。
 *
 * 三条写路径共用同一套失败语义：拒绝发生在写之前（可见性/角色/门槛/拓扑全部
 * 通过才动库），状态推进与流转历史、审计行在同一事务——历史行 append-only
 * （0013 触发器），审计失败则推进失败（与全部业务写路径一致）。进入后动作在
 * 事务提交后执行：动作是「进入状态之后的后果」，失败不回滚已成立的流转，错误
 * 随结果返回给调用方记录（后续 #224 自动化引擎进场后改为经队列投递）。
 *
 * 并发推进用乐观并发控制：UPDATE 带 `current_state = 读到的状态` 条件，抢不到
 * 行说明状态已被并发请求推进，按冲突拒绝——不覆盖别人的流转，也不落第二行历史。
 */

export interface StartCommand {
  subjectType: string;
  subjectId: string;
  startedById: string;
}

export type StartOutcome =
  | { status: "started"; instanceId: string; templateKey: string; currentState: string }
  | {
      status: "rejected";
      reason:
        | "subject_unregistered"
        | "subject_not_found"
        | "no_template"
        | "already_started"
        | "template_invalid";
      instanceId?: string;
    };

/**
 * 解析模板：产品类型精确命中最优先，其次该类型的默认模板（部分唯一索引保证
 * 至多一个），再按创建先后稳定排序。
 */
async function resolveTemplate(
  db: Db,
  subjectType: string,
  productType: string | null,
): Promise<{ id: string; templateKey: string; definition: unknown } | undefined> {
  const rows = await db
    .select({
      id: schema.workflowTemplates.id,
      templateKey: schema.workflowTemplates.templateKey,
      definition: schema.workflowTemplates.definition,
    })
    .from(schema.workflowTemplates)
    .where(
      and(
        eq(schema.workflowTemplates.subjectType, subjectType),
        eq(schema.workflowTemplates.active, true),
      ),
    )
    .orderBy(
      sql`(${schema.workflowTemplates.productType} is not distinct from ${productType}) desc`,
      desc(schema.workflowTemplates.isDefault),
      asc(schema.workflowTemplates.createdAt),
    )
    .limit(1);
  return rows[0];
}

export async function startWorkflow(db: Db, cmd: StartCommand): Promise<StartOutcome> {
  const spec = workflowSubjectSpec(cmd.subjectType);
  if (spec === undefined) {
    return { status: "rejected", reason: "subject_unregistered" };
  }
  const subject = await spec.load(db, cmd.subjectId);
  if (subject === null) {
    return { status: "rejected", reason: "subject_not_found" };
  }
  const template = await resolveTemplate(db, cmd.subjectType, subject.productType ?? null);
  if (template === undefined) {
    return { status: "rejected", reason: "no_template" };
  }
  const parsed = parseWorkflowTemplate(template.definition);
  if (!parsed.ok) {
    // 模板在保存时已过校验；走到这里是库内数据被外力改歪，拒绝启动而不是带病在飞
    return { status: "rejected", reason: "template_invalid" };
  }
  const enteredAt = new Date();
  const inserted = await db
    .insert(schema.workflowInstances)
    .values({
      subjectType: cmd.subjectType,
      subjectId: cmd.subjectId,
      templateId: template.id,
      templateKey: template.templateKey,
      definition: template.definition,
      currentState: parsed.template.initial,
      stateEnteredAt: enteredAt,
      stateDueAt: stateDueAt(parsed.template, parsed.template.initial, enteredAt),
      startedById: cmd.startedById,
    })
    // 唯一索引撞车 = 并发双启动，输家按已存在实例幂等返回
    .onConflictDoNothing({ target: [schema.workflowInstances.subjectType, schema.workflowInstances.subjectId] })
    .returning({ id: schema.workflowInstances.id });
  const row = inserted[0];
  if (row === undefined) {
    const existing = await db
      .select({ id: schema.workflowInstances.id })
      .from(schema.workflowInstances)
      .where(
        and(
          eq(schema.workflowInstances.subjectType, cmd.subjectType),
          eq(schema.workflowInstances.subjectId, cmd.subjectId),
        ),
      )
      .limit(1);
    return {
      status: "rejected",
      reason: "already_started",
      ...(existing[0] !== undefined ? { instanceId: existing[0].id } : {}),
    };
  }
  await recordAudit(db, {
    actor: cmd.startedById,
    action: "workflow.instance_started",
    target: row.id,
    detail: {
      subjectType: cmd.subjectType,
      subjectId: cmd.subjectId,
      templateKey: template.templateKey,
      from: parsed.template.initial,
    },
  });
  return {
    status: "started",
    instanceId: row.id,
    templateKey: template.templateKey,
    currentState: parsed.template.initial,
  };
}

export interface TransitionCommand {
  subjectType: string;
  subjectId: string;
  actorId: string;
  /** 调用方（路由）从 authz 中间件取的当前角色集 */
  actorRoles: readonly Role[];
  event: string;
  /** 人工推进原因；requireNote 的流转空白即拒 */
  note?: string | undefined;
}

export type TransitionOutcome =
  | {
      status: "applied";
      instanceId: string;
      from: string;
      to: string;
      /** 提交后动作的失败清单（状态已推进；动作失败随结果带出，由调用方记录） */
      actionErrors: { name: string; error: string }[];
    }
  | {
      status: "rejected";
      reason:
        | "not_found"
        | "event_not_allowed"
        | "note_required"
        | "role_required"
        | "gate_failed"
        | "gate_unavailable"
        | "concurrent_conflict";
      gateName?: string;
    };

/** 流转是员工动作：纯 customer 角色的调用者永不通过（内核地板，模板 roles 再收紧） */
function isStaffRole(roles: readonly Role[]): boolean {
  return roles.some((role) => role !== "customer");
}

export async function applyTransition(db: Db, cmd: TransitionCommand): Promise<TransitionOutcome> {
  if (!isStaffRole(cmd.actorRoles)) {
    return { status: "rejected", reason: "role_required" };
  }
  const instanceRows = await db
    .select()
    .from(schema.workflowInstances)
    .where(
      and(
        eq(schema.workflowInstances.subjectType, cmd.subjectType),
        eq(schema.workflowInstances.subjectId, cmd.subjectId),
      ),
    )
    .limit(1);
  const instance = instanceRows[0];
  if (instance === undefined) {
    return { status: "rejected", reason: "not_found" };
  }
  const parsed = parseWorkflowTemplate(instance.definition);
  if (!parsed.ok) {
    // 实例快照在启动时已过校验；被外力改歪时 fail closed，不猜拓扑
    throw new Error(`workflow instance ${instance.id} has an invalid definition`);
  }
  const step = applyWorkflowEvent(parsed.template, instance.currentState, cmd.event);
  if (!step.ok) {
    return { status: "rejected", reason: step.reason === "unknown_state" ? "event_not_allowed" : step.reason };
  }
  const transition = step.transition;
  if (transition.roles !== undefined && !transition.roles.some((role) => cmd.actorRoles.includes(role))) {
    return { status: "rejected", reason: "role_required" };
  }
  if (transition.requireNote && (cmd.note ?? "").trim() === "") {
    return { status: "rejected", reason: "note_required" };
  }
  for (const gate of transition.gates ?? []) {
    const block = conditionBlock(gate.name);
    if (block === undefined) {
      // fail closed：引用的积木不在（代码回退/注册表漂移）时宁可停住也不放行
      return { status: "rejected", reason: "gate_unavailable", gateName: gate.name };
    }
    const passed = await block({
      db,
      actorId: cmd.actorId,
      subjectType: cmd.subjectType,
      subjectId: cmd.subjectId,
      instanceId: instance.id,
      config: gate.config,
    });
    if (!passed) {
      return { status: "rejected", reason: "gate_failed", gateName: gate.name };
    }
  }
  const enteredAt = new Date();
  const dueAt = stateDueAt(parsed.template, transition.target, enteredAt);
  const updated = await db
    .update(schema.workflowInstances)
    .set({
      currentState: transition.target,
      stateEnteredAt: enteredAt,
      stateDueAt: dueAt,
    })
    .where(
      and(eq(schema.workflowInstances.id, instance.id), eq(schema.workflowInstances.currentState, instance.currentState)),
    )
    .returning({ id: schema.workflowInstances.id });
  if (updated[0] === undefined) {
    // 并发推进抢输了：别人的流转已生效，本次按冲突拒绝，由调用方重读最新状态
    return { status: "rejected", reason: "concurrent_conflict" };
  }
  const note = cmd.note?.trim();
  await db.insert(schema.workflowTransitions).values({
    instanceId: instance.id,
    fromState: instance.currentState,
    toState: transition.target,
    event: cmd.event,
    ...(note !== undefined && note !== "" ? { note } : {}),
    actorId: cmd.actorId,
  });
  await recordAudit(db, {
    actor: cmd.actorId,
    action: "workflow.state_changed",
    target: instance.id,
    detail: {
      subjectType: cmd.subjectType,
      subjectId: cmd.subjectId,
      event: cmd.event,
      from: instance.currentState,
      to: transition.target,
      ...(note !== undefined && note !== "" ? { note } : {}),
    },
  });
  // 提交后动作（进入后动作）：失败不回滚已成立的流转，错误带出给调用方记录
  const actionErrors: { name: string; error: string }[] = [];
  for (const action of parsed.template.states[transition.target]?.entryActions ?? []) {
    const block = actionBlock(action.name);
    if (block === undefined) {
      actionErrors.push({ name: action.name, error: "action block is not registered" });
      continue;
    }
    try {
      await block({
        db,
        actorId: cmd.actorId,
        subjectType: cmd.subjectType,
        subjectId: cmd.subjectId,
        instanceId: instance.id,
        config: action.config,
      });
    } catch (err) {
      actionErrors.push({ name: action.name, error: err instanceof Error ? err.message : "unknown error" });
    }
  }
  return {
    status: "applied",
    instanceId: instance.id,
    from: instance.currentState,
    to: transition.target,
    actionErrors,
  };
}

export interface SubjectFlowView {
  instanceId: string;
  templateId: string | null;
  templateKey: string;
  currentState: string;
  stateEnteredAt: Date;
  stateDueAt: Date | null;
  allowedEvents: ParsedTransition[];
}

export type SubjectFlowOutcome =
  | { status: "found"; view: SubjectFlowView }
  | { status: "none" };

/** 实例读法（可见性门在路由层与评论/关注同扇）：状态 + 当前可发事件 + 超时基准 */
export async function subjectFlow(db: Db, subjectType: string, subjectId: string): Promise<SubjectFlowOutcome> {
  const rows = await db
    .select()
    .from(schema.workflowInstances)
    .where(
      and(
        eq(schema.workflowInstances.subjectType, subjectType),
        eq(schema.workflowInstances.subjectId, subjectId),
      ),
    )
    .limit(1);
  const instance = rows[0];
  if (instance === undefined) {
    return { status: "none" };
  }
  const parsed = parseWorkflowTemplate(instance.definition);
  if (!parsed.ok) {
    throw new Error(`workflow instance ${instance.id} has an invalid definition`);
  }
  return {
    status: "found",
    view: {
      instanceId: instance.id,
      templateId: instance.templateId,
      templateKey: instance.templateKey,
      currentState: instance.currentState,
      stateEnteredAt: instance.stateEnteredAt,
      stateDueAt: instance.stateDueAt,
      allowedEvents: allowedEventsOf(parsed.template, instance.currentState),
    },
  };
}

function allowedEventsOf(template: ParsedTemplate, currentState: string): ParsedTransition[] {
  const state = template.states[currentState];
  return state === undefined ? [] : Object.values(state.on);
}

export interface TransitionHistoryRow {
  fromState: string;
  toState: string;
  event: string;
  note: string | null;
  actorId: string;
  createdAt: Date;
}

/** 流转历史（新在前翻页） */
export async function transitionHistory(
  db: Db,
  subjectType: string,
  subjectId: string,
): Promise<TransitionHistoryRow[]> {
  const rows = await db
    .select({
      fromState: schema.workflowTransitions.fromState,
      toState: schema.workflowTransitions.toState,
      event: schema.workflowTransitions.event,
      note: schema.workflowTransitions.note,
      actorId: schema.workflowTransitions.actorId,
      createdAt: schema.workflowTransitions.createdAt,
    })
    .from(schema.workflowTransitions)
    .innerJoin(schema.workflowInstances, eq(schema.workflowTransitions.instanceId, schema.workflowInstances.id))
    .where(
      and(
        eq(schema.workflowInstances.subjectType, subjectType),
        eq(schema.workflowInstances.subjectId, subjectId),
      ),
    )
    .orderBy(desc(schema.workflowTransitions.createdAt))
    .limit(100);
  return rows;
}

export interface DueInstanceRow {
  instanceId: string;
  subjectType: string;
  subjectId: string;
  templateKey: string;
  currentState: string;
  stateDueAt: Date;
}

/**
 * 超时扫描（#220「停留超过设定时间时提醒负责人」的内核半边）：stateDueAt 在
 * 每次进入状态时按快照一次算好，扫描是纯索引查询。「提醒负责人怎么送」不是
 * 内核的裁决——属主域给不出负责人之前，本函数只对内暴露（未来定时任务 +
 * #116 通知渠道的第一个接缝），不设路由。
 */
export async function findDueInstances(db: Db, opts: { now: Date; limit: number }): Promise<DueInstanceRow[]> {
  const rows = await db
    .select({
      instanceId: schema.workflowInstances.id,
      subjectType: schema.workflowInstances.subjectType,
      subjectId: schema.workflowInstances.subjectId,
      templateKey: schema.workflowInstances.templateKey,
      currentState: schema.workflowInstances.currentState,
      stateDueAt: schema.workflowInstances.stateDueAt,
    })
    .from(schema.workflowInstances)
    .where(lte(schema.workflowInstances.stateDueAt, opts.now))
    .orderBy(asc(schema.workflowInstances.stateDueAt))
    .limit(opts.limit);
  // lte 已把 SQL 空值挡在外面；这里只收窄 drizzle 的列类型（null 不可比）
  return rows.flatMap((row) => {
    const dueAt = row.stateDueAt;
    return dueAt === null ? [] : [{ ...row, stateDueAt: dueAt }];
  });
}
