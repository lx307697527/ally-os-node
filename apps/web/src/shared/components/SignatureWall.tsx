// The signature wall (#219's read half, displayed where its first carried
// record lives — the approvals page's decision history). One wall per
// SUBJECT: given subject refs it reads GET /api/esignatures and shows the
// Part 11.50 display — printed name, exact time, meaning — plus the record
// version each signature is bound to. Any future carrying record (#204 batch
// release, …) mounts the same component with its own refs; it never names a
// subject type itself.
//
// States never lie: a wall that cannot be fully read is "could not be loaded"
// — a PARTIAL regulatory wall would quietly hide signatures, so one failed
// ref fails the whole section. Offline signatures (#219: signed offline, synced
// later) keep their original signing time and carry an explicit "synced" note
// — the wall explains the gap instead of hiding it.
//
// testids: sig-wall / sig-wall-loading / sig-wall-unavailable / sig-wall-empty /
// sig-wall-row / sig-wall-row-version / sig-wall-row-synced.
import type { ReactElement } from "react";
import { useQuery } from "@tanstack/react-query";

import { Paragraph } from "@ally/ui";

import { meaningLabel } from "./SignatureDialog.tsx";
import {
  createEsignAdapters,
  isLateSync,
  type EsignAdapters,
  type SignatureRow,
  type SignatureWallRef,
} from "../lib/esign-client.ts";

const esignAdapters = createEsignAdapters();

function formatWhen(iso: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(iso),
  );
}

export function SignatureWall(props: {
  /** Which records' signatures to show, in display order. */
  refs: readonly SignatureWallRef[];
  /** Injectable for tests; defaults to the real API adapters. */
  adapters?: EsignAdapters;
}): ReactElement {
  const adapters = props.adapters ?? esignAdapters;
  const wall = useQuery({
    queryKey: ["esignatures", "wall", props.refs],
    queryFn: async () => {
      // One failed ref fails the whole wall (see header): a regulatory display
      // is either fully read or explicitly unreadable, never partial. Empty
      // refs short-circuit to an empty wall — no request, honest empty state.
      const results = await Promise.all(props.refs.map((ref) => adapters.wall(ref)));
      const rows: SignatureRow[] = [];
      for (const result of results) {
        if (!result.ok) return { ok: false as const, reason: result.reason };
        rows.push(...result.data);
      }
      return { ok: true as const, data: rows };
    },
  });

  const rows = wall.data?.ok ? wall.data.data : undefined;
  const unavailable = wall.data?.ok === false || wall.isError;

  return (
    <div className="mt-2" data-testid="sig-wall">
      <h3 className="text-ui-sm font-semibold text-ink">Signatures</h3>
      {wall.isPending ? (
        <Paragraph className="mt-1 text-ui-sm text-ink-soft" data-testid="sig-wall-loading">
          Loading signatures…
        </Paragraph>
      ) : unavailable ? (
        <Paragraph className="mt-1 text-ui-sm text-ink-soft" data-testid="sig-wall-unavailable">
          The signature wall could not be loaded.
        </Paragraph>
      ) : rows?.length === 0 ? (
        <Paragraph className="mt-1 text-ui-sm text-ink-soft" data-testid="sig-wall-empty">
          No signatures recorded.
        </Paragraph>
      ) : rows !== undefined ? (
        <ul className="mt-1" data-testid="sig-wall-rows">
          {rows.map((row) => (
            <li key={row.id} className="text-ui-sm text-ink-soft" data-testid="sig-wall-row">
              {row.signer.name} signed{" "}
              <span className="text-ink">{meaningLabel(row.meaning)}</span> ·{" "}
              {formatWhen(row.signedAt)}
              <span
                className="ml-2 font-mono text-[length:var(--fs-meta)]"
                data-testid="sig-wall-row-version"
              >
                record {row.recordVersion}
              </span>
              {isLateSync(row) ? (
                <span
                  className="ml-2 font-mono text-[length:var(--fs-meta)]"
                  data-testid="sig-wall-row-synced"
                >
                  signed offline, synced {formatWhen(row.receivedAt)}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
