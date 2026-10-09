// The content templates page (#225 template config face) — the
// configuration studio's template half: per (channel, template type) wording
// that overrides the platform's builtin copy the moment it is saved.
//
// The page's rulings, kept visible up front: there is NO delete — deactivating
// a template sends every consumer back to the builtin wording, reversibly,
// with the version history on record. Content edits mint a new immutable
// version; restoring an old version creates a new version (history is never
// rewritten). Placeholders are {{name}}; a variable with no value goes out
// as-is, and the preview reports which would — a visible defect beats a
// silently emptied email.
//
// The known-types hints (which emails consume password_reset, which variables
// resolveAuthEmail injects) are documentation, not validation: template types
// are an open set, the server stays the sole authority, and an unknown type is
// configured exactly like a known one.
//
// States are honest, never blank-by-accident — loading, no templates
// permission, an unreachable API, an empty table, and every write failure
// mode all say themselves in words (the adapter reports the failure mode —
// see templates-client.ts).
import type { ReactElement } from "react";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card, Heading, Paragraph } from "@ally/ui";

import {
  channelWantsSubject,
  createTemplatesAdapters,
  KNOWN_TEMPLATE_TYPES,
  sampleVariableValue,
  templateTypeLabel,
  type CreateTemplateFailure,
  type CreateTemplateInput,
  type RollbackTemplateFailure,
  type TemplateChannelOption,
  type TemplatePreview,
  type TemplateRow,
  type TemplateVersion,
  type UpdateTemplateFailure,
} from "../lib/templates-client.ts";

const templatesAdapters = createTemplatesAdapters();

const CREATE_ERRORS: Record<Exclude<CreateTemplateFailure, "unavailable">, string> = {
  forbidden: "Your account does not have permission to manage content templates.",
  unknown_channel: "That channel is no longer open for templates.",
  subject_required: "This channel's templates need a subject line.",
  subject_not_allowed: "This channel's templates have no subject line — clear it and save again.",
  exists: "A template for this channel and type already exists — edit that one instead.",
  invalid: "The template was rejected — check the fields and try again.",
};

const EDIT_ERRORS: Record<Exclude<UpdateTemplateFailure, "unavailable">, string> = {
  forbidden: "Your account does not have permission to manage content templates.",
  not_found: "This template no longer exists — someone may have just created it anew.",
  subject_required: "This channel's templates need a subject line.",
  subject_not_allowed: "This channel's templates have no subject line — clear it and save again.",
  invalid: "The change was rejected — check the fields and try again.",
};

const RESTORE_ERRORS: Record<Exclude<RollbackTemplateFailure, "unavailable">, string> = {
  forbidden: "Your account does not have permission to manage content templates.",
  not_found: "This template no longer exists.",
  version_not_found: "That version is no longer in the history — reload and pick again.",
  invalid: "The restore was rejected — pick a version from the list.",
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

const TYPE_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/;

/** The create form's draft — inputs are strings until submit validates them;
 *  the server is the authority, this check only keeps obviously-broken
 *  submits from making the round trip. */
interface CreateDraft {
  channel: string;
  templateType: string;
  subject: string;
  body: string;
}

const EMPTY_CREATE: CreateDraft = { channel: "", templateType: "", subject: "", body: "" };

interface EditDraft {
  subject: string;
  body: string;
  active: boolean;
}

/** The preview panel — one authority, the server's /preview endpoint. The
 *  first render fills sample values for every variable the template
 *  references (known ones get human words, unknown ones start empty) and
 *  immediately renders again, so what is shown was rendered with the values
 *  shown. Missing variables are reported, never hidden: that is exactly what
 *  a send would put in the letter. */
function PreviewPanel(props: {
  subjectTemplate: string | null;
  bodyTemplate: string;
  testPrefix: string;
}): ReactElement {
  const [vars, setVars] = useState<Record<string, string>>({});
  const [result, setResult] = useState<TemplatePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready = props.bodyTemplate.trim() !== "";

  async function run(): Promise<void> {
    if (!ready) return;
    setBusy(true);
    setError(null);
    const first = await templatesAdapters.preview({
      subjectTemplate: props.subjectTemplate,
      bodyTemplate: props.bodyTemplate,
      vars,
    });
    if (!first.ok) {
      setBusy(false);
      setError("The preview could not be rendered — check the fields and try again.");
      return;
    }
    const filled = { ...vars };
    let added = false;
    for (const name of first.data.referencedVariables) {
      if (filled[name] === undefined) {
        filled[name] = sampleVariableValue(name);
        added = true;
      }
    }
    if (added) {
      // second pass so the rendered text reflects the sample values in the inputs
      const second = await templatesAdapters.preview({
        subjectTemplate: props.subjectTemplate,
        bodyTemplate: props.bodyTemplate,
        vars: filled,
      });
      setVars(filled);
      setBusy(false);
      if (second.ok) {
        setResult(second.data);
        return;
      }
      setError("The preview could not be rendered — check the fields and try again.");
      return;
    }
    setVars(filled);
    setBusy(false);
    setResult(first.data);
  }

  return (
    <div className="mt-3 rounded-card border border-line p-4" data-testid={`${props.testPrefix}-preview`}>
      <div className="flex items-center justify-between gap-2">
        <Heading as="h3">Preview</Heading>
        <Button
          variant="default"
          size="sm"
          disabled={!ready || busy}
          data-testid={`${props.testPrefix}-preview-run`}
          onClick={() => {
            void run();
          }}
        >
          {busy ? "Rendering…" : "Render preview"}
        </Button>
      </div>
      <Paragraph className="mt-1 text-ui-sm text-ink-soft">
        Sample values stand in for the real ones — nothing is sent. A variable
        left empty renders as its placeholder, exactly as a send would.
      </Paragraph>
      {error !== null ? (
        <Paragraph className="mt-2 text-err font-medium" data-testid={`${props.testPrefix}-preview-error`}>
          {error}
        </Paragraph>
      ) : null}
      {result !== null ? (
        <>
          {result.referencedVariables.length > 0 ? (
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {result.referencedVariables.map((name) => (
                <label key={name} className="text-ui-sm text-ink">
                  <span className="font-mono">{`{{${name}}}`}</span>
                  <input
                    className="mt-1 block w-full rounded-control border border-line bg-card p-[var(--pad-control)] font-mono text-ui text-ink"
                    data-testid={`${props.testPrefix}-preview-var-${name}`}
                    value={vars[name] ?? ""}
                    onChange={(e) => {
                      setVars({ ...vars, [name]: e.target.value });
                    }}
                  />
                </label>
              ))}
            </div>
          ) : null}
          {result.missingVariables.length > 0 ? (
            <Paragraph className="mt-2 text-err font-medium" data-testid={`${props.testPrefix}-preview-missing`}>
              No sample value for {result.missingVariables.map((name) => `{{${name}}}`).join(", ")} —
              a send with these empty would carry the placeholders as-is.
            </Paragraph>
          ) : null}
          {result.subject !== null ? (
            <Paragraph className="mt-2 font-medium text-ink" data-testid={`${props.testPrefix}-preview-subject`}>
              Subject: {result.subject}
            </Paragraph>
          ) : null}
          <pre
            className="mt-2 max-h-64 overflow-auto rounded-control border border-line bg-card p-3 font-mono text-ui-sm whitespace-pre-wrap text-ink"
            data-testid={`${props.testPrefix}-preview-body`}
          >
            {result.body}
          </pre>
        </>
      ) : null}
    </div>
  );
}

/** The known-type hint — documentation at the point of editing, for the three
 *  authentication emails this system consumes today. */
function KnownTypeHint(props: { templateType: string; testPrefix: string }): ReactElement | null {
  const known = KNOWN_TEMPLATE_TYPES[props.templateType];
  if (known === undefined) return null;
  return (
    <Paragraph className="mt-2 text-ui-sm text-ink-soft" data-testid={`${props.testPrefix}-type-hint`}>
      {known.label} — goes out as {known.usedBy}. Variables:{" "}
      {known.variables.map((name) => `{{${name}}}`).join(" ")} (name and email are
      escaped in the HTML body; the link never is).
    </Paragraph>
  );
}

export function Templates(): ReactElement {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [createDraft, setCreateDraft] = useState<CreateDraft>(EMPTY_CREATE);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createBusy, setCreateBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTarget, setEditTarget] = useState<TemplateRow | null>(null);
  const [editDraft, setEditDraft] = useState<EditDraft | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [editBusy, setEditBusy] = useState(false);
  const [restoringVersion, setRestoringVersion] = useState<number | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const listQuery = useQuery({
    queryKey: ["templates"],
    queryFn: () => templatesAdapters.list(),
  });
  const detailQuery = useQuery({
    queryKey: ["template-detail", editingId],
    queryFn: () => templatesAdapters.detail(editingId ?? ""),
    enabled: editingId !== null,
  });

  const channels: TemplateChannelOption[] = listQuery.data?.ok ? listQuery.data.data.channels : [];
  const templates: TemplateRow[] = listQuery.data?.ok ? listQuery.data.data.templates : [];
  const forbidden = listQuery.data?.ok === false && listQuery.data.reason === "forbidden";
  const unavailable = listQuery.data?.ok === false && listQuery.data.reason === "unavailable";
  const versions: TemplateVersion[] = detailQuery.data?.ok ? detailQuery.data.data.versions : [];

  function refresh(): void {
    void queryClient.invalidateQueries({ queryKey: ["templates"] });
    void queryClient.invalidateQueries({ queryKey: ["template-detail"] });
  }

  function openCreate(): void {
    setFlash(null);
    setCreateError(null);
    setCreateDraft(EMPTY_CREATE);
    setCreateOpen(true);
  }

  function parseCreate(): CreateTemplateInput | null {
    const channel = createDraft.channel;
    const templateType = createDraft.templateType.trim();
    const wantsSubject = channelWantsSubject(channel);
    const subject = wantsSubject ? createDraft.subject.trim() : "";
    if (channel === "" || !TYPE_PATTERN.test(templateType)) return null;
    if (createDraft.body.trim() === "") return null;
    if (wantsSubject && subject === "") return null;
    return {
      channel,
      templateType,
      subjectTemplate: wantsSubject ? subject : null,
      bodyTemplate: createDraft.body,
    };
  }

  async function submitCreate(): Promise<void> {
    const parsed = parseCreate();
    if (parsed === null) {
      setCreateError(
        "Pick a channel, give a lowercase type identifier (letters, digits, dot, dash), and fill the body" +
          (channelWantsSubject(createDraft.channel) ? " and subject" : "") +
          ".",
      );
      return;
    }
    setCreateBusy(true);
    setCreateError(null);
    const result = await templatesAdapters.create(parsed);
    setCreateBusy(false);
    if (!result.ok) {
      setCreateError(failureMessage(CREATE_ERRORS, result.reason));
      return;
    }
    setCreateOpen(false);
    setFlash("Template created — its wording goes out as soon as it is active.");
    refresh();
  }

  function openEdit(row: TemplateRow): void {
    setFlash(null);
    setEditError(null);
    setEditingId(row.id);
    setEditTarget(row);
    setEditDraft({
      subject: row.subjectTemplate ?? "",
      body: row.bodyTemplate,
      active: row.isActive,
    });
  }

  function closeEdit(): void {
    setEditingId(null);
    setEditTarget(null);
    setEditDraft(null);
  }

  async function submitEdit(): Promise<void> {
    if (editDraft === null || editingId === null || editTarget === null) return;
    const wantsSubject = channelWantsSubject(editTarget.channel);
    const subject = wantsSubject ? editDraft.subject.trim() : "";
    if (editDraft.body.trim() === "" || (wantsSubject && subject === "")) {
      setEditError(
        wantsSubject
          ? "The body and the subject line are both required."
          : "The body is required.",
      );
      return;
    }
    setEditBusy(true);
    setEditError(null);
    const result = await templatesAdapters.update(editingId, {
      subjectTemplate: wantsSubject ? subject : null,
      bodyTemplate: editDraft.body,
      isActive: editDraft.active,
    });
    setEditBusy(false);
    if (!result.ok) {
      setEditError(failureMessage(EDIT_ERRORS, result.reason));
      return;
    }
    if (!result.data.updated) {
      setFlash("No changes to save — the template already says exactly this.");
    } else {
      setFlash(
        result.data.template.isActive
          ? `Saved — this template's wording goes out from the next send (now v${result.data.template.version}).`
          : "Saved — deactivated; consumers are back on the builtin wording.",
      );
    }
    setEditTarget(result.data.template);
    setEditDraft({
      subject: result.data.template.subjectTemplate ?? "",
      body: result.data.template.bodyTemplate,
      active: result.data.template.isActive,
    });
    refresh();
  }

  async function restore(version: number): Promise<void> {
    if (editingId === null) return;
    setRestoringVersion(version);
    setEditError(null);
    const result = await templatesAdapters.rollback(editingId, version);
    setRestoringVersion(null);
    if (!result.ok) {
      setEditError(failureMessage(RESTORE_ERRORS, result.reason));
      return;
    }
    setFlash(
      `Restored v${version} as v${result.data.template.version} — history is never rewritten; the restore is itself a version.`,
    );
    setEditTarget(result.data.template);
    setEditDraft({
      subject: result.data.template.subjectTemplate ?? "",
      body: result.data.template.bodyTemplate,
      active: result.data.template.isActive,
    });
    refresh();
  }

  return (
    <div className="w-full" data-page="templates" data-testid="templates-root">
      <Card>
        <Heading as="h2">Content templates</Heading>
        <Paragraph className="text-ink-soft">
          Templates override the builtin wording of platform emails — per channel
          and template type, no code changes. An active template takes over as
          soon as it is saved; deactivating it — there is no delete — sends
          consumers back to the builtin wording. Placeholders are written{" "}
          <span className="font-mono">{"{{name}}"}</span>; a variable with no
          value goes out as-is, and the preview shows which would.
        </Paragraph>

        {flash !== null ? (
          <Paragraph className="mt-3 text-ink" data-testid="templates-flash">
            {flash}
          </Paragraph>
        ) : null}

        {listQuery.isPending ? (
          <Paragraph className="mt-3" data-testid="templates-loading">
            Loading…
          </Paragraph>
        ) : forbidden ? (
          <Paragraph className="mt-3 text-ink-soft" data-testid="templates-forbidden">
            Your account does not have permission to manage content templates.
            Ask an administrator for the templates permission.
          </Paragraph>
        ) : unavailable ? (
          <Paragraph className="mt-3 text-ink-soft" data-testid="templates-unavailable">
            The templates could not be loaded.
          </Paragraph>
        ) : (
          <>
            <div className="mt-3">
              <Button variant="primary" size="sm" data-testid="templates-new" onClick={openCreate}>
                New template
              </Button>
            </div>

            {createOpen ? (
              <div className="mt-3 rounded-card border border-line p-4" data-testid="templates-create-form">
                <Heading as="h3">New template</Heading>
                <Paragraph className="mt-1 text-ui-sm text-ink-soft">
                  One template per (channel, type): creating a second copy of a
                  pair is refused — edit the existing one instead.
                </Paragraph>
                {channels.length === 0 ? (
                  <Paragraph className="mt-2 text-ink-soft" data-testid="templates-channels-empty">
                    No channels are open for templates yet — the list opens as
                    channel infrastructure arrives.
                  </Paragraph>
                ) : (
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <label className="text-ui-sm text-ink">
                      Channel
                      <select
                        className="mt-1 block w-full rounded-control border border-line bg-card p-[var(--pad-control)] text-ui text-ink"
                        data-testid="templates-create-channel"
                        value={createDraft.channel}
                        onChange={(e) => {
                          setCreateDraft({ ...createDraft, channel: e.target.value });
                        }}
                      >
                        <option value="">Choose a channel…</option>
                        {channels.map((entry) => (
                          <option key={entry.channel} value={entry.channel}>
                            {entry.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="text-ui-sm text-ink">
                      Template type
                      <input
                        className="mt-1 block w-full rounded-control border border-line bg-card p-[var(--pad-control)] font-mono text-ui text-ink"
                        data-testid="templates-create-type"
                        value={createDraft.templateType}
                        placeholder="e.g. password_reset"
                        onChange={(e) => {
                          setCreateDraft({ ...createDraft, templateType: e.target.value });
                        }}
                      />
                    </label>
                    {channelWantsSubject(createDraft.channel) ? (
                      <label className="text-ui-sm text-ink sm:col-span-2">
                        Subject
                        <input
                          className="mt-1 block w-full rounded-control border border-line bg-card p-[var(--pad-control)] text-ui text-ink"
                          data-testid="templates-create-subject"
                          value={createDraft.subject}
                          onChange={(e) => {
                            setCreateDraft({ ...createDraft, subject: e.target.value });
                          }}
                        />
                      </label>
                    ) : null}
                    <label className="text-ui-sm text-ink sm:col-span-2">
                      Body (HTML)
                      <textarea
                        className="mt-1 block w-full rounded-control border border-line bg-card p-[var(--pad-control)] font-mono text-ui text-ink"
                        rows={8}
                        spellCheck={false}
                        data-testid="templates-create-body"
                        value={createDraft.body}
                        onChange={(e) => {
                          setCreateDraft({ ...createDraft, body: e.target.value });
                        }}
                      />
                    </label>
                  </div>
                )}
                <KnownTypeHint templateType={createDraft.templateType.trim()} testPrefix="templates-create" />
                {createError !== null ? (
                  <Paragraph className="mt-2 text-err font-medium" data-testid="templates-create-error">
                    {createError}
                  </Paragraph>
                ) : null}
                {createDraft.channel !== "" && createDraft.body.trim() !== "" ? (
                  <PreviewPanel
                    subjectTemplate={
                      channelWantsSubject(createDraft.channel) && createDraft.subject.trim() !== ""
                        ? createDraft.subject.trim()
                        : null
                    }
                    bodyTemplate={createDraft.body}
                    testPrefix="templates-create"
                  />
                ) : null}
                <div className="mt-3 flex gap-2">
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={createBusy}
                    data-testid="templates-create-submit"
                    onClick={() => {
                      void submitCreate();
                    }}
                  >
                    {createBusy ? "Creating…" : "Create template"}
                  </Button>
                  <Button
                    variant="default"
                    size="sm"
                    disabled={createBusy}
                    data-testid="templates-create-cancel"
                    onClick={() => {
                      setCreateOpen(false);
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : null}

            {templates.length === 0 ? (
              <Paragraph className="mt-3 text-ink-soft" data-testid="templates-empty">
                No templates yet — the builtin wording is going out. Create a
                template to take over a message.
              </Paragraph>
            ) : (
              <div className="mt-3 overflow-x-auto" data-testid="templates-table">
                <table className="w-full border-collapse text-left text-ui-sm">
                  <thead>
                    <tr className="border-b border-line">
                      <th className="py-2 pr-4 font-mono text-[length:var(--fs-meta)] font-medium tracking-[var(--ls-crumb)] text-ink-soft uppercase">Channel</th>
                      <th className="py-2 pr-4 font-mono text-[length:var(--fs-meta)] font-medium tracking-[var(--ls-crumb)] text-ink-soft uppercase">Template type</th>
                      <th className="py-2 pr-4 font-mono text-[length:var(--fs-meta)] font-medium tracking-[var(--ls-crumb)] text-ink-soft uppercase">Status</th>
                      <th className="py-2 pr-4 font-mono text-[length:var(--fs-meta)] font-medium tracking-[var(--ls-crumb)] text-ink-soft uppercase">Version</th>
                      <th className="py-2 pr-4 font-mono text-[length:var(--fs-meta)] font-medium tracking-[var(--ls-crumb)] text-ink-soft uppercase">Updated</th>
                      <th className="py-2 font-mono text-[length:var(--fs-meta)] font-medium tracking-[var(--ls-crumb)] text-ink-soft uppercase"> </th>
                    </tr>
                  </thead>
                  <tbody>
                    {templates.map((row) => (
                      <tr key={row.id} className="border-b border-line align-top" data-testid="templates-row">
                        <td className="py-2 pr-4 font-mono">{row.channel}</td>
                        <td className="py-2 pr-4">
                          {templateTypeLabel(row.templateType)}
                          <span className="block font-mono text-ink-soft">{row.templateType}</span>
                        </td>
                        <td className="py-2 pr-4">
                          {row.isActive ? (
                            <span className="font-medium text-brand" data-testid="templates-row-active">Active</span>
                          ) : (
                            <span className="text-ink-soft" data-testid="templates-row-inactive">
                              Deactivated — builtin wording
                            </span>
                          )}
                        </td>
                        <td className="py-2 pr-4 font-mono">v{row.version}</td>
                        <td className="py-2 pr-4 whitespace-nowrap text-ink-soft">{formatDateTime(row.updatedAt)}</td>
                        <td className="py-2">
                          <Button
                            variant="default"
                            size="sm"
                            data-testid="templates-row-edit"
                            onClick={() => {
                              openEdit(row);
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
              <div className="mt-3 rounded-card border border-line p-4" data-testid="templates-edit-form">
                <Heading as="h3">
                  Edit template — {templateTypeLabel(editTarget.templateType)} ({editTarget.channel})
                </Heading>
                <Paragraph className="mt-1 text-ui-sm text-ink-soft">
                  Saving content mints a new version; while active, the new
                  wording goes out from the next send. Deactivating sends
                  consumers back to the builtin wording — the template and its
                  history stay on record.
                </Paragraph>
                {channelWantsSubject(editTarget.channel) ? (
                  <label className="mt-3 block text-ui-sm text-ink">
                    Subject
                    <input
                      className="mt-1 block w-full rounded-control border border-line bg-card p-[var(--pad-control)] text-ui text-ink"
                      data-testid="templates-edit-subject"
                      value={editDraft.subject}
                      onChange={(e) => {
                        setEditDraft({ ...editDraft, subject: e.target.value });
                      }}
                    />
                  </label>
                ) : null}
                <label className="mt-3 block text-ui-sm text-ink">
                  Body (HTML)
                  <textarea
                    className="mt-1 block w-full rounded-control border border-line bg-card p-[var(--pad-control)] font-mono text-ui text-ink"
                    rows={10}
                    spellCheck={false}
                    data-testid="templates-edit-body"
                    value={editDraft.body}
                    onChange={(e) => {
                      setEditDraft({ ...editDraft, body: e.target.value });
                    }}
                  />
                </label>
                <label className="mt-3 flex cursor-pointer items-center gap-2 text-ui-sm text-ink">
                  <input
                    type="checkbox"
                    className="size-4 accent-[var(--accent)]"
                    data-testid="templates-edit-active"
                    checked={editDraft.active}
                    onChange={(e) => {
                      setEditDraft({ ...editDraft, active: e.target.checked });
                    }}
                  />
                  Active — this wording goes out while checked; unchecking sends
                  consumers back to the builtin.
                </label>
                <KnownTypeHint templateType={editTarget.templateType} testPrefix="templates-edit" />
                {editError !== null ? (
                  <Paragraph className="mt-2 text-err font-medium" data-testid="templates-edit-error">
                    {editError}
                  </Paragraph>
                ) : null}
                <PreviewPanel
                  subjectTemplate={
                    channelWantsSubject(editTarget.channel) && editDraft.subject.trim() !== ""
                      ? editDraft.subject.trim()
                      : null
                  }
                  bodyTemplate={editDraft.body}
                  testPrefix="templates-edit"
                />
                <div className="mt-3 flex gap-2">
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={editBusy}
                    data-testid="templates-edit-submit"
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
                    data-testid="templates-edit-cancel"
                    onClick={closeEdit}
                  >
                    Cancel
                  </Button>
                </div>

                <div className="mt-4 border-t border-line pt-3">
                  <Heading as="h3">Version history</Heading>
                  <Paragraph className="mt-1 text-ui-sm text-ink-soft">
                    Every content change is a version; restoring an old one
                    creates a new version — history is never rewritten.
                  </Paragraph>
                  {detailQuery.isPending ? (
                    <Paragraph className="mt-2 text-ink-soft" data-testid="templates-versions-loading">
                      Loading history…
                    </Paragraph>
                  ) : detailQuery.data?.ok === false && detailQuery.data.reason === "not_found" ? (
                    <Paragraph className="mt-2 text-ink-soft" data-testid="templates-versions-gone">
                      This template no longer exists — close the editor.
                    </Paragraph>
                  ) : versions.length === 0 ? (
                    <Paragraph className="mt-2 text-ink-soft" data-testid="templates-versions-empty">
                      The history could not be loaded.
                    </Paragraph>
                  ) : (
                    <div className="mt-2" data-testid="templates-versions">
                      {versions.map((version) => (
                        <div
                          key={version.version}
                          className="flex items-center justify-between gap-2 border-b border-line py-2"
                          data-testid="templates-version-row"
                        >
                          <div>
                            <span className="font-mono text-ui-sm font-medium">v{version.version}</span>
                            <span className="ml-2 text-ui-sm text-ink-soft">
                              {version.subjectTemplate ?? "(no subject)"}
                            </span>
                            <span className="ml-2 whitespace-nowrap text-ui-sm text-ink-soft">
                              {formatDateTime(version.changedAt)}
                            </span>
                            {version.version === editTarget.version ? (
                              <span className="ml-2 font-medium text-brand" data-testid="templates-version-current">current</span>
                            ) : null}
                          </div>
                          {version.version !== editTarget.version ? (
                            <Button
                              variant="default"
                              size="sm"
                              disabled={restoringVersion !== null}
                              data-testid="templates-version-restore"
                              onClick={() => {
                                void restore(version.version);
                              }}
                            >
                              {restoringVersion === version.version ? "Restoring…" : "Restore"}
                            </Button>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ) : null}
          </>
        )}
      </Card>
    </div>
  );
}
