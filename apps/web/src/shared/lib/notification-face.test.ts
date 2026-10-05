import { describe, expect, it } from "vitest";

import {
  BELL_RECENT_LIMIT,
  describeAge,
  describeNotification,
  unreadBadge,
  UNREAD_BADGE_CAP,
  type NotificationRow,
} from "./notification-face.ts";

function row(over: Partial<NotificationRow> = {}): NotificationRow {
  return {
    id: "n-1",
    eventType: "test.event",
    aggregateType: null,
    aggregateId: null,
    payload: {},
    isRead: false,
    createdAt: "2026-10-06T08:00:00.000Z",
    ...over,
  };
}

describe("unreadBadge", () => {
  it("0 与负数无角标", () => {
    expect(unreadBadge(0)).toBeNull();
    expect(unreadBadge(-3)).toBeNull();
  });

  it("1..20 显示数字，21（封顶哨兵）显示 20+", () => {
    expect(unreadBadge(1)).toBe("1");
    expect(unreadBadge(20)).toBe("20");
    expect(unreadBadge(21)).toBe(`${UNREAD_BADGE_CAP}+`);
    expect(unreadBadge(99)).toBe("20+");
  });

  it("非有限数无角标", () => {
    expect(unreadBadge(Number.NaN)).toBeNull();
  });
});

describe("describeNotification (生产者白名单落地前的兜底面)", () => {
  it("payload 带 title/detail 就用", () => {
    const face = describeNotification(row({ payload: { title: "Quote viewed", detail: "By ACME" } }));
    expect(face).toEqual({ title: "Quote viewed", detail: "By ACME", href: null });
  });

  it("没有就亮 event_type 原文，去处一律 null", () => {
    const face = describeNotification(row());
    expect(face).toEqual({ title: "test.event", detail: "", href: null });
  });

  it("非字符串/空串的 payload 字段不采用", () => {
    const face = describeNotification(row({ payload: { title: 42, detail: "" } }));
    expect(face.title).toBe("test.event");
    expect(face.detail).toBe("");
  });
});

describe("describeAge", () => {
  const now = new Date("2026-10-06T09:00:00.000Z");

  it("60 秒内是 just now，随后分钟/小时/天", () => {
    expect(describeAge("2026-10-06T08:59:30.000Z", now)).toBe("just now");
    expect(describeAge("2026-10-06T08:40:00.000Z", now)).toBe("20m ago");
    expect(describeAge("2026-10-06T07:00:00.000Z", now)).toBe("2h ago");
    expect(describeAge("2026-10-04T09:00:00.000Z", now)).toBe("2d ago");
  });

  it("未来的时间戳（时钟偏差）不算负数", () => {
    expect(describeAge("2026-10-06T09:01:00.000Z", now)).toBe("just now");
  });
});

describe("契约常量", () => {
  it("铃面 20 行、角标封顶 20——与 API 的 BELL_RECENT_LIMIT/UNREAD_COUNT_CAP 对齐", () => {
    expect(BELL_RECENT_LIMIT).toBe(20);
    expect(UNREAD_BADGE_CAP).toBe(20);
  });
});
