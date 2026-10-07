import type { Logger } from "pino";
import {
  NOTIFICATIONS_CHANGED_EVENT,
  REALTIME_LISTEN_CHANNEL,
  encodeBusEnvelope,
  userChannel,
  type RealtimeBusPayload,
} from "@ally/realtime";
import type { ActionResult, CreateTaskAction, NotifyAction, SendEmailAction } from "@ally/automations";
import { AUTOMATION_ACTOR_PREFIX } from "@ally/automations";
import { escapeHtml, htmlToPlainText, type Mailer } from "@ally/mailer";
import { inArray } from "drizzle-orm";
import { schema, type Db } from "@ally/db";

/**
 * 动作执行器（#224 的内核动作：建任务、发通知、发邮件）。
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
  /** 邮件通道（#116 渠道层的 @ally/mailer；send_email 动作的唯一传输） */
  mailer: Mailer;
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

/** 动作的非 DB 依赖（发布执行器、邮件通道、日志、实例标识）——与 db 通道分开注入 */
export interface ActionServices {
  /** pg_notify 总线的发布执行器（与 packages/realtime RealtimeBus.publish 同一条 SQL） */
  publishExecutor: PublishExecutor;
  logger: Logger;
  /** 总线信封的 instanceId（跨进程广播标记来源实例，worker 启动时生成） */
  instanceId: string;
  /** 邮件通道（@ally/mailer；未配 Resend key 时是日志模式，动作照样「成功」） */
  mailer: Mailer;
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

/** 邮件正文的 HTML 形态：作者写的是纯文本，转义后换行成 <br>，尾注署名规则 */
function renderEmailBody(body: string, ruleName: string): { html: string; text: string } {
  const html =
    `<p>${escapeHtml(body).replace(/\n/g, "<br>")}</p>` +
    `<p style="color:#6b7280;font-size:12px">` +
    `Sent automatically by the Ally OS rule &quot;${escapeHtml(ruleName)}&quot;.</p>`;
  return { html, text: htmlToPlainText(html) };
}

/**
 * send_email 动作（#224 切片 4，#116 渠道层解锁）：收件人按 id 解析账号邮箱，
 * 逐人一封（收件人之间不见地址），传输走 @ally/mailer——未配 Resend key 时是
 * 日志模式（动作照样成功，本地开发可从日志取信），与老系统「传输只是接缝、
 * 内容是调用方策略」的 comms 裁法同构，但这里没有第二套传输。
 *
 * 投递语义是 at-least-once：信是真金白银的外部副作用，丢了比重复更糟——
 * 部分收件人发送失败时动作失败进重试，已收到的重试后会再收到一封（窗口 =
 * 第一个失败点之前的收件人）；铃铛「催」的 at-most-once 与此刻意相反，便宜的
 * 加速器可以丢，付费的信不能凭空消失。发送在 runner 的动作事务内：事务回滚
 * （如 action_results 写失败）同样可能重发，同一个语义。
 *
 * 收件人被删 = 抛错进重试协议（重试耗尽终判 failed + 告警），不静默跳过——
 * 「少发一个人」必须有人看见。邮件本身不写审计、不进通知表：发送事实在
 * automation_runs 的 action_results 里（与 notify 的通知行即台账同一裁法）。
 */
export async function executeSendEmail(
  db: Pick<Db, "select">,
  services: ActionServices,
  ctx: ActionContext,
  action: SendEmailAction,
): Promise<ActionResult> {
  const config = action.config;
  const userIds = [...new Set(config.userIds)];
  const rows = await db
    .select({ id: schema.authUser.id, email: schema.authUser.email })
    .from(schema.authUser)
    .where(inArray(schema.authUser.id, userIds));
  const emailById = new Map(rows.map((row) => [row.id, row.email]));
  const missing = userIds.filter((id) => !emailById.has(id));
  if (missing.length > 0) {
    throw new Error(`send_email recipients no longer exist: ${missing.join(",")}`);
  }
  const { html, text } = renderEmailBody(config.body, ctx.ruleName);
  for (const id of userIds) {
    const to = emailById.get(id);
    if (to === undefined) throw new Error(`send_email recipient vanished mid-send: ${id}`);
    await services.mailer.send({ to, subject: config.subject, html, text });
  }
  return { type: "send_email", status: "succeeded" };
}
