// The invoice detail page (#192 slice 4 — the finance confirmation page's
// working half): the lines finance checks before issuing, the two state verbs
// (confirm = issue, R-12-6's human gate; void a draft), whole-replacement
// editing of draft lines, the payment ledger with its verbs, and the credit
// notes (#192 红冲的 web 半边): the correction ledger with its own verbs —
// create a draft credit note, confirm it (the credit then reduces what the
// customer owes), void a draft.
//
// Disciplines said on the page, not just enforced by the API:
// - issuing is final — an issued invoice's lines never change (corrections
//   are credit notes: new documents, never edits); the confirm dialog shows
//   the money it commits.
// - the server computes every amount (generated columns; RULE-007) — the
//   editor submits quantities and unit prices only, and shows no totals of
//   its own; the authoritative totals appear after the save lands.
// - money is integer cents end to end; the editor's dollars inputs parse by
//   exact string rules (parseDollarsToCents), never float.
// - the collection verbs record facts, not intentions: a manual booking is
//   money that arrived outside a payment link, a void is a correction with a
//   reason, and a link's payment is booked by the provider's confirmation —
//   recording it by hand too would double-count.
// - a credit note credits nothing while it is a draft (R-12-6's gate — the
//   credited total counts confirmed notes only); an issued credit note is
//   final, and crediting stops at the invoice's total.
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
  isInvoiceOverdue,
  parseDollarsToCents,
  parseDueInDays,
  parseLocalDateTimeToIso,
  parseQuantity,
  type CreditActionFailure,
  type CreditNoteRow,
  type CreditNotesLedger,
  type InvoiceDetail as InvoiceDetailData,
  type InvoiceLineInput,
  type InvoiceVerbResult,
  type PaymentActionFailure,
  type PaymentLinkResult,
  type PaymentMethod,
  type PaymentRow,
  type PaymentsLedger,
} from "../lib/invoices-client.ts";

/** The created link handed to the dialog — a refusal never gets here. */
type PaymentLinkData = Extract<PaymentLinkResult, { ok: true }>["data"];

const invoiceAdapters = createInvoiceAdapters();

const invoiceIdSchema = z.uuid();

/** The payment-terms presets (R-12-7): the words a contract uses; the number
 *  is whole days, 0 = due on receipt. "none" = no agreed terms — no due date,
 *  the invoice never enters the overdue scan; "custom" opens the days field
 *  for whatever the contract says (0–365, the server's own admission). */
const TERMS_OPTIONS: readonly { value: string; label: string; days: number | null }[] = [
  { value: "none", label: "No agreed terms", days: null },
  { value: "receipt", label: "Due on receipt", days: 0 },
  { value: "net15", label: "Net 15", days: 15 },
  { value: "net30", label: "Net 30", days: 30 },
  { value: "net60", label: "Net 60", days: 60 },
  { value: "custom", label: "Custom days…", days: null },
];

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

/** The payment verbs' gates, said for a person. Each 409 code names its own
 *  state; misconfiguration is a config fact (the environment lacks the
 *  provider), so its sentence points at setup, never at reloading. */
function paymentActionError(result: Exclude<PaymentActionFailure, { ok: true }>): string {
  if (result.reason === "conflict") {
    if (result.code === "not_issued") {
      return "Only an issued invoice can collect payments — reload to see its current state.";
    }
    if (result.code === "invoice_voided") {
      return "This invoice has been voided — reload to see its current state.";
    }
    if (result.code === "payment_exists") {
      return "A payment from this exact source is already booked — reload the ledger before recording again.";
    }
    if (result.code === "payment_voided") {
      return "That payment row is already voided — reload the ledger to see it.";
    }
    if (result.code === "nothing_to_collect") {
      return "This invoice has nothing to collect — its total is zero.";
    }
    if (result.code === "surcharge_rule_unusable") {
      return "The surcharge rule cannot be read right now — ask an admin to check it in the rules registry, then try the link again.";
    }
    return "The payment state changed while you were working — reload and try again.";
  }
  if (result.reason === "misconfigured") {
    return "This payment provider is not configured on this environment — the link cannot be created.";
  }
  if (result.reason === "forbidden") {
    return "Your account does not have permission to manage invoices.";
  }
  if (result.reason === "notfound") {
    return "This invoice is no longer available to you.";
  }
  return "The change could not be saved. Reload and try again.";
}

/** The credit verbs' gates, said for a person. The codes split by subject —
 *  some belong to the invoice being credited (only an issued invoice can be
 *  credited), some to the boundary (crediting stops at the invoice total),
 *  one to configuration (the numbering rule), two to the note itself. A
 *  404 reads the same whichever document vanished: reload. */
function creditActionError(result: Exclude<CreditActionFailure, { ok: true }>): string {
  if (result.reason === "conflict") {
    if (result.code === "not_issued") {
      return "Only an issued invoice can be credited — reload to see its current state.";
    }
    if (result.code === "invoice_voided") {
      return "This invoice has been voided — reload to see its current state.";
    }
    if (result.code === "credit_exceeds_invoice") {
      return "These lines would push the credited total past the invoice's total — lower the amounts. A credit reduces what the customer owes; returning money is the refund flow, not a credit note.";
    }
    if (result.code === "numbering_not_configured") {
      return "No numbering rule is active for credit notes — ask an admin to set one in the configuration studio, then try again.";
    }
    if (result.code === "credit_note_voided") {
      return "That credit note is voided — reload the ledger to see it.";
    }
    if (result.code === "not_voidable") {
      return "Only a draft credit note can be voided — an issued credit note is final; reload to see its current state.";
    }
    return "The credit note changed while you were working — reload and try again.";
  }
  if (result.reason === "forbidden") {
    return "Your account does not have permission to manage invoices.";
  }
  if (result.reason === "notfound") {
    return "This document is no longer available to you.";
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
  const credits = useQuery({
    queryKey: ["invoices", "credit-notes", props.invoiceId],
    queryFn: () => invoiceAdapters.creditNotes(props.invoiceId),
  });

  const data = invoice.data?.ok === true ? invoice.data.data : undefined;

  const [flash, setFlash] = useState<{ text: string; kind: "ok" | "error" } | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [voidOpen, setVoidOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [recordOpen, setRecordOpen] = useState(false);
  const [voidTarget, setVoidTarget] = useState<PaymentRow | null>(null);
  const [link, setLink] = useState<{ channel: "Stripe" | "PayPal"; data: PaymentLinkData } | null>(null);
  const [linkBusy, setLinkBusy] = useState<false | "stripe" | "paypal">(false);
  const [creditCreateOpen, setCreditCreateOpen] = useState(false);
  const [creditConfirmTarget, setCreditConfirmTarget] = useState<CreditNoteRow | null>(null);
  const [creditVoidTarget, setCreditVoidTarget] = useState<CreditNoteRow | null>(null);

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
  // The scan's own rule, read at render: past due and still owing. Display
  // only — the reminder ledger, not this flag, sends the bells.
  const overdue = isInvoiceOverdue(data);

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
          {data.creditedCents > 0 ? (
            <span data-testid="invoice-detail-credited-block">
              <span className="block font-mono text-[length:var(--fs-meta)] text-ink-soft">Credited</span>
              <span className="block font-slab text-ui text-ink" data-testid="invoice-detail-credited">
                {formatMoney(data.creditedCents, data.currency)}
              </span>
            </span>
          ) : null}
          <span data-testid="invoice-detail-payment-status-block">
            <span className="block font-mono text-[length:var(--fs-meta)] text-ink-soft">Payment status</span>
            <span className="block font-slab text-ui text-ink" data-testid="invoice-detail-payment-status">
              {data.paymentStatus}
            </span>
          </span>
          {data.dueAt !== null ? (
            <span data-testid="invoice-detail-due-block">
              <span className="block font-mono text-[length:var(--fs-meta)] text-ink-soft">Due</span>
              <span
                className={`block font-slab text-ui ${overdue ? "text-err" : "text-ink"}`}
                data-testid="invoice-detail-due"
              >
                {`${formatDay(data.dueAt)}${overdue ? " · overdue" : ""}`}
              </span>
            </span>
          ) : null}
        </div>

        {flash !== null ? (
          <Paragraph
            className={`mt-3 ${flash.kind === "error" ? "text-err" : "text-ink"}`}
            data-testid="invoice-flash"
          >
            {flash.text}
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
              setFlash({ text: message, kind: "ok" });
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
          issued={data.status === "issued"}
          linkBusy={linkBusy}
          onRecordPayment={() => {
            setFlash(null);
            setRecordOpen(true);
          }}
          onPaymentLink={(channel) => {
            setFlash(null);
            setLinkBusy(channel);
            void (channel === "stripe"
              ? invoiceAdapters.stripeLink(data.id)
              : invoiceAdapters.paypalLink(data.id)
            ).then((result) => {
              setLinkBusy(false);
              if (result.ok) {
                setLink({ channel: channel === "stripe" ? "Stripe" : "PayPal", data: result.data });
              } else {
                // A failed link has nothing to hand over, so there is no
                // dialog — the refusal is the page's message line, said as
                // the error it is.
                setFlash({ text: paymentActionError(result), kind: "error" });
              }
            });
          }}
          onVoidPayment={(row) => {
            setFlash(null);
            setVoidTarget(row);
          }}
        />

        {data.status === "issued" ? (
          <CreditNotesSection
            invoiceTotalCents={data.totalCents}
            currency={data.currency}
            ledger={credits.data?.ok === true ? credits.data.data : undefined}
            loading={credits.isPending}
            unavailable={credits.data?.ok === false}
            onCreate={() => {
              setFlash(null);
              setCreditCreateOpen(true);
            }}
            onConfirm={(note) => {
              setFlash(null);
              setCreditConfirmTarget(note);
            }}
            onVoid={(note) => {
              setFlash(null);
              setCreditVoidTarget(note);
            }}
          />
        ) : null}
      </Card>

      {confirmOpen ? (
        <ConfirmIssueDialog
          invoice={data}
          onClose={() => {
            setConfirmOpen(false);
          }}
          onIssued={(outcome) => {
            setConfirmOpen(false);
            setFlash(
              outcome === "already"
                ? { text: "Already issued — nothing changed.", kind: "ok" }
                : { text: "Invoice issued.", kind: "ok" },
            );
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
            setFlash(
              outcome === "already"
                ? { text: "Already voided — nothing changed.", kind: "ok" }
                : { text: "Invoice voided.", kind: "ok" },
            );
            refresh();
          }}
        />
      ) : null}
      {recordOpen ? (
        <RecordPaymentDialog
          invoice={data}
          onClose={() => {
            setRecordOpen(false);
          }}
          onRecorded={(paid) => {
            setRecordOpen(false);
            setFlash({
              text: `Payment recorded — ${formatMoney(paid.paidCents, data.currency)} paid of ${formatMoney(paid.totalCents, data.currency)} (${paid.paymentStatus}).`,
              kind: "ok",
            });
            refresh();
          }}
        />
      ) : null}
      {voidTarget !== null ? (
        <VoidPaymentDialog
          invoice={data}
          payment={voidTarget}
          onClose={() => {
            setVoidTarget(null);
          }}
          onVoided={(outcome) => {
            setVoidTarget(null);
            setFlash({
              text:
                outcome === "already"
                  ? "Already voided — nothing changed."
                  : "Payment voided — the ledger now shows the corrected paid total.",
              kind: "ok",
            });
            refresh();
          }}
        />
      ) : null}
      {link !== null ? (
        <PaymentLinkDialog
          invoice={data}
          channel={link.channel}
          data={link.data}
          onClose={() => {
            setLink(null);
          }}
        />
      ) : null}
      {creditCreateOpen ? (
        <CreateCreditNoteDialog
          invoice={data}
          onClose={() => {
            setCreditCreateOpen(false);
          }}
          onCreated={(created) => {
            setCreditCreateOpen(false);
            setFlash({
              text: `Credit note ${created.number} created as a draft — it credits nothing until it is confirmed.`,
              kind: "ok",
            });
            refresh();
          }}
        />
      ) : null}
      {creditConfirmTarget !== null ? (
        <ConfirmCreditNoteDialog
          invoice={data}
          note={creditConfirmTarget}
          onClose={() => {
            setCreditConfirmTarget(null);
          }}
          onConfirmed={(outcome) => {
            setCreditConfirmTarget(null);
            setFlash(
              outcome === "already"
                ? { text: "Already issued — nothing changed.", kind: "ok" }
                : { text: "Credit note issued — the credited total now reduces what the customer owes.", kind: "ok" },
            );
            refresh();
          }}
        />
      ) : null}
      {creditVoidTarget !== null ? (
        <VoidCreditNoteDialog
          invoice={data}
          note={creditVoidTarget}
          onClose={() => {
            setCreditVoidTarget(null);
          }}
          onVoided={(outcome) => {
            setCreditVoidTarget(null);
            setFlash(
              outcome === "already"
                ? { text: "Already voided — nothing changed.", kind: "ok" }
                : { text: "Credit note voided — the boundary it held is released.", kind: "ok" },
            );
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

/** The confirmation gate (R-12-6) with the terms beside it (R-12-7): issuing
 *  is final, and the agreed terms are the last thing finance sets before it.
 *  The preset labels are contract words; a custom value is whole days. The
 *  due preview is the server's own arithmetic (issuedAt + N × 86 400 000 ms,
 *  integer, UTC) run against now — the server stamps the authoritative date
 *  at the moment of issue; this says what the choice means before committing. */
function ConfirmIssueDialog(props: {
  invoice: InvoiceDetailData;
  onIssued: (outcome: string) => void;
  onClose: () => void;
}): ReactElement {
  const [terms, setTerms] = useState("none");
  const [customDays, setCustomDays] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dueInDays =
    terms === "custom"
      ? parseDueInDays(customDays)
      : (TERMS_OPTIONS.find((option) => option.value === terms)?.days ?? null);

  async function confirm(): Promise<void> {
    setError(null);
    if (terms === "custom" && dueInDays === null) {
      setError("Custom terms must be whole days between 0 and 365 — 0 means due on receipt.");
      return;
    }
    setBusy(true);
    const result =
      dueInDays === null
        ? await invoiceAdapters.confirm(props.invoice.id)
        : await invoiceAdapters.confirm(props.invoice.id, dueInDays);
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
      <label className="mb-3 block">
        <span className="mb-1 block text-ui-sm font-semibold text-ink">Payment terms</span>
        <select
          className="rounded-control border border-line bg-card p-[var(--pad-control)] text-ui text-ink"
          value={terms}
          onChange={(event) => {
            setTerms(event.target.value);
          }}
          aria-label="Payment terms"
          data-testid="invoice-confirm-terms"
        >
          {TERMS_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      {terms === "custom" ? (
        <label className="mb-3 block">
          <span className="mb-1 block text-ui-sm font-semibold text-ink">
            Terms in days (0 = due on receipt)
          </span>
          <Input
            type="text"
            value={customDays}
            onChange={(event) => {
              setCustomDays(event.target.value);
            }}
            aria-label="Payment terms in days"
            placeholder="e.g. 45"
            className="w-[120px]"
            data-testid="invoice-confirm-custom-days"
          />
        </label>
      ) : null}
      {dueInDays !== null ? (
        <Paragraph
          className="mb-4 font-mono text-[length:var(--fs-meta)] text-ink-soft"
          data-testid="invoice-confirm-due-preview"
        >
          {`Due ${formatDay(new Date(Date.now() + dueInDays * 86_400_000).toISOString())} — ${String(dueInDays)} ${dueInDays === 1 ? "day" : "days"} after issue; past-due invoices remind finance, the system never chases the customer.`}
        </Paragraph>
      ) : null}
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

/** The payment ledger and its verbs (#192 slice 2's endpoints are the surface;
 *  #192 remaining adds the collection actions). A booked payment's amount is
 *  what it settles of the invoice; the card / PayPal surcharge is the
 *  customer's separate fee, shown next to it. Voided corrections stay visible
 *  — money rows are never deleted; only a live row offers the void verb. */
function PaymentsSection(props: {
  currency: string;
  ledger: PaymentsLedger | undefined;
  loading: boolean;
  unavailable: boolean;
  issued: boolean;
  linkBusy: false | "stripe" | "paypal";
  onRecordPayment: () => void;
  onPaymentLink: (channel: "stripe" | "paypal") => void;
  onVoidPayment: (row: PaymentRow) => void;
}): ReactElement {
  return (
    <div className="mt-5 border-t border-line pt-4" data-testid="invoice-payments-section">
      <Heading as="h3">Payments</Heading>
      {props.issued ? (
        <div className="mt-2 flex flex-wrap gap-2" data-testid="invoice-payment-actions">
          <Button
            variant="primary"
            size="sm"
            onClick={props.onRecordPayment}
            data-testid="invoice-record-payment"
          >
            Record payment
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={props.linkBusy !== false}
            onClick={() => {
              props.onPaymentLink("stripe");
            }}
            data-testid="invoice-stripe-link"
          >
            {props.linkBusy === "stripe" ? "Creating the link…" : "Stripe payment link"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={props.linkBusy !== false}
            onClick={() => {
              props.onPaymentLink("paypal");
            }}
            data-testid="invoice-paypal-link"
          >
            {props.linkBusy === "paypal" ? "Creating the link…" : "PayPal payment link"}
          </Button>
        </div>
      ) : null}
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
                  <span className="flex items-center gap-2">
                    <span
                      className={`min-w-0 flex-1 text-ui ${
                        row.voidedAt !== null ? "text-ink-soft line-through" : "text-ink"
                      }`}
                    >
                      {`${methodLabel(row.method)} · ${formatMoney(row.amountCents, row.currency)}`}
                      {row.surchargeCents !== null
                        ? ` (+ ${formatMoney(row.surchargeCents, row.currency)} surcharge)`
                        : ""}
                    </span>
                    {row.voidedAt === null ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          props.onVoidPayment(row);
                        }}
                        aria-label={`Void this ${methodLabel(row.method)} payment of ${formatMoney(row.amountCents, row.currency)}`}
                        data-testid="invoice-payment-void"
                      >
                        Void
                      </Button>
                    ) : null}
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

/** Record a manual payment (#192 remaining): the facts of an arrival — the
 *  amount that actually landed, how, when, and an optional note. The amount
 *  starts empty on purpose: what arrived is a fact only finance knows, and
 *  over- or under-payment is real — prefilling the outstanding would invite
 *  booking money that is not there. The dialog says why link money is not
 *  recorded here: the provider's webhook books its own, and a hand row on top
 *  would double-count. */
function RecordPaymentDialog(props: {
  invoice: InvoiceDetailData;
  onRecorded: (paid: { paidCents: number; totalCents: number; paymentStatus: string }) => void;
  onClose: () => void;
}): ReactElement {
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<PaymentMethod>("wire_ach");
  const [receivedAt, setReceivedAt] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function record(): Promise<void> {
    setError(null);
    const amountCents = parseDollarsToCents(amount);
    if (amountCents === null || amountCents <= 0) {
      setError("The amount must be a dollar amount like 1,500.00 — the money that actually arrived.");
      return;
    }
    const receivedAtIso = parseLocalDateTimeToIso(receivedAt);
    if (receivedAt !== "" && receivedAtIso === null) {
      setError("The received time could not be read — clear it to use now, or pick a valid date and time.");
      return;
    }
    if (receivedAtIso !== null && new Date(receivedAtIso).getTime() > Date.now()) {
      setError("The received time cannot be in the future — an arrival is a past fact.");
      return;
    }
    setBusy(true);
    const result = await invoiceAdapters.recordPayment(props.invoice.id, {
      amountCents,
      method,
      ...(receivedAtIso !== null ? { receivedAtIso } : {}),
      ...(note.trim() !== "" ? { note: note.trim() } : {}),
    });
    setBusy(false);
    if (!result.ok) {
      setError(paymentActionError(result));
      return;
    }
    props.onRecorded(result.data);
  }

  return (
    <DialogFrame labelledBy="invoice-record-title" title="Record payment">
      <Paragraph className="mb-4 text-ink-soft">
        Record money that has actually arrived on{" "}
        <strong>{props.invoice.number}</strong> — a wire or ACH that landed
        outside a payment link. Card and PayPal payments made through a link
        are booked by the provider's confirmation; recording them here too
        would double-count.
      </Paragraph>
      <label className="mb-3 block">
        <span className="mb-1 block text-ui-sm font-semibold text-ink">Amount received (USD)</span>
        <Input
          type="text"
          value={amount}
          onChange={(event) => {
            setAmount(event.target.value);
          }}
          aria-label="Amount received in dollars"
          placeholder="1,500.00"
          className="w-[180px]"
          data-testid="invoice-record-amount"
        />
      </label>
      <label className="mb-3 block">
        <span className="mb-1 block text-ui-sm font-semibold text-ink">Method</span>
        <select
          className="rounded-control border border-line bg-card p-[var(--pad-control)] text-ui text-ink"
          value={method}
          onChange={(event) => {
            setMethod(event.target.value as PaymentMethod);
          }}
          aria-label="Payment method"
          data-testid="invoice-record-method"
        >
          <option value="wire_ach">Wire / ACH</option>
          <option value="card">Card</option>
          <option value="paypal">PayPal</option>
        </select>
      </label>
      <label className="mb-3 block">
        <span className="mb-1 block text-ui-sm font-semibold text-ink">Received at (optional — now if empty)</span>
        <Input
          type="datetime-local"
          value={receivedAt}
          onChange={(event) => {
            setReceivedAt(event.target.value);
          }}
          aria-label="When the money arrived"
          data-testid="invoice-record-received-at"
        />
      </label>
      <label className="mb-4 block">
        <span className="mb-1 block text-ui-sm font-semibold text-ink">Note (optional)</span>
        <Input
          type="text"
          value={note}
          maxLength={500}
          onChange={(event) => {
            setNote(event.target.value);
          }}
          aria-label="Payment note"
          placeholder="Wire ref, payer name, what this settles"
          data-testid="invoice-record-note"
        />
      </label>
      {error !== null ? (
        <Paragraph className="mb-3 text-err" data-testid="invoice-record-error">
          {error}
        </Paragraph>
      ) : null}
      <div className="flex items-center gap-3">
        <Button variant="primary" disabled={busy} onClick={() => { void record(); }} data-testid="invoice-record-go">
          {busy ? "Recording…" : "Record payment"}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={props.onClose} data-testid="invoice-record-cancel">
          Cancel
        </Button>
      </div>
    </DialogFrame>
  );
}

/** Void a booked payment (the correction verb): a mistake's undo, not a
 *  refund — refunds are their own flow. The reason is required because the
 *  voided row stays on the ledger with it; money rows are never deleted. */
function VoidPaymentDialog(props: {
  invoice: InvoiceDetailData;
  payment: PaymentRow;
  onVoided: (outcome: string) => void;
  onClose: () => void;
}): ReactElement {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function voidPayment(): Promise<void> {
    setError(null);
    if (reason.trim() === "") {
      setError("Write why this payment is being voided — the ledger keeps the reason on the row.");
      return;
    }
    setBusy(true);
    const result = await invoiceAdapters.voidPayment(props.payment.id, reason);
    setBusy(false);
    if (!result.ok) {
      setError(paymentActionError(result));
      return;
    }
    props.onVoided(result.data.outcome);
  }

  return (
    <DialogFrame labelledBy="invoice-payment-void-title" title="Void payment">
      <Paragraph className="mb-4 text-ink-soft">
        Void the {methodLabel(props.payment.method).toLowerCase()} payment of{" "}
        <strong>{formatMoney(props.payment.amountCents, props.payment.currency)}</strong> on{" "}
        <strong>{props.invoice.number}</strong>? Money rows are never deleted —
        the voided row stays on the ledger struck through with this reason, and
        the paid total drops as soon as the void lands.
      </Paragraph>
      <label className="mb-4 block">
        <span className="mb-1 block text-ui-sm font-semibold text-ink">Reason</span>
        <Input
          type="text"
          value={reason}
          maxLength={500}
          onChange={(event) => {
            setReason(event.target.value);
          }}
          aria-label="Void payment reason"
          placeholder="Booked twice, wrong amount, test row…"
          data-testid="invoice-payment-void-reason"
        />
      </label>
      {error !== null ? (
        <Paragraph className="mb-3 text-err" data-testid="invoice-payment-void-error">
          {error}
        </Paragraph>
      ) : null}
      <div className="flex items-center gap-3">
        <Button variant="primary" disabled={busy} onClick={() => { void voidPayment(); }} data-testid="invoice-payment-void-go">
          {busy ? "Voiding…" : "Void payment"}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={props.onClose} data-testid="invoice-payment-void-cancel">
          Cancel
        </Button>
      </div>
    </DialogFrame>
  );
}

/** The payment link's answer (#192 remaining): the customer's URL, the money
 *  they will see (gross = principal + surcharge), and the discipline that the
 *  provider's confirmation books the payment — finance sends the link, the
 *  webhook does the booking, nobody records it by hand. Only a created link
 *  opens this dialog; a refusal has nothing to hand over and dies as the
 *  page's error line instead. */
function PaymentLinkDialog(props: {
  invoice: InvoiceDetailData;
  channel: "Stripe" | "PayPal";
  data: PaymentLinkData;
  onClose: () => void;
}): ReactElement {
  const [copied, setCopied] = useState<string | null>(null);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(props.data.url);
      setCopied("Copied.");
    } catch {
      setCopied("Copy failed — select the link and copy it by hand.");
    }
  }

  const data = props.data;
  return (
    <DialogFrame labelledBy="invoice-link-title" title={`${props.channel} payment link`}>
      <Paragraph className="mb-3 text-ink-soft">
        Send this link to the customer for{" "}
        <strong>{props.invoice.number}</strong> — they will pay{" "}
        <strong>{formatMoney(data.amountCents, data.currency)}</strong>
        {data.surchargeCents > 0
          ? ` (${formatMoney(data.principalCents, data.currency)} invoice + ${formatMoney(data.surchargeCents, data.currency)} ${props.channel.toLowerCase()} surcharge)`
          : ""}
        . The provider's confirmation books the payment — this page's Paid
        total updates then; do not record it by hand.
      </Paragraph>
      <span className="mb-1 block text-ui-sm font-semibold text-ink">Payment link</span>
      <Input
        type="text"
        readOnly
        value={data.url}
        onFocus={(event) => {
          event.target.select();
        }}
        aria-label="Payment link URL"
        className="w-full font-mono text-[length:var(--fs-meta)]"
        data-testid="invoice-link-url"
      />
      <div className="mt-3 flex items-center gap-3">
        <Button variant="primary" size="sm" onClick={() => { void copy(); }} data-testid="invoice-link-copy">
          Copy link
        </Button>
        {copied !== null ? (
          <span className="text-ui-sm text-ink-soft" data-testid="invoice-link-copied">
            {copied}
          </span>
        ) : null}
      </div>
      <div className="mt-4 flex items-center gap-3">
        <Button variant="ghost" onClick={props.onClose} data-testid="invoice-link-close">
          Close
        </Button>
      </div>
    </DialogFrame>
  );
}

/** The credit-note ledger and its verbs (#192 红冲的 web 半边). A credit note
 *  is a correction document in its own right — it never edits the invoice's
 *  lines, and the credited total counts confirmed (issued) notes only: a
 *  draft credits nothing until finance confirms it (R-12-6's gate). Voided
 *  notes stay visible struck through — documents are records, never deleted;
 *  an issued note is final, so only a draft row offers verbs. */
function CreditNotesSection(props: {
  invoiceTotalCents: number;
  currency: string;
  ledger: CreditNotesLedger | undefined;
  loading: boolean;
  unavailable: boolean;
  onCreate: () => void;
  onConfirm: (note: CreditNoteRow) => void;
  onVoid: (note: CreditNoteRow) => void;
}): ReactElement {
  return (
    <div className="mt-5 border-t border-line pt-4" data-testid="invoice-credit-section">
      <Heading as="h3">Credit notes</Heading>
      <div className="mt-2 flex flex-wrap gap-2" data-testid="invoice-credit-actions">
        <Button variant="primary" size="sm" onClick={props.onCreate} data-testid="invoice-credit-create">
          Issue credit note
        </Button>
      </div>
      {props.loading ? (
        <Paragraph className="mt-2" data-testid="invoice-credits-loading">
          Loading…
        </Paragraph>
      ) : props.unavailable || props.ledger === undefined ? (
        <Paragraph className="mt-2 text-ink-soft" data-testid="invoice-credits-unavailable">
          The credit-note ledger could not be loaded.
        </Paragraph>
      ) : (
        <>
          <Paragraph className="mt-1 font-mono text-[length:var(--fs-meta)] text-ink-soft" data-testid="invoice-credits-summary">
            {`Credited ${formatMoney(props.ledger.creditedCents, props.currency)} of ${formatMoney(props.invoiceTotalCents, props.currency)} — the credited total counts confirmed notes; a draft credits nothing until it is issued.`}
          </Paragraph>
          {props.ledger.creditNotes.length === 0 ? (
            <Paragraph className="mt-2 text-ink-soft" data-testid="invoice-credits-empty">
              No credit notes. A correction is a new document that credits this
              invoice — it never edits the invoice's own lines.
            </Paragraph>
          ) : (
            <ul className="mt-2" data-testid="invoice-credits-list">
              {props.ledger.creditNotes.map((note) => (
                <li
                  key={note.id}
                  className="border-b border-line py-2"
                  data-testid="invoice-credits-row"
                  data-status={note.status}
                >
                  <span className="flex items-center gap-2">
                    <span
                      className={`min-w-0 flex-1 text-ui ${
                        note.status === "void" ? "text-ink-soft line-through" : "text-ink"
                      }`}
                    >
                      {`${note.number} · ${formatMoney(note.totalCents, note.currency)} · ${
                        note.status === "draft"
                          ? "draft — waiting for finance confirmation"
                          : note.status
                      }`}
                    </span>
                    {note.status === "draft" ? (
                      <>
                        <Button
                          variant="primary"
                          size="sm"
                          onClick={() => {
                            props.onConfirm(note);
                          }}
                          aria-label={`Confirm credit note ${note.number}`}
                          data-testid="invoice-credit-confirm"
                        >
                          Confirm
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            props.onVoid(note);
                          }}
                          aria-label={`Void draft credit note ${note.number}`}
                          data-testid="invoice-credit-void"
                        >
                          Void
                        </Button>
                      </>
                    ) : null}
                  </span>
                  <span className="mt-0.5 block font-mono text-[length:var(--fs-meta)] text-ink-soft">
                    {note.reason}
                    {` · created ${formatDay(note.createdAt)}`}
                    {note.status === "issued" && note.issuedAt !== null ? ` · issued ${formatDay(note.issuedAt)}` : ""}
                    {note.status === "void" && note.voidedAt !== null
                      ? ` · voided ${formatDay(note.voidedAt)}${note.voidReason !== null ? `: ${note.voidReason}` : ""}`
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

/** Open a credit-note draft (#192 红冲的 web 半边). The reason is required —
 *  it is the correction's narrative body, the row the auditor reads. The
 *  lines follow the invoice editor's discipline: description, quantity, unit
 *  price, parsed by exact string rules; no totals are computed or shown here
 *  — the server's generated columns are the only totals, and the boundary
 *  (credits never pass the invoice's total) is checked there, in the
 *  invoice's row lock. */
function CreateCreditNoteDialog(props: {
  invoice: InvoiceDetailData;
  onCreated: (created: { id: string; number: string }) => void;
  onClose: () => void;
}): ReactElement {
  const [reason, setReason] = useState("");
  const [rows, setRows] = useState<{ description: string; quantity: string; unitPrice: string }[]>([
    { description: "", quantity: "", unitPrice: "" },
  ]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function updateRow(index: number, patch: Partial<{ description: string; quantity: string; unitPrice: string }>): void {
    setRows(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  function removeRow(index: number): void {
    if (rows.length <= 1) return;
    setRows(rows.filter((_, i) => i !== index));
  }

  async function create(): Promise<void> {
    setError(null);
    const trimmedReason = reason.trim();
    if (trimmedReason === "") {
      setError("Write why this credit is being issued — the reason stays on the document.");
      return;
    }
    const lines: InvoiceLineInput[] = [];
    for (const [index, row] of rows.entries()) {
      const description = row.description.trim();
      const quantity = parseQuantity(row.quantity);
      const unitPriceCents = parseDollarsToCents(row.unitPrice);
      if (description === "") {
        setError(`Line ${String(index + 1)}: write what this line credits.`);
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
    setBusy(true);
    const result = await invoiceAdapters.createCreditNote(props.invoice.id, {
      reason: trimmedReason,
      lines,
    });
    setBusy(false);
    if (!result.ok) {
      setError(creditActionError(result));
      return;
    }
    props.onCreated(result.data);
  }

  return (
    <DialogFrame labelledBy="invoice-credit-create-title" title="Issue credit note">
      <Paragraph className="mb-4 text-ink-soft">
        Credit <strong>{props.invoice.number}</strong> with a new document — the
        invoice's own lines never change. A draft credits nothing; once
        confirmed, an issued credit note is final and the credited amount
        reduces what the customer owes. The credited total can never pass the
        invoice's total.
      </Paragraph>
      <label className="mb-3 block">
        <span className="mb-1 block text-ui-sm font-semibold text-ink">Reason</span>
        <Input
          type="text"
          value={reason}
          maxLength={500}
          onChange={(event) => {
            setReason(event.target.value);
          }}
          aria-label="Credit note reason"
          placeholder="Why this credit is being issued — e.g. billed twice for setup"
          data-testid="invoice-credit-create-reason"
        />
      </label>
      <Paragraph className="mb-2 font-mono text-[length:var(--fs-meta)] text-ink-soft">
        Credit lines — amounts are computed by the server; they appear once the
        draft is on the books.
      </Paragraph>
      <ul className="grid gap-2" data-testid="invoice-credit-create-rows">
        {rows.map((row, index) => (
          <li key={index} className="flex flex-wrap items-center gap-2" data-testid="invoice-credit-create-row">
            <Input
              type="text"
              value={row.description}
              onChange={(event) => {
                updateRow(index, { description: event.target.value });
              }}
              aria-label={`Credit line ${String(index + 1)} description`}
              placeholder="What this line credits"
              className="min-w-[220px] flex-1"
              data-testid="invoice-credit-create-description"
            />
            <Input
              type="text"
              value={row.quantity}
              onChange={(event) => {
                updateRow(index, { quantity: event.target.value });
              }}
              aria-label={`Credit line ${String(index + 1)} quantity`}
              placeholder="Quantity"
              className="w-[110px]"
              data-testid="invoice-credit-create-quantity"
            />
            <Input
              type="text"
              value={row.unitPrice}
              onChange={(event) => {
                updateRow(index, { unitPrice: event.target.value });
              }}
              aria-label={`Credit line ${String(index + 1)} unit price in dollars`}
              placeholder="Unit price (USD)"
              className="w-[140px]"
              data-testid="invoice-credit-create-unit-price"
            />
            <Button
              variant="ghost"
              size="sm"
              disabled={rows.length <= 1}
              onClick={() => {
                removeRow(index);
              }}
              aria-label={`Remove credit line ${String(index + 1)}`}
              data-testid="invoice-credit-create-remove-line"
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
          data-testid="invoice-credit-create-add-line"
        >
          Add line
        </Button>
      </div>
      {error !== null ? (
        <Paragraph className="mt-2 text-err" data-testid="invoice-credit-create-error">
          {error}
        </Paragraph>
      ) : null}
      <div className="mt-3 flex items-center gap-3">
        <Button variant="primary" disabled={busy} onClick={() => { void create(); }} data-testid="invoice-credit-create-go">
          {busy ? "Creating…" : "Create draft credit note"}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={props.onClose} data-testid="invoice-credit-create-cancel">
          Cancel
        </Button>
      </div>
    </DialogFrame>
  );
}

/** The credit note's own R-12-6 gate: confirming issues the document and the
 *  credited amount starts reducing what the customer owes. Issued is final —
 *  a mistaken credit is corrected by crediting back, never by editing. */
function ConfirmCreditNoteDialog(props: {
  invoice: InvoiceDetailData;
  note: CreditNoteRow;
  onConfirmed: (outcome: string) => void;
  onClose: () => void;
}): ReactElement {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm(): Promise<void> {
    setBusy(true);
    setError(null);
    const result = await invoiceAdapters.confirmCreditNote(props.note.id);
    setBusy(false);
    if (!result.ok) {
      setError(creditActionError(result));
      return;
    }
    props.onConfirmed(result.data.outcome);
  }

  return (
    <DialogFrame labelledBy="invoice-credit-confirm-title" title="Confirm credit note">
      <Paragraph className="mb-4 text-ink-soft">
        Confirm credit note <strong>{props.note.number}</strong> for{" "}
        <strong>{formatMoney(props.note.totalCents, props.note.currency)}</strong> against{" "}
        <strong>{props.invoice.number}</strong>? Once issued, the credited
        amount reduces what the customer owes — paid statuses and payment links
        follow the credited total. An issued credit note is final; it cannot be
        voided.
      </Paragraph>
      <Paragraph className="mb-4 font-mono text-[length:var(--fs-meta)] text-ink-soft">
        {`Reason: ${props.note.reason}`}
      </Paragraph>
      {error !== null ? (
        <Paragraph className="mb-3 text-err" data-testid="invoice-credit-confirm-error">
          {error}
        </Paragraph>
      ) : null}
      <div className="flex items-center gap-3">
        <Button variant="primary" disabled={busy} onClick={() => { void confirm(); }} data-testid="invoice-credit-confirm-go">
          {busy ? "Confirming…" : "Confirm credit note"}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={props.onClose} data-testid="invoice-credit-confirm-cancel">
          Cancel
        </Button>
      </div>
    </DialogFrame>
  );
}

/** Void a draft credit note (the correction verb on the correction): the
 *  draft is cancelled and stays on the books as void; the boundary it held
 *  is released. The reason is optional, mirroring the API's admission — a
 *  voided note keeps whatever reason was given beside it on the ledger. */
function VoidCreditNoteDialog(props: {
  invoice: InvoiceDetailData;
  note: CreditNoteRow;
  onVoided: (outcome: string) => void;
  onClose: () => void;
}): ReactElement {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function voidNote(): Promise<void> {
    setBusy(true);
    setError(null);
    const result = await invoiceAdapters.voidCreditNote(
      props.note.id,
      reason.trim() === "" ? undefined : reason.trim(),
    );
    setBusy(false);
    if (!result.ok) {
      setError(creditActionError(result));
      return;
    }
    props.onVoided(result.data.outcome);
  }

  return (
    <DialogFrame labelledBy="invoice-credit-void-title" title="Void draft credit note">
      <Paragraph className="mb-4 text-ink-soft">
        Void draft credit note <strong>{props.note.number}</strong> against{" "}
        <strong>{props.invoice.number}</strong>? The draft is cancelled and
        stays on the books as void — it can never be issued, and the credited
        boundary it held is released. This cannot be undone.
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
          aria-label="Void credit note reason"
          placeholder="Why this draft is being cancelled"
          data-testid="invoice-credit-void-reason"
        />
      </label>
      {error !== null ? (
        <Paragraph className="mb-3 text-err" data-testid="invoice-credit-void-error">
          {error}
        </Paragraph>
      ) : null}
      <div className="flex items-center gap-3">
        <Button variant="primary" disabled={busy} onClick={() => { void voidNote(); }} data-testid="invoice-credit-void-go">
          {busy ? "Voiding…" : "Void draft"}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={props.onClose} data-testid="invoice-credit-void-cancel">
          Cancel
        </Button>
      </div>
    </DialogFrame>
  );
}
