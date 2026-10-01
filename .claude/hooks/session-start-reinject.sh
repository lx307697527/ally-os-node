#!/usr/bin/env bash
# SessionStart hook: re-inject the harness's hard invariants + the current task
# cursor into context. Plugs the hole where a long or auto-compacted session
# forgets the rules mid-run (current-task.json handles cross-session resume; this
# handles "still in the session but the early context scrolled/compacted away").
# On Claude Code versions that pass source=compact to SessionStart, this also
# fires right after a compaction. Receives hook JSON on stdin (has "source").
#
# Ported from ally-os; invariant wording adapted to this repo (drizzle
# migrations instead of spec-ID'd SQL migrations, GitHub issues instead of the
# ops/backlog file, no test-amendment label gate yet).
STATE_FILE="$CLAUDE_PROJECT_DIR/.claude/state/current-task.json"
FAST_MODE_FILE="$CLAUDE_PROJECT_DIR/.claude/state/harness-fast-mode.json"

if [ -f "$FAST_MODE_FILE" ] && grep -q '"fast_mode"[[:space:]]*:[[:space:]]*true' "$FAST_MODE_FILE" 2>/dev/null; then
  INVARIANTS='HARNESS INVARIANTS (never skip, any autonomy level) — FAST MODE ON (see .claude/state/harness-fast-mode.json): (1) [SUSPENDED while fast_mode=true] failing test before any fix/impl — skip TEST-FIRST/REPRODUCE, go straight to implementation; (2) implementer/you never edit the test-author'"'"'s tests; (3) schema changes only via packages/db/src/schema.ts + pnpm db:generate, never a hand-written migration; (4) same-PR docs-sync (docs/ + AGENTS.md stay accurate with the code they describe); (5) tier declares impact but does not require T1 approval; (6) GitHub issues close only via the PR that lands the work ("Closes #n"), never by a session editing state. [SUSPENDED while fast_mode=true] post-implementation VERIFY gate — do not block on a green suite before COMMIT/PR, but still run lint/typecheck if cheaply available. New task → .claude/skills/task-intake. Full-orchestration build → orchestrator skill (clean context; dispatch, never hand-code).'
else
  INVARIANTS='HARNESS INVARIANTS (never skip, any autonomy level): (1) failing test before any fix/impl; (2) implementer/you never edit the test-author'"'"'s tests; (3) schema changes only via packages/db/src/schema.ts + pnpm db:generate, never a hand-written migration; (4) same-PR docs-sync (docs/ + AGENTS.md stay accurate with the code they describe); (5) tier declares impact but does not require T1 approval; (6) GitHub issues close only via the PR that lands the work ("Closes #n"), never by a session editing state. New task → .claude/skills/task-intake. Full-orchestration build → orchestrator skill (clean context; dispatch, never hand-code).'
fi

if [ -f "$STATE_FILE" ]; then
  CURSOR="Current task cursor (.claude/state/current-task.json): $(tr -d '\n' < "$STATE_FILE")"
else
  CURSOR="No current-task.json — if starting work, run task-intake to set the cursor."
fi

# Emit as SessionStart additionalContext (JSON-escaped).
python3 - "$INVARIANTS" "$CURSOR" << 'PY' 2>/dev/null || exit 0
import json, sys
inv, cursor = sys.argv[1], sys.argv[2]
print(json.dumps({"hookSpecificOutput": {"hookEventName": "SessionStart",
      "additionalContext": inv + "\n" + cursor}}))
PY
exit 0
