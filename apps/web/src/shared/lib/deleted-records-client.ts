// The deleted-records page's data access (#29 slice 2): one list read —
// GET /api/deleted-records, offset paging — and one verb, restore. The page
// is a compliance surface (same audit.read gate as the audit log), so the
// adapter reports the failure mode instead of flattening it:
//
//   { ok: true, data }                       — a good read
//   { ok: false, reason: "forbidden" }       — 403: no audit.read permission
//   { ok: false, reason: "unavailable" }     — network/5xx/body that won't parse
//
// Restore has its own honest answers: 404 (the ledger row is gone) and the
// 409 codes come through as `conflict` with the server's word — the page
// says WHICH conflict (already restored / type not restorable / row gone),
// never a generic "failed".
import { z } from "zod";

const personSchema = z.object({ id: z.string(), name: z.string() });

const ledgerRowSchema = z.object({
  id: z.string(),
  subjectType: z.string(),
  subjectId: z.string(),
  title: z.string(),
  snapshot: z.record(z.string(), z.unknown()),
  deletedBy: personSchema.nullable(),
  deletedAt: z.string(),
  restoredBy: personSchema.nullable(),
  restoredAt: z.string().nullable(),
});

const pageSchema = z.object({
  records: z.array(ledgerRowSchema),
  total: z.number().int().nonnegative(),
});

export type DeletedRecordRow = z.infer<typeof ledgerRowSchema>;
export type DeletedRecordsPage = z.infer<typeof pageSchema>;

export interface DeletedRecordsQuery {
  limit: number;
  offset: number;
}

export type DeletedRecordsReadResult =
  | { ok: true; data: DeletedRecordsPage }
  | { ok: false; reason: "forbidden" | "unavailable" };

/** Restore answers with the server's own conflict word; the page translates. */
export type RestoreResult =
  | { ok: true; data: DeletedRecordRow }
  | {
      ok: false;
      reason: "forbidden" | "notfound" | "conflict" | "unavailable";
      code?: string;
    };

export interface DeletedRecordsAdapters {
  page(query: DeletedRecordsQuery): Promise<DeletedRecordsReadResult>;
  restore(ledgerId: string): Promise<RestoreResult>;
}

export function createDeletedRecordsAdapters(fetchFn: typeof fetch = fetch): DeletedRecordsAdapters {
  return {
    async page(query: DeletedRecordsQuery): Promise<DeletedRecordsReadResult> {
      const params = new URLSearchParams({
        limit: String(query.limit),
        offset: String(query.offset),
      });
      try {
        const res = await fetchFn(`/api/deleted-records?${params.toString()}`);
        if (res.status === 403) return { ok: false, reason: "forbidden" };
        if (!res.ok) return { ok: false, reason: "unavailable" };
        return { ok: true, data: pageSchema.parse(await res.json()) };
      } catch {
        return { ok: false, reason: "unavailable" };
      }
    },

    async restore(ledgerId: string): Promise<RestoreResult> {
      try {
        const res = await fetchFn(`/api/deleted-records/${encodeURIComponent(ledgerId)}/restore`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        });
        if (res.status === 403) return { ok: false, reason: "forbidden" };
        if (res.status === 404) return { ok: false, reason: "notfound" };
        if (res.status === 409) {
          // The body is { error: code } — the server's conflict word, kept for
          // the page to translate (zod-guarded: garbage reads as unknown).
          const body = z
            .object({ error: z.string() })
            .safeParse(await res.json().catch(() => undefined));
          return {
            ok: false,
            reason: "conflict",
            ...(body.success ? { code: body.data.error } : {}),
          };
        }
        if (!res.ok) return { ok: false, reason: "unavailable" };
        const parsed = z.object({ record: ledgerRowSchema }).safeParse(await res.json());
        if (!parsed.success) return { ok: false, reason: "unavailable" };
        return { ok: true, data: parsed.data.record };
      } catch {
        return { ok: false, reason: "unavailable" };
      }
    },
  };
}
