// The comment panel's data access (#110 slice 1): reads (one subject's
// comments, conversation order), writes (post, edit, delete). Same face as the
// tasks client — the failure mode is reported, never flattened:
//
//   { ok: true, data }                       — a good read/write
//   { ok: false, reason: "notfound" }        — 404 (subject gone or not yours)
//   { ok: false, reason: "forbidden" }       — 403 (deleting/editing someone else's)
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
  author: personSchema.nullable(),
  createdAt: z.string(),
  // #110 slice 5: null = never edited; the "(edited)" marker's only source
  editedAt: z.string().nullable(),
});

const commentListSchema = z.object({
  comments: z.array(commentRowSchema),
  total: z.number().int().nonnegative(),
});

const commentCreatedSchema = z.object({
  comment: commentRowSchema,
  mentioned: z.array(personSchema),
  // 关注扇出（#110 slice 4）：这条评论同时推给了几个关注者（不含被提及者）
  notifiedFollowers: z.number().int().nonnegative(),
});

// #110 slice 5: the edit lands with the same mention report shape as create,
// but `mentioned` is only the NEWLY mentioned (creation-time mentions were
// already notified and are never re-notified by an edit)
const commentEditedSchema = z.object({
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

export type CommentEditResult =
  | { ok: true; data: z.infer<typeof commentEditedSchema> }
  | { ok: false; reason: "forbidden" | "notfound" | "conflict" | "unavailable" };

export interface CommentAdapters {
  list(query: CommentListQuery): Promise<CommentListResult>;
  create(input: CommentCreateInput): Promise<CommentCreateResult>;
  edit(id: string, body: string): Promise<CommentEditResult>;
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

    async edit(id: string, body: string): Promise<CommentEditResult> {
      try {
        const res = await fetchFn(`/api/comments/${encodeURIComponent(id)}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ body }),
        });
        if (res.status === 403) return { ok: false, reason: "forbidden" };
        if (res.status === 404) return { ok: false, reason: "notfound" };
        if (res.status === 400) return { ok: false, reason: "conflict" };
        if (!res.ok) return { ok: false, reason: "unavailable" };
        return { ok: true, data: commentEditedSchema.parse(await res.json()) };
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
