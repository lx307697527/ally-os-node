// The error events page's data access (#28 slice 2): two reads — the
// fingerprint triage summary (GET /api/error-events/summary, last N days by
// fingerprint+source) and the raw ledger (GET /api/error-events, offset
// paging, exact total, fingerprint/source filters). Same shape as
// rate-limit-client.ts: the PAGE is a primary surface, so the adapter
// reports the failure mode instead of flattening it —
//
//   { ok: true, data }                       — a good read
//   { ok: false, reason: "forbidden" }       — 403: no audit.read permission
//   { ok: false, reason: "unavailable" }     — network/5xx/body that won't parse
//
// The body parse is zod because API responses are external input as far as
// this bundle is concerned (an SPA fallback HTML behind a misrouted proxy
// must read as "unavailable", not as a crash).
import { z } from "zod";

// error_events.source is an open set ('web' today; worker/portal join later
// without a migration): the ROW schema reads it as a plain string so a
// future source's rows still render. The FILTER is the narrow union the
// API's query validation accepts today — display open, query closed.
const eventRowSchema = z.object({
  id: z.string(),
  fingerprint: z.string(),
  source: z.string(),
  message: z.string(),
  stack: z.string().nullable(),
  url: z.string().nullable(),
  userAgent: z.string().nullable(),
  requestId: z.string().nullable(),
  createdAt: z.string(),
});

const pageSchema = z.object({
  events: z.array(eventRowSchema),
  total: z.number().int().nonnegative(),
});

const summaryRowSchema = z.object({
  fingerprint: z.string(),
  source: z.string(),
  count: z.number().int(),
  firstSeen: z.string(),
  lastSeen: z.string(),
  sampleMessage: z.string(),
});

const summarySchema = z.object({
  windowDays: z.number().int().positive(),
  groups: z.array(summaryRowSchema),
});

export type ErrorEventRow = z.infer<typeof eventRowSchema>;
export type ErrorEventPage = z.infer<typeof pageSchema>;
export type ErrorEventsSummary = z.infer<typeof summarySchema>;

/** The sources the API's filter accepts today — the table's set is open, the query's is not. */
export type ErrorEventSource = "web" | "api";

export interface ErrorEventListQuery {
  limit: number;
  offset: number;
  fingerprint: string | undefined;
  source: ErrorEventSource | undefined;
}

export interface ErrorEventsSummaryQuery {
  days: number;
}

export type ErrorEventsReadResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: "forbidden" | "unavailable" };

export interface ErrorEventsAdapters {
  list(query: ErrorEventListQuery): Promise<ErrorEventsReadResult<ErrorEventPage>>;
  summary(query: ErrorEventsSummaryQuery): Promise<ErrorEventsReadResult<ErrorEventsSummary>>;
}

export function createErrorEventsAdapters(fetchFn: typeof fetch = fetch): ErrorEventsAdapters {
  async function read<T>(url: string, schema: z.ZodType<T>): Promise<ErrorEventsReadResult<T>> {
    try {
      const res = await fetchFn(url);
      if (res.status === 403) return { ok: false, reason: "forbidden" };
      if (!res.ok) return { ok: false, reason: "unavailable" };
      return { ok: true, data: schema.parse(await res.json()) };
    } catch {
      return { ok: false, reason: "unavailable" };
    }
  }

  return {
    async list(query: ErrorEventListQuery): Promise<ErrorEventsReadResult<ErrorEventPage>> {
      const params = new URLSearchParams({
        limit: String(query.limit),
        offset: String(query.offset),
      });
      if (query.fingerprint !== undefined) params.set("fingerprint", query.fingerprint);
      if (query.source !== undefined) params.set("source", query.source);
      return read(`/api/error-events?${params.toString()}`, pageSchema);
    },
    async summary(
      query: ErrorEventsSummaryQuery,
    ): Promise<ErrorEventsReadResult<ErrorEventsSummary>> {
      const params = new URLSearchParams({ days: String(query.days) });
      return read(`/api/error-events/summary?${params.toString()}`, summarySchema);
    },
  };
}
