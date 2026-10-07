// The custom fields page (#222 config face) — the configuration studio's
// field half: one definition per (subject type, key) adds a column to every
// form of that object type without a line of code.
//
// The page's rulings, kept visible in words:
//
// 1. The subject and the key are identity — they never change after
//    creation, and a taken key is never reused. A replacement is a NEW key.
// 2. An edit lands for everyone under a new ledger version; values already
//    written keep the JSON they were written with — changing a field's type
//    never rewrites them.
// 3. A deactivated field disappears from forms and stops taking values; its
//    definition, its values and its history stay.
// 4. An empty role list means no restriction — everyone who can see the
//    record sees (and may edit) the field; an editor must also be able to
//    see it (the server refuses a write it cannot read).
//
// Every state says itself in words — loading, no permission, an unreachable
// API, an empty table, and every write failure mode (see
// custom-fields-client.ts for the reason catalog).
import type { ReactElement } from "react";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card, Heading, Input, Paragraph } from "@ally/ui";

import {
  createCustomFieldsAdapters,
  FIELD_ROLES,
  FIELD_TYPES,
  type CreateFieldFailure,
  type CustomFieldRow,
  type FieldType,
  type FieldRole,
  type RollbackFailure,
  type UpdateFieldFailure,
} from "../lib/custom-fields-client.ts";

const customFieldsAdapters = createCustomFieldsAdapters();

const TYPE_LABELS: Record<FieldType, string> = {
  text: "Text",
  number: "Number",
  boolean: "Checkbox (yes/no)",
  date: "Date",
  select: "Dropdown (options)",
};

const CREATE_ERRORS: Record<Exclude<CreateFieldFailure, "unavailable">, string> = {
  forbidden: "Your account does not have permission to manage custom fields.",
  exists:
    "That key is already taken for this subject type — keys are never reused. Deactivate the old field or create a new key.",
  invalid_options:
    "The options were rejected — a dropdown needs a non-empty list of unique options; other field types take none.",
  invalid: "The field was rejected — check the fields and try again.",
};

const EDIT_ERRORS: Record<Exclude<UpdateFieldFailure, "unavailable">, string> = {
  forbidden: "Your account does not have permission to manage custom fields.",
  not_found: "This field no longer exists — reload the page.",
  invalid_options:
    "The options were rejected — a dropdown needs a non-empty list of unique options; other field types take none.",
  invalid: "The change was rejected — check the fields and try again.",
};

const ROLLBACK_ERRORS: Record<Exclude<RollbackFailure, "unavailable">, string> = {
  forbidden:
    "The server refused the rollback — managing custom fields requires the custom fields permission.",
  not_found: "That version is not in this field's history.",
  no_change: "That version already matches the current definition — nothing to roll back.",
  unsupported: "This field's family does not support rollback.",
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

function changeSummary(changes: Record<string, { from: unknown; to: unknown }> | null): string {
  if (changes === null) return "created";
  return Object.keys(changes).join(", ");
}

/** One options-per-line textarea's content parsed into the API's string list
 *  (trimmed, empties dropped) — null when the field type takes no options. */
function parseOptions(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/** The role checklist shared by the create and edit forms — every role is
 *  offered, customer included: unlike approvers, a field may be visible to
 *  (or editable by) the customer. `data-testid` is `${idPrefix}-${group}-${role}`. */
function RoleChecklist(props: {
  idPrefix: string;
  group: "viewable" | "editable";
  selected: FieldRole[];
  onToggle: (role: FieldRole) => void;
}): ReactElement {
  return (
    <div className="grid grid-cols-2 gap-1 sm:grid-cols-3">
      {FIELD_ROLES.map((role) => (
        <label key={role} className="flex cursor-pointer items-center gap-2 text-ui-sm text-ink">
          <input
            type="checkbox"
            className="size-4 accent-[var(--accent)]"
            data-testid={`${props.idPrefix}-${props.group}-${role}`}
            checked={props.selected.includes(role)}
            onChange={() => {
              props.onToggle(role);
            }}
          />
          {role}
        </label>
      ))}
    </div>
  );
}

/** The create form's draft — inputs are strings/checkbox state until submit
 *  validates them; the server is the authority, this check only keeps
 *  obviously-broken submits from making the round trip. */
interface CreateDraft {
  subjectType: string;
  fieldKey: string;
  label: string;
  fieldType: FieldType;
  optionsText: string;
  required: boolean;
  viewableBy: FieldRole[];
  editableBy: FieldRole[];
}

const EMPTY_CREATE: CreateDraft = {
  subjectType: "",
  fieldKey: "",
  label: "",
  fieldType: "text",
  optionsText: "",
  required: false,
  viewableBy: [],
  editableBy: [],
};

interface EditDraft {
  label: string;
  fieldType: FieldType;
  optionsText: string;
  required: boolean;
  viewableBy: FieldRole[];
  editableBy: FieldRole[];
  active: boolean;
}

function editDraftOf(field: CustomFieldRow): EditDraft {
  return {
    label: field.label,
    fieldType: field.fieldType,
    optionsText: (field.options ?? []).join("\n"),
    required: field.required,
    viewableBy: field.viewableBy.filter((role): role is FieldRole =>
      (FIELD_ROLES as readonly string[]).includes(role),
    ),
    editableBy: field.editableBy.filter((role): role is FieldRole =>
      (FIELD_ROLES as readonly string[]).includes(role),
    ),
    active: field.active,
  };
}

function toggleRole(selected: FieldRole[], role: FieldRole): FieldRole[] {
  return selected.includes(role) ? selected.filter((entry) => entry !== role) : [...selected, role];
}

export function CustomFields(): ReactElement {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [createDraft, setCreateDraft] = useState<CreateDraft>(EMPTY_CREATE);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createBusy, setCreateBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<EditDraft | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [editBusy, setEditBusy] = useState(false);
  const [historyId, setHistoryId] = useState<string | null>(null);
  const [rollbackVersion, setRollbackVersion] = useState("");
  const [rollbackReason, setRollbackReason] = useState("");
  const [rollbackError, setRollbackError] = useState<string | null>(null);
  const [rollbackBusy, setRollbackBusy] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [filterSubject, setFilterSubject] = useState("all");
  const [filterStatus, setFilterStatus] = useState<"all" | "active" | "inactive">("all");
  const [filterText, setFilterText] = useState("");

  const fieldsQuery = useQuery({
    queryKey: ["custom-fields"],
    queryFn: () => customFieldsAdapters.list(),
  });
  const historyQuery = useQuery({
    queryKey: ["custom-fields-history", historyId],
    queryFn: () => customFieldsAdapters.history(historyId ?? ""),
    enabled: historyId !== null,
  });

  const fields = fieldsQuery.data?.ok ? fieldsQuery.data.data : undefined;
  const forbidden = fieldsQuery.data?.ok === false && fieldsQuery.data.reason === "forbidden";
  const unavailable =
    (fieldsQuery.data?.ok === false && fieldsQuery.data.reason === "unavailable") ||
    fields === undefined;
  const revisions = historyQuery.data?.ok ? historyQuery.data.data : undefined;

  const subjectTypes = [...new Set((fields ?? []).map((field) => field.subjectType))].sort();
  const visibleFields = (fields ?? []).filter((field) => {
    if (filterSubject !== "all" && field.subjectType !== filterSubject) return false;
    if (filterStatus === "active" && !field.active) return false;
    if (filterStatus === "inactive" && field.active) return false;
    if (filterText.trim() !== "") {
      const needle = filterText.trim().toLowerCase();
      const haystack = `${field.fieldKey} ${field.label}`.toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });

  function refresh(): void {
    void queryClient.invalidateQueries({ queryKey: ["custom-fields"] });
    void queryClient.invalidateQueries({ queryKey: ["custom-fields-history"] });
  }

  function openCreate(): void {
    setFlash(null);
    setCreateError(null);
    setCreateDraft(EMPTY_CREATE);
    setCreateOpen(true);
  }

  async function submitCreate(): Promise<void> {
    const subjectType = createDraft.subjectType.trim();
    const fieldKey = createDraft.fieldKey.trim();
    if (subjectType === "" || !/^[a-z][a-z0-9_]*$/.test(fieldKey) || createDraft.label.trim() === "") {
      setCreateError(
        "Subject type and label are required; the key must be lower_snake_case (letters, digits, underscores).",
      );
      return;
    }
    if (createDraft.fieldType === "select" && parseOptions(createDraft.optionsText).length === 0) {
      setCreateError("A dropdown field needs at least one option — one option per line.");
      return;
    }
    setCreateBusy(true);
    setCreateError(null);
    const result = await customFieldsAdapters.create({
      subjectType,
      fieldKey,
      label: createDraft.label.trim(),
      fieldType: createDraft.fieldType,
      ...(createDraft.fieldType === "select" ? { options: parseOptions(createDraft.optionsText) } : {}),
      required: createDraft.required,
      viewableBy: createDraft.viewableBy,
      editableBy: createDraft.editableBy,
    });
    setCreateBusy(false);
    if (!result.ok) {
      setCreateError(failureMessage(CREATE_ERRORS, result.reason));
      return;
    }
    setCreateOpen(false);
    setFlash("Field created — every form of that subject type now carries it.");
    refresh();
  }

  function openEdit(field: CustomFieldRow): void {
    setFlash(null);
    setEditError(null);
    setEditingId(field.id);
    setEditDraft(editDraftOf(field));
  }

  async function submitEdit(): Promise<void> {
    if (editDraft === null || editingId === null) return;
    if (editDraft.label.trim() === "") {
      setEditError("Label is required.");
      return;
    }
    if (editDraft.fieldType === "select" && parseOptions(editDraft.optionsText).length === 0) {
      setEditError("A dropdown field needs at least one option — one option per line.");
      return;
    }
    setEditBusy(true);
    setEditError(null);
    const result = await customFieldsAdapters.update(editingId, {
      label: editDraft.label.trim(),
      fieldType: editDraft.fieldType,
      options:
        editDraft.fieldType === "select" ? parseOptions(editDraft.optionsText) : null,
      required: editDraft.required,
      viewableBy: editDraft.viewableBy,
      editableBy: editDraft.editableBy,
      active: editDraft.active,
    });
    setEditBusy(false);
    if (!result.ok) {
      setEditError(failureMessage(EDIT_ERRORS, result.reason));
      return;
    }
    setEditingId(null);
    setEditDraft(null);
    setFlash(
      "Saved under a new version — values already written keep the JSON they were written with.",
    );
    refresh();
  }

  function openHistory(field: CustomFieldRow): void {
    setFlash(null);
    setRollbackError(null);
    setRollbackVersion("");
    setRollbackReason("");
    setHistoryId(field.id);
  }

  async function submitRollback(): Promise<void> {
    const field = fields?.find((entry) => entry.id === historyId);
    if (field === undefined || rollbackVersion === "") return;
    const reason = rollbackReason.trim();
    setRollbackBusy(true);
    setRollbackError(null);
    const result = await customFieldsAdapters.rollback(
      field.id,
      Number(rollbackVersion),
      reason !== "" ? reason : undefined,
    );
    setRollbackBusy(false);
    if (!result.ok) {
      setRollbackError(failureMessage(ROLLBACK_ERRORS, result.reason));
      return;
    }
    setHistoryId(null);
    setFlash(
      `Rolled back — version ${result.data.restoredVersion} is now version ${result.data.newVersion}; the history is never rewritten.`,
    );
    refresh();
  }

  const editTarget = fields?.find((field) => field.id === editingId) ?? null;
  const historyTarget = fields?.find((field) => field.id === historyId) ?? null;

  return (
    <div className="w-full" data-page="custom-fields" data-testid="custom-fields-root">
      <Card>
        <Heading as="h2">Custom fields</Heading>
        <Paragraph className="text-ink-soft">
          One definition per subject type and key adds a field to every form of
          that object — no code, one entry in the version ledger per change.
          The subject and the key are identity: they never change after
          creation, and a taken key is never reused. An edit lands for everyone
          under a new version; values already written keep the JSON they were
          written with. A deactivated field disappears from forms and stops
          taking values; its definition and history stay. An empty role list
          means no restriction — everyone who can see the record sees (and may
          edit) the field.
        </Paragraph>

        {flash !== null ? (
          <Paragraph className="mt-3 text-ink" data-testid="custom-fields-flash">
            {flash}
          </Paragraph>
        ) : null}

        {fieldsQuery.isPending ? (
          <Paragraph className="mt-3" data-testid="custom-fields-loading">
            Loading…
          </Paragraph>
        ) : forbidden ? (
          <Paragraph className="mt-3 text-ink-soft" data-testid="custom-fields-forbidden">
            Your account does not have permission to manage custom fields. Ask
            an administrator for the custom fields permission.
          </Paragraph>
        ) : unavailable ? (
          <Paragraph className="mt-3 text-ink-soft" data-testid="custom-fields-unavailable">
            The custom fields could not be loaded.
          </Paragraph>
        ) : (
          <>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button variant="primary" size="sm" data-testid="custom-fields-new" onClick={openCreate}>
                New field
              </Button>
              <select
                className="rounded-control border border-line bg-card p-[var(--pad-control)] text-ui text-ink"
                data-testid="custom-fields-filter-subject"
                value={filterSubject}
                onChange={(e) => {
                  setFilterSubject(e.target.value);
                }}
              >
                <option value="all">All subject types</option>
                {subjectTypes.map((subject) => (
                  <option key={subject} value={subject}>
                    {subject}
                  </option>
                ))}
              </select>
              <select
                className="rounded-control border border-line bg-card p-[var(--pad-control)] text-ui text-ink"
                data-testid="custom-fields-filter-status"
                value={filterStatus}
                onChange={(e) => {
                  setFilterStatus(e.target.value as typeof filterStatus);
                }}
              >
                <option value="all">Active and deactivated</option>
                <option value="active">Active only</option>
                <option value="inactive">Deactivated only</option>
              </select>
              <Input
                className="w-48"
                placeholder="Search key or label…"
                data-testid="custom-fields-filter-text"
                value={filterText}
                onChange={(e) => {
                  setFilterText(e.target.value);
                }}
              />
            </div>

            {createOpen ? (
              <div className="mt-3 rounded-card border border-line p-4" data-testid="custom-fields-create-form">
                <Heading as="h3">New field</Heading>
                <Paragraph className="mt-1 text-ui-sm text-ink-soft">
                  The subject type and the key are permanent — they are how
                  every form, report and automation rule will refer to this
                  field.
                </Paragraph>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <label className="text-ui-sm text-ink">
                    Subject type (lower_snake_case)
                    <Input
                      className="mt-1 block w-full font-mono"
                      data-testid="custom-fields-create-subject"
                      list="custom-fields-subject-options"
                      value={createDraft.subjectType}
                      onChange={(e) => {
                        setCreateDraft({ ...createDraft, subjectType: e.target.value });
                      }}
                    />
                    <datalist id="custom-fields-subject-options">
                      {["task", ...subjectTypes.filter((subject) => subject !== "task")].map(
                        (subject) => (
                          <option key={subject} value={subject} />
                        ),
                      )}
                    </datalist>
                  </label>
                  <label className="text-ui-sm text-ink">
                    Key (lower_snake_case, permanent)
                    <Input
                      className="mt-1 block w-full font-mono"
                      data-testid="custom-fields-create-key"
                      value={createDraft.fieldKey}
                      onChange={(e) => {
                        setCreateDraft({ ...createDraft, fieldKey: e.target.value });
                      }}
                    />
                  </label>
                  <label className="text-ui-sm text-ink">
                    Label
                    <Input
                      className="mt-1 block w-full"
                      data-testid="custom-fields-create-label"
                      value={createDraft.label}
                      onChange={(e) => {
                        setCreateDraft({ ...createDraft, label: e.target.value });
                      }}
                    />
                  </label>
                  <label className="text-ui-sm text-ink">
                    Field type
                    <select
                      className="mt-1 block w-full rounded-control border border-line bg-card p-[var(--pad-control)] text-ui text-ink"
                      data-testid="custom-fields-create-type"
                      value={createDraft.fieldType}
                      onChange={(e) => {
                        setCreateDraft({
                          ...createDraft,
                          fieldType: e.target.value as FieldType,
                        });
                      }}
                    >
                      {FIELD_TYPES.map((type) => (
                        <option key={type} value={type}>
                          {TYPE_LABELS[type]}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                {createDraft.fieldType === "select" ? (
                  <label className="mt-3 block text-ui-sm text-ink">
                    Options — one per line
                    <textarea
                      className="mt-1 block w-full rounded-control border border-line bg-card p-[var(--pad-control)] font-mono text-ui text-ink"
                      rows={4}
                      data-testid="custom-fields-create-options"
                      value={createDraft.optionsText}
                      onChange={(e) => {
                        setCreateDraft({ ...createDraft, optionsText: e.target.value });
                      }}
                    />
                  </label>
                ) : null}
                <label className="mt-3 flex cursor-pointer items-center gap-2 text-ui-sm text-ink">
                  <input
                    type="checkbox"
                    className="size-4 accent-[var(--accent)]"
                    data-testid="custom-fields-create-required"
                    checked={createDraft.required}
                    onChange={(e) => {
                      setCreateDraft({ ...createDraft, required: e.target.checked });
                    }}
                  />
                  Required — submissions without it are rejected (for roles that can see the field)
                </label>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <div>
                    <Paragraph className="text-ui-sm text-ink">
                      Visible to (empty = everyone who sees the record)
                    </Paragraph>
                    <RoleChecklist
                      idPrefix="custom-fields-create"
                      group="viewable"
                      selected={createDraft.viewableBy}
                      onToggle={(role) => {
                        setCreateDraft({
                          ...createDraft,
                          viewableBy: toggleRole(createDraft.viewableBy, role),
                        });
                      }}
                    />
                  </div>
                  <div>
                    <Paragraph className="text-ui-sm text-ink">
                      Editable by (empty = everyone who sees the record)
                    </Paragraph>
                    <RoleChecklist
                      idPrefix="custom-fields-create"
                      group="editable"
                      selected={createDraft.editableBy}
                      onToggle={(role) => {
                        setCreateDraft({
                          ...createDraft,
                          editableBy: toggleRole(createDraft.editableBy, role),
                        });
                      }}
                    />
                  </div>
                </div>
                {createError !== null ? (
                  <Paragraph className="mt-2 text-err font-medium" data-testid="custom-fields-create-error">
                    {createError}
                  </Paragraph>
                ) : null}
                <div className="mt-3 flex gap-2">
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={createBusy}
                    data-testid="custom-fields-create-submit"
                    onClick={() => {
                      void submitCreate();
                    }}
                  >
                    {createBusy ? "Creating…" : "Create field"}
                  </Button>
                  <Button
                    variant="default"
                    size="sm"
                    disabled={createBusy}
                    data-testid="custom-fields-create-cancel"
                    onClick={() => {
                      setCreateOpen(false);
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : null}

            {fields.length === 0 ? (
              <Paragraph className="mt-3 text-ink-soft" data-testid="custom-fields-empty">
                No custom fields yet. Create the first field to extend a form
                without a line of code.
              </Paragraph>
            ) : visibleFields.length === 0 ? (
              <Paragraph className="mt-3 text-ink-soft" data-testid="custom-fields-filter-empty">
                No field matches these filters.
              </Paragraph>
            ) : (
              <div className="mt-3 overflow-x-auto" data-testid="custom-fields-table">
                <table className="w-full border-collapse text-left text-ui-sm">
                  <thead>
                    <tr className="border-b border-line">
                      <th className="py-2 pr-4 font-mono text-[length:var(--fs-meta)] font-medium tracking-[var(--ls-crumb)] text-ink-soft uppercase">Subject</th>
                      <th className="py-2 pr-4 font-mono text-[length:var(--fs-meta)] font-medium tracking-[var(--ls-crumb)] text-ink-soft uppercase">Key</th>
                      <th className="py-2 pr-4 font-mono text-[length:var(--fs-meta)] font-medium tracking-[var(--ls-crumb)] text-ink-soft uppercase">Label</th>
                      <th className="py-2 pr-4 font-mono text-[length:var(--fs-meta)] font-medium tracking-[var(--ls-crumb)] text-ink-soft uppercase">Type</th>
                      <th className="py-2 pr-4 font-mono text-[length:var(--fs-meta)] font-medium tracking-[var(--ls-crumb)] text-ink-soft uppercase">Access</th>
                      <th className="py-2 pr-4 font-mono text-[length:var(--fs-meta)] font-medium tracking-[var(--ls-crumb)] text-ink-soft uppercase">Status</th>
                      <th className="py-2 pr-4 font-mono text-[length:var(--fs-meta)] font-medium tracking-[var(--ls-crumb)] text-ink-soft uppercase">Version</th>
                      <th className="py-2 font-mono text-[length:var(--fs-meta)] font-medium tracking-[var(--ls-crumb)] text-ink-soft uppercase"> </th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleFields.map((field) => (
                      <tr key={field.id} className="border-b border-line align-top" data-testid="custom-fields-row">
                        <td className="py-2 pr-4 font-mono">{field.subjectType}</td>
                        <td className="py-2 pr-4 font-mono">{field.fieldKey}</td>
                        <td className="py-2 pr-4">{field.label}</td>
                        <td className="py-2 pr-4">
                          {TYPE_LABELS[field.fieldType]}
                          {field.fieldType === "select" && field.options !== null ? (
                            <span className="block text-ink-soft">{field.options.join(", ")}</span>
                          ) : null}
                        </td>
                        <td className="py-2 pr-4 text-ink-soft">
                          {field.required ? <span className="block">required</span> : null}
                          <span className="block">
                            {field.viewableBy.length === 0 ? "visible to all" : `visible: ${field.viewableBy.join(", ")}`}
                          </span>
                          <span className="block">
                            {field.editableBy.length === 0 ? "editable by all" : `editable: ${field.editableBy.join(", ")}`}
                          </span>
                        </td>
                        <td className="py-2 pr-4">
                          {field.active ? (
                            <span className="font-medium text-brand" data-testid="custom-fields-row-active">Active</span>
                          ) : (
                            <span className="text-ink-soft" data-testid="custom-fields-row-inactive">Deactivated</span>
                          )}
                        </td>
                        <td className="py-2 pr-4 font-mono text-ink-soft">v{field.version}</td>
                        <td className="py-2">
                          <div className="flex gap-2">
                            <Button
                              variant="default"
                              size="sm"
                              data-testid="custom-fields-row-edit"
                              onClick={() => {
                                openEdit(field);
                              }}
                            >
                              Edit
                            </Button>
                            <Button
                              variant="default"
                              size="sm"
                              data-testid="custom-fields-row-history"
                              onClick={() => {
                                openHistory(field);
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

            {editTarget !== null && editDraft !== null ? (
              <div className="mt-3 rounded-card border border-line p-4" data-testid="custom-fields-edit-form">
                <Heading as="h3">
                  Edit field — <span className="font-mono">{editTarget.subjectType}.{editTarget.fieldKey}</span>
                </Heading>
                <Paragraph className="mt-1 text-ui-sm text-ink-soft">
                  The key is permanent. Saving lands as a new version for
                  everyone; values already written keep the JSON they were
                  written with — changing the type never rewrites them.
                </Paragraph>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <label className="text-ui-sm text-ink">
                    Label
                    <Input
                      className="mt-1 block w-full"
                      data-testid="custom-fields-edit-label"
                      value={editDraft.label}
                      onChange={(e) => {
                        setEditDraft({ ...editDraft, label: e.target.value });
                      }}
                    />
                  </label>
                  <label className="text-ui-sm text-ink">
                    Field type
                    <select
                      className="mt-1 block w-full rounded-control border border-line bg-card p-[var(--pad-control)] text-ui text-ink"
                      data-testid="custom-fields-edit-type"
                      value={editDraft.fieldType}
                      onChange={(e) => {
                        setEditDraft({ ...editDraft, fieldType: e.target.value as FieldType });
                      }}
                    >
                      {FIELD_TYPES.map((type) => (
                        <option key={type} value={type}>
                          {TYPE_LABELS[type]}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                {editDraft.fieldType === "select" ? (
                  <label className="mt-3 block text-ui-sm text-ink">
                    Options — one per line
                    <textarea
                      className="mt-1 block w-full rounded-control border border-line bg-card p-[var(--pad-control)] font-mono text-ui text-ink"
                      rows={4}
                      data-testid="custom-fields-edit-options"
                      value={editDraft.optionsText}
                      onChange={(e) => {
                        setEditDraft({ ...editDraft, optionsText: e.target.value });
                      }}
                    />
                  </label>
                ) : null}
                <label className="mt-3 flex cursor-pointer items-center gap-2 text-ui-sm text-ink">
                  <input
                    type="checkbox"
                    className="size-4 accent-[var(--accent)]"
                    data-testid="custom-fields-edit-required"
                    checked={editDraft.required}
                    onChange={(e) => {
                      setEditDraft({ ...editDraft, required: e.target.checked });
                    }}
                  />
                  Required — submissions without it are rejected (for roles that can see the field)
                </label>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <div>
                    <Paragraph className="text-ui-sm text-ink">
                      Visible to (empty = everyone who sees the record)
                    </Paragraph>
                    <RoleChecklist
                      idPrefix="custom-fields-edit"
                      group="viewable"
                      selected={editDraft.viewableBy}
                      onToggle={(role) => {
                        setEditDraft({
                          ...editDraft,
                          viewableBy: toggleRole(editDraft.viewableBy, role),
                        });
                      }}
                    />
                  </div>
                  <div>
                    <Paragraph className="text-ui-sm text-ink">
                      Editable by (empty = everyone who sees the record)
                    </Paragraph>
                    <RoleChecklist
                      idPrefix="custom-fields-edit"
                      group="editable"
                      selected={editDraft.editableBy}
                      onToggle={(role) => {
                        setEditDraft({
                          ...editDraft,
                          editableBy: toggleRole(editDraft.editableBy, role),
                        });
                      }}
                    />
                  </div>
                </div>
                <label className="mt-3 flex cursor-pointer items-center gap-2 text-ui-sm text-ink">
                  <input
                    type="checkbox"
                    className="size-4 accent-[var(--accent)]"
                    data-testid="custom-fields-edit-active"
                    checked={editDraft.active}
                    onChange={(e) => {
                      setEditDraft({ ...editDraft, active: e.target.checked });
                    }}
                  />
                  Active — a deactivated field disappears from forms and stops taking values
                </label>
                {editError !== null ? (
                  <Paragraph className="mt-2 text-err font-medium" data-testid="custom-fields-edit-error">
                    {editError}
                  </Paragraph>
                ) : null}
                <div className="mt-3 flex gap-2">
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={editBusy}
                    data-testid="custom-fields-edit-submit"
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
                    data-testid="custom-fields-edit-cancel"
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

            {historyTarget !== null ? (
              <div className="mt-3 rounded-card border border-line p-4" data-testid="custom-fields-history-panel">
                <Heading as="h3">
                  History — <span className="font-mono">{historyTarget.subjectType}.{historyTarget.fieldKey}</span>
                </Heading>
                {historyQuery.isPending ? (
                  <Paragraph className="mt-2 text-ink-soft">Loading history…</Paragraph>
                ) : revisions === undefined ? (
                  <Paragraph className="mt-2 text-ink-soft">The history could not be loaded.</Paragraph>
                ) : (
                  <table className="mt-2 w-full border-collapse text-left text-ui-sm">
                    <thead>
                      <tr className="border-b border-line">
                        <th className="py-1 pr-4 font-mono text-[length:var(--fs-meta)] uppercase text-ink-soft">Version</th>
                        <th className="py-1 pr-4 font-mono text-[length:var(--fs-meta)] uppercase text-ink-soft">Source</th>
                        <th className="py-1 pr-4 font-mono text-[length:var(--fs-meta)] uppercase text-ink-soft">Changed</th>
                        <th className="py-1 font-mono text-[length:var(--fs-meta)] uppercase text-ink-soft">When</th>
                      </tr>
                    </thead>
                    <tbody>
                      {revisions.map((revision) => (
                        <tr key={revision.version} className="border-b border-line" data-testid="custom-fields-history-row">
                          <td className="py-1 pr-4 font-mono">v{revision.version}</td>
                          <td className="py-1 pr-4">{revision.source}</td>
                          <td className="py-1 pr-4 font-mono text-ink-soft">{changeSummary(revision.changes)}</td>
                          <td className="py-1 whitespace-nowrap text-ink-soft">{formatDateTime(revision.createdAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                <Paragraph className="mt-2 text-ui-sm text-ink-soft">
                  A rollback restores the chosen version's definition as a NEW
                  version — the history is never rewritten.
                </Paragraph>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Input
                    className="w-24"
                    type="number"
                    min={1}
                    placeholder="Version"
                    data-testid="custom-fields-rollback-version"
                    value={rollbackVersion}
                    onChange={(e) => {
                      setRollbackVersion(e.target.value);
                    }}
                  />
                  <Input
                    className="w-64"
                    placeholder="Reason (optional)"
                    data-testid="custom-fields-rollback-reason"
                    value={rollbackReason}
                    onChange={(e) => {
                      setRollbackReason(e.target.value);
                    }}
                  />
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={rollbackBusy}
                    data-testid="custom-fields-rollback-submit"
                    onClick={() => {
                      void submitRollback();
                    }}
                  >
                    {rollbackBusy ? "Rolling back…" : "Roll back"}
                  </Button>
                </div>
                {rollbackError !== null ? (
                  <Paragraph className="mt-2 text-err font-medium" data-testid="custom-fields-rollback-error">
                    {rollbackError}
                  </Paragraph>
                ) : null}
              </div>
            ) : null}
          </>
        )}
      </Card>
    </div>
  );
}
