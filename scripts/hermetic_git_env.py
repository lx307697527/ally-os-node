#!/usr/bin/env python3
"""
[BUG-525] An environment in which git cannot find the CALLER's repository.

A fixture that builds a throwaway repository — `git init <tmp>`, then
`git config user.email t@t`, `git commit` — trusts git to find THAT repository
from its working directory. git does so only when nothing in the environment has
already named one, and a git hook's environment always has. githooks(5):

    Environment variables, such as GIT_DIR, GIT_WORK_TREE, etc., are exported
    so that Git commands run by the hook can correctly locate the repository.

Measured on git 2.55.0.windows.3, 2026-09-23: in a LINKED worktree — where every
session in this repo works — pre-push receives
`GIT_DIR=<primary>/.git/worktrees/<name>`, and pre-commit receives that plus
`GIT_INDEX_FILE`. Under that environment a fixture's `git init <tmp>` leaves
<tmp> empty and re-initialises the named repository instead — and since that
path does not end in `/.git`, git guesses it is bare. Its `git config` writes
there directly. A linked worktree's config IS the shared `<primary>/.git/config`,
so every worktree on the machine inherits the result:

    core.bare = true           with extensions.worktreeConfig on (as here),
                               every worktree then refuses `git status`
    [user] name / email        the fixture's identity
    commit.gpgsign = false, gpg.format = ssh, user.signingkey and
    gpg.ssh.allowedSignersFile pointing into a deleted temp dir

That is the incident. Measured the same day against a sentinel repository named
the same way: 21 of the 135 guard self-test suites wrote into it.

WHICH VARIABLES

git's own answer first: `git rev-parse --local-env-vars` prints `local_repo_env`
(environment.c), the set git itself clears before it runs a command against a
different repository. LOCAL_REPO_ENV below is that output at git 2.55.0. Also
dropped, because each one still reaches into a fixture:

  * GIT_NAMESPACE — it does not locate a repository, but it re-roots every ref a
    local receive-pack writes, and fixtures push to file-path remotes;
  * GIT_INTERNAL_SUPER_PREFIX — gone from current git, re-prefixes every path a
    submodule command prints on an older one; dropping it costs nothing;
  * GIT_CONFIG_KEY_<n> / GIT_CONFIG_VALUE_<n> — the `-c` pairs GIT_CONFIG_COUNT
    (in the list) introduces; without the count they are inert, so this is
    tidiness, not safety.

The installed git's own list is unioned in at run time, so a newer git that adds
a name is covered without an edit here. The baseline is the floor: a git that
cannot be asked — missing, or failing — leaves exactly the baseline, never less.

Matching ignores case. Windows environment names are case-insensitive, and a
hand-built `{"git_dir": ...}` reaches git for Windows as GIT_DIR; on POSIX git
reads only the upper-case spelling, so dropping a lower-case look-alike there
costs nothing.

Everything else passes through untouched — PATH, HOME, GIT_EXEC_PATH,
GIT_AUTHOR_*, GIT_EDITOR, and the GIT_CONFIG_GLOBAL / GIT_CONFIG_NOSYSTEM that
fixtures set on purpose.

TWO ENTRY POINTS

  scrub(env)        a copy of `env` without them — for a subprocess environment
                    built from the caller's: `env = hermetic_git_env.scrub(os.environ)`.
  scrub_process()   removes them from THIS process's os.environ. A suite calls it
                    once at import, before anything can run git. A copy protects
                    only the calls it is handed; a `subprocess.run(["git", ...])`
                    with no `env=`, and every git the code under test runs
                    in-process, inherit os.environ instead.

`scripts/run_guard_self_tests.py` applies scrub() to every suite it starts, so a
suite that forgets scrub_process() is still safe inside the sweep; its own call
is what keeps it safe when it is run by itself.

This module decides nothing and touches no repository: no main(), no verdict.
"""
from __future__ import annotations

import functools
import os
import re
import subprocess
from typing import Mapping

__all__ = [
    "ALSO_DROPPED",
    "LOCAL_REPO_ENV",
    "is_local_env_var",
    "local_env_vars",
    "scrub",
    "scrub_process",
]

# `git rev-parse --local-env-vars`, git 2.55.0, in git's own order.
LOCAL_REPO_ENV = (
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_CONFIG",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_COUNT",
    "GIT_OBJECT_DIRECTORY",
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_IMPLICIT_WORK_TREE",
    "GIT_GRAFT_FILE",
    "GIT_INDEX_FILE",
    "GIT_NO_REPLACE_OBJECTS",
    "GIT_REPLACE_REF_BASE",
    "GIT_PREFIX",
    "GIT_SHALLOW_FILE",
    "GIT_COMMON_DIR",
)

# Not in git's list; why each is dropped anyway is in the module docstring.
ALSO_DROPPED = ("GIT_NAMESPACE", "GIT_INTERNAL_SUPER_PREFIX")

_BASELINE = frozenset(LOCAL_REPO_ENV + ALSO_DROPPED)
_CONFIG_PAIR = re.compile(r"GIT_CONFIG_(?:KEY|VALUE)_\d+")
_NAME = re.compile(r"[A-Z_][A-Z0-9_]*")


def _in_baseline(name: str) -> bool:
    upper = name.upper()
    return upper in _BASELINE or _CONFIG_PAIR.fullmatch(upper) is not None


def _ask_git() -> frozenset[str]:
    """The installed git's own list, or nothing when there is no git to ask.

    Asked with the baseline already removed: a malformed GIT_CONFIG_PARAMETERS
    makes EVERY git command die before it prints anything, and the answer must
    not depend on the variables it is asked about.
    """
    try:
        proc = subprocess.run(
            ["git", "rev-parse", "--local-env-vars"],
            env={k: v for k, v in os.environ.items() if not _in_baseline(k)},
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=60,
        )
    except (OSError, subprocess.SubprocessError):
        return frozenset()
    if proc.returncode != 0:
        return frozenset()
    names = (line.strip().upper() for line in proc.stdout.splitlines())
    return frozenset(n for n in names if _NAME.fullmatch(n))


@functools.lru_cache(maxsize=1)
def local_env_vars() -> frozenset[str]:
    """Every name dropped by exact match: the baseline plus git's own list.

    The numbered GIT_CONFIG_KEY_<n> / GIT_CONFIG_VALUE_<n> pairs are matched by
    pattern in `is_local_env_var`, since no finite list can hold them.
    """
    return _BASELINE | _ask_git()


def is_local_env_var(name: str) -> bool:
    """True when `name` would tell git which repository it is in (any case)."""
    return _in_baseline(name) or name.upper() in local_env_vars()


def scrub(env: Mapping[str, str]) -> dict[str, str]:
    """A copy of `env` without git's repository-local variables.

    `env` itself is never modified, so `scrub(os.environ)` leaves this process's
    environment as it was.
    """
    return {k: v for k, v in env.items() if not is_local_env_var(k)}


def scrub_process() -> list[str]:
    """Remove git's repository-local variables from this process's environment.

    Returns the names removed, sorted — empty when there was nothing to remove,
    which is the normal case outside a git hook. Every subprocess started
    afterwards inherits the scrubbed environment, including the ones started
    with no `env=` and the ones the code under test starts in-process.
    """
    removed = sorted(k for k in os.environ if is_local_env_var(k))
    for name in removed:
        del os.environ[name]
    return removed
