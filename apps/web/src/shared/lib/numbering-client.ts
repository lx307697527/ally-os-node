// The numbering rules' data access (#225 config face): the two reads (rules,
// numbered subjects) and the two writes (create, update). A config page is a
// primary surface, not a degrading widget — like the audit page, the adapter
// reports the failure mode instead of flattening it, so "why is the table
// empty" always has an answer in words.
//
//   { ok: true, data }                        — the call worked
//   { ok: false, reason: "forbidden" }        — 403: no numbering.configure
//   { ok: false, reason: "unavailable" }      — network/5xx/unparseable body
// and the writes add the specific rejections the kernel speaks: an
// unregistered subject, an active-rule collision (409), a bad body, a
// missing rule. Response bodies are zod-parsed because API responses are
// external input as far as this bundle is concerned.
import { z } from "zod";

// Mirrors NUMBERING_DATE_FORMATS in apps/api/src/numbering/service.ts — the
// server enum is the source of truth; this copy is what the create/edit
// selects offer and what the row parse accepts. numbering-client.test.ts
// pins the mirror against the rendering rules.
export const NUMBERING_DATE_FORMATS = ["YYYY", "YYYYMM", "YYYYMMDD"] as const;
export type NumberingDateFormat = (typeof NUMBERING_DATE_FORMATS)[number];

const ruleRowSchema = z.object({
  id: z.string(),
  subject: z.string(),
  label: z.string(),
  prefix: z.string(),
  dateFormat: z.enum(NUMBERING_DATE_FORMATS).nullable(),
  padding: z.number().int().min(0).max(10),
  startNumber: z.number().int().min(1),
  active: z.boolean(),
  // 已发出的最大号;从未发号为 null——不是 0(0 会冒充「已发到 0 号」的语义)
  lastIssued: z.number().int().min(1).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const rulesPageSchema = z.object({ rules: z.array(ruleRowSchema) });
const subjectsSchema = z.object({
  subjects: z.array(z.object({ subject: z.string(), label: z.string() })),
});
const createdSchema = z.object({ id: z.string() });

export type NumberingRuleRow = z.infer<typeof ruleRowSchema>;
export type NumberedSubjectOption = z.infer<(typeof subjectsSchema)["shape"]["subjects"]["element"]>;

export type NumberingReadResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: "forbidden" | "unavailable" };

export type CreateRuleFailure =
  | "forbidden"
  | "unregistered"
  | "exists"
  | "invalid"
  | "unavailable";
export type UpdateRuleFailure =
  | "forbidden"
  | "not_found"
  | "exists"
  | "invalid"
  | "unavailable";

export interface CreateRuleInput {
  subject: string;
  label: string;
  prefix: string;
  dateFormat: NumberingDateFormat | null;
  padding: number;
  startNumber: number;
}

// startNumber 刻意不在可改清单里:服务端 strict PATCH 显式 400(对已在发的
// 系列无效果,静默忽略会误导),客户端类型从形状上就不给这条路
export interface UpdateRuleInput {
  label?: string;
  prefix?: string;
  dateFormat?: NumberingDateFormat | null;
  padding?: number;
  active?: boolean;
}

async function readJson<T>(
  fetchFn: typeof fetch,
  schema: z.ZodType<T>,
  url: string,
  init?: RequestInit,
): Promise<{ status: number; body: T | null; error: string | null }> {
  try {
    const res = await fetchFn(url, init);
    const raw: unknown = await res.json().catch(() => null);
    const parsed = schema.safeParse(raw);
    return {
      status: res.status,
      body: parsed.success ? parsed.data : null,
      error:
        typeof raw === "object" && raw !== null && "error" in raw
          ? String(raw.error)
          : null,
    };
  } catch {
    return { status: 0, body: null, error: null };
  }
}

export interface NumberingAdapters {
  list(): Promise<NumberingReadResult<NumberingRuleRow[]>>;
  subjects(): Promise<NumberingReadResult<NumberedSubjectOption[]>>;
  create(
    input: CreateRuleInput,
  ): Promise<{ ok: true; data: { id: string } } | { ok: false; reason: CreateRuleFailure }>;
  update(
    id: string,
    input: UpdateRuleInput,
  ): Promise<
    | { ok: true; data: NumberingRuleRow }
    | { ok: false; reason: UpdateRuleFailure }
  >;
}

export function createNumberingAdapters(fetchFn: typeof fetch = fetch): NumberingAdapters {
  return {
    async list() {
      const res = await readJson(fetchFn, rulesPageSchema, "/api/numbering-rules");
      if (res.status === 403) return { ok: false as const, reason: "forbidden" as const };
      if (res.status !== 200 || res.body === null) {
        return { ok: false as const, reason: "unavailable" as const };
      }
      return { ok: true as const, data: res.body.rules };
    },

    async subjects() {
      const res = await readJson(fetchFn, subjectsSchema, "/api/numbering-rules/subjects");
      if (res.status === 403) return { ok: false as const, reason: "forbidden" as const };
      if (res.status !== 200 || res.body === null) {
        return { ok: false as const, reason: "unavailable" as const };
      }
      return { ok: true as const, data: res.body.subjects };
    },

    async create(input) {
      const res = await readJson(fetchFn, createdSchema, "/api/numbering-rules", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      if (res.status === 403) return { ok: false as const, reason: "forbidden" as const };
      if (res.status === 409) return { ok: false as const, reason: "exists" as const };
      if (res.status === 400 && res.error === "unregistered_subject") {
        return { ok: false as const, reason: "unregistered" as const };
      }
      if (res.status === 201 && res.body !== null) {
        return { ok: true as const, data: res.body };
      }
      return { ok: false as const, reason: res.status === 400 ? ("invalid" as const) : ("unavailable" as const) };
    },

    async update(id, input) {
      const res = await readJson(fetchFn, ruleRowSchema, `/api/numbering-rules/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      if (res.status === 403) return { ok: false as const, reason: "forbidden" as const };
      if (res.status === 404) return { ok: false as const, reason: "not_found" as const };
      if (res.status === 409) return { ok: false as const, reason: "exists" as const };
      if (res.status === 200 && res.body !== null) {
        return { ok: true as const, data: res.body };
      }
      return { ok: false as const, reason: res.status === 400 ? ("invalid" as const) : ("unavailable" as const) };
    },
  };
}

/** What the counter hands out next: one past the highest issued number, or
 *  the series' start when nothing has been issued yet. (lastIssued is the
 *  highest issued number and is never 0 — null means "no number minted".) */
export function nextSequenceFor(rule: Pick<NumberingRuleRow, "lastIssued" | "startNumber">): number {
  return (rule.lastIssued ?? rule.startNumber - 1) + 1;
}

function dateSegment(format: NumberingDateFormat, now: Date): string {
  // UTC calendar — the same rendering the server does
  // (apps/api/src/numbering/service.ts formatDocumentNumber); the timezone
  // is a deliberate ruling recorded in docs/numbering.md.
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  if (format === "YYYY") return year;
  if (format === "YYYYMM") return `${year}${month}`;
  return `${year}${month}${day}`;
}

/** The next number a rule would mint, rendered exactly as the server renders
 *  issued numbers: prefix + date segment + "-" + zero-padded sequence. A
 *  preview, not a promise — another allocation can take the number first. */
export function previewNumber(
  rule: Pick<NumberingRuleRow, "prefix" | "dateFormat" | "padding">,
  sequence: number,
  now: Date,
): string {
  const segment = rule.dateFormat === null ? "" : `${dateSegment(rule.dateFormat, now)}-`;
  return `${rule.prefix}${segment}${String(sequence).padStart(rule.padding, "0")}`;
}
