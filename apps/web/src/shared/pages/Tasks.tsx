// The tasks page (#113 slice 1) — the operator's own to-do list: tasks
// assigned to them and tasks they created. One task system (the old
// system's three tables merge here); business-object attachment arrives with
// the first business domain, so today every task is standalone.
//
// States are honest, never blank-by-accident: loading says so, an unreachable
// API says so, an empty list says what would fill it (the adapter reports the
// failure mode — see tasks-client.ts). Status is the old system's checkbox
// read: tick = done, untick = open; cancel is a separate verb, never a
// checkbox state.
import type { ReactElement } from "react";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card, Heading, Input, Paragraph } from "@ally/ui";

import {
  createTaskAdapters,
  type AssigneeOption,
  type TaskRow,
  type TaskScope,
  type TaskStatus,
} from "../lib/tasks-client.ts";

const taskAdapters = createTaskAdapters();

/** Rows per page — also the API's cap; the pager steps in this unit. */
const PAGE_SIZE = 50;

const STATUS_FILTERS: readonly { value: TaskStatus | "all"; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "done", label: "Done" },
  { value: "cancelled", label: "Cancelled" },
  { value: "all", label: "All" },
];

function formatDue(iso: string | null): string {
  if (iso === null) return "";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(iso));
}

function isOverdue(row: TaskRow): boolean {
  return row.dueAt !== null && row.status === "open" && new Date(row.dueAt).getTime() < Date.now();
}

export function Tasks(): ReactElement {
  const queryClient = useQueryClient();
  const [scope, setScope] = useState<TaskScope>("assigned");
  const [statusFilter, setStatusFilter] = useState<TaskStatus | "all">("open");
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ["tasks", scope, statusFilter, offset],
    queryFn: () =>
      taskAdapters.list({
        scope,
        ...(statusFilter === "all" ? {} : { status: statusFilter }),
        limit: PAGE_SIZE,
        offset,
      }),
    placeholderData: (previous) => previous,
  });
  const assignees = useQuery({
    queryKey: ["tasks", "assignee-options"],
    queryFn: () => taskAdapters.assigneeOptions(),
    staleTime: 5 * 60 * 1000,
  });

  const data = list.data?.ok ? list.data.data : undefined;
  const unavailable = list.data?.ok === false || (list.data !== undefined && data === undefined);
  const hasNewer = offset > 0;
  const hasOlder = data !== undefined && offset + PAGE_SIZE < data.total;

  function refresh(): void {
    void queryClient.invalidateQueries({ queryKey: ["tasks"] });
  }

  async function toggleDone(row: TaskRow): Promise<void> {
    setError(null);
    const next = row.status === "done" ? "open" : "done";
    const result = await taskAdapters.patch(row.id, { status: next });
    if (!result.ok) {
      setError("The change could not be saved. Reload and try again.");
      return;
    }
    refresh();
  }

  async function cancelTask(row: TaskRow): Promise<void> {
    setError(null);
    const result = await taskAdapters.patch(row.id, { status: "cancelled" });
    if (!result.ok) {
      setError("The change could not be saved. Reload and try again.");
      return;
    }
    refresh();
  }

  return (
    <div className="w-full" data-page="tasks" data-testid="tasks-root">
      <Card>
        <Heading as="h2">Tasks</Heading>
        <Paragraph className="text-ink-soft">
          Your own to-do list: what is assigned to you and what you created.
          Assignment notifies the assignee in the bell.
        </Paragraph>

        <CreateTaskForm
          assignees={assignees.data?.ok === true ? assignees.data.data : []}
          onCreated={() => {
            refresh();
          }}
        />

        <div className="mt-4 flex flex-wrap items-center gap-2" data-testid="tasks-filters">
          <span className="flex gap-1" role="tablist" aria-label="Task scope">
            {(
              [
                { value: "assigned", label: "Assigned to me" },
                { value: "created", label: "Created by me" },
              ] as const
            ).map((tab) => (
              <Button
                key={tab.value}
                variant={scope === tab.value ? "default" : "ghost"}
                size="sm"
                onClick={() => {
                  setScope(tab.value);
                  setOffset(0);
                }}
                data-testid={`tasks-scope-${tab.value}`}
              >
                {tab.label}
              </Button>
            ))}
          </span>
          <span className="flex gap-1" aria-label="Status filter">
            {STATUS_FILTERS.map((chip) => (
              <Button
                key={chip.value}
                variant={statusFilter === chip.value ? "default" : "ghost"}
                size="sm"
                onClick={() => {
                  setStatusFilter(chip.value);
                  setOffset(0);
                }}
                data-testid={`tasks-status-${chip.value}`}
              >
                {chip.label}
              </Button>
            ))}
          </span>
        </div>

        {error !== null ? (
          <Paragraph className="mt-3 text-ink-soft" data-testid="tasks-action-error">
            {error}
          </Paragraph>
        ) : null}

        {list.isPending ? (
          <Paragraph className="mt-3" data-testid="tasks-loading">
            Loading…
          </Paragraph>
        ) : unavailable || data === undefined ? (
          <Paragraph className="mt-3 text-ink-soft" data-testid="tasks-unavailable">
            The task list could not be loaded.
          </Paragraph>
        ) : data.tasks.length === 0 ? (
          <Paragraph className="mt-3 text-ink-soft" data-testid="tasks-empty">
            No tasks here. Create one above — whoever is assigned gets a bell
            notification.
          </Paragraph>
        ) : (
          <>
            <ul className="mt-3" data-testid="tasks-list">
              {data.tasks.map((row) => (
                <li
                  key={row.id}
                  className="flex items-start gap-3 border-b border-line py-2"
                  data-testid="tasks-row"
                  data-status={row.status}
                >
                  <Input
                    type="checkbox"
                    aria-label={row.status === "done" ? `Reopen ${row.title}` : `Mark ${row.title} done`}
                    checked={row.status === "done"}
                    disabled={row.status === "cancelled"}
                    onChange={() => {
                      void toggleDone(row);
                    }}
                    className="mt-1"
                    data-testid="tasks-row-check"
                  />
                  <span className="min-w-0 flex-1">
                    <span
                      className={
                        row.status === "cancelled"
                          ? "text-ui text-ink-soft line-through"
                          : row.status === "done"
                            ? "text-ui text-ink-soft"
                            : "text-ui text-ink"
                      }
                    >
                      {row.title}
                    </span>
                    {row.description !== null && row.description !== "" ? (
                      <span className="block text-ui-sm text-ink-soft">{row.description}</span>
                    ) : null}
                    <span className="mt-0.5 block font-mono text-[length:var(--fs-meta)] text-ink-soft">
                      {scope === "assigned"
                        ? `from ${row.createdBy?.name ?? "—"}`
                        : `to ${row.assignee?.name ?? "unassigned"}`}
                      {row.dueAt !== null ? ` · due ${formatDue(row.dueAt)}` : ""}
                      {isOverdue(row) ? " · overdue" : ""}
                    </span>
                  </span>
                  {row.status === "open" || row.status === "done" ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        void cancelTask(row);
                      }}
                      data-testid="tasks-row-cancel"
                    >
                      Cancel task
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
            <div className="mt-3 flex items-center justify-between" data-testid="tasks-pager">
              <span className="font-mono text-[length:var(--fs-meta)] text-ink-soft">
                {data.total === 0
                  ? "0 tasks"
                  : `${String(offset + 1)}–${String(Math.min(offset + data.tasks.length, data.total))} of ${String(data.total)}`}
              </span>
              <span className="flex gap-2">
                <Button
                  variant="default"
                  size="sm"
                  disabled={!hasNewer}
                  onClick={() => {
                    setOffset(Math.max(0, offset - PAGE_SIZE));
                  }}
                  data-testid="tasks-newer"
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
                  data-testid="tasks-older"
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

function CreateTaskForm(props: {
  assignees: AssigneeOption[];
  onCreated: () => void;
}): ReactElement {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [assigneeId, setAssigneeId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    setFormError(null);
    const trimmed = title.trim();
    if (trimmed === "") {
      setFormError("Give the task a title first.");
      return;
    }
    setSubmitting(true);
    const result = await taskAdapters.create({
      title: trimmed,
      ...(description.trim() === "" ? {} : { description: description.trim() }),
      ...(dueDate === "" ? {} : { dueAt: `${dueDate}T00:00:00.000Z` }),
      ...(assigneeId === "" ? {} : { assigneeId }),
    });
    setSubmitting(false);
    if (!result.ok) {
      setFormError(
        result.reason === "conflict"
          ? "The task was rejected — check the assignee and try again."
          : "The task could not be created. Reload and try again.",
      );
      return;
    }
    setTitle("");
    setDescription("");
    setDueDate("");
    setAssigneeId("");
    props.onCreated();
  }

  return (
    <form
      className="mt-4 grid gap-2"
      data-testid="tasks-create-form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="flex flex-wrap gap-2">
        <Input
          type="text"
          placeholder="What needs doing?"
          value={title}
          onChange={(event) => {
            setTitle(event.target.value);
          }}
          className="min-w-[220px] flex-1"
          aria-label="Task title"
          data-testid="tasks-create-title"
        />
        <select
          value={assigneeId}
          onChange={(event) => {
            setAssigneeId(event.target.value);
          }}
          aria-label="Assignee"
          data-testid="tasks-create-assignee"
          className="rounded-control border border-line bg-card p-[var(--pad-control)] font-sans text-ui text-ink"
        >
          <option value="">Unassigned</option>
          {props.assignees.map((person) => (
            <option key={person.id} value={person.id}>
              {person.name}
            </option>
          ))}
        </select>
        <Input
          type="date"
          value={dueDate}
          onChange={(event) => {
            setDueDate(event.target.value);
          }}
          aria-label="Due date"
          data-testid="tasks-create-due"
        />
        <Button type="submit" size="sm" disabled={submitting} data-testid="tasks-create-submit">
          Add task
        </Button>
      </div>
      <Input
        type="text"
        placeholder="Notes (optional)"
        value={description}
        onChange={(event) => {
          setDescription(event.target.value);
        }}
        aria-label="Task description"
        data-testid="tasks-create-description"
      />
      {formError !== null ? (
        <Paragraph className="text-ink-soft" data-testid="tasks-create-error">
          {formError}
        </Paragraph>
      ) : null}
    </form>
  );
}
