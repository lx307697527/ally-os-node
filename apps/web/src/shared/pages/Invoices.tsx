// The invoices page (#192 slice 4 — the finance confirmation page's list
// half). The finance main read is the DRAFT filter: what the system proposed
// and finance has not yet issued. The first screen says the page's discipline
// (drafts are proposals; confirming issues the invoice; issuing is the
// finance gate R-12-6) — the verbs live on the detail page, where the lines
// being confirmed are on screen.
//
// The split action (#192 分期的 web 半边): finance can cut an agreed amount
// into 2–12 installment draft invoices. The plan is created with all its
// parts in one server transaction; the total is stamped from the parts — no
// total field exists here (RULE-007). Each part is an ordinary draft invoice;
// nothing reaches a customer until finance confirms the part.
//
// States are honest, never blank-by-accident: loading says so, a missing
// invoices.manage permission says so, an unreachable API says so, an empty
// filter says what would fill it.
import type { ReactElement } from "react";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Button, Card, Heading, Input, Paragraph } from "@ally/ui";

import {
  createInvoiceAdapters,
  formatMoney,
  isInvoiceOverdue,
  parseDollarsToCents,
  type InvoicePlanCreateResult,
  type InvoicePlanCreated,
  type InvoiceStatus,
} from "../lib/invoices-client.ts";

const invoiceAdapters = createInvoiceAdapters();

/** The parts' admission, mirrored from the server's zod: a plan is 2–12
 *  parts (one is the ordinary draft; twelve the cap — longer schedules are a
 *  financing arrangement, not an invoice split) and the parts' sum cannot
 *  pass the plan total's storage limit. A doomed submission is refused in the
 *  form, not by a round trip. */
const PLAN_PARTS_MIN = 2;
const PLAN_PARTS_MAX = 12;
const PLAN_TOTAL_MAX_CENTS = 2_147_483_647;

/** The split action's gates, said for a person. The one 409 today is the
 *  missing numbering rule — any part's number failing rolls the whole plan
 *  back, so nothing half-exists; the fix is configuration, not reloading. */
function planActionError(result: Exclude<InvoicePlanCreateResult, { ok: true }>): string {
  if (result.reason === "conflict") {
    if (result.code === "numbering_not_configured") {
      return "No numbering rule is active for invoices — ask an admin to set one in the configuration studio, then try again.";
    }
    return "The plan changed while you were working — reload and try again.";
  }
  if (result.reason === "forbidden") {
    return "Your account does not have permission to manage invoices.";
  }
  return "The plan could not be created. Reload and try again.";
}

const STATUS_FILTERS: readonly { value: InvoiceStatus | "all"; label: string }[] = [
  { value: "draft", label: "Draft" },
  { value: "issued", label: "Issued" },
  { value: "void", label: "Void" },
  { value: "all", label: "All" },
];

function formatDay(iso: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(iso));
}

export function Invoices(): ReactElement {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<InvoiceStatus | "all">("draft");
  const [flash, setFlash] = useState<{ text: string; kind: "ok" | "error" } | null>(null);
  const [planOpen, setPlanOpen] = useState(false);

  const list = useQuery({
    queryKey: ["invoices", filter],
    queryFn: () => invoiceAdapters.list(filter === "all" ? undefined : filter),
    placeholderData: (previous) => previous,
  });

  const data = list.data?.ok === true ? list.data.data : undefined;
  const forbidden = list.data?.ok === false && list.data.reason === "forbidden";
  const unavailable = list.data?.ok === false && list.data.reason === "unavailable";

  return (
    <div className="w-full" data-page="invoices" data-testid="invoices-root">
      <Card>
        <Heading as="h2">Invoices</Heading>
        <Paragraph className="text-ink-soft">
          Every invoice starts as a draft the system proposed — nothing reaches a
          customer until finance confirms it. Confirming issues the invoice;
          issued invoices can no longer be edited. Payments appear on each
          invoice as they are booked.
        </Paragraph>

        <div className="mt-4 flex flex-wrap items-center gap-2" data-testid="invoices-filters">
          <span className="flex gap-1" aria-label="Status filter">
            {STATUS_FILTERS.map((chip) => (
              <Button
                key={chip.value}
                variant={filter === chip.value ? "default" : "ghost"}
                size="sm"
                onClick={() => {
                  setFilter(chip.value);
                }}
                data-testid={`invoices-filter-${chip.value}`}
              >
                {chip.label}
              </Button>
            ))}
          </span>
          <span className="flex-1" />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setFlash(null);
              setPlanOpen(true);
            }}
            data-testid="invoices-plan-create"
          >
            Split into installments
          </Button>
        </div>

        {flash !== null ? (
          <Paragraph
            className={`mt-3 ${flash.kind === "error" ? "text-err" : "text-ink"}`}
            data-testid="invoices-flash"
          >
            {flash.text}
          </Paragraph>
        ) : null}

        {list.isPending ? (
          <Paragraph className="mt-3" data-testid="invoices-loading">
            Loading…
          </Paragraph>
        ) : forbidden ? (
          <Paragraph className="mt-3 text-ink-soft" data-testid="invoices-forbidden">
            Your account does not have permission to manage invoices. Ask an
            administrator for the invoicing permission.
          </Paragraph>
        ) : unavailable || data === undefined ? (
          <Paragraph className="mt-3 text-ink-soft" data-testid="invoices-unavailable">
            The invoice list could not be loaded.
          </Paragraph>
        ) : data.length === 0 ? (
          <Paragraph className="mt-3 text-ink-soft" data-testid="invoices-empty">
            {filter === "draft"
              ? "No drafts are waiting for confirmation. Drafts appear here when a business event triggers one."
              : "No invoices under this filter."}
          </Paragraph>
        ) : (
          <ul className="mt-3" data-testid="invoices-list">
            {data.map((row) => (
              <li
                key={row.id}
                className="flex items-start gap-3 border-b border-line py-2"
                data-testid="invoices-row"
                data-status={row.status}
              >
                <span className="min-w-0 flex-1">
                  <Link
                    to={`/invoices/${row.id}`}
                    data-testid="invoices-row-number"
                    className={
                      row.status === "void"
                        ? "text-ui text-ink-soft line-through hover:text-link"
                        : "text-ui text-ink font-medium hover:text-link"
                    }
                  >
                    {row.number}
                  </Link>
                  <span className="mt-0.5 block font-mono text-[length:var(--fs-meta)] text-ink-soft">
                    {row.invoiceType.replace(/_/g, " ")}
                    {/* 分期成员事实(#192 分期的 web 半边):i 与 n 都是服务端
                        的事实(创建时落定的序数、读时派生的计数) */}
                    {row.plan !== null
                      ? ` · part ${String(row.plan.index)} of ${String(row.plan.count)}`
                      : ""}
                    {row.subject !== null ? ` · for ${row.subject.type}` : " · manual"}
                    {` · created ${formatDay(row.createdAt)}`}
                    {row.status === "issued" && row.issuedAt !== null
                      ? ` · issued ${formatDay(row.issuedAt)}`
                      : ""}
                    {/* R-12-7's web face: the agreed terms' due date, and the
                        scan's own overdue rule read at render — display only. */}
                    {row.dueAt !== null ? ` · due ${formatDay(row.dueAt)}` : ""}
                    {isInvoiceOverdue(row) ? " · overdue" : ""}
                  </span>
                </span>
                <span className="text-right font-mono text-ui-sm text-ink">
                  <span data-testid="invoices-row-total">{formatMoney(row.totalCents, row.currency)}</span>
                  <span
                    className="block text-[length:var(--fs-meta)] text-ink-soft"
                    data-testid="invoices-row-payment"
                  >
                    {row.paymentStatus === "paid"
                      ? "paid"
                      : row.paymentStatus === "partial"
                        ? `${formatMoney(row.paidCents, row.currency)} paid`
                        : "unpaid"}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
        {data !== undefined && data.length > 0 ? (
          <Paragraph className="mt-2 font-mono text-[length:var(--fs-meta)] text-ink-soft" data-testid="invoices-count">
            {`${String(data.length)} invoice${data.length === 1 ? "" : "s"}`}
          </Paragraph>
        ) : null}
      </Card>

      {planOpen ? (
        <CreatePlanDialog
          onClose={() => {
            setPlanOpen(false);
          }}
          onCreated={(created) => {
            setPlanOpen(false);
            setFlash({
              text: `Plan created — ${String(created.parts.length)} draft invoices, ${formatMoney(created.totalCents, "USD")} agreed: ${created.parts.map((part) => part.number).join(", ")}. They are waiting under Draft.`,
              kind: "ok",
            });
            void queryClient.invalidateQueries({ queryKey: ["invoices"] });
          }}
        />
      ) : null}
    </div>
  );
}

/** Split an agreed amount into installments (#192 分期的 web 半边). One
 *  transaction creates the plan and its 2–12 member drafts; the total is
 *  stamped by the server from the parts, so no total field exists here
 *  (RULE-007). Each part is an ordinary draft invoice — edited, confirmed,
 *  collected and voided on its own page; nothing reaches a customer until
 *  finance confirms the part. Amounts parse by exact string rules, never
 *  float; the admission (2–12 parts, each positive, the sum within the
 *  plan-total storage limit) is mirrored from the server so a doomed
 *  submission dies in the form. */
function CreatePlanDialog(props: {
  onCreated: (created: InvoicePlanCreated) => void;
  onClose: () => void;
}): ReactElement {
  const [label, setLabel] = useState("");
  const [parts, setParts] = useState<string[]>(["", ""]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function updatePart(index: number, value: string): void {
    setParts(parts.map((part, i) => (i === index ? value : part)));
  }

  function removePart(index: number): void {
    if (parts.length <= PLAN_PARTS_MIN) return;
    setParts(parts.filter((_, i) => i !== index));
  }

  async function create(): Promise<void> {
    setError(null);
    const trimmedLabel = label.trim();
    if (trimmedLabel === "") {
      setError("Write what this plan is for — the label stays on every part's line.");
      return;
    }
    const amounts: number[] = [];
    for (const [index, text] of parts.entries()) {
      const cents = parseDollarsToCents(text);
      if (cents === null || cents <= 0) {
        setError(`Part ${String(index + 1)}: the amount must be a dollar amount like 1,500.00.`);
        return;
      }
      amounts.push(cents);
    }
    if (parts.length > PLAN_PARTS_MAX) {
      setError(`A plan holds at most ${String(PLAN_PARTS_MAX)} parts — longer schedules are a financing arrangement, not an invoice split.`);
      return;
    }
    const total = amounts.reduce((sum, amount) => sum + amount, 0);
    if (total > PLAN_TOTAL_MAX_CENTS) {
      setError("The parts add up past what one plan can hold — split the agreement into more than one plan.");
      return;
    }
    setBusy(true);
    const result = await invoiceAdapters.createInvoicePlan({
      label: trimmedLabel,
      parts: amounts.map((amountCents) => ({ amountCents })),
    });
    setBusy(false);
    if (!result.ok) {
      setError(planActionError(result));
      return;
    }
    props.onCreated(result.data);
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-scrim px-6 py-13 outline-none"
      role="dialog"
      aria-modal="true"
      aria-labelledby="invoices-plan-create-title"
      data-testid="invoices-plan-dialog-overlay"
    >
      <Card
        padding="lg"
        className="mt-13 w-full max-w-[var(--width-dialog-560)] border-t-[length:var(--border-accent-width)] border-t-accent shadow-modal"
      >
        <h2
          id="invoices-plan-create-title"
          className="mb-1 font-slab text-[length:var(--fs-h3)] font-semibold tracking-[var(--ls-display)] text-ink"
        >
          Split into installments
        </h2>
        <Paragraph className="mb-4 text-ink-soft">
          Cut an agreed amount into {String(PLAN_PARTS_MIN)}–{String(PLAN_PARTS_MAX)} draft
          invoices — one per part, created together. The total is stamped by the
          server from the parts. Each part is an ordinary draft invoice — edit,
          confirm, collect and void it on its own page; nothing reaches a
          customer until finance confirms the part.
        </Paragraph>
        <label className="mb-3 block">
          <span className="mb-1 block text-ui-sm font-semibold text-ink">What this plan is for</span>
          <Input
            type="text"
            value={label}
            maxLength={200}
            onChange={(event) => {
              setLabel(event.target.value);
            }}
            aria-label="Installment plan label"
            placeholder="e.g. Annual retainer — 4 monthly parts"
            data-testid="invoices-plan-label"
          />
        </label>
        <Paragraph className="mb-2 font-mono text-[length:var(--fs-meta)] text-ink-soft">
          Part amounts (USD) — the agreed total is what they add up to; it is
          stamped by the server.
        </Paragraph>
        <ul className="grid gap-2" data-testid="invoices-plan-parts">
          {parts.map((part, index) => (
            <li key={index} className="flex flex-wrap items-center gap-2" data-testid="invoices-plan-part-row">
              <span className="w-[64px] font-mono text-[length:var(--fs-meta)] text-ink-soft">
                {`Part ${String(index + 1)}`}
              </span>
              <Input
                type="text"
                value={part}
                onChange={(event) => {
                  updatePart(index, event.target.value);
                }}
                aria-label={`Part ${String(index + 1)} amount in dollars`}
                placeholder="1,500.00"
                className="w-[140px]"
                data-testid="invoices-plan-part-amount"
              />
              <Button
                variant="ghost"
                size="sm"
                disabled={parts.length <= PLAN_PARTS_MIN}
                onClick={() => {
                  removePart(index);
                }}
                aria-label={`Remove part ${String(index + 1)}`}
                data-testid="invoices-plan-remove-part"
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
            disabled={parts.length >= PLAN_PARTS_MAX}
            onClick={() => {
              setParts([...parts, ""]);
            }}
            data-testid="invoices-plan-add-part"
          >
            Add part
          </Button>
        </div>
        {error !== null ? (
          <Paragraph className="mt-2 text-err" data-testid="invoices-plan-error">
            {error}
          </Paragraph>
        ) : null}
        <div className="mt-3 flex items-center gap-3">
          <Button variant="primary" disabled={busy} onClick={() => { void create(); }} data-testid="invoices-plan-go">
            {busy ? "Splitting…" : "Create plan"}
          </Button>
          <Button variant="ghost" disabled={busy} onClick={props.onClose} data-testid="invoices-plan-cancel">
            Cancel
          </Button>
        </div>
      </Card>
    </div>
  );
}
