import { and, asc, eq, inArray, sql } from "drizzle-orm";
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
 * 审批催办（#221「pg-boss 催办」；§4.9「执行放在 pg-boss，和现有后台作业共用
 * 一套重试与告警」）。每小时对账扫描：在飞请求在本级停满 24h 没人裁 → 给当前级
 * 审批人各落一行 approval.reminder 通知（铃铛 + 开了摘要的进每日邮件），再催要
 * 隔另一个 24h；级推进后按新级重新计时（台账在 approval_requests.last_reminder_*，
 * 与通知行 digest_sent_at 同一裁法：台账在行上，重试与重扫不重复投递）。
 *
 * 语义是「轮到谁还没裁」而不是「过期作废」：审批没有超时拒绝——业务自批（R-16-5）
 * 之下没人有权替审批人做决定，催办只是把「这儿等着」的事实再递一次。
 *
 * worker 不跨 app 依赖（apps/api 的审批内核过不来），levels 快照在这里用**窄
 * 读取 schema** 投影出提醒需要的三个字段（name/users/roles）——写面的完整校验
 * 仍是 api 的 approvalLevelsSchema 一处收口；读不准的快照跳过并告警（一条没人
 * 看得见的提醒是假成功，与规则待办提醒同一姿态）。审批人集合 = 点名 users ∪
 * 角色持有者（app_role 枚举过滤，与 api 侧同一防御）；空集合跳过并告警。
 *
 * 通知行只存事实（configName/levelName/waitingHours/detail），不带服务端文案；
 * 提交后对收件人做一次实时「催」（rules-pending-reminder 同一通道），失败只
 * 降级轮询。
 */

export const APPROVAL_REMINDERS_JOB = "approval-reminders";

/** 本级停满多久开始催；催过之后再隔多久催下一轮（同一个节奏：24h 一轮） */
export const APPROVAL_REMIND_AFTER_MS = 24 * 60 * 60 * 1000;

/** 提醒的窄读取 schema：只认提醒需要的字段，多余字段不拒（快照由写面负责） */
const reminderLevelSchema = z.object({
  name: z.string(),
  users: z.array(z.string()).default([]),
  roles: z.array(z.string()).default([]),
});
const reminderLevelsSchema = z.array(reminderLevelSchema).min(1);

/** 发布用的执行器：worker 自己的连接池即可（与 automations 的 PublishExecutor 同形） */
export interface PublishExecutor {
  query(text: string, values?: unknown[]): Promise<unknown>;
}

export interface ApprovalReminderServices {
  db: Db;
  publishExecutor: PublishExecutor;
  logger: Logger;
  /** 总线信封的 instanceId（跨进程广播标记来源实例） */
  instanceId: string;
  /** 测试注入；缺省真时钟 */
  now?: () => Date;
}

export interface ApprovalReminderScanSummary {
  /** 本轮在飞请求数 */
  pendingRequests: number;
  /** 停满时限且到了再催间隔的请求数 */
  dueRequests: number;
  /** 落库的提醒通知行数 */
  remindersSent: number;
  /** 快照读不出 / 当前级越界 / 审批人集合为空的请求数（已告警跳过） */
  skippedRequests: number;
}

/** 提交后的实时「催」：铃铛重读 summary，读到的就是已落库的提醒；失败只降级 */
async function nudgeBells(services: ApprovalReminderServices, userIds: string[]): Promise<void> {
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
    services.logger.warn({ err, recipients: userIds.length }, "approval reminder bell nudge failed");
  });
}

/** 点名 users ∪ 角色持有者；角色按 app_role 枚举过滤（与 api 侧同一防御） */
async function resolveAdjudicatorIds(db: Db, level: { users: string[]; roles: string[] }): Promise<string[]> {
  const eligible = level.roles.filter((role): role is (typeof schema.appRole.enumValues)[number] =>
    (schema.appRole.enumValues as readonly string[]).includes(role),
  );
  const holders =
    eligible.length === 0
      ? []
      : await db
          .selectDistinct({ id: schema.authUser.id })
          .from(schema.authUser)
          .innerJoin(schema.userRole, eq(schema.userRole.userId, schema.authUser.id))
          .where(inArray(schema.userRole.role, eligible));
  return [...new Set([...level.users, ...holders.map((row) => row.id)])];
}

/** 对账一轮：见模块注释。返回摘要供任务日志与测试断言 */
export async function runApprovalReminderScan(services: ApprovalReminderServices): Promise<ApprovalReminderScanSummary> {
  const now = services.now ?? (() => new Date());
  const summary: ApprovalReminderScanSummary = {
    pendingRequests: 0,
    dueRequests: 0,
    remindersSent: 0,
    skippedRequests: 0,
  };
  const { db } = services;

  const pendingRows = await db
    .select({
      id: schema.approvalRequests.id,
      configKey: schema.approvalRequests.configKey,
      configName: schema.approvalConfigs.name,
      subjectType: schema.approvalRequests.subjectType,
      subjectId: schema.approvalRequests.subjectId,
      levels: schema.approvalRequests.levels,
      currentStep: schema.approvalRequests.currentStep,
      createdAt: schema.approvalRequests.createdAt,
      lastReminderAt: schema.approvalRequests.lastReminderAt,
      lastReminderStep: schema.approvalRequests.lastReminderStep,
    })
    .from(schema.approvalRequests)
    .innerJoin(schema.approvalConfigs, eq(schema.approvalRequests.configId, schema.approvalConfigs.id))
    .where(eq(schema.approvalRequests.status, "pending"))
    .orderBy(asc(schema.approvalRequests.createdAt));
  summary.pendingRequests = pendingRows.length;
  if (pendingRows.length === 0) return summary;

  // 在飞请求上已存在的 action 都是已完成级（当前级还没有 action 行）：
  // max(createdAt) 即进入当前级的时刻，首级没有 action → 回落提交时刻。
  // 裸 sql 聚合不走列类型映射，返回 ISO 串——用 new Date 归一（Date 入参也兼容）
  const enteredRows = await db
    .select({
      requestId: schema.approvalActions.requestId,
      enteredAt: sql<string>`max(${schema.approvalActions.createdAt})`,
    })
    .from(schema.approvalActions)
    .where(inArray(schema.approvalActions.requestId, pendingRows.map((row) => row.id)))
    .groupBy(schema.approvalActions.requestId);
  const enteredById = new Map(enteredRows.map((row) => [row.requestId, new Date(row.enteredAt)]));

  const nowMs = now().getTime();
  const nudged = new Set<string>();
  for (const row of pendingRows) {
    const parsed = reminderLevelsSchema.safeParse(row.levels);
    const level = parsed.success ? parsed.data[row.currentStep] : undefined;
    if (!parsed.success || level === undefined) {
      summary.skippedRequests += 1;
      services.logger.warn(
        { requestId: row.id, currentStep: row.currentStep },
        "approval request has unreadable levels snapshot; reminder skipped",
      );
      continue;
    }
    const enteredAt = enteredById.get(row.id) ?? row.createdAt;
    const waitingMs = nowMs - enteredAt.getTime();
    if (waitingMs < APPROVAL_REMIND_AFTER_MS) continue;
    const remindedThisStep =
      row.lastReminderStep === row.currentStep &&
      row.lastReminderAt !== null &&
      nowMs - row.lastReminderAt.getTime() < APPROVAL_REMIND_AFTER_MS;
    if (remindedThisStep) continue;

    const adjudicators = await resolveAdjudicatorIds(db, level);
    if (adjudicators.length === 0) {
      summary.skippedRequests += 1;
      services.logger.warn(
        { requestId: row.id, level: level.name, users: level.users, roles: level.roles },
        "approval level has no resolvable adjudicator; reminder skipped",
      );
      continue;
    }

    // 盖章先行并带 current_step/status 条件：扫描期间请求被推进或关闭 → 本轮
    // 不催（update 匹配 0 行），通知行与台账同一事务，要么都在要么都不在
    const stamped = await db.transaction(async (tx) => {
      const updated = await tx
        .update(schema.approvalRequests)
        .set({ lastReminderAt: new Date(nowMs), lastReminderStep: row.currentStep })
        .where(
          and(
            eq(schema.approvalRequests.id, row.id),
            eq(schema.approvalRequests.status, "pending"),
            eq(schema.approvalRequests.currentStep, row.currentStep),
          ),
        )
        .returning({ id: schema.approvalRequests.id });
      if (updated[0] === undefined) return false;
      await tx.insert(schema.notifications).values(
        adjudicators.map((userId) => ({
          userId,
          eventType: "approval.reminder",
          aggregateType: "approval_request",
          aggregateId: row.id,
          payload: {
            subjectType: row.subjectType,
            subjectId: row.subjectId,
            configKey: row.configKey,
            configName: row.configName,
            levelName: level.name,
            waitingHours: Math.floor(waitingMs / 3_600_000),
            detail: `${row.configName} · ${level.name}`,
          },
        })),
      );
      return true;
    });
    if (!stamped) continue;
    summary.dueRequests += 1;
    summary.remindersSent += adjudicators.length;
    for (const userId of adjudicators) nudged.add(userId);
  }

  if (nudged.size > 0) {
    await nudgeBells(services, [...nudged]);
  }
  return summary;
}
