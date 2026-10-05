// The audit log's data access (#29): one read — GET /api/audit-events, offset
// paging, exact-match filters. Unlike the bell (a widget that degrades to
// null and keeps last good state), the audit PAGE is a primary surface: an
// operator looking at an empty table must know WHY. So the adapter reports
// the failure mode instead of flattening it:
//
//   { ok: true, data }                       — a good read
//   { ok: false, reason: "forbidden" }       — 403: no audit.read permission
//   { ok: false, reason: "unavailable" }     — network/5xx/body that won't parse
//
// The body parse is zod because API responses are external input as far as
// this bundle is concerned (an SPA fallback HTML behind a misrouted proxy
// must read as "unavailable", not as a crash).
import { z } from "zod";

const eventRowSchema = z.object({
  id: z.string(),
  actor: z.string().nullable(),
  action: z.string(),
  target: z.string().nullable(),
  detail: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string(),
});

const pageSchema = z.object({
  events: z.array(eventRowSchema),
  total: z.number().int().nonnegative(),
});

export type AuditEventRow = z.infer<typeof eventRowSchema>;
export type AuditPage = z.infer<typeof pageSchema>;

export interface AuditQuery {
  limit: number;
  offset: number;
}

export type AuditReadResult =
  | { ok: true; data: AuditPage }
  | { ok: false; reason: "forbidden" | "unavailable" };

export interface AuditAdapters {
  page(query: AuditQuery): Promise<AuditReadResult>;
}

export function createAuditAdapters(fetchFn: typeof fetch = fetch): AuditAdapters {
  return {
    async page(query: AuditQuery): Promise<AuditReadResult> {
      const params = new URLSearchParams({
        limit: String(query.limit),
        offset: String(query.offset),
      });
      try {
        const res = await fetchFn(`/api/audit-events?${params.toString()}`);
        if (res.status === 403) return { ok: false, reason: "forbidden" };
        if (!res.ok) return { ok: false, reason: "unavailable" };
        return { ok: true, data: pageSchema.parse(await res.json()) };
      } catch {
        return { ok: false, reason: "unavailable" };
      }
    },
  };
}
