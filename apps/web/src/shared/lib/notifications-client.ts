// The bell's data access (#129 slice 4): one summary read, two writes — the
// same adapter face the old bell consumed (NotificationBellAdapters, reduced
// to what this API serves: no popupAlerts, no separate list/count reads).
//
// EVERY failure degrades to `null`, never to a guess: an unreachable API, a
// non-OK answer, or a body that doesn't parse is "no data this round", and
// the bell KEEPS the last good state on screen (a failed read is not an empty
// inbox — the old bell's ruling). The parses are zod because API responses
// are external input as far as this bundle is concerned: an SPA fallback HTML
// page behind a misrouted proxy must read as "no data", not as a crash.
import { z } from "zod";

import type { NotificationRow } from "./notification-face.ts";

const rowSchema = z.object({
  id: z.string(),
  eventType: z.string(),
  aggregateType: z.string().nullable(),
  aggregateId: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()),
  isRead: z.boolean(),
  createdAt: z.string(),
});

const summarySchema = z.object({
  recent: z.array(rowSchema),
  unreadCount: z.number().int().nonnegative(),
});

export interface NotificationSummary {
  recent: NotificationRow[];
  unreadCount: number;
}

export interface NotificationAdapters {
  summary(): Promise<NotificationSummary | null>;
  markRead(notificationId: string): Promise<boolean>;
  markAllRead(): Promise<number | null>;
}

/** Never rejects. `null` = this round failed; keep what you had. */
export function createNotificationAdapters(fetchFn: typeof fetch = fetch): NotificationAdapters {
  return {
    async summary(): Promise<NotificationSummary | null> {
      try {
        const res = await fetchFn("/api/notifications/summary");
        if (!res.ok) return null;
        return summarySchema.parse(await res.json());
      } catch {
        return null;
      }
    },
    async markRead(notificationId: string): Promise<boolean> {
      try {
        const res = await fetchFn(`/api/notifications/${encodeURIComponent(notificationId)}/read`, {
          method: "POST",
        });
        return res.ok;
      } catch {
        return false;
      }
    },
    async markAllRead(): Promise<number | null> {
      try {
        const res = await fetchFn("/api/notifications/read-all", { method: "POST" });
        if (!res.ok) return null;
        return markedSchema.parse(await res.json()).marked;
      } catch {
        return null;
      }
    },
  };
}

const markedSchema = z.object({ marked: z.number().int().nonnegative() });
