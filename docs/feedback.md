# Feedback reports — #129

Status: submit path landed (slice 4, old FEAT-198). Queue/management is a later slice.

## What exists

- **Table** `feedback_reports` (migration 0006): `report_number` (`BR-` + 8 hex, unique,
  re-rolled on collision), `type` / `priority` / `status` pgEnums with the old CHECK
  vocabularies verbatim (`bug_report|feature_request|process_gap` ×
  `low|medium|high|critical` × `pending|in_review|resolved|closed`), the report text,
  and the **submitter snapshot** (`submitted_by_user_id` + name/email at submit time —
  later profile changes don't rewrite history).
- **Endpoint** `POST /api/feedback-reports` (session auth): the submitter is resolved
  from the session, never from the body (old RPC ruling). The API accepts the two FORM
  types only — `process_gap` is filed by the feedback AI assistant (FEAT-775), an
  extension that hasn't ported. Limits mirror the old CHECKs: title ≤200,
  description ≤5000, steps ≤5000.

## What is deliberately NOT here yet

- **Attachments** (old: ≤3 images ≤5MiB in a private bucket, keyed by submitter) —
  needs `@ally/storage`; column + endpoint field land expand-only.
- **Admin queue** (`/feedback-reports` page, `update_feedback_report` status flow,
  GitHub issue sync + reaper crons) — management domain.
- **Fan-out notification** to admins on submit (old FEAT-637) — needs the
  notifications producer seam (see docs/notifications.md).

## Frontend

`FeedbackDialog` (opened from the session menu) with testids `fb-form`,
`fb-field-*`, `fb-submit`, `fb-error`, `fb-done`, `fb-number` — the old form's ids.
Validation is duplicated ONCE in `feedback-draft.ts` (pure; the API's zod remains the
real gate — the form's copy exists to say WHERE the problem is, immediately).
