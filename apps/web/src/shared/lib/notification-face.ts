/**
 * 通知的展示层（#129 切片 4，白名单与深链 #110 切片 1）——老系统
 * notification-display.ts 的直译。
 *
 * 老系统的裁定「文案与深链在 TS 不在库」在这里生效：event_type → {title,
 * detail, href} 的映射只认白名单里的类型（NOTIFIED_EVENT_TYPES），每类文案
 * 从 payload 的事实字段拼出、href 从 aggregate 指到真实页面。白名单之外的
 * 行走 `describeNotification` 的兜底面：payload 里带 title/detail 就用，
 * 没有就亮 event_type 原文，去处一律 null。兜底面是诚实的占位，不是最终文案。
 *
 * href 的落点必须真实存在：notification-href-routes.test.ts 把白名单的每个
 * 去处对着 App.tsx 注册的路由做 parity 校验（老系统同一守卫的移植——它抓到
 * 过深链静默落进 catch-all 重定向的真 bug）。
 */

/** 铃铛下拉一次带走的行数，与 API 的 BELL_RECENT_LIMIT 是等价性契约。 */
export const BELL_RECENT_LIMIT = 20;

/** 未读数到这个值为「封顶」：API 返回 21 = 「超过 20」，角标打印 "20+"。 */
export const UNREAD_BADGE_CAP = 20;

/** 铃铛认得的事件类型：文案与深链只在这张表里，生产者随业务域落地时进来。 */
export const NOTIFIED_EVENT_TYPES: readonly string[] = [
  "task.assigned",
  "task.status_changed",
  "comment.mentioned",
  "comment.created",
  // 审批扇出与催办（#221）：去处是待办页——裁决就在那里发生。
  // approval.completed / approval.rejected 刻意不在白名单：终态还没有承载页
  // （「我发起的审批」随 phase-2 属主域进场），兜底面亮事件类型 + payload 的
  // detail 事实、去处 null 是诚实的占位；有了承载页再进来。
  "approval.pending",
  "approval.reminder",
];

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

function actorOf(payload: Record<string, unknown>): string {
  return stringField(payload, "actorName") ?? "Someone";
}

/** 催办事实里的等待时长（小时，服务端落库时的整数）；缺了不硬凑 */
function hoursWaiting(payload: Record<string, unknown>): string | null {
  const hours = payload.waitingHours;
  return typeof hours === "number" && Number.isFinite(hours) ? `${String(hours)}h waiting` : null;
}

/** 状态流转的动词从 to 的事实来；事实缺位用中性的 updated，不硬凑方向 */
function statusVerb(to: string | null): string {
  if (to === "done") return "completed";
  if (to === "cancelled") return "cancelled";
  if (to === "open") return "reopened";
  return "updated";
}

/** 任务详情页的深链：聚合指向任务，带 comment 参数时落到那条评论上。 */
function taskHref(aggregateId: string | null, commentId: string | null): string | null {
  if (aggregateId === null) return null;
  return commentId === null ? `/tasks/${aggregateId}` : `/tasks/${aggregateId}?comment=${commentId}`;
}

export function describeNotification(row: NotificationRow): NotificationFace {
  switch (row.eventType) {
    case "task.assigned":
      return {
        title: `${actorOf(row.payload)} assigned you a task`,
        detail: stringField(row.payload, "taskTitle") ?? "",
        href: taskHref(row.aggregateId, null),
      };
    case "task.status_changed":
      // 关注扇出（#113）：你关注（而非经办/创建）的任务被人动了状态
      return {
        title: `${actorOf(row.payload)} ${statusVerb(stringField(row.payload, "to"))} a task you follow`,
        detail: stringField(row.payload, "taskTitle") ?? "",
        href: taskHref(row.aggregateId, null),
      };
    case "comment.mentioned":
      return {
        title: `${actorOf(row.payload)} mentioned you on a task`,
        detail: stringField(row.payload, "excerpt") ?? stringField(row.payload, "taskTitle") ?? "",
        href: taskHref(row.aggregateId, stringField(row.payload, "commentId")),
      };
    case "comment.created":
      // 关注扇出（#110 slice 4）：你关注（而非被提及）的对象上有新评论
      return {
        title: `${actorOf(row.payload)} commented on a task you follow`,
        detail: stringField(row.payload, "excerpt") ?? stringField(row.payload, "taskTitle") ?? "",
        href: taskHref(row.aggregateId, stringField(row.payload, "commentId")),
      };
    case "approval.pending":
      // 审批扇出（#221）：轮到你裁了。去处是待办页（裁决的发生地），不是详情——
      // 裁决人不必先过单据可见性门，详情门在页面里各自说话
      return {
        title: `${actorOf(row.payload)} sent ${
          stringField(row.payload, "configName") ?? "a request"
        } for your approval`,
        detail: stringField(row.payload, "levelName") ?? stringField(row.payload, "detail") ?? "",
        href: "/approvals",
      };
    case "approval.reminder":
      // 催办（#221）：本级停满 24h 没人裁，事实里带等了多少小时
      return {
        title: `Still waiting: ${
          stringField(row.payload, "configName") ?? "an approval"
        } needs a decision`,
        detail:
          stringField(row.payload, "detail") ??
          [stringField(row.payload, "levelName"), hoursWaiting(row.payload)]
            .filter((part): part is string => part !== null)
            .join(" · "),
        href: "/approvals",
      };
    default:
      return {
        title: stringField(row.payload, "title") ?? row.eventType,
        detail: stringField(row.payload, "detail") ?? "",
        href: null,
      };
  }
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
