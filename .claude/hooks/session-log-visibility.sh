#!/usr/bin/env bash
# [FEAT-040 phase 2] SessionStart hook: say which session logs are still only
# half written, and which have never reached git.
#
# Thin on purpose. Every decision — what counts as an unwritten judgment layer,
# what counts as untracked, and which failures are preconditions rather than
# findings — lives in scripts/check_session_logs.py, where the reverse-fixture
# suite (scripts/tests/test_check_session_logs.py) can reach it. RULE-002 check 4
# exists because guard logic in untested shell produced BUG-010 and BUG-017.
#
# Receives hook JSON on stdin; unused, and deliberately not drained — the Python
# side takes no input and a `cat` here would only add a way to hang.
#
# NEVER FAILS THE SESSION. `|| true` is not a RULE-002 fail-open: nothing is
# being guarded. This is a notice, and a SessionStart hook that exits non-zero
# breaks EVERY session in every container — a far larger failure than the one it
# would be reporting. The script's own exit 2 (repository unreadable) still
# prints its reason, which is the part a human acts on.
set -uo pipefail
HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$HOOK_DIR/../.." && pwd)}"
python3 "$REPO_ROOT/scripts/check_session_logs.py" --repo "$REPO_ROOT" || true
