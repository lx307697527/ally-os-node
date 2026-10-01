#!/usr/bin/env python3
"""
Encoding contract for the scripts/ guards [BUG-020].

Every guard here reads UTF-8 (git output over a repo whose backlog, maps and
specs are largely Chinese) and writes UTF-8 (`✓`, `✗`, `—`, titles echoed back
out of those files). Python decides both encodings from the ambient environment
unless told otherwise, so on a Windows box whose ANSI codepage is not UTF-8
(cp936) the guards were simply unrunnable — in two independent ways:

  DECODE. `subprocess.run(..., text=True)` with no `encoding=` builds a
  TextIOWrapper on the locale encoding. Decoding UTF-8 Chinese as gbk raises
  UnicodeDecodeError inside subprocess's reader THREAD, the buffer stays empty,
  and `_communicate` returns `stdout[0] if stdout else None`. The caller gets
  **returncode 0 and stdout None** — git "succeeded" and produced nothing. On a
  codepage that can decode the bytes into *something* (cp1252) there is no
  exception at all, just a real verdict rendered over mojibake.

  ENCODE. When stdout is a pipe rather than a console, `print("✓")` is encoded
  with the ambient codepage and raises UnicodeEncodeError. The same script
  therefore succeeds in PowerShell (console, UTF-8 path) and fails in Git Bash
  (MinTTY pipe, gbk) — a gate whose runnability depends on which shell the
  contributor opened.

Both are the RULE-001 shape (something load-bearing left to implicit
environment discovery), and BUG-003's lesson one step over: a harness written
on Windows must ASSERT the environment-derived properties it depends on rather
than inherit them. The two AST ratchets in scripts/tests/test_guard_io.py are
that assertion.

Usage:
    from guard_io import force_utf8_stdio, run_text

    def main() -> int:
        force_utf8_stdio()
        ...

    out = run_text(["git", "-C", str(repo), "diff", rng]).stdout
"""
import os
import shutil
import subprocess
import sys

__all__ = ["GuardIoError", "force_utf8_stdio", "resolve_executable", "run_text"]


class GuardIoError(RuntimeError):
    """A command's output could not be obtained — the caller must fail closed.

    Subclasses RuntimeError deliberately: the guards already wrap their git
    helpers in `except RuntimeError` / `except GuardError` and turn that into
    `::error` + a precondition exit code. Landing there is the whole point — a
    bare `AttributeError: 'NoneType' object has no attribute 'strip'` is
    non-zero, so not fail-open, but it tells the reader nothing about which
    precondition broke (RULE-002: a guard must prove it ran).
    """


def force_utf8_stdio() -> None:
    """Pin this process's std streams to UTF-8, whatever the codepage is.

    Called first thing in every guard's main(). Reconfiguring rather than
    dropping the non-ASCII glyphs is deliberate: `✓`/`✗` carry the audit
    table's meaning, and Chinese titles read out of the backlog are the
    identifying half of most error messages.

    stdin is included for the same reason and not as an afterthought:
    write_session_log.py reads its hook payload as `json.load(sys.stdin)`, and
    that payload is UTF-8 JSON about a repo whose commit subjects are Chinese.

    Never raises. A stream that cannot be reconfigured is one of two harmless
    cases — an io.StringIO installed by contextlib.redirect_stdout (how every
    suite in scripts/tests captures guard output, and already unicode-clean), or
    a stream whose buffer is detached. Crashing here would break the guard on
    behalf of the fix.
    """
    for name in ("stdin", "stdout", "stderr"):
        reconfigure = getattr(getattr(sys, name, None), "reconfigure", None)
        if reconfigure is None:
            continue
        try:
            reconfigure(encoding="utf-8")
        except (ValueError, OSError):
            continue


def resolve_executable(argv):
    """Return `argv` with its command resolved the way the platform spells it.

    [BUG-244] Python's subprocess runs CreateProcess on Windows, and CreateProcess
    only ever appends `.exe` — never `.cmd` or `.bat`. `npx` and `pnpm` are `.cmd`
    scripts there, so `["npx", "tsc", ...]` died with FileNotFoundError on every
    Windows machine while the tool sat installed two directories away. Three of
    `pnpm lint`'s four stages were unrunnable, and since scripts/hooks/pre-push
    runs `pnpm lint`, no Windows contributor could push at all.

    `shutil.which` is the fix because it honours PATHEXT, so it finds `.cmd`,
    `.exe` and extensionless shims alike, on every platform, with no branch on
    `os.name` here.

    Resolution is deliberately best-effort and never itself a verdict:

    * A command that cannot be resolved is passed through UNCHANGED, so subprocess
      raises as before and run_text's existing GuardIoError branch reports it.
      Turning "not on PATH" into a different error here would move a fail-closed
      message that RULE-002 relies on.
    * An `argv[0]` that already carries a path separator is left alone — the
      caller has named a specific file and which() has no business second-guessing
      it.
    * A string `argv` (shell=True) is left alone: the shell does its own lookup.
    """
    if isinstance(argv, (str, bytes)):
        return argv
    argv = list(argv)
    if not argv:
        return argv
    head = argv[0]
    if not isinstance(head, str):
        head = os.fspath(head)
    if os.sep in head or (os.altsep and os.altsep in head):
        return argv
    found = shutil.which(head)
    if found:
        argv[0] = found
    return argv


def run_text(argv, *, capture_output: bool = True, errors: str = "strict",
             **kwargs) -> "subprocess.CompletedProcess[str]":
    """`subprocess.run` with the decode pinned, and an absent stream OR an absent
    executable made loud.

    [BUG-027] Three failure shapes are normalised to GuardIoError so every caller
    has exactly one exception to handle: an undecodable stream (both platform
    variants, below), and a command that could not be run at all because the
    executable is missing or not runnable. The last one was the gap — callers had
    been told to expect GuardIoError, but subprocess raises FileNotFoundError
    before this helper sees anything, so it escaped as a traceback. A command
    that EXISTS and exits non-zero is not an I/O failure and still returns
    normally: that verdict belongs to the caller.

    `errors` defaults to strict on purpose: a guard's verdict must never be
    rendered over silently substituted characters. Pass errors="replace" only
    where the text is advisory (a failure summary echoed to a human) and no
    decision reads it.

    A strict decode that fails surfaces DIFFERENTLY per platform, and both
    shapes are normalised to GuardIoError here so callers have one thing to
    handle. On Windows `_communicate` reads in a thread: the thread dies, the
    buffer stays empty, and the caller is handed returncode 0 with stdout None.
    On POSIX the decode happens inline and UnicodeDecodeError propagates out of
    subprocess.run itself. Only the second is visible on a UTF-8 CI runner,
    which is why this asymmetry is written down rather than discovered twice.
    """
    try:
        # Resolve for SPAWNING only; every message below still renders the argv the
        # caller passed, so a guard's error text keeps naming `npx tsc …` rather
        # than an absolute path nobody typed.
        proc = subprocess.run(
            resolve_executable(argv), capture_output=capture_output,
            encoding="utf-8", errors=errors, **kwargs,
        )
    except UnicodeDecodeError as e:
        raise GuardIoError(
            f"`{' '.join(str(a) for a in argv)}` produced output that is not "
            f"valid UTF-8 ({e}). Refusing to reach a verdict over bytes we "
            f"could not read (RULE-002)."
        ) from e
    except OSError as e:
        # [BUG-244] Widened from (FileNotFoundError, NotADirectoryError,
        # PermissionError) to their common base. The missing member was Windows'
        # `OSError: [WinError 193] %1 is not a valid Win32 application`, raised when
        # CreateProcess is handed the extensionless POSIX shim that npm writes into
        # node_modules/.bin beside the .CMD one. It is the same "could not be run"
        # shape BUG-027 set out to normalise, and it was escaping as a raw traceback
        # for exactly the reason BUG-027 describes. type(e).__name__ below still
        # tells the reader which member it was, so widening loses no information.
        # [BUG-027] The executable is absent (or not runnable) — the commonest
        # way a command's output "could not be obtained", and the one this helper
        # was silently NOT covering. subprocess raises before any decoding, so it
        # escaped as a bare traceback while every caller had been told to expect
        # GuardIoError; check_codegraph_version_pin's live_version() even
        # documents that promise. Net effect: doc-sync-check's Python-only
        # `mechanical-checks` job (no setup-node, no pnpm) crashed on every PR in
        # the repository instead of printing the ::error the guard already had.
        #
        # Deliberately NOT collapsed into the message above: "not installed" and
        # "installed but the output was unreadable" need different fixes, so they
        # must not read the same. Same reason the wording avoids "exited" — this
        # command never ran at all.
        raise GuardIoError(
            f"`{' '.join(str(a) for a in argv)}` could not be run: "
            f"{type(e).__name__} — the executable was not found or is not "
            f"runnable in this environment. Refusing to reach a verdict without "
            f"having run it (RULE-002). If this is a CI job, check that the "
            f"toolchain the command needs is actually installed there."
        ) from e
    if capture_output:
        for stream in ("stdout", "stderr"):
            if getattr(proc, stream) is not None:
                continue
            rendered = " ".join(str(a) for a in argv)
            raise GuardIoError(
                f"`{rendered}` exited {proc.returncode} but its {stream} could "
                f"not be read as UTF-8 — subprocess's reader thread died "
                f"decoding it (a UnicodeDecodeError is reported separately by "
                f"the threading excepthook) and the stream came back None. "
                f"Refusing to reach a verdict having read nothing (RULE-002)."
            )
    return proc
