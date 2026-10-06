// The numbering rules page (#225 config face) — the configuration studio's
// numbering half: one rule per document type mints that type's numbers as
// prefix + date segment + zero-padded sequence.
//
// The page's one rule to keep visible: an edit applies to documents issued
// FROM NOW ON. Issued numbers never change, and the start number is fixed
// after creation (restarting a series = deactivate this rule, create a new
// one — the server refuses the field rather than silently ignoring it, so
// the page never offers it). The next-number preview renders exactly what
// the server will mint so a format edit can be read before it is saved;
// it is a preview, not a reservation.
//
// States are honest, never blank-by-accident — loading, no numbering
// permission, an unreachable API, an empty registry (no document type can
// be numbered yet), an empty rule table, and every write failure mode all
// say themselves in words (the adapter reports the failure mode — see
// numbering-client.ts).
import type { ReactElement } from "react";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card, Heading, Input, Paragraph } from "@ally/ui";

import {
  createNumberingAdapters,
  nextSequenceFor,
  NUMBERING_DATE_FORMATS,
  previewNumber,
  type CreateRuleFailure,
  type NumberedSubjectOption,
  type NumberingDateFormat,
  type NumberingRuleRow,
  type UpdateRuleFailure,
} from "../lib/numbering-client.ts";

const numberingAdapters = createNumberingAdapters();

const DATE_LABELS: Record<NumberingDateFormat, string> = {
  YYYY: "Year — YYYY",
  YYYYMM: "Year + month — YYYYMM",
  YYYYMMDD: "Year + month + day — YYYYMMDD",
};

const CREATE_ERRORS: Record<Exclude<CreateRuleFailure, "unavailable">, string> = {
  forbidden: "Your account does not have permission to manage numbering rules.",
  unregistered: "That document type is no longer open for numbering rules.",
  exists: "An active rule already exists for this document type — deactivate it first.",
  invalid: "The rule was rejected — check the fields and try again.",
};

const EDIT_ERRORS: Record<Exclude<UpdateRuleFailure, "unavailable">, string> = {
  forbidden: "Your account does not have permission to manage numbering rules.",
  not_found: "This rule no longer exists — someone removed it while you were editing.",
  exists: "Another active rule already exists for this document type — deactivate that one first.",
  invalid: "The change was rejected — check the fields and try again.",
};

function failureMessage<T extends string>(
  catalog: Record<Exclude<T, "unavailable">, string>,
  reason: T,
): string {
  return reason === "unavailable"
    ? "The change could not be saved. Reload and try again."
    : catalog[reason as Exclude<T, "unavailable">];
}

function formatDateTime(iso: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(iso),
  );
}

/** The create form's draft — inputs are strings until submit validates them;
 *  the server is the authority, this check only keeps obviously-broken
 *  submits from making the round trip. */
interface CreateDraft {
  subject: string;
  label: string;
  prefix: string;
  dateFormat: NumberingDateFormat | "none";
  padding: string;
  startNumber: string;
}

const EMPTY_CREATE: CreateDraft = {
  subject: "",
  label: "",
  prefix: "",
  dateFormat: "none",
  padding: "4",
  startNumber: "1",
};

/** Parses the draft into a create body, or null when a field is off. */
function parseCreate(draft: CreateDraft): {
  subject: string;
  label: string;
  prefix: string;
  dateFormat: NumberingDateFormat | null;
  padding: number;
  startNumber: number;
} | null {
  const padding = Number(draft.padding);
  const startNumber = Number(draft.startNumber);
  if (draft.subject === "" || draft.label === "") return null;
  if (!Number.isInteger(padding) || padding < 0 || padding > 10) return null;
  if (!Number.isInteger(startNumber) || startNumber < 1) return null;
  return {
    subject: draft.subject,
    label: draft.label,
    prefix: draft.prefix.trim(),
    dateFormat: draft.dateFormat === "none" ? null : draft.dateFormat,
    padding,
    startNumber,
  };
}

function subjectLabelOf(subjects: NumberedSubjectOption[], subject: string): string {
  return subjects.find((entry) => entry.subject === subject)?.label ?? subject;
}

export function NumberingRules(): ReactElement {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [createDraft, setCreateDraft] = useState<CreateDraft>(EMPTY_CREATE);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createBusy, setCreateBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<{ label: string; prefix: string; dateFormat: NumberingDateFormat | "none"; padding: string; active: boolean } | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [editBusy, setEditBusy] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  const rulesQuery = useQuery({
    queryKey: ["numbering-rules"],
    queryFn: () => numberingAdapters.list(),
  });
  const subjectsQuery = useQuery({
    queryKey: ["numbering-subjects"],
    queryFn: () => numberingAdapters.subjects(),
  });

  const rules = rulesQuery.data?.ok ? rulesQuery.data.data : undefined;
  const forbidden = rulesQuery.data?.ok === false && rulesQuery.data.reason === "forbidden";
  const unavailable = (rulesQuery.data?.ok === false && rulesQuery.data.reason === "unavailable") || rules === undefined;
  const subjects = subjectsQuery.data?.ok ? subjectsQuery.data.data : [];

  const previewClock = new Date();
  const nextNumberFor = (rule: NumberingRuleRow): string =>
    previewNumber(rule, nextSequenceFor(rule), previewClock);

  function refresh(): void {
    void queryClient.invalidateQueries({ queryKey: ["numbering-rules"] });
    void queryClient.invalidateQueries({ queryKey: ["numbering-subjects"] });
  }

  function openCreate(): void {
    setFlash(null);
    setCreateError(null);
    setCreateDraft(EMPTY_CREATE);
    setCreateOpen(true);
  }

  async function submitCreate(): Promise<void> {
    const parsed = parseCreate(createDraft);
    if (parsed === null) {
      setCreateError("Label and document type are required; padding is 0–10 and the start number is a whole number of 1 or more.");
      return;
    }
    setCreateBusy(true);
    setCreateError(null);
    const result = await numberingAdapters.create(parsed);
    setCreateBusy(false);
    if (!result.ok) {
      setCreateError(failureMessage(CREATE_ERRORS, result.reason));
      return;
    }
    setCreateOpen(false);
    setFlash("Rule created — the series starts at the next document.");
    refresh();
  }

  function openEdit(rule: NumberingRuleRow): void {
    setFlash(null);
    setEditError(null);
    setEditingId(rule.id);
    setEditDraft({
      label: rule.label,
      prefix: rule.prefix,
      dateFormat: rule.dateFormat ?? "none",
      padding: String(rule.padding),
      active: rule.active,
    });
  }

  async function submitEdit(): Promise<void> {
    if (editDraft === null || editingId === null) return;
    const padding = Number(editDraft.padding);
    if (!Number.isInteger(padding) || padding < 0 || padding > 10 || editDraft.label.trim() === "") {
      setEditError("Label is required and padding is 0–10.");
      return;
    }
    setEditBusy(true);
    setEditError(null);
    const result = await numberingAdapters.update(editingId, {
      label: editDraft.label.trim(),
      prefix: editDraft.prefix.trim(),
      dateFormat: editDraft.dateFormat === "none" ? null : editDraft.dateFormat,
      padding,
      active: editDraft.active,
    });
    setEditBusy(false);
    if (!result.ok) {
      setEditError(failureMessage(EDIT_ERRORS, result.reason));
      return;
    }
    setEditingId(null);
    setEditDraft(null);
    setFlash("Saved — the format applies to documents issued from now on; issued numbers never change.");
    refresh();
  }

  const editTarget = rules?.find((rule) => rule.id === editingId) ?? null;

  return (
    <div className="w-full" data-page="numbering-rules" data-testid="numbering-rules-root">
      <Card>
        <Heading as="h2">Numbering rules</Heading>
        <Paragraph className="text-ink-soft">
          One rule per document type mints its numbers — prefix, date segment
          (UTC) and a zero-padded sequence that never restarts. Edits apply to
          documents issued from now on; issued numbers never change.
        </Paragraph>

        {flash !== null ? (
          <Paragraph className="mt-3 text-ink" data-testid="numbering-flash">
            {flash}
          </Paragraph>
        ) : null}

        {rulesQuery.isPending ? (
          <Paragraph className="mt-3" data-testid="numbering-rules-loading">
            Loading…
          </Paragraph>
        ) : forbidden ? (
          <Paragraph className="mt-3 text-ink-soft" data-testid="numbering-rules-forbidden">
            Your account does not have permission to manage numbering rules.
            Ask an administrator for the numbering permission.
          </Paragraph>
        ) : unavailable ? (
          <Paragraph className="mt-3 text-ink-soft" data-testid="numbering-rules-unavailable">
            The numbering rules could not be loaded.
          </Paragraph>
        ) : (
          <>
            <div className="mt-3">
              <Button variant="primary" size="sm" data-testid="numbering-new" onClick={openCreate}>
                New rule
              </Button>
            </div>

            {createOpen ? (
              <div className="mt-3 rounded-card border border-line p-4" data-testid="numbering-create-form">
                <Heading as="h3">New rule</Heading>
                {subjects.length === 0 ? (
                  <Paragraph className="mt-2 text-ink-soft" data-testid="numbering-subjects-empty">
                    No document types can be numbered yet — the list opens as
                    business domains arrive.
                  </Paragraph>
                ) : (
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <label className="text-ui-sm text-ink">
                      Document type
                      <select
                        className="mt-1 block w-full rounded-control border border-line bg-card p-[var(--pad-control)] text-ui text-ink"
                        data-testid="numbering-create-subject"
                        value={createDraft.subject}
                        onChange={(e) => {
                          setCreateDraft({ ...createDraft, subject: e.target.value });
                        }}
                      >
                        <option value="">Choose a document type…</option>
                        {subjects.map((entry) => (
                          <option key={entry.subject} value={entry.subject}>
                            {entry.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="text-ui-sm text-ink">
                      Label
                      <Input
                        className="mt-1 block w-full"
                        data-testid="numbering-create-label"
                        value={createDraft.label}
                        onChange={(e) => {
                          setCreateDraft({ ...createDraft, label: e.target.value });
                        }}
                      />
                    </label>
                    <label className="text-ui-sm text-ink">
                      Prefix
                      <Input
                        className="mt-1 block w-full"
                        data-testid="numbering-create-prefix"
                        value={createDraft.prefix}
                        placeholder="INV-"
                        onChange={(e) => {
                          setCreateDraft({ ...createDraft, prefix: e.target.value });
                        }}
                      />
                    </label>
                    <label className="text-ui-sm text-ink">
                      Date segment (UTC)
                      <select
                        className="mt-1 block w-full rounded-control border border-line bg-card p-[var(--pad-control)] text-ui text-ink"
                        data-testid="numbering-create-dateformat"
                        value={createDraft.dateFormat}
                        onChange={(e) => {
                          setCreateDraft({ ...createDraft, dateFormat: e.target.value as CreateDraft["dateFormat"] });
                        }}
                      >
                        <option value="none">No date segment</option>
                        {NUMBERING_DATE_FORMATS.map((format) => (
                          <option key={format} value={format}>
                            {DATE_LABELS[format]}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="text-ui-sm text-ink">
                      Padding (minimum digits)
                      <Input
                        className="mt-1 block w-full"
                        type="number"
                        min={0}
                        max={10}
                        data-testid="numbering-create-padding"
                        value={createDraft.padding}
                        onChange={(e) => {
                          setCreateDraft({ ...createDraft, padding: e.target.value });
                        }}
                      />
                    </label>
                    <label className="text-ui-sm text-ink">
                      Start number
                      <Input
                        className="mt-1 block w-full"
                        type="number"
                        min={1}
                        data-testid="numbering-create-start"
                        value={createDraft.startNumber}
                        onChange={(e) => {
                          setCreateDraft({ ...createDraft, startNumber: e.target.value });
                        }}
                      />
                    </label>
                  </div>
                )}
                {createError !== null ? (
                  <Paragraph className="mt-2 text-err font-medium" data-testid="numbering-create-error">
                    {createError}
                  </Paragraph>
                ) : null}
                {subjects.length > 0 && createDraft.subject !== "" ? (
                  <Paragraph className="mt-2 font-mono text-ui-sm text-ink-soft" data-testid="numbering-create-preview">
                    First number: {previewNumber(
                      {
                        prefix: createDraft.prefix.trim(),
                        dateFormat: createDraft.dateFormat === "none" ? null : createDraft.dateFormat,
                        padding: Number(createDraft.padding),
                      },
                      Number(createDraft.startNumber),
                      previewClock,
                    )}
                  </Paragraph>
                ) : null}
                <div className="mt-3 flex gap-2">
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={createBusy}
                    data-testid="numbering-create-submit"
                    onClick={() => {
                      void submitCreate();
                    }}
                  >
                    {createBusy ? "Creating…" : "Create rule"}
                  </Button>
                  <Button
                    variant="default"
                    size="sm"
                    disabled={createBusy}
                    data-testid="numbering-create-cancel"
                    onClick={() => {
                      setCreateOpen(false);
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : null}

            {rules.length === 0 ? (
              <Paragraph className="mt-3 text-ink-soft" data-testid="numbering-rules-empty">
                No rules yet. Create the first rule to start a series.
              </Paragraph>
            ) : (
              <div className="mt-3 overflow-x-auto" data-testid="numbering-rules-table">
                <table className="w-full border-collapse text-left text-ui-sm">
                  <thead>
                    <tr className="border-b border-line">
                      <th className="py-2 pr-4 font-mono text-[length:var(--fs-meta)] font-medium tracking-[var(--ls-crumb)] text-ink-soft uppercase">Document type</th>
                      <th className="py-2 pr-4 font-mono text-[length:var(--fs-meta)] font-medium tracking-[var(--ls-crumb)] text-ink-soft uppercase">Label</th>
                      <th className="py-2 pr-4 font-mono text-[length:var(--fs-meta)] font-medium tracking-[var(--ls-crumb)] text-ink-soft uppercase">Next number</th>
                      <th className="py-2 pr-4 font-mono text-[length:var(--fs-meta)] font-medium tracking-[var(--ls-crumb)] text-ink-soft uppercase">Status</th>
                      <th className="py-2 pr-4 font-mono text-[length:var(--fs-meta)] font-medium tracking-[var(--ls-crumb)] text-ink-soft uppercase">Last issued</th>
                      <th className="py-2 pr-4 font-mono text-[length:var(--fs-meta)] font-medium tracking-[var(--ls-crumb)] text-ink-soft uppercase">Updated</th>
                      <th className="py-2 font-mono text-[length:var(--fs-meta)] font-medium tracking-[var(--ls-crumb)] text-ink-soft uppercase"> </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rules.map((rule) => (
                      <tr key={rule.id} className="border-b border-line align-top" data-testid="numbering-rule-row">
                        <td className="py-2 pr-4">
                          <span className="font-mono">{rule.subject}</span>
                          <span className="block text-ink-soft">{subjectLabelOf(subjects, rule.subject)}</span>
                        </td>
                        <td className="py-2 pr-4">{rule.label}</td>
                        <td className="py-2 pr-4 font-mono" data-testid="numbering-rule-preview">
                          {nextNumberFor(rule)}
                        </td>
                        <td className="py-2 pr-4">
                          {rule.active ? (
                            <span className="font-medium text-brand" data-testid="numbering-rule-active">Active</span>
                          ) : (
                            <span className="text-ink-soft" data-testid="numbering-rule-inactive">Deactivated</span>
                          )}
                        </td>
                        <td className="py-2 pr-4 font-mono text-ink-soft">
                          {rule.lastIssued === null ? "—" : String(rule.lastIssued)}
                        </td>
                        <td className="py-2 pr-4 whitespace-nowrap text-ink-soft">{formatDateTime(rule.updatedAt)}</td>
                        <td className="py-2">
                          <Button
                            variant="default"
                            size="sm"
                            data-testid="numbering-rule-edit"
                            onClick={() => {
                              openEdit(rule);
                            }}
                          >
                            Edit
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {editTarget !== null && editDraft !== null ? (
              <div className="mt-3 rounded-card border border-line p-4" data-testid="numbering-edit-form">
                <Heading as="h3">Edit rule — {subjectLabelOf(subjects, editTarget.subject)}</Heading>
                <Paragraph className="mt-1 text-ui-sm text-ink-soft">
                  Series {editTarget.prefix === "" ? "(no prefix)" : editTarget.prefix} starts at{" "}
                  <span className="font-mono">{editTarget.startNumber}</span>. The start number is
                  fixed after creation — to restart the series, deactivate this rule and create a
                  new one; this rule stays on record either way.
                </Paragraph>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <label className="text-ui-sm text-ink">
                    Label
                    <Input
                      className="mt-1 block w-full"
                      data-testid="numbering-edit-label"
                      value={editDraft.label}
                      onChange={(e) => {
                        setEditDraft({ ...editDraft, label: e.target.value });
                      }}
                    />
                  </label>
                  <label className="text-ui-sm text-ink">
                    Prefix
                    <Input
                      className="mt-1 block w-full"
                      data-testid="numbering-edit-prefix"
                      value={editDraft.prefix}
                      onChange={(e) => {
                        setEditDraft({ ...editDraft, prefix: e.target.value });
                      }}
                    />
                  </label>
                  <label className="text-ui-sm text-ink">
                    Date segment (UTC)
                    <select
                      className="mt-1 block w-full rounded-control border border-line bg-card p-[var(--pad-control)] text-ui text-ink"
                      data-testid="numbering-edit-dateformat"
                      value={editDraft.dateFormat}
                      onChange={(e) => {
                        setEditDraft({ ...editDraft, dateFormat: e.target.value as CreateDraft["dateFormat"] });
                      }}
                    >
                      <option value="none">No date segment</option>
                      {NUMBERING_DATE_FORMATS.map((format) => (
                        <option key={format} value={format}>
                          {DATE_LABELS[format]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="text-ui-sm text-ink">
                    Padding (minimum digits)
                    <Input
                      className="mt-1 block w-full"
                      type="number"
                      min={0}
                      max={10}
                      data-testid="numbering-edit-padding"
                      value={editDraft.padding}
                      onChange={(e) => {
                        setEditDraft({ ...editDraft, padding: e.target.value });
                      }}
                    />
                  </label>
                </div>
                <label className="mt-3 flex cursor-pointer items-center gap-2 text-ui-sm text-ink">
                  <input
                    type="checkbox"
                    className="size-4 accent-[var(--accent)]"
                    data-testid="numbering-edit-active"
                    checked={editDraft.active}
                    onChange={(e) => {
                      setEditDraft({ ...editDraft, active: e.target.checked });
                    }}
                  />
                  Active — this rule mints the numbers for {subjectLabelOf(subjects, editTarget.subject)}
                </label>
                {editError !== null ? (
                  <Paragraph className="mt-2 text-err font-medium" data-testid="numbering-edit-error">
                    {editError}
                  </Paragraph>
                ) : null}
                <Paragraph className="mt-2 font-mono text-ui-sm text-ink-soft" data-testid="numbering-edit-preview">
                  Next number with these settings: {previewNumber(
                    {
                      prefix: editDraft.prefix.trim(),
                      dateFormat: editDraft.dateFormat === "none" ? null : editDraft.dateFormat,
                      padding: Number(editDraft.padding),
                    },
                    nextSequenceFor(editTarget),
                    previewClock,
                  )}
                </Paragraph>
                <div className="mt-3 flex gap-2">
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={editBusy}
                    data-testid="numbering-edit-submit"
                    onClick={() => {
                      void submitEdit();
                    }}
                  >
                    {editBusy ? "Saving…" : "Save"}
                  </Button>
                  <Button
                    variant="default"
                    size="sm"
                    disabled={editBusy}
                    data-testid="numbering-edit-cancel"
                    onClick={() => {
                      setEditingId(null);
                      setEditDraft(null);
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : null}
          </>
        )}
      </Card>
    </div>
  );
}
