import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Logger } from "pino";
import type { Mailer, MailMessage } from "@ally/mailer";
import type { Db } from "@ally/db";
import { schema } from "@ally/db";

/**
 * 通知邮件摘要（#116 渠道层的首个额外渠道）。设计 §11「应用内实时、邮件摘要、
 * Slack，每人可选渠道」的投递一半：对开了 email_digest 的人，把「还没进过任何
 * 摘要」的未读通知攒成每日一封。
 *
 * 与老系统的对应：老系统没有邮件通知通道（站内信止步于 platform.notifications）；
 * 这里是 greenfield，但语义沿用它的裁定——通知行存事实（event_type + payload），
 * 文案在消费侧。摘要邮件是消费侧的一种：只渲染事实（类型 + payload 里的事实
 * 字段 + 时间），不做 web 铃铛那份文案表（那是前端展示层的资产，服务端复制一份
 * 就是两处漂移；深链 per-item 等共享 face 包与 #115 Slack 一起进场）。
 *
 * 投递语义：
 * - 行级台账 digest_sent_at：一行最多进一次邮件（exactly-once），发信成功才盖章，
 *   隔天不念旧账；应用内已读与否不影响——邮件是「别错过」的兜底，不是已读投影。
 * - 列表封顶 {@link DIGEST_ITEM_CAP}：邮件报真实总数、列最旧的 CAP 条、只给列出的
   行盖章——没列出的留 null，明天的摘要继续带（不静默吞掉）。
 * - 按人隔离失败：一人的信失败不拦其他人，最后汇总上抛给 pg-boss 重试；已盖章的
   人天然跳过，重试只补失败者。
 */

export const NOTIFICATIONS_DIGEST_JOB = "notifications-digest";

/** 一封摘要最多列出的条数；超出报「还有 N 条」并留到下次 */
export const DIGEST_ITEM_CAP = 50;

export interface DigestServices {
  db: Db;
  mailer: Mailer;
  /** web 端根地址，用于「去应用里看」链接；不配置 = 邮件里不放链接（诚实降级） */
  webAppUrl: string | undefined;
  logger: Logger;
  /** 测试注入；缺省真时钟 */
  now?: () => Date;
}

/** 扫描的一行：通知事实 + 收件地址（join 出来，不在循环里查） */
interface DigestRow {
  id: string;
  userId: string;
  email: string;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}

function payloadDetail(payload: Record<string, unknown>): string | null {
  for (const key of ["taskTitle", "title", "detail"] as const) {
    const value = payload[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function formatWhen(at: Date): string {
  return `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** 摘要的一行在邮件里的样子（纯文本形态；HTML 由它转义生成） */
export interface DigestItem {
  eventType: string;
  detail: string | null;
  when: string;
}

/** 邮件文案（纯函数，测试直打）；英文用户可见文案（RULE-010） */
export function renderDigest(items: DigestItem[], totalCount: number, webAppUrl: string | undefined): { subject: string; text: string; html: string } {
  const noun = totalCount === 1 ? "notification" : "notifications";
  const subject = `Ally OS digest: ${String(totalCount)} unread ${noun}`;
  const lines: string[] = items.map((item) => {
    const head = item.detail === null ? item.eventType : `${item.eventType} — ${item.detail}`;
    return `- ${head} (${item.when})`;
  });
  const omitted = totalCount - items.length;
  if (omitted > 0) {
    lines.push(`… and ${String(omitted)} more — open the app to see everything.`);
  }
  if (webAppUrl !== undefined) {
    lines.push(`Open Ally OS: ${webAppUrl}/overview`);
  }
  const text = `You have ${String(totalCount)} unread ${noun}:\n\n${lines.join("\n")}\n`;
  const listHtml = items
    .map(
      (item) =>
        `<li><code>${escapeHtml(item.eventType)}</code>${
          item.detail === null ? "" : ` — ${escapeHtml(item.detail)}`
        } <span class="when">${escapeHtml(item.when)}</span></li>`,
    )
    .join("");
  const omittedHtml =
    omitted > 0
      ? `<li class="more">… and ${String(omitted)} more — open the app to see everything.</li>`
      : "";
  const linkHtml = webAppUrl === undefined ? "" : `<p><a href="${escapeHtml(`${webAppUrl}/overview`)}">Open Ally OS</a></p>`;
  const html = `<p>You have <strong>${String(totalCount)}</strong> unread ${noun}:</p><ul>${listHtml}${omittedHtml}</ul>${linkHtml}`;
  return { subject, text, html };
}

/** mailer 包内部不导出的转义这里复制不了——邮件行的 HTML 转义（与 @ally/mailer 的 escapeHtml 同义） */
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** 扫描一次：攒信、发信、盖章。返回每人投递条数（测试与日志用）。 */
export async function runNotificationsDigestScan(services: DigestServices): Promise<Map<string, number>> {
  const now = services.now ?? (() => new Date());
  const pending = await services.db
    .select({
      id: schema.notifications.id,
      userId: schema.notifications.userId,
      email: schema.authUser.email,
      eventType: schema.notifications.eventType,
      payload: schema.notifications.payload,
      createdAt: schema.notifications.createdAt,
    })
    .from(schema.notifications)
    .innerJoin(
      schema.notificationPreferences,
      and(
        eq(schema.notificationPreferences.userId, schema.notifications.userId),
        eq(schema.notificationPreferences.emailDigest, true),
      ),
    )
    .innerJoin(schema.authUser, eq(schema.authUser.id, schema.notifications.userId))
    .where(and(eq(schema.notifications.isRead, false), isNull(schema.notifications.digestSentAt)))
    .orderBy(schema.notifications.userId, schema.notifications.createdAt);

  const byUser = new Map<string, { email: string; rows: DigestRow[] }>();
  for (const row of pending) {
    const bucket = byUser.get(row.userId) ?? { email: row.email, rows: [] };
    bucket.rows.push(row);
    byUser.set(row.userId, bucket);
  }

  const delivered = new Map<string, number>();
  const failures: { userId: string; error: unknown }[] = [];
  for (const [userId, bucket] of byUser) {
    const listed = bucket.rows.slice(0, DIGEST_ITEM_CAP);
    const message: MailMessage = {
      to: bucket.email,
      ...renderDigest(
        listed.map((row) => ({
          eventType: row.eventType,
          detail: payloadDetail(row.payload),
          when: formatWhen(row.createdAt),
        })),
        bucket.rows.length,
        services.webAppUrl,
      ),
    };
    try {
      await services.mailer.send(message);
      // 只给列出的行盖章：没列出的保持 null，下次摘要继续带（见模块注释的封顶语义）。
      // WHERE 再挡一次 digest_sent_at IS NULL——并发/重投下不改写已盖章的行。
      const listedIds = listed.map((row) => row.id);
      await services.db
        .update(schema.notifications)
        .set({ digestSentAt: now() })
        .where(and(isNull(schema.notifications.digestSentAt), inArray(schema.notifications.id, listedIds)));
      delivered.set(userId, listed.length);
    } catch (error) {
      services.logger.error({ err: error, userId }, "notification digest send failed");
      failures.push({ userId, error });
    }
  }
  if (failures.length > 0) {
    // 上抛让 pg-boss 重试；成功者已盖章，重试只补失败者（模块注释的按人隔离）
    throw new Error(`notification digest failed for ${String(failures.length)} user(s)`);
  }
  return delivered;
}
