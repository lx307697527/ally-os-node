// The rate limits page (#27) — the System region's abuse-telemetry face.
// Two reads: the denials ledger (every request the API refused because its
// source outspent its limit, newest first) and a 7-day triage summary by
// action, so "is anyone hammering us" is the first thing on screen.
//
// The ledger is telemetry, not the gate: the counter refused the request
// before this row was written. The page answers who is knocking, on what,
// and how hard — it does not unblock anyone (no verbs here by design).
//
// States are honest, never blank-by-accident: loading says so, a 403 says
// the account lacks the audit.read permission, an unreachable API says so
// (the adapter reports the failure mode — see rate-limit-client.ts). The
// summary degrades alone: if only it fails, the ledger still renders with
// a said-so where the summary would be.
import type { ReactElement } from "react";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, Card, Heading, Paragraph } from "@ally/ui";

import { createRateLimitAdapters } from "../lib/rate-limit-client.ts";

const rateLimitAdapters = createRateLimitAdapters();

/** Rows per page — also the API's default; the pager steps in this unit. */
const PAGE_SIZE = 50;
/** The triage window, in days — also the API's default. */
const SUMMARY_DAYS = 7;

function formatTime(iso: string): string {
  // Locale follows the browser: timestamps are numbers, not copy.
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" }).format(
    new Date(iso),
  );
}

export function RateLimits(): ReactElement {
  const [offset, setOffset] = useState(0);
  const page = useQuery({
    queryKey: ["rate-limit-denials", offset],
    queryFn: () => rateLimitAdapters.page({ limit: PAGE_SIZE, offset }),
    // The ledger only grows at the front; while paging, keep the previous
    // page on screen instead of collapsing to the loading row.
    placeholderData: (previous) => previous,
  });
  const summary = useQuery({
    queryKey: ["rate-limit-summary"],
    queryFn: () => rateLimitAdapters.summary({ days: SUMMARY_DAYS }),
  });

  const data = page.data?.ok ? page.data.data : undefined;
  const failure = page.data?.ok === false ? page.data.reason : undefined;
  const summaryData = summary.data?.ok ? summary.data.data : undefined;
  const summaryFailure = summary.data?.ok === false ? summary.data.reason : undefined;
  const hasNewer = offset > 0;
  const hasOlder = data !== undefined && offset + PAGE_SIZE < data.total;

  return (
    <div className="w-full" data-page="rate-limits" data-testid="rate-limits-root">
      <Card>
        <Heading as="h2">Rate limits</Heading>
        <Paragraph className="text-ink-soft">
          Every request the API refused because its source outspent its rate
          limit, newest first. The ledger is telemetry — the counter refused
          the request before this row was written, and nothing here unblocks
          anyone.
        </Paragraph>

        {page.isPending || summary.isPending ? (
          <Paragraph data-testid="rate-limits-loading">Loading…</Paragraph>
        ) : failure === "forbidden" || summaryFailure === "forbidden" ? (
          <Paragraph data-testid="rate-limits-forbidden" className="text-ink-soft">
            Your account does not have permission to read abuse telemetry. Ask
            an administrator for the audit permission.
          </Paragraph>
        ) : failure === "unavailable" || data === undefined ? (
          <Paragraph data-testid="rate-limits-unavailable" className="text-ink-soft">
            The denials ledger could not be loaded.
          </Paragraph>
        ) : data.denials.length === 0 ? (
          <Paragraph data-testid="rate-limits-empty" className="text-ink-soft">
            No denials yet. Rows appear the first time a source outspends a
            rate limit.
          </Paragraph>
        ) : (
          <>
            <div className="mt-3" data-testid="rate-limits-summary">
              {summaryData === undefined ? (
                <Paragraph data-testid="rate-limits-summary-unavailable" className="text-ink-soft">
                  The summary could not be loaded; the ledger below is current.
                </Paragraph>
              ) : summaryData.groups.length === 0 ? (
                <Paragraph data-testid="rate-limits-summary-empty" className="text-ink-soft">
                  Nothing denied in the last {String(summaryData.windowDays)} days.
                </Paragraph>
              ) : (
                <table className="w-full border-collapse text-left text-ui-sm">
                  <thead>
                    <tr className="border-b border-line">
                      <th className="py-2 pr-4 font-mono text-[length:var(--fs-meta)] font-medium tracking-[var(--ls-crumb)] text-ink-soft uppercase">Action (last {String(summaryData.windowDays)} days)</th>
                      <th className="py-2 pr-4 font-mono text-[length:var(--fs-meta)] font-medium tracking-[var(--ls-crumb)] text-ink-soft uppercase">Denied</th>
                      <th className="py-2 pr-4 font-mono text-[length:var(--fs-meta)] font-medium tracking-[var(--ls-crumb)] text-ink-soft uppercase">Sources</th>
                      <th className="py-2 font-mono text-[length:var(--fs-meta)] font-medium tracking-[var(--ls-crumb)] text-ink-soft uppercase">Last denial</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summaryData.groups.map((group) => (
                      <tr key={group.action} className="border-b border-line" data-testid="rate-limits-summary-row">
                        <td className="py-2 pr-4 font-mono">{group.action}</td>
                        <td className="py-2 pr-4 font-mono">{String(group.count)}</td>
                        <td className="py-2 pr-4 font-mono">{String(group.distinctIdentifiers)}</td>
                        <td className="py-2 whitespace-nowrap text-ink-soft">{formatTime(group.lastDeniedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="mt-3 overflow-x-auto" data-testid="rate-limits-table">
              <table className="w-full border-collapse text-left text-ui-sm">
                <thead>
                  <tr className="border-b border-line">
                    <th className="py-2 pr-4 font-mono text-[length:var(--fs-meta)] font-medium tracking-[var(--ls-crumb)] text-ink-soft uppercase">Time</th>
                    <th className="py-2 pr-4 font-mono text-[length:var(--fs-meta)] font-medium tracking-[var(--ls-crumb)] text-ink-soft uppercase">Source</th>
                    <th className="py-2 pr-4 font-mono text-[length:var(--fs-meta)] font-medium tracking-[var(--ls-crumb)] text-ink-soft uppercase">Type</th>
                    <th className="py-2 pr-4 font-mono text-[length:var(--fs-meta)] font-medium tracking-[var(--ls-crumb)] text-ink-soft uppercase">Action</th>
                    <th className="py-2 pr-4 font-mono text-[length:var(--fs-meta)] font-medium tracking-[var(--ls-crumb)] text-ink-soft uppercase">Count</th>
                    <th className="py-2 pr-4 font-mono text-[length:var(--fs-meta)] font-medium tracking-[var(--ls-crumb)] text-ink-soft uppercase">Limit</th>
                    <th className="py-2 font-mono text-[length:var(--fs-meta)] font-medium tracking-[var(--ls-crumb)] text-ink-soft uppercase">Request ID</th>
                  </tr>
                </thead>
                <tbody>
                  {data.denials.map((denial) => (
                    <tr key={denial.id} className="border-b border-line align-top" data-testid="rate-limits-row">
                      <td className="py-2 pr-4 whitespace-nowrap text-ink-soft">{formatTime(denial.deniedAt)}</td>
                      <td className="py-2 pr-4 font-mono break-all">{denial.identifier}</td>
                      <td className="py-2 pr-4 font-mono">{denial.identifierType}</td>
                      <td className="py-2 pr-4 font-mono">{denial.action}</td>
                      <td className="py-2 pr-4 font-mono">{String(denial.countAtDenial)}</td>
                      <td className="py-2 pr-4 font-mono">{String(denial.limitValue)}</td>
                      <td className="py-2 font-mono break-all text-ink-soft">{denial.requestId ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-3 flex items-center justify-between" data-testid="rate-limits-pager">
              <span className="font-mono text-[length:var(--fs-meta)] text-ink-soft">
                {data.total === 0
                  ? "0 entries"
                  : `${String(offset + 1)}–${String(Math.min(offset + data.denials.length, data.total))} of ${String(data.total)}`}
              </span>
              <span className="flex gap-2">
                <Button
                  variant="default"
                  size="sm"
                  disabled={!hasNewer}
                  onClick={() => {
                    setOffset(Math.max(0, offset - PAGE_SIZE));
                  }}
                  data-testid="rate-limits-newer"
                >
                  ‹ Newer
                </Button>
                <Button
                  variant="default"
                  size="sm"
                  disabled={!hasOlder}
                  onClick={() => {
                    setOffset(offset + PAGE_SIZE);
                  }}
                  data-testid="rate-limits-older"
                >
                  Older ›
                </Button>
              </span>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
