// The invoice detail page (#192 slice 4 — the finance confirmation page's
// working half): the lines finance checks before issuing, the two state verbs
// (confirm = issue, R-12-6's human gate; void a draft), whole-replacement
// editing of draft lines, and the payment ledger.
//
// Disciplines said on the page, not just enforced by the API:
// - issuing is final — an issued invoice's lines never change (corrections are
//   a later slice's own verbs); the confirm dialog shows the money it commits.
// - the server computes every amount (generated columns; RULE-007) — the
//   editor submits quantities and unit prices only, and shows no totals of
//   its own; the authoritative totals appear after the save lands.
// - money is integer cents end to end; the editor's dollars inputs parse by
//   exact string rules (parseDollarsToCents), never float.
//
// States are honest: loading, not-available (the anti-probe 404), unreachable
// API, and per-verb errors — a 409's machine code is translated into the
// sentence for that gate, a stale view says "reload", a code never reaches
// the user.
import { useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { Button, Card, Heading, Input, Paragraph } from "@ally/ui";

import {
  createInvoiceAdapters,
  formatMoney,
  parseDollarsToCents,
  parseQuantity,
  type InvoiceDetail as InvoiceDetailData,
  type InvoiceLineInput,
  type InvoiceVerbResult,
  type PaymentsLedger,
} from "../lib/invoices-client.ts";

const invoiceAdapters = createInvoiceAdapters();

const invoiceIdSchema = z.uuid();

function formatDay(iso: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(iso));
}

function formatDayTime(iso: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(iso),
  );
}

/** The payment methods' human labels; the wordlist is open — an unknown
 *  method shows verbatim, rendering never guesses. */
function methodLabel(method: string): string {
  if (method === "card") return "Card";
  if (method === "paypal") return "PayPal";
  if (method === "wire_ach") return "Wire / ACH";
  return method;
}

/** A verb's failure said as the sentence for that gate — the server's 409
 *  codes name the gate, this names it for a person. */
function verbError(result: Exclude<InvoiceVerbResult, { ok: true }>): string {
  if (result.reason === "conflict") {
    if (result.code === "not_draft") {
      return "This invoice is no longer an open draft — reload to see its current state.";
    }
    if (result.code === "invoice_voided") {
      return "This invoice has been voided — reload to see its current state.";
    }
    if (result.code === "not_voidable") {
      return "Only a draft can be voided; an issued invoice stays on the books — reload to see its current state.";
    }
    return "The invoice changed while you were working — reload and try again.";
  }
  if (result.reason === "forbidden") {
    return "Your account does not have permission to manage invoices.";
  }
  if (result.reason === "notfound") {
    return "This invoice is no longer available to you.";
  }
  return "The change could not be saved. Reload and try again.";
}

export function InvoiceDetail(): ReactElement {
  const { invoiceId } = useParams();
  if (invoiceId === undefined || !invoiceIdSchema.safeParse(invoiceId).success) {
    return <InvoiceUnavailable />;
  }
  return <InvoiceLoaded invoiceId={invoiceId} />;
}

function InvoiceLoaded(props: { invoiceId: string }): ReactElement {
  const queryClient = useQueryClient();
  const invoice = useQuery({
    queryKey: ["invoices", "detail", props.invoiceId],
    queryFn: () => invoiceAdapters.get(props.invoiceId),
  });
  const ledger = useQuery({
    queryKey: ["invoices", "payments", props.invoiceId],
    queryFn: () => invoiceAdapters.payments(props.invoiceId),
  });

  const data = invoice.data?.ok === true ? invoice.data.data : undefined;

  const [flash, setFlash] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [voidOpen, setVoidOpen] = useState(false);
  const [editing, setEditing] = useState(false);

  // One invalidation refreshes the detail, its ledger and every cached list —
  // a state verb moves the row between filters, a line edit moves the totals.
  function refresh(): void {
    void queryClient.invalidateQueries({ queryKey: ["invoices"] });
  }

  if (invoice.isPending) {
    return (
      <div className="w-full" data-page="invoice-detail" data-testid="invoice-detail-root">
        <Card>
          <Paragraph data-testid="invoice-detail-loading">Loading…</Paragraph>
        </Card>
      </div>
    );
  }
  if (data === undefined) {
    return <InvoiceUnavailable />;
  }

  const isDraft = data.status === "draft";

  return (
    <div className="w-full" data-page="invoice-detail" data-testid="invoice-detail-root">
      <Card>
        <Link
          to="/invoices"
          className="text-ui-sm text-link underline underline-offset-2 hover:text-link-hover"
          data-testid="invoice-detail-back"
        >
          ← All invoices
        </Link>
        <Heading as="h2" className="mt-2" data-testid="invoice-detail-number">
          {data.number}
        </Heading>
        <Paragraph
          className="mt-1 font-mono text-[length:var(--fs-meta)] text-ink-soft"
          data-testid="invoice-detail-meta"
        >
          {data.invoiceType.replace(/_/g, " ")}
          {` · ${data.status === "draft" ? "draft — waiting for finance confirmation" : data.status}`}
          {data.subject !== null ? ` · for ${data.subject.type}` : " · manual"}
          {` · created ${formatDay(data.createdAt)}`}
          {data.status === "issued" && data.issuedAt !== null ? ` · issued ${formatDay(data.issuedAt)}` : ""}
          {data.status === "void" && data.voidedAt !== null ? ` · voided ${formatDay(data.voidedAt)}` : ""}
        </Paragraph>
        {data.voidReason !== null ? (
          <Paragraph className="mt-1 text-ink-soft" data-testid="invoice-detail-void-reason">
            Void reason: {data.voidReason}
          </Paragraph>
        ) : null}

        <div className="mt-3 flex flex-wrap gap-6" data-testid="invoice-detail-money">
          <span data-testid="invoice-detail-total-block">
            <span className="block font-mono text-[length:var(--fs-meta)] text-ink-soft">Total</span>
            <span className="block font-slab text-ui text-ink" data-testid="invoice-detail-total">
              {formatMoney(data.totalCents, data.currency)}
            </span>
          </span>
          <span data-testid="invoice-detail-paid-block">
            <span className="block font-mono text-[length:var(--fs-meta)] text-ink-soft">Paid</span>
            <span className="block font-slab text-ui text-ink" data-testid="invoice-detail-paid">
              {formatMoney(data.paidCents, data.currency)}
            </span>
          </span>
          <span data-testid="invoice-detail-payment-status-block">
            <span className="block font-mono text-[length:var(--fs-meta)] text-ink-soft">Payment status</span>
            <span className="block font-slab text-ui text-ink" data-testid="invoice-detail-payment-status">
              {data.paymentStatus}
            </span>
          </span>
        </div>

        {flash !== null ? (
          <Paragraph className="mt-3 text-ink" data-testid="invoice-flash">
            {flash}
          </Paragraph>
        ) : null}

        {isDraft && !editing ? (
          <div className="mt-3 flex flex-wrap gap-2" data-testid="invoice-draft-actions">
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                setFlash(null);
                setConfirmOpen(true);
              }}
              data-testid="invoice-confirm"
            >
              Confirm and issue
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setFlash(null);
                setVoidOpen(true);
              }}
              data-testid="invoice-void"
            >
              Void draft
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setFlash(null);
                setEditing(true);
              }}
              data-testid="invoice-edit"
            >
              Edit lines
            </Button>
          </div>
        ) : null}

        {editing ? (
          <LinesEditor
            invoice={data}
            onSaved={(message) => {
              setEditing(false);
              setFlash(message);
              refresh();
            }}
            onCancel={() => {
              setEditing(false);
            }}
          />
        ) : (
          <LinesReadonly lines={data.lines} currency={data.currency} />
        )}

        <PaymentsSection
          currency={data.currency}
          ledger={ledger.data?.ok === true ? ledger.data.data : undefined}
          loading={ledger.isPending}
          unavailable={ledger.data?.ok === false}
        />
      </Card>

      {confirmOpen ? (
        <ConfirmIssueDialog
          invoice={data}
          onClose={() => {
            setConfirmOpen(false);
          }}
          onIssued={(outcome) => {
            setConfirmOpen(false);
            setFlash(outcome === "already" ? "Already issued — nothing changed." : "Invoice issued.");
            refresh();
          }}
        />
      ) : null}
      {voidOpen ? (
        <VoidDraftDialog
          invoice={data}
          onClose={() => {
            setVoidOpen(false);
          }}
          onVoided={(outcome) => {
            setVoidOpen(false);
            setFlash(outcome === "already" ? "Already voided — nothing changed." : "Invoice voided.");
            refresh();
          }}
        />
      ) : null}
    </div>
  );
}

function InvoiceUnavailable(): ReactElement {
  return (
    <div className="w-full" data-page="invoice-detail" data-testid="invoice-detail-root">
      <Card>
        <Paragraph className="text-ink-soft" data-testid="invoice-detail-unavailable">
          This invoice is not available — it may not exist, or your account may
          not have the invoicing permission.
        </Paragraph>
        <Paragraph className="mt-2">
          <Link
            to="/invoices"
            className="text-ui-sm text-link underline underline-offset-2 hover:text-link-hover"
          >
            ← All invoices
          </Link>
        </Paragraph>
      </Card>
    </div>
  );
}

/** The issued lines, with the server-computed totals — display only, the
 *  numbers are the generated columns' answer, never a client recomputation. */
function LinesReadonly(props: { lines: InvoiceDetailData["lines"]; currency: string }): ReactElement {
  return (
    <div className="mt-5 border-t border-line pt-4">
      <Heading as="h3">Lines</Heading>
      {props.lines.length === 0 ? (
        <Paragraph className="mt-2 text-ink-soft" data-testid="invoice-lines-empty">
          This invoice has no lines.
        </Paragraph>
      ) : (
        <ul className="mt-2" data-testid="invoice-lines">
          {props.lines.map((line) => (
            <li
              key={line.id}
              className="flex items-start gap-3 border-b border-line py-2"
              data-testid="invoice-line-row"
            >
              <span className="min-w-0 flex-1">
                <span className="block text-ui text-ink">{line.description}</span>
                <span className="mt-0.5 block font-mono text-[length:var(--fs-meta)] text-ink-soft">
                  {`line ${String(line.lineNumber)} · qty ${line.quantity} × ${formatMoney(line.unitPriceCents, props.currency)}`}
                </span>
              </span>
              <span className="font-mono text-ui-sm text-ink" data-testid="invoice-line-total">
                {formatMoney(line.lineTotalCents, props.currency)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Draft-line editing as the API hears it: a WHOLE replacement, row order is
 *  the document's line order. No totals are computed or shown here — the
 *  server's generated columns are the only totals; they appear after saving. */
function LinesEditor(props: {
  invoice: InvoiceDetailData;
  onSaved: (message: string) => void;
  onCancel: () => void;
}): ReactElement {
  const [rows, setRows] = useState<{ description: string; quantity: string; unitPrice: string }[]>(
    props.invoice.lines.map((line) => ({
      description: line.description,
      quantity: line.quantity,
      unitPrice: (line.unitPriceCents / 100).toFixed(2),
    })),
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function updateRow(index: number, patch: Partial<{ description: string; quantity: string; unitPrice: string }>): void {
    setRows(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  function removeRow(index: number): void {
    if (rows.length <= 1) return;
    setRows(rows.filter((_, i) => i !== index));
  }

  async function save(): Promise<void> {
    setError(null);
    const lines: InvoiceLineInput[] = [];
    for (const [index, row] of rows.entries()) {
      const description = row.description.trim();
      const quantity = parseQuantity(row.quantity);
      const unitPriceCents = parseDollarsToCents(row.unitPrice);
      if (description === "") {
        setError(`Line ${String(index + 1)}: write what this line bills for.`);
        return;
      }
      if (quantity === null) {
        setError(`Line ${String(index + 1)}: the quantity must be a positive number with at most three decimals.`);
        return;
      }
      if (unitPriceCents === null) {
        setError(`Line ${String(index + 1)}: the unit price must be a dollar amount like 1,500.00.`);
        return;
      }
      lines.push({ description, quantity, unitPriceCents });
    }
    setSaving(true);
    const result = await invoiceAdapters.updateLines(props.invoice.id, lines);
    setSaving(false);
    if (!result.ok) {
      setError(verbError(result));
      return;
    }
    props.onSaved("Lines updated.");
  }

  return (
    <div className="mt-5 border-t border-line pt-4" data-testid="invoice-edit-form">
      <Heading as="h3">Edit draft lines</Heading>
      <Paragraph className="mt-1 font-mono text-[length:var(--fs-meta)] text-ink-soft">
        Saving replaces all lines — the row order below is the invoice's line
        order. Totals are computed by the server; they appear once the save
        lands.
      </Paragraph>
      <ul className="mt-2 grid gap-2" data-testid="invoice-edit-rows">
        {rows.map((row, index) => (
          <li key={index} className="flex flex-wrap items-center gap-2" data-testid="invoice-edit-row">
            <Input
              type="text"
              value={row.description}
              onChange={(event) => {
                updateRow(index, { description: event.target.value });
              }}
              aria-label={`Line ${String(index + 1)} description`}
              placeholder="What this line bills for"
              className="min-w-[220px] flex-1"
              data-testid="invoice-edit-description"
            />
            <Input
              type="text"
              value={row.quantity}
              onChange={(event) => {
                updateRow(index, { quantity: event.target.value });
              }}
              aria-label={`Line ${String(index + 1)} quantity`}
              placeholder="Quantity"
              className="w-[110px]"
              data-testid="invoice-edit-quantity"
            />
            <Input
              type="text"
              value={row.unitPrice}
              onChange={(event) => {
                updateRow(index, { unitPrice: event.target.value });
              }}
              aria-label={`Line ${String(index + 1)} unit price in dollars`}
              placeholder="Unit price (USD)"
              className="w-[140px]"
              data-testid="invoice-edit-unit-price"
            />
            <Button
              variant="ghost"
              size="sm"
              disabled={rows.length <= 1}
              onClick={() => {
                removeRow(index);
              }}
              aria-label={`Remove line ${String(index + 1)}`}
              data-testid="invoice-edit-remove-line"
            >
              Remove
            </Button>
          </li>
        ))}
      </ul>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setRows([...rows, { description: "", quantity: "", unitPrice: "" }]);
          }}
          data-testid="invoice-edit-add-line"
        >
          Add line
        </Button>
      </div>
      {error !== null ? (
        <Paragraph className="mt-2 text-ink-soft" data-testid="invoice-edit-error">
          {error}
        </Paragraph>
      ) : null}
      <div className="mt-3 flex gap-2">
        <Button variant="primary" size="sm" disabled={saving} onClick={() => { void save(); }} data-testid="invoice-edit-save">
          {saving ? "Saving…" : "Save lines"}
        </Button>
        <Button variant="ghost" size="sm" disabled={saving} onClick={props.onCancel} data-testid="invoice-edit-cancel">
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** Overlay chrome shared by the two verb dialogs — presentational, the page
 *  owns the verb (SignatureDialog's split). */
function DialogFrame(props: {
  labelledBy: string;
  title: string;
  children: ReactNode;
}): ReactElement {
  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-scrim px-6 py-13 outline-none"
      role="dialog"
      aria-modal="true"
      aria-labelledby={props.labelledBy}
      data-testid="invoice-dialog-overlay"
    >
      <Card
        padding="lg"
        className="mt-13 w-full max-w-[var(--width-dialog-560)] border-t-[length:var(--border-accent-width)] border-t-accent shadow-modal"
      >
        <h2
          id={props.labelledBy}
          className="mb-1 font-slab text-[length:var(--fs-h3)] font-semibold tracking-[var(--ls-display)] text-ink"
        >
          {props.title}
        </h2>
        {props.children}
      </Card>
    </div>
  );
}

function ConfirmIssueDialog(props: {
  invoice: InvoiceDetailData;
  onIssued: (outcome: string) => void;
  onClose: () => void;
}): ReactElement {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm(): Promise<void> {
    setBusy(true);
    setError(null);
    const result = await invoiceAdapters.confirm(props.invoice.id);
    setBusy(false);
    if (!result.ok) {
      setError(verbError(result));
      return;
    }
    props.onIssued(result.data.outcome);
  }

  return (
    <DialogFrame labelledBy="invoice-confirm-title" title="Confirm and issue">
      <Paragraph className="mb-4 text-ink-soft">
        Issue <strong>{props.invoice.number}</strong> for{" "}
        <strong>{formatMoney(props.invoice.totalCents, props.invoice.currency)}</strong>? An
        issued invoice can no longer be edited — its lines are locked and
        payments can be booked against it.
      </Paragraph>
      {error !== null ? (
        <Paragraph className="mb-3 text-err" data-testid="invoice-confirm-error">
          {error}
        </Paragraph>
      ) : null}
      <div className="flex items-center gap-3">
        <Button variant="primary" disabled={busy} onClick={() => { void confirm(); }} data-testid="invoice-confirm-go">
          {busy ? "Issuing…" : "Issue invoice"}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={props.onClose} data-testid="invoice-confirm-cancel">
          Cancel
        </Button>
      </div>
    </DialogFrame>
  );
}

function VoidDraftDialog(props: {
  invoice: InvoiceDetailData;
  onVoided: (outcome: string) => void;
  onClose: () => void;
}): ReactElement {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function voidDraft(): Promise<void> {
    setBusy(true);
    setError(null);
    const result = await invoiceAdapters.voidInvoice(
      props.invoice.id,
      reason.trim() === "" ? undefined : reason.trim(),
    );
    setBusy(false);
    if (!result.ok) {
      setError(verbError(result));
      return;
    }
    props.onVoided(result.data.outcome);
  }

  return (
    <DialogFrame labelledBy="invoice-void-title" title="Void draft">
      <Paragraph className="mb-4 text-ink-soft">
        Void <strong>{props.invoice.number}</strong>? The draft is cancelled and
        stays on the books as void — it can never be issued. This cannot be
        undone; a replacement draft is a new invoice.
      </Paragraph>
      <label className="mb-4 block">
        <span className="mb-1 block text-ui-sm font-semibold text-ink">Reason (optional)</span>
        <Input
          type="text"
          value={reason}
          maxLength={500}
          onChange={(event) => {
            setReason(event.target.value);
          }}
          aria-label="Void reason"
          placeholder="Why this draft is being cancelled"
          data-testid="invoice-void-reason"
        />
      </label>
      {error !== null ? (
        <Paragraph className="mb-3 text-err" data-testid="invoice-void-error">
          {error}
        </Paragraph>
      ) : null}
      <div className="flex items-center gap-3">
        <Button variant="primary" disabled={busy} onClick={() => { void voidDraft(); }} data-testid="invoice-void-go">
          {busy ? "Voiding…" : "Void draft"}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={props.onClose} data-testid="invoice-void-cancel">
          Cancel
        </Button>
      </div>
    </DialogFrame>
  );
}

/** The payment ledger, read-only (#192 slice 2's endpoints are the surface).
 *  A booked payment's amount is what it settles of the invoice; the card /
 *  PayPal surcharge is the customer's separate fee, shown next to it. Voided
 *  corrections stay visible — money rows are never deleted. */
function PaymentsSection(props: {
  currency: string;
  ledger: PaymentsLedger | undefined;
  loading: boolean;
  unavailable: boolean;
}): ReactElement {
  return (
    <div className="mt-5 border-t border-line pt-4" data-testid="invoice-payments-section">
      <Heading as="h3">Payments</Heading>
      {props.loading ? (
        <Paragraph className="mt-2" data-testid="invoice-payments-loading">
          Loading…
        </Paragraph>
      ) : props.unavailable || props.ledger === undefined ? (
        <Paragraph className="mt-2 text-ink-soft" data-testid="invoice-payments-unavailable">
          The payment ledger could not be loaded.
        </Paragraph>
      ) : (
        <>
          <Paragraph className="mt-1 font-mono text-[length:var(--fs-meta)] text-ink-soft" data-testid="invoice-payments-summary">
            {`Paid ${formatMoney(props.ledger.paidCents, props.currency)} of ${formatMoney(props.ledger.totalCents, props.currency)} · ${props.ledger.paymentStatus}`}
          </Paragraph>
          {props.ledger.payments.length === 0 ? (
            <Paragraph className="mt-2 text-ink-soft" data-testid="invoice-payments-empty">
              No payments booked yet. Payments appear here once they are
              recorded — an invoice starts collecting only after it is issued.
            </Paragraph>
          ) : (
            <ul className="mt-2" data-testid="invoice-payments-list">
              {props.ledger.payments.map((row) => (
                <li
                  key={row.id}
                  className="border-b border-line py-2"
                  data-testid="invoice-payments-row"
                  data-voided={row.voidedAt !== null}
                >
                  <span
                    className={`block text-ui ${
                      row.voidedAt !== null ? "text-ink-soft line-through" : "text-ink"
                    }`}
                  >
                    {`${methodLabel(row.method)} · ${formatMoney(row.amountCents, row.currency)}`}
                    {row.surchargeCents !== null
                      ? ` (+ ${formatMoney(row.surchargeCents, row.currency)} surcharge)`
                      : ""}
                  </span>
                  <span className="mt-0.5 block font-mono text-[length:var(--fs-meta)] text-ink-soft">
                    {`received ${formatDayTime(row.receivedAt)}`}
                    {row.note !== null ? ` · ${row.note}` : ""}
                    {row.voidedAt !== null
                      ? ` · voided ${formatDay(row.voidedAt)}${row.voidReason !== null ? `: ${row.voidReason}` : ""}`
                      : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
