# Notifications (in-app bell) — #129

Status: framework landed (slice 4). Producers come with business domains.

## What exists

- **Table** `notifications` (migration 0006): one row = one business event delivered
  to one user (`user_id`, `event_type`, `aggregate_type/aggregate_id`, `payload` jsonb,
  `is_read`, `read_at`, `created_at`). Reads are per-user by construction (every query
  filters `user_id`); there are no DB-level policies — the API is the only writer/reader.
- **Endpoints** (session auth, own rows only):
  - `GET /api/notifications/summary` — the bell's single read (old FEAT-391):
    `{ recent: ≤20 rows desc, unreadCount: min(actual, 21) }`. **21 is a sentinel for
    "more than 20"**, not a count — the badge prints `20+` and counting exactly would
    be a wasted query (old ruling).
  - `POST /api/notifications/:id/read` — **another user's id is a silent no-op
    (200 `{marked:0}`)**: no existence oracle, old RPC anti-probe ruling. Malformed
    id → 400.
  - `POST /api/notifications/read-all` → `{marked: n}`.
- **Frontend** `apps/web`: `NotificationBell` in the shell header (a `ReactNode` slot —
  the shell still fetches nothing), adapters in `notifications-client.ts` (zod-validated,
  every failure degrades to `null` = keep last good state), pure display in
  `notification-face.ts`, 60s visible-poll via `use-visible-poll.ts`.

## Rulings kept from the old system

- **Polling, not a subscription** — 60s, visible tabs only (hidden tabs stop, return
  catches up immediately). The realtime bus (#30) has no notifications publisher; when
  business domains land one, the bell MAY move to push — until then this is the mechanism.
- **A failed read is not zero** — a failed summary keeps the last state on screen and
  says so in the panel.
- **Writes re-read from the server** — mark-read/mark-all never clear locally.
- **Display text lives in TS, not the DB** — `describeNotification` is the fallback face
  (`payload.title`/`payload.detail`, else the raw `event_type`, `href: null`). The
  per-event whitelist + deep links arrive with the first producer.

## Producer seam (open, by design)

Old system: business RPCs wrote `core.outbox`, an AFTER INSERT trigger fanned out to
per-user rows from an event-type whitelist, idempotent on `(user_id, outbox_id)`. The
new system has no outbox yet. When the first business domain needs a bell entry:
add the fan-out (pg-boss job or inline insert), add `outbox_id` + the unique index
(expand-only migration), extend `describeNotification` + its whitelist test.
