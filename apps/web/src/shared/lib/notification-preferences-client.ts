// The channel-preferences data access (#116): one GET, one PUT — the same
// discipline as the bell's notifications-client. EVERY failure degrades to
// `null`, never to a guess: an unreachable API, a non-OK answer, or a body
// that doesn't parse is "no answer this round", and the settings page says so
// instead of showing a made-up state. The parses are zod because API responses
// are external input as far as this bundle is concerned.
import { z } from "zod";

const preferencesSchema = z.object({
  emailDigest: z.boolean(),
  updatedAt: z.string().nullable(),
});

export interface NotificationPreferences {
  emailDigest: boolean;
  updatedAt: string | null;
}

export interface NotificationPreferencesAdapters {
  load(): Promise<NotificationPreferences | null>;
  /** 整份替换语义（服务端 PUT 同名合同）；返回 null = 没存上，页面必须说 */
  save(next: { emailDigest: boolean }): Promise<NotificationPreferences | null>;
}

/** Never rejects. `null` = this round failed; the page shows it honestly. */
export function createNotificationPreferencesAdapters(fetchFn: typeof fetch = fetch): NotificationPreferencesAdapters {
  return {
    async load(): Promise<NotificationPreferences | null> {
      try {
        const res = await fetchFn("/api/notifications/preferences");
        if (!res.ok) return null;
        return preferencesSchema.parse(await res.json());
      } catch {
        return null;
      }
    },
    async save(next: { emailDigest: boolean }): Promise<NotificationPreferences | null> {
      try {
        const res = await fetchFn("/api/notifications/preferences", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(next),
        });
        if (!res.ok) return null;
        return preferencesSchema.parse(await res.json());
      } catch {
        return null;
      }
    },
  };
}
