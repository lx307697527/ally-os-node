// The finance invoices page's data access (#192 slice 4 — the confirmation
// page). Reads (the list, one invoice with its lines, one invoice's payment
// ledger, one invoice's credit-note ledger) and the confirmation verbs
// (replace draft lines, confirm = issue, void a draft), the collection verbs
// (record a payment, void one, the two checkout-link channels) and the credit
// verbs (#192 红冲的 web 半边: create a credit-note draft, confirm it = the
// credit applies, void a draft). Like every primary-surface adapter, it
// reports the failure mode instead of flattening it:
//
//   { ok: true, data }                       — a good read/write
//   { ok: false, reason: "forbidden" }       — 403 (invoices.manage not held)
//   { ok: false, reason: "notfound" }        — 404 (the anti-probe answer)
//   { ok: false, reason: "conflict", code }  — 409 (invoice exists, state gate)
//   { ok: false, reason: "unavailable" }     — network/5xx/body that won't parse
//
// A 409 carries the server's machine code so the page can say the state gate
// as a sentence ("no longer a draft — reload") instead of a generic failure;
// codes never reach the user themselves. Bodies parse through zod: API
// responses are external input as far as this bundle is concerned.
//
// Money discipline (#192): integer cents everywhere; quantities arrive as
// strings with up to 3 decimals; line totals are server-computed generated
// columns — displayed, never recomputed-and-trusted. The two input parsers
// (dollars → cents, quantity text → number) do exact string arithmetic, so
// "8.45" never becomes 844.9999… on its way to the API.
import { z } from "zod";

const invoiceSchema = z.object({
  id: z.string(),
  number: z.string(),
  invoiceType: z.string(),
  status: z.enum(["draft", "issued", "void"]),
  currency: z.string(),
  subject: z.object({ type: z.string(), id: z.string() }).nullable(),
  // 分期成员事实（#192 分期切片）：index 是创建时落定的序数，count 是成员数
  // （含 void，读时派生）；展示「Part i of n」随分期 web 面切片
  plan: z.object({ id: z.string(), index: z.number().int(), count: z.number().int() }).nullable(),
  totalCents: z.number().int(),
  // 有效贷项合计（#192 红冲切片）：paymentStatus 的应付口径是发票合计 − 它；
  // 贷项台账的展示随贷项动作 web 面切片
  creditedCents: z.number().int(),
  paidCents: z.number().int(),
  paymentStatus: z.enum(["unpaid", "partial", "paid"]),
  issuedAt: z.string().nullable(),
  // R-12-7：null = 未约定账期（不进逾期扫描）；web 面展示到期日 + 逾期派生标记
  dueAt: z.string().nullable(),
  voidedAt: z.string().nullable(),
  voidReason: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const invoiceLineSchema = z.object({
  id: z.string(),
  lineNumber: z.number().int(),
  description: z.string(),
  quantity: z.string(),
  unitPriceCents: z.number().int(),
  lineTotalCents: z.number().int(),
});

const invoiceDetailSchema = invoiceSchema.extend({
  lines: z.array(invoiceLineSchema),
});

const invoiceListSchema = z.object({ invoices: z.array(invoiceSchema) });

const paymentRowSchema = z.object({
  id: z.string(),
  method: z.string(),
  amountCents: z.number().int(),
  surchargeCents: z.number().int().nullable(),
  currency: z.string(),
  receivedAt: z.string(),
  note: z.string().nullable(),
  voidedAt: z.string().nullable(),
  voidReason: z.string().nullable(),
  createdAt: z.string(),
});

const paymentsLedgerSchema = z.object({
  totalCents: z.number().int(),
  creditedCents: z.number().int(),
  paidCents: z.number().int(),
  paymentStatus: z.enum(["unpaid", "partial", "paid"]),
  payments: z.array(paymentRowSchema),
});

const paymentRecordedSchema = z.object({
  id: z.string(),
  paidCents: z.number().int(),
  totalCents: z.number().int(),
  creditedCents: z.number().int(),
  paymentStatus: z.string(),
});

const paymentVoidedSchema = z.object({
  status: z.string(),
  paidCents: z.number().int(),
  creditedCents: z.number().int(),
  paymentStatus: z.string(),
});

/** A checkout answer's money disclosure: the URL the customer pays at, the
 *  gross they will see, and its split — the principal is the invoice's lines,
 *  the surcharge is the provider's fee (R-12-2/3), never part of the invoice. */
const paymentLinkSchema = z.object({
  url: z.string(),
  amountCents: z.number().int(),
  principalCents: z.number().int(),
  surchargeCents: z.number().int(),
  currency: z.string(),
});

// ---- Credit notes (#192 红冲切片的 web 半边):a correction is its own
// document, never an edit of the issued invoice's lines. The ledger row is
// the whole document for this page's purposes — the detail read exists at
// the API but the page works off the ledger. ----

const creditNoteRowSchema = z.object({
  id: z.string(),
  number: z.string(),
  status: z.enum(["draft", "issued", "void"]),
  reason: z.string(),
  currency: z.string(),
  totalCents: z.number().int(),
  issuedAt: z.string().nullable(),
  voidedAt: z.string().nullable(),
  voidReason: z.string().nullable(),
  createdAt: z.string(),
});

const creditNotesLedgerSchema = z.object({
  // 有效合计只数 issued——草稿未过 R-12-6 的财务闸,不能让发票提前变「paid」
  creditedCents: z.number().int(),
  creditNotes: z.array(creditNoteRowSchema),
});

export type Invoice = z.infer<typeof invoiceSchema>;
export type InvoiceDetail = z.infer<typeof invoiceDetailSchema>;
export type InvoiceLine = z.infer<typeof invoiceLineSchema>;
export type InvoiceStatus = Invoice["status"];
export type PaymentRow = z.infer<typeof paymentRowSchema>;
export type PaymentsLedger = z.infer<typeof paymentsLedgerSchema>;
export type CreditNoteRow = z.infer<typeof creditNoteRowSchema>;
export type CreditNotesLedger = z.infer<typeof creditNotesLedgerSchema>;

/** What the client sends for a line — the server is the only amount authority
 *  (RULE-007): quantity and unit price, never a computed total. */
export interface InvoiceLineInput {
  description: string;
  quantity: number;
  unitPriceCents: number;
}

export type InvoiceListResult =
  | { ok: true; data: Invoice[] }
  | { ok: false; reason: "forbidden" | "unavailable" };

/** 404 is meaningful on a detail read: the anti-probe answer renders as "not
 *  available to you" — it does not guess gone-vs-never-yours. */
export type InvoiceGetResult =
  | { ok: true; data: InvoiceDetail }
  | { ok: false; reason: "notfound" | "forbidden" | "unavailable" };

export type PaymentsResult =
  | { ok: true; data: PaymentsLedger }
  | { ok: false; reason: "notfound" | "forbidden" | "unavailable" };

/** A state verb's answer. `confirm` → issued|already, `void` → voided|already,
 *  `updateLines` → ok. A 409 carries the server's state code so the page can
 *  say the gate as a sentence; an unknown or missing code reads as null and
 *  gets the generic sentence. */
export type InvoiceVerbResult =
  | { ok: true; data: { outcome: string } }
  | { ok: false; reason: "forbidden" | "notfound" | "unavailable" }
  | { ok: false; reason: "conflict"; code: string | null };

/** The payment verbs' failure taxonomy — the invoice verb's gates plus the
 *  payment-specific 409s (payment_exists, payment_voided) and, on the link
 *  channels, a 500 misconfigured body that means the environment lacks the
 *  provider (a config fact, not a reload case). */
export type PaymentActionFailure =
  | { ok: false; reason: "forbidden" | "notfound" | "unavailable" }
  | { ok: false; reason: "conflict"; code: string | null }
  | { ok: false; reason: "misconfigured" };

export type PaymentRecordResult =
  | {
      ok: true;
      data: { paidCents: number; totalCents: number; creditedCents: number; paymentStatus: string };
    }
  | PaymentActionFailure;

export type PaymentVoidResult =
  | {
      ok: true;
      data: { outcome: string; paidCents: number; creditedCents: number; paymentStatus: string };
    }
  | PaymentActionFailure;

export type PaymentLinkResult =
  | {
      ok: true;
      data: {
        url: string;
        amountCents: number;
        principalCents: number;
        surchargeCents: number;
        currency: string;
      };
    }
  | PaymentActionFailure;

/** The credit verbs' failure taxonomy: the shared gates (403/404/network)
 *  plus a 409 that carries the credit domain's own state code — the boundary
 *  (credit_exceeds_invoice), the gates it inherits from the invoice
 *  (not_issued, invoice_voided), the note's own state (credit_note_voided,
 *  not_voidable) and the missing numbering rule (numbering_not_configured).
 *  Codes never reach the user; the page says each as its own sentence. */
export type CreditActionFailure =
  | { ok: false; reason: "forbidden" | "notfound" | "unavailable" }
  | { ok: false; reason: "conflict"; code: string | null };

export type CreditNotesResult =
  | { ok: true; data: CreditNotesLedger }
  | { ok: false; reason: "notfound" | "forbidden" | "unavailable" };

/** A creation's answer: the new document's id and number. A draft credits
 *  nothing — applying it is the confirm gate's own verb. */
export type CreditNoteCreateResult =
  | { ok: true; data: { id: string; number: string } }
  | CreditActionFailure;

/** A state verb's answer, the invoice verbs' shape: `confirm` → issued|already,
 *  `void` → voided|already. */
export type CreditNoteVerbResult =
  | { ok: true; data: { outcome: string } }
  | CreditActionFailure;

/** What the client sends when crediting an invoice — the server is the only
 *  amount authority (RULE-007), and the reason is the correction's narrative
 *  body (the API refuses a reasonless credit). */
export interface CreditNoteCreateInput {
  reason: string;
  lines: InvoiceLineInput[];
}

/** The manual booking's method — the server's PAYMENT_METHODS wordlist (the
 *  ledger stays open-ended; a booked row's method renders whatever arrived). */
export type PaymentMethod = "card" | "paypal" | "wire_ach";

export interface PaymentRecordInput {
  amountCents: number;
  method: PaymentMethod;
  /** Full ISO instant of when the money actually arrived; absent means now. */
  receivedAtIso?: string;
  note?: string;
}

export interface InvoiceAdapters {
  list(status?: InvoiceStatus): Promise<InvoiceListResult>;
  get(id: string): Promise<InvoiceGetResult>;
  payments(id: string): Promise<PaymentsResult>;
  updateLines(id: string, lines: InvoiceLineInput[]): Promise<InvoiceVerbResult>;
  /** `dueInDays` absent = no agreed terms (the server leaves dueAt null); 0
   *  is a real value — due on receipt. */
  confirm(id: string, dueInDays?: number): Promise<InvoiceVerbResult>;
  voidInvoice(id: string, reason?: string): Promise<InvoiceVerbResult>;
  recordPayment(id: string, input: PaymentRecordInput): Promise<PaymentRecordResult>;
  voidPayment(paymentId: string, reason: string): Promise<PaymentVoidResult>;
  stripeLink(id: string): Promise<PaymentLinkResult>;
  paypalLink(id: string): Promise<PaymentLinkResult>;
  creditNotes(id: string): Promise<CreditNotesResult>;
  createCreditNote(id: string, input: CreditNoteCreateInput): Promise<CreditNoteCreateResult>;
  confirmCreditNote(creditNoteId: string): Promise<CreditNoteVerbResult>;
  voidCreditNote(creditNoteId: string, reason?: string): Promise<CreditNoteVerbResult>;
}

/** The state verbs' shared failure mapping: 403/404/409, a 409 carrying the
 *  server's gate code, everything else unavailable. Misconfiguration is the
 *  link channels' own answer and never comes from here. */
async function actionFailure(
  res: Response,
): Promise<
  | { ok: false; reason: "forbidden" | "notfound" | "unavailable" }
  | { ok: false; reason: "conflict"; code: string | null }
> {
  if (res.status === 403) return { ok: false, reason: "forbidden" };
  if (res.status === 404) return { ok: false, reason: "notfound" };
  if (res.status === 409) {
    let code: string | null = null;
    try {
      const parsed = z.object({ error: z.string() }).safeParse(await res.json());
      if (parsed.success) code = parsed.data.error;
    } catch {
      // an unparseable 409 body still reads as a conflict, code unknown
    }
    return { ok: false, reason: "conflict", code };
  }
  return { ok: false, reason: "unavailable" };
}

export function createInvoiceAdapters(fetchFn: typeof fetch = fetch): InvoiceAdapters {
  async function verb(res: Response): Promise<InvoiceVerbResult> {
    if (!res.ok) return await actionFailure(res);
    try {
      const parsed = z.object({ status: z.string() }).safeParse(await res.json());
      if (!parsed.success) return { ok: false, reason: "unavailable" };
      return { ok: true, data: { outcome: parsed.data.status } };
    } catch {
      return { ok: false, reason: "unavailable" };
    }
  }

  return {
    async list(status?: InvoiceStatus): Promise<InvoiceListResult> {
      const params = new URLSearchParams();
      if (status !== undefined) params.set("status", status);
      const query = params.toString();
      try {
        const res = await fetchFn(query === "" ? "/api/invoices" : `/api/invoices?${query}`);
        if (res.status === 403) return { ok: false, reason: "forbidden" };
        if (!res.ok) return { ok: false, reason: "unavailable" };
        const parsed = invoiceListSchema.safeParse(await res.json());
        if (!parsed.success) return { ok: false, reason: "unavailable" };
        return { ok: true, data: parsed.data.invoices };
      } catch {
        return { ok: false, reason: "unavailable" };
      }
    },

    async get(id: string): Promise<InvoiceGetResult> {
      try {
        const res = await fetchFn(`/api/invoices/${encodeURIComponent(id)}`);
        if (res.status === 404) return { ok: false, reason: "notfound" };
        if (res.status === 403) return { ok: false, reason: "forbidden" };
        if (!res.ok) return { ok: false, reason: "unavailable" };
        const parsed = invoiceDetailSchema.safeParse(await res.json());
        if (!parsed.success) return { ok: false, reason: "unavailable" };
        return { ok: true, data: parsed.data };
      } catch {
        return { ok: false, reason: "unavailable" };
      }
    },

    async payments(id: string): Promise<PaymentsResult> {
      try {
        const res = await fetchFn(`/api/invoices/${encodeURIComponent(id)}/payments`);
        if (res.status === 404) return { ok: false, reason: "notfound" };
        if (res.status === 403) return { ok: false, reason: "forbidden" };
        if (!res.ok) return { ok: false, reason: "unavailable" };
        const parsed = paymentsLedgerSchema.safeParse(await res.json());
        if (!parsed.success) return { ok: false, reason: "unavailable" };
        return { ok: true, data: parsed.data };
      } catch {
        return { ok: false, reason: "unavailable" };
      }
    },

    async updateLines(id: string, lines: InvoiceLineInput[]): Promise<InvoiceVerbResult> {
      try {
        const res = await fetchFn(`/api/invoices/${encodeURIComponent(id)}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ lines }),
        });
        return await verb(res);
      } catch {
        return { ok: false, reason: "unavailable" };
      }
    },

    async confirm(id: string, dueInDays?: number): Promise<InvoiceVerbResult> {
      try {
        const res = await fetchFn(
          `/api/invoices/${encodeURIComponent(id)}/confirm`,
          dueInDays === undefined
            ? { method: "POST" }
            : {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ dueInDays }),
              },
        );
        return await verb(res);
      } catch {
        return { ok: false, reason: "unavailable" };
      }
    },

    async voidInvoice(id: string, reason?: string): Promise<InvoiceVerbResult> {
      try {
        const res = await fetchFn(`/api/invoices/${encodeURIComponent(id)}/void`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(reason === undefined || reason.trim() === "" ? {} : { reason: reason.trim() }),
        });
        return await verb(res);
      } catch {
        return { ok: false, reason: "unavailable" };
      }
    },

    async recordPayment(id: string, input: PaymentRecordInput): Promise<PaymentRecordResult> {
      try {
        const res = await fetchFn(`/api/invoices/${encodeURIComponent(id)}/payments`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            amountCents: input.amountCents,
            method: input.method,
            ...(input.receivedAtIso !== undefined ? { receivedAt: input.receivedAtIso } : {}),
            ...(input.note !== undefined && input.note.trim() !== "" ? { note: input.note.trim() } : {}),
          }),
        });
        if (!res.ok) return await actionFailure(res);
        const parsed = paymentRecordedSchema.safeParse(await res.json());
        if (!parsed.success) return { ok: false, reason: "unavailable" };
        return {
          ok: true,
          data: {
            paidCents: parsed.data.paidCents,
            totalCents: parsed.data.totalCents,
            creditedCents: parsed.data.creditedCents,
            paymentStatus: parsed.data.paymentStatus,
          },
        };
      } catch {
        return { ok: false, reason: "unavailable" };
      }
    },

    async voidPayment(paymentId: string, reason: string): Promise<PaymentVoidResult> {
      try {
        const res = await fetchFn(`/api/payments/${encodeURIComponent(paymentId)}/void`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reason: reason.trim() }),
        });
        if (!res.ok) return await actionFailure(res);
        const parsed = paymentVoidedSchema.safeParse(await res.json());
        if (!parsed.success) return { ok: false, reason: "unavailable" };
        return {
          ok: true,
          data: {
            outcome: parsed.data.status,
            paidCents: parsed.data.paidCents,
            creditedCents: parsed.data.creditedCents,
            paymentStatus: parsed.data.paymentStatus,
          },
        };
      } catch {
        return { ok: false, reason: "unavailable" };
      }
    },

    async stripeLink(id: string): Promise<PaymentLinkResult> {
      return paymentLink(
        fetchFn,
        `/api/invoices/${encodeURIComponent(id)}/stripe-checkout`,
      );
    },

    async paypalLink(id: string): Promise<PaymentLinkResult> {
      return paymentLink(
        fetchFn,
        `/api/invoices/${encodeURIComponent(id)}/paypal-checkout`,
      );
    },

    async creditNotes(id: string): Promise<CreditNotesResult> {
      try {
        const res = await fetchFn(`/api/invoices/${encodeURIComponent(id)}/credit-notes`);
        if (res.status === 404) return { ok: false, reason: "notfound" };
        if (res.status === 403) return { ok: false, reason: "forbidden" };
        if (!res.ok) return { ok: false, reason: "unavailable" };
        const parsed = creditNotesLedgerSchema.safeParse(await res.json());
        if (!parsed.success) return { ok: false, reason: "unavailable" };
        return { ok: true, data: parsed.data };
      } catch {
        return { ok: false, reason: "unavailable" };
      }
    },

    async createCreditNote(id: string, input: CreditNoteCreateInput): Promise<CreditNoteCreateResult> {
      try {
        const res = await fetchFn(`/api/invoices/${encodeURIComponent(id)}/credit-notes`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            reason: input.reason,
            lines: input.lines.map((line) => ({
              description: line.description,
              quantity: line.quantity,
              unitPriceCents: line.unitPriceCents,
            })),
          }),
        });
        if (!res.ok) return await actionFailure(res);
        const parsed = z
          .object({ id: z.string(), number: z.string() })
          .safeParse(await res.json());
        if (!parsed.success) return { ok: false, reason: "unavailable" };
        return { ok: true, data: parsed.data };
      } catch {
        return { ok: false, reason: "unavailable" };
      }
    },

    async confirmCreditNote(creditNoteId: string): Promise<CreditNoteVerbResult> {
      try {
        const res = await fetchFn(
          `/api/credit-notes/${encodeURIComponent(creditNoteId)}/confirm`,
          { method: "POST" },
        );
        return await verb(res);
      } catch {
        return { ok: false, reason: "unavailable" };
      }
    },

    async voidCreditNote(creditNoteId: string, reason?: string): Promise<CreditNoteVerbResult> {
      try {
        const res = await fetchFn(`/api/credit-notes/${encodeURIComponent(creditNoteId)}/void`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            reason === undefined || reason.trim() === "" ? {} : { reason: reason.trim() },
          ),
        });
        return await verb(res);
      } catch {
        return { ok: false, reason: "unavailable" };
      }
    },
  };
}

/** The two checkout channels answer in one shape: a 201 with the customer's
 *  URL and the gross/principal/surcharge disclosure, or a 500 misconfigured
 *  body naming the environment's gap — read from the body so a different 500
 *  stays a generic unavailable. */
async function paymentLink(fetchFn: typeof fetch, url: string): Promise<PaymentLinkResult> {
  try {
    const res = await fetchFn(url, { method: "POST" });
    if (res.status === 500) {
      try {
        const parsed = z.object({ error: z.string() }).safeParse(await res.json());
        if (parsed.success && parsed.data.error === "misconfigured") {
          return { ok: false, reason: "misconfigured" };
        }
      } catch {
        // a 500 with no JSON body is a server failure, not a config fact
      }
      return { ok: false, reason: "unavailable" };
    }
    if (!res.ok) return await actionFailure(res);
    const parsed = paymentLinkSchema.safeParse(await res.json());
    if (!parsed.success) return { ok: false, reason: "unavailable" };
    return { ok: true, data: parsed.data };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

/**
 * Integer cents → human money, the server's own format (billing/payment-alerts
 * formatMoney): `USD 1,500.00` — currency ISO prefix, en-US grouping, fixed
 * 2dp. One format across the bell, the list and the detail page.
 */
export function formatMoney(amountCents: number, currency: string | null): string {
  const negative = amountCents < 0;
  const abs = Math.abs(amountCents);
  const dollars = `${Math.floor(abs / 100).toLocaleString("en-US")}.${String(abs % 100).padStart(2, "0")}`;
  return `${negative ? "-" : ""}${currency === null ? "" : `${currency.toUpperCase()} `}${dollars}`;
}

/**
 * A dollars text input → integer cents, or null when it is not a clean
 * non-negative amount. Exact string arithmetic: no float ever touches the
 * value ("8.45" → 845, not 844.9999…). Allows thousands commas — finance
 * reads big numbers with them.
 */
export function parseDollarsToCents(text: string): number | null {
  const cleaned = text.replaceAll(",", "").trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(cleaned)) return null;
  const [whole = "", frac = ""] = cleaned.split(".");
  const cents = Number(whole) * 100 + Number((frac + "00").slice(0, 2));
  return cents > 2_000_000_000 ? null : cents;
}

/**
 * A quantity text input → a JSON number, or null. The API's admission is a
 * number with at most 3 decimals and the same positive/upper bounds — the
 * regex guarantees the decimals, the numeric checks mirror the server so a
 * doomed submission is refused in the form, not by a round trip.
 */
export function parseQuantity(text: string): number | null {
  const cleaned = text.trim();
  if (!/^\d+(?:\.\d{1,3})?$/.test(cleaned)) return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value) || value <= 0 || value > 999_999_999) return null;
  return value;
}

/**
 * A datetime-local input's value → a full UTC ISO string (the API's
 * `z.iso.datetime()`), or null when empty/unparseable — the field is
 * optional, but junk typed into it is refused in the form, not by a round
 * trip. `Date` reads a wall-clock value in the viewer's own timezone, so the
 * instant is the one the finance person meant.
 */
export function parseLocalDateTimeToIso(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

/**
 * A custom payment-terms text input → whole days 0–365, or null. Mirrors the
 * confirm endpoint's zod admission (`dueInDays` int 0–365; 0 = due on
 * receipt, 365 = the cap) so a doomed submission is refused in the form, not
 * by a round trip.
 */
export function parseDueInDays(text: string): number | null {
  const cleaned = text.trim();
  if (!/^\d{1,3}$/.test(cleaned)) return null;
  const value = Number(cleaned);
  return value <= 365 ? value : null;
}

/**
 * The overdue scan's rule as a display fact (R-12-7): past due and still
 * owing. The server's `paymentStatus` is the paid half of the derivation —
 * a $0 invoice is vacuously paid — so this reads exactly what the daily
 * worker reads, at render time. Display-only: the reminder ledger, not the
 * clock, decides who actually gets a bell.
 */
export function isInvoiceOverdue(
  invoice: { dueAt: string | null; paymentStatus: string },
  now: Date = new Date(),
): boolean {
  return (
    invoice.dueAt !== null &&
    invoice.paymentStatus !== "paid" &&
    new Date(invoice.dueAt).getTime() < now.getTime()
  );
}
