#!/usr/bin/env python3
"""
[FEAT-683] SessionStart: move a brand-new session branch from `main` onto
`develop`, so new work starts where its PR will land. Suite:
`scripts/tests/test_align_worktree_base.py`.

WHY THIS EXISTS

In the develop flow every feature and fix PR targets `develop`. But new session
worktrees are cut from `origin/main`: `.claude/settings.json`'s
`worktree.baseRef: fresh` means "the remote's default branch", Claude Code
cannot be told to use another branch there (its documentation: the setting does
not take a branch name), and the desktop app cuts its per-session worktrees the
same way. The default branch must stay `main` (design.md decision 1). A branch
cut from main and PR'd into develop still merges cleanly, but it starts up to a
day behind develop — conflicts and "works on my branch" surprises that nothing
about the work itself caused.

WHAT IT DOES — ONLY WHEN EVERY CONDITION HOLDS

  1. HEAD is on a branch, and that branch is not `main`, `develop`, `release`
     or `hotfix/*` (a hotfix is SUPPOSED to start from main);
  2. `git fetch origin develop` succeeds and `origin/develop` exists — i.e. the
     flow has gone live (before go-live the branch does not exist);
  3. the branch has no commits of its own: `origin/main..HEAD` is empty;
  4. no tracked file is modified (untracked files are left alone);
  5. HEAD is not already a descendant of `origin/develop`.

Then `git reset --keep origin/develop` — `--keep` refuses rather than overwrite
anything local — and one line saying what moved, plus how to go back for a
hotfix. Any other state: it says nothing and changes nothing.

It ALWAYS exits 0. A session must never fail to start because a fetch timed out
or a condition could not be read; the worst case is a branch that stays on main,
which is exactly the state before this script existed.
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS))

import branch_flow as flow  # noqa: E402
from guard_io import GuardIoError, force_utf8_stdio, run_text  # noqa: E402

PREFIX = "[worktree-base]"
FETCH_TIMEOUT_SECONDS = 30
TARGET = f"origin/{flow.INTEGRATION_BRANCH_NAME}"
MAIN = f"origin/{flow.PRODUCTION_BRANCH}"


class Skip(Exception):
    """A condition does not hold; nothing to do (not an error)."""


def _git(repo: Path, *args: str, timeout: float | None = None) -> subprocess.CompletedProcess:
    try:
        return run_text(["git", "-C", str(repo), *args], timeout=timeout)
    except (GuardIoError, subprocess.TimeoutExpired) as exc:
        raise Skip(f"git {' '.join(args)}: {exc}") from exc


def _out(repo: Path, *args: str) -> str | None:
    proc = _git(repo, *args)
    return proc.stdout.strip() if proc.returncode == 0 else None


def is_protected(branch: str) -> bool:
    return branch in (flow.PRODUCTION_BRANCH, flow.INTEGRATION_BRANCH_NAME, flow.RELEASE_BRANCH) or \
        branch.startswith(flow.HOTFIX_PREFIX)


def plan(repo: Path, *, fetch: bool = True) -> str:
    """Return the branch name to move, or raise Skip with the reason."""
    branch = _out(repo, "symbolic-ref", "--quiet", "--short", "HEAD")
    if not branch:
        raise Skip("HEAD is detached")
    if is_protected(branch):
        raise Skip(f"`{branch}` is not a session branch")
    if fetch:
        proc = _git(repo, "fetch", "--quiet", "origin", flow.INTEGRATION_BRANCH_NAME,
                    timeout=FETCH_TIMEOUT_SECONDS)
        if proc.returncode != 0:
            raise Skip(f"`{flow.INTEGRATION_BRANCH_NAME}` is not on the remote (the develop flow is not live)")
    if not _out(repo, "rev-parse", "--verify", "--quiet", f"{TARGET}^{{commit}}"):
        raise Skip(f"`{TARGET}` does not exist")
    if not _out(repo, "rev-parse", "--verify", "--quiet", f"{MAIN}^{{commit}}"):
        raise Skip(f"`{MAIN}` does not exist")
    ahead = _out(repo, "rev-list", "--count", f"{MAIN}..HEAD")
    if ahead != "0":
        raise Skip(f"`{branch}` already has commits of its own")
    status = _out(repo, "status", "--porcelain", "--untracked-files=no")
    if status is None or status:
        raise Skip("tracked files are modified")
    if _git(repo, "merge-base", "--is-ancestor", TARGET, "HEAD").returncode == 0:
        raise Skip(f"`{branch}` is already based on `{TARGET}`")
    return branch


def align(repo: Path, *, fetch: bool = True) -> str | None:
    """Move the branch; return the line to print, or None when nothing moved."""
    try:
        branch = plan(repo, fetch=fetch)
    except Skip:
        return None
    before = _out(repo, "rev-parse", "--short", "HEAD") or "?"
    proc = _git(repo, "reset", "--quiet", "--keep", TARGET)
    if proc.returncode != 0:
        return (f"{PREFIX} could not move `{branch}` onto {TARGET} "
                f"({proc.stderr.strip()[:200]}); it stays where it was.")
    after = _out(repo, "rev-parse", "--short", "HEAD") or "?"
    return (f"{PREFIX} moved new branch `{branch}` from {MAIN}@{before} to {TARGET}@{after} "
            f"[FEAT-683]: feature and fix PRs target `{flow.INTEGRATION_BRANCH_NAME}`. "
            f"Working on an urgent production fix instead? "
            f"`git checkout -B {flow.HOTFIX_PREFIX}<name> {MAIN}` and open the PR against main.")


def main(argv: list[str] | None = None) -> int:
    force_utf8_stdio()
    ap = argparse.ArgumentParser(description="Move a fresh session branch onto develop [FEAT-683]")
    ap.add_argument("--repo", default=os.environ.get("CLAUDE_PROJECT_DIR") or ".")
    ap.add_argument("--no-fetch", action="store_true", help="use the remote-tracking refs as they are")
    args = ap.parse_args(argv)
    try:
        line = align(Path(args.repo), fetch=not args.no_fetch)
    except Exception as exc:  # noqa: BLE001 — SessionStart never fails a session
        print(f"{PREFIX} skipped: {exc}", file=sys.stderr)
        return 0
    if line:
        print(line)
    return 0


if __name__ == "__main__":
    sys.exit(main())
