import { describe, expect, it } from "vitest";

import {
  BELL_RECENT_LIMIT,
  describeAge,
  describeNotification,
  NOTIFIED_EVENT_TYPES,
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

describe("describeNotification (白名单类型：文案与深链在 TS 不在库)", () => {
  const taskId = "1f0e9c2a-3b4d-4e5f-8a9b-0c1d2e3f4a5b";
  const commentId = "9a8b7c6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d";

  it("task.assigned：谁派的、派了什么、去处是任务详情页", () => {
    const face = describeNotification(
      row({
        eventType: "task.assigned",
        aggregateType: "task",
        aggregateId: taskId,
        payload: { taskTitle: "Review label copy", actorName: "Alice" },
      }),
    );
    expect(face.title).toBe("Alice assigned you a task");
    expect(face.detail).toBe("Review label copy");
    expect(face.href).toBe(`/tasks/${taskId}`);
  });

  it("comment.mentioned：去处带着 comment 参数，落到那条评论", () => {
    const face = describeNotification(
      row({
        eventType: "comment.mentioned",
        aggregateType: "task",
        aggregateId: taskId,
        payload: { taskTitle: "Review label copy", commentId, actorName: "Bob", excerpt: "@Alice check this" },
      }),
    );
    expect(face.title).toBe("Bob mentioned you on a task");
    expect(face.detail).toBe("@Alice check this");
    expect(face.href).toBe(`/tasks/${taskId}?comment=${commentId}`);
  });

  it("comment.created：关注对象上的新评论，去处同样带着 comment 参数", () => {
    const face = describeNotification(
      row({
        eventType: "comment.created",
        aggregateType: "task",
        aggregateId: taskId,
        payload: { taskTitle: "Review label copy", commentId, actorName: "Bob", excerpt: "Ship it" },
      }),
    );
    expect(face.title).toBe("Bob commented on a task you follow");
    expect(face.detail).toBe("Ship it");
    expect(face.href).toBe(`/tasks/${taskId}?comment=${commentId}`);
  });

  it("task.status_changed：关注对象的状态流转，动词随 to 的事实，事实缺位不硬凑", () => {
    const base = {
      aggregateType: "task",
      aggregateId: taskId,
      payload: { taskTitle: "Review label copy", actorName: "Alice", from: "open", to: "done" },
    };
    expect(describeNotification(row({ eventType: "task.status_changed", ...base }))).toEqual({
      title: "Alice completed a task you follow",
      detail: "Review label copy",
      href: `/tasks/${taskId}`,
    });
    const at = (to: string | undefined): string =>
      describeNotification(
        row({
          eventType: "task.status_changed",
          aggregateType: "task",
          aggregateId: taskId,
          payload: {
            taskTitle: "t",
            actorName: "Alice",
            ...(to === undefined ? {} : { to }),
          },
        }),
      ).title;
    expect(at("cancelled")).toBe("Alice cancelled a task you follow");
    expect(at("open")).toBe("Alice reopened a task you follow");
    expect(at(undefined)).toBe("Alice updated a task you follow");
  });

  it("事实缺位不撒谎：没有聚合 id 无处可去，没有摘录用任务名，没有名字用 Someone", () => {
    const noAggregate = describeNotification(row({ eventType: "task.assigned", payload: { taskTitle: "t" } }));
    expect(noAggregate.href).toBeNull();
    const noExcerpt = describeNotification(
      row({ eventType: "comment.mentioned", aggregateId: taskId, payload: { taskTitle: "fallback title" } }),
    );
    expect(noExcerpt.detail).toBe("fallback title");
    expect(noExcerpt.href).toBe(`/tasks/${taskId}`);
    const noActor = describeNotification(row({ eventType: "task.assigned", aggregateId: taskId }));
    expect(noActor.title).toBe("Someone assigned you a task");
    expect(noActor.detail).toBe("");
  });

  it("approval.pending：谁提交的、哪条线哪一级，去处是待办页（裁决发生地）", () => {
    const face = describeNotification(
      row({
        eventType: "approval.pending",
        aggregateType: "approval_request",
        aggregateId: "req-1",
        payload: {
          configName: "Discount line",
          configKey: "discount",
          levelName: "lead review",
          actorName: "Alice",
        },
      }),
    );
    expect(face.title).toBe("Alice sent Discount line for your approval");
    expect(face.detail).toBe("lead review");
    expect(face.href).toBe("/approvals");
  });

  it("approval.reminder：本级停满 24h 的催办，事实带等待时长", () => {
    const face = describeNotification(
      row({
        eventType: "approval.reminder",
        payload: {
          configName: "Discount line",
          levelName: "final sign-off",
          waitingHours: 27,
          detail: "Discount line · final sign-off",
        },
      }),
    );
    expect(face.title).toBe("Still waiting: Discount line needs a decision");
    expect(face.detail).toBe("Discount line · final sign-off");
    expect(face.href).toBe("/approvals");
  });

  it("审批事实缺位不撒谎：没有 configName 用泛称，没有 levelName 用 detail 兜底", () => {
    const noConfig = describeNotification(row({ eventType: "approval.pending", payload: { actorName: "Alice" } }));
    expect(noConfig.title).toBe("Alice sent a request for your approval");
    expect(noConfig.detail).toBe("");
    const noLevel = describeNotification(
      row({ eventType: "approval.pending", payload: { detail: "Discount line · lead review" } }),
    );
    expect(noLevel.detail).toBe("Discount line · lead review");
    const noHours = describeNotification(row({ eventType: "approval.reminder", payload: { levelName: "L1" } }));
    expect(noHours.detail).toBe("L1");
    expect(noHours.title).toBe("Still waiting: an approval needs a decision");
  });

  it("approval.completed / rejected 不在白名单：终态还没有承载页，兜底面亮类型 + detail 事实", () => {
    for (const eventType of ["approval.completed", "approval.rejected"]) {
      expect(NOTIFIED_EVENT_TYPES).not.toContain(eventType);
      const face = describeNotification(
        row({ eventType, payload: { configName: "Discount line", actorName: "Carol", detail: "Discount line" } }),
      );
      expect(face.title).toBe(eventType);
      expect(face.detail).toBe("Discount line");
      expect(face.href).toBeNull();
    }
  });

  it("白名单就是铃铛认得的全部：新生产者必须先进这张表", () => {
    expect(NOTIFIED_EVENT_TYPES).toEqual([
      "task.assigned",
      "task.status_changed",
      "comment.mentioned",
      "comment.created",
      "approval.pending",
      "approval.reminder",
    ]);
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
