# Notifications (in-app bell + channels) — #129 / #116

Status: framework landed (slice 4); channel layer landed (email digest). Producers come with business domains.

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
  - `GET|PUT /api/notifications/preferences` (#116) — the per-user channel layer.
    `PUT` is full replacement with a strict body `{emailDigest: boolean}` (unknown keys
    → 400); a user with no row reads the default (`{emailDigest: false, updatedAt: null}`)
    and no row is written until they first save. Own-row data plane, same as the bell
    endpoints: no permission point, no audit (personal delivery preference, not a
    governance object).
- **Frontend** `apps/web`: `NotificationBell` in the shell header (a `ReactNode` slot —
  the shell still fetches nothing), adapters in `notifications-client.ts` (zod-validated,
  every failure degrades to `null` = keep last good state), pure display in
  `notification-face.ts`, 60s visible-poll via `use-visible-poll.ts`.
- **Channel layer** (#116): in-app (write + realtime bell) is the notification itself
  and is always on; `notification_preferences` (migration 0025) registers the EXTRA
  channels — the first is the **daily email digest**, a worker job
  (`notifications-digest`, 13:30 UTC = 9:30 AM US Eastern, staggered 30 min after the
  rules reminder):
  - Rows carry `digest_sent_at` (0025, expand-only) — a delivery ledger. A row is
    emailed **at most once**: the scan picks unread + never-digested rows for users
    with `email_digest = true`, sends one email per user, and stamps only the rows it
    LISTED (cap 50; the email reports the true total and says "… and N more"). Tomorrow's
    scan picks up the unlisted remainder — nothing is silently dropped, nothing is
    re-read aloud.
  - In-app read state does not affect the digest — email is the "don't miss it"
    backstop, not a projection of read state.
  - Per-user failure isolation: one user's send failure doesn't block others; the job
    then throws so pg-boss retries — stamped users are skipped, the retry only refills
    the failures.
  - Email copy is rendered from the row's FACTS (event type + `payload` fact fields +
    time), not from a server-side copy of the bell's face map — the digest email is one
    consumer surface; duplicating `describeNotification` server-side would be a second
    truth to drift. Per-item deep links wait for the shared face package (with #115's
    Slack channel, which needs the same copy).
  - Mailer lives in `@ally/mailer` (sunk from apps/api when the worker became the second
    consumer — same move as the automations kernel). Unconfigured `RESEND_API_KEY` =
    logging mode, so a dev deployment "sends" digests into the worker log.
  - Frontend: `/settings/notifications` (`NotificationSettings.tsx`) with the entry link
    in the bell dropdown footer; adapters in `notification-preferences-client.ts` (same
    never-throw, `null`-on-failure discipline).
- **Live push** (#110 slice 2): `notification-live.ts` (built by the composition root,
  passed to the bell as the `live` prop) holds one WebSocket per tab, subscribed to the
  signed-in user's private `user:<id>` channel. A `notifications.changed` nudge — or a
  reconnect `resync` — just re-runs the same summary read. Producers publish the nudge
  through `AppDeps.notifyUsers` **after** the insert transaction commits.

## Rulings kept from the old system

- **Push is the trigger, the poll is the fallback** (#110 slice 2 revised the #129
  ruling) — the realtime nudge is the primary refresh trigger, and the 60s visible-poll
  STAYS: delivery is at-most-once (docs/realtime.md), so what a dead socket or a lost
  NOTIFY drops, the poll catches up. Hidden tabs still pause the poll but receive pushes.
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

The three producers so far (`task.assigned` in routes/tasks.ts, `comment.mentioned`
and the follower fan-out `comment.created` in routes/comments.ts — the latter
delivered to the subject's followers (#110 slice 4), minus the author, minus the
already-mentioned, and only while the follower is still a viewer) insert inline
inside the business transaction and then call
`deps.notifyUsers(userIds)` after it commits — the realtime nudge (see docs/realtime.md,
`user:` channels). New producers follow the same two-step shape; `notifyUsers` is
contracted to never reject, so a realtime outage degrades to the poll, never fails the
business request.
