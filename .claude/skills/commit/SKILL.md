---
name: commit
description: Generate and create git commits for this repo. Use whenever committing staged changes, when the user says "commit this", or at the COMMIT state of feature-dev/bug-fix. Enforces Conventional Commits + spec/bug ID traceability.
---

# Commit Generation

## Procedure

1. `git status` + `git diff --staged` — read what is actually being committed.
   If nothing is staged, ask whether to stage all changes or a subset.
2. Identify the spec context: the active `FEAT-xxx` or `BUG-xxx` from the
   current workflow. If neither exists and the change is non-trivial, stop —
   non-trivial work without a spec violates the harness; route through
   feature-dev or bug-fix first. Trivial chores (`chore`, `docs`, `style`) may
   omit the ID.
3. Split unrelated changes into separate commits (e.g. migration vs frontend
   vs docs can share a commit only if they serve one spec step).

## Format (Conventional Commits + spec ID)

```
<type>(<scope>): <imperative summary, ≤72 chars> [FEAT-xxx|BUG-xxx]

- What changed and why (1–4 bullets, reference AC numbers where relevant)
- Migration: <filename> (if any)
- Docs updated: <paths> (or "no-doc-impact: <reason>")
```

Types: `feat` `fix` `refactor` `test` `docs` `chore` `perf` `ci` `build`
Scope: the module name from the root `CLAUDE.md` index.

Example:

```
feat(quotes): add tiered pricing fallback [FEAT-023]

- Implements AC-3 from ops/specs/FEAT-023/prd.md
- Migration: 20260703_add_pricing_tiers.sql
- Docs updated: src/modules/quotes/CLAUDE.md
```

## PR title & body (governed — not just the commits)

When opening the PR (feature-dev State 11), the PR is a first-class artifact:

- **PR title** MUST use the same format as the lead commit:
  `<type>(<scope>): <summary> [FEAT-xxx|BUG-xxx]`. This is load-bearing, not
  cosmetic: under squash-merge the PR title BECOMES the commit on `develop` (or
  `main`, for a `hotfix/*`), and the `backlog-close` merge Action extracts the
  spec ID (and phase) from it — marking the issue awaiting release on develop,
  closing it when the daily release reaches main [FEAT-683]. A title without a
  spec ID gets the PR labeled `backlog-unlinked` and the backlog won't
  auto-close.
- **PR base is `develop`** (`gh pr create --base develop`); only `hotfix/*`
  targets `main`. The `release -> main` PR is the release train's: never open,
  approve or merge it from a session.
- Put the phase in the title when multi-phase: `... [FEAT-023] phase 2`.
- **PR body is bilingual (repo rule, 2026-08-23 — same rule as issue bodies)**:
  every content section carries 中文 + English — zh paragraph then en mirror
  (or paired per section). AC checklist lines quoting literal identifiers may
  stay single-language. Commit titles stay English; it is the PR/issue BODY
  that is bilingual.
- **PR body** MUST fill the template's `## Summary` with 2-4 prose sentences
  (what/why/blast radius) — the reviewer's "介绍" and, under squash, the commit
  body on `main`. Linking the spec is not a substitute for summarizing.

## Rules

- Never commit failing tests (except the intentional red commit in TEST-FIRST,
  which must be labeled `test(...): add failing tests for [FEAT-xxx]`).
- Never include secrets, .env files, or generated artifacts not meant for VCS.
- Do not amend or force-push shared branches.
