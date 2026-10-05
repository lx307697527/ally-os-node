/**
 * 通知的展示层（#129 切片 4）——老系统 notification-display.ts 的种子直译。
 *
 * 老系统的裁定「文案与深链在 TS 不在库」在这里生效：event_type → {title,
 * detail, href} 的映射表（NOTIFIED_EVENT_TYPES 白名单 + 与 SQL 侧的双向
 * parity 测试）随第一个扇出生产者（业务域迁移）一起落地。在那之前所有行都
 * 走 `describeNotification` 的兜底面：payload 里带 title/detail 就用，
 * 没有就亮 event_type 原文，去处一律 null（本仓库还没有可跳的业务页）。
 * 兜底面是诚实的占位，不是最终文案。
 */

/** 铃铛下拉一次带走的行数，与 API 的 BELL_RECENT_LIMIT 是等价性契约。 */
export const BELL_RECENT_LIMIT = 20;

/** 未读数到这个值为「封顶」：API 返回 21 = 「超过 20」，角标打印 "20+"。 */
export const UNREAD_BADGE_CAP = 20;

/** API summary 的一行（zod 校验后的形状，camelCase）。 */
export interface NotificationRow {
  id: string;
  eventType: string;
  aggregateType: string | null;
  aggregateId: string | null;
  payload: Record<string, unknown>;
  isRead: boolean;
  /** ISO 字符串（JSON 线上格式）。 */
  createdAt: string;
}

/** 一行通知在铃铛里亮出来的样子。 */
export interface NotificationFace {
  title: string;
  detail: string;
  /** 行的去处；null = 这个应用还没有地方可去（点了只标已读）。 */
  href: string | null;
}

/**
 * 未读角标文案：0 或负数 = 无角标（null）；超过封顶 = "20+"。
 * 与老系统 unreadBadge 逐行同义。
 */
export function unreadBadge(count: number): string | null {
  if (!Number.isFinite(count) || count < 1) return null;
  return count > UNREAD_BADGE_CAP ? `${UNREAD_BADGE_CAP}+` : String(Math.floor(count));
}

function stringField(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** 生产者白名单落地前的兜底面（见文件头）。 */
export function describeNotification(row: NotificationRow): NotificationFace {
  return {
    title: stringField(row.payload, "title") ?? row.eventType,
    detail: stringField(row.payload, "detail") ?? "",
    href: null,
  };
}

/** 「刚刚发生」的相对表述只到分钟粒度；铃铛轮询 60s，粒度对齐刷新节奏。 */
export function describeAge(createdAt: string, now: Date = new Date()): string {
  const then = new Date(createdAt);
  const seconds = Math.max(0, Math.floor((now.getTime() - then.getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
