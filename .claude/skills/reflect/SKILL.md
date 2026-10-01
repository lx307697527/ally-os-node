---
name: reflect
description: The weekly self-evolution loop. Use when asked to "run the reflection", "distill rules from bugs", "review recurring incidents", or as a scheduled Claude Code Routine. Clusters the incident ledger and fix-commit history; recurrences (>=2 same root cause) become rule proposals via PR; also prunes stale rules and pushes active rules up the graduation ladder.
---

# Reflect (self-evolution loop)

Goal: turn recurring failures into durable rules, keep the rule set small and
alive, and push rules toward mechanical enforcement. Output is always **PR
proposals** — reflect never writes rules directly into maps.

## Trigger (FEAT-026 phase 3)

Weekly, on the same pair as `drift-audit`: a scheduled Claude Routine runs this
skill (configured outside the repository), and
`python3 scripts/check_audit_freshness.py` fails when `ops/drift-reports/` has no
`reflect-YYYY-MM-DD.md` inside the 14-day window (its Monday workflow was removed
by [FEAT-679]; run it by hand). The two streams are checked separately on purpose: a repo that
reflects weekly and never audits its maps has a real problem, and averaging them
would hide it.

## Step 1 — Gather

1. Read `ops/incidents/index.yaml` (the ledger) and each incident file.
   Also read `ops/backlog/backlog.yaml` and note any phase with
   `bounce_count >= 3` — repeated PR bounces signal a fuzzy spec or
   under-scoped work; surface these in the report as process (not code)
   findings, separate from bug clusters.
2. `git log --grep='^fix(' --since=<last reflect run>` — cross-check: every
   fix commit should reference a BUG-xxx that exists in the ledger. Fixes
   WITHOUT an incident file are a process leak — list them in the report and
   file a chore to backfill.
3. Read `ops/rules/*.md` (active + proposed rules) and their `last_triggered`.

## Step 2 — Cluster (mechanical first, semantic second)

1. Mechanical pass: group incidents by `(module, root_cause_category)` and by
   `recurrence_of` chains.
2. Semantic pass: for each mechanical cluster of size >=2, READ the full
   incident texts and judge: same underlying root cause, or coincidence of
   category? Also scan across modules for the same mechanism appearing in
   different modules (e.g. state-desync on two different tables) — that is a
   GLOBAL pattern candidate.
3. Honest constraint: this semantic judgment is the one step that cannot be
   made mechanical. Err toward proposing — the human PR review is the filter.

## Step 3 — Propose rules (for each confirmed cluster >=2)

For each, create a branch + PR containing:

1. `ops/rules/RULE-xxx.md` from `docs/zh-CN/templates/rule-template.md`
   (`born_from` lists the incidents; `ladder: prose` initially unless it can
   start higher).
2. The ONE-line rule placed per policy:
   - module-scoped → that module's `CLAUDE.md` Invariants + link.
   - global → root `CLAUDE.md` Global conventions + link. **Check the cap
     (15): if full, the PR must also retire/graduate one.**
3. Answer the graduation question IN the PR description: *"Can this be a
   lint rule / CI check / type instead of prose?"* If yes, include the check
   (script or workflow step) in the same PR and set `ladder: ci-check` —
   prose that can be a machine should be born a machine.
4. Route approval by tier: module rule → module owner (T2); global rule or
   any rule that adds a CI check → CTO (T1), since it touches root map or
   `.github/**`.

## Step 4 — Graduate & prune existing rules

For each ACTIVE rule:
- **Graduate:** can it move up the ladder now? (e.g. a naming convention →
  lint rule; an invariant constant → a type or a CI grep). Propose the move;
  on graduation, REMOVE the prose from CLAUDE.md and replace with
  "enforced by CI: <check-name>". A vitest file is not a CI check since
  [FEAT-666] (CI runs no vitest), so it cannot graduate a rule — and a rule
  whose only machine is one (RULE-012) is a demotion candidate.
- **Prune:** `last_triggered` > 6 months ago, or the guarded code no longer
  exists → propose `status: retired` and removal of its CLAUDE.md line.
- Update `last_triggered` for any rule that demonstrably caught/prevented an
  issue this cycle (evidence: incident avoided, CI check fired).

## Step 5 — Report

Write `ops/drift-reports/reflect-YYYY-MM-DD.md`:

```markdown
# Reflect YYYY-MM-DD
## Incidents since last run: N (M undocumented fixes — backfill filed)
## Clusters found
- (module, category) ×k → RULE-xxx proposed | judged coincidental because ...
## Rule proposals opened: [PR links]
## Graduations proposed / Prunes proposed
## Rule budget: root X/15 global rules
```

Then comment the summary on the open `weekly-audit` issue and tick the `reflect`
box; close the issue once `drift-audit` has run too. Post the summary to the team
channel as well. Keep the whole report under 40 lines.
