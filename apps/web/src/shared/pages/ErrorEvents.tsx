// The error events page (#28 slice 2) — the System region's error-telemetry
// face, the successor of the old /admin/error-logs. Two reads: the
// fingerprint summary (triage's first screen — which error is loudest in the
// window, grouped by fingerprint+source) and the raw ledger (every event,
// newest first, drillable by fingerprint, filterable by source).
//
// The ledger is telemetry, not a work queue: the reporters (the web global
// handler, the API's unhandled-failure hook) already filed these rows and
// the spike watcher reads the same table — nothing here resolves anything.
// The page answers what broke, where, how often, and since when.
//
// States are honest, never blank-by-accident: loading says so, a 403 says
// the account lacks the audit.read permission, an unreachable API says so
// (the adapter reports the failure mode — see error-events-client.ts). The
// summary degrades alone: if only it fails, the ledger still renders with a
// said-so where the summary would be. A filter change collapses the ledger
// to the loading row — the previous rows answer a different question —
// while a page flip keeps the page on screen (the ledger only grows at the
// front).
import type { ReactElement } from "react";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, Card, Heading, Paragraph } from "@ally/ui";

import {
  createErrorEventsAdapters,
  type ErrorEventSource,
} from "../lib/error-events-client.ts";

const errorEventsAdapters = createErrorEventsAdapters();

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

/** 64 hex characters are noise in a table cell; the first 12 are the row's
 *  handle — the full value rides the title and the filter state. */
function shortFingerprint(fingerprint: string): string {
  return fingerprint.slice(0, 12);
}

const SOURCE_TABS: readonly {
  readonly label: string;
  readonly value: ErrorEventSource | undefined;
}[] = [
  { label: "All sources", value: undefined },
  { label: "Web", value: "web" },
  { label: "API", value: "api" },
];

export function ErrorEvents(): ReactElement {
  const [offset, setOffset] = useState(0);
  const [fingerprintFilter, setFingerprintFilter] = useState<string | undefined>(undefined);
  const [sourceFilter, setSourceFilter] = useState<ErrorEventSource | undefined>(undefined);

  const page = useQuery({
    queryKey: ["error-events", offset, fingerprintFilter, sourceFilter],
    queryFn: () =>
      errorEventsAdapters.list({
        limit: PAGE_SIZE,
        offset,
        fingerprint: fingerprintFilter,
        source: sourceFilter,
      }),
    // Page flips keep the previous page on screen; a filter change collapses
    // to the loading row — the key's filter slots differ, and the old rows
    // answer a different question.
    placeholderData: (previous, previousQuery) => {
      const key = previousQuery?.queryKey;
      return key !== undefined && key[2] === fingerprintFilter && key[3] === sourceFilter
        ? previous
        : undefined;
    },
  });
  const summary = useQuery({
    queryKey: ["error-events-summary"],
    queryFn: () => errorEventsAdapters.summary({ days: SUMMARY_DAYS }),
  });

  const data = page.data?.ok ? page.data.data : undefined;
  const failure = page.data?.ok === false ? page.data.reason : undefined;
  const summaryData = summary.data?.ok ? summary.data.data : undefined;
  const summaryFailure = summary.data?.ok === false ? summary.data.reason : undefined;
  const hasNewer = offset > 0;
  const hasOlder = data !== undefined && offset + PAGE_SIZE < data.total;
  const filtered = fingerprintFilter !== undefined || sourceFilter !== undefined;

  return (
    <div className="w-full" data-page="error-events" data-testid="error-events-root">
      <Card>
        <Heading as="h2">Error events</Heading>
        <Paragraph className="text-ink-soft">
          Every error the system caught — the browser's global handler and the
          API's unhandled failures in one ledger, newest first. The ledger is
          telemetry: the reporters already filed these rows, and nothing here
          resolves anything.
        </Paragraph>

        {page.isPending || summary.isPending ? (
          <Paragraph data-testid="error-events-loading">Loading…</Paragraph>
        ) : failure === "forbidden" || summaryFailure === "forbidden" ? (
          <Paragraph data-testid="error-events-forbidden" className="text-ink-soft">
            Your account does not have permission to read error telemetry. Ask
            an administrator for the audit permission.
          </Paragraph>
        ) : failure === "unavailable" || data === undefined ? (
          <Paragraph data-testid="error-events-unavailable" className="text-ink-soft">
            The error ledger could not be loaded.
          </Paragraph>
        ) : data.events.length === 0 ? (
          <Paragraph data-testid="error-events-empty" className="text-ink-soft">
            {filtered
              ? "No events match the current filter. Clear it to see the full ledger."
              : "No error events yet. Rows appear the first time the app reports or throws."}
          </Paragraph>
        ) : (
          <>
            <div className="mt-3" data-testid="error-events-summary">
              {summaryData === undefined ? (
                <Paragraph data-testid="error-events-summary-unavailable" className="text-ink-soft">
                  The summary could not be loaded; the ledger below is current.
                </Paragraph>
              ) : summaryData.groups.length === 0 ? (
                <Paragraph data-testid="error-events-summary-empty" className="text-ink-soft">
                  Nothing reported in the last {String(summaryData.windowDays)} days.
                </Paragraph>
              ) : (
                <table className="w-full border-collapse text-left text-ui-sm">
                  <thead>
                    <tr className="border-b border-line">
                      <th className="py-2 pr-4 font-mono text-[length:var(--fs-meta)] font-medium tracking-[var(--ls-crumb)] text-ink-soft uppercase">Fingerprint (last {String(summaryData.windowDays)} days)</th>
                      <th className="py-2 pr-4 font-mono text-[length:var(--fs-meta)] font-medium tracking-[var(--ls-crumb)] text-ink-soft uppercase">Source</th>
                      <th className="py-2 pr-4 font-mono text-[length:var(--fs-meta)] font-medium tracking-[var(--ls-crumb)] text-ink-soft uppercase">Events</th>
                      <th className="py-2 pr-4 font-mono text-[length:var(--fs-meta)] font-medium tracking-[var(--ls-crumb)] text-ink-soft uppercase">First seen</th>
                      <th className="py-2 pr-4 font-mono text-[length:var(--fs-meta)] font-medium tracking-[var(--ls-crumb)] text-ink-soft uppercase">Last seen</th>
                      <th className="py-2 font-mono text-[length:var(--fs-meta)] font-medium tracking-[var(--ls-crumb)] text-ink-soft uppercase">Sample message</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summaryData.groups.map((group) => (
                      <tr
                        key={group.fingerprint}
                        className="border-b border-line"
                        data-testid="error-events-summary-row"
                      >
                        <td className="py-2 pr-4">
                          {/* The drill: this row's fingerprint becomes the
                              ledger's filter; clicking the active one again
                              clears it. */}
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-pressed={fingerprintFilter === group.fingerprint}
                            onClick={() => {
                              setFingerprintFilter((current) =>
                                current === group.fingerprint ? undefined : group.fingerprint,
                              );
                              setOffset(0);
                            }}
                            data-testid="error-events-drill"
                            title={group.fingerprint}
                            className="font-mono"
                          >
                            {shortFingerprint(group.fingerprint)}
                          </Button>
                        </td>
                        <td className="py-2 pr-4 font-mono">{group.source}</td>
                        <td className="py-2 pr-4 font-mono">{String(group.count)}</td>
                        <td className="py-2 pr-4 whitespace-nowrap text-ink-soft">{formatTime(group.firstSeen)}</td>
                        <td className="py-2 pr-4 whitespace-nowrap text-ink-soft">{formatTime(group.lastSeen)}</td>
                        <td className="py-2 break-words text-ink-soft">{group.sampleMessage}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="mt-3 flex items-center justify-between" data-testid="error-events-toolbar">
              <span className="flex gap-2">
                {SOURCE_TABS.map((tab) => (
                  <Button
                    key={tab.label}
                    variant="ghost"
                    size="sm"
                    aria-pressed={sourceFilter === tab.value}
                    onClick={() => {
                      setSourceFilter(tab.value);
                      setOffset(0);
                    }}
                    data-testid={
                      tab.value === undefined ? "error-events-source-all" : `error-events-source-${tab.value}`
                    }
                  >
                    {tab.label}
                  </Button>
                ))}
              </span>
              {fingerprintFilter !== undefined ? (
                <span
                  className="flex items-center gap-2 font-mono text-[length:var(--fs-meta)] text-ink-soft"
                  data-testid="error-events-filter-chip"
                >
                  fingerprint {shortFingerprint(fingerprintFilter)}…
                  <Button
                    variant="default"
                    size="sm"
                    onClick={() => {
                      setFingerprintFilter(undefined);
                      setOffset(0);
                    }}
                    data-testid="error-events-filter-clear"
                  >
                    Clear filter
                  </Button>
                </span>
              ) : null}
            </div>

            <div className="mt-3 overflow-x-auto" data-testid="error-events-table">
              <table className="w-full border-collapse text-left text-ui-sm">
                <thead>
                  <tr className="border-b border-line">
                    <th className="py-2 pr-4 font-mono text-[length:var(--fs-meta)] font-medium tracking-[var(--ls-crumb)] text-ink-soft uppercase">Time</th>
                    <th className="py-2 pr-4 font-mono text-[length:var(--fs-meta)] font-medium tracking-[var(--ls-crumb)] text-ink-soft uppercase">Source</th>
                    <th className="py-2 pr-4 font-mono text-[length:var(--fs-meta)] font-medium tracking-[var(--ls-crumb)] text-ink-soft uppercase">Message</th>
                    <th className="py-2 pr-4 font-mono text-[length:var(--fs-meta)] font-medium tracking-[var(--ls-crumb)] text-ink-soft uppercase">URL</th>
                    <th className="py-2 pr-4 font-mono text-[length:var(--fs-meta)] font-medium tracking-[var(--ls-crumb)] text-ink-soft uppercase">Request ID</th>
                    <th className="py-2 font-mono text-[length:var(--fs-meta)] font-medium tracking-[var(--ls-crumb)] text-ink-soft uppercase">Stack</th>
                  </tr>
                </thead>
                <tbody>
                  {data.events.map((event) => (
                    <tr key={event.id} className="border-b border-line align-top" data-testid="error-events-row">
                      <td className="py-2 pr-4 whitespace-nowrap text-ink-soft">{formatTime(event.createdAt)}</td>
                      <td className="py-2 pr-4 font-mono">{event.source}</td>
                      <td className="max-w-[28rem] py-2 pr-4 break-words">{event.message}</td>
                      <td className="py-2 pr-4 font-mono break-all text-ink-soft">{event.url ?? "—"}</td>
                      <td className="py-2 pr-4 font-mono break-all text-ink-soft">{event.requestId ?? "—"}</td>
                      <td className="py-2 text-ink-soft">
                        {/* The stack is triage's second look, not the first:
                            collapsed by default, the message and the place it
                            happened answer first. */}
                        {event.stack === null ? (
                          "—"
                        ) : (
                          <details data-testid="error-events-details">
                            <summary className="cursor-pointer">Stack</summary>
                            <pre className="mt-1 max-w-[32rem] overflow-x-auto font-mono text-[length:var(--fs-meta)]">
                              {event.stack}
                            </pre>
                          </details>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-3 flex items-center justify-between" data-testid="error-events-pager">
              <span className="font-mono text-[length:var(--fs-meta)] text-ink-soft">
                {data.total === 0
                  ? "0 entries"
                  : `${String(offset + 1)}–${String(Math.min(offset + data.events.length, data.total))} of ${String(data.total)}`}
              </span>
              <span className="flex gap-2">
                <Button
                  variant="default"
                  size="sm"
                  disabled={!hasNewer}
                  onClick={() => {
                    setOffset(Math.max(0, offset - PAGE_SIZE));
                  }}
                  data-testid="error-events-newer"
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
                  data-testid="error-events-older"
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
