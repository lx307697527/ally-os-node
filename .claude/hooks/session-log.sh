#!/usr/bin/env bash
# SessionEnd hook [FEAT-029] — write this session's work log to ops/session-logs/.
#
# Thin on purpose: all logic lives in scripts/write_session_log.py, which has a
# reverse-fixture suite (scripts/tests/test_write_session_log.py). Guard decision
# logic must not live in shell — RULE-002. This wrapper only locates the repo and
# passes the hook payload through on stdin.
#
# Never fails the session: the writer is a logger, not a gate, so a teardown that
# dies here would cost the log AND the clean exit. `|| true` is deliberate and is
# not a RULE-002 fail-open, because nothing is being guarded.
set -uo pipefail
REPO="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
python3 "$REPO/scripts/write_session_log.py" || true
