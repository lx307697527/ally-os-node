---
name: bug-fix
description: The mandatory workflow for fixing bugs, defects, regressions, or "X is broken / not working / wrong output" reports. Use whenever the user reports incorrect behavior, pastes an error, or asks to fix something — even if they don't say "bug". Do NOT use for new features or behavior changes (use feature-dev).
---

# Bug Fix State Machine

```
EXPLORE → REPRODUCE → ROOT CAUSE → FIX → REGRESSION → SPEC BACKFILL → COMMIT
```

**The prime directive: no failing reproduction test, no code change.**
If you cannot reproduce the bug in a test, you do not understand it yet, and
"fixing" it would be guessing. (Suspended while
`.claude/state/harness-fast-mode.json` has `fast_mode: true` — see State 2.
Understanding the bug is still required; only the test artifact is optional.)

## State 1 — EXPLORE

Same discipline as feature-dev: root map → module map → key files. Also check:
- `ops/incidents/` for similar past bugs (recurring bug = systemic problem).
- The spec (`ops/specs/`) that defined the intended behavior — the bug is a
  divergence from *spec*, not from your imagination of what it should do.

If information is missing to reproduce (exact input, environment, expected vs
actual), ask the user — with defaults, max 3 rounds, same as feature-dev.

## State 2 — REPRODUCE (mandatory failing test)

**Fast-mode check first:** read `.claude/state/harness-fast-mode.json`. If
`fast_mode: true`, this state is suspended (see that file + issue #1812) —
instead just describe the reproduction (input, expected vs actual) in the
incident file, set `test_status: skipped`, and move to ROOT CAUSE without a
test. This is a deliberate, tracked, reversible override, not license to skip
understanding the bug.

Write a test that fails because of the bug. Run it; confirm it fails for the
reported reason. If the bug only manifests in E2E, write the Playwright spec
and confirm locally-runnable status with the user.

## State 3 — ROOT CAUSE

Allocate `BUG-xxx` with `python3 scripts/claim_spec_id.py --kind bug`, which
reserves it on the remote before returning it and exits 2 rather than hand back a
number it could not claim [FEAT-116]. If task-intake already claimed one, use
that — do not take a second. **Do not read the remote's highest number and add
one**: that is a guess, not a reservation, and `check_spec_id_allocated.py`
(pre-push) reddens an added `ops/incidents/BUG-xxx*.md` whose `spec/BUG-xxx`
tag does not exist [FEAT-116 p4]. Then write
`ops/incidents/BUG-xxx-<slug>.md` from `docs/zh-CN/templates/bug-template.md` —
the frontmatter is MANDATORY and machine-read: `module`,
`root_cause_category` (from the allowed enum), `recurrence_of`. Then:
1. Append the matching entry to `ops/incidents/index.yaml`
   (`harness check incident-ledger` validates ledger<->file consistency; no CI
   job runs it since [FEAT-679]).
   **This step is not optional and is no longer only advisory** [FEAT-481 /
   #3190]: `check_fix_commit_bug_ids.py` (pre-push) refuses a
   branch whose `fix` commit subject cites a `[BUG-xxx]` that this file cannot
   resolve. Seven ids since 2026-09-07 had no row — four because the work went
   to an `ops/specs/BUG-xxx-…/` directory INSTEAD of the ledger (a spec dir is
   a supplement, never a substitute), two because it went nowhere, and one
   because the "id" was a GitHub issue number (`[BUG-3178]`). A missing row
   hides that fix's root cause from `reflect`'s clustering, so it can never
   become a rule — which is the whole reason the ledger exists.
2. Recurrence check: search the ledger for the same (module, category) or the
   same mechanism elsewhere. If found, set `recurrence_of: BUG-yyy` — this is
   the signal the weekly `reflect` skill clusters on to propose a rule.
Distinguish:
- **Implementation bug** — code diverged from spec → fix code.
- **Spec bug** — spec was wrong or silent → this needs user confirmation of
  the intended behavior BEFORE fixing, then a spec update.

## State 4 — FIX

Minimal change that fixes the reported behavior (makes the reproduction test
pass, when one exists — see State 2's fast-mode note). Resist drive-by
refactors — if you spot unrelated debt, note it in the incident file instead.

## State 5 — REGRESSION

**Fast-mode check first:** if `.claude/state/harness-fast-mode.json` has
`fast_mode: true`, this state's test-suite run is suspended — do a quick
lint/typecheck pass instead and move to SPEC BACKFILL. Otherwise:

Run the module's full test suite plus any suites for modules listed as
dependents in the module maps. The reproduction test stays in the suite
permanently — it is now the regression guard for this bug.

## State 6 — SPEC BACKFILL (docs-sync for bugs)

- If ROOT CAUSE was a spec bug: update the relevant `ops/specs/FEAT-xxx/prd.md`
  acceptance criteria in the same PR.
- If the module map's stated invariants were wrong or incomplete: fix them.
- Link the incident file from the PR.

## State 7 — COMMIT

PR base is `develop` (`gh pr create --base develop`) [FEAT-683]. Only a fix
production cannot wait a day for goes `hotfix/*` → `main`: cut it from main
(`git checkout -B hotfix/<name> origin/main`), and after it merges, merge the
`main -> develop` back-merge PR the release train opens (merge commit).

Use the `commit` skill with `fix(...)` type and `[BUG-xxx]` ID. PR must link
the incident note, and show the reproduction test in the diff — unless State 2
ran in fast-mode, in which case note that in the PR body instead.
