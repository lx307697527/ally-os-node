import type { Logger } from "pino";
import {
  NOTIFICATIONS_CHANGED_EVENT,
  REALTIME_LISTEN_CHANNEL,
  encodeBusEnvelope,
  userChannel,
  type RealtimeBusPayload,
} from "@ally/realtime";
import type { ActionResult, CreateTaskAction, NotifyAction } from "@ally/automations";
import { AUTOMATION_ACTOR_PREFIX } from "@ally/automations";
import { schema, type Db } from "@ally/db";

/**
 * 动作执行器（#224 切片 1 的两个内核动作：建任务、发通知）。
 *
 * 动作是内核的、实现在这里而不在 API：它们由 worker 的 automation-run 任务在
 * 重试语境里调用（#224「动作通过 pg-boss 执行」），API 不执行动作。幂等协议
 * 在 runner（已成功的动作按 action_results 跳过），本文件每个函数只管把一件事
 * 做成：建任务 + task.created 审计（actor 带 automation:<runId> 前缀——扫描器
 * 靠这个前缀防「自动化再触发自动化」的回路），发通知 + 铃铛「催」（与 API 路由
 * 同一形态：通知行是真相，推送是 at-most-once 加速器，失败只降级不回滚）。
 *
 * 任务分配通知（task.assigned）是任务内核（#113）行为的 worker 侧镜像——统一
 * 通知通道（#116）进场时并入，不复刻第二份。
 */

/** 发布用的执行器：worker 自己的连接池即可（query(text, values) 与 pg.Pool 兼容） */
export interface PublishExecutor {
  query(text: string, values?: unknown[]): Promise<unknown>;
}

export interface ActionDeps {
  db: Db;
  /** pg_notify 总线的发布执行器（与 packages/realtime RealtimeBus.publish 同一条 SQL） */
  publishExecutor: PublishExecutor;
  logger: Logger;
  /** 总线信封的 instanceId（跨进程广播标记来源实例，worker 启动时生成） */
  instanceId: string;
}

/** 经 pg_notify 总线发铃铛「催」；失败不抛（通知行已落库，推送只是加速器） */
async function nudgeBells(services: ActionServices, userIds: string[]): Promise<void> {
  const nudges = userIds.map(async (userId) => {
    const payload: RealtimeBusPayload = {
      type: "message",
      channel: userChannel(userId),
      event: NOTIFICATIONS_CHANGED_EVENT,
      data: {},
    };
    const encoded = encodeBusEnvelope(payload, services.instanceId);
    await services.publishExecutor.query("select pg_notify($1, $2)", [
      REALTIME_LISTEN_CHANNEL,
      encoded,
    ]);
  });
  await Promise.all(nudges).catch((err: unknown) => {
    services.logger.warn({ err, recipients: userIds.length }, "automation bell nudge failed");
  });
}

/** 动作的非 DB 依赖（发布执行器、日志、实例标识）——与 db 通道分开注入 */
export interface ActionServices {
  /** pg_notify 总线的发布执行器（与 packages/realtime RealtimeBus.publish 同一条 SQL） */
  publishExecutor: PublishExecutor;
  logger: Logger;
  /** 总线信封的 instanceId（跨进程广播标记来源实例，worker 启动时生成） */
  instanceId: string;
}

export interface ActionContext {
  ruleId: string;
  ruleName: string;
  /** create_task 的创建人快照（规则创建者；规则删了任务仍在） */
  createdById: string | null;
  runId: string;
}

/**
 * 自动化建的任务附着在规则行上（tasks.subject_type/subject_id 的又一个生产者）。
 * 一石二鸟：观测面（「这条规则 spawn 过哪些任务」走 tasks_subject_idx 读法）+
 * due 触发的防环闸（due-registry 的 task 成员不扫这类任务——「due 触发 →
 * create_task(dueInHours)」不设防会每 ≥5 分钟自增一条任务，同规则与跨规则
 * 的链式自触发一并挡住，人工建的入口不受影响）。
 */
export const AUTOMATION_TASK_SUBJECT_TYPE = "automation_rule";

export async function executeCreateTask(
  db: Pick<Db, "insert">,
  services: ActionServices,
  ctx: ActionContext,
  action: CreateTaskAction,
): Promise<ActionResult> {
  const config = action.config;
  const inserted = await db
    .insert(schema.tasks)
    .values({
      title: config.title,
      ...(config.description !== undefined ? { description: config.description } : {}),
      ...(config.assigneeId !== undefined ? { assigneeId: config.assigneeId } : {}),
      ...(config.dueInHours !== undefined
        ? { dueAt: new Date(Date.now() + config.dueInHours * 3_600_000) }
        : {}),
      createdById: ctx.createdById,
      subjectType: AUTOMATION_TASK_SUBJECT_TYPE,
      subjectId: ctx.ruleId,
    })
    .returning({ id: schema.tasks.id });
  const task = inserted[0];
  if (task === undefined) throw new Error("automation create_task returned no row");
  // 与 API 写路径同一形态的 task.created 审计；actor 带 automation 前缀：
  // 扫描器跳过这类事件（规则触发规则 = 回路）
  await db.insert(schema.auditEvents).values({
    actor: `${AUTOMATION_ACTOR_PREFIX}${ctx.runId}`,
    action: "task.created",
    target: task.id,
    detail: {
      via: "automation",
      ruleId: ctx.ruleId,
      ruleName: ctx.ruleName,
      title: config.title,
      assignee: config.assigneeId ?? null,
    },
  });
  if (config.assigneeId !== undefined) {
    await db.insert(schema.notifications).values({
      userId: config.assigneeId,
      eventType: "task.assigned",
      aggregateType: "task",
      aggregateId: task.id,
      payload: { taskTitle: config.title, actorName: ctx.ruleName },
    });
    await nudgeBells(services, [config.assigneeId]);
  }
  return { type: "create_task", status: "succeeded", ref: task.id };
}

export async function executeNotify(
  db: Pick<Db, "insert">,
  services: ActionServices,
  ctx: ActionContext,
  action: NotifyAction,
): Promise<ActionResult> {
  const config = action.config;
  const userIds = [...new Set(config.userIds)];
  await db.insert(schema.notifications).values(
    userIds.map((userId) => ({
      userId,
      eventType: "automation.notified",
      aggregateType: "automation_rule",
      aggregateId: ctx.ruleId,
      payload: {
        ruleName: ctx.ruleName,
        title: config.title,
        ...(config.body !== undefined ? { body: config.body } : {}),
      },
    })),
  );
  await nudgeBells(services, userIds);
  return { type: "notify", status: "succeeded" };
}
