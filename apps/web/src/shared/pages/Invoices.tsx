// The invoices page (#192 slice 4 — the finance confirmation page's list
// half). The finance main read is the DRAFT filter: what the system proposed
// and finance has not yet issued. The first screen says the page's discipline
// (drafts are proposals; confirming issues the invoice; issuing is the
// finance gate R-12-6) — the verbs live on the detail page, where the lines
// being confirmed are on screen.
//
// States are honest, never blank-by-accident: loading says so, a missing
// invoices.manage permission says so, an unreachable API says so, an empty
// filter says what would fill it.
import type { ReactElement } from "react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Button, Card, Heading, Paragraph } from "@ally/ui";

import { createInvoiceAdapters, formatMoney, type InvoiceStatus } from "../lib/invoices-client.ts";

const invoiceAdapters = createInvoiceAdapters();

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
  const [filter, setFilter] = useState<InvoiceStatus | "all">("draft");

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
        </div>

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
                    {row.subject !== null ? ` · for ${row.subject.type}` : " · manual"}
                    {` · created ${formatDay(row.createdAt)}`}
                    {row.status === "issued" && row.issuedAt !== null
                      ? ` · issued ${formatDay(row.issuedAt)}`
                      : ""}
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
    </div>
  );
}
