// The comment panel's data access (#110 slice 1): reads (one subject's
// comments, conversation order), writes (post, delete). Same face as the
// tasks client — the failure mode is reported, never flattened:
//
//   { ok: true, data }                       — a good read/write
//   { ok: false, reason: "notfound" }        — 404 (subject gone or not yours)
//   { ok: false, reason: "forbidden" }       — 403 (deleting someone else's)
//   { ok: false, reason: "conflict" }        — 400 (validation)
//   { ok: false, reason: "unavailable" }     — network/5xx/body that won't parse
//
// Bodies parse through zod: API responses are external input as far as this
// bundle is concerned (an SPA fallback HTML behind a misrouted proxy must read
// as "unavailable", not as a crash).
import { z } from "zod";

const personSchema = z.object({ id: z.string(), name: z.string() });

const commentRowSchema = z.object({
  id: z.string(),
  subjectType: z.string(),
  subjectId: z.string(),
  body: z.string(),
  author: personSchema,
  createdAt: z.string(),
});

const commentListSchema = z.object({
  comments: z.array(commentRowSchema),
  total: z.number().int().nonnegative(),
});

const commentCreatedSchema = z.object({
  comment: commentRowSchema,
  mentioned: z.array(personSchema),
});

export type Person = z.infer<typeof personSchema>;
export type CommentRow = z.infer<typeof commentRowSchema>;

export interface CommentListQuery {
  subjectType: string;
  subjectId: string;
  limit: number;
  offset: number;
}

export interface CommentCreateInput {
  subjectType: string;
  subjectId: string;
  body: string;
}

export type CommentListResult =
  | { ok: true; data: z.infer<typeof commentListSchema> }
  | { ok: false; reason: "notfound" | "unavailable" };

export type CommentCreateResult =
  | { ok: true; data: z.infer<typeof commentCreatedSchema> }
  | { ok: false; reason: "notfound" | "conflict" | "unavailable" };

export type CommentDeleteResult =
  | { ok: true }
  | { ok: false; reason: "forbidden" | "notfound" | "unavailable" };

export interface CommentAdapters {
  list(query: CommentListQuery): Promise<CommentListResult>;
  create(input: CommentCreateInput): Promise<CommentCreateResult>;
  remove(id: string): Promise<CommentDeleteResult>;
}

export function createCommentAdapters(fetchFn: typeof fetch = fetch): CommentAdapters {
  return {
    async list(query: CommentListQuery): Promise<CommentListResult> {
      const params = new URLSearchParams({
        subjectType: query.subjectType,
        subjectId: query.subjectId,
        limit: String(query.limit),
        offset: String(query.offset),
      });
      try {
        const res = await fetchFn(`/api/comments?${params.toString()}`);
        if (res.status === 404) return { ok: false, reason: "notfound" };
        if (!res.ok) return { ok: false, reason: "unavailable" };
        return { ok: true, data: commentListSchema.parse(await res.json()) };
      } catch {
        return { ok: false, reason: "unavailable" };
      }
    },

    async create(input: CommentCreateInput): Promise<CommentCreateResult> {
      try {
        const res = await fetchFn("/api/comments", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        });
        if (res.status === 404) return { ok: false, reason: "notfound" };
        if (res.status === 400) return { ok: false, reason: "conflict" };
        if (!res.ok) return { ok: false, reason: "unavailable" };
        return { ok: true, data: commentCreatedSchema.parse(await res.json()) };
      } catch {
        return { ok: false, reason: "unavailable" };
      }
    },

    async remove(id: string): Promise<CommentDeleteResult> {
      try {
        const res = await fetchFn(`/api/comments/${encodeURIComponent(id)}`, { method: "DELETE" });
        if (res.status === 403) return { ok: false, reason: "forbidden" };
        if (res.status === 404) return { ok: false, reason: "notfound" };
        if (!res.ok) return { ok: false, reason: "unavailable" };
        return { ok: true };
      } catch {
        return { ok: false, reason: "unavailable" };
      }
    },
  };
}
