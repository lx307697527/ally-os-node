// The approvals page (#221 slice 3) — the approver's side of the approval
// kernel: requests whose current level names this operator (by name or by
// role), each carrying its decision context — who submitted, what exactly is
// being approved (the payload), and whether agreeing requires the electronic
// signature ceremony (#219's SignatureDialog, first consumer here).
//
// Two doors, said honestly (see docs/approval.md): being NAMED on a level
// authorizes the decision, but the full request record still answers to the
// SUBJECT's visibility — so the panel shows the full history when the record
// is visible, and an explicit "decide from the summary" note when it is not,
// never a blank.
//
// States never lie: loading, unreachable API, an empty inbox, and every
// decision failure mode are all said in words (the adapter reports the
// failure mode — see approvals-client.ts).
import type { ReactElement } from "react";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card, Heading, Paragraph } from "@ally/ui";

import { SignatureDialog, meaningLabel } from "../components/SignatureDialog.tsx";
import {
  createApprovalAdapters,
  type ApprovalActInput,
  type ApprovalActResult,
  type ApprovalTodoRow,
} from "../lib/approvals-client.ts";
import { payloadRows } from "../lib/payload-rows.ts";

const approvalAdapters = createApprovalAdapters();

const ACT_MESSAGES: Record<Exclude<ApprovalActResult, { ok: true }>["reason"], string> = {
  invalid_credentials: "Password incorrect — nothing was signed.",
  two_factor_required:
    "Signing requires two-factor authentication. Set it up under Settings → Two-factor, then try again.",
  not_approver: "This request is no longer waiting on you.",
  gone: "This request was already decided or removed.",
  conflict: "Someone decided this request a moment ago.",
  signature_required: "This approval must be signed — approve again to sign.",
  invalid: "The decision was rejected — check the note and try again.",
  forbidden: "You are no longer allowed to decide this request.",
  unavailable: "The decision could not be saved. Reload and try again.",
};

function formatWhen(iso: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(iso),
  );
}

export function Approvals(): ReactElement {
  const queryClient = useQueryClient();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const todo = useQuery({
    queryKey: ["approvals", "todo"],
    queryFn: () => approvalAdapters.todo(),
  });

  const rows = todo.data?.ok ? todo.data.data : undefined;
  const unavailable = todo.data?.ok === false;
  const expanded = rows?.find((row) => row.requestId === expandedId) ?? null;

  function refresh(): void {
    void queryClient.invalidateQueries({ queryKey: ["approvals"] });
  }

  function toggle(row: ApprovalTodoRow): void {
    setFlash(null);
    setExpandedId((current) => (current === row.requestId ? null : row.requestId));
  }

  function onDecided(message: string): void {
    setFlash(message);
    setExpandedId(null);
    refresh();
  }

  return (
    <div className="w-full" data-page="approvals" data-testid="approvals-root">
      <Card>
        <Heading as="h2">Approvals</Heading>
        <Paragraph className="text-ink-soft">
          Requests waiting on your decision. Agreeing may require your
          electronic signature — the line's configuration says which levels.
        </Paragraph>

        {flash !== null ? (
          <Paragraph className="mt-3 text-ink" data-testid="approvals-flash">
            {flash}
          </Paragraph>
        ) : null}

        {todo.isPending ? (
          <Paragraph className="mt-3" data-testid="approvals-loading">
            Loading…
          </Paragraph>
        ) : unavailable || rows === undefined ? (
          <Paragraph className="mt-3 text-ink-soft" data-testid="approvals-unavailable">
            The approval inbox could not be loaded.
          </Paragraph>
        ) : rows.length === 0 ? (
          <Paragraph className="mt-3 text-ink-soft" data-testid="approvals-empty">
            Nothing is waiting on your decision.
          </Paragraph>
        ) : (
          <ul className="mt-3" data-testid="approvals-list">
            {rows.map((row) => (
              <li
                key={row.requestId}
                className="border-b border-line py-2"
                data-testid="approvals-row"
                data-request-id={row.requestId}
              >
                <div className="flex flex-wrap items-baseline gap-x-3">
                  <span className="text-ui font-medium text-ink" data-testid="approvals-row-name">
                    {row.configName}
                  </span>
                  <span className="font-mono text-[length:var(--fs-meta)] text-ink-soft" data-testid="approvals-row-level">
                    {row.levelName}
                  </span>
                  {row.requireSignature ? (
                    <span
                      className="font-mono text-[length:var(--fs-meta)] text-ink-soft"
                      data-testid="approvals-row-signs"
                    >
                      signs: {meaningLabel(row.signatureMeaning)}
                    </span>
                  ) : null}
                  {row.levelMode !== "any" ? (
                    <span
                      className="font-mono text-[length:var(--fs-meta)] text-ink-soft"
                      data-testid="approvals-row-progress"
                    >
                      {row.levelMode === "all" ? "countersign" : "vote"} {row.approvedCount}/
                      {row.neededApprovals}
                    </span>
                  ) : null}
                  <span className="flex-1" />
                  <Button
                    variant={expanded?.requestId === row.requestId ? "ghost" : "default"}
                    size="sm"
                    onClick={() => {
                      toggle(row);
                    }}
                    data-testid="approvals-row-review"
                  >
                    {expanded?.requestId === row.requestId ? "Close" : "Review"}
                  </Button>
                </div>
                <span className="mt-0.5 block font-mono text-[length:var(--fs-meta)] text-ink-soft" data-testid="approvals-row-meta">
                  {row.subjectType} · from {row.submittedBy.name} · {formatWhen(row.submittedAt)}
                </span>
                {expanded?.requestId === row.requestId ? (
                  <ReviewPanel row={row} onDecided={onDecided} />
                ) : null}              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

/** The decision panel for ONE expanded row. Owns the note, the signature
 *  dialog and the act call; the page owns only which row is open. */
function ReviewPanel(props: { row: ApprovalTodoRow; onDecided: (message: string) => void }): ReactElement {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signOpen, setSignOpen] = useState(false);
  const [signError, setSignError] = useState<string | null>(null);

  // The full record answers to the subject's visibility, not to being named on
  // the level — a config-named approver who cannot see the record still
  // decides, from the row's own context, and the panel says so.
  const detail = useQuery({
    queryKey: ["approvals", "detail", props.row.requestId],
    queryFn: () => approvalAdapters.get(props.row.requestId),
    staleTime: 30 * 1000,
  });
  const view = detail.data?.ok ? detail.data.data : undefined;

  async function act(decision: "approved" | "rejected", signature?: { password: string; clientToken: string }): Promise<void> {
    setError(null);
    setBusy(true);
    const trimmed = note.trim();
    const input: ApprovalActInput = {
      decision,
      ...(trimmed !== "" ? { note: trimmed } : {}),
      ...(signature ?? {}),
    };
    const result = await approvalAdapters.act(props.row.requestId, input);
    setBusy(false);
    if (result.ok) {
      props.onDecided("Decision recorded.");
      return;
    }
    // Stale-inbox cases: the world moved while this panel was open — collapse
    // the panel, refresh the list behind it, and say what actually happened
    // (never "recorded": this operator's decision did NOT land).
    if (result.reason === "gone" || result.reason === "conflict" || result.reason === "not_approver") {
      setSignOpen(false);
      props.onDecided(ACT_MESSAGES[result.reason]);
      return;
    }
    if (signOpen) {
      setSignError(ACT_MESSAGES[result.reason]);
      return;
    }
    setError(ACT_MESSAGES[result.reason]);
  }

  return (
    <div className="mt-2 rounded-small border border-line bg-card p-3" data-testid="approvals-panel">
      <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-[max-content_1fr]" data-testid="approvals-payload">
        {payloadRows(props.row.payload).map((entry) => (
          <div key={entry.key === "" ? "__payload" : entry.key} className="contents">
            <dt className="font-mono text-[length:var(--fs-meta)] text-ink-soft">{entry.label}</dt>
            <dd className="text-ui text-ink" data-testid={`approvals-payload-${entry.key === "" ? "value" : entry.key}`}>
              {entry.value}
            </dd>
          </div>
        ))}
        {payloadRows(props.row.payload).length === 0 ? (
          <dd className="text-ui-sm text-ink-soft" data-testid="approvals-payload-empty">
            No parameters recorded.
          </dd>
        ) : null}
      </dl>

      {detail.isPending ? (
        <Paragraph className="mt-2 text-ui-sm text-ink-soft" data-testid="approvals-detail-loading">
          Loading the full record…
        </Paragraph>
      ) : view !== undefined ? (
        <div className="mt-2" data-testid="approvals-detail">
          <Paragraph className="text-ui-sm text-ink-soft">
            {view.status === "pending"
              ? `Waiting on: ${view.currentLevel?.name ?? `step ${String(view.currentStep + 1)}`}`
              : view.status === "approved"
                ? "Approved."
                : "Rejected — back with the submitter."}
          </Paragraph>
          {view.actions.length > 0 ? (
            <ul className="mt-1" data-testid="approvals-detail-actions">
              {view.actions.map((action) => (
                <li key={action.id} className="text-ui-sm text-ink-soft">
                  {action.actor.name} {action.decision === "approved" ? "approved" : "rejected"}{" "}
                  “{action.levelName}” · {formatWhen(action.createdAt)}
                  {action.note !== null && action.note !== "" ? ` — “${action.note}”` : ""}
                  {action.signature !== null
                    ? ` · signed ${meaningLabel(action.signature.meaning)} at ${formatWhen(action.signature.signedAt)}`
                    : ""}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : detail.data?.ok === false && detail.data.reason === "notfound" ? (
        <Paragraph className="mt-2 text-ui-sm text-ink-soft" data-testid="approvals-detail-unseen">
          The full record is limited to people who can see the underlying
          document. Decide from the summary above.
        </Paragraph>
      ) : null}

      {props.row.viewerAlreadyActed ? (
        <Paragraph className="mt-3 text-ink-soft" data-testid="approvals-row-acted">
          You have already voted on this level — waiting on the remaining
          approvers.
        </Paragraph>
      ) : (
        <div className="mt-3">
          <label className="block">
            <span className="mb-1 block text-ui-sm font-semibold text-ink">
              Note <span className="font-normal text-ink-soft">(optional)</span>
            </span>
            <textarea
              value={note}
              onChange={(event) => {
                setNote(event.target.value);
              }}
              rows={2}
              maxLength={2000}
              placeholder="Why — one line the submitter will read"
              aria-label="Decision note"
              data-testid="approvals-row-note"
              className="block w-full rounded-small border border-line bg-card px-3 py-2 text-ui leading-[var(--lh-ui)] text-ink outline-none placeholder:text-ink-soft focus:border-[var(--control-navy)]"
            />
          </label>
        </div>
      )}

      {error !== null ? (
        <Paragraph className="mt-2 text-err" data-testid="approvals-action-error">
          {error}
        </Paragraph>
      ) : null}

      {props.row.viewerAlreadyActed ? null : (
        <div className="mt-3 flex items-center gap-3">
          <Button
            variant="primary"
            size="sm"
            disabled={busy}
            onClick={() => {
              if (props.row.requireSignature) {
                setSignError(null);
                setSignOpen(true);
                return;
              }
              void act("approved");
            }}
            data-testid="approvals-row-approve"
          >
            {busy ? "Saving…" : "Approve"}
          </Button>
          <Button
            variant="danger"
            size="sm"
            disabled={busy}
            onClick={() => {
              void act("rejected");
            }}
            data-testid="approvals-row-reject"
          >
            Reject
          </Button>
        </div>
      )}

      {signOpen ? (
        <SignatureDialog
          meaning={props.row.signatureMeaning}
          submitting={busy}
          error={signError}
          onClose={() => {
            setSignOpen(false);
            setSignError(null);
          }}
          onConfirm={(input) => {
            void act("approved", input);
          }}
        />
      ) : null}
    </div>
  );
}
