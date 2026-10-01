---
name: task-intake
description: The front door for ANY new work in this repo. Use at the start of every new task or session — whenever the user gives a development request, a bug report, or says "let's work on X", "start a new task", "what should we do", or pastes a requirement. This skill checks the backlog for pending/deferred work, confirms the autonomy level, allocates the spec ID, then routes to feature-dev or bug-fix. Always run this BEFORE feature-dev or bug-fix.
---

# Task Intake (session front door)

Run this before starting any new work. Four jobs: recover state, check the
backlog, set autonomy, route.

**Worktree-per-task (FEAT-020, default ON).** Every task runs in its own git
worktree under `.claude/worktrees/<spec_id>/`, created via the `EnterWorktree`
tool. With `worktree.baseRef: "fresh"` (set in `.claude/settings.json`) the
worktree branches from `origin/<default-branch>` — so each task ALWAYS starts on
the latest main, and parallel sessions never share a working tree or collide on
a branch checkout (the two failure modes that bit us: a branch based on a stale
commit, and parallel sessions racing on spec IDs). This removes the manual
`git fetch → checkout main → pull → checkout -b` dance. The user may opt out for
a given task ("no worktree" / "work in the main checkout"); then skip the
EnterWorktree calls and branch manually off latest `origin/develop`.

**[FEAT-683] The branch work starts from is `develop`, not `main`** (root
`CLAUDE.md` § 分支与上线). `worktree.baseRef` cannot name a branch, so a new
worktree is still cut from `origin/main`; SessionStart's
`scripts/align_worktree_base.py` moves a brand-new branch onto `origin/develop`
(desktop-app sessions start inside their worktree, so this is their path). A
worktree entered MID-session with `EnterWorktree` misses that hook: run
`git fetch origin develop && git reset --keep origin/develop` right after
entering it. The one exception is an urgent production fix — cut it from main
instead: `git checkout -B hotfix/<name> origin/main`, PR to `main`.

## Step 1 — Recover any in-flight task

Read `.claude/state/current-task.json` (local, gitignored). If it exists and
`status` is not `done`/`abandoned`:

> "There's an unfinished task in progress: **{spec_id} — {title}**, last state
> **{state}** (tests: {test_status}). Resume it, or set it aside and start
> something new?"

If resuming, hand back to the owning skill (feature-dev/bug-fix) AT that state —
do not restart from EXPLORE. If the file is missing/`done`, continue.

If the recovered task carries a `worktree_path` and the session is not already
inside it, re-enter that worktree first: `EnterWorktree` with `path:
<worktree_path>` (switching into an existing worktree, not creating one). This
puts the resumed work back on its own branch/tree. If entering the recorded path
fails (worktree was removed), note it and fall back to the branch named in
`branch`.

## Step 2 — Check the backlog

The delivery backlog lives on **GitHub issues** since [FEAT-055] (index:
migration issue + `ops/backlog/migration-FEAT-055.json`; `ops/backlog/backlog.yaml`
is the frozen archive — read it only for history, never write it). Collect
ready work:

```
gh issue list --label backlog --state open \
  --json number,title,labels,milestone
```

A phase is ready when it carries `status:pending` (or `status:blocked`, for
visibility) and every phase its body's `depends_on` names is closed (closed
issues under the same milestone).

- If there are ready pending items, surface them BEFORE taking the new request:

> "Before we start that — the backlog has {N} ready item(s):
> - {spec_id} phase {p}: {title} (est: {phases} phases)
> Do you want to knock out backlog work first, or proceed with the new request?"

- If the user's new request looks like it's already IN the backlog (match by
  title/module), say so and offer to continue that item instead of duplicating.
- If backlog is empty or all blocked, note it briefly and proceed.

Never silently ignore ready backlog items. This is the "check the todo list on
every new task" guarantee.

**Reconciliation (catch a loop that didn't close) — run the guard, don't eyeball
it:** normally the `backlog-close` merge Action flips `in_review → done`. When it
doesn't, nothing says so. Run:

```
python3 scripts/check_backlog_issue_reconciliation.py
```

Exit 0 = nothing stale. Exit 1 = findings. Exit 2 = it could not judge (gh
failure, no history, no issues, or a missing `ops/rules/backlog-reverse-baseline.txt`
— [#2172]) — that is not a pass, say so rather than moving on.

Its **reverse** direction (a merged claim with no tracking issue at all) reads
that baseline file and renders the pairs it covers in a separate counted
section instead of as findings. Those 38 pairs are history no session can
clear — `done` is the merge Action's to write and their PRs merged weeks ago —
so they are not yours to act on. A NEW reverse finding, i.e. one not in that
file, is: read the claiming commits, then either register the issue or add a
line with the reason. Never add a line to silence a claim you have not judged.

**Before you do either, check the PR's `Backlog:` trailer — and expect the
guard to have checked it for you** [FEAT-607]. Since [FEAT-483 p1] the merge
Action links by the trailer and falls back to the title only when there is
none, so a phase can be fully tracked — `backlog` label on, closed by the bot
seconds after merge, no `backlog-unlinked` — while its issue's title is ordinary
human prose that matches no pattern. That used to flag here forever. It no
longer does: the guard now reads the same trailer under the same rule the closer
applies, and lists what it explained under **`## Tracked by a `Backlog:`
trailer`**, which is NOT a finding. Two consequences for you. First, a pair in
that section needs no issue and no baseline line — registering a second issue
beside the one the trailer already names is how you get a duplicate. Second, a
pair that is STILL a finding has genuinely not been linked by anything, so the
two options above are the whole menu, and "the closer probably found it" is no
longer an available excuse for a line.

A third option people reach for and should not: **retitling the human issue** to
`FEAT-xxx · pN — …`. Do it only when that issue really is that one phase. When
it is the whole request and the phase delivered part of it, the retitle states
something false — `FEAT-553 p1`, `FEAT-467 p1`, `FEAT-604 p1` and `FEAT-605 p1`
were all judged that way, the last two because #3970 covers 32 pages against
p1's four and #3968 covers 12 chain steps against p1's three.

**Run the ISSUE-side guard, never the YAML-era one** [BUG-082]. This line named
`check_backlog_reconciliation.py` until 2026-08-30, and since [FEAT-055] p2 that
script was a frozen-archive no-op: it printed "not applicable" and exited 0 on
every repository state, so a session following this step got a clean bill of
health from a guard that had measured nothing. [FEAT-679] p4 deleted it. The
docstring of the real guard says "task-intake remains the session-side
detector" — this is the step it means.

Three directions, and the third is why FEAT-115 (#1275) sat open for a day with
its code on main: a merged PR labeled `backlog-unlinked` whose claim still has an
open issue. That label is the Action's own record that it refused to guess, and
until [BUG-082] nothing read it — 258 merged PRs carried it.

Surface any findings to the user and offer to close them **through the Action**:
`gh workflow run backlog-close.yml -f spec=FEAT-xxx -f phase=N` (omit `-f phase`
to close a single-phase epic). Never edit the rows by hand — `done` is the
Action's to write (invariant 6), and PR #104 was closed for exactly that.

**Verify before you dispatch: the guard reports, it does not adjudicate.** Of the
four candidates it surfaced on 2026-08-30, only one was a real zombie — FEAT-015
p4 was legitimately open because AC-10 was still owed, and FEAT-054 p3 had
delivered one half of its scope. Closing all four would have written three false
`done`s, which is worse than the silence this guard exists to break. Read the
phase's ACs against what actually merged before closing anything. Before assuming the workflow is broken, check whether
Actions is running at all (`gh run list --workflow=backlog-close.yml`): in the
occurrence this guard was built for, GitHub produced no run records for three
days and the workflow itself was never at fault.

This prose used to ask you to cross-reference merged PRs by hand. No session ever
did, which is how eleven rows went stale unnoticed — so it is a command now
[BUG-028]. **This call is now the only detector**: the daily `backlog-reconcile.yml`
that ran the same guard was removed by [FEAT-679] (owner request, 2026-09-23) after
34 of its last 40 runs were red with nobody acting on them. Also still worth a glance by eye:
an `in_progress` item with no open branch/PR (possibly abandoned).

**Then run its other half** [FEAT-679 p4]:

```
python3 scripts/check_stranded_phases.py
```

`backlog-reconcile.yml` ran two guards, not one, and only the first moved here
when it was deleted. This one asks the opposite question: which backlog issue is
still OPEN although `main` already carries its phase's commits — the merge Action
missed it, or the phase merged in pieces. Measured on the day p4 wired it here:
five such issues (#4411, #4024, #4170, #4175, #4359) that the reconciliation
guard above reported as "all reconciled". Same exit codes, same rule for acting
on a finding: read the phase's ACs against what merged, then close through
`backlog-close.yml` — never by hand. `ops/rules/stranded-phase-allowlist.txt` is
its baseline, with the same "judge it before you add a line" discipline. It
reads `HEAD`'s history, so run it here, before the task's first commit: on a
branch that already carries your phase's commits, your own open issue is a finding.

## Step 3 — Set the autonomy level

Confirm how autonomously to run (default from `current-task.json`, else ask
once). Record it in the new task's state file.

| Level | Clarify gate | Approval gate | Runs to |
|---|---|---|---|
| **L1 Supervised** | asks | hard stop after spec | you drive each gate |
| **L2 Batch** (recommended for "input and go") | batches ALL questions + spec into ONE checkpoint | that one checkpoint | then straight to PR |
| **L3 Autonomous** | asks only if truly blocked | skipped | straight to PR; you review the PR |

The user can override per-task ("run this at L3"). Higher autonomy still cannot
bypass: migrations-reference-spec-id, and docs-sync. Failing-test-before-fix is
also un-bypassable by autonomy level alone — the ONLY way to suspend it is the
repo-wide `.claude/state/harness-fast-mode.json` switch (see that file and
issue #1812); check it at the start of every task, not just once per session.

## Step 4 — Claim the issue, allocate the spec ID, route

1. **If you are PICKING UP AN ISSUE THAT ALREADY EXISTS, claim it first — before
   the spec ID** [FEAT-483 p2]:

   ```bash
   python3 scripts/claim_issue.py claim --issue <n> --ttl-minutes 120
   #   exit 0  it is yours
   #   exit 1  someone else holds it (the message names who, until when, and
   #           their session) — pick a different issue, do NOT retry
   #   exit 2  could not judge — stop; never read "could not see" as "free"
   ```

   Renew it (`renew`) if the task outlives the TTL, and `release` it if you stop
   early. Release is a tombstone, not a deletion, so it always works.

   **The ORDER is the point, and it is why #2995 cost a duplicate
   implementation.** The spec-ID milestone below is a real mutex — the server
   takes the first writer and refuses the rest — but it guards the NUMBER, and
   the thing two sessions actually contend for is the ISSUE. On 2026-09-13/14
   two sessions both took #2995, both reached the allocator, and both were
   served, because they asked for different numbers (FEAT-467 and FEAT-459).
   The mutex fired perfectly and prevented nothing. Claiming downstream of the
   contention point is the same as not claiming.

   A claim is a git ref, `refs/heads/claims/issue-<n>`, whose commit message
   carries the lease. Advancing it IS the lock: a writer parents its commit on
   the sha it read, so if anyone moved the ref in between the push is no longer
   a fast-forward and the server rejects it. Two reclaimers that both judge a
   lease expired therefore elect exactly one winner, with no clock agreement
   and no coordination (measured against the live remote, 2026-09-15).

   ⚠️ **A claim COMMENT is not a claim.** "本单已由自动接单器接走" is read-then-write
   with a window in the middle; two sessions can both read "unclaimed" and both
   write it. Keep posting it if you like — it is how a human sees what is going
   on — but it decides nothing. The ref does.

   Creating a BRAND-NEW issue needs no claim to be correct (nobody else can be
   on an issue that did not exist), but claim it anyway if the work will span
   hours: the lease is also how a later session tells "in progress" from
   "abandoned" without reading timestamps out of prose.

2. **Claim the ID on GitHub, then register the work** [FEAT-116]. Reading a
   file and appending to it is not an allocator: two branches can both write,
   both are legal alone, and the collision only surfaces at merge — hours later,
   after the number has spread into the filename, the frontmatter, two ledgers,
   every commit subject and the PR body. BUG-078 paid that rename. Ten live
   worktrees make it likely, not unlucky.

   ```bash
   ID=$(python3 scripts/claim_spec_id.py --kind bug)   # or --kind feat
   gh issue create --title "$ID · p1 — <one line>" \
     --label backlog --label "status:in-progress" --milestone "$ID"
   ```

   **That title shape and that `backlog` label are not decoration — three
   consumers refuse to read anything else, and until 2026-09-14 this line
   produced a shape none of them accepts** [FEAT-477 / #3173]. It said
   `--title "$ID — <one line>" --label "status:in-progress"`: an epic-shaped
   title with no phase number and no `backlog` label. The three readers are
   `backlog_close_issue.match_issues()` (prefix `FEAT-xxx · pN `),
   `check_backlog_issue_reconciliation.issue_claim()` (regex
   `^FEAT-xxx · p<N> — `) and `check_stranded_phases.issue_claim()`; the
   `backlog` label gate is `partition_backlog()`, which the guard *imports from
   the closer* — one function, both sides. So a wrong shape does not merely
   raise a daily alarm: the merge Action cannot find the issue, labels the PR
   `backlog-unlinked` and **never writes `done` at all**. Measured 2026-09-14:
   8 merged phases untracked, 6 of their PRs carrying `backlog-unlinked`.

   **There is no "this task is only one phase" branch** — feature-dev's
   SIZE&DECOMPOSE already rules that a task tripping no threshold is still
   registered as phase 1 (`.claude/skills/feature-dev/SKILL.md:164`), because a
   task that isn't on the board can't be reported done. So: always `· p1` here,
   and feature-dev adds `· p2`, `· p3`… if it later decomposes.

   **Human grouping goes AFTER the em dash, never in place of the phase number.**
   `FEAT-416 · D 档 · /billing/wire-claims …` (#2808) carries the spec id AND the
   `backlog` label and still matches nothing, because `· D 档 ·` is where `· p1`
   had to be. Write `FEAT-416 · p1 — D 档：/billing/wire-claims …` instead.

   **If you ADOPT an existing issue instead of creating one, it is your job to
   make it answer the claim.** This is the commonest way the leak happens — 5 of
   those 8 (#2891, #2950, #2952, #2956, #2995): a session picks up a
   human-written tracking issue such as `HubSpot 同步 · p7 — 对账定时任务与告警`,
   claims a fresh spec id, and tags its commits `[FEAT-444] phase 7`. The issue
   reads perfectly to a human and to all three consumers says nothing. Retitle
   it and label it, in the same session:

   ```bash
   gh issue edit <n> --title "$ID · p<N> — <its existing title>" \
     --add-label backlog --milestone "$ID"
   ```

   Then check your own work before you start — it costs one command, and it is
   the only check that runs before the commits exist:

   ```bash
   python3 - <<'PY'
   import sys; sys.path.insert(0, "scripts")
   from check_backlog_issue_reconciliation import issue_claim
   print(issue_claim("<paste the issue title exactly>"))   # must be ('FEAT-xxx', N)
   PY
   ```

   `claim_spec_id.py` creates a **GitHub milestone whose title is the bare id**
   (`FEAT-171`); the server accepts the first writer and refuses the rest with
   `422 already_exists`, so the number is yours before any file mentions it. It
   **exits 2** if it cannot reach the board — do not start work on an unclaimed
   number (RULE-002). Losing a race is normal and silent: it just takes the next
   id. **It does not need the `gh` binary** [BUG-104]: with no `gh` on `$PATH` and
   `GH_TOKEN` / `GITHUB_TOKEN` in the environment, the same two calls go over REST
   (the shape the auto-dispatch container has). Only with neither does it exit 2,
   and the message then names both repairs — never rebuild the algorithm by hand
   with `curl`; that bypasses every safety check the allocator carries.

   **That title is the LOCK. Never rename it** [FEAT-171 p2] — milestone-title
   uniqueness is byte-exact (measured: `FEAT-114` was created beside an existing
   `FEAT-114 — <title>`), so a renamed lock can be created a second time and two
   sessions each believe they own the number. The epic's human-readable title goes
   in the milestone's **description**, and feature-dev's decomposition updates that
   description rather than creating a second milestone.

   The `spec/<ID>` annotated tag is still written, as a best-effort **receipt**: it
   is what lets `check_spec_id_allocated.py` settle an id through `git` alone, so
   `scripts/hooks/pre-push` keeps working without a `gh` login. A receipt that
   fails no longer stops the claim — it warns, and that id falls back to the `gh`
   path. This is the direct repair of the stoppage where an environment 403'd every
   `refs/tags/spec/*` push and a human hand-made the tag.

   **In a Claude Code remote-execution container the receipt ALWAYS fails, and that
   warning is expected** [BUG-230 / #2829]. Such a container may push
   `refs/heads/*` and not `refs/tags/*` — measured 2026-09-11, and reproduced
   independently at least five times before that. The id is still yours: the
   milestone is the lock and it was created. **Do not re-run the allocator on that
   warning** — it does not retry a claim, it takes the NEXT id; three were burnt
   that way in one session. Two consequences worth knowing:

   * The tag namespace has been empty for every id since `spec/FEAT-380` (36 and
     counting). So a host carrying **neither `gh` nor `GH_TOKEN`/`GITHUB_TOKEN`**
     can no longer push a change set that introduces a new id — the guard cannot
     reach either namespace and exits 2. A host with just the token is fine
     (BUG-104's HTTP transport, which the guard inherits by importing `run_gh`).
   * To see what a `git push` actually did here, use `--no-verify`. Without it you
     are watching `scripts/hooks/pre-push` run the whole guard chain, which looks
     exactly like a hung network for several minutes.

   The board is `git ls-remote --tags origin 'refs/tags/spec/*'` plus the
   `FEAT-xxx` / `BUG-xxx` milestones (`gh api repos/{owner}/{repo}/milestones
   --paginate -q '.[].title'`) plus the open issues. `ops/specs/REGISTRY.md` is
   **no longer a reservation surface** — it had 247 commits in 60 days and zero
   programmatic readers, which is why a reservation written there protected
   nothing.

   **This step is no longer advisory** [FEAT-116 p4]. `check_spec_id_allocated.py`
   runs in `scripts/hooks/pre-push` (its CI run, the `spec-id-claims` job, was removed
   by [FEAT-679]): a spec ID your change set ADDS that
   nothing on the remote reserved is red. Skipping the command above and picking a
   number by hand is exactly what PR #1354 did, and the id had reached five files
   before anything said so.

   **Two things count as a reservation since [FEAT-171] p1**: a `spec/<ID>` tag,
   or a GitHub milestone whose title STARTS with the id (`FEAT-171`, or the older
   `FEAT-171 — <title>` shape). The tag namespace is read first, through `git`, and
   `gh` is consulted only when some introduced id is not accounted for there — so a
   contributor with git configured and no `gh` login still gets the same verdict on
   the normal path. If NEITHER namespace can be read, the guard exits 2 (could not
   judge), never 0. Since p2 the allocator writes the milestone and the tag is only
   a receipt, so an id whose receipt failed is settled through `gh` — which is why
   both sources still count and why neither is optional.
3. Enter the task's worktree (unless the user opted out — see the worktree note
   above): `EnterWorktree` with `name: <spec_id>` (e.g. `BUG-011`). This creates
   `.claude/worktrees/<spec_id>/` branched off the latest `origin/<default>` and
   switches the session into it — no manual branch/checkout needed. (Requires
   not already being in a worktree; if resuming, Step 1 already handled entry.)
   Then move it onto the integration branch [FEAT-683]:
   `git fetch origin develop && git reset --keep origin/develop` (skip for a
   `hotfix/*` task, which stays on main).
   Record the resulting path as `worktree_path` in the state file (next step).
4. Initialize `.claude/state/current-task.json` from
   `.claude/state/current-task.template.json` with the spec_id, autonomy,
   `worktree_path` (from the previous step; null if the user opted out),
   `state: EXPLORE`.
5. Route:
   - New feature / change → `feature-dev` skill, begin at EXPLORE.
   - Bug / defect → `bug-fix` skill, begin at its EXPLORE.
