# Session state

`current-task.json` is this machine's live cursor into the state machine —
which spec, which state, red/green, which phase, autonomy level. It is
**gitignored on purpose**: it's local session recovery, not shared truth.

Written at every state transition by feature-dev / bug-fix. Read by task-intake
at session start to offer resuming an interrupted task instead of restarting
from EXPLORE.

Create it from `current-task.template.json`. If it's ever corrupt or stale,
delete it — the backlog + spec files + git branch still hold the durable state.

v3.4 adds `build_mode` (lightweight | full), and, during a full-orchestration
build, `layer`, `layer_attempts`, and `review_bounces` — the in-session loop
budgets the orchestrator tracks (distinct from the backlog's PR-level
`bounce_count`).

`harness-fast-mode.json` is the opposite kind of file: **tracked, not
gitignored** — a repo-wide switch, same pattern as CI's `CI_PAUSED` variable.
When `fast_mode` is `true`, the TEST-FIRST/REPRODUCE state and the
post-implementation VERIFY/test-runner gate are skipped across every
session (see `harness-fast-mode.json` itself and issue #1812 for scope and
cost). Restore by setting `fast_mode` back to `false` or deleting the file.
