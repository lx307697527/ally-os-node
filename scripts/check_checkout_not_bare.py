#!/usr/bin/env python3
"""
Does git see this checkout's work tree, or has its config made it bare? — [BUG-531].

Suite: `scripts/tests/test_check_checkout_not_bare.py`.

WHAT HAPPENS. `core.bare = true` tells git a repository has no work tree. On
2026-09-23 guard self-test fixtures leaked GIT_DIR inside a git hook and wrote
exactly that into the SHARED `.git/config` [BUG-525]; this repository runs with
`extensions.worktreeConfig` on, which makes a core.bare in that file apply to
every worktree, so every worktree on the machine refused `git status` with
"this operation must be run in a work tree".

WHY A LOUD `git status` IS NOT ENOUGH. In that state git no longer moves to the
work-tree root before it runs a hook, so the RELATIVE `core.hooksPath`
(`scripts/hooks`, the only form install_git_hooks.py leaves) resolves against
the directory the push was started from. BUG-528 made pre-push refuse when it
runs without a work tree, and measured the gap no hook can close: a push
started from a subdirectory finds no hook at all and goes out with no check run
and nothing printed. Since FEAT-679, pre-push is the only place most guards
run. A push needs no work tree, so commits made before the config broke can
leave that way while nothing else looks wrong.

SO THE QUESTION IS ASKED OUTSIDE THE HOOK, AT SESSIONSTART — before anyone
pushes. `.claude/settings.json` runs this with `--session-start`.

WHAT COUNTS. The question pre-push itself asks first: does
`git rev-parse --show-toplevel` resolve a work tree here? It is asked from the
checkout with git's repository-locating variables removed (hermetic_git_env),
so the answer is about this directory and not about whatever GIT_DIR a caller
exported — and "no work tree" is believed only when `--is-inside-work-tree`
agrees. Two shortcuts were measured wrong (git 2.55.0.windows.3):

  * the VALUE of core.bare. With extensions.worktreeConfig off, a linked
    worktree reads `core.bare = true` from the shared file and is perfectly
    healthy: git then applies a shared core.bare to the primary checkout only.
  * `git rev-parse --is-bare-repository`. It rereads config WITH include.path,
    while git decides whether there is a work tree from the repository's own
    config files WITHOUT following includes. So `core.bare = true` followed by
    an include that sets it back to false answers "not bare" — and git still
    finds no work tree, and a push from a subdirectory still skips the hook.

For the same reason the file is named by `git config --no-includes
--show-origin`: the value git's own decision read.

A GENUINELY BARE REPOSITORY IS NOT A FINDING. Two shapes: the directory IS
git's own directory (`git clone --bare`), or a `.git` that nothing was ever
checked out from. "Checked out" is read from git's index, not from the
directory listing: a bare repository stored as `<dir>/.git` can keep its own
linked worktrees inside `<dir>`, so `<dir>` is full of files and still has no
work tree of its own (measured). Two things are never called genuinely bare: a
git directory that holds an index (a checkout's `.git` handed in by mistake —
undecidable), and the checkout THIS script is checked out into, whose index may
simply be gone. A `.git` directory or gitfile that leads to the repository git
is using, files checked out from it, and no work tree — that is the finding,
`configured-bare`.

DETECT, NEVER REPAIR. The file is the shared config of every worktree on the
machine, and whatever else a leak wrote into it (BUG-525's restore touched
seven keys: core.bare, user.name, user.email, user.signingkey, commit.gpgsign,
gpg.format and gpg.ssh.allowedSignersFile) needs a human to judge. So this
prints the file, the one command for core.bare, and those keys as they read now;
the machine's owner repairs it. (An AI session in auto mode is refused edits to
that file anyway.)

SCOPE. The checkout this script lives in, or `--root <dir>` — e.g. the primary
checkout, which a linked worktree's session does not see. Like
check_worktree_hooks_path.py it judges a LOCAL developer environment, so it is
not in `harness check --all` or any workflow: a CI checkout is never configured
bare, and saying so there would be noise (BUG-017).

Exit codes: 0 ok, or a genuinely bare repository · 1 configured bare ·
2 could not judge. With `--session-start`: always 0 — SessionStart must speak,
not block — and the verdict goes to stdout as one SessionStart JSON object, the
channel that reaches the session's context (the contract
fact_layer_ready_hook.py and session-start-reinject.sh use); a finding also
goes to stderr, and to the user as `systemMessage`.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Mapping

import hermetic_git_env
from guard_io import GuardIoError, force_utf8_stdio, run_text

# Where the checkout is, derived from this file rather than from the working
# directory: SessionStart does not promise a cwd (check_worktree_hooks_path.py
# makes the same choice for the same reason).
REPO_ROOT = Path(__file__).resolve().parents[1]

GUARD = "check_checkout_not_bare:"
TAG = "[checkout-bare]"
# A local `git rev-parse` answers in milliseconds; this only bounds a git that
# hangs, so a SessionStart hook stays well inside the harness's own timeout.
GIT_TIMEOUT_SECONDS = 10

# The identity and signing keys BUG-525's leak rewrote beside core.bare, in
# git's canonical lower-case spelling, which is what `--get-regexp` matches.
RELATED_KEYS = (
    "user.name",
    "user.email",
    "user.signingkey",
    "commit.gpgsign",
    "gpg.format",
    "gpg.ssh.allowedsignersfile",
)
RELATED_KEYS_RE = "^(" + "|".join(re.escape(key) for key in RELATED_KEYS) + ")$"
# An identity is put back, never deleted: a repo-level one is usually the owner's.
IDENTITY_KEYS = ("user.name", "user.email")

EXIT = {
    "ok": 0,
    "bare-repository": 0,
    "configured-bare": 1,
    "undecidable": 2,
}
QUIET = ("ok", "bare-repository")


def plan(
    *,
    root: str,
    dot_git: str | None,
    git_dir: str | None,
    has_work_tree: bool | None,
    leads_to_git_dir: bool = False,
    git_dir_is_root: bool = False,
    index_exists: bool = False,
    own_checkout: bool = False,
    toplevel: str | None = None,
    toplevel_is_root: bool = False,
    worktree_config: bool = False,
    bare_scope: str | None = None,
    bare_origin: str | None = None,
    bare_value: str | None = None,
    effective_value: str | None = None,
    related: tuple[tuple[str, str], ...] = (),
    git_error: str | None = None,
) -> tuple[str, str]:
    """Pure decision. Verdict in ok/configured-bare/bare-repository/undecidable.

    Every input is injected so each branch is reachable without a repository;
    `discover()` is the half that asks git and the filesystem. The suite drives
    real repositories too — BUG-341's lesson: a guard about git configuration
    has to be asked in a git repository at least once.
    """
    if git_dir is None or has_work_tree is None:
        return (
            "undecidable",
            f"could not ask git about {root}: {git_error or 'no answer'}. Not a pass: "
            f"whether git sees a work tree here is unknown.",
        )

    if has_work_tree:
        if toplevel_is_root:
            return ("ok", f"git resolves this checkout's work tree ({toplevel}); it is not configured bare")
        return (
            "undecidable",
            f"git resolves the work tree for {root} to {toplevel} rather than to this "
            f"directory, so this is not a checkout of its own (a core.worktree setting, "
            f"or a .git git does not accept, so it found an enclosing repository). Not a "
            f"pass: which hooks a push from here runs cannot be told.",
        )

    # git resolves no work tree here: a repository without one, or a broken checkout?
    if dot_git is None:
        if git_dir_is_root and not index_exists:
            return (
                "bare-repository",
                f"{root} is a bare repository — git's own directory, with no work tree — "
                f"so core.bare = true is correct here and there is nothing to check",
            )
        if git_dir_is_root:
            return (
                "undecidable",
                f"{root} is a git directory that keeps an index, i.e. a checkout's .git. "
                f"Not a pass: run this on the checkout directory, not on its git directory.",
            )
        return (
            "undecidable",
            f"{root} has no .git of its own, and the repository git found from here "
            f"({git_dir}) has no work tree for it. Not a pass: run this inside a checkout.",
        )
    if not leads_to_git_dir:
        return (
            "undecidable",
            f"{root}/.git does not lead to the repository git is using ({git_dir}), so "
            f"which config took the work tree away cannot be told. Not a pass.",
        )
    # Checked out: git keeps an index for it — or this very script is checked out
    # there, which no bare repository can say (its index may just be gone).
    if not index_exists and not own_checkout:
        return (
            "bare-repository",
            f"{root}/.git is a bare repository that nothing has been checked out from "
            f"(git has no index for it), so core.bare = true describes it correctly",
        )
    return (
        "configured-bare",
        _configured_bare_message(
            root=root,
            dot_git=dot_git,
            git_dir=git_dir,
            index_exists=index_exists,
            worktree_config=worktree_config,
            bare_scope=bare_scope,
            bare_origin=bare_origin,
            bare_value=bare_value,
            effective_value=effective_value,
            related=related,
        ),
    )


def _truthy(value: str | None) -> bool | None:
    """git's boolean spellings; None when unset or not a boolean."""
    text = (value or "").strip().lower()
    if text in ("true", "yes", "on", "1"):
        return True
    if text in ("false", "no", "off", "0"):
        return False
    return None


def _configured_bare_message(
    *,
    root: str,
    dot_git: str,
    git_dir: str,
    index_exists: bool,
    worktree_config: bool,
    bare_scope: str | None,
    bare_origin: str | None,
    bare_value: str | None,
    effective_value: str | None,
    related: tuple[tuple[str, str], ...],
) -> str:
    kind = "directory" if dot_git == "dir" else f"file pointing at {git_dir}"
    evidence = (
        "git keeps an index of the files checked out here"
        if index_exists
        else "this script is checked out here, though git's index for it is missing"
    )
    lines = [
        f"git treats {root} as a BARE repository, with no work tree — but it is a "
        f"checkout: its .git is a {kind}, and {evidence}.",
    ]
    if bare_origin:
        scope = f" ({bare_scope} scope)" if bare_scope else ""
        lines.append(f"core.bare = {bare_value or 'true'} is set in {bare_origin}{scope}.")
        if bare_scope == "local" and worktree_config:
            lines.append(
                "That is the SHARED config, and extensions.worktreeConfig is on, so this "
                "one value makes every worktree of this repository bare at once [BUG-525]."
            )
        if effective_value is not None and _truthy(effective_value) != _truthy(bare_value):
            lines.append(
                f"`git config --get core.bare` reads {effective_value} here because an "
                f"include sets it back — but git decides whether there is a work tree from "
                f"the repository's own config files without following includes, so that "
                f"does not help."
            )
    else:
        lines.append(
            "git could not name the file that sets it: `git config --no-includes "
            "--show-origin --get core.bare` names no file."
        )
    lines.append(
        "Why it matters: in this state git no longer moves to the work-tree root before "
        "it runs a hook, so the relative core.hooksPath (scripts/hooks) resolves against "
        "the directory a push is started from. From the root, pre-push runs and refuses "
        "[BUG-528]; from any subdirectory (scripts/, apps/, ...) git finds no hook at all, "
        "and the push goes out with no check run and nothing printed. Do not push from "
        "this checkout until it is fixed."
    )
    target = bare_origin or "<the file that sets it>"
    lines.append("Fix it by hand — this check only reports; it never edits git config:")
    lines.append(f'    git config --file "{target}" core.bare false')
    if not index_exists:
        lines.append(
            "Its index is missing as well: once core.bare is false, `git reset` rebuilds "
            "it from HEAD without touching the files."
        )
    if related:
        lines.append(
            "Check that file's identity and signing keys too: BUG-525's leak rewrote them "
            "alongside core.bare. As they read now:"
        )
        lines.extend(f"    {key} = {value}" if value else f"    {key}" for key, value in related)
        identity = [key for key, _ in related if key in IDENTITY_KEYS]
        signing = [key for key, _ in related if key not in IDENTITY_KEYS]
        if identity:
            lines.append(
                f"If {' / '.join(identity)} is not your own, set it back with "
                f'git config --file "{target}" <key> <your value>.'
            )
        if signing:
            lines.append("If these are not your own, remove them:")
            lines.extend(f'    git config --file "{target}" --unset {key}' for key in signing)
    lines.append("Then re-check:  python3 scripts/check_checkout_not_bare.py")
    return "\n".join(lines)


class Unaskable(Exception):
    """git could not be asked at all — missing, undecodable, or hung. Not an answer."""


def _git(root: Path, env: Mapping[str, str], *argv: str) -> subprocess.CompletedProcess:
    """One git call from `root`. A non-zero exit is an ANSWER and comes back;
    a git that could not be asked raises Unaskable."""
    try:
        return run_text(
            ["git", "-C", str(root), *argv],
            env=dict(env),
            timeout=GIT_TIMEOUT_SECONDS,
        )
    except (GuardIoError, subprocess.TimeoutExpired) as exc:
        raise Unaskable(str(exc)) from exc


def _same(a: str | Path, b: str | Path) -> bool:
    """The same directory on disk, however it is spelled (case, separators, 8.3 names)."""
    try:
        return os.path.samefile(a, b)
    except (OSError, ValueError):
        return False


def _gitfile_target(dot_git: Path) -> Path | None:
    """Where a `.git` FILE points (`gitdir: <path>`), resolved against its directory."""
    try:
        first = dot_git.read_text(encoding="utf-8").splitlines()[0].strip()
    except (OSError, UnicodeDecodeError, IndexError):
        return None
    if not first.startswith("gitdir:"):
        return None
    target = Path(first[len("gitdir:"):].strip())
    return target if target.is_absolute() else dot_git.parent / target


def _origin_file(origin: str, root: Path) -> str | None:
    """The file `--show-origin` names, absolute. git spells it relative to the
    directory it ran in (`file:.git/config`) when the file lies below it."""
    if not origin.startswith("file:"):
        return None
    path = Path(origin[len("file:"):])
    return (path if path.is_absolute() else root / path).as_posix()


def _out(proc: subprocess.CompletedProcess) -> str:
    return (proc.stdout or "").strip()


def discover(root: Path = REPO_ROOT, env: Mapping[str, str] | None = None) -> dict:
    """The half that asks git and the filesystem. Every value may be missing."""
    root = Path(root)
    env = dict(env) if env is not None else hermetic_git_env.scrub(os.environ)
    facts: dict = {
        "root": root.as_posix(),
        "dot_git": None,
        "git_dir": None,
        "has_work_tree": None,
        "own_checkout": _same(REPO_ROOT, root),
    }
    dot = root / ".git"
    target: Path | None = None
    if dot.is_dir():
        facts["dot_git"], target = "dir", dot
    elif dot.is_file():
        facts["dot_git"], target = "file", _gitfile_target(dot)
    try:
        facts.update(_ask_git(root, env, target))
    except Unaskable as exc:
        facts["git_error"] = f"git could not be asked: {exc}"
    return facts


def _ask_git(root: Path, env: Mapping[str, str], target: Path | None) -> dict:
    """The git half of discover(). Raises Unaskable rather than return half an answer."""
    where = _git(
        root, env,
        "rev-parse", "--path-format=absolute", "--git-dir", "--git-path", "index",
        "--is-inside-work-tree",
    )
    if where.returncode != 0:
        return {"git_error": (where.stderr or "").strip() or f"git exited {where.returncode}"}
    lines = _out(where).splitlines()
    if len(lines) != 3 or lines[2] not in ("true", "false"):
        return {"git_error": f"unexpected answer from git rev-parse: {where.stdout!r}"}
    git_dir, index, inside = lines

    top = _git(root, env, "rev-parse", "--show-toplevel")
    toplevel = _out(top) if top.returncode == 0 and _out(top) else None
    if toplevel is None and inside == "true":
        return {
            "git_error": "git says this is inside a work tree but cannot name it: "
            + ((top.stderr or "").strip() or f"git exited {top.returncode}")
        }
    facts: dict = {
        "git_dir": git_dir,
        "has_work_tree": toplevel is not None,
        "leads_to_git_dir": target is not None and _same(target, git_dir),
        "git_dir_is_root": _same(root, git_dir),
        "index_exists": Path(index).is_file(),
        "toplevel": toplevel,
        "toplevel_is_root": toplevel is not None and _same(root, toplevel),
    }
    if toplevel is not None:
        return facts

    # No work tree: which file says bare (as git's own decision read it), and what
    # else is in that file.
    origin = _git(
        root, env,
        "config", "--no-includes", "--show-scope", "--show-origin", "--null", "--get", "core.bare",
    )
    fields = (origin.stdout or "").split("\0") if origin.returncode == 0 else []
    if len(fields) >= 3:
        facts["bare_scope"], raw, facts["bare_value"] = fields[0], fields[1], fields[2]
        facts["bare_origin"] = _origin_file(raw, root)
    effective = _git(root, env, "config", "--get", "core.bare")
    if effective.returncode == 0:
        facts["effective_value"] = _out(effective)
    worktree_config = _git(root, env, "config", "--type=bool", "--get", "extensions.worktreeConfig")
    facts["worktree_config"] = worktree_config.returncode == 0 and _out(worktree_config) == "true"
    if facts.get("bare_origin"):
        related = _git(
            root, env, "config", "--file", facts["bare_origin"], "--null", "--get-regexp", RELATED_KEYS_RE
        )
        if related.returncode == 0:
            pairs = (entry.partition("\n") for entry in (related.stdout or "").split("\0") if entry)
            facts["related"] = tuple((key, value) for key, _, value in pairs)
    return facts


def emit(verdict: str, message: str) -> int:
    """Guard mode: the verdict on one stream, the exit code RULE-002 asks for."""
    stream = sys.stdout if verdict in QUIET else sys.stderr
    print(f"{GUARD} {verdict}: {message}", file=stream)
    return EXIT[verdict]


def emit_session_start(verdict: str, message: str, facts: dict) -> int:
    """SessionStart mode: one JSON object on stdout, a finding also on stderr. Always 0."""
    context = f"{TAG} {verdict}: {message}"
    payload: dict = {
        "hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": context}
    }
    if verdict not in QUIET:
        for line in context.splitlines():
            print(line, file=sys.stderr)
    if verdict == "configured-bare":
        origin = facts.get("bare_origin")
        payload["hookSpecificOutput"]["additionalContext"] += (
            f"\n{TAG} Degraded, not blocked: tell the user before anything else. Do not "
            f"push from this checkout, and do not edit that config file yourself — "
            f"repairing it is the machine owner's call."
        )
        where = f"core.bare = true in {origin}" if origin else "core.bare = true"
        fix = f' Fix by hand: git config --file "{origin}" core.bare false' if origin else ""
        payload["systemMessage"] = (
            f"{TAG} git treats this checkout as a bare repository ({where}). Until that "
            f"is fixed, a git push started from a subdirectory skips pre-push entirely "
            f"[BUG-531].{fix}"
        )
    print(json.dumps(payload, ensure_ascii=False))
    return 0


def main(argv: list[str] | None = None) -> int:
    # BUG-020: messages carry paths that may be non-ASCII, and SessionStart's
    # stdout is a pipe the harness reads as JSON.
    force_utf8_stdio()
    ap = argparse.ArgumentParser(
        description="Does git see this checkout's work tree, or has its config made it bare? [BUG-531]"
    )
    ap.add_argument(
        "--root",
        default=str(REPO_ROOT),
        help="the checkout to judge (default: the one this script lives in)",
    )
    ap.add_argument(
        "--session-start",
        action="store_true",
        help="SessionStart mode: the verdict as SessionStart JSON on stdout, a finding "
        "also on stderr; always exits 0 — a session must start, and be told",
    )
    args = ap.parse_args(argv)

    facts: dict = {}
    try:
        facts = discover(Path(args.root))
        verdict, message = plan(**facts)
    except Exception as exc:  # noqa: BLE001 — never a traceback at SessionStart, never a pass
        verdict, message = "undecidable", f"the check itself failed: {exc!r}. Not a pass."

    if args.session_start:
        return emit_session_start(verdict, message, facts)
    return emit(verdict, message)


if __name__ == "__main__":
    sys.exit(main())
