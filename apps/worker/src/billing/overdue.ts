import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
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
 * 发票逾期对账扫描（#192 剩余清单③的 due 扫描半边；R-12-7「逾期由财务人工催，
 * 系统不发催款」）。
 *
 * 每日 13:10 UTC 一轮（排在 rules 13:00 之后、通知摘要 13:30 之前——逾期的
 * 铃铛当天就能进摘要）：issued 且有到期日（due_at 非空——terms 是确认发出时
 * 财务给的，未约定账期的票没有「到期」可言，老系统「NULL = 未约定」同款语义）
 * 且到期已过、还有钱没收齐（paid < total，付款态派生值不落列，扫描时对候选
 * 集实时 SUM——$0 票 vacuously paid 不进结果集）→ 给财务（invoices.manage
 * 持有者）各落一行 invoice.overdue 通知，再催隔 24h（workflow/approval 催办
 * 同一节奏）。
 *
 * **只提醒内部，不发客户催款**：R-12-7 的前半（到期前提醒客户）随客户门户与
 * 渠道层接线——没有收件人的邮件不存在。老系统对照 FEAT-765（stage 1/7/30 天
 * 三档 + Slack 日报）：档位节奏与 Slack 面刻意不搬——统一 24h 再催与既有催办
 * 裁法一致，Slack 告警通道留给 job 失败（runner.ts），业务提醒走通知域。
 *
 * 台账在 invoices.overdue_reminder_at（扫描选中后盖章、通知行同事务落库）。
 * 付清不清零台账：收款是派生值，付清的票由 paid >= total 过滤结构性出局——
 * 台账只回答「上次催是什么时候」，不回答「还欠不欠」。条件盖章带 status =
 * 'issued'：当前状态机 issued 是终态（红冲是未来的新动词、不是对已发行的
 * 改写），这是范式防御不是现实竞争窗口——扫描期间票不会离开 issued。
 *
 * worker 不跨 app 依赖（apps/api 的 billing 内核过不来），候选集与收件人在
 * 这里用窄读取投影（workflow/reminder.ts 同一姿态）；金额格式化镜像
 * apps/api/src/billing/payment-alerts.ts 的 formatMoney（同一语义的兄弟副本，
 * 两处各自拥有自己的渲染面）。
 */

export const INVOICE_OVERDUE_REMINDERS_JOB = "invoice-overdue-reminders";

/** 催过之后再隔多久催下一轮（24h——与审批催办/流程超时提醒同一节奏） */
export const OVERDUE_REMIND_AFTER_MS = 24 * 60 * 60 * 1000;

/** 一轮最多处理的票数（逾期是稀疏集；溢出留给下一轮，order by due_at 催最老的） */
const SCAN_BATCH_LIMIT = 200;

/** 发布用的执行器：worker 自己的连接池即可（approval/workflow reminders 同形） */
export interface PublishExecutor {
  query(text: string, values?: unknown[]): Promise<unknown>;
}

export interface OverdueScanServices {
  db: Db;
  publishExecutor: PublishExecutor;
  logger: Logger;
  /** 总线信封的 instanceId（跨进程广播标记来源实例） */
  instanceId: string;
  /** 测试注入；缺省真时钟 */
  now?: () => Date;
}

export interface OverdueScanSummary {
  /** 本轮逾期且到了再催间隔的票数（落了提醒的） */
  overdueInvoices: number;
  /** 落库的提醒通知行数 */
  remindersSent: number;
  /** 无收件人而跳过的票数（已告警——没人看得见的提醒是假成功） */
  skippedInvoices: number;
}

/** 提交后的实时「催」：铃铛重读 summary，读到的就是已落库的提醒；失败只降级 */
async function nudgeBells(services: OverdueScanServices, userIds: string[]): Promise<void> {
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
    services.logger.warn({ err, recipients: userIds.length }, "invoice overdue bell nudge failed");
  });
}

/**
 * invoices.manage 持有者（收件人）：owner/finance 角色默认 + user_permission
 * 个人授权，去重升序——apps/api invoiceAlertRecipients 的同一矩阵，worker 侧
 * 窄读取（不跨 app import）。
 */
export async function overdueRecipients(db: Db): Promise<string[]> {
  const byRole = await db
    .select({ id: schema.userRole.userId })
    .from(schema.userRole)
    .where(inArray(schema.userRole.role, ["owner", "finance"]));
  const byGrant = await db
    .select({ id: schema.userPermission.userId })
    .from(schema.userPermission)
    .where(eq(schema.userPermission.permission, "invoices.manage"));
  return [...new Set([...byRole.map((row) => row.id), ...byGrant.map((row) => row.id)])].sort();
}

/** 整数分 → 人类金额（USD 1,500.00）——payment-alerts.formatMoney 的兄弟副本 */
export function formatMoneyCents(amountCents: number, currency: string): string {
  const abs = Math.abs(amountCents);
  const dollars = `${Math.floor(abs / 100).toLocaleString("en-US")}.${String(abs % 100).padStart(2, "0")}`;
  return `${currency.toUpperCase()} ${dollars}`;
}

/** 逾期行的两个事实字段（payload.title/detail；通知域的既定读法） */
export function overdueTitle(invoiceNumber: string): string {
  return `Invoice ${invoiceNumber} is overdue`;
}

export function overdueDetail(
  outstandingCents: number,
  currency: string,
  dueAt: Date,
): string {
  const dueDate = dueAt.toISOString().slice(0, 10);
  return `${formatMoneyCents(outstandingCents, currency)} outstanding — was due ${dueDate}`;
}

/** dedupe_key 的日粒度成分（UTC）：同一天内结构上最多一行/人，台账之外的第二道幂等 */
function dayKey(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** 对账一轮：见模块注释。返回摘要供任务日志与测试断言 */
export async function runInvoiceOverdueScan(services: OverdueScanServices): Promise<OverdueScanSummary> {
  const now = services.now ?? (() => new Date());
  const nowAt = now();
  const summary: OverdueScanSummary = {
    overdueInvoices: 0,
    remindersSent: 0,
    skippedInvoices: 0,
  };
  const { db } = services;

  // 到期已过 + （从未催过 或 上次催满 24h）。lte 把 SQL 空值挡在外面：due_at 为
  // null 的票未约定账期，结构性不进结果集（部分索引 invoices_issued_due_idx）
  const candidates = await db
    .select({
      id: schema.invoices.id,
      number: schema.invoices.number,
      currency: schema.invoices.currency,
      dueAt: schema.invoices.dueAt,
    })
    .from(schema.invoices)
    .where(
      and(
        eq(schema.invoices.status, "issued"),
        lte(schema.invoices.dueAt, nowAt),
        or(
          isNull(schema.invoices.overdueReminderAt),
          lte(schema.invoices.overdueReminderAt, new Date(nowAt.getTime() - OVERDUE_REMIND_AFTER_MS)),
        ),
      ),
    )
    .orderBy(asc(schema.invoices.dueAt))
    .limit(SCAN_BATCH_LIMIT);
  if (candidates.length === 0) return summary;

  // 付款态实时派生（不落列的裁决）：对候选集两条分组查询 + JS 合并——不用相关
  // 子查询（drizzle sql`` 渲染裸列名会被内层表影子化，列表读法踩过的坑）
  const ids = candidates.map((row) => row.id);
  const lineSums = await db
    .select({
      invoiceId: schema.invoiceLines.invoiceId,
      total: sql<string>`coalesce(sum(${schema.invoiceLines.lineTotalCents}), 0)`,
    })
    .from(schema.invoiceLines)
    .where(inArray(schema.invoiceLines.invoiceId, ids))
    .groupBy(schema.invoiceLines.invoiceId);
  const paidSums = await db
    .select({
      invoiceId: schema.payments.invoiceId,
      paid: sql<string>`coalesce(sum(${schema.payments.amountCents}), 0)`,
    })
    .from(schema.payments)
    .where(and(isNull(schema.payments.voidedAt), inArray(schema.payments.invoiceId, ids)))
    .groupBy(schema.payments.invoiceId);
  const totals = new Map(lineSums.map((row) => [row.invoiceId, Number(row.total)]));
  const paids = new Map(paidSums.map((row) => [row.invoiceId, Number(row.paid)]));

  // 还欠钱的才催：paid >= total（含超收、$0 票 vacuously paid）没有逾期语义
  const overdue = candidates.filter((row) => {
    const paid = paids.get(row.id) ?? 0;
    return paid < (totals.get(row.id) ?? 0);
  });
  if (overdue.length === 0) return summary;

  const recipients = await overdueRecipients(db);
  if (recipients.length === 0) {
    // 没人可投：一张都不催（不是只催一张——收件人是部署态不是票的属性），告警
    summary.skippedInvoices = overdue.length;
    services.logger.warn(
      { invoices: overdue.length },
      "invoice overdue scan has no recipients; reminders skipped",
    );
    return summary;
  }

  const nudged = new Set<string>();
  for (const row of overdue) {
    const dueAt = row.dueAt;
    if (dueAt === null) continue;
    const totalCents = totals.get(row.id) ?? 0;
    const paidCents = paids.get(row.id) ?? 0;
    const outstandingCents = totalCents - paidCents;

    // 盖章先行并带 status 条件（范式见模块注释）：update 匹配 0 行 = 本轮不催，
    // 通知行与台账同一事务，要么都在要么都不在
    const stamped = await db.transaction(async (tx) => {
      const updated = await tx
        .update(schema.invoices)
        .set({ overdueReminderAt: nowAt })
        .where(
          and(
            eq(schema.invoices.id, row.id),
            eq(schema.invoices.status, "issued"),
          ),
        )
        .returning({ id: schema.invoices.id });
      if (updated[0] === undefined) return false;
      await tx
        .insert(schema.notifications)
        .values(
          recipients.map((userId) => ({
            userId,
            eventType: "invoice.overdue",
            aggregateType: "invoice",
            aggregateId: row.id,
            payload: {
              title: overdueTitle(row.number),
              detail: overdueDetail(outstandingCents, row.currency, dueAt),
              invoiceNumber: row.number,
              dueAt: dueAt.toISOString(),
              daysOverdue: Math.max(0, Math.floor((nowAt.getTime() - dueAt.getTime()) / 86_400_000)),
              outstandingCents,
              currency: row.currency,
            },
            dedupeKey: `invoice-overdue:${row.id}:${dayKey(nowAt)}`,
          })),
        )
        .onConflictDoNothing();
      return true;
    });
    if (!stamped) continue;
    summary.overdueInvoices += 1;
    summary.remindersSent += recipients.length;
    for (const userId of recipients) nudged.add(userId);
  }

  if (nudged.size > 0) {
    await nudgeBells(services, [...nudged]);
  }
  return summary;
}
