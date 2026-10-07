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

// #110 attachments slice: an attachment row as the list read carries it —
// no URL field (short-lived download URLs are minted on demand, a list that
// logs well must not carry them)
const attachmentRowSchema = z.object({
  id: z.string(),
  fileName: z.string(),
  contentType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  createdAt: z.string(),
});

const commentRowSchema = z.object({
  id: z.string(),
  subjectType: z.string(),
  subjectId: z.string(),
  body: z.string(),
  author: personSchema.nullable(),
  createdAt: z.string(),
  // #110 slice 5: null = never edited; the "(edited)" marker's only source
  editedAt: z.string().nullable(),
  attachments: z.array(attachmentRowSchema),
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
export type AttachmentRow = z.infer<typeof attachmentRowSchema>;

// #110 attachments slice: the server's admission codes (closed vocabulary, see
// the route) — the page maps each to a plain sentence instead of showing codes
const attachmentRejectionCodeSchema = z.enum([
  "no_files",
  "not_a_file",
  "empty_file",
  "file_too_large",
  "file_type_not_allowed",
  "invalid_file_name",
  "too_many_files",
]);

export type AttachmentRejectionCode = z.infer<typeof attachmentRejectionCodeSchema>;

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

export type AttachmentAttachResult =
  | { ok: true; data: { attachments: AttachmentRow[] } }
  | { ok: false; reason: "forbidden" | "notfound" }
  // a refusal always carries the server's admission code (null only if the
  // body was unparseable — the page falls back to a generic sentence)
  | { ok: false; reason: "conflict"; code: AttachmentRejectionCode | null }
  | { ok: false; reason: "unavailable" };

export type AttachmentUrlResult =
  | {
      ok: true;
      data: {
        url: string;
        fileName: string;
        contentType: string;
        sizeBytes: number;
        expiresInSeconds: number;
      };
    }
  | { ok: false; reason: "notfound" | "unavailable" };

export type AttachmentRemoveResult =
  | { ok: true }
  | { ok: false; reason: "forbidden" | "notfound" | "unavailable" };

export interface CommentAdapters {
  list(query: CommentListQuery): Promise<CommentListResult>;
  create(input: CommentCreateInput): Promise<CommentCreateResult>;
  edit(id: string, body: string): Promise<CommentEditResult>;
  remove(id: string): Promise<CommentDeleteResult>;
  // #110 attachments slice: the author's upload/download/remove verbs
  attach(id: string, files: File[]): Promise<AttachmentAttachResult>;
  attachmentUrl(id: string, attachmentId: string): Promise<AttachmentUrlResult>;
  removeAttachment(id: string, attachmentId: string): Promise<AttachmentRemoveResult>;
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

    // #110 attachments slice: multipart upload — no content-type header here,
    // the browser builds the multipart boundary; a 400 carries the server's
    // admission code so the page can say WHY the file was refused
    async attach(id: string, files: File[]): Promise<AttachmentAttachResult> {
      try {
        const form = new FormData();
        for (const file of files) form.append("files", file);
        const res = await fetchFn(`/api/comments/${encodeURIComponent(id)}/attachments`, {
          method: "POST",
          body: form,
        });
        if (res.status === 403) return { ok: false, reason: "forbidden" };
        if (res.status === 404) return { ok: false, reason: "notfound" };
        if (res.status === 400) {
          const body = (await res.json().catch(() => null)) as { code?: string } | null;
          const code = attachmentRejectionCodeSchema.safeParse(body?.code);
          return { ok: false, reason: "conflict", code: code.success ? code.data : null };
        }
        if (!res.ok) return { ok: false, reason: "unavailable" };
        return { ok: true, data: z.object({ attachments: z.array(attachmentRowSchema) }).parse(await res.json()) };
      } catch {
        return { ok: false, reason: "unavailable" };
      }
    },

    async attachmentUrl(id: string, attachmentId: string): Promise<AttachmentUrlResult> {
      try {
        const res = await fetchFn(
          `/api/comments/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attachmentId)}/url`,
        );
        if (res.status === 404) return { ok: false, reason: "notfound" };
        if (!res.ok) return { ok: false, reason: "unavailable" };
        return {
          ok: true,
          data: z
            .object({
              url: z.string(),
              fileName: z.string(),
              contentType: z.string(),
              sizeBytes: z.number().int().nonnegative(),
              expiresInSeconds: z.number().int().positive(),
            })
            .parse(await res.json()),
        };
      } catch {
        return { ok: false, reason: "unavailable" };
      }
    },

    async removeAttachment(id: string, attachmentId: string): Promise<AttachmentRemoveResult> {
      try {
        const res = await fetchFn(
          `/api/comments/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attachmentId)}`,
          { method: "DELETE" },
        );
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
