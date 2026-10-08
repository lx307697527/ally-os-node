// #192 slice 4's web half, checked as source text — the same jsdom-free shape
// the tasks/audit tests use. What matters: the page reads the real endpoints,
// every state is said (loading / forbidden / unavailable / empty), the
// confirmation page's disciplines are ON the page (drafts are proposals,
// confirming issues, issued lines never change, the server computes totals,
// money is integer cents end to end), and the shell/route wiring uses the
// same table the rail prints.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = dirname(fileURLToPath(import.meta.url));
const client = readFileSync(join(SRC, "shared", "lib", "invoices-client.ts"), "utf8");
const list = readFileSync(join(SRC, "shared", "pages", "Invoices.tsx"), "utf8");
const detail = readFileSync(join(SRC, "shared", "pages", "InvoiceDetail.tsx"), "utf8");
const app = readFileSync(join(SRC, "App.tsx"), "utf8");
const rail = readFileSync(join(SRC, "shared", "shell", "rail-groups.ts"), "utf8");

describe("invoices client (#192 slice 4)", () => {
  it("reads and writes the real endpoints, bodies parsed by zod", () => {
    expect(client).toContain('"/api/invoices"');
    expect(client).toContain("`/api/invoices?${query}`");
    expect(client).toContain("`/api/invoices/${encodeURIComponent(id)}/confirm`");
    expect(client).toContain("`/api/invoices/${encodeURIComponent(id)}/void`");
    expect(client).toContain("`/api/invoices/${encodeURIComponent(id)}/payments`");
    expect(client).toContain('method: "PATCH"');
    expect(client).toContain("invoiceListSchema.safeParse");
    expect(client).toContain("invoiceDetailSchema.safeParse");
    expect(client).toContain("paymentsLedgerSchema.safeParse");
  });

  it("reports the failure mode instead of flattening it — a 409 carries the state code", () => {
    expect(client).toContain('reason: "forbidden"');
    expect(client).toContain('reason: "notfound"');
    expect(client).toContain('reason: "conflict"');
    expect(client).toContain('reason: "unavailable"');
    expect(client).toContain("reason: \"conflict\", code");
  });

  it("money is integer cents end to end — exact string parsing, never float", () => {
    expect(client).toContain("export function formatMoney");
    expect(client).toContain("export function parseDollarsToCents");
    expect(client).toContain("export function parseQuantity");
    expect(client).toContain("/^\\d+(?:\\.\\d{1,2})?$/");
    expect(client).toContain("/^\\d+(?:\\.\\d{1,3})?$/");
  });
});

describe("invoices list page (#192 slice 4)", () => {
  it("every state is said: loading, forbidden, unavailable, empty, list", () => {
    expect(list).toContain('data-testid="invoices-loading"');
    expect(list).toContain('data-testid="invoices-forbidden"');
    expect(list).toContain('data-testid="invoices-unavailable"');
    expect(list).toContain('data-testid="invoices-empty"');
    expect(list).toContain('data-testid="invoices-list"');
  });

  it("draft is the default filter — the finance main read is what waits for confirmation", () => {
    expect(list).toContain('useState<InvoiceStatus | "all">("draft")');
    expect(list).toContain('data-testid={`invoices-filter-${chip.value}`}');
  });

  it("the first screen says the discipline: nothing reaches a customer before finance confirms", () => {
    expect(list).toContain("Every invoice starts as a draft the system proposed");
    expect(list).toContain("Confirming issues the invoice");
  });

  it("the number is the way in; void keeps the strike", () => {
    expect(list).toContain("to={`/invoices/${row.id}`}");
    expect(list).toContain('data-testid="invoices-row-number"');
    expect(list).toContain('"text-ui text-ink-soft line-through hover:text-link"');
  });
});

describe("invoice detail page (#192 slice 4)", () => {
  it("every state is said: loading, unavailable, lines, payments", () => {
    expect(detail).toContain('data-testid="invoice-detail-loading"');
    expect(detail).toContain('data-testid="invoice-detail-unavailable"');
    expect(detail).toContain('data-testid="invoice-lines"');
    expect(detail).toContain('data-testid="invoice-payments-loading"');
    expect(detail).toContain('data-testid="invoice-payments-unavailable"');
    expect(detail).toContain('data-testid="invoice-payments-empty"');
  });

  it("the confirm dialog shows the money it commits and says issuing is final", () => {
    expect(detail).toContain("ConfirmIssueDialog");
    expect(detail).toContain("formatMoney(props.invoice.totalCents, props.invoice.currency)");
    expect(detail).toContain("issued invoice can no longer be edited");
  });

  it("the confirm and void verbs speak the real routes; outcomes flow back as flash", () => {
    expect(detail).toContain("invoiceAdapters.confirm(props.invoice.id)");
    expect(detail).toContain("invoiceAdapters.confirm(props.invoice.id, dueInDays)");
    expect(detail).toContain("invoiceAdapters.voidInvoice(");
    expect(detail).toContain('data-testid="invoice-confirm-go"');
    expect(detail).toContain('data-testid="invoice-void-go"');
    expect(detail).toContain('data-testid="invoice-flash"');
  });

  it("draft-only actions: confirm, void and edit never render for issued or void invoices", () => {
    expect(detail).toContain('const isDraft = data.status === "draft";');
    expect(detail).toContain("{isDraft && !editing ? (");
    expect(detail).toContain('data-testid="invoice-draft-actions"');
  });

  it("the editor replaces whole lines and computes no totals of its own", () => {
    expect(detail).toContain("invoiceAdapters.updateLines(props.invoice.id, lines)");
    expect(detail).toContain("Totals are computed by the server");
    expect(detail).toContain("parseDollarsToCents(row.unitPrice)");
    expect(detail).toContain("parseQuantity(row.quantity)");
  });

  it("a 409's machine code is said as the gate's sentence — codes never reach the user", () => {
    expect(detail).toContain('result.code === "not_draft"');
    expect(detail).toContain('result.code === "invoice_voided"');
    expect(detail).toContain('result.code === "not_voidable"');
    expect(detail).toContain("reload to see its current state");
  });

  it("the ledger shows voided corrections — money rows are never deleted", () => {
    expect(detail).toContain("PaymentsSection");
    expect(detail).toContain('data-testid="invoice-payments-row"');
    expect(detail).toContain("surchargeCents !== null");
    expect(detail).toContain("voided");
  });
});

describe("payment actions (#192 remaining — the collection verbs' web face)", () => {
  it("an issued invoice carries the three collection actions beside its ledger; drafts and voids get none", () => {
    expect(detail).toContain('data.status === "issued"');
    expect(detail).toContain('data-testid="invoice-payment-actions"');
    expect(detail).toContain('data-testid="invoice-record-payment"');
    expect(detail).toContain('data-testid="invoice-stripe-link"');
    expect(detail).toContain('data-testid="invoice-paypal-link"');
  });

  it("the record dialog takes only the facts of an arrival, and says why link money is not recorded by hand", () => {
    expect(detail).toContain("RecordPaymentDialog");
    expect(detail).toContain('data-testid="invoice-record-amount"');
    expect(detail).toContain('data-testid="invoice-record-method"');
    expect(detail).toContain('data-testid="invoice-record-received-at"');
    expect(detail).toContain('data-testid="invoice-record-note"');
    expect(detail).toContain("double-count");
    expect(detail).toContain("cannot be in the future");
    expect(detail).toContain("parseDollarsToCents(");
  });

  it("voiding a booked payment demands a reason, and only live rows offer the verb", () => {
    expect(detail).toContain("VoidPaymentDialog");
    expect(detail).toContain('data-testid="invoice-payment-void"');
    expect(detail).toContain('data-testid="invoice-payment-void-reason"');
    expect(detail).toContain("row.voidedAt === null");
    expect(detail).toContain("never deleted");
  });

  it("the link dialog hands finance the customer's URL with the surcharge split and a copy", () => {
    expect(detail).toContain("PaymentLinkDialog");
    expect(detail).toContain('data-testid="invoice-link-url"');
    expect(detail).toContain('data-testid="invoice-link-copy"');
    expect(detail).toContain("data.surchargeCents");
    expect(detail).toContain("books the payment");
  });

  it("each payment gate has its own sentence; misconfiguration is a config fact, not a reload case", () => {
    expect(detail).toContain('code === "not_issued"');
    expect(detail).toContain('code === "invoice_voided"');
    expect(detail).toContain('code === "payment_exists"');
    expect(detail).toContain('code === "payment_voided"');
    expect(detail).toContain('code === "nothing_to_collect"');
    expect(detail).toContain('code === "surcharge_rule_unusable"');
    expect(detail).toContain('"misconfigured"');
  });

  it("outcomes and refusals share the page's message line, said as what they are", () => {
    expect(detail).toContain('kind: "ok"');
    expect(detail).toContain('kind: "error"');
    expect(detail).toContain('data-testid="invoice-flash"');
  });
});

describe("payment terms and due dates (#192 remaining — R-12-7's web face)", () => {
  it("the confirm dialog asks for the terms: contract words as presets, a custom-days field beside them", () => {
    expect(detail).toContain("Payment terms");
    expect(detail).toContain('data-testid="invoice-confirm-terms"');
    expect(detail).toContain('data-testid="invoice-confirm-custom-days"');
    expect(detail).toContain("No agreed terms");
    expect(detail).toContain("Due on receipt");
    expect(detail).toContain("Net 15");
    expect(detail).toContain("Net 60");
    expect(detail).toContain("parseDueInDays(");
  });

  it("the terms choice says what it commits: the due preview and the scan's discipline, said on the dialog", () => {
    expect(detail).toContain('data-testid="invoice-confirm-due-preview"');
    expect(detail).toContain("86_400_000");
    expect(detail).toContain("never chases the customer");
  });

  it("the due date is said where finance reads it — a Due stat on the detail, the date on every list row", () => {
    expect(detail).toContain('data-testid="invoice-detail-due"');
    expect(detail).toContain("data.dueAt !== null");
    expect(list).toContain("row.dueAt !== null");
  });

  it("overdue is a display fact with the scan's own rule: past due and still owing", () => {
    expect(detail).toContain("isInvoiceOverdue(");
    expect(list).toContain("isInvoiceOverdue(");
    expect(detail).toContain('overdue ? "text-err" : "text-ink"');
  });
});

describe("credit notes web face (#192 红冲的 web 半边)", () => {
  it("the client reads the real credit endpoints and parses the ledger by zod", () => {
    expect(client).toContain("`/api/invoices/${encodeURIComponent(id)}/credit-notes`");
    expect(client).toContain("`/api/credit-notes/${encodeURIComponent(creditNoteId)}/confirm`");
    expect(client).toContain("`/api/credit-notes/${encodeURIComponent(creditNoteId)}/void`");
    expect(client).toContain("creditNotesLedgerSchema.safeParse");
    expect(client).toContain("createCreditNote");
  });

  it("every state is said on the detail page: loading, unavailable, empty, ledger, credited money", () => {
    expect(detail).toContain('data-testid="invoice-credit-section"');
    expect(detail).toContain('data-testid="invoice-credits-loading"');
    expect(detail).toContain('data-testid="invoice-credits-unavailable"');
    expect(detail).toContain('data-testid="invoice-credits-empty"');
    expect(detail).toContain('data-testid="invoice-credits-list"');
    expect(detail).toContain('data-testid="invoice-detail-credited"');
    expect(detail).toContain("data.creditedCents > 0");
  });

  it("the ledger section is an issued-invoice fact — credits cannot exist on a draft or void invoice", () => {
    expect(detail).toContain("<CreditNotesSection");
    expect(detail).toContain('data-testid="invoice-credit-create"');
    expect(detail).toContain("CreateCreditNoteDialog");
    expect(detail).toContain("ConfirmCreditNoteDialog");
    expect(detail).toContain("VoidCreditNoteDialog");
  });

  it("R-12-6's gate is said on the page: a draft credits nothing, issued is final, corrections are new documents", () => {
    expect(detail).toContain("Issue credit note");
    expect(detail).toContain("Confirm credit note");
    expect(detail).toContain("it credits nothing until it is confirmed");
    expect(detail).toContain("the credited total counts confirmed notes");
    expect(detail).toContain("it never edits the invoice's own lines");
    expect(detail).toContain("An issued credit note is final");
  });

  it("each credit gate has its own sentence; codes never reach the user", () => {
    expect(detail).toContain('code === "not_issued"');
    expect(detail).toContain('code === "invoice_voided"');
    expect(detail).toContain('code === "credit_exceeds_invoice"');
    expect(detail).toContain('code === "numbering_not_configured"');
    expect(detail).toContain('code === "credit_note_voided"');
    expect(detail).toContain('code === "not_voidable"');
    expect(detail).toContain("returning money is the refund flow");
  });

  it("the create dialog keeps the money discipline: exact string parsing, reason required, no client totals", () => {
    expect(detail).toContain("Write why this credit is being issued");
    expect(detail).toContain("amounts are computed by the server");
    expect(detail).toContain("parseQuantity(row.quantity)");
    expect(detail).toContain("parseDollarsToCents(row.unitPrice)");
  });

  it("only a draft row offers verbs; voided notes stay visible struck through — records, never deleted", () => {
    expect(detail).toContain('note.status === "draft"');
    expect(detail).toContain('note.status === "void" ? "text-ink-soft line-through" : "text-ink"');
    expect(detail).toContain("voidReason !== null");
  });
});

describe("installment plans web face (#192 分期的 web 半边)", () => {
  it("the client reads the real plan endpoints and parses the ledger by zod", () => {
    expect(client).toContain("`/api/invoice-plans/${encodeURIComponent(planId)}`");
    expect(client).toContain('"/api/invoice-plans"');
    expect(client).toContain("invoicePlanSchema.safeParse");
    expect(client).toContain("invoicePlanCreatedSchema.safeParse");
    expect(client).toContain("createInvoicePlan");
  });

  it("the plan section renders only for a member invoice — a plan fact, not a decoration", () => {
    expect(detail).toContain("<PlanSection");
    expect(detail).toContain("data.plan !== null ? <PlanSection memberOf={data.plan} /> : null");
    expect(detail).toContain('data-testid="invoice-plan-section"');
  });

  it("every plan state is said: loading, unavailable, parts ledger, money blocks", () => {
    expect(detail).toContain('data-testid="invoice-plan-loading"');
    expect(detail).toContain('data-testid="invoice-plan-unavailable"');
    expect(detail).toContain('data-testid="invoice-plan-parts"');
    expect(detail).toContain('data-testid="invoice-plan-agreed"');
    expect(detail).toContain('data-testid="invoice-plan-invoiced"');
    expect(detail).toContain('data-testid="invoice-plan-paid"');
    expect(detail).toContain('data-testid="invoice-plan-outstanding"');
  });

  it("part i of n comes from the server's facts, never a client derivation", () => {
    expect(detail).toContain("part ${String(data.plan.index)} of ${String(data.plan.count)}");
    expect(list).toContain("part ${String(row.plan.index)} of ${String(row.plan.count)}");
    expect(client).toContain("n 含 void(partCount)与在世口径(livePartCount)都由服务端派生");
  });

  it("the drift is exposed, never clamped — both directions said as sentences", () => {
    expect(detail).toContain("plan.uninvoicedCents > 0");
    expect(detail).toContain("plan.uninvoicedCents < 0");
    expect(detail).toContain("left it uninvoiced");
    expect(detail).toContain("edited past the original split");
  });

  it("the plan mints no verbs — every verb lives on each part's own invoice page", () => {
    expect(detail).toContain("The plan is the ledger — confirm, collect and void live on each part's");
    expect(detail).toContain("to={`/invoices/${part.invoiceId}`}");
    expect(detail).toContain('part.status === "void"');
  });

  it("the split action lives on the finance list, its dialog takes a label and parts only", () => {
    expect(list).toContain('data-testid="invoices-plan-create"');
    expect(list).toContain("CreatePlanDialog");
    expect(list).toContain('data-testid="invoices-plan-label"');
    expect(list).toContain('data-testid="invoices-plan-part-amount"');
    expect(list).toContain('data-testid="invoices-plan-add-part"');
    expect(list).toContain("parseDollarsToCents(");
    expect(list).toContain("PLAN_PARTS_MIN = 2");
    expect(list).toContain("PLAN_PARTS_MAX = 12");
    expect(list).toContain("PLAN_TOTAL_MAX_CENTS");
  });

  it("the split dialog keeps the money discipline: no total field, the server stamps the agreed amount", () => {
    expect(list).toContain("The total is stamped by the");
    expect(list).toContain("stamped by the server");
  });

  it("the split's one gate has its own sentence — numbering is configuration, not a reload case", () => {
    expect(list).toContain('code === "numbering_not_configured"');
    expect(list).toContain("ask an admin to set one in the configuration studio");
    expect(list).toContain('data-testid="invoices-flash"');
  });
});

describe("wiring (#192 slice 4)", () => {
  it("the routes exist and the rail item points at them — one table, no drift", () => {
    expect(app).toContain('path="/invoices"');
    expect(app).toContain('path="/invoices/:invoiceId"');
    expect(app).toContain("<Invoices />");
    expect(app).toContain("<InvoiceDetail />");
    expect(rail).toContain('to: "/invoices"');
    expect(rail).toContain('nav: "invoices"');
  });

  it("the billing group is no longer an empty promise — its note tells the truth", () => {
    expect(rail).not.toContain("Arrives with the finance module");
    expect(rail).toContain("The finance back office");
  });

  it("the payment alerts deep-link target exists (bell whitelist parity)", () => {
    expect(detail).toContain('data-testid="invoice-detail-root"');
  });
});
