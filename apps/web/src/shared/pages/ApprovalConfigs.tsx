// The approval lines page (#221 config face) — the configuration studio's
// approval half: one line per (subject type, key) routes that document's
// requests through ordered levels of named people and roles.
//
// The page's rulings, kept visible in words:
//
// 1. The key is identity and is never reused — a replacement is a NEW key,
//    and the old line is deactivated, not edited into a different thing.
// 2. An edit applies to requests submitted from now on; requests already in
//    flight keep the levels they were submitted with (the server snapshots
//    levels at submit time).
// 3. A deactivated line stops taking new submissions; its history and its
//    ledger versions stay.
// 4. customer is never offered as an approver — approval is a staff action
//    (the server refuses it either way; the editor does not offer it).
//
// Every state says itself in words — loading, no permission, an unreachable
// API, an empty table, and every write failure mode (see
// approval-config-client.ts for the reason catalog).
import type { ReactElement } from "react";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card, Heading, Input, Paragraph } from "@ally/ui";

import {
  APPROVAL_LEVEL_MODES,
  APPROVAL_ROLES,
  APPROVAL_SIGNATURE_MEANINGS,
  createApprovalConfigAdapters,
  type ApprovalConfigRow,
  type ApprovalLevel,
  type ApprovalLevelMode,
  type ApprovalRole,
  type ApprovalSignatureMeaning,
  type CreateConfigFailure,
  type RollbackFailure,
  type StaffOption,
  type UpdateConfigFailure,
} from "../lib/approval-config-client.ts";

const approvalAdapters = createApprovalConfigAdapters();

const MODE_LABELS: Record<ApprovalLevelMode, string> = {
  any: "any one approver",
  all: "everyone together (countersign)",
  quorum: "a quorum of approvers",
};

const MEANING_LABELS: Record<ApprovalSignatureMeaning, string> = {
  reviewed: "Reviewed",
  approved: "Approved",
};

const CREATE_ERRORS: Record<Exclude<CreateConfigFailure, "unavailable">, string> = {
  forbidden: "Your account does not have permission to manage approval lines.",
  exists:
    "That key is already taken for this subject type — keys are never reused. Deactivate the old line and create a new key.",
  invalid_levels:
    "The levels were rejected — every level needs a name and at least one approver; a vote threshold needs 2–50.",
  invalid: "The line was rejected — check the fields and try again.",
};

const EDIT_ERRORS: Record<Exclude<UpdateConfigFailure, "unavailable">, string> = {
  forbidden: "Your account does not have permission to manage approval lines.",
  not_found: "This line no longer exists — reload the page.",
  invalid_levels:
    "The levels were rejected — every level needs a name and at least one approver; a vote threshold needs 2–50.",
  invalid: "The change was rejected — check the fields and try again.",
};

const ROLLBACK_ERRORS: Record<Exclude<RollbackFailure, "unavailable">, string> = {
  forbidden:
    "The server refused the rollback — managing approval lines requires the approval permission.",
  not_found: "That version is not in this line's history.",
  no_change: "That version already matches the current definition — nothing to roll back.",
  unsupported: "This line's family does not support rollback.",
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

/** One level as the editor holds it — counts stay strings until submit
 *  validates them; the server is the authority, this check only keeps
 *  obviously-broken submits from making the round trip. */
interface LevelDraft {
  name: string;
  users: string[];
  roles: ApprovalRole[];
  mode: ApprovalLevelMode;
  quorum: string;
  requireSignature: boolean;
  signatureMeaning: ApprovalSignatureMeaning;
}

function emptyLevel(): LevelDraft {
  return {
    name: "",
    users: [],
    roles: [],
    mode: "any",
    quorum: "2",
    requireSignature: false,
    signatureMeaning: "approved",
  };
}

function levelToDraft(level: ApprovalLevel): LevelDraft {
  return {
    name: level.name,
    users: [...level.users],
    roles: (level.roles as ApprovalRole[]).filter((role) =>
      (APPROVAL_ROLES as readonly string[]).includes(role),
    ),
    mode: level.mode,
    quorum: String(level.quorum ?? 2),
    requireSignature: level.requireSignature,
    signatureMeaning: level.signatureMeaning,
  };
}

/** Parses the level drafts into the server's levels shape, or null when a
 *  level is off (the server re-validates and can still refuse). */
function parseLevels(drafts: LevelDraft[]): ApprovalLevel[] | null {
  const levels: ApprovalLevel[] = [];
  for (const draft of drafts) {
    const name = draft.name.trim();
    if (name === "") return null;
    if (draft.users.length + draft.roles.length < 1) return null;
    if (draft.mode === "quorum") {
      const quorum = Number(draft.quorum);
      if (!Number.isInteger(quorum) || quorum < 2 || quorum > 50) return null;
      levels.push({
        name,
        users: draft.users,
        roles: draft.roles,
        mode: "quorum",
        quorum,
        requireSignature: draft.requireSignature,
        signatureMeaning: draft.signatureMeaning,
      });
      continue;
    }
    levels.push({
      name,
      users: draft.users,
      roles: draft.roles,
      mode: draft.mode,
      requireSignature: draft.requireSignature,
      signatureMeaning: draft.signatureMeaning,
    });
  }
  return levels.length > 0 ? levels : null;
}

function levelsSummary(levels: ApprovalLevel[]): string {
  return levels
    .map((level, index) => {
      const mode =
        level.mode === "quorum" ? `quorum ${level.quorum ?? "?"}` : MODE_LABELS[level.mode];
      const signature = level.requireSignature ? " · signature" : "";
      return `${index + 1}. ${level.name} (${mode})${signature}`;
    })
    .join("  ");
}

interface LevelsEditorProps {
  drafts: LevelDraft[];
  staff: StaffOption[];
  onChange: (drafts: LevelDraft[]) => void;
  idPrefix: string;
}

/** The ordered-levels editor shared by the create and edit forms. Users are
 *  picked from the staff directory, roles from the staff role list — the
 *  approver set of a level is named people UNION role holders. */
function LevelsEditor({ drafts, staff, onChange, idPrefix }: LevelsEditorProps): ReactElement {
  const update = (index: number, patch: Partial<LevelDraft>): void => {
    onChange(drafts.map((draft, i) => (i === index ? { ...draft, ...patch } : draft)));
  };
  const toggleRole = (index: number, role: ApprovalRole): void => {
    const current = drafts[index];
    if (current === undefined) return;
    const roles = current.roles.includes(role)
      ? current.roles.filter((entry) => entry !== role)
      : [...current.roles, role];
    update(index, { roles });
  };
  return (
    <div className="mt-1 space-y-3">
      {drafts.map((draft, index) => (
        <div
          key={index}
          className="rounded-card border border-line p-3"
          data-testid={`${idPrefix}-level-row-${index}`}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-[length:var(--fs-meta)] tracking-[var(--ls-crumb)] text-ink-soft uppercase">
              Level {index + 1}
            </span>
            {drafts.length > 1 ? (
              <Button
                variant="default"
                size="sm"
                data-testid={`${idPrefix}-level-remove-${index}`}
                onClick={() => {
                  onChange(drafts.filter((_, i) => i !== index));
                }}
              >
                Remove
              </Button>
            ) : null}
          </div>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            <label className="text-ui-sm text-ink">
              Level name
              <Input
                className="mt-1 block w-full"
                data-testid={`${idPrefix}-level-name-${index}`}
                value={draft.name}
                placeholder="Lead review"
                onChange={(e) => {
                  update(index, { name: e.target.value });
                }}
              />
            </label>
            <label className="text-ui-sm text-ink">
              Decision rule
              <select
                className="mt-1 block w-full rounded-control border border-line bg-card p-[var(--pad-control)] text-ui text-ink"
                data-testid={`${idPrefix}-level-mode-${index}`}
                value={draft.mode}
                onChange={(e) => {
                  update(index, { mode: e.target.value as ApprovalLevelMode });
                }}
              >
                {APPROVAL_LEVEL_MODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {MODE_LABELS[mode]}
                  </option>
                ))}
              </select>
            </label>
            {draft.mode === "quorum" ? (
              <label className="text-ui-sm text-ink">
                Approvals needed (2–50)
                <Input
                  className="mt-1 block w-full"
                  type="number"
                  min={2}
                  max={50}
                  data-testid={`${idPrefix}-level-quorum-${index}`}
                  value={draft.quorum}
                  onChange={(e) => {
                    update(index, { quorum: e.target.value });
                  }}
                />
              </label>
            ) : null}
          </div>
          <label className="mt-3 block text-ui-sm text-ink">
            Named approvers
            <select
              className="mt-1 block w-full rounded-control border border-line bg-card p-[var(--pad-control)] text-ui text-ink"
              multiple
              size={Math.min(4, Math.max(2, staff.length))}
              data-testid={`${idPrefix}-level-users-${index}`}
              value={draft.users}
              onChange={(e) => {
                update(index, { users: Array.from(e.target.selectedOptions).map((o) => o.value) });
              }}
            >
              {staff.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name} ({person.email})
                </option>
              ))}
            </select>
          </label>
          <fieldset className="mt-3">
            <legend className="text-ui-sm text-ink">Role approvers</legend>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
              {APPROVAL_ROLES.map((role) => (
                <label key={role} className="flex cursor-pointer items-center gap-1 text-ui-sm text-ink">
                  <input
                    type="checkbox"
                    className="size-4 accent-[var(--accent)]"
                    data-testid={`${idPrefix}-level-role-${index}-${role}`}
                    checked={draft.roles.includes(role)}
                    onChange={() => {
                      toggleRole(index, role);
                    }}
                  />
                  {role}
                </label>
              ))}
            </div>
          </fieldset>
          <label className="mt-3 flex cursor-pointer items-center gap-2 text-ui-sm text-ink">
            <input
              type="checkbox"
              className="size-4 accent-[var(--accent)]"
              data-testid={`${idPrefix}-level-signature-${index}`}
              checked={draft.requireSignature}
              onChange={(e) => {
                update(index, { requireSignature: e.target.checked });
              }}
            />
            Require an electronic signature to approve this level
          </label>
          {draft.requireSignature ? (
            <label className="mt-2 block text-ui-sm text-ink">
              Signature meaning (fixed by the line, shown to the signer)
              <select
                className="mt-1 block w-full rounded-control border border-line bg-card p-[var(--pad-control)] text-ui text-ink"
                data-testid={`${idPrefix}-level-meaning-${index}`}
                value={draft.signatureMeaning}
                onChange={(e) => {
                  update(index, { signatureMeaning: e.target.value as ApprovalSignatureMeaning });
                }}
              >
                {APPROVAL_SIGNATURE_MEANINGS.map((meaning) => (
                  <option key={meaning} value={meaning}>
                    {MEANING_LABELS[meaning]}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
      ))}
      {drafts.length < 10 ? (
        <Button
          variant="default"
          size="sm"
          data-testid={`${idPrefix}-levels-add`}
          onClick={() => {
            onChange([...drafts, emptyLevel()]);
          }}
        >
          Add level
        </Button>
      ) : null}
    </div>
  );
}

export function ApprovalConfigs(): ReactElement {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [createSubject, setCreateSubject] = useState("");
  const [createKey, setCreateKey] = useState("");
  const [createName, setCreateName] = useState("");
  const [createLevels, setCreateLevels] = useState<LevelDraft[]>([emptyLevel()]);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createBusy, setCreateBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editActive, setEditActive] = useState(true);
  const [editLevels, setEditLevels] = useState<LevelDraft[]>([]);
  const [editError, setEditError] = useState<string | null>(null);
  const [editBusy, setEditBusy] = useState(false);
  const [historyId, setHistoryId] = useState<string | null>(null);
  const [rollbackVersion, setRollbackVersion] = useState("");
  const [rollbackReason, setRollbackReason] = useState("");
  const [rollbackError, setRollbackError] = useState<string | null>(null);
  const [rollbackBusy, setRollbackBusy] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  const configsQuery = useQuery({
    queryKey: ["approval-configs"],
    queryFn: () => approvalAdapters.list(),
  });
  const staffQuery = useQuery({
    queryKey: ["approval-staff-directory"],
    queryFn: () => approvalAdapters.directory(),
  });
  const historyQuery = useQuery({
    queryKey: ["approval-configs-history", historyId],
    queryFn: () => approvalAdapters.history(historyId ?? ""),
    enabled: historyId !== null,
  });

  const configs = configsQuery.data?.ok ? configsQuery.data.data : undefined;
  const forbidden = configsQuery.data?.ok === false && configsQuery.data.reason === "forbidden";
  const unavailable =
    (configsQuery.data?.ok === false && configsQuery.data.reason === "unavailable") ||
    configs === undefined;
  const staff = staffQuery.data?.ok ? staffQuery.data.data : [];
  const revisions = historyQuery.data?.ok ? historyQuery.data.data : undefined;

  function refresh(): void {
    void queryClient.invalidateQueries({ queryKey: ["approval-configs"] });
    void queryClient.invalidateQueries({ queryKey: ["approval-configs-history"] });
  }

  function openCreate(): void {
    setFlash(null);
    setCreateError(null);
    setCreateSubject("");
    setCreateKey("");
    setCreateName("");
    setCreateLevels([emptyLevel()]);
    setCreateOpen(true);
  }

  async function submitCreate(): Promise<void> {
    const levels = parseLevels(createLevels);
    const key = createKey.trim();
    if (createSubject.trim() === "" || createName.trim() === "" || levels === null) {
      setCreateError(
        "Subject type, name and every level are required; each level needs at least one approver.",
      );
      return;
    }
    if (!/^[a-z][a-z0-9_]*$/.test(key)) {
      setCreateError("The key must be lower_snake_case — it is the address other systems call this line by.");
      return;
    }
    setCreateBusy(true);
    setCreateError(null);
    const result = await approvalAdapters.create({
      subjectType: createSubject.trim(),
      configKey: key,
      name: createName.trim(),
      levels,
    });
    setCreateBusy(false);
    if (!result.ok) {
      setCreateError(failureMessage(CREATE_ERRORS, result.reason));
      return;
    }
    setCreateOpen(false);
    setFlash("Line created — new submissions to this key now follow these levels.");
    refresh();
  }

  function openEdit(config: ApprovalConfigRow): void {
    setFlash(null);
    setEditError(null);
    setEditingId(config.id);
    setEditName(config.name);
    setEditActive(config.active);
    setEditLevels(config.levels.map(levelToDraft));
  }

  async function submitEdit(): Promise<void> {
    if (editingId === null) return;
    const levels = parseLevels(editLevels);
    if (editName.trim() === "" || levels === null) {
      setEditError("Name and every level are required; each level needs at least one approver.");
      return;
    }
    setEditBusy(true);
    setEditError(null);
    const result = await approvalAdapters.update(editingId, {
      name: editName.trim(),
      levels,
      active: editActive,
    });
    setEditBusy(false);
    if (!result.ok) {
      setEditError(failureMessage(EDIT_ERRORS, result.reason));
      return;
    }
    setEditingId(null);
    setFlash(
      `Saved as version ${result.data.version} — requests submitted from now on follow these levels; requests already in flight keep the levels they were submitted with.`,
    );
    refresh();
  }

  function openHistory(config: ApprovalConfigRow): void {
    setFlash(null);
    setRollbackError(null);
    setRollbackVersion("");
    setRollbackReason("");
    setHistoryId(config.id);
  }

  async function submitRollback(): Promise<void> {
    const config = configs?.find((entry) => entry.id === historyId);
    if (config === undefined || rollbackVersion === "") return;
    const reason = rollbackReason.trim();
    setRollbackBusy(true);
    setRollbackError(null);
    const result = await approvalAdapters.rollback(
      config.id,
      Number(rollbackVersion),
      reason === "" ? undefined : reason,
    );
    setRollbackBusy(false);
    if (!result.ok) {
      setRollbackError(failureMessage(ROLLBACK_ERRORS, result.reason));
      return;
    }
    setFlash(
      `Rolled back to version ${result.data.restoredVersion} — the line now carries it as version ${result.data.newVersion}.`,
    );
    setHistoryId(null);
    refresh();
  }

  const editTarget = configs?.find((config) => config.id === editingId) ?? null;
  const historyTarget = configs?.find((config) => config.id === historyId) ?? null;

  return (
    <div className="w-full" data-page="approval-configs" data-testid="approval-configs-root">
      <Card>
        <Heading as="h2">Approval lines</Heading>
        <Paragraph className="text-ink-soft">
          An approval line routes a document's requests through ordered levels of
          named people and roles. Edits apply to requests submitted from now on —
          requests already in flight keep the levels they were submitted with. The
          key is never reused: a replacement is a new key, and a deactivated line
          stops taking new submissions while its history stays.
        </Paragraph>

        {flash !== null ? (
          <Paragraph className="mt-3 text-ink" data-testid="approval-configs-flash">
            {flash}
          </Paragraph>
        ) : null}

        {configsQuery.isPending ? (
          <Paragraph className="mt-3" data-testid="approval-configs-loading">
            Loading…
          </Paragraph>
        ) : forbidden ? (
          <Paragraph className="mt-3 text-ink-soft" data-testid="approval-configs-forbidden">
            Your account does not have permission to manage approval lines. Ask an
            administrator for the approval permission.
          </Paragraph>
        ) : unavailable ? (
          <Paragraph className="mt-3 text-ink-soft" data-testid="approval-configs-unavailable">
            The approval lines could not be loaded.
          </Paragraph>
        ) : (
          <>
            <div className="mt-3">
              <Button variant="primary" size="sm" data-testid="approval-configs-new" onClick={openCreate}>
                New line
              </Button>
            </div>

            {createOpen ? (
              <div className="mt-3 rounded-card border border-line p-4" data-testid="approval-configs-create-form">
                <Heading as="h3">New approval line</Heading>
                <div className="mt-3 grid gap-3 sm:grid-cols-3">
                  <label className="text-ui-sm text-ink">
                    Subject type
                    <Input
                      className="mt-1 block w-full"
                      data-testid="approval-configs-create-subject"
                      value={createSubject}
                      placeholder="quote_discount"
                      onChange={(e) => {
                        setCreateSubject(e.target.value);
                      }}
                    />
                  </label>
                  <label className="text-ui-sm text-ink">
                    Key (lower_snake_case, permanent)
                    <Input
                      className="mt-1 block w-full"
                      data-testid="approval-configs-create-key"
                      value={createKey}
                      placeholder="discount_line"
                      onChange={(e) => {
                        setCreateKey(e.target.value);
                      }}
                    />
                  </label>
                  <label className="text-ui-sm text-ink">
                    Name
                    <Input
                      className="mt-1 block w-full"
                      data-testid="approval-configs-create-name"
                      value={createName}
                      onChange={(e) => {
                        setCreateName(e.target.value);
                      }}
                    />
                  </label>
                </div>
                <Paragraph className="mt-2 text-ui-sm text-ink-soft">
                  The subject type must match the type the submitting domain
                  registers; the key is the address a submission names — both are
                  permanent once created.
                </Paragraph>
                <Heading as="h3">Levels, in order</Heading>
                <LevelsEditor
                  drafts={createLevels}
                  staff={staff}
                  onChange={setCreateLevels}
                  idPrefix="approval-create"
                />
                {staffQuery.data?.ok === false ? (
                  <Paragraph className="mt-2 text-ink-soft">
                    The staff directory could not be loaded — configure approvers by
                    role, or reload to pick named people.
                  </Paragraph>
                ) : null}
                {createError !== null ? (
                  <Paragraph className="mt-2 text-err font-medium" data-testid="approval-configs-create-error">
                    {createError}
                  </Paragraph>
                ) : null}
                <div className="mt-3 flex gap-2">
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={createBusy}
                    data-testid="approval-configs-create-submit"
                    onClick={() => {
                      void submitCreate();
                    }}
                  >
                    {createBusy ? "Creating…" : "Create line"}
                  </Button>
                  <Button
                    variant="default"
                    size="sm"
                    disabled={createBusy}
                    data-testid="approval-configs-create-cancel"
                    onClick={() => {
                      setCreateOpen(false);
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : null}

            {configs.length === 0 ? (
              <Paragraph className="mt-3 text-ink-soft" data-testid="approval-configs-empty">
                No approval lines yet. Create the first line to route a document's
                requests through approval.
              </Paragraph>
            ) : (
              <div className="mt-3 overflow-x-auto" data-testid="approval-configs-table">
                <table className="w-full border-collapse text-left text-ui-sm">
                  <thead>
                    <tr className="border-b border-line">
                      <th className="py-2 pr-4 font-mono text-[length:var(--fs-meta)] font-medium tracking-[var(--ls-crumb)] text-ink-soft uppercase">Subject type</th>
                      <th className="py-2 pr-4 font-mono text-[length:var(--fs-meta)] font-medium tracking-[var(--ls-crumb)] text-ink-soft uppercase">Key</th>
                      <th className="py-2 pr-4 font-mono text-[length:var(--fs-meta)] font-medium tracking-[var(--ls-crumb)] text-ink-soft uppercase">Name</th>
                      <th className="py-2 pr-4 font-mono text-[length:var(--fs-meta)] font-medium tracking-[var(--ls-crumb)] text-ink-soft uppercase">Levels</th>
                      <th className="py-2 pr-4 font-mono text-[length:var(--fs-meta)] font-medium tracking-[var(--ls-crumb)] text-ink-soft uppercase">Status</th>
                      <th className="py-2 pr-4 font-mono text-[length:var(--fs-meta)] font-medium tracking-[var(--ls-crumb)] text-ink-soft uppercase">Version</th>
                      <th className="py-2 font-mono text-[length:var(--fs-meta)] font-medium tracking-[var(--ls-crumb)] text-ink-soft uppercase"> </th>
                    </tr>
                  </thead>
                  <tbody>
                    {configs.map((config) => (
                      <tr key={config.id} className="border-b border-line align-top" data-testid="approval-configs-row">
                        <td className="py-2 pr-4 font-mono">{config.subjectType}</td>
                        <td className="py-2 pr-4 font-mono">{config.configKey}</td>
                        <td className="py-2 pr-4">{config.name}</td>
                        <td className="py-2 pr-4 text-ink-soft">{levelsSummary(config.levels)}</td>
                        <td className="py-2 pr-4">
                          {config.active ? (
                            <span className="font-medium text-brand" data-testid="approval-configs-active">Active</span>
                          ) : (
                            <span className="text-ink-soft" data-testid="approval-configs-inactive">Deactivated</span>
                          )}
                        </td>
                        <td className="py-2 pr-4 font-mono text-ink-soft">v{config.version}</td>
                        <td className="py-2">
                          <div className="flex gap-2">
                            <Button
                              variant="default"
                              size="sm"
                              data-testid="approval-configs-edit"
                              onClick={() => {
                                openEdit(config);
                              }}
                            >
                              Edit
                            </Button>
                            <Button
                              variant="default"
                              size="sm"
                              data-testid="approval-configs-history"
                              onClick={() => {
                                openHistory(config);
                              }}
                            >
                              History
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {editTarget !== null ? (
              <div className="mt-3 rounded-card border border-line p-4" data-testid="approval-configs-edit-form">
                <Heading as="h3">Edit line — {editTarget.subjectType} / {editTarget.configKey}</Heading>
                <Paragraph className="mt-1 text-ui-sm text-ink-soft">
                  The key is permanent. Saving rewrites the definition as version{" "}
                  {editTarget.version + 1}; requests already in flight keep the
                  levels they were submitted with.
                </Paragraph>
                <label className="mt-3 block text-ui-sm text-ink">
                  Name
                  <Input
                    className="mt-1 block w-full"
                    data-testid="approval-configs-edit-name"
                    value={editName}
                    onChange={(e) => {
                      setEditName(e.target.value);
                    }}
                  />
                </label>
                <Heading as="h3">Levels, in order</Heading>
                <LevelsEditor
                  drafts={editLevels}
                  staff={staff}
                  onChange={setEditLevels}
                  idPrefix="approval-edit"
                />
                <label className="mt-3 flex cursor-pointer items-center gap-2 text-ui-sm text-ink">
                  <input
                    type="checkbox"
                    className="size-4 accent-[var(--accent)]"
                    data-testid="approval-configs-edit-active"
                    checked={editActive}
                    onChange={(e) => {
                      setEditActive(e.target.checked);
                    }}
                  />
                  Active — this line accepts new submissions
                </label>
                {editError !== null ? (
                  <Paragraph className="mt-2 text-err font-medium" data-testid="approval-configs-edit-error">
                    {editError}
                  </Paragraph>
                ) : null}
                <div className="mt-3 flex gap-2">
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={editBusy}
                    data-testid="approval-configs-edit-submit"
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
                    data-testid="approval-configs-edit-cancel"
                    onClick={() => {
                      setEditingId(null);
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : null}

            {historyTarget !== null ? (
              <div className="mt-3 rounded-card border border-line p-4" data-testid="approval-configs-history-panel">
                <Heading as="h3">
                  History — {historyTarget.subjectType} / {historyTarget.configKey}
                </Heading>
                {historyQuery.isPending ? (
                  <Paragraph className="mt-2 text-ink-soft">Loading history…</Paragraph>
                ) : revisions !== undefined && revisions.length > 0 ? (
                  <table className="mt-2 w-full border-collapse text-left text-ui-sm">
                    <tbody>
                      {revisions.map((revision) => (
                        <tr key={revision.version} className="border-b border-line" data-testid="approval-configs-revision-row">
                          <td className="py-2 pr-4 font-mono">v{revision.version}</td>
                          <td className="py-2 pr-4">{revision.source}</td>
                          <td className="py-2 pr-4 text-ink-soft">
                            {revision.changes === null
                              ? "First version"
                              : Object.keys(revision.changes).join(", ")}
                          </td>
                          <td className="py-2 pr-4 whitespace-nowrap text-ink-soft">
                            {formatDateTime(revision.createdAt)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <Paragraph className="mt-2 text-ink-soft">
                    The history could not be loaded.
                  </Paragraph>
                )}
                <div className="mt-3 flex flex-wrap items-end gap-3">
                  <label className="text-ui-sm text-ink">
                    Roll back to version
                    <select
                      className="mt-1 block rounded-control border border-line bg-card p-[var(--pad-control)] text-ui text-ink"
                      data-testid="approval-configs-rollback-version"
                      value={rollbackVersion}
                      onChange={(e) => {
                        setRollbackVersion(e.target.value);
                      }}
                    >
                      <option value="">Choose a version…</option>
                      {(revisions ?? []).map((revision) => (
                        <option key={revision.version} value={revision.version}>
                          v{revision.version} ({revision.source})
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="text-ui-sm text-ink">
                    Reason (optional)
                    <Input
                      className="mt-1 block w-64"
                      data-testid="approval-configs-rollback-reason"
                      value={rollbackReason}
                      onChange={(e) => {
                        setRollbackReason(e.target.value);
                      }}
                    />
                  </label>
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={rollbackBusy || rollbackVersion === ""}
                    data-testid="approval-configs-rollback-submit"
                    onClick={() => {
                      void submitRollback();
                    }}
                  >
                    {rollbackBusy ? "Rolling back…" : "Roll back"}
                  </Button>
                </div>
                <Paragraph className="mt-2 text-ui-sm text-ink-soft">
                  A rollback restores the chosen version's definition as a NEW
                  version — history is never rewritten, and the current level
                  snapshot of requests already in flight is untouched.
                </Paragraph>
                {rollbackError !== null ? (
                  <Paragraph className="mt-2 text-err font-medium" data-testid="approval-configs-rollback-error">
                    {rollbackError}
                  </Paragraph>
                ) : null}
                <div className="mt-3">
                  <Button
                    variant="default"
                    size="sm"
                    data-testid="approval-configs-history-close"
                    onClick={() => {
                      setHistoryId(null);
                    }}
                  >
                    Close
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
