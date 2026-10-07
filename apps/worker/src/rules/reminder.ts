import { and, asc, eq, inArray, isNull } from "drizzle-orm";
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
 * 待填规则待办提醒（#233 切片 2：§4.2「未定数字以『待填』上线，并在待办中提醒」）。
 *
 * 每日对账扫描，语义是 reconcile 而不是发信：
 * - 还没值的规则（value is null，0011 种子里 8 条）→ 给「谁能改」角色持有者的
 *   我的待办里各保有一条 open 提醒任务；没有该等角色持有者时回落到 owner（owner
 *   恒可改，R-16-5 同源）；连 owner 都没有 → 跳过并告警（一条没人看得见的任务
 *   是假成功，宁可明说）。提醒任务多态附着在规则行上（tasks.subject_type =
 *   'registry_rule'，任务内核附着列的第一个生产者），去重靠 (subject, assignee,
 *   open) 查询，不靠标题字符串。
 * - 值已填上的规则 → 遗留的 open 提醒自动关闭（task.status_changed 审计）。
 *   经办人提前勾掉（done）而值仍空 → 下一轮扫描再建一条：待办的目的就是填值，
 *   值没填 = 没完成，提醒是故意的。
 *
 * 与任务内核（#113）的写入纪律逐条对齐：任务行 + task.created/task.status_changed
 * 审计 + task.assigned 站内通知同事务；实时「催」在提交后发（#110 切片 2），
 * 失败只降级回轮询。actor 用 system:rules-registry（非 uuid actor 的先例是
 * automation:<runId>）——这是系统行为，不是任何用户的行为。
 */

export const RULES_PENDING_REMINDER_JOB = "rules-pending-reminder";

/** 附着列的 subject 类型：规则注册表（第一个挂任务的业务对象） */
export const RULE_REMINDER_SUBJECT_TYPE = "registry_rule";

/** 提醒任务创建/关闭的审计与通知署名 */
export const RULES_REMINDER_ACTOR = "system:rules-registry";

/** 发布用的执行器：worker 自己的连接池即可（与 automations 的 PublishExecutor 同形） */
export interface PublishExecutor {
  query(text: string, values?: unknown[]): Promise<unknown>;
}

export interface ReminderServices {
  db: Db;
  publishExecutor: PublishExecutor;
  logger: Logger;
  /** 总线信封的 instanceId（跨进程广播标记来源实例） */
  instanceId: string;
}

export interface ReminderScanSummary {
  /** 本轮值仍为空的规则数 */
  pendingRules: number;
  /** 新建的提醒任务数（含回落分派的） */
  tasksCreated: number;
  /** 因值已填而关闭的遗留提醒数 */
  tasksClosed: number;
  /** 找不到任何可分派人的规则数（已告警跳过） */
  skippedRules: number;
}

type Tx = Parameters<Db["transaction"]>[0] extends (tx: infer T) => unknown ? T : never;

interface PendingRule {
  id: string;
  key: string;
  label: string;
  valueType: string;
  adjudicationRefs: string[];
  changeableBy: string[];
}

function must<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("unexpected missing value in scan");
  return value;
}

/** 提交后的实时「催」：铃铛重读 summary，读到的就是已提交的数据；失败只降级 */
async function nudgeBells(services: ReminderServices, userIds: string[]): Promise<void> {
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
    services.logger.warn({ err, recipients: userIds.length }, "rules reminder bell nudge failed");
  });
}

/** 规则的「谁能改」角色持有者；无人在场时回落 owner（owner 恒可改） */
async function resolveAssignees(db: Db, rule: PendingRule): Promise<string[]> {
  const holdersFor = async (roles: string[]): Promise<string[]> => {
    const eligible = roles.filter((role): role is (typeof schema.appRole.enumValues)[number] =>
      (schema.appRole.enumValues as readonly string[]).includes(role),
    );
    if (eligible.length === 0) return [];
    const rows = await db
      .selectDistinct({ id: schema.authUser.id })
      .from(schema.authUser)
      .innerJoin(schema.userRole, eq(schema.userRole.userId, schema.authUser.id))
      .where(inArray(schema.userRole.role, eligible));
    return rows.map((row) => row.id);
  };
  const holders = await holdersFor(rule.changeableBy);
  if (holders.length > 0) return holders;
  return holdersFor(["owner"]);
}

/** 一条提醒任务 = 任务行 + task.created 审计 + task.assigned 通知（同事务） */
async function createReminderTask(
  tx: Tx,
  rule: PendingRule,
  assigneeId: string,
): Promise<string> {
  const title = `Fill in registry rule: ${rule.label}`.slice(0, 200);
  const refs = rule.adjudicationRefs.length > 0 ? rule.adjudicationRefs.join(", ") : "none";
  const description =
    `Rule ${rule.key} (${rule.valueType}) launched without a value and is still pending. ` +
    `Adjudication: ${refs}. Set the value in the rules registry.`;
  const inserted = await tx
    .insert(schema.tasks)
    .values({
      title,
      description,
      status: "open",
      assigneeId,
      createdById: null,
      subjectType: RULE_REMINDER_SUBJECT_TYPE,
      subjectId: rule.id,
    })
    .returning({ id: schema.tasks.id });
  const task = must(inserted[0]);
  await tx.insert(schema.auditEvents).values({
    actor: RULES_REMINDER_ACTOR,
    action: "task.created",
    target: task.id,
    detail: {
      via: "rules-reminder",
      ruleKey: rule.key,
      ruleLabel: rule.label,
      assignee: assigneeId,
    },
  });
  await tx.insert(schema.notifications).values({
    userId: assigneeId,
    eventType: "task.assigned",
    aggregateType: "task",
    aggregateId: task.id,
    payload: { taskTitle: title, actorName: "Rules registry" },
  });
  return task.id;
}

/** 对账一轮：见模块注释。返回摘要供任务日志与测试断言 */
export async function runRulesPendingReminderScan(
  services: ReminderServices,
): Promise<ReminderScanSummary> {
  const { db } = services;
  const summary: ReminderScanSummary = {
    pendingRules: 0,
    tasksCreated: 0,
    tasksClosed: 0,
    skippedRules: 0,
  };

  const pendingRows = await db
    .select({
      id: schema.registryRules.id,
      key: schema.registryRules.key,
      label: schema.registryRules.label,
      valueType: schema.registryRules.valueType,
      adjudicationRefs: schema.registryRules.adjudicationRefs,
      changeableBy: schema.registryRules.changeableBy,
    })
    .from(schema.registryRules)
    .where(isNull(schema.registryRules.value))
    .orderBy(asc(schema.registryRules.key));
  const pending: PendingRule[] = pendingRows.map((row) => ({ ...row }));
  summary.pendingRules = pending.length;

  // 关闭阶段：附着在规则上的 open 提醒，其规则已不在待填集合 → 值已填，销账
  const openReminders = await db
    .select({
      id: schema.tasks.id,
      subjectId: schema.tasks.subjectId,
    })
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.subjectType, RULE_REMINDER_SUBJECT_TYPE),
        eq(schema.tasks.status, "open"),
        // 软删行不可见（#29 切片 2）：删掉的提醒不参与销账对账——它的规则若
        // 仍待填，确保阶段会重建一条，与「提前 done 而值仍空」同一纪律
        isNull(schema.tasks.deletedAt),
      ),
    );
  const pendingIds = new Set(pending.map((rule) => rule.id));
  const stale = openReminders.flatMap((task) => {
    const subjectId = task.subjectId;
    if (subjectId === null || pendingIds.has(subjectId)) return [];
    return [{ taskId: task.id, subjectId }];
  });
  if (stale.length > 0) {
    const ruleKeys = await db
      .select({ id: schema.registryRules.id, key: schema.registryRules.key })
      .from(schema.registryRules)
      .where(inArray(schema.registryRules.id, [...new Set(stale.map((s) => s.subjectId))]));
    const keyById = new Map(ruleKeys.map((row) => [row.id, row.key]));
    for (const item of stale) {
      await db.transaction(async (tx) => {
        await tx
          .update(schema.tasks)
          .set({ status: "done", updatedAt: new Date() })
          .where(eq(schema.tasks.id, item.taskId));
        await tx.insert(schema.auditEvents).values({
          actor: RULES_REMINDER_ACTOR,
          action: "task.status_changed",
          target: item.taskId,
          detail: {
            via: "rules-reminder",
            ruleKey: keyById.get(item.subjectId) ?? null,
            from: "open",
            to: "done",
          },
        });
      });
      summary.tasksClosed += 1;
    }
  }

  // 确保阶段：每条待填规则 × 每个可分派人，缺一条 open 提醒就补一条
  const nudged: string[] = [];
  for (const rule of pending) {
    const assignees = await resolveAssignees(db, rule);
    if (assignees.length === 0) {
      summary.skippedRules += 1;
      services.logger.warn(
        { ruleKey: rule.key, changeableBy: rule.changeableBy },
        "pending rule has no assignable user; reminder skipped",
      );
      continue;
    }
    const existing = await db
      .select({ assigneeId: schema.tasks.assigneeId })
      .from(schema.tasks)
      .where(
        and(
          eq(schema.tasks.subjectType, RULE_REMINDER_SUBJECT_TYPE),
          eq(schema.tasks.subjectId, rule.id),
          eq(schema.tasks.status, "open"),
          isNull(schema.tasks.deletedAt),
        ),
      );
    const covered = new Set(
      existing.flatMap((row) => (row.assigneeId === null ? [] : [row.assigneeId])),
    );
    for (const assignee of assignees) {
      if (covered.has(assignee)) continue;
      await db.transaction(async (tx) => {
        await createReminderTask(tx, rule, assignee);
      });
      nudged.push(assignee);
      summary.tasksCreated += 1;
    }
  }

  if (nudged.length > 0) {
    await nudgeBells(services, [...new Set(nudged)]);
  }
  return summary;
}
