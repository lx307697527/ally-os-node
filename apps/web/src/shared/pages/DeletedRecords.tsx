// The deleted-records page (#29 slice 2) — the System region's second page,
// behind the same audit.read gate as the audit log. One read, newest deletion
// first: what was deleted, by whom, when, and the snapshot of the row as it
// stood at deletion; restore puts a soft-deleted row back and the ledger row
// stays (restored is history, not an erasure).
//
// States are honest, never blank-by-accident: loading says so, a 403 says
// the account lacks the audit permission, an unreachable API says so, an
// empty ledger says what would fill it. Restore conflicts are named —
// already restored, type not restorable, row gone — never a bare "failed".
import type { ReactElement } from "react";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card, Heading, Paragraph } from "@ally/ui";

import { createDeletedRecordsAdapters, type DeletedRecordRow } from "../lib/deleted-records-client.ts";

const deletedRecordsAdapters = createDeletedRecordsAdapters();

/** Rows per page — also the API's default; the pager steps in this unit. */
const PAGE_SIZE = 50;

function formatTime(iso: string): string {
  // Locale follows the browser: timestamps are numbers, not copy.
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(iso),
  );
}

/** The server's conflict word, translated. Unknown codes read verbatim. */
function conflictMessage(code: string | undefined): string {
  switch (code) {
    case "restored_already":
      return "This record was already restored.";
    case "restore_unsupported":
      return "This record type cannot be restored here.";
    case "subject_missing":
      return "The deleted row no longer exists; nothing to restore.";
    case undefined:
      return "Restore was refused.";
    default:
      return `Restore was refused (${code}).`;
  }
}

export function DeletedRecords(): ReactElement {
  const queryClient = useQueryClient();
  const [offset, setOffset] = useState(0);
  const [conflict, setConflict] = useState<string | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const page = useQuery({
    queryKey: ["deleted-records", offset],
    queryFn: () => deletedRecordsAdapters.page({ limit: PAGE_SIZE, offset }),
    placeholderData: (previous) => previous,
  });

  const data = page.data?.ok ? page.data.data : undefined;
  const failure = page.data?.ok === false ? page.data.reason : undefined;
  const hasNewer = offset > 0;
  const hasOlder = data !== undefined && offset + PAGE_SIZE < data.total;

  async function restore(row: DeletedRecordRow): Promise<void> {
    setConflict(null);
    setRestoringId(row.id);
    const result = await deletedRecordsAdapters.restore(row.id);
    setRestoringId(null);
    if (!result.ok) {
      if (result.reason === "conflict") setConflict(conflictMessage(result.code));
      else if (result.reason === "notfound") setConflict("This ledger entry no longer exists.");
      else if (result.reason === "forbidden")
        setConflict("Your account does not have permission to restore records.");
      else setConflict("Restore could not be completed. Reload and try again.");
      return;
    }
    void queryClient.invalidateQueries({ queryKey: ["deleted-records"] });
  }

  return (
    <div className="w-full" data-page="deleted-records" data-testid="deleted-records-root">
      <Card>
        <Heading as="h2">Deleted records</Heading>
        <Paragraph className="text-ink-soft">
          Everything soft-deleted, newest first, with the row as it stood at
          deletion. Restoring puts the record back; the deletion stays on the
          ledger — history is not rewritten.
        </Paragraph>

        {page.isPending ? (
          <Paragraph data-testid="deleted-records-loading">Loading…</Paragraph>
        ) : failure === "forbidden" ? (
          <Paragraph data-testid="deleted-records-forbidden" className="text-ink-soft">
            Your account does not have permission to read deleted records. Ask
            an administrator for the audit permission.
          </Paragraph>
        ) : failure === "unavailable" || data === undefined ? (
          <Paragraph data-testid="deleted-records-unavailable" className="text-ink-soft">
            The deleted-records list could not be loaded.
          </Paragraph>
        ) : data.records.length === 0 ? (
          <Paragraph data-testid="deleted-records-empty" className="text-ink-soft">
            Nothing has been deleted yet. Deletions appear here the first time
            a record is removed.
          </Paragraph>
        ) : (
          <>
            {conflict !== null ? (
              <Paragraph className="mt-3 text-ink-soft" data-testid="deleted-records-conflict">
                {conflict}
              </Paragraph>
            ) : null}
            <div className="mt-3 overflow-x-auto" data-testid="deleted-records-table">
              <table className="w-full border-collapse text-left text-ui-sm">
                <thead>
                  <tr className="border-b border-line">
                    <th className="py-2 pr-4 font-mono text-[length:var(--fs-meta)] font-medium tracking-[var(--ls-crumb)] text-ink-soft uppercase">Deleted at</th>
                    <th className="py-2 pr-4 font-mono text-[length:var(--fs-meta)] font-medium tracking-[var(--ls-crumb)] text-ink-soft uppercase">Type</th>
                    <th className="py-2 pr-4 font-mono text-[length:var(--fs-meta)] font-medium tracking-[var(--ls-crumb)] text-ink-soft uppercase">Title</th>
                    <th className="py-2 pr-4 font-mono text-[length:var(--fs-meta)] font-medium tracking-[var(--ls-crumb)] text-ink-soft uppercase">Deleted by</th>
                    <th className="py-2 pr-4 font-mono text-[length:var(--fs-meta)] font-medium tracking-[var(--ls-crumb)] text-ink-soft uppercase">Status</th>
                    <th className="py-2 font-mono text-[length:var(--fs-meta)] font-medium tracking-[var(--ls-crumb)] text-ink-soft uppercase">Snapshot</th>
                    <th className="py-2" aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {data.records.map((row) => (
                    <tr key={row.id} className="border-b border-line align-top" data-testid="deleted-records-row">
                      <td className="py-2 pr-4 whitespace-nowrap text-ink-soft">{formatTime(row.deletedAt)}</td>
                      <td className="py-2 pr-4 font-mono">{row.subjectType}</td>
                      <td className="py-2 pr-4">{row.title}</td>
                      <td className="py-2 pr-4 text-ink-soft">{row.deletedBy?.name ?? "—"}</td>
                      <td className="py-2 pr-4 whitespace-nowrap">
                        {row.restoredAt === null ? (
                          <span data-testid="deleted-records-status-active">Deleted</span>
                        ) : (
                          <span className="text-ink-soft" data-testid="deleted-records-status-restored">
                            Restored {formatTime(row.restoredAt)}
                            {row.restoredBy !== null ? ` by ${row.restoredBy.name}` : ""}
                          </span>
                        )}
                      </td>
                      <td className="max-w-[320px] py-2 pr-4">
                        <details data-testid="deleted-records-snapshot">
                          <summary className="cursor-pointer font-mono text-[length:var(--fs-meta)] text-ink-soft">
                            View snapshot
                          </summary>
                          <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-[length:var(--fs-meta)] text-ink-soft">
                            {JSON.stringify(row.snapshot, null, 2)}
                          </pre>
                        </details>
                      </td>
                      <td className="py-2 whitespace-nowrap">
                        {row.restoredAt === null ? (
                          <Button
                            variant="default"
                            size="sm"
                            disabled={restoringId !== null}
                            onClick={() => {
                              void restore(row);
                            }}
                            data-testid="deleted-records-restore"
                          >
                            {restoringId === row.id ? "Restoring…" : "Restore"}
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-3 flex items-center justify-between" data-testid="deleted-records-pager">
              <span className="font-mono text-[length:var(--fs-meta)] text-ink-soft">
                {data.total === 0
                  ? "0 entries"
                  : `${String(offset + 1)}–${String(Math.min(offset + data.records.length, data.total))} of ${String(data.total)}`}
              </span>
              <span className="flex gap-2">
                <Button
                  variant="default"
                  size="sm"
                  disabled={!hasNewer}
                  onClick={() => {
                    setOffset(Math.max(0, offset - PAGE_SIZE));
                  }}
                  data-testid="deleted-records-newer"
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
                  data-testid="deleted-records-older"
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
