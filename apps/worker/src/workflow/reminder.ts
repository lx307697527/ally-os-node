import { and, asc, eq, inArray, isNull, lte, or } from "drizzle-orm";
import { z } from "zod";
import type { Logger } from "pino";
import {
  NOTIFICATIONS_CHANGED_EVENT,
  REALTIME_LISTEN_CHANNEL,
  encodeBusEnvelope,
  userChannel,
  type RealtimeBusPayload,
} from "@ally/realtime";
import { schema, type Db } from "@ally/db";

/**
 * 流程超时提醒（#220「超时后负责人收到提醒」的投递半边；§4.9「执行放在 pg-boss」）。
 * 每小时对账扫描：实例在当前状态停留超过 timeoutAfterHours（stateDueAt 已在进入
 * 状态时一次算好）→ 给「负责人」各落一行 workflow.state_overdue 通知（铃铛 +
 * 开了摘要的进每日邮件），再催要隔另一个 24h；推进后按新占用重置计时（台账在
 * workflow_instances.state_reminder_at，推进方随进状态一次写 null，与
 * approval_requests.last_reminder_* 同一裁法：台账在行上，盖章带 currentState
 * 条件，扫描期间被推进的不催、重试与重扫不重复投递）。
 *
 * 「负责人」在内核的读法 = 发起人（started_by）∪ **能推当前状态的角色持有者**
 * （当前状态出边流转上 roles 的并集——催「轮到谁还没推」，与审批催办催当前级
 * 审批人是同一语义）。未限角色的出边（可见者中的员工皆可推）不贡献收件人——
 * 那等于给全员工发信；属主域进场后若「负责人」另有其人（如客户负责人），由
 * 属主域在自己的扇出里补，内核不猜。
 *
 * worker 不跨 app 依赖（apps/api 的流程内核过不来），definition 快照在这里用
 * **窄读取 schema** 投影出收件人需要的字段（states → on → roles）——快照在启动
 * 时刻已过保存面四门校验，读不准的跳过并告警（一条没人看得见的提醒是假成功，
 * 与审批 levels 快照同一姿态）。流转收字符串简写与对象两种形态（保存面存的是
 * 原始定义，归一发生在 api 引擎里，worker 读原始形状）。
 *
 * 通知行只存事实（templateKey/stateName/dueAt/waitingHours/title/detail），不带
 * 服务端文案表。流程还没有承载页，刻意不进铃铛白名单——payload 带 title/detail
 * 走兜底面（approval.completed 与 #193 失败付款提醒的同款裁决），摘要按事实渲染。
 * 提交后对收件人做一次实时「催」（approval-reminders 同一通道），失败只降级轮询。
 */

export const WORKFLOW_TIMEOUT_REMINDERS_JOB = "workflow-timeout-reminders";

/** 停满多久（stateDueAt 起）算超时到期由模板的 timeoutAfterHours 决定；本常量是
 * 「催过之后再隔多久催下一轮」（与审批催办同一节奏：24h 一轮） */
export const WORKFLOW_REMIND_AFTER_MS = 24 * 60 * 60 * 1000;

/** 提醒的窄读取 schema：只认收件人需要的字段；快照由 api 保存面负责，多余
 * 字段（gates/requireNote/entryActions/timeoutAfterHours）不拒 */
const reminderDefinitionSchema = z.object({
  states: z.record(
    z.string(),
    z.object({
      on: z
        .record(
          z.string(),
          z.union([
            z.string(),
            z.object({ roles: z.array(z.string()).optional() }),
          ]),
        )
        .optional(),
    }),
  ),
});

/** 发布用的执行器：worker 自己的连接池即可（approval-reminders 同形） */
export interface PublishExecutor {
  query(text: string, values?: unknown[]): Promise<unknown>;
}

export interface WorkflowReminderServices {
  db: Db;
  publishExecutor: PublishExecutor;
  logger: Logger;
  /** 总线信封的 instanceId（跨进程广播标记来源实例） */
  instanceId: string;
  /** 测试注入；缺省真时钟 */
  now?: () => Date;
}

export interface WorkflowReminderScanSummary {
  /** 本轮超时在飞的实例数（stateDueAt 已过且到了再催间隔） */
  dueInstances: number;
  /** 落库的提醒通知行数 */
  remindersSent: number;
  /** 快照读不出 / 收件人集合为空的实例数（已告警跳过） */
  skippedInstances: number;
}

/** 提交后的实时「催」：铃铛重读 summary，读到的就是已落库的提醒；失败只降级 */
async function nudgeBells(services: WorkflowReminderServices, userIds: string[]): Promise<void> {
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
    services.logger.warn({ err, recipients: userIds.length }, "workflow reminder bell nudge failed");
  });
}

/** 当前状态出边上 roles 的并集（字符串简写出边无限角色，不贡献收件人） */
function outboundRoles(parsed: z.infer<typeof reminderDefinitionSchema>, currentState: string): string[] {
  const state = parsed.states[currentState];
  const roles = new Set<string>();
  for (const transition of Object.values(state?.on ?? {})) {
    if (typeof transition === "string") continue;
    for (const role of transition.roles ?? []) roles.add(role);
  }
  return [...roles];
}

/** 角色按 app_role 枚举过滤（与 api 侧同一防御），查持有者去重 */
async function resolveRoleHolderIds(db: Db, roles: string[]): Promise<string[]> {
  const eligible = roles.filter((role): role is (typeof schema.appRole.enumValues)[number] =>
    (schema.appRole.enumValues as readonly string[]).includes(role),
  );
  if (eligible.length === 0) return [];
  const holders = await db
    .selectDistinct({ id: schema.authUser.id })
    .from(schema.authUser)
    .innerJoin(schema.userRole, eq(schema.userRole.userId, schema.authUser.id))
    .where(inArray(schema.userRole.role, eligible));
  return holders.map((row) => row.id);
}

/** 对账一轮：见模块注释。返回摘要供任务日志与测试断言 */
export async function runWorkflowTimeoutScan(services: WorkflowReminderServices): Promise<WorkflowReminderScanSummary> {
  const now = services.now ?? (() => new Date());
  const summary: WorkflowReminderScanSummary = {
    dueInstances: 0,
    remindersSent: 0,
    skippedInstances: 0,
  };
  const { db } = services;
  const nowMs = now().getTime();

  // 超时且到了再催间隔的：stateDueAt 已过 + （从未催过 或 上次催满 24h）。
  // lte 把 SQL 空值挡在外面（NULL 比较为假）；stateDueAt 为 null 的状态没配
  // 超时，无提醒语义，结构性不进结果集
  const dueRows = await db
    .select({
      id: schema.workflowInstances.id,
      subjectType: schema.workflowInstances.subjectType,
      subjectId: schema.workflowInstances.subjectId,
      templateKey: schema.workflowInstances.templateKey,
      currentState: schema.workflowInstances.currentState,
      stateEnteredAt: schema.workflowInstances.stateEnteredAt,
      stateDueAt: schema.workflowInstances.stateDueAt,
      startedById: schema.workflowInstances.startedById,
      definition: schema.workflowInstances.definition,
    })
    .from(schema.workflowInstances)
    .where(
      and(
        lte(schema.workflowInstances.stateDueAt, now()),
        or(
          isNull(schema.workflowInstances.stateReminderAt),
          lte(schema.workflowInstances.stateReminderAt, new Date(nowMs - WORKFLOW_REMIND_AFTER_MS)),
        ),
      ),
    )
    .orderBy(asc(schema.workflowInstances.stateDueAt))
    .limit(200);
  if (dueRows.length === 0) return summary;

  // 角色集 → 持有者的去重缓存：同模板同状态的到期实例共享同一组出边角色，逐行
  // 问库是一次扫描内的 N+1；键排序归一（inArray 不看顺序），同名角色集只问一次
  const holdersCache = new Map<string, Promise<string[]>>();
  const holdersFor = (roles: string[]): Promise<string[]> => {
    const key = JSON.stringify([...roles].sort());
    const cached = holdersCache.get(key);
    if (cached !== undefined) return cached;
    const pending = resolveRoleHolderIds(db, roles);
    holdersCache.set(key, pending);
    return pending;
  };

  const nudged = new Set<string>();
  for (const row of dueRows) {
    const dueAt = row.stateDueAt;
    if (dueAt === null) continue;
    const parsed = reminderDefinitionSchema.safeParse(row.definition);
    if (!parsed.success) {
      summary.skippedInstances += 1;
      services.logger.warn(
        { instanceId: row.id, currentState: row.currentState },
        "workflow instance has unreadable definition snapshot; reminder skipped",
      );
      continue;
    }
    // 收件人 = 发起人 ∪ 能推当前状态的角色持有者（并集去重；发起人行随用户删除
    // 而 set null，集合可空性在下面统一裁）
    const starter = row.startedById;
    const roleHolders = await holdersFor(outboundRoles(parsed.data, row.currentState));
    const recipients = [...new Set([...(starter === null ? [] : [starter]), ...roleHolders])];
    if (recipients.length === 0) {
      summary.skippedInstances += 1;
      services.logger.warn(
        { instanceId: row.id, templateKey: row.templateKey, currentState: row.currentState },
        "workflow instance has no resolvable responsible person; reminder skipped",
      );
      continue;
    }
    const waitingHours = Math.max(0, Math.floor((nowMs - row.stateEnteredAt.getTime()) / 3_600_000));

    // 盖章先行并带 currentState 条件：扫描期间实例被推进 → 本轮不催（update 匹配
    // 0 行），通知行与台账同一事务，要么都在要么都不在
    const stamped = await db.transaction(async (tx) => {
      const updated = await tx
        .update(schema.workflowInstances)
        .set({ stateReminderAt: new Date(nowMs) })
        .where(
          and(
            eq(schema.workflowInstances.id, row.id),
            eq(schema.workflowInstances.currentState, row.currentState),
          ),
        )
        .returning({ id: schema.workflowInstances.id });
      if (updated[0] === undefined) return false;
      await tx.insert(schema.notifications).values(
        recipients.map((userId) => ({
          userId,
          eventType: "workflow.state_overdue",
          aggregateType: "workflow_instance",
          aggregateId: row.id,
          payload: {
            subjectType: row.subjectType,
            subjectId: row.subjectId,
            templateKey: row.templateKey,
            stateName: row.currentState,
            dueAt: dueAt.toISOString(),
            waitingHours,
            title: `${row.templateKey} has been in "${row.currentState}"`,
            detail: `${row.templateKey} · ${row.currentState}`,
          },
        })),
      );
      return true;
    });
    if (!stamped) continue;
    summary.dueInstances += 1;
    summary.remindersSent += recipients.length;
    for (const userId of recipients) nudged.add(userId);
  }

  if (nudged.size > 0) {
    await nudgeBells(services, [...nudged]);
  }
  return summary;
}
