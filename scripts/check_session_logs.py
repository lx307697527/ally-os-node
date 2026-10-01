#!/usr/bin/env python3
"""
[FEAT-040 phase 2] Session-log visibility report.

Suite: `scripts/tests/test_check_session_logs.py`.

WHY THIS EXISTS

FEAT-029 shipped a two-layer log and was honest that the valuable half — the
judgment layer — "cannot be machine-guaranteed": the `UNFILLED` marker makes a
miss VISIBLE, it cannot make writing one MANDATORY. But visible to whom? Nothing
ever looked. Measured 2026-08-04 on this repository: **13 of 41** logs still
carry the marker, and the only way anybody would learn that is by running the
`grep` the README suggests, which no session had reason to run.

The second category is worse and newer. The writer deliberately never runs a git
WRITE, so a log reaches the repository only because a human committed it. On a
local checkout an uncommitted log is STRANDED — annoying, recoverable. On a
remote container it is LOST: the tree is reclaimed when the session ends, and the
one artifact nobody can reconstruct goes with it. The same now applies to the
distilled transcripts under `ops/session-transcripts/`.

So this is a REPORT, not a gate, and the distinction is deliberate:

  0  ran fine — findings included. An unwritten judgment layer belongs to the
     session that did not write it, and a stranded log belongs to whoever had it
     in their tree. Reddening the NEXT contributor's branch for either would
     punish the one person who can fix neither, and an alarm that fires at the
     wrong people is how a SessionStart notice becomes wallpaper. Same posture as
     `check_audit_freshness` (schedule-only, never a PR gate) and the same reason.
  2  precondition failure — the repository could not be read at all. Being
     unable to ASK is not the same as having nothing to report, and rendering it
     as the clean verdict is the BUG-020 shape: a `git` that never ran hands back
     an empty stream, and a caller that reads empty as "nothing untracked"
     reports all-clear forever. `check_typecheck_coverage.analyze` set the
     precedent by refusing to report success over an empty tracked set.

There is deliberately no exit 1. Nothing here is a violation — only work someone
has not finished yet.

ONE JUDGE, NOT TWO

"Is this judgment layer written?" is answered by importing the WRITER's own
`judgment_is_filled`, never by re-implementing it. Two cases in the suite are
satisfiable only that way, and both are real shapes from this repository:

  * a log whose judgment layer IS written while its MECHANICAL half quotes the
    README's `grep -rl UNFILLED` command — a whole-file grep reports it falsely;
  * a log whose marker was DELETED but whose prompts were never answered — a
    whole-file grep misses it entirely, and it is the more dishonest of the two.

A second parser would drift from the writer's, and the symptom of that drift is
silence: this report would quietly disagree with the merge logic that decides
whether a session's judgment layer gets preserved or overwritten.
"""
import argparse
import sys
from pathlib import Path

from guard_io import GuardIoError, force_utf8_stdio, run_text
from write_session_log import judgment_is_filled, judgment_split

REPO = Path(__file__).resolve().parent.parent
LOG_DIR = "ops/session-logs"
ARCHIVE_DIR = "ops/session-transcripts"


class Precondition(Exception):
    """The repository could not be read — exit 2, never a clean verdict."""


def unfilled_logs(repo: Path) -> list[str]:
    """Names of logs whose judgment layer is missing or hollow.

    An unreadable log is REPORTED rather than raised on: one corrupt file must
    not cost the report on all the others, and "we could not read this one" is
    itself a finding a reader can act on.
    """
    log_dir = repo / LOG_DIR
    if not log_dir.is_dir():
        # A fresh clone or a brand-new worktree has written no logs yet. That is
        # an empty set, not a broken precondition — failing here would open every
        # new tree with a false alarm.
        return []
    findings = []
    for path in sorted(log_dir.glob("*.md")):
        if path.name == "README.md":
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as e:
            findings.append(f"{path.name}(读不出来:{e.__class__.__name__})")
            continue
        split = judgment_split(text)
        if split is None or not judgment_is_filled(split[1]):
            findings.append(path.name)
    return findings


def untracked_artifacts(repo: Path) -> list[str]:
    """Logs and archives that exist in the working tree and in no commit.

    `--others --exclude-standard` is the question exactly: files git knows
    nothing about, minus anything .gitignore'd. A file that is tracked but
    MODIFIED is not reported — it is already in history, so nothing is lost when
    the container goes away, and reporting it would bury the category that
    matters.
    """
    try:
        proc = run_text(
            ["git", "-C", str(repo), "ls-files", "--others", "--exclude-standard",
             "--", LOG_DIR, ARCHIVE_DIR],
            errors="replace",
        )
    except (GuardIoError, OSError) as e:
        raise Precondition(f"`git ls-files` 无法在 {repo} 上执行:{e}") from e
    if proc.returncode != 0:
        raise Precondition(
            f"`git ls-files` 在 {repo} 上返回 {proc.returncode}"
            f"(可能不是 git 仓库):{(proc.stderr or '').strip()}"
        )
    if proc.stdout is None:
        # BUG-020's exact shape: returncode 0 with no stream is a decode failure
        # wearing success's clothes, and treating it as "no untracked files"
        # would report all-clear forever.
        raise Precondition(f"`git ls-files` 在 {repo} 上没有返回可解码的输出")
    return sorted(line.strip() for line in proc.stdout.splitlines() if line.strip())


def report(repo: Path) -> tuple[int, list[str]]:
    """The whole verdict, as (exit code, lines). Pure enough to test directly."""
    try:
        unfilled = unfilled_logs(repo)
        untracked = untracked_artifacts(repo)
    except Precondition as e:
        return 2, [f"::error::check_session_logs 无法判断:{e}"]

    lines = []
    if untracked:
        lines.append(
            f"check_session_logs: {len(untracked)} 份日志/归档**尚未进 git** —— "
            "远程会话里容器一回收就永久丢失,请随本次 PR 提交:"
        )
        lines += [f"  - {name}" for name in untracked]
    if unfilled:
        lines.append(
            f"check_session_logs: {len(unfilled)} 份日志的**判断层没写** —— "
            "机械层 git log 也能看出大半,判断层才是真正会被挖到东西的那一半:"
        )
        lines += [f"  - {LOG_DIR}/{name}" for name in unfilled]
    if not lines:
        lines.append("check_session_logs: OK —— 判断层齐全,且没有未入 git 的日志/归档。")
    return 0, lines


def main(argv: list[str] | None = None) -> int:
    force_utf8_stdio()
    parser = argparse.ArgumentParser(
        description="Report session logs with an unwritten judgment layer, and "
                    "logs/archives that are not committed yet.",
    )
    parser.add_argument("--repo", default=str(REPO))
    args = parser.parse_args(argv)

    code, lines = report(Path(args.repo))
    for line in lines:
        print(line)
    return code


if __name__ == "__main__":
    sys.exit(main())
