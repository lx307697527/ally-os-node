// The task detail page (#110 slice 1) — the first record route, and the
// landing spot for task notifications: a notification's click goes HERE, to
// the comment that mentioned you (the ?comment= param scrolls to it and
// highlights it). The comments panel is the first consumer of the comments
// kernel; subjects beyond tasks arrive with their business domains.
//
// States are honest, never blank-by-accident: loading says so, an unreachable
// API says so, a task that is gone or was never yours says so (the API's
// anti-probe 404 renders as "not available to you", it does not guess which).
// Mentions resolve against the task's participants — the composer says who
// can be mentioned, so a silent no-op mention is never a surprise.
import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { Button, Card, Heading, Paragraph } from "@ally/ui";

import { createCommentAdapters, type CommentRow, type Person } from "../lib/comments-client.ts";
import { createTaskAdapters, type TaskRow } from "../lib/tasks-client.ts";
import { useSession } from "../lib/session.ts";

const taskAdapters = createTaskAdapters();
const commentAdapters = createCommentAdapters();

/** The composer pulls one page; a busier subject pages later with the
 *  activity stream. The API's cap is the same 100. */
const COMMENTS_PAGE = 100;

const COMMENT_BODY_MAX = 5000;

const taskIdSchema = z.uuid();

function formatDay(iso: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(iso),
  );
}

export function TaskDetail(): ReactElement {
  const { taskId } = useParams();
  const [searchParams] = useSearchParams();
  const { user } = useSession();
  const highlightId = searchParams.get("comment");

  if (taskId === undefined || !taskIdSchema.safeParse(taskId).success) {
    return <TaskUnavailable kind="notfound" />;
  }

  return (
    <TaskLoaded
      taskId={taskId}
      highlightId={highlightId}
      meId={user?.id ?? null}
    />
  );
}

function TaskLoaded(props: {
  taskId: string;
  highlightId: string | null;
  meId: string | null;
}): ReactElement {
  const queryClient = useQueryClient();
  const task = useQuery({
    queryKey: ["tasks", props.taskId],
    queryFn: () => taskAdapters.get(props.taskId),
  });
  const comments = useQuery({
    queryKey: ["comments", "task", props.taskId],
    queryFn: () =>
      commentAdapters.list({
        subjectType: "task",
        subjectId: props.taskId,
        limit: COMMENTS_PAGE,
        offset: 0,
      }),
  });

  const taskData = task.data?.ok === true ? task.data.data : undefined;
  const commentsData = comments.data?.ok === true ? comments.data.data : undefined;

  // The deep link's second half: once the comments are on screen, walk to the
  // mentioned one and hold the highlight. A param without a row (deleted, or
  // a typo in a copied link) simply does not highlight — the page is still
  // the right destination for the task.
  useEffect(() => {
    if (props.highlightId === null || commentsData === undefined) return;
    const el = document.querySelector(`[data-comment-id="${CSS.escape(props.highlightId)}"]`);
    if (el !== null) el.scrollIntoView({ block: "center" });
  }, [props.highlightId, commentsData]);

  function refreshComments(): void {
    void queryClient.invalidateQueries({ queryKey: ["comments", "task", props.taskId] });
  }

  return (
    <div className="w-full" data-page="task-detail" data-testid="task-detail-root">
      {task.isPending ? (
        <Card>
          <Paragraph data-testid="task-detail-loading">Loading…</Paragraph>
        </Card>
      ) : taskData === undefined ? (
        <TaskUnavailable
          kind={task.data?.ok === false && task.data.reason === "notfound" ? "notfound" : "unavailable"}
        />
      ) : (
        <Card>
          <Link
            to="/tasks"
            className="text-ui-sm text-link underline underline-offset-2 hover:text-link-hover"
            data-testid="task-detail-back"
          >
            ← All tasks
          </Link>
          <Heading as="h2" className="mt-2" data-testid="task-detail-title">
            {taskData.title}
          </Heading>
          <TaskMeta row={taskData} />
          {taskData.description !== null && taskData.description !== "" ? (
            <Paragraph className="mt-2 text-ink-soft">{taskData.description}</Paragraph>
          ) : null}

          <CommentsSection
            subjectId={props.taskId}
            comments={commentsData?.comments}
            total={commentsData?.total}
            loading={comments.isPending}
            unavailable={comments.data !== undefined && commentsData === undefined}
            notfound={comments.data?.ok === false && comments.data.reason === "notfound"}
            meId={props.meId}
            viewers={participantsOf(taskData)}
            highlightId={props.highlightId}
            onChanged={refreshComments}
          />
        </Card>
      )}
    </div>
  );
}

function TaskMeta(props: { row: TaskRow }): ReactElement {
  const due =
    props.row.dueAt === null
      ? ""
      : ` · due ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(props.row.dueAt))}`;
  return (
    <Paragraph className="mt-1 font-mono text-[length:var(--fs-meta)] text-ink-soft" data-testid="task-detail-meta">
      {props.row.status}
      {` · from ${props.row.createdBy?.name ?? "—"}`}
      {` · to ${props.row.assignee?.name ?? "unassigned"}`}
      {due}
    </Paragraph>
  );
}

function TaskUnavailable(props: { kind: "notfound" | "unavailable" }): ReactElement {
  return (
    <Card>
      {props.kind === "notfound" ? (
        <Paragraph className="text-ink-soft" data-testid="task-detail-notfound">
          This task is not available to you — it may be gone, or you may not be
          its creator or assignee.
        </Paragraph>
      ) : (
        <Paragraph className="text-ink-soft" data-testid="task-detail-unavailable">
          The task could not be loaded.
        </Paragraph>
      )}
      <Paragraph className="mt-2">
        <Link
          to="/tasks"
          className="text-ui-sm text-link underline underline-offset-2 hover:text-link-hover"
        >
          ← All tasks
        </Link>
      </Paragraph>
    </Card>
  );
}

/** The mention surface is the task's participant set — the same people the
 *  server resolves @Full Name against. Saying so keeps a mention that names
 *  an outsider from reading as a notification that never arrived. */
function participantsOf(row: TaskRow): Person[] {
  const people: Person[] = [];
  for (const person of [row.createdBy, row.assignee]) {
    if (person !== null && !people.some((p) => p.id === person.id)) {
      people.push({ id: person.id, name: person.name });
    }
  }
  return people;
}

function CommentsSection(props: {
  subjectId: string;
  comments: CommentRow[] | undefined;
  total: number | undefined;
  loading: boolean;
  unavailable: boolean;
  notfound: boolean;
  meId: string | null;
  viewers: Person[];
  highlightId: string | null;
  onChanged: () => void;
}): ReactElement {
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notified, setNotified] = useState<string | null>(null);

  async function submit(): Promise<void> {
    setError(null);
    const body = draft.trim();
    if (body === "") {
      setError("Write the comment first.");
      return;
    }
    setSubmitting(true);
    const result = await commentAdapters.create({
      subjectType: "task",
      subjectId: props.subjectId,
      body,
    });
    setSubmitting(false);
    if (!result.ok) {
      setError(
        result.reason === "conflict"
          ? "The comment was rejected — check its length and try again."
          : "The comment could not be posted. Reload and try again.",
      );
      return;
    }
    setDraft("");
    setNotified(
      result.data.mentioned.length === 0
        ? null
        : `Notified: ${result.data.mentioned.map((p) => p.name).join(", ")}`,
    );
    props.onChanged();
  }

  async function remove(row: CommentRow): Promise<void> {
    setError(null);
    const result = await commentAdapters.remove(row.id);
    if (!result.ok) {
      setError(
        result.reason === "forbidden"
          ? "Only the author can delete a comment."
          : "The comment could not be deleted. Reload and try again.",
      );
      return;
    }
    props.onChanged();
  }

  const mentionHint =
    props.viewers.length === 0
      ? ""
      : `Participants: ${props.viewers.map((p) => p.name).join(", ")}. Mention someone with @Full Name.`;

  return (
    <div className="mt-6 border-t border-line pt-4">
      <Heading as="h3">Comments</Heading>
      {props.comments !== undefined && props.total !== undefined && props.total > props.comments.length ? (
        <Paragraph className="mt-1 font-mono text-[length:var(--fs-meta)] text-ink-soft">
          Showing the first {String(props.comments.length)} of {String(props.total)}.
        </Paragraph>
      ) : null}

      {props.loading ? (
        <Paragraph className="mt-2" data-testid="comments-loading">
          Loading…
        </Paragraph>
      ) : props.unavailable || props.notfound || props.comments === undefined ? (
        <Paragraph className="mt-2 text-ink-soft" data-testid="comments-unavailable">
          The comment list could not be loaded.
        </Paragraph>
      ) : props.comments.length === 0 ? (
        <Paragraph className="mt-2 text-ink-soft" data-testid="comments-empty">
          No comments yet. Mention a participant with @Full Name to notify them
          in the bell.
        </Paragraph>
      ) : (
        <ul className="mt-2" data-testid="comments-list">
          {props.comments.map((row) => {
            const highlighted = row.id === props.highlightId;
            return (
              <li
                key={row.id}
                data-testid="comment-row"
                data-comment-id={row.id}
                className={`border-b border-line py-2 ${highlighted ? "rounded-small bg-accent/10 ring-1 ring-accent" : ""}`}
              >
                <span className="block text-ui leading-[var(--lh-ui)] text-ink">{row.body}</span>
                <span className="mt-0.5 block font-mono text-[length:var(--fs-meta)] text-ink-soft">
                  {row.author.name} · {formatDay(row.createdAt)}
                </span>
                {props.meId !== null && row.author.id === props.meId ? (
                  <span className="mt-1 block">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        void remove(row);
                      }}
                      data-testid="comment-delete"
                    >
                      Delete
                    </Button>
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {props.comments !== undefined ? (
        <form
          className="mt-3 grid gap-2"
          data-testid="comments-compose"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {/* The composer is a plain textarea — @ally/ui ports the rest of the
              library with the pages that need it (see its barrel note), and a
              raw element styled from the same tokens renders identically. */}
          <textarea
            value={draft}
            maxLength={COMMENT_BODY_MAX}
            onChange={(event) => {
              setDraft(event.target.value);
            }}
            aria-label="Write a comment"
            placeholder="Write a comment…"
            rows={3}
            data-testid="comments-compose-body"
            className="rounded-control border border-line bg-card p-[var(--pad-control)] font-sans text-ui text-ink"
          />
          <span className="font-mono text-[length:var(--fs-meta)] text-ink-soft">{mentionHint}</span>
          {notified !== null ? (
            <span className="text-ui-sm text-ink-soft" data-testid="comments-notified">
              {notified}
            </span>
          ) : null}
          {error !== null ? (
            <Paragraph className="text-ink-soft" data-testid="comments-compose-error">
              {error}
            </Paragraph>
          ) : null}
          <span>
            <Button type="submit" size="sm" disabled={submitting} data-testid="comments-compose-submit">
              Post comment
            </Button>
          </span>
        </form>
      ) : null}
    </div>
  );
}
