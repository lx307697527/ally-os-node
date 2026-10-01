#!/usr/bin/env python3
"""
Point git at this repo's tracked hooks — [FEAT-034 phase 3].

`scripts/hooks/pre-push` has existed since FEAT-025 (#63), tracked 100755, and as
far as any evidence in this repo shows it has never run for anyone. It was opt-in
behind a `git config core.hooksPath scripts/hooks` a contributor had to know about
and type; the worktree this spec was written in did not have it set. A guard that
exists and never fires is BUG-003's shape, so `postinstall` now does it.

Three rules, because an installer that runs on every `pnpm install` gets one
chance to be well-behaved:

  1. Never clobber a `core.hooksPath` someone set deliberately. Silently
     redirecting another tool's hooks would be a worse defect than the one this
     fixes, so a foreign value is reported and left alone.
  2. Be idempotent. `pnpm install` runs constantly; a run that changes nothing
     should touch nothing.
  3. NEVER fail the install. This is the one place in this repo where fail-closed
     is the wrong instinct, and the asymmetry is deliberate rather than sloppy:
     every check this hook runs still runs in CI (FEAT-034 AC-7), so a hook that
     will not install costs convenience, not coverage — while an install that
     dies over a convenience hook costs everyone the whole toolchain. Always 0.

FOURTH RULE, ADDED BY [FEAT-095]: normalise our OWN path out of its
worktree-hostile form.

Found while wiring the commit-signature gate. This repo's `.git/config` held

    core.hooksPath = /…/ally-os/scripts/hooks

as an ABSOLUTE path. Every per-task worktree shares that one config file, and git
resolves a relative `core.hooksPath` against the working tree it is running in
but an absolute one against nothing — so every worktree was running the PRIMARY
checkout's copy of the hooks, at whatever revision that checkout happened to sit
on, no matter which branch the work was on. Rule 1 classified it as foreign and
printed a polite note on every `pnpm install`; nobody ever acted on it, because
the note reads like another tool owns the setting.

It is not another tool. It is the same directory written in the one form that
breaks worktrees, so rewriting it preserves the author's intent rather than
overriding it. Rule 1 is untouched for everything else: a value that does not
resolve to THIS repo's own hooks directory is still left strictly alone.

FIFTH RULE, ADDED BY [BUG-341]: write to the scope the value was READ from.

Rule four never took effect in the worktrees it was written for. `git config
--get` answers with the value that WINS, and git's precedence is system < global
< local < worktree. A per-task worktree created by the desktop app carries

    core.hooksPath = C:/.../ally-os/scripts/hooks      (an absolute path)

in its own `config.worktree`. This installer read that (winning) value, judged
it correctly as "ours, absolute", and then ran a plain `git config` — which
writes LOCAL scope. The worktree value still won, so every `pnpm install`
printed "Rewritten to 'scripts/hooks'" and nothing changed. Measured 2026-09-17:
a branch that deleted a guard script was refused by the PRIMARY checkout's
older pre-push, which still called it.

So the scope is read alongside the value (`--show-scope`) and the rewrite goes
back where the value came from: worktree -> `git config --worktree`, local ->
`git config`. A value that wins from GLOBAL or SYSTEM scope is left alone even
when it is our own path: those files belong to the user's whole machine, not to
this repository, and rule 1's reasoning applies to them unchanged.

Bypass, both documented in the hook's own output:
    git push --no-verify          # once
    git config --unset core.hooksPath   # for good
"""
import subprocess
import sys
from pathlib import Path

from guard_io import force_utf8_stdio

HOOKS_PATH = "scripts/hooks"
CONFIG_KEY = "core.hooksPath"


def current_hooks_path() -> str | None:
    """Whatever git currently reports, or None if it cannot be asked."""
    try:
        proc = subprocess.run(
            ["git", "config", "--get", CONFIG_KEY],
            capture_output=True, text=True, encoding="utf-8",
        )
    except OSError:
        return None
    return proc.stdout if proc.returncode == 0 else None


# Scopes this installer may write to. `global` and `system` are the user's
# machine, not this repository (rule five).
WRITABLE_SCOPES = ("local", "worktree")


def current_scope() -> str | None:
    """The scope the WINNING value comes from, or None if unset / unknowable.

    `git config --show-scope --get` prints the scope, a TAB, then the value that
    wins. None is also what an old git without `--show-scope` yields, and the
    caller then writes local scope — the behaviour before rule five.
    """
    line = _git_line("config", "--show-scope", "--get", CONFIG_KEY)
    fields = (line or "").split(maxsplit=1)
    if len(fields) != 2:
        return None
    return fields[0]


def _git_line(*argv: str) -> str | None:
    try:
        proc = subprocess.run(
            ["git", *argv], capture_output=True, text=True, encoding="utf-8",
        )
    except OSError:
        return None
    return proc.stdout.strip() if proc.returncode == 0 else None


def own_hook_paths() -> tuple[str, ...]:
    """Absolute paths that ARE this repo's tracked hooks directory.

    Two of them, because the answer differs depending on where the installer runs:
    the current working tree (a per-task worktree, usually) and the primary
    checkout that owns the shared `.git` (the parent of `--git-common-dir`, which
    is where an absolute value in `.git/config` almost always points).

    Returns an empty tuple when git cannot be asked — and `plan()` then treats
    every absolute value as foreign, which is the safe direction.
    """
    roots = []
    for argv in (
        ("rev-parse", "--show-toplevel"),
        ("rev-parse", "--path-format=absolute", "--git-common-dir"),
    ):
        line = _git_line(*argv)
        if not line:
            continue
        root = Path(line)
        if argv[-1] == "--git-common-dir":
            root = root.parent  # …/<checkout>/.git -> …/<checkout>
        roots.append(root)
    found = []
    for root in roots:
        candidate = str((root / HOOKS_PATH).resolve())
        if candidate not in found:
            found.append(candidate)
    return tuple(found)


def plan(
    current: str | None, own_paths: tuple[str, ...] = (), scope: str | None = None
) -> tuple[str, str]:
    """Pure decision. Action in set/keep/normalize/foreign.

    `own_paths` is injected rather than discovered here so the decision stays
    testable without a git repo — the discovery half is `own_hook_paths()`.
    `scope` is where the winning value lives (rule five); None means unknown.
    """
    value = (current or "").strip().rstrip("/")
    if not value:
        return "set", f"{CONFIG_KEY} -> {HOOKS_PATH} (pre-push checks now run locally)"
    if value == HOOKS_PATH:
        return "keep", f"{CONFIG_KEY} already {HOOKS_PATH} — nothing to do"
    if own_paths and value in {p.rstrip("/") for p in own_paths}:
        if scope is not None and scope not in WRITABLE_SCOPES:
            return (
                "foreign",
                f"{CONFIG_KEY} is '{value}' — our own hooks directory as an absolute "
                f"path, but it is set in {scope.upper()} git config, which belongs to "
                f"the whole machine rather than to this repository, so it is left "
                f"alone [BUG-341]. Worktrees of this repo will run that ONE "
                f"checkout's hooks until it is removed: "
                f"git config --{scope} --unset {CONFIG_KEY}",
            )
        return (
            "normalize",
            f"{CONFIG_KEY} was '{value}' — our own hooks directory, but written as an "
            f"absolute path, which every git worktree of this repo then resolves to "
            f"that ONE checkout instead of its own. Rewritten to '{HOOKS_PATH}' so a "
            f"worktree runs the hooks of the branch it is on [FEAT-095].",
        )
    return (
        "foreign",
        f"{CONFIG_KEY} is set to '{value}', not '{HOOKS_PATH}' — leaving it alone. "
        f"If that was not deliberate: git config {CONFIG_KEY} {HOOKS_PATH}",
    )


def _git_setter(value: str, scope: str | None = None) -> None:
    """Write `value` to the scope the winning value was read from (rule five)."""
    argv = ["git", "config"]
    if scope == "worktree":
        argv.append("--worktree")
    subprocess.run([*argv, CONFIG_KEY, value], check=True)


def main(current: str | None = None, setter=None, own_paths=None, scope: str | None = None) -> int:
    force_utf8_stdio()
    if current is None and setter is None:
        current = current_hooks_path()
        scope = current_scope()
    if setter is None:
        def setter(value: str, _scope=scope) -> None:
            _git_setter(value, _scope)
    if own_paths is None:
        own_paths = own_hook_paths()

    action, message = plan(current, own_paths, scope)
    if action in ("set", "normalize"):
        try:
            setter(HOOKS_PATH)
        except Exception as exc:  # noqa: BLE001 — rule 3: never fail the install
            print(
                f"install_git_hooks: could not set {CONFIG_KEY} ({exc}). Skipping — "
                "CI still runs every one of these checks. To enable locally: "
                f"git config {CONFIG_KEY} {HOOKS_PATH}"
            )
            return 0
    print(f"install_git_hooks: {message}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
