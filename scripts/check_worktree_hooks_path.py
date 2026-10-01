#!/usr/bin/env python3
"""
Does this working tree run ITS OWN hooks? — [BUG-402].

RULE-002 says a guard must prove it ran, because a guard that fails silently
manufactures false confidence. This is that failure mode INVERTED, and it is
worse: a guard that was deliberately RETIRED still refusing pushes.

WHAT HAPPENS. The desktop app creates each per-task worktree with its own
`.git/worktrees/<name>/config.worktree`, and writes an ABSOLUTE
`core.hooksPath` into it:

    [core]
        longpaths = true
        hooksPath = D:\\Code\\ally-os\\scripts\\hooks

The shared `.git/config` holds the correct RELATIVE `scripts/hooks`, which git
resolves against whichever working tree the hook runs in. But git's precedence
is system < global < local < worktree, so the absolute value wins, and every
worktree runs the PRIMARY checkout's copy of the hooks at whatever revision
that checkout happens to sit on.

Measured 2026-09-20 on this repo: the primary checkout was 3459 commits behind
`origin/main`, and line 219 of its `pre-push` still called
`scripts/check_blast_radius_record.py` — deleted by 0221f5236 [FEAT-546] when
the blast radius moved into CI. So python exited non-zero with "can't open
file", the hook recorded a failure for `blast-radius records`, and the push was
refused for a guard that no longer exists. Of 29 live worktrees, 25 carried the
absolute path. `ops/session-logs/2026-09-18-worktree-bug-345-c5f37812.md:43`
records the same symptom, and BUG-402's own spec-id tag receipt was refused by
it.

WHY THIS IS NOT BUG-341 AGAIN. Rule five of `install_git_hooks.py` already
repairs exactly this, in exactly the right scope — read the scope with
`--show-scope`, write it back there. That rule is correct and its test pins it.
What was missing is WHEN it runs: it is wired to `postinstall`, and nobody runs
`pnpm install` inside a per-task worktree. The repair existed and never fired,
and nothing anywhere REPORTED the mismatch. So this guard is the report, and
`--repair` is the same tested rule five invoked from somewhere that actually
runs in a worktree (SessionStart).

TWO WAYS TO ASK, AND THE STRONGER ONE IS PREFERRED. Given `--running-hook`, the
answer needs no inference at all: the hook that is executing knows its own path,
so `pre-push` passes its own `${BASH_SOURCE[0]}` and this compares it against
the hooks directory of the tree being pushed. Without it, the verdict is derived
from `core.hooksPath` as git resolves it. The direct form cannot be fooled by a
config that looks right for a reason that is not the reason it is right.

SCOPE, DELIBERATELY NARROW. This judges a LOCAL developer environment, so it is
wired into `scripts/hooks/pre-push` and SessionStart, and NOT into
`harness check --all` or any workflow. A CI checkout has no `core.hooksPath`
and needs none — `not-installed` there would be a true statement about an
irrelevant property, i.e. the noise BUG-017 documents.

A value pointing somewhere that is NOT this repo's hooks is another tool's
setting: reported, never failed. That is rule one of `install_git_hooks.py`,
and disagreeing with it here would mean this guard demands a change that the
installer refuses to make.

WHERE THE SESSIONSTART VERDICT GOES [BUG-532]. Claude Code documents that a
SessionStart hook's stdout reaches the session's context — plain text, or one
JSON object carrying `hookSpecificOutput.additionalContext` — and does not say
what becomes of stderr when the hook exits 0, which `--repair` always does. This
mode used to put every verdict worth hearing on stderr only, so in BUG-525's bare
state (measured by BUG-531) the session's context got a single line,
"install_git_hooks: ... nothing to do", which reads as healthy. `--repair` now
writes exactly ONE JSON object to stdout, the contract fact_layer_ready_hook.py
and check_checkout_not_bare.py already use, with install_git_hooks.py's own
stdout folded into it — printed beside the object, plain text would stop the
harness from parsing either as JSON.

Exit codes: 0 clean (or foreign) · 1 wrong hooks · 2 could not judge.
With `--repair`: always 0 (SessionStart must speak, not block), and stdout is one
SessionStart JSON object; other-checkout, not-installed and undecidable also go
to stderr line by line, and the first two, the findings, to the user as
`systemMessage`.
"""
from __future__ import annotations

import argparse
import contextlib
import io
import json
import subprocess
import sys
from collections.abc import Sequence
from pathlib import Path

from guard_io import force_utf8_stdio

HOOKS_SUBDIR = "scripts/hooks"
CONFIG_KEY = "core.hooksPath"
GUARD = "check_worktree_hooks_path:"
TAG = "[worktree-hooks]"

# Where the repo lives, derived from this file rather than from the working
# directory: SessionStart does not promise a cwd, and `git rev-parse` would
# then answer about whatever tree the session happened to start in.
REPO_ROOT = Path(__file__).resolve().parents[1]


def _git(*argv: str) -> str | None:
    """One git line, or None if git cannot be asked (never an exception)."""
    try:
        proc = subprocess.run(
            ["git", "-C", str(REPO_ROOT), *argv],
            capture_output=True,
            text=True,
            encoding="utf-8",
        )
    except OSError:
        return None
    return proc.stdout.strip() if proc.returncode == 0 else None


def _norm(path: str | Path) -> str:
    """One spelling for one directory: forward slashes, no trailing slash, case-folded.

    Case-folded because this defect is overwhelmingly a Windows one, where
    `D:\\Code\\...` and `d:\\code\\...` are the same directory. On a
    case-sensitive filesystem two genuinely different directories can fold
    together, which would make this guard MISS a mismatch rather than invent
    one — the safe direction, and the one BUG-017 argues for.

    It does NOT make a path absolute: doing that here would read the process's
    working directory, and `plan()` has to stay pure. Callers make paths
    absolute against an explicit `toplevel` first.
    """
    return str(Path(path)).replace("\\", "/").rstrip("/").casefold()


def _against(toplevel: str, path: str) -> Path:
    """Resolve `path` the way git resolves a hook path: against the working tree.

    git invokes the hook by whatever `core.hooksPath` spells, so a relative
    value arrives here relative — `${BASH_SOURCE[0]}` is literally
    `scripts/hooks/pre-push` on the normal path. Comparing that to an absolute
    directory matches nothing, which made the first cut of this guard refuse
    every correctly-configured push. An absolute value is left alone, which is
    exactly the case that SHOULD stand out.
    """
    candidate = Path(path)
    return candidate if candidate.is_absolute() else Path(toplevel) / candidate


def resolve_hooks_dir(configured: str | None, toplevel: str, common_dir: str) -> str:
    """The directory git will look in for hooks.

    Mirrors git's own rule: an unset `core.hooksPath` means `$GIT_COMMON_DIR/hooks`
    — which for a linked worktree is the PRIMARY checkout's `.git/hooks`, shared,
    and never this repo's tracked `scripts/hooks`. A relative value resolves
    against the working tree the hook runs in; an absolute one against nothing.
    """
    value = (configured or "").strip()
    if not value:
        return str(Path(common_dir) / "hooks")
    candidate = Path(value)
    if candidate.is_absolute():
        return str(candidate)
    return str(Path(toplevel) / candidate)


def plan(
    *,
    configured: str | None,
    scope: str | None,
    toplevel: str | None,
    own_hooks: str | None,
    resolved: str | None,
    running_hook: str | None = None,
) -> tuple[str, str]:
    """Pure decision. Verdict in ok/other-checkout/not-installed/foreign/undecidable.

    Every input is injected so the whole decision is reachable without a git
    repository; `discover()` is the half that talks to git. BUG-341's lesson was
    that asserting on the call rather than on the read-back hides a defect, so
    the suite for this drives real repositories too — but the branching lives
    here.
    """
    if not toplevel or not own_hooks:
        return (
            "undecidable",
            f"could not ask git where this working tree is, so whether it runs its "
            f"own hooks is unknown. Not a pass: re-run inside a git checkout — and if "
            f"this IS one, git may be treating it as bare (core.bare = true); "
            f"`python3 scripts/check_checkout_not_bare.py` names the file [BUG-531]. "
            f"({CONFIG_KEY} read as {configured!r})",
        )

    own = _norm(own_hooks)
    fix = "python3 scripts/install_git_hooks.py    # rewrites it in the scope it came from [BUG-341]"

    # The direct question, when the caller can answer it: which file is running?
    if running_hook:
        actual_dir = _norm(_against(toplevel, running_hook).parent)
        if actual_dir != own:
            return (
                "other-checkout",
                f"the hook that is RUNNING is {running_hook} — its directory is not "
                f"this working tree's {HOOKS_SUBDIR}. This tree is {toplevel}, so the "
                f"checks being applied are another checkout's, at whatever revision it "
                f"sits on: a guard deleted on this branch can still refuse the push, "
                f"and a guard added on this branch never runs [BUG-402]. Fix:\n    {fix}",
            )
        return ("ok", f"running this tree's own hook ({running_hook})")

    if not (configured or "").strip():
        return (
            "not-installed",
            f"{CONFIG_KEY} is unset, so git uses the shared .git/hooks and this repo's "
            f"tracked {HOOKS_SUBDIR} never runs — no local pre-push gate at all "
            f"[FEAT-034]. Fix:\n    {fix}",
        )

    if resolved is None:
        return (
            "undecidable",
            f"{CONFIG_KEY} is {configured!r} but it could not be resolved to a directory.",
        )

    if _norm(resolved) == own:
        where = f" (in {scope} scope)" if scope else ""
        return ("ok", f"{CONFIG_KEY} resolves to this tree's own {HOOKS_SUBDIR}{where}")

    # Ours, but another checkout's copy of it — the BUG-402 shape.
    if _norm(resolved).endswith("/" + HOOKS_SUBDIR):
        scope_note = f" It is set in {scope.upper()} scope." if scope else ""
        tail = (
            fix
            if scope in (None, "local", "worktree")
            else f"git config --{scope} --unset {CONFIG_KEY}    # it belongs to your whole machine, not this repo"
        )
        return (
            "other-checkout",
            f"{CONFIG_KEY} is {configured!r}, which resolves to {resolved} — a "
            f"{HOOKS_SUBDIR} that is NOT this working tree's. This tree is {toplevel}."
            f"{scope_note} Every push from here runs that other checkout's hooks at "
            f"whatever revision it sits on, so a retired guard can still refuse the "
            f"push and a new one never runs [BUG-402]. Fix:\n    {tail}",
        )

    return (
        "foreign",
        f"{CONFIG_KEY} is {configured!r}, which is not this repo's {HOOKS_SUBDIR} at "
        f"all — another tool owns it, so it is left alone (rule 1 of "
        f"install_git_hooks.py). If that was not deliberate:\n"
        f"    git config --unset {CONFIG_KEY}",
    )


def discover() -> dict[str, str | None]:
    """The half that talks to git. Every value may be None."""
    configured = _git("config", "--get", CONFIG_KEY)
    scope_line = _git("config", "--show-scope", "--get", CONFIG_KEY)
    fields = (scope_line or "").split(maxsplit=1)
    scope = fields[0] if len(fields) == 2 else None

    toplevel = _git("rev-parse", "--show-toplevel")
    common_dir = _git("rev-parse", "--path-format=absolute", "--git-common-dir")

    own_hooks = str(Path(toplevel) / HOOKS_SUBDIR) if toplevel else None
    resolved = (
        resolve_hooks_dir(configured, toplevel, common_dir)
        if toplevel and common_dir
        else None
    )
    return {
        "configured": configured,
        "scope": scope,
        "toplevel": toplevel,
        "own_hooks": own_hooks,
        "resolved": resolved,
    }


EXIT = {
    "ok": 0,
    "foreign": 0,
    "other-checkout": 1,
    "not-installed": 1,
    "undecidable": 2,
}
# The two findings: pushes from this tree are gated by the wrong hooks, or by none.
DEGRADED = ("other-checkout", "not-installed")
NOISY = (*DEGRADED, "undecidable")
DEGRADED_LINE = (
    f"{TAG} Degraded, not blocked: your pushes are gated by the wrong hooks this "
    "session. Run the fix above before you push."
)
# Not "run the fix": --repair has already run the one fix that is safe to
# automate, so whatever is still wrong needs a person — and for a value that
# points at a third checkout, the fix `plan()` names does not even help.
TELL_THE_USER = (
    f"{TAG} Tell the user before anything else, and leave the fix to them: --repair "
    "already made the one change that is safe to automate, so what remains is a git "
    "config change for them to make, not this session."
)


def run_repair() -> tuple[list[str], list[str]]:
    """install_git_hooks.py's rule five, in-process: (what it printed, what went wrong).

    Delegate the WRITE to the one place that already gets the scope right and is
    already tested for it (BUG-341). Duplicating it here would be a second
    implementation of the rule whose first implementation caused the incident.

    Its stdout is CAPTURED, not passed through [BUG-532]: in this mode stdout is
    one SessionStart JSON object and nothing else. What is captured is its
    `print()`s, the import's included; the one git child it leaves uncaptured,
    the `git config` write, prints nothing to stdout — its errors go to stderr.
    """
    printed = io.StringIO()
    problems: list[str] = []
    try:
        with contextlib.redirect_stdout(printed):
            import install_git_hooks

            install_git_hooks.main()
    except Exception as exc:  # noqa: BLE001 — SessionStart never fails a session
        problems.append(f"{TAG} could not run install_git_hooks.py: {exc}")
    return printed.getvalue().splitlines(), problems


def session_start(
    verdict: str,
    message: str,
    printed: Sequence[str] = (),
    problems: Sequence[str] = (),
) -> tuple[dict, list[str]]:
    """What `--repair` says: (the ONE JSON object for stdout, the lines for stderr). Pure.

    Everything goes into `additionalContext`, install_git_hooks.py's words first
    because it ran first: that is the channel documented to reach the session.
    stderr keeps what it always carried, one line at a time, for a person reading
    the transcript. A finding also hands the user those same stderr lines as
    `systemMessage`, the split check_checkout_not_bare.py makes: `undecidable` is
    never a pass, but it is not a finding either.
    """
    said = f"{TAG} {verdict}: {message}".splitlines()
    stderr = [*problems, *(said if verdict in NOISY else ())]
    context = [*printed, *problems, *said]
    if verdict in DEGRADED:
        stderr.append(DEGRADED_LINE)
        context += [DEGRADED_LINE, TELL_THE_USER]
    payload: dict = {
        "hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": "\n".join(context),
        }
    }
    if verdict in DEGRADED:
        payload["systemMessage"] = "\n".join(stderr)
    return payload, stderr


def repair_and_report(running_hook: str | None = None) -> int:
    """`--repair`: normalise, judge, say it as one SessionStart JSON object. Always 0."""
    printed, problems = run_repair()
    try:
        verdict, message = plan(**discover(), running_hook=running_hook)
    except Exception as exc:  # noqa: BLE001 — never a traceback at SessionStart, never a pass
        verdict, message = "undecidable", f"the check itself failed: {exc!r}. Not a pass."
    payload, stderr = session_start(verdict, message, printed, problems)
    for line in stderr:
        print(line, file=sys.stderr)
    # ensure_ascii=False: paths may be non-ASCII, and force_utf8_stdio() made
    # stdout UTF-8 (BUG-020).
    print(json.dumps(payload, ensure_ascii=False))
    return 0


def main(argv: list[str] | None = None) -> int:
    force_utf8_stdio()
    ap = argparse.ArgumentParser(description="Does this working tree run its own hooks? [BUG-402]")
    ap.add_argument(
        "--running-hook",
        help="absolute path of the hook file currently executing; pre-push passes "
        "its own ${BASH_SOURCE[0]} so the verdict needs no inference from config",
    )
    ap.add_argument(
        "--repair",
        action="store_true",
        help="normalise the path first (install_git_hooks.py rule five), then report as "
        "one SessionStart JSON object on stdout. Always exits 0 — this is the "
        "SessionStart mode, which must speak, not block.",
    )
    args = ap.parse_args(argv)

    if args.repair:
        return repair_and_report(args.running_hook)

    verdict, message = plan(**discover(), running_hook=args.running_hook)
    stream = sys.stderr if verdict in NOISY else sys.stdout
    print(f"{GUARD} {verdict}: {message}", file=stream)
    return EXIT[verdict]


if __name__ == "__main__":
    sys.exit(main())
