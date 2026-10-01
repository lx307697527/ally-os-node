---
name: feature-dev
description: The mandatory end-to-end workflow for any new feature, enhancement, or non-trivial change request. Use this skill whenever the user gives a development requirement, asks to build/add/change functionality, or pastes a request from Slack — even if they don't say "feature" or "spec". Run task-intake FIRST. Do NOT use for bug fixes (use bug-fix) or trivial typo-level edits.
---

# Feature Development State Machine (v2)

Precondition: `task-intake` has run — spec ID allocated, autonomy level set,
`.claude/state/current-task.json` initialized.

```
EXPLORE → CLARIFY → SPEC → SIZE&DECOMPOSE → [RISK CHECKPOINT] → PLAN → TEST-FIRST
        → [BUILD-MODE SELECT]
             ├─ lightweight: IMPLEMENT → VERIFY --fail--> FAILURE-HANDLING
             └─ full:        orchestrator (implement↔run-tests↔review loop)
        → DOCS-SYNC → COMMIT → PHASE-LOOP
```

The build middle (getting from red tests to green + reviewed) runs one of two
ways; everything before (intake→spec→approval) and after (docs-sync→commit→
close-out) is identical either way. Mode is chosen at BUILD-MODE SELECT below.

## State persistence (do this at EVERY transition)

After entering each state, update `.claude/state/current-task.json`:
`state`, `test_status` (unknown|red|green), `phase`, `updated`. This is what
lets a killed session resume instead of restarting. The file is local and
gitignored; shared/cross-machine state lives in the committed backlog + spec +
git branch.

## Autonomy behavior (set by task-intake)

- **L1**: CLARIFY asks interactively; the user-facing checkpoint is a hard stop.
- **L2**: at end of SIZE&DECOMPOSE, present ONE combined checkpoint — all
  clarifications, the spec, and the decomposition — get a single approval, then
  run uninterrupted to PR.
- **L3**: skip the user-facing checkpoint; only pause if genuinely blocked; run to PR.
Regardless of level, the hard invariants below are never skipped — the sole
exception is TEST-FIRST/VERIFY, which the repo-wide
`.claude/state/harness-fast-mode.json` switch can suspend for everyone (see
States 7 and 9 below, and issue #1812). Autonomy level itself never bypasses
anything; only that switch does.

Orchestrated builds (full mode) run **after** the risk checkpoint: the
implement↔test↔review loop proceeds without human input up to its loop budgets,
then escalates. This is identical across L1/L2/L3 — the human control point is
the gate, not the inner loop.

---

## State 1 — EXPLORE (read before you ask)
Asking before reading is forbidden. **Fact layer first:** if a code-graph MCP
server is configured (`docs/zh-CN/CODE-INTELLIGENCE.md`), query it for the area's call
paths and blast radius before reading files — it answers "what connects to this"
mechanically. Then the intent layer: root `CLAUDE.md` -> module map(s) -> only the
pointed-to files. Heavy exploration (>5 files) -> `explorer` subagent, receive a
summary (which now includes a blast-radius section). Produce a **Current-State
Summary** (5-15 lines): how it works today, relevant invariants, what the request
changes.

**If this task will touch a T1 path or a core table** (`ops/rules/core-tables.txt`):
work out the impact set NOW and carry it into SPEC — knowing it before you design
is the point. Which method depends on what you are changing, because the graph
indexes `.ts/.tsx/.py/...` and **0 of this repo's 176 `.sql` files** [FEAT-030]:
- code in a graph-indexed language → run `codegraph impact` / `codegraph affected`
  and design from the real output;
- **a core-table migration (SQL-only)** → the graph cannot see it at all, so carry
  the **SQL-side** verification (migration fact-check / pgTAP contract / consumer
  surface). Do not write "graph unavailable" for it;
- graph genuinely down → carry the reason *and* the method you used instead.

**Not machine-enforced since [FEAT-546]**, and nothing is pasted. Nothing posts
it on the pull request either since [FEAT-679] deleted the `blast-radius-report`
job: query the graph on demand with
`python3 scripts/report_blast_radius.py --changed <files>` or the codegraph MCP.
design.md carries only what no graph shows — the SQL-side impact and
string-read consumers. Background:
`docs/zh-CN/CODE-INTELLIGENCE.md` → 影响范围记录契约.

## State 2 — CLARIFY (<=3 rounds)
Every question carries its own default ("if you don't answer, I assume X").
Split into requirement-ambiguity (ask) vs technical-choice (propose A/B,
recommend). At L2, do NOT ask yet — collect questions and carry them to the
combined checkpoint. Cap 3 rounds; record defaults in the spec's Assumptions.

## State 3 — SPEC
Create `ops/specs/FEAT-xxx-<slug>/` from `docs/zh-CN/templates/`. **All three
artifacts below are REQUIRED — a spec dir missing any of them is incomplete and
is rejected by `scripts/validate_specs.py`** (diff-scoped with `--changed`: it
fires on any spec dir your change touches; no CI job runs it since [FEAT-679],
and `scripts/hooks/pre-push` does since p4). Write all three at SPEC time, not
"prd/testplan later":
- **prd.md** — background, user stories, Gherkin acceptance criteria, wireframes
  (Mermaid/ASCII inline; `prototype.html` if high-fidelity requested).
- **design.md** — affected modules table, an **Impact / blast radius** section
  (one of the three branches from EXPLORE above — a real query result, an SQL-side
  method, or a reason-plus-fallback record; a bare "graph unavailable" is not a
  record [FEAT-030] — no guard has judged it since [FEAT-546], so the reviewer
  does), mandatory Schema Changes section if any migration, API
  contracts, Mermaid sequence, ADR link if architectural.
- **testplan.md** — every AC maps to >=1 named test case. **Every governed-RPC
  client wrapper you add/touch (`src/modules/*/rpc.ts`, `apps/*/src/lib/*-actions.ts`)
  MUST get at least one `unit`-level row** for its boundary contract (schema/RPC
  name + `p_*` mapping + typed `Result`), not only a `sql`/pgTAP row — declaring
  only the pgTAP row is what let wrappers rot to 0% coverage (FEAT-025). Nothing
  backs this row up mechanically any more: the per-diff coverage gate
  (`scripts/diff_coverage.py`, ≥80% of changed `src/**` lines) and the mutation
  gate left CI with the unit tests [FEAT-666], so an un-tested wrapper now reaches
  `main` unless review catches it.
- **design.md must declare the Decision Tier** (T1/T2/T3 — see the template's
  definitions). When ambiguous, classify UP. The tier records impact and review
  routing; it never creates an approval requirement before merge.

## State 4 — SIZE & DECOMPOSE (NEW — the "auto-split" state)

Estimate scope from the spec — coarse is fine, the goal is to trigger splitting,
not to be precise:

- Count: affected modules, acceptance criteria, schema changes, roughly how many
  files will be touched.
- Apply the split thresholds:

| Signal | Single phase | Must decompose |
|---|---|---|
| Modules touched | <=2 | >=3 |
| Acceptance criteria | <=5 | >=6 |
| Schema migrations | <=1 | >=2 |
| Est. files touched | <=~10 | >~10 |

If ANY "must decompose" signal trips, split into **independently shippable
phases**. Core rule: **each phase must fit in one context window and end in its
own commit/PR.** This — not estimate accuracy — is the real safety net: a wrong
estimate then costs at most one phase, never the whole epic.

When a phase carries its own artifacts under `phases/`
(`phase-N-{prd,design,testplan}.md`, authoritative for multi-phase epics),
**its design.md follows the same Impact / blast radius convention as the root
one** — what the graph cannot show, scoped to the symbols that phase changes.
No guard judges it [FEAT-546], and since [FEAT-679] no PR job computes the
import-graph half either — for the files that phase touches, run
`python3 scripts/report_blast_radius.py --changed <files>` or ask the codegraph MCP.

Record the phase breakdown on the **backlog issues** side [FEAT-055]
(`ops/backlog/backlog.yaml` is the frozen archive — never write it):
- The epic milestone is **already there** — the allocator created it when the id
  was claimed, titled with the bare id (`FEAT-171`) [FEAT-171 p2]. **Do not create
  another**: milestone-title uniqueness is byte-exact (measured), so
  `FEAT-171 — <title>` is a DIFFERENT title, GitHub accepts it, and the id ends up
  with two milestones — one holding the lock and one holding the issues. Put the
  human-readable title in that milestone's **description** instead, and **never
  rename the title**, or the number can be claimed a second time:
  `gh api -X PATCH repos/{owner}/{repo}/milestones/<n> -f description='<title>'`.
  Attach phase issues with `--milestone "FEAT-171"`. Milestones predating
  [FEAT-171] keep their `<ID> — <title>` titles and are left alone.
- One issue per phase under it: title `FEAT-xxx · pN — <title>`, labels
  `backlog` + `status:in-progress` (phase 1) / `status:pending` (rest), body
  section `depends_on` listing the phase numbers (or the blocking issue #s).
  **Both halves are read by three consumers** — the merge Action's
  `match_issues()`, the reconciliation guard's `issue_claim()` and
  `check_stranded_phases`. Get either wrong and the Action never writes `done`;
  `scripts/tests/test_intake_issue_shape.py` pins this template against all
  three so it and task-intake's cannot drift apart again [FEAT-477]. A human
  grouping (`D 档`, `批 2`) goes AFTER the em dash — `· pN` is the only thing
  that may sit in that slot (FEAT-416's `· D 档 ·` issues match nothing).
  **Issue body is bilingual** (repo rule, 2026-08-23 — 中文 + English per
  section; same rule as PR bodies).

Then proceed with **phase 1 only**. Remaining phases stay in the backlog for
future sessions (task-intake will resurface them).

**Branch strategy for dependent phases (solves "can't pull unmerged code"):**
a phase whose `depends_on` is non-empty must branch off the branch of the phase
it depends on, NOT off `develop` — because the dependency's code isn't on
`develop` until it merges. So phase 2 (`depends_on: [1]`) branches from phase 1's
branch (a stacked PR). Only phases with empty `depends_on` branch from `develop`
(the integration branch since [FEAT-683]; `main` receives only the daily release
and `hotfix/*`). This is
why phases can proceed in parallel without waiting for merges, while backlog
status still reflects reality via `in_review`.

If nothing trips a threshold: record it as a single-phase item in the backlog
anyway (phase 1, `in_progress`). It still gets closed out the same way — DOCS-SYNC
marks the phase AND the epic `done`. A task that isn't in the backlog can't be
reported as done, so every task lands there, even one-phase ones.

## State 5 — RISK CHECKPOINT (routed by tier x autonomy)

The tier from design.md determines the impact record and advisory review routing;
it does not decide who must approve. **No tier requires human approval before
merge**. L1/L2 retain their user-facing product checkpoints, while L3 continues
unless genuinely blocked.

| Tier | Required record | Merge policy |
|---|---|---|
| T1 system | explicit impact / blast-radius disclosure | author may merge after required checks pass |
| T2 module | module impact and owner routing | author may merge after required checks pass |
| T3 routine | normal spec and test evidence | author may merge after required checks pass |

Phases inherit the epic's tier unless a phase independently trips a T1 trigger
(e.g. phase 3 adds a core-table migration), in which case it needs the T1 impact
record. CODEOWNERS remains an advisory review request; required checks remain
the mechanical merge floor.

## State 6 — PLAN
Ordered steps for THIS phase only (migration -> backend -> frontend -> wiring),
each independently verifiable. List which module maps will need updating.

## State 7 — TEST-FIRST (delegated — referee/player separation)
**Fast-mode check first:** read `.claude/state/harness-fast-mode.json`. If
`fast_mode: true`, this whole state and State 9's test-gate are suspended
(see that file + issue #1812 for scope/cost) — set `test_status: skipped` and
go straight to BUILD-MODE SELECT / IMPLEMENT. Still run lint/typecheck/LSP
diagnostics where cheaply available; nothing else in this skill changes.

Do NOT write these tests yourself. Delegate to the **test-author** subagent,
passing ONLY the spec directory path and the affected modules' CLAUDE.md paths
— never your implementation plan. It writes the failing tests from the
contract, confirms red for the right reason, and commits with the anchor
message `test(<module>): add failing tests for [FEAT-xxx]`. Set
`test_status: red`. From this point you may not edit those test files; if an
amendment is truly needed (spec changed, broken fixture), it requires the
`test-amended` label + reviewer sign-off (CI-enforced), and at L2/L3 this is
one of the few legitimate reasons to pause and ask.

## State 7b — BUILD-MODE SELECT (NEW in v3.4)
The failing tests exist (red). Choose how to get to green + reviewed:

| Choose **full-orchestration** if ANY holds | Otherwise **lightweight** |
|---|---|
| this phase touches ≥2 modules | single small module |
| ≥3 layers of tests to satisfy (unit+integration+e2e) | mostly one layer |
| you expect several implement↔test↔review rounds | a near-mechanical change |

- **full-orchestration →** hand the build to the `orchestrator` skill. It runs
  the layered implement↔run-tests↔review loop via the `implementer`,
  `test-runner`, and `reviewer` subagents, with in-session loop budgets, and
  returns to you **green + approved**. Then skip straight to State 10 DOCS-SYNC.
  (You keep a clean context; the orchestrator holds the build state.)
- **lightweight →** do States 8–9 inline yourself (below), then State 10.

Don't over-engineer: a typo-level or one-file change must NOT be orchestrated —
the dispatch overhead dwarfs the work. Record the chosen mode in
`.claude/state/current-task.json`. Either way, the hard invariants and the
referee/player split (you never edit the test-author's tests) are identical.

## State 8 — IMPLEMENT (lightweight mode)
Make tests pass (green -> `test_status: green`), then refactor. **Diagnostics
loop (cheap before expensive):** after each edit, if an LSP MCP tool is
available, check diagnostics for the changed files and clear type/unresolved-
symbol errors *before* running the suite — never spend a (slow) test run on code
that doesn't type-check. Hard invariants: schema changes ONLY via migration
(header comment references spec ID); never violate a module-map invariant (if one
must change, that's a spec change -> back to the user regardless of autonomy).

## State 9 — VERIFY (lightweight mode)
**Fast-mode check first:** if `.claude/state/harness-fast-mode.json` has
`fast_mode: true`, this state's test-suite gate is suspended — run
lint/typecheck/LSP diagnostics only (still worth doing, still cheap), skip
straight to `reviewer`, and note in the state file that VERIFY ran in
fast-mode (`test_status: skipped`). Otherwise, proceed as below.

**Pre-test gate:** if an LSP tool is available, the diff must be diagnostics-clean
(zero new type errors / unresolved symbols) before the suite runs — a fast filter
in front of slow tests. Then the full relevant suite + lint. Walk this phase's
ACs, state pass/fail each.

> **测试运行策略见 `.claude/test-strategy.md`**：本地只跑与改动相关的
> （vitest `<glob>` + 相关 pgTAP 文件 + 改动文件 eslint），pgTAP 与 lint 的全量留给 CI
> （PR 上 db-contracts 跑 pgTAP、unit 跑 `pnpm run lint`；vitest 自 [FEAT-666] 起
> 哪里都不自动跑）。worktree 先
> `pnpm install`；rebase/pull 后先 `supabase db reset` 再跑 pgTAP（避免
> 本地 DB 陈旧的假红）。提交前补一次 `harness check --all --changed`。

- All pass -> invoke `reviewer` on the diff (same as full mode does in-loop, just
  once here); address blocking items, re-verify -> DOCS-SYNC.
- Any fail -> FAILURE-HANDLING.

(In full-orchestration mode you don't run this state — the orchestrator already
returned green + approved; go straight to DOCS-SYNC.)

## State 9b — FAILURE-HANDLING (NEW — the unhappy path)
1. Retry with diagnosis (read the failure, form a hypothesis, fix) — max 2
   attempts.
2. Still failing -> **stop and escalate**, don't thrash: write what's failing,
   the hypotheses tried, and the suspected cause into the state file and to the
   user. Flip the phase issue to `status:blocked` and post the reason as an
   issue comment [FEAT-055].
3. Weakening or editing the test-author's tests to force green is both
   forbidden AND mechanically caught (test-amendment guard). Never leave the
   branch broken-but-committed; if aborting, note the last-good commit.

## State 10 — DOCS-SYNC (same PR, non-negotiable, all autonomy levels)
The backlog is state too — it syncs here, in the SAME PR, exactly like the maps.
1. Update touched module `CLAUDE.md`(s) (only what actually changed), regenerate
   generated docs if schema/API changed, update root module index if needed.
2. Set `prd.md` frontmatter `status: implemented` (or `partial` if more phases
   remain).
3. **Move THIS phase to `status:in-review`** on its backlog issue [FEAT-055]
   (`gh issue edit <n> --remove-label status:in-progress --add-label status:in-review`):
   - In-review, NOT done. Local work is done; the PR is open; but it isn't
     merged, so it isn't `done` yet.
   - Do NOT close the issue — closing is the merge Action's job
     (`backlog-close`, invariant 6's issue form), so closed always equals
     "on main". Since [FEAT-683] a merge into `develop` moves it to
     `status:awaiting-release`; the daily release's merge into main closes it.
   - The epic milestone closes automatically when its last phase issue closes.

## State 11 — COMMIT
Invoke `commit` skill; commits carry `[FEAT-xxx]`. Open the PR via the template,
**against `develop`** — `gh pr create --base develop` [FEAT-683]; only a
`hotfix/*` branch targets `main`, and the daily `release -> main` PR is never a
session's to open, approve or merge (root `CLAUDE.md` § 分支与上线):
the **PR title** must be `<type>(<scope>): <summary> [FEAT-xxx] phase N` (the
merge Action and squash-merge both key on it), the **Summary** section must be
2-4 prose sentences, and fill the AC checklist from VERIFY. A PR title without a
spec ID won't auto-close the backlog (it gets `backlog-unlinked`).

## State 12 — CLOSE-OUT & PHASE-LOOP
DOCS-SYNC moved this phase to `in_review` (riding the PR). This state decides
control flow — the flip to `done` is not ours to make (the merge Action does it).

1. **Confirm** this phase is `in_review` in the backlog and the PR is open with a
   governed title. Set `.claude/state/current-task.json` accordingly (state
   `AWAITING_MERGE` for this phase).
2. **Decide next**:
   - No phases left → nothing more to build; the epic flips to `done` when this
     last phase's PR merges (merge Action). Stop; state file `status: done`
     once merged (task-intake reconciles if the session ends first).
   - Phases remain → because dependent phases are **stacked branches**
     (SIZE&DECOMPOSE), phase N+1 already has phase N's code even before merge,
     so you need NOT wait for merge to build it:
     - L1: ask "phase {n} PR opened; start {n+1} now, or wait?"
     - L2/L3: continue — re-enter at PLAN for phase N+1 on a branch stacked atop
       phase N. Its own DOCS-SYNC will set it `in_review` in turn.
   - A `blocked` phase halts the loop until unblocked.

## Handling a bounced PR (review sent it back)
A PR sent back in review is NOT a new task and NOT a new backlog item — it's the
SAME phase returning to work:
1. Set that phase's backlog `status` back to `in_progress` and `bounce_count += 1`
   (on the branch; it rides the fix PR). Keep the same spec ID and phase.
2. Address the review, re-run VERIFY, DOCS-SYNC sets it `in_review` again, push.
3. The `bounce_count` is a signal `reflect` watches: a phase bounced 3+ times
   usually means a fuzzy spec or under-scoped work — worth a process note.
Never open a second backlog entry for the retry; that fragments the history.
