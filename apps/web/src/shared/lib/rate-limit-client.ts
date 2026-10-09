// The rate limits page's data access (#27): two reads — the denials ledger
// (GET /api/rate-limit-denials, offset paging, exact total) and the triage
// summary (GET /api/rate-limit-denials/summary, last N days by action).
// Same shape as audit-client.ts: the PAGE is a primary surface, so the
// adapter reports the failure mode instead of flattening it —
//
//   { ok: true, data }                       — a good read
//   { ok: false, reason: "forbidden" }       — 403: no audit.read permission
//   { ok: false, reason: "unavailable" }     — network/5xx/body that won't parse
//
// The body parse is zod because API responses are external input as far as
// this bundle is concerned (an SPA fallback HTML behind a misrouted proxy
// must read as "unavailable", not as a crash).
import { z } from "zod";

const denialRowSchema = z.object({
  id: z.string(),
  identifierType: z.string(),
  identifier: z.string(),
  action: z.string(),
  windowStart: z.string(),
  countAtDenial: z.number().int(),
  limitValue: z.number().int(),
  requestId: z.string().nullable(),
  deniedAt: z.string(),
});

const pageSchema = z.object({
  denials: z.array(denialRowSchema),
  total: z.number().int().nonnegative(),
});

const summaryRowSchema = z.object({
  action: z.string(),
  count: z.number().int(),
  distinctIdentifiers: z.number().int(),
  lastDeniedAt: z.string(),
});

const summarySchema = z.object({
  windowDays: z.number().int().positive(),
  groups: z.array(summaryRowSchema),
});

export type RateLimitDenialRow = z.infer<typeof denialRowSchema>;
export type RateLimitDenialPage = z.infer<typeof pageSchema>;
export type RateLimitSummary = z.infer<typeof summarySchema>;

export interface RateLimitQuery {
  limit: number;
  offset: number;
}

export interface RateLimitSummaryQuery {
  days: number;
}

export type RateLimitReadResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: "forbidden" | "unavailable" };

export interface RateLimitAdapters {
  page(query: RateLimitQuery): Promise<RateLimitReadResult<RateLimitDenialPage>>;
  summary(query: RateLimitSummaryQuery): Promise<RateLimitReadResult<RateLimitSummary>>;
}

export function createRateLimitAdapters(fetchFn: typeof fetch = fetch): RateLimitAdapters {
  async function read<T>(url: string, schema: z.ZodType<T>): Promise<RateLimitReadResult<T>> {
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
    async page(query: RateLimitQuery): Promise<RateLimitReadResult<RateLimitDenialPage>> {
      const params = new URLSearchParams({
        limit: String(query.limit),
        offset: String(query.offset),
      });
      return read(`/api/rate-limit-denials?${params.toString()}`, pageSchema);
    },
    async summary(query: RateLimitSummaryQuery): Promise<RateLimitReadResult<RateLimitSummary>> {
      const params = new URLSearchParams({ days: String(query.days) });
      return read(`/api/rate-limit-denials/summary?${params.toString()}`, summarySchema);
    },
  };
}
