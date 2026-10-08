// The deep-link guard (#110 slice 1), ported from ally-os
// notification-href-routes.test.ts: every whitelisted notification event's
// href must resolve against a route REGISTERED in App.tsx — the catch-all
// redirect does not count. The old repo added this test because /support/:id
// once silently landed on the catch-all and deep-linked straight back to the
// dashboard; this file exists so the first real hrefs never learn that trick.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { describeNotification, NOTIFIED_EVENT_TYPES, type NotificationRow } from "./notification-face.ts";

const SRC = dirname(fileURLToPath(import.meta.url));
const app = readFileSync(join(SRC, "..", "..", "App.tsx"), "utf8");

/** The literal `path="…"` attributes of App.tsx — the routes that EXIST. */
const REGISTERED: string[] = [...app.matchAll(/path="([^"]+)"/g)].map((m) => m[1] ?? "");

const TASK_ID = "1f0e9c2a-3b4d-4e5f-8a9b-0c1d2e3f4a5b";
const COMMENT_ID = "9a8b7c6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d";
const INVOICE_ID = "3c5e7f90-a1b2-4c3d-8e9f-0a1b2c3d4e5f";

const PAYMENT_EVENTS: readonly string[] = ["payment.attempt_failed", "payment.unbookable"];

function rowFor(eventType: string): NotificationRow {
  if (PAYMENT_EVENTS.includes(eventType)) {
    // 收款告警（#193）：聚合是发票，payload 带服务端拼好的 title/detail 与
    // invoiceId（深链的原料）。
    return {
      id: "n-1",
      eventType,
      aggregateType: "invoice",
      aggregateId: INVOICE_ID,
      payload: {
        title: "A stripe payment arrived but could not be recorded",
        detail: "A stripe payment of USD 100.00 arrived but could not be recorded.",
        invoiceId: INVOICE_ID,
        channel: "stripe",
      },
      isRead: false,
      createdAt: "2026-10-06T08:00:00.000Z",
    };
  }
  if (eventType === "invoice.overdue") {
    // 逾期提醒（#192 due 扫描）：聚合是发票，payload 带 worker 扫描拼好的
    // title/detail（金额 + 到期日事实）。
    return {
      id: "n-1",
      eventType,
      aggregateType: "invoice",
      aggregateId: INVOICE_ID,
      payload: {
        title: "Invoice INV-1007 is overdue",
        detail: "USD 15,000.00 outstanding — was due 2026-10-01",
        invoiceNumber: "INV-1007",
        outstandingCents: 1_500_000,
        currency: "USD",
      },
      isRead: false,
      createdAt: "2026-10-06T08:00:00.000Z",
    };
  }
  return {
    id: "n-1",
    eventType,
    aggregateType: "task",
    aggregateId: TASK_ID,
    payload:
      eventType === "comment.mentioned" || eventType === "comment.created"
        ? { taskTitle: "t", commentId: COMMENT_ID, actorName: "Alice", excerpt: "e" }
        : { taskTitle: "t", actorName: "Alice" },
    isRead: false,
    createdAt: "2026-10-06T08:00:00.000Z",
  };
}

/** Segment matcher against a registered pattern: a `:param` segment eats any
 *  one non-empty segment; literals must be literal. Query strings are not
 *  route shape. The catch-all never matches — that is the entire point. */
function resolvesAgainstRegistered(href: string): boolean {
  const path = href.split("?")[0] ?? "";
  const actual = path.split("/").filter((seg) => seg !== "");
  return REGISTERED.some((route) => {
    if (route === "*") return false;
    const pattern = route.split("/").filter((seg) => seg !== "");
    if (pattern.length !== actual.length) return false;
    return pattern.every((seg, i) => {
      const value = actual[i];
      if (value === undefined || value === "") return false;
      return seg.startsWith(":") ? true : seg === value;
    });
  });
}

describe("notification hrefs land on real routes (#110 slice 1)", () => {
  it("App.tsx actually registered routes (the guard has something to check)", () => {
    expect(REGISTERED).toContain("/tasks/:taskId");
    expect(REGISTERED).toContain("/tasks");
    // 收款告警的承载页（#192 财务确认页）
    expect(REGISTERED).toContain("/invoices/:invoiceId");
    expect(REGISTERED).toContain("/invoices");
  });

  it("every whitelisted event's face has a href that resolves — catch-all excluded", () => {
    expect(NOTIFIED_EVENT_TYPES.length).toBeGreaterThanOrEqual(2);
    for (const eventType of NOTIFIED_EVENT_TYPES) {
      const face = describeNotification(rowFor(eventType));
      expect(face.href, `${eventType} must deep-link somewhere real`).not.toBeNull();
      expect(
        resolvesAgainstRegistered(face.href ?? ""),
        `${eventType} → ${face.href ?? ""} must match a registered route, not the catch-all`,
      ).toBe(true);
    }
  });

  it("the mentioned comment's href carries its ?comment= target", () => {
    const face = describeNotification(rowFor("comment.mentioned"));
    expect(face.href).toBe(`/tasks/${TASK_ID}?comment=${COMMENT_ID}`);
  });

  it("the follower's comment notification deep-links to the comment too (#110 slice 4)", () => {
    const face = describeNotification(rowFor("comment.created"));
    expect(face.href).toBe(`/tasks/${TASK_ID}?comment=${COMMENT_ID}`);
  });

  it("a payment alert deep-links to the invoice it is about (#193 → #192)", () => {
    for (const eventType of PAYMENT_EVENTS) {
      const face = describeNotification(rowFor(eventType));
      expect(face.href, `${eventType} lands on the invoice page`).toBe(`/invoices/${INVOICE_ID}`);
    }
  });

  it("an overdue reminder deep-links to the invoice it is about (#192 due 扫描)", () => {
    const face = describeNotification(rowFor("invoice.overdue"));
    expect(face.href).toBe(`/invoices/${INVOICE_ID}`);
  });
});
