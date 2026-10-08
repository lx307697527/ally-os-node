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

  it("the payment ledger is read-only and shows voided corrections — money rows are never deleted", () => {
    expect(detail).toContain("PaymentsSection");
    expect(detail).toContain('data-testid="invoice-payments-row"');
    expect(detail).toContain("surchargeCents !== null");
    expect(detail).toContain("voided");
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
