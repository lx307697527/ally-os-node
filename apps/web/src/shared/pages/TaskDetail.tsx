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
import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { Button, Card, Heading, Paragraph } from "@ally/ui";

import { createActivityAdapters, type ActivityRow } from "../lib/activity-client.ts";
import {
  createCommentAdapters,
  type AttachmentRejectionCode,
  type AttachmentRow,
  type CommentRow,
  type Person,
} from "../lib/comments-client.ts";
import { createFollowAdapters, type FollowState } from "../lib/follows-client.ts";
import { createTaskAdapters, type TaskRow } from "../lib/tasks-client.ts";
import { useSession } from "../lib/session.ts";

const taskAdapters = createTaskAdapters();
const commentAdapters = createCommentAdapters();
const activityAdapters = createActivityAdapters();
const followAdapters = createFollowAdapters();

/** The composer pulls one page; a busier subject pages later with the
 *  activity stream. The API's cap is the same 100. */
const COMMENTS_PAGE = 100;

/** The timeline pulls one page; older rows stay reachable through the pager
 *  footer once a subject outlives the first fifty events. */
const ACTIVITY_PAGE = 50;

const COMMENT_BODY_MAX = 5000;

// The file picker's hint, mirroring the server's closed allowlist — the
// server's admission remains the only authority; this just spares the user a
// doomed pick. Same numbers as the API: 10 MiB per file, 5 per comment.
const ATTACH_ACCEPT = ".png,.jpg,.jpeg,.gif,.webp,.pdf,.txt,.csv,.md,.json,.doc,.docx,.xls,.xlsx,.ppt,.pptx";

function formatBytes(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${String(sizeBytes)} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The server's admission codes said as sentences — codes never reach the user. */
function rejectionSentence(code: AttachmentRejectionCode | null): string {
  switch (code) {
    case "file_too_large":
      return "That file is over the 10 MiB per-file limit.";
    case "file_type_not_allowed":
      return "That file type is not on the allowed list.";
    case "too_many_files":
      return "A comment can hold at most 5 attachments.";
    case "empty_file":
      return "That file is empty.";
    case "invalid_file_name":
      return "That file name can't be used.";
    // a missing/unparseable body and a multipart-only defect read the same to
    // the user: the pick was rejected, check type and size
    case "no_files":
    case "not_a_file":
    case null:
      return "The file was rejected — check its type and size and try again.";
  }
}

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
  const activity = useQuery({
    queryKey: ["activity", "task", props.taskId],
    queryFn: () =>
      activityAdapters.list({
        subjectType: "task",
        subjectId: props.taskId,
        limit: ACTIVITY_PAGE,
        offset: 0,
      }),
  });
  const follows = useQuery({
    queryKey: ["follows", "task", props.taskId],
    queryFn: () => followAdapters.state("task", props.taskId),
  });

  const taskData = task.data?.ok === true ? task.data.data : undefined;
  const commentsData = comments.data?.ok === true ? comments.data.data : undefined;
  const activityData = activity.data?.ok === true ? activity.data.data : undefined;
  const followsData = follows.data?.ok === true ? follows.data.data : undefined;

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
    // A new comment is also an activity row (comment.created); the delete
    // path lands here too. Both readers of the subject refresh together.
    void queryClient.invalidateQueries({ queryKey: ["comments", "task", props.taskId] });
    void queryClient.invalidateQueries({ queryKey: ["activity", "task", props.taskId] });
  }

  // Following and unfollowing are activity rows too (follow.created/deleted),
  // so the toggle refreshes the timeline along with its own list.
  function refreshFollows(): void {
    void queryClient.invalidateQueries({ queryKey: ["follows", "task", props.taskId] });
    void queryClient.invalidateQueries({ queryKey: ["activity", "task", props.taskId] });
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

          <FollowSection
            subjectId={props.taskId}
            state={followsData}
            loading={follows.isPending}
            unavailable={follows.data !== undefined && followsData === undefined}
            onChanged={refreshFollows}
          />

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

          <ActivitySection
            subjectId={props.taskId}
            events={activityData?.events}
            total={activityData?.total}
            loading={activity.isPending}
            unavailable={activity.data !== undefined && activityData === undefined}
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

/**
 * The follow panel (#110 slice 4): watch a subject so its activity reaches
 * you — a new comment lands in your bell as a notification. The toggle is
 * idempotent server-side; the follower line names who else is watching, so
 * following reads as a shared fact, not a private flag. States are honest:
 * loading, load failure, or the follower list itself — the toggle only
 * renders once the state is known.
 */
function FollowSection(props: {
  subjectId: string;
  state: FollowState | undefined;
  loading: boolean;
  unavailable: boolean;
  onChanged: () => void;
}): ReactElement {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle(): Promise<void> {
    if (props.state === undefined) return;
    setError(null);
    setBusy(true);
    const result =
      props.state.meFollowing
        ? await followAdapters.unfollow("task", props.subjectId)
        : await followAdapters.follow("task", props.subjectId);
    setBusy(false);
    if (!result.ok) {
      setError("The change could not be saved. Reload and try again.");
      return;
    }
    props.onChanged();
  }

  if (props.loading) {
    return (
      <div className="mt-3" data-testid="follow-loading">
        <Paragraph className="font-mono text-[length:var(--fs-meta)] text-ink-soft">
          Loading…
        </Paragraph>
      </div>
    );
  }
  if (props.unavailable || props.state === undefined) {
    return (
      <div className="mt-3">
        <Paragraph className="font-mono text-[length:var(--fs-meta)] text-ink-soft" data-testid="follow-unavailable">
          The follower list could not be loaded.
        </Paragraph>
      </div>
    );
  }
  const followers =
    props.state.followers.length === 0
      ? "No followers yet. Follow to hear about new comments in your bell."
      : `Followed by ${props.state.followers.map((row) => row.name).join(", ")}.`;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2" data-testid="follow-section">
      <Button
        variant={props.state.meFollowing ? "ghost" : "primary"}
        size="sm"
        aria-pressed={props.state.meFollowing}
        disabled={busy}
        onClick={() => {
          void toggle();
        }}
        data-testid="follow-toggle"
      >
        {props.state.meFollowing ? "Unfollow" : "Follow"}
      </Button>
      <span className="font-mono text-[length:var(--fs-meta)] text-ink-soft" data-testid="follow-state">
        {followers}
      </span>
      {error !== null ? (
        <Paragraph className="text-ink-soft" data-testid="follow-error">
          {error}
        </Paragraph>
      ) : null}
    </div>
  );
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
  // #110 slice 5: the id of the comment being edited inline (null = none)
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  // #110 attachments: the upload in flight (comment id) and the one refusal or
  // failure being said (per comment — a stale error must not haunt another row)
  const [attachingId, setAttachingId] = useState<string | null>(null);
  const [attachmentError, setAttachmentError] = useState<{ commentId: string; text: string } | null>(null);
  // one hidden file input per own comment row; the row's button clicks it (a
  // <button> inside a <label> would swallow the label's activation)
  const attachInputRefs = useRef(new Map<string, HTMLInputElement>());

  function openFilePicker(commentId: string): void {
    attachInputRefs.current.get(commentId)?.click();
  }

  async function attachFiles(row: CommentRow, fileList: FileList | null): Promise<void> {
    setAttachmentError(null);
    const files = fileList === null ? [] : Array.from(fileList);
    if (files.length === 0) return;
    setAttachingId(row.id);
    const result = await commentAdapters.attach(row.id, files);
    setAttachingId(null);
    if (!result.ok) {
      setAttachmentError({
        commentId: row.id,
        text:
          result.reason === "forbidden"
            ? "Only the author can attach files."
            : result.reason === "conflict"
              ? rejectionSentence(result.code)
              : "The file could not be uploaded. Reload and try again.",
      });
      return;
    }
    // An attachment is also an activity row (comment.attachment_added); the
    // list read carries the new row.
    props.onChanged();
  }

  async function downloadAttachment(row: CommentRow, attachment: AttachmentRow): Promise<void> {
    setAttachmentError(null);
    const result = await commentAdapters.attachmentUrl(row.id, attachment.id);
    if (!result.ok) {
      setAttachmentError({
        commentId: row.id,
        text: "The download link could not be created. Reload and try again.",
      });
      return;
    }
    // The signed URL is short-lived and was minted for this click; the anchor's
    // download attribute restores the original file name.
    const anchor = document.createElement("a");
    anchor.href = result.data.url;
    anchor.download = result.data.fileName;
    anchor.rel = "noopener";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  }

  async function removeAttachment(row: CommentRow, attachment: AttachmentRow): Promise<void> {
    setAttachmentError(null);
    const result = await commentAdapters.removeAttachment(row.id, attachment.id);
    if (!result.ok) {
      setAttachmentError({
        commentId: row.id,
        text:
          result.reason === "forbidden"
            ? "Only the author can remove an attachment."
            : "The attachment could not be removed. Reload and try again.",
      });
      return;
    }
    props.onChanged();
  }

  function startEdit(row: CommentRow): void {
    setError(null);
    setEditError(null);
    setEditingId(row.id);
    setEditDraft(row.body);
  }

  function cancelEdit(): void {
    setEditingId(null);
    setEditDraft("");
    setEditError(null);
  }

  async function saveEdit(row: CommentRow): Promise<void> {
    setEditError(null);
    const body = editDraft.trim();
    if (body === "") {
      setEditError("Write the comment first.");
      return;
    }
    setSavingEdit(true);
    const result = await commentAdapters.edit(row.id, body);
    setSavingEdit(false);
    if (!result.ok) {
      setEditError(
        result.reason === "forbidden"
          ? "Only the author can edit a comment."
          : result.reason === "conflict"
            ? "The edit was rejected — check its length and try again."
            : "The edit could not be saved. Reload and try again.",
      );
      return;
    }
    // An edit is also an activity row (comment.updated); both readers refresh.
    // Newly mentioned people are named the same way a fresh post names them.
    setEditingId(null);
    setEditDraft("");
    const newly = result.data.mentioned.map((p) => p.name);
    setNotified(
      newly.length === 0 ? null : `Notified: ${newly.join(", ")}`,
    );
    props.onChanged();
  }

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
    const notifiedParts: string[] = [];
    if (result.data.mentioned.length > 0) {
      notifiedParts.push(`Notified: ${result.data.mentioned.map((p) => p.name).join(", ")}`);
    }
    if (result.data.notifiedFollowers > 0) {
      notifiedParts.push(
        `Reached ${String(result.data.notifiedFollowers)} follower${result.data.notifiedFollowers === 1 ? "" : "s"}`,
      );
    }
    setNotified(notifiedParts.length === 0 ? null : notifiedParts.join(" · "));
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
            const mine = props.meId !== null && row.author?.id === props.meId;
            const editing = row.id === editingId;
            return (
              <li
                key={row.id}
                data-testid="comment-row"
                data-comment-id={row.id}
                className={`border-b border-line py-2 ${highlighted ? "rounded-small bg-accent/10 ring-1 ring-accent" : ""}`}
              >
                {editing ? (
                  <div className="grid gap-2" data-testid="comment-edit-form">
                    <textarea
                      value={editDraft}
                      maxLength={COMMENT_BODY_MAX}
                      onChange={(event) => {
                        setEditDraft(event.target.value);
                      }}
                      aria-label="Edit the comment"
                      rows={3}
                      data-testid="comment-edit-body"
                      className="rounded-control border border-line bg-card p-[var(--pad-control)] font-sans text-ui text-ink"
                    />
                    <span className="font-mono text-[length:var(--fs-meta)] text-ink-soft">
                      {mentionHint}
                    </span>
                    {editError !== null ? (
                      <Paragraph className="text-ink-soft" data-testid="comment-edit-error">
                        {editError}
                      </Paragraph>
                    ) : null}
                    <span className="flex gap-2">
                      <Button
                        variant="primary"
                        size="sm"
                        disabled={savingEdit}
                        onClick={() => {
                          void saveEdit(row);
                        }}
                        data-testid="comment-edit-save"
                      >
                        Save
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={savingEdit}
                        onClick={cancelEdit}
                        data-testid="comment-edit-cancel"
                      >
                        Cancel
                      </Button>
                    </span>
                  </div>
                ) : (
                  <>
                    <span className="block text-ui leading-[var(--lh-ui)] text-ink">{row.body}</span>
                    {row.attachments.length > 0 ? (
                      <ul className="mt-1 grid gap-1" data-testid="comment-attachments">
                        {row.attachments.map((attachment) => (
                          <li
                            key={attachment.id}
                            className="flex items-center gap-2 font-mono text-[length:var(--fs-meta)] text-ink-soft"
                            data-testid="comment-attachment-row"
                          >
                            <span className="truncate">
                              {attachment.fileName} · {formatBytes(attachment.sizeBytes)}
                            </span>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                void downloadAttachment(row, attachment);
                              }}
                              data-testid="comment-attachment-download"
                            >
                              Download
                            </Button>
                            {mine ? (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => {
                                  void removeAttachment(row, attachment);
                                }}
                                data-testid="comment-attachment-remove"
                              >
                                Remove
                              </Button>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    <span className="mt-0.5 block font-mono text-[length:var(--fs-meta)] text-ink-soft">
                      {row.author?.name ?? "—"} · {formatDay(row.createdAt)}
                      {row.editedAt !== null ? " · (edited)" : ""}
                    </span>
                    {attachmentError?.commentId === row.id ? (
                      <Paragraph className="text-ink-soft" data-testid="comment-attachment-error">
                        {attachmentError.text}
                      </Paragraph>
                    ) : null}
                    {mine ? (
                      <span className="mt-1 flex gap-2">
                        <input
                          type="file"
                          multiple
                          accept={ATTACH_ACCEPT}
                          className="sr-only"
                          disabled={attachingId === row.id}
                          onChange={(event) => {
                            const files = event.target.files;
                            void attachFiles(row, files);
                            // reset so picking the same file again still fires change
                            event.target.value = "";
                          }}
                          ref={(node) => {
                            if (node === null) {
                              attachInputRefs.current.delete(row.id);
                            } else {
                              attachInputRefs.current.set(row.id, node);
                            }
                          }}
                          data-testid="comment-attach-input"
                        />
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={attachingId === row.id}
                          onClick={() => {
                            openFilePicker(row.id);
                          }}
                          data-testid="comment-attach"
                        >
                          {attachingId === row.id ? "Uploading…" : "Attach file"}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            startEdit(row);
                          }}
                          data-testid="comment-edit"
                        >
                          Edit
                        </Button>
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
                  </>
                )}
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

/**
 * The subject's timeline (#110 slice 3): a read-only projection of the same
 * audit facts the system log keeps, scoped to this task. The verdicts live
 * server-side; this section only renders them — newest first, actor named,
 * unknown actions shown verbatim (the wordlist is open, rendering never
 * guesses). Comment rows deep-link to their comment, reusing the same
 * ?comment= highlight the bell notifications land on.
 */
function ActivitySection(props: {
  subjectId: string;
  events: ActivityRow[] | undefined;
  total: number | undefined;
  loading: boolean;
  unavailable: boolean;
}): ReactElement {
  return (
    <div className="mt-6 border-t border-line pt-4">
      <Heading as="h3">Activity</Heading>
      {props.events !== undefined && props.total !== undefined && props.total > props.events.length ? (
        <Paragraph className="mt-1 font-mono text-[length:var(--fs-meta)] text-ink-soft">
          Showing the first {String(props.events.length)} of {String(props.total)}.
        </Paragraph>
      ) : null}

      {props.loading ? (
        <Paragraph className="mt-2" data-testid="activity-loading">
          Loading…
        </Paragraph>
      ) : props.unavailable || props.events === undefined ? (
        <Paragraph className="mt-2 text-ink-soft" data-testid="activity-unavailable">
          The activity timeline could not be loaded.
        </Paragraph>
      ) : props.events.length === 0 ? (
        <Paragraph className="mt-2 text-ink-soft" data-testid="activity-empty">
          Nothing has happened yet.
        </Paragraph>
      ) : (
        <ul className="mt-2" data-testid="activity-list">
          {props.events.map((row) => (
            <li
              key={row.id}
              data-testid="activity-row"
              className="border-b border-line py-2"
            >
              <span className="block text-ui leading-[var(--lh-ui)] text-ink">
                <span className="font-medium">{row.actor?.name ?? "System"}</span>
                {" "}
                {(row.action === "comment.created" || row.action === "comment.updated") &&
                row.target !== null ? (
                  <Link
                    to={`/tasks/${props.subjectId}?comment=${row.target}`}
                    className="text-link underline underline-offset-2 hover:text-link-hover"
                  >
                    {activityText(row)}
                  </Link>
                ) : (
                  activityText(row)
                )}
              </span>
              <span className="mt-0.5 block font-mono text-[length:var(--fs-meta)] text-ink-soft">
                {formatDay(row.createdAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function detailString(detail: ActivityRow["detail"], key: string): string | null {
  const value = detail?.[key];
  return typeof value === "string" ? value : null;
}

function detailFields(detail: ActivityRow["detail"]): string[] {
  const value = detail?.fields;
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

/**
 * Open wordlist, explicit map: a known action reads as a sentence, an unknown
 * one shows verbatim. Rendered text never invents facts the row doesn't carry.
 */
function activityText(row: ActivityRow): string {
  switch (row.action) {
    case "task.created":
      return "created the task";
    case "task.updated": {
      const fields = detailFields(row.detail);
      return fields.length > 0 ? `updated ${fields.join(", ")}` : "updated the task";
    }
    case "task.status_changed": {
      const from = detailString(row.detail, "from") ?? "?";
      const to = detailString(row.detail, "to") ?? "?";
      return `changed status from ${from} to ${to}`;
    }
    case "task.assigned": {
      const name = detailString(row.detail, "assigneeName");
      return name === null ? "unassigned the task" : `assigned the task to ${name}`;
    }
    case "comment.created":
      return "commented";
    case "comment.updated":
      return "edited a comment";
    case "comment.deleted":
      return "deleted a comment";
    case "follow.created":
      return "started following the task";
    case "follow.deleted":
      return "stopped following the task";
    default:
      return row.action;
  }
}
