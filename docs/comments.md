# Comments & attachments — #110 (and #232 §11)

Status: kernel landed in slices (#262 comment + mentions, #263 realtime,
#264 activity stream, #265 follows, #266 edit); this page documents the kernel
as it now stands, with the **attachment face** as the newest slice.

## Design basis

Old system never shipped portable comments (`workspace_comments` belongs to an
unrecoverable older generation; follows never existed at all). The kernel is
greenfield per #232 §11: 「评论、@、关注与附件：每个业务对象都有」.

- **One visibility door.** Legal subject types and "who can see / comment /
  follow / attach" are ruled by `apps/api/src/subjects/registry.ts` — one
  registry, one ruling, two readers (comments, activity stream). `task` is the
  first registered subject; business domains register their own loaders with
  their slices. Unregistered type → 400; invisible or missing → 404
  (anti-probe).
- **Audit is the activity stream.** No second event table: every business
  change already lands an audit row in the same transaction, and the
  per-object activity endpoint is a read projection of `audit_events`
  (`docs/audit.md` row→subject convention).

## Attachments (#110 closing slice)

Files hang off **comment rows**, not directly off subjects — a comment is the
collaboration carrier, the file travels with the words. Rulings:

- **The author is the verb owner.** Attach and remove are the same verb family
  as edit/delete: on your own comment only (`403 author_only` for other
  viewers, `404` for outsiders). Visibility is *not* re-expressed: every read
  goes through the same subject door — see the comment, see its attachments.
- **Admission is a closed vocabulary (fail closed):** content-type allowlist
  (png/jpeg/gif/webp, pdf, txt/csv/md, json, doc/xls/ppt families), ≤10 MiB per
  file, ≤5 files per comment, file-name sanity (length/control chars — names
  never enter the storage key). A 400 carries a `code` (`file_too_large`,
  `file_type_not_allowed`, `empty_file`, `invalid_file_name`, `too_many_files`,
  `no_files`); the page says sentences, never codes. The quota is re-counted
  inside the transaction under a row lock, so two concurrent attaches cannot
  both spend the last slot.
- **Storage keys carry zero user input:** `comment-attachments/<commentId>/<uuid>`.
  The original file name lives in `file_name` and is restored at download time
  via the anchor's `download` attribute.
- **Orphan lesson (old BUG-325) ruled away by ordering:** bytes go to the
  bucket first, the row + audit land in one transaction; if the transaction
  fails, staged keys are deleted best-effort (`@ally/storage` gained `delete`).
  A rare surviving orphan is invisible bytes, never a dead row; a reaper cron
  is a later worker slice if the bucket ever needs it.
- **Signed URLs are minted on demand** (`GET …/attachments/:id/url`, 15-min
  TTL) and never ride in list responses — lists get logged, long-lived URLs
  must not travel with logs. The web mints one per download click and restores
  the file name client-side.
- **Attachments are not a new "动静":** no notifications, no follower fan-out
  (same ruling as edits — a supplement is not new news). The
  `comment.attachment_added` / `comment.attachment_removed` audit rows carry the
  subject reference in `detail`, so the activity stream picks them up with zero
  extra wiring. Deleting a comment cascades the rows; its stored objects are
  deleted best-effort after the commit.

## API surface (all session-authenticated, row-level gated)

| Endpoint | Gate | Notes |
| --- | --- | --- |
| `GET /api/comments?subjectType&subjectId` | subject viewer | page + exact total; each row carries `attachments[]` (no URLs) |
| `POST /api/comments` | subject viewer | body + mention parse; mention & follower fan-out in one transaction |
| `PATCH /api/comments/:id` | author | true change only; newly-mentioned people are notified |
| `DELETE /api/comments/:id` | author | rows cascade; storage objects cleaned best-effort |
| `GET /api/comments/:id/attachments` | subject viewer | the list, no URLs |
| `POST /api/comments/:id/attachments` | author | multipart field `files`; admission rules above |
| `GET /api/comments/:id/attachments/:attachmentId/url` | subject viewer | mints the short-lived signed URL |
| `DELETE /api/comments/:id/attachments/:attachmentId` | author | row + audit in one transaction; bytes cleaned best-effort |

## Storage backend

`@ally/storage` speaks the S3 protocol only (AWS S3, MinIO, Aliyun OSS, Tencent
COS) — bucket/credentials come from env via `@ally/config` (`S3_*`, see
`.env.example`). Business code sees the `Storage` interface (put / signedGetUrl
/ signedPutUrl / delete), never the SDK; tests inject an in-memory fake.

## Deliberately not here

- **Orphan reaper cron** — survivors are invisible bytes; add a worker sweep
  only if the bucket ever needs it.
- **Inline preview rendering** — downloads restore the original name; a
  preview face (old BUG-123's preview/download distinction) can come with the
  first domain that needs one, on the same signed-URL endpoint.
- **Attachments outside comments** (e.g. feedback reports' ≤3 images) — lands
  with each owning domain slice on this same seam.
