// The workflow templates page (#220 config face) — the configuration
// studio's flow half: one template per subject type (plus product-type
// variants) defines the states, the allowed transitions and who may take
// them, as an XState JSON definition the server validates through four gates
// at save time.
//
// The page's one rule to keep visible: a running instance keeps the
// definition it STARTED with. Editing a template never reaches into running
// flows — it changes only flows started from now on. The definition editor
// is JSON with a live diagram beside it: the diagram renders exactly what
// the server would store, and the server's four gates (shape, topology,
// reachability, block existence) are the authority — a client preview that
// renders is not a save that passes.
//
// States are honest, never blank-by-accident — loading, no workflow
// permission, an unreachable API, and an empty table all say themselves in
// words (the adapter reports the failure mode — see workflow-client.ts).
import { useMemo, useState } from "react";
import type { ReactElement } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card, Heading, Input, Paragraph } from "@ally/ui";

import { WorkflowDiagram } from "../components/WorkflowDiagram.tsx";
import {
  layoutWorkflowDiagram,
  parseWorkflowDefinition,
  type WorkflowDiagramLayout,
} from "../lib/workflow-diagram.ts";
import {
  createWorkflowAdapters,
  type UpdateTemplateFailure,
  type WorkflowTemplateRow,
} from "../lib/workflow-client.ts";

const workflowAdapters = createWorkflowAdapters();

// The create form's starting point: two states and one transition — enough
// to show the shape (and to pass the server's gates) without pretending to
// know anyone's business flow.
const DEFINITION_SKELETON = {
  initial: "new",
  states: {
    new: { on: { ADVANCE: "done" } },
    done: {},
  },
};

function formatDateTime(iso: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(iso),
  );
}

/** What the definition textarea currently holds, for the live preview. */
type DraftDiagram =
  | { kind: "ok"; layout: WorkflowDiagramLayout }
  | { kind: "json"; message: string }
  | { kind: "definition"; message: string };

function parseDraft(text: string): DraftDiagram {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { kind: "json", message: error instanceof Error ? error.message : "invalid JSON" };
  }
  const parsed = parseWorkflowDefinition(raw);
  if (!parsed.ok) {
    return { kind: "definition", message: parsed.error };
  }
  return { kind: "ok", layout: layoutWorkflowDiagram(parsed.model) };
}

const CREATE_ERRORS = {
  forbidden: "Your account does not have permission to manage workflow templates.",
  exists: "A template with this key already exists for this subject type.",
  default_exists:
    "Another template is already the default for this subject type — make that one non-default first.",
  unavailable: "The template could not be created. Reload and try again.",
};

const EDIT_ERRORS: Record<Exclude<UpdateTemplateFailure, "unavailable">, string> = {
  forbidden: "Your account does not have permission to manage workflow templates.",
  not_found: "This template no longer exists — the list is stale; reload the page.",
  default_exists:
    "Another template is already the default for this subject type — make that one non-default first.",
};

function invalidMessage(detail: string | null): string {
  return detail === null
    ? "The definition was refused — check the JSON against the template shape and try again."
    : `The definition was refused: ${detail}`;
}

interface CreateDraft {
  subjectType: string;
  templateKey: string;
  productType: string;
  isDefault: boolean;
  definitionText: string;
}

const EMPTY_CREATE: CreateDraft = {
  subjectType: "",
  templateKey: "",
  productType: "",
  isDefault: false,
  definitionText: JSON.stringify(DEFINITION_SKELETON, null, 2),
};

interface EditDraft {
  productType: string;
  isDefault: boolean;
  active: boolean;
  definitionText: string;
}

export function WorkflowTemplates(): ReactElement {
  const queryClient = useQueryClient();
  const templatesQuery = useQuery({
    queryKey: ["workflow-templates"],
    queryFn: () => workflowAdapters.list(),
  });
  const templates = templatesQuery.data?.ok ? templatesQuery.data.data : undefined;
  const forbidden = templatesQuery.data?.ok === false && templatesQuery.data.reason === "forbidden";
  const unavailable =
    (templatesQuery.data?.ok === false && templatesQuery.data.reason === "unavailable") ||
    templates === undefined;

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createDraft, setCreateDraft] = useState<CreateDraft>(EMPTY_CREATE);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createBusy, setCreateBusy] = useState(false);
  const [editDraft, setEditDraft] = useState<EditDraft | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [editBusy, setEditBusy] = useState(false);

  const selected = templates?.find((template) => template.id === selectedId) ?? null;

  const selectedDiagram = useMemo<DraftDiagram | null>(() => {
    if (selected === null || editDraft !== null) return null;
    return parseDraft(JSON.stringify(selected.definition, null, 2));
  }, [selected, editDraft]);

  const createPreview = useMemo<DraftDiagram | null>(
    () => (createOpen ? parseDraft(createDraft.definitionText) : null),
    [createOpen, createDraft.definitionText],
  );

  const editPreview = useMemo<DraftDiagram | null>(
    () => (editDraft !== null ? parseDraft(editDraft.definitionText) : null),
    [editDraft],
  );

  function refresh(): void {
    void queryClient.invalidateQueries({ queryKey: ["workflow-templates"] });
  }

  function openCreate(): void {
    setFlash(null);
    setCreateError(null);
    setCreateDraft(EMPTY_CREATE);
    setCreateOpen(true);
  }

  async function submitCreate(): Promise<void> {
    const subjectType = createDraft.subjectType.trim();
    const templateKey = createDraft.templateKey.trim();
    let definition: unknown;
    try {
      definition = JSON.parse(createDraft.definitionText);
    } catch {
      setCreateError("The definition is not valid JSON yet — fix it and try again.");
      return;
    }
    if (subjectType === "" || templateKey === "") {
      setCreateError("Subject type and template key are required.");
      return;
    }
    setCreateBusy(true);
    setCreateError(null);
    const result = await workflowAdapters.create({
      subjectType,
      templateKey,
      productType: createDraft.productType.trim() === "" ? null : createDraft.productType.trim(),
      isDefault: createDraft.isDefault,
      definition,
    });
    setCreateBusy(false);
    if (!result.ok) {
      setCreateError(
        result.reason === "invalid" ? invalidMessage(result.detail) : CREATE_ERRORS[result.reason],
      );
      return;
    }
    setCreateOpen(false);
    setSelectedId(result.data.id);
    setFlash("Template created — flows for this subject type can be configured against it.");
    refresh();
  }

  function openEdit(template: WorkflowTemplateRow): void {
    setFlash(null);
    setEditError(null);
    setSelectedId(template.id);
    setEditDraft({
      productType: template.productType ?? "",
      isDefault: template.isDefault,
      active: template.active,
      definitionText: JSON.stringify(template.definition, null, 2),
    });
  }

  async function submitEdit(): Promise<void> {
    if (selected === null || editDraft === null) return;
    let definition: unknown;
    try {
      definition = JSON.parse(editDraft.definitionText);
    } catch {
      setEditError("The definition is not valid JSON yet — fix it and try again.");
      return;
    }
    setEditBusy(true);
    setEditError(null);
    const result = await workflowAdapters.update(selected.id, {
      productType: editDraft.productType.trim() === "" ? null : editDraft.productType.trim(),
      isDefault: editDraft.isDefault,
      active: editDraft.active,
      definition,
    });
    setEditBusy(false);
    if (!result.ok) {
      setEditError(
        result.reason === "invalid"
          ? invalidMessage(result.detail)
          : result.reason === "unavailable"
            ? "The change could not be saved. Reload and try again."
            : EDIT_ERRORS[result.reason],
      );
      return;
    }
    setEditDraft(null);
    setFlash(
      "Saved — running instances keep the definition they started with; the new one applies to flows started from now on.",
    );
    refresh();
  }


  return (
    <div className="w-full" data-page="workflow-templates" data-testid="workflow-templates-root">
      <Card>
        <Heading as="h2">Workflow templates</Heading>
        <Paragraph className="text-ink-soft">
          One template per subject type defines the flow — its states, the allowed
          transitions, and who may take them. A running instance keeps the definition
          it started with; edits apply to flows started from now on.
        </Paragraph>

        {flash !== null ? (
          <Paragraph className="mt-3 text-ink" data-testid="workflow-flash">
            {flash}
          </Paragraph>
        ) : null}

        {templatesQuery.isPending ? (
          <Paragraph className="mt-3" data-testid="workflow-templates-loading">
            Loading…
          </Paragraph>
        ) : forbidden ? (
          <Paragraph className="mt-3 text-ink-soft" data-testid="workflow-templates-forbidden">
            Your account does not have permission to manage workflow templates. Ask an
            administrator for the workflow permission.
          </Paragraph>
        ) : unavailable ? (
          <Paragraph className="mt-3 text-ink-soft" data-testid="workflow-templates-unavailable">
            The workflow templates could not be loaded.
          </Paragraph>
        ) : (
          <>
            <div className="mt-3">
              <Button variant="primary" size="sm" data-testid="workflow-new" onClick={openCreate}>
                New template
              </Button>
            </div>

            {createOpen ? (
              <div className="mt-3 rounded-card border border-line p-4" data-testid="workflow-create-form">
                <Heading as="h3">New template</Heading>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <label className="text-ui-sm text-ink">
                    Subject type
                    <Input
                      className="mt-1 block w-full"
                      data-testid="workflow-create-subject"
                      placeholder="lead, opportunity, …"
                      value={createDraft.subjectType}
                      onChange={(e) => {
                        setCreateDraft({ ...createDraft, subjectType: e.target.value });
                      }}
                    />
                  </label>
                  <label className="text-ui-sm text-ink">
                    Template key
                    <Input
                      className="mt-1 block w-full font-mono"
                      data-testid="workflow-create-key"
                      placeholder="standard"
                      value={createDraft.templateKey}
                      onChange={(e) => {
                        setCreateDraft({ ...createDraft, templateKey: e.target.value });
                      }}
                    />
                  </label>
                  <label className="text-ui-sm text-ink">
                    Product type (optional — empty matches every product)
                    <Input
                      className="mt-1 block w-full"
                      data-testid="workflow-create-product"
                      value={createDraft.productType}
                      onChange={(e) => {
                        setCreateDraft({ ...createDraft, productType: e.target.value });
                      }}
                    />
                  </label>
                  <label className="mt-6 flex cursor-pointer items-center gap-2 text-ui-sm text-ink">
                    <input
                      type="checkbox"
                      className="size-4 accent-[var(--accent)]"
                      data-testid="workflow-create-default"
                      checked={createDraft.isDefault}
                      onChange={(e) => {
                        setCreateDraft({ ...createDraft, isDefault: e.target.checked });
                      }}
                    />
                    Default for this subject type (at most one — the fallback when no
                    product type matches)
                  </label>
                </div>
                <label className="mt-3 block text-ui-sm text-ink">
                  Definition (XState JSON — states, transitions, roles, gates)
                  <textarea
                    className="mt-1 block w-full rounded-control border border-line bg-card p-[var(--pad-control)] font-mono text-ui text-ink"
                    rows={12}
                    spellCheck={false}
                    data-testid="workflow-create-definition"
                    value={createDraft.definitionText}
                    onChange={(e) => {
                      setCreateDraft({ ...createDraft, definitionText: e.target.value });
                    }}
                  />
                </label>
                {createPreview === null ? null : createPreview.kind === "ok" ? (
                  <div className="mt-3 overflow-x-auto" data-testid="workflow-create-preview">
                    <Paragraph className="text-ui-sm text-ink-soft">
                      Preview — what the server would store:
                    </Paragraph>
                    <WorkflowDiagram layout={createPreview.layout} />
                  </div>
                ) : (
                  <Paragraph
                    className="mt-2 font-mono text-ui-sm text-ink-soft"
                    data-testid="workflow-create-preview-error"
                  >
                    {createPreview.kind === "json"
                      ? `Not valid JSON yet: ${createPreview.message}`
                      : `Not renderable yet: ${createPreview.message}`}
                  </Paragraph>
                )}
                {createError !== null ? (
                  <Paragraph className="mt-2 text-err font-medium" data-testid="workflow-create-error">
                    {createError}
                  </Paragraph>
                ) : null}
                <div className="mt-3 flex gap-2">
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={createBusy}
                    data-testid="workflow-create-submit"
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
                    data-testid="workflow-create-cancel"
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
              <Paragraph className="mt-3 text-ink-soft" data-testid="workflow-templates-empty">
                No templates yet. Create the first one — the flow for a subject type
                starts here, and business domains pick it up as they arrive.
              </Paragraph>
            ) : (
              <div className="mt-3 overflow-x-auto" data-testid="workflow-templates-table">
                <table className="w-full border-collapse text-left text-ui-sm">
                  <thead>
                    <tr className="border-b border-line">
                      <th className="py-2 pr-4 font-mono text-[length:var(--fs-meta)] font-medium tracking-[var(--ls-crumb)] text-ink-soft uppercase">Subject type</th>
                      <th className="py-2 pr-4 font-mono text-[length:var(--fs-meta)] font-medium tracking-[var(--ls-crumb)] text-ink-soft uppercase">Template key</th>
                      <th className="py-2 pr-4 font-mono text-[length:var(--fs-meta)] font-medium tracking-[var(--ls-crumb)] text-ink-soft uppercase">Product type</th>
                      <th className="py-2 pr-4 font-mono text-[length:var(--fs-meta)] font-medium tracking-[var(--ls-crumb)] text-ink-soft uppercase">Status</th>
                      <th className="py-2 pr-4 font-mono text-[length:var(--fs-meta)] font-medium tracking-[var(--ls-crumb)] text-ink-soft uppercase">Version</th>
                      <th className="py-2 pr-4 font-mono text-[length:var(--fs-meta)] font-medium tracking-[var(--ls-crumb)] text-ink-soft uppercase">Created</th>
                      <th className="py-2 font-mono text-[length:var(--fs-meta)] font-medium tracking-[var(--ls-crumb)] text-ink-soft uppercase"> </th>
                    </tr>
                  </thead>
                  <tbody>
                    {templates.map((template) => (
                      <tr key={template.id} className="border-b border-line align-top" data-testid="workflow-template-row">
                        <td className="py-2 pr-4 font-mono">{template.subjectType}</td>
                        <td className="py-2 pr-4 font-mono">{template.templateKey}</td>
                        <td className="py-2 pr-4 font-mono">
                          {template.productType ?? <span className="text-ink-soft">any</span>}
                        </td>
                        <td className="py-2 pr-4">
                          {template.active ? (
                            <span className="font-medium text-brand" data-testid="workflow-template-active">Active</span>
                          ) : (
                            <span className="text-ink-soft" data-testid="workflow-template-inactive">Deactivated</span>
                          )}
                          {template.isDefault ? (
                            <span
                              className="ml-2 font-medium text-accent-ink"
                              data-testid="workflow-template-default"
                            >
                              Default
                            </span>
                          ) : null}
                        </td>
                        <td className="py-2 pr-4 font-mono text-ink-soft">v{template.version}</td>
                        <td className="py-2 pr-4 whitespace-nowrap text-ink-soft">{formatDateTime(template.createdAt)}</td>
                        <td className="py-2">
                          <Button
                            variant="default"
                            size="sm"
                            data-testid="workflow-template-open"
                            onClick={() => {
                              setFlash(null);
                              setEditDraft(null);
                              setSelectedId(template.id);
                            }}
                          >
                            Open
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {selected !== null && selectedDiagram !== null ? (
              <div className="mt-3" data-testid="workflow-detail">
                <Heading as="h3">
                  {selected.templateKey} <span className="text-ink-soft">· {selected.subjectType}</span>
                </Heading>
                <Paragraph className="mt-1 text-ui-sm text-ink-soft">
                  {selected.productType === null
                    ? "Matches every product type."
                    : `Only product type ${selected.productType}.`}
                  {selected.isDefault ? " The default template for this subject type." : ""}
                  {selected.active ? "" : " Deactivated — no new flow starts from it until reactivated."}
                </Paragraph>
                <div className="mt-2 overflow-x-auto" data-testid="workflow-detail-diagram">
                  {selectedDiagram.kind === "ok" ? (
                    <WorkflowDiagram layout={selectedDiagram.layout} />
                  ) : (
                    <Paragraph className="font-mono text-ui-sm text-err">
                      The saved definition could not be drawn: {selectedDiagram.message}
                    </Paragraph>
                  )}
                </div>
                <div className="mt-3">
                  <Button
                    variant="default"
                    size="sm"
                    data-testid="workflow-edit-open"
                    onClick={() => {
                      openEdit(selected);
                    }}
                  >
                    Edit template
                  </Button>
                </div>
              </div>
            ) : null}

            {selected !== null && editDraft !== null ? (
              <div className="mt-3 rounded-card border border-line p-4" data-testid="workflow-edit-form">
                <Heading as="h3">
                  Edit {selected.templateKey} <span className="text-ink-soft">· {selected.subjectType}</span>
                </Heading>
                <Paragraph className="mt-1 text-ui-sm text-ink-soft">
                  Running instances keep their start-time definition — this change
                  reaches only flows started from now on. The template key and subject
                  type are this template's identity and cannot change here.
                </Paragraph>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <label className="text-ui-sm text-ink">
                    Product type (empty matches every product)
                    <Input
                      className="mt-1 block w-full"
                      data-testid="workflow-edit-product"
                      value={editDraft.productType}
                      onChange={(e) => {
                        setEditDraft({ ...editDraft, productType: e.target.value });
                      }}
                    />
                  </label>
                  <div className="text-ui-sm text-ink">
                    <label className="mt-0 flex cursor-pointer items-center gap-2">
                      <input
                        type="checkbox"
                        className="size-4 accent-[var(--accent)]"
                        data-testid="workflow-edit-default"
                        checked={editDraft.isDefault}
                        onChange={(e) => {
                          setEditDraft({ ...editDraft, isDefault: e.target.checked });
                        }}
                      />
                      Default for this subject type (at most one — demote the other first)
                    </label>
                    <label className="mt-2 flex cursor-pointer items-center gap-2">
                      <input
                        type="checkbox"
                        className="size-4 accent-[var(--accent)]"
                        data-testid="workflow-edit-active"
                        checked={editDraft.active}
                        onChange={(e) => {
                          setEditDraft({ ...editDraft, active: e.target.checked });
                        }}
                      />
                      Active — new flows can start from this template
                    </label>
                  </div>
                </div>
                <label className="mt-3 block text-ui-sm text-ink">
                  Definition (XState JSON — states, transitions, roles, gates)
                  <textarea
                    className="mt-1 block w-full rounded-control border border-line bg-card p-[var(--pad-control)] font-mono text-ui text-ink"
                    rows={14}
                    spellCheck={false}
                    data-testid="workflow-edit-definition"
                    value={editDraft.definitionText}
                    onChange={(e) => {
                      setEditDraft({ ...editDraft, definitionText: e.target.value });
                    }}
                  />
                </label>
                {editPreview === null ? null : editPreview.kind === "ok" ? (
                  <div className="mt-3 overflow-x-auto" data-testid="workflow-edit-preview">
                    <Paragraph className="text-ui-sm text-ink-soft">
                      Preview — what the server would store:
                    </Paragraph>
                    <WorkflowDiagram layout={editPreview.layout} />
                  </div>
                ) : (
                  <Paragraph
                    className="mt-2 font-mono text-ui-sm text-ink-soft"
                    data-testid="workflow-edit-preview-error"
                  >
                    {editPreview.kind === "json"
                      ? `Not valid JSON yet: ${editPreview.message}`
                      : `Not renderable yet: ${editPreview.message}`}
                  </Paragraph>
                )}
                {editError !== null ? (
                  <Paragraph className="mt-2 text-err font-medium" data-testid="workflow-edit-error">
                    {editError}
                  </Paragraph>
                ) : null}
                <div className="mt-3 flex gap-2">
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={editBusy}
                    data-testid="workflow-edit-submit"
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
                    data-testid="workflow-edit-cancel"
                    onClick={() => {
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
