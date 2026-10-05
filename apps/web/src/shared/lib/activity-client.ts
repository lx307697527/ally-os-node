// The activity timeline's data access (#110 slice 3): one subject's activity,
// newest first, read-only. Same face as the comments client — the failure mode
// is reported, never flattened:
//
//   { ok: true, data }                     — a good read
//   { ok: false, reason: "notfound" }      — 404 (subject gone or not yours)
//   { ok: false, reason: "unavailable" }   — network/5xx/body that won't parse
//
// Bodies parse through zod: API responses are external input as far as this
// bundle is concerned (an SPA fallback HTML behind a misrouted proxy must read
// as "unavailable", not as a crash).
import { z } from "zod";

const actorSchema = z.object({ id: z.string(), name: z.string() });

const activityRowSchema = z.object({
  id: z.string(),
  action: z.string(),
  target: z.string().nullable(),
  detail: z.record(z.string(), z.unknown()).nullable(),
  actor: actorSchema.nullable(),
  createdAt: z.string(),
});

const activityListSchema = z.object({
  events: z.array(activityRowSchema),
  total: z.number().int().nonnegative(),
});

export type ActivityRow = z.infer<typeof activityRowSchema>;

export interface ActivityListQuery {
  subjectType: string;
  subjectId: string;
  limit: number;
  offset: number;
}

export type ActivityListResult =
  | { ok: true; data: z.infer<typeof activityListSchema> }
  | { ok: false; reason: "notfound" | "unavailable" };

export interface ActivityAdapters {
  list(query: ActivityListQuery): Promise<ActivityListResult>;
}

export function createActivityAdapters(fetchFn: typeof fetch = fetch): ActivityAdapters {
  return {
    async list(query: ActivityListQuery): Promise<ActivityListResult> {
      const params = new URLSearchParams({
        subjectType: query.subjectType,
        subjectId: query.subjectId,
        limit: String(query.limit),
        offset: String(query.offset),
      });
      try {
        const res = await fetchFn(`/api/activity?${params.toString()}`);
        if (res.status === 404) return { ok: false, reason: "notfound" };
        if (!res.ok) return { ok: false, reason: "unavailable" };
        return { ok: true, data: activityListSchema.parse(await res.json()) };
      } catch {
        return { ok: false, reason: "unavailable" };
      }
    },
  };
}
