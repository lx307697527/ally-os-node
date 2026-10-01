---
name: drift-audit
description: Weekly documentation-vs-code drift audit. Use when asked to "run the drift audit", "check doc drift", "audit the code maps", or as a scheduled Claude Code Routine. Compares every CLAUDE.md map and spec against actual code and produces a drift report.
---

# Drift Audit

Goal: find places where the maps/specs lie about the code, before they mislead
a future session.

## Trigger (FEAT-026 phase 3)

Weekly, from two halves that only work together:

- **The actor** — a scheduled Claude Routine runs this skill and commits its
  report. It is configured in the CTO's Claude account, not in this repository.
- **The evidence** — `python3 scripts/check_audit_freshness.py` fails when
  `ops/drift-reports/` holds no report inside the 14-day window. It used to run
  every Monday from `weekly-audit.yml`'s `audit-due` job; that job was removed by
  [FEAT-679] (owner request, 2026-09-23) after four red Mondays in a row that
  nobody acted on, so a paused Routine is now noticed only by running the guard.

Run it by hand any time (`/drift-audit`, or "run the drift audit"). A hand-run
report satisfies the freshness guard exactly like a Routine-run one — the guard
deliberately checks that the audit happened, not who did it.

## Procedure

1. **Enumerate maps.** Root `CLAUDE.md` module index + every
   `src/modules/*/CLAUDE.md` + `supabase/CLAUDE.md`.
2. **Per module, verify (delegate to `explorer` subagent per module to keep
   context small):**
   - Every file listed under "Key files" exists; flag listed-but-deleted and
     significant new files not mentioned.
   - Every declared public interface still exists with a matching signature.
   - Each declared invariant — spot-check it still holds in code
     (e.g. "setup fee fixed at $4000" → grep the constant).
   - Module one-liner in the root index still matches reality.
3. **Database:** compare `supabase/TABLE-INDEX.md` (the full index this map's
   capsule points at — extracted from `supabase/CLAUDE.md` by FEAT-065 p1)
   against actual migrations. Flag tables present in migrations but missing
   from the index, and vice versa.
4. **Specs — the spec↔test contract.** For every spec whose `prd.md` frontmatter
   says `status: implemented` or `partial`, walk **every** row of its root
   `testplan.md` (not a sample) and confirm the named test still exists and still
   passes. Report a declared-but-missing test as **critical** drift: the spec
   claims a criterion is proven when nothing proves it.

   **This is now the only place that contract is verified.** A CI guard
   (`verify_ac_coverage.py`) used to match every declared name against the vitest
   JSON report at build time; FEAT-026 retired it after it twice produced false
   failures on correct suites (BUG-008, BUG-016) — matching prose test titles
   across three file formats broke more often than the contract it protected. The
   property is still worth having, so it moved here: weekly, human-read, and free
   to use judgment about a renamed-but-equivalent test instead of turning `main`
   red over a backtick. Do not skip this step because it is tedious; it is the
   whole reason the gate could be removed.

   Scope note: rows whose Level is `sql` (pgTAP), `deno`, `e2e`/`local`, or `ops`
   run in their own gates. Check that the named test exists; do not try to execute
   e2e locally as part of the audit.

5. **Specs — parked work.** Scan `ops/specs/**/*.md` for markers that defer work:
   `deferred`, `before go-live` / `上线前`, `follow-up`. Each must name where the
   work is tracked (a `FEAT-xxx` / `BUG-xxx` reference). Report an untracked
   marker as **minor** drift — it is how scope silently rots. Judgment applies:
   descriptive prose that merely uses the word "deferred" without parking any
   actual work is not a finding. A CI guard used to enforce this (retired in
   FEAT-026). It flagged any marker line lacking a backlog reference and not
   present in a hand-maintained allowlist — which meant it could not tell a parked
   commitment from a sentence *about* parked commitments, and in the end it
   reported 16 violations against the very spec that retired it. You can tell
   those apart. That judgement is the whole reason this step replaced the gate.

6. **Report.** Write `ops/drift-reports/YYYY-MM-DD.md`:

```markdown
# Drift Report YYYY-MM-DD
## Summary: N issues (X critical / Y minor)
## Critical (map actively wrong — will mislead)
- [module] claim → reality → suggested fix
## Minor (stale but not misleading)
- ...
## Clean modules
- ...
```

7. **Fix or file.** Minor drift: fix the docs directly in a `docs(...)` commit
   on a branch + PR. Critical drift (code may be wrong rather than docs):
   do NOT silently pick a side — open an issue and flag to the team.
8. **Close the loop.** Comment the summary on the open `weekly-audit` issue and
   tick the `drift-audit` box, then close the issue once `reflect` has run too —
   that issue is the week's checklist, and an unclosed one is the signal the
   cadence slipped. Post the summary to the team channel as well.
