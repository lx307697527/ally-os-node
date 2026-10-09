// The signature wall's data access (#219): read a record's signatures — the
// Part 11.50 display (signer name, exact time, meaning) plus the record
// version each signature is bound to. The server's read gate is the SUBJECT's
// visibility (subjects/registry.ts — for approval actions: the request's
// participants), so:
//
//   wall(): notfound — meaningful: the viewer cannot see the record the
//          signatures belong to (a participant question, not an error).
//          unavailable — network/parse failure or a type the server does not
//          know (client bug; never shown as "no signatures").
//
// Bodies parse through zod: API responses are external input as far as this
// bundle is concerned (an SPA fallback HTML behind a misrouted proxy must read
// as "unavailable", not as a crash).
import { z } from "zod";

export const signatureRowSchema = z.object({
  id: z.string(),
  subjectType: z.string(),
  subjectId: z.string(),
  meaning: z.enum(["performed", "reviewed", "approved"]),
  recordVersion: z.string(),
  recordHash: z.string(),
  signedAt: z.string(),
  receivedAt: z.string(),
  signer: z.object({ id: z.string(), name: z.string() }),
});

export type SignatureRow = z.infer<typeof signatureRowSchema>;

/** receivedAt beyond this after signedAt means the signature was signed
 * offline and synced later — the wall says so instead of letting the two
 * timestamps silently disagree. */
export const LATE_SYNC_MS = 60 * 1000;

export function isLateSync(row: Pick<SignatureRow, "signedAt" | "receivedAt">): boolean {
  return new Date(row.receivedAt).getTime() - new Date(row.signedAt).getTime() > LATE_SYNC_MS;
}

export interface SignatureWallRef {
  subjectType: string;
  subjectId: string;
}

export type SignatureWallResult =
  | { ok: true; data: SignatureRow[] }
  | { ok: false; reason: "notfound" | "unavailable" };

export interface EsignAdapters {
  wall(ref: SignatureWallRef): Promise<SignatureWallResult>;
}

export function createEsignAdapters(fetchFn: typeof fetch = fetch): EsignAdapters {
  return {
    async wall(ref: SignatureWallRef): Promise<SignatureWallResult> {
      try {
        const query = `subjectType=${encodeURIComponent(ref.subjectType)}&subjectId=${encodeURIComponent(ref.subjectId)}`;
        const res = await fetchFn(`/api/esignatures?${query}`);
        if (res.status === 404) return { ok: false, reason: "notfound" };
        if (!res.ok) return { ok: false, reason: "unavailable" };
        const parsed = z
          .object({ signatures: z.array(signatureRowSchema) })
          .safeParse(await res.json());
        if (!parsed.success) return { ok: false, reason: "unavailable" };
        return { ok: true, data: parsed.data.signatures };
      } catch {
        return { ok: false, reason: "unavailable" };
      }
    },
  };
}
