// The audit log page (#29) — the System region's first page. One read,
// newest first, exact total; the operator pages back in time and reads each
// governed action as actor / action / target / detail.
//
// States are honest, never blank-by-accident: loading says so, a 403 says
// the account lacks the audit.read permission, an unreachable API says so
// (the adapter reports the failure mode — see audit-client.ts). Detail is
// the change payload verbatim (JSON); a state change carries from/to in it.
import type { ReactElement } from "react";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, Card, Heading, Paragraph } from "@ally/ui";

import { createAuditAdapters } from "../lib/audit-client.ts";

const auditAdapters = createAuditAdapters();

/** Rows per page — also the API's default; the pager steps in this unit. */
const PAGE_SIZE = 50;

function formatTime(iso: string): string {
  // Locale follows the browser: timestamps are numbers, not copy.
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" }).format(
    new Date(iso),
  );
}

export function AuditLog(): ReactElement {
  const [offset, setOffset] = useState(0);
  const page = useQuery({
    queryKey: ["audit-events", offset],
    queryFn: () => auditAdapters.page({ limit: PAGE_SIZE, offset }),
    // The log only grows at the front; while paging, keep the previous page
    // on screen instead of collapsing to the loading row.
    placeholderData: (previous) => previous,
  });

  const data = page.data?.ok ? page.data.data : undefined;
  const failure = page.data?.ok === false ? page.data.reason : undefined;
  const hasNewer = offset > 0;
  const hasOlder = data !== undefined && offset + PAGE_SIZE < data.total;

  return (
    <div className="w-full" data-page="audit-log" data-testid="audit-log-root">
      <Card>
        <Heading as="h2">Audit log</Heading>
        <Paragraph className="text-ink-soft">
          Every governed change, newest first. Entries are append-only: what
          was written stays written.
        </Paragraph>

        {page.isPending ? (
          <Paragraph data-testid="audit-log-loading">Loading…</Paragraph>
        ) : failure === "forbidden" ? (
          <Paragraph data-testid="audit-log-forbidden" className="text-ink-soft">
            Your account does not have permission to read the audit log. Ask an
            administrator for the audit permission.
          </Paragraph>
        ) : failure === "unavailable" || data === undefined ? (
          <Paragraph data-testid="audit-log-unavailable" className="text-ink-soft">
            The audit log could not be loaded.
          </Paragraph>
        ) : data.events.length === 0 ? (
          <Paragraph data-testid="audit-log-empty" className="text-ink-soft">
            No entries yet. Actions appear here the first time something
            governed changes.
          </Paragraph>
        ) : (
          <>
            <div className="mt-3 overflow-x-auto" data-testid="audit-log-table">
              <table className="w-full border-collapse text-left text-ui-sm">
                <thead>
                  <tr className="border-b border-line">
                    <th className="py-2 pr-4 font-mono text-[length:var(--fs-meta)] font-medium tracking-[var(--ls-crumb)] text-ink-soft uppercase">Time</th>
                    <th className="py-2 pr-4 font-mono text-[length:var(--fs-meta)] font-medium tracking-[var(--ls-crumb)] text-ink-soft uppercase">Actor</th>
                    <th className="py-2 pr-4 font-mono text-[length:var(--fs-meta)] font-medium tracking-[var(--ls-crumb)] text-ink-soft uppercase">Action</th>
                    <th className="py-2 pr-4 font-mono text-[length:var(--fs-meta)] font-medium tracking-[var(--ls-crumb)] text-ink-soft uppercase">Target</th>
                    <th className="py-2 font-mono text-[length:var(--fs-meta)] font-medium tracking-[var(--ls-crumb)] text-ink-soft uppercase">Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {data.events.map((event) => (
                    <tr key={event.id} className="border-b border-line align-top" data-testid="audit-log-row">
                      <td className="py-2 pr-4 whitespace-nowrap text-ink-soft">{formatTime(event.createdAt)}</td>
                      <td className="py-2 pr-4 font-mono break-all">{event.actor ?? "—"}</td>
                      <td className="py-2 pr-4 font-mono">{event.action}</td>
                      <td className="py-2 pr-4 font-mono break-all">{event.target ?? "—"}</td>
                      <td className="max-w-[360px] py-2 font-mono break-all text-ink-soft">
                        {event.detail === null ? "—" : JSON.stringify(event.detail)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-3 flex items-center justify-between" data-testid="audit-log-pager">
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
                  data-testid="audit-log-newer"
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
                  data-testid="audit-log-older"
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
