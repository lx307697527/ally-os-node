#!/usr/bin/env python3
"""
Session-log writer [FEAT-029] — the mechanical half of the agent work log.

Runs from the SessionEnd hook (`.claude/hooks/session-log.sh`). Reads the hook
payload on stdin, parses the session transcript, and writes one markdown file to
`ops/session-logs/` so teammates can read what an agent actually did and mine it
for things worth folding back into the project.

WHY A TWO-LAYER LOG. A hook can record what happened — files changed, commands
run, PRs opened. It cannot record the part with the most value: which approaches
were tried and abandoned, and why. That judgment layer is left as an explicitly
UNFILLED section, so a reader can tell at a glance whether anyone wrote it. A log
that silently omits it while looking complete would be worse than no log.

WHAT THIS IS NOT. Not a guard — it gates nothing. RULE-002's fail-closed rule
therefore does not apply: making session teardown fail would protect nothing. The
contract here is the honest analogue: **always leave an artifact, and when the
input could not be read, say so inside the artifact** rather than exiting quietly.
So every error path still writes a log, and main() returns 0.

DELIBERATELY NOT COMMITTED FROM HERE. The writer never runs a git WRITE — no
`add`, no `commit`, no `push`. A hook that committed could land mid-rebase or
sweep unrelated files into a commit. The file lands in the working tree and rides
along with the session's own PR.
KNOWN GAP, stated rather than hidden: a session that ends without anyone
committing leaves its log uncommitted, and the next session's SessionStart notice
is what surfaces it. Distribution is a convention, not a mechanism. On a REMOTE
container that gap is not "stranded" but "lost" — the tree is reclaimed — which
is why `scripts/check_session_logs.py` names untracked artifacts at SessionStart.

[FEAT-040] READ-ONLY git is now in bounds, and the distinction is the point. The
prose above used to say "never runs git", while the only thing enforcing it —
`test_writer_does_not_touch_git` — forbade exactly the three WRITE verbs. Every
argument in that paragraph (a commit mid-rebase, unrelated files swept in) is an
argument about writing. So `git branch --show-current` is used to recover a
branch name the transcript did not carry, and the ratchet in the FEAT-040 suite
pins both halves: no write verb may appear, and at least one read verb must.

[FEAT-040] RESOLUTION, NOT TRUST. The SessionEnd payload names the transcript
after the PAYLOAD session id, but the file on disk can carry a different
(container/CCR) id — measured on this repo's own remote sessions, where 5 of 41
logs came out as `0000-00-00-no-branch-*` with an empty mechanical layer while a
complete 1.4 MB transcript sat in the same directory. So the payload's path is a
first guess, not the answer: `resolve_transcript` falls back to the newest
`*.jsonl` beside it and the log SAYS SO, naming both paths. A fallback nobody can
see is how you turn a visible failure into an invisible one.

[FEAT-040] THE ARCHIVE. The same run also distils the transcript into
`ops/session-transcripts/<same stem>.jsonl`: prompts, thinking VERBATIM, assistant
text, and tool CALLS — never tool_result bodies (bulk, and the likeliest carrier
of environment values), attachments or queue-operations. It is rewritten whole
each time rather than merged: unlike the log it has no hand-written half to
protect, so "one session, one archive" is cheaper to guarantee by regenerating.
When no transcript could be read at all, NO archive is written — an empty shell
would claim a session did nothing, when the truth is nothing was recorded.

REDACTION. Command strings are recorded (they are the reusable part) but passed
through a redactor first, because a shared artifact must not carry a token that
happened to appear on a command line. Redactions are visible, never silent drops.
The patterns cover the shapes this repo can plausibly produce; it is a safety net
over an unlikely event, not a claim of completeness.

MERGE, NOT OVERWRITE [BUG-024]. The judgment layer can only be written by the
session that holds the judgment, i.e. while that session is still running — but
this writer only runs at SessionEnd. The first version closed that circle the
wrong way round: it ended in an unconditional `write_text()`, so a judgment layer
written during the session was destroyed on the way out, and there was no moment
at which the valuable half could safely be recorded. So the write is now a merge:
**the mechanical layer is the hook's to rewrite, everything from the `## 判断层`
heading to EOF is the session's to keep**, preserved byte for byte. Only content
under that heading survives — a pre-writer who puts notes above it will find them
replaced by the real mechanical facts, which is the point of the split.

The merge fires only when that section holds actual writing: still carrying the
UNFILLED marker, or holding nothing but the template's unanswered prompts, both
count as empty and are overwritten. Preserving an empty section would hand back
exactly what this design calls worse than no log — one that looks complete and
says nothing.
"""
import json
import re
import subprocess
import sys
from datetime import datetime, tzinfo
from pathlib import Path

from guard_io import force_utf8_stdio

REPO = Path(__file__).resolve().parent.parent
LOG_DIR = "ops/session-logs"
# [FEAT-040] The distilled archive lives beside the logs, same stem, .jsonl.
ARCHIVE_DIR = "ops/session-transcripts"
# [FEAT-040] A pasted payload inside a tool call is noise; the call itself is the
# reusable part. Thinking and assistant text are NEVER capped — archiving them
# whole is the reason the file exists.
ARCHIVE_FIELD_MAX = 2000
UNFILLED_MARKER = "<!-- UNFILLED: 判断层未填写 -->"
REDACTED = "[REDACTED]"
TRUNCATED = "…[truncated]"
CMD_MAX = 220

NOTE_TWO_LAYER = "> 机械层由 SessionEnd hook 自动写入(FEAT-029);**判断层需人/agent 收尾时手写**。"
NOTE_PRESERVED = "> 机械层由 SessionEnd hook 自动写入(FEAT-029);**判断层是本次会话手写的,已原样保留**(BUG-024)。"

# The judgment heading, matched loosely on purpose. The template writes
# `## 判断层(手写 —— hook 写不出这部分)`, but the first hand-written log used
# full-width parens `（…）` — pinning the exact string would have made the matcher
# miss the one real artifact it exists to protect. Two hashes exactly: an `###`
# inside the section is content, not a new section.
JUDGMENT_H2_RE = re.compile(r"^##[ \t]*判断层.*$", re.M)
# A template prompt nobody answered: `- **试过又放弃的路径,以及为什么**:` with
# nothing after the colon. Half- and full-width colons both, since the template
# is Chinese and hand edits drift between them.
#
# [FEAT-040] `[^:：]*` between the bold label and the colon is a BUG FIX, not
# tidying. The template's last prompt carries a parenthetical outside the bold —
# `- **值得纳入项目的点**(规则候选、可复用命令、文档漏洞):` — which the original
# pattern could not match, because it required the colon to follow `**`
# immediately. One unmatched line is enough to make the whole section read as
# written: a log whose UNFILLED marker had been deleted but whose prompts were
# never answered counted as FILLED, so `merge_log` PRESERVED the hollow section
# instead of refreshing it, and `check_session_logs` would never report it. That
# is precisely the "looks complete, says nothing" artifact FEAT-029 called worse
# than no log. Surfaced by FEAT-040's AC-13 case, which deletes the marker and
# demands the section still be judged empty.
#
# The bound stays tight in the direction that matters: anything AFTER the colon
# is content, so an answered prompt is still filled.
EMPTY_PROMPT_RE = re.compile(r"^\s*[-*]\s*\*\*.*?\*\*[^:：]*[:：]?\s*$")
HTML_COMMENT_RE = re.compile(r"^\s*<!--.*-->\s*$")

# Tools whose file_path is a CHANGE vs. merely a read. Kept explicit rather than
# inferred, so a new mutating tool must be added here consciously.
WRITE_TOOLS = ("Edit", "Write", "NotebookEdit", "MultiEdit")
READ_TOOLS = ("Read",)

# Machine-specific home paths are noise in a shared artifact, and they are all
# over command strings (34 of 71 commands in the first real run). Collapse to ~.
HOME_RE = re.compile(r"/(?:Users|home)/[A-Za-z0-9._-]+")

SECRET_RES = [
    re.compile(r"gh[pousr]_[A-Za-z0-9]{16,}"),
    re.compile(r"sk-[A-Za-z0-9-]{12,}"),
    re.compile(r"AKIA[0-9A-Z]{12,}"),
    re.compile(r"(?i)(bearer|token|api[-_]?key|password|secret)[\"'\s:=]+[A-Za-z0-9._\-/+]{12,}"),
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
]


def redact(text: str) -> str:
    for rx in SECRET_RES:
        text = rx.sub(REDACTED, text)
    return HOME_RE.sub("~", text)


def one_line(cmd: str) -> str:
    """Commands are recorded for reuse, so keep the invocation and drop the payload.

    A heredoc body (`python3 - <<'PY' … PY`) is an inlined script, not a command:
    the real run produced a 7,744-char entry and a 28 KB log. The first line plus a
    visible truncation marker is what a reader can actually act on.
    """
    head = cmd.strip().splitlines()[0] if cmd.strip() else ""
    extra = len(cmd) - len(head)
    if extra > 0 or len(head) > CMD_MAX:
        return f"{head[:CMD_MAX]} {TRUNCATED} (+{max(extra, len(head) - CMD_MAX)} chars)"
    return head


def local_date(ts: str, tz: tzinfo | None = None) -> str:
    """Transcript timestamps are UTC; the filename date must be LOCAL.

    This team works in UTC+8, so a session ending 18:00Z lands at 02:00 the next
    day for them. The first real run filed that session under the previous date,
    which makes "today's logs" silently miss it. Unparseable input degrades to the
    raw date prefix rather than costing the log.

    `tz` defaults to None, which `astimezone` reads as the host's own zone — the
    only thing the writer itself ever wants, and byte-for-byte what this did
    before the parameter existed. It is here so the date boundary can be asserted
    against a *stated* zone instead of by retuning the whole process's clock,
    which is not possible on Windows [BUG-025].
    """
    try:
        return datetime.fromisoformat((ts or "").replace("Z", "+00:00")).astimezone(tz).strftime("%Y-%m-%d")
    except ValueError:
        return (ts or "")[:10]


def host_today(tz: tzinfo | None = None) -> str:
    """The writing machine's local date [FEAT-040].

    Used only when NO transcript could be read, so there is no session timestamp
    to date the file by. `0000-00-00` was the previous answer: it sorts before
    every real log, hides when the session happened, and reads as corruption
    rather than as "the transcript was lost". The host's own date is not the
    session's date in the strictest sense — but it is within hours of it, and the
    problem line right inside the file says the transcript was never read.
    """
    return datetime.now(tz).astimezone(tz).strftime("%Y-%m-%d")


def git_branch(cwd: str) -> str:
    """The current branch via a READ-ONLY git query, or "" [FEAT-040].

    Never raises: this is a logger, and a SessionEnd that dies costs the log AND
    the clean exit. Every failure mode — git absent, not a repository, detached
    HEAD, a hang — degrades to "" and the caller falls back to `no-branch`, which
    is what the writer did before this existed. `encoding` is stated (BUG-020:
    an unstated encoding hands back returncode 0 with stdout None on a non-UTF-8
    console, i.e. failure wearing success's clothes), and so is a timeout, since
    a wedged git would otherwise hold session teardown open indefinitely.
    """
    try:
        proc = subprocess.run(
            ["git", "branch", "--show-current"],
            cwd=cwd or None,
            capture_output=True,
            encoding="utf-8",
            errors="replace",
            timeout=10,
        )
    except (OSError, ValueError, subprocess.SubprocessError):
        return ""
    if proc.returncode != 0 or not proc.stdout:
        return ""
    return proc.stdout.strip()


def resolve_transcript(path: Path) -> tuple[Path | None, str]:
    """Pick the transcript to parse: the payload's path, else its newest sibling.

    Returns `(chosen, note)`; `note` is empty when the payload's own path was
    used, and otherwise describes the fallback for the log's problem area.

    WHY A FALLBACK AT ALL [FEAT-040]. The payload names the transcript after the
    payload session id; on a remote container the file on disk carries a
    different one. The transcript is right there, complete, under another name —
    so "unreadable path" is a naming mismatch far more often than a missing file.

    NEWEST mtime, not the richest-looking or the alphabetically first: the most
    recently written transcript in the session's own directory is the best
    available guess at "this session". The guess can be wrong, which is exactly
    why the note names the file — a reader can always tell whose facts they are
    reading. A silent guess would be the worse artifact.
    """
    try:
        if path and path.is_file():
            return path, ""
    except OSError:
        pass
    try:
        siblings = [p for p in path.parent.glob("*.jsonl") if p.is_file()]
    except (OSError, ValueError):
        siblings = []
    if not siblings:
        return None, ""
    try:
        chosen = max(siblings, key=lambda p: p.stat().st_mtime)
    except OSError:
        return None, ""
    return chosen, (
        f"transcript unreadable at `{path}` —— 已回退到同目录 mtime 最新的 "
        f"`{chosen.name}`,以下机械层出自该文件。"
    )


def slug(text: str, limit: int = 40) -> str:
    """Filesystem-safe slug. Collapses every separator, so `../` cannot survive."""
    cleaned = re.sub(r"[^A-Za-z0-9]+", "-", text or "").strip("-").lower()
    return (cleaned[:limit].strip("-")) or "no-branch"


def rel(path: str, cwd: str) -> str:
    """Repo-relative where possible — absolute machine paths are noise to a reader."""
    p = (path or "").replace("\\", "/")
    for root in (cwd or "", str(REPO)):
        root = (root or "").replace("\\", "/").rstrip("/")
        if root and p.startswith(root + "/"):
            return p[len(root) + 1:]
    # Outside the repo (e.g. an agent memory file): keep it identifiable but drop
    # the machine-specific home prefix, same as command strings get.
    return HOME_RE.sub("~", p)


def add_usage(facts: dict, usage) -> None:
    """Accumulate one message's token usage into the running totals [FEAT-040].

    Cache creation and cache read are kept as their OWN totals rather than folded
    into `tokens_in`: the point of reporting them is the split (what was paid to
    build the cache vs. what the cache saved), and a single merged number leaves
    nothing split. A transcript predating usage reporting contributes zero rather
    than raising — every log written before this field existed still has to parse.
    """
    if not isinstance(usage, dict):
        return
    for key, field in (
        ("input_tokens", "tokens_in"),
        ("output_tokens", "tokens_out"),
        ("cache_creation_input_tokens", "cache_creation"),
        ("cache_read_input_tokens", "cache_read"),
    ):
        value = usage.get(key)
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            continue
        facts[field] += int(value)


def archive_input(inp: dict) -> dict:
    """A tool call's arguments, redacted and capped per field [FEAT-040].

    The CALL is the reusable part; a pasted payload inside it is noise, so each
    string field caps at ARCHIVE_FIELD_MAX with a visible marker. Non-string
    values are stringified rather than dropped — a reader needs to see that an
    argument was there at all.
    """
    out = {}
    for key, value in inp.items():
        text = redact(value if isinstance(value, str) else json.dumps(
            value, ensure_ascii=False, default=str))
        if len(text) > ARCHIVE_FIELD_MAX:
            text = text[:ARCHIVE_FIELD_MAX] + TRUNCATED
        out[str(key)] = text
    return out


def write_archive(target: Path, records: list) -> None:
    """Rewrite this session's distilled transcript, whole [FEAT-040].

    Whole-file, not append: SessionEnd fires more than once per session (a
    `/clear` then an exit), and appending would duplicate every thinking block
    while a second filename would split one session across two artifacts. Unlike
    the log there is no hand-written half to protect here, so regenerating is
    both the cheapest and the safest way to hold "one session, one archive".
    """
    target.parent.mkdir(parents=True, exist_ok=True)
    with open(target, "w", encoding="utf-8", newline="\n") as fh:
        for rec in records:
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")


def parse_transcript(path: Path, cwd: str) -> dict:
    """Extract the mechanical layer. Never raises: unreadable input is a finding."""
    facts = {
        "commands": [], "changed": [], "read": [], "prs": [], "tools": {},
        "prompts": 0, "bad_lines": 0, "branch": "", "first": "", "last": "",
        "problem": "",
        # [FEAT-040] p4 aggregates + p3 distillation. `archivable` is False until
        # a transcript has actually been read, so the caller can tell "nothing to
        # archive" from "archived nothing".
        "models": [], "tokens_in": 0, "tokens_out": 0,
        "cache_creation": 0, "cache_read": 0, "thinking_blocks": 0,
        "archive": [], "archivable": False,
    }
    chosen, note = resolve_transcript(path)
    if chosen is None:
        facts["problem"] = (
            f"transcript unreadable at `{path}`,同目录也没有可回退的 `*.jsonl` —— "
            "机械层为空,日期取自本机本地时钟。"
        )
        return facts
    try:
        raw = chosen.read_text(encoding="utf-8", errors="replace")
    except OSError as e:
        facts["problem"] = f"transcript unreadable at `{path}`: {e.__class__.__name__} — {e}"
        return facts
    facts["archivable"] = True
    if note:
        facts["problem"] = note

    for line in raw.splitlines():
        if not line.strip():
            continue
        try:
            d = json.loads(line)
        except (json.JSONDecodeError, ValueError):
            facts["bad_lines"] += 1
            continue
        if not isinstance(d, dict):
            facts["bad_lines"] += 1
            continue

        ts = d.get("timestamp") or ""
        if ts:
            facts["first"] = facts["first"] or ts
            facts["last"] = ts
        facts["branch"] = d.get("gitBranch") or facts["branch"]
        kind = d.get("type")

        if kind == "pr-link":
            # Real field is `prUrl` (+ prNumber/prRepository). The first version
            # read `content`, and the fixture had been written to match that guess,
            # so the suite was green while zero PRs were found on real input —
            # BUG-018's exact mechanism. `content`/`url` stay as fallbacks only.
            url = d.get("prUrl") or d.get("content") or d.get("url") or ""
            if isinstance(url, str) and url and url not in facts["prs"]:
                facts["prs"].append(url)
            continue

        # [FEAT-040] Everything below is either a user turn or an assistant turn.
        # Attachments and queue-operations fall out here and never reach the
        # archive — they are transport noise, not model interaction.
        if kind not in ("user", "assistant"):
            continue

        msg = d.get("message")
        if not isinstance(msg, dict):
            continue
        if kind == "user" and isinstance(msg.get("content"), str):
            facts["prompts"] += 1
            facts["archive"].append({
                "role": "user", "ts": ts,
                "text": redact(str(msg["content"])),
            })
        model = str(msg.get("model") or "") if kind == "assistant" else ""
        if model and model not in facts["models"]:
            facts["models"].append(model)
        add_usage(facts, msg.get("usage"))
        content = msg.get("content")
        if not isinstance(content, list):
            continue
        for blk in content:
            if not isinstance(blk, dict):
                continue
            btype = blk.get("type")
            # [FEAT-040] The archive's whole purpose. Verbatim: no truncation, no
            # one_line(). Redaction still applies — the archive is committed, and
            # AC-9 says that beats verbatim where the two collide.
            if btype == "thinking":
                facts["thinking_blocks"] += 1
                body = redact(str(blk.get("thinking") or ""))
                # [FEAT-040] MEASURED 2026-08-04 on this repo's own remote
                # transcripts: all 107 thinking blocks carried `thinking: ""`
                # with a populated `signature` — the reasoning is ENCRYPTED at
                # the source, so the transcript records THAT the model reasoned,
                # not WHAT it reasoned. A bare empty string reads as a writer
                # bug; `kind` says which of the two a reader is looking at, and
                # uses FEAT-039's vocabulary so the development side and the
                # product side describe reasoning availability the same way.
                kind = "full" if body.strip() else (
                    "encrypted" if blk.get("signature") else "none")
                facts["archive"].append({
                    "role": "assistant", "ts": ts, "model": model,
                    "kind": kind, "thinking": body,
                })
                continue
            if btype == "text":
                facts["archive"].append({
                    "role": "assistant", "ts": ts, "model": model,
                    "text": redact(str(blk.get("text") or "")),
                })
                continue
            if btype != "tool_use":
                # tool_result lands here and is dropped: bulky, and the likeliest
                # carrier of an environment value into a committed artifact.
                continue
            name = str(blk.get("name") or "?")
            inp = blk.get("input") if isinstance(blk.get("input"), dict) else {}
            facts["tools"][name] = facts["tools"].get(name, 0) + 1
            facts["archive"].append({
                "role": "assistant", "ts": ts, "model": model,
                "tool": name, "input": archive_input(inp),
            })
            if name in ("Bash", "Monitor"):
                cmd = one_line(redact(str(inp.get("command") or "").strip()))
                if cmd and cmd not in facts["commands"]:
                    facts["commands"].append(cmd)
            elif name in WRITE_TOOLS:
                f = rel(str(inp.get("file_path") or ""), cwd)
                if f and f not in facts["changed"]:
                    facts["changed"].append(f)
            elif name in READ_TOOLS:
                f = rel(str(inp.get("file_path") or ""), cwd)
                if f and f not in facts["read"]:
                    facts["read"].append(f)
    return facts


def build_log(payload: dict, facts: dict) -> tuple[str, str]:
    sid = str(payload.get("session_id") or "unknown-session")
    # [FEAT-040] Both degradations, in order of trustworthiness: the transcript's
    # own facts first, then the host's. A transcript that never recorded a branch
    # (the remote-container shape) still gets one; a session with no transcript at
    # all still gets a real date instead of `0000-00-00`.
    branch = facts.get("branch") or git_branch(str(payload.get("cwd") or ""))
    date = local_date(facts.get("last") or facts.get("first") or "") or host_today()
    name = f"{date}-{slug(branch)}-{sid[:8]}.md"

    def block(items, limit, empty="(无)"):
        if not items:
            return empty
        shown = [f"- `{i}`" for i in items[:limit]]
        if len(items) > limit:
            shown.append(f"- …另有 {len(items) - limit} 项(见 transcript)")
        return "\n".join(shown)

    tools = ", ".join(f"{k}×{v}" for k, v in sorted(
        facts["tools"].items(), key=lambda kv: -kv[1])) or "(无)"
    problem = facts.get("problem") or ""
    lines = [
        "---",
        f"session_id: {sid}",
        f"branch: {branch or '(unknown)'}",
        f"date: {date}",
        f"reason: {payload.get('reason') or '(unknown)'}",
        f"prompts: {facts['prompts']}",
        f"unparseable_transcript_lines: {facts['bad_lines']}",
        # [FEAT-040] What the session cost and which models ran it. Absent usage
        # reads 0 rather than omitting the field, so a reader can tell "nothing
        # spent" from "this writer predates the field".
        f"models: {', '.join(facts.get('models') or []) or '(unknown)'}",
        f"tokens_in: {facts.get('tokens_in', 0)}",
        f"tokens_out: {facts.get('tokens_out', 0)}",
        f"cache_creation_tokens: {facts.get('cache_creation', 0)}",
        f"cache_read_tokens: {facts.get('cache_read', 0)}",
        f"thinking_blocks: {facts.get('thinking_blocks', 0)}",
        "---",
        "",
        f"# Session log — {branch or '(unknown branch)'} — {date}",
        "",
        NOTE_TWO_LAYER,
        "> 本文件用途:让同事看到 agent 实际做了什么,并从中挑出值得纳入项目的点。",
        "",
    ]
    if problem:
        lines += ["## ⚠ 本次日志不完整", "", f"{problem}", "",
                  "机械层因此可能缺失或为空 —— 记录在此,而不是静默产出一份看起来正常的日志。", ""]
    lines += [
        "## 机械层(自动)", "",
        f"- **工具用量**:{tools}",
        f"- **开出/引用的 PR**:{', '.join(facts['prs']) if facts['prs'] else '(无)'}",
        f"- **时间跨度**:{facts['first'] or '?'} → {facts['last'] or '?'}",
        "",
        f"### 改动的文件({len(facts['changed'])})", "", block(facts["changed"], 40), "",
        f"### 仅读取的文件({len(facts['read'])})", "", block(facts["read"], 25), "",
        f"### 执行过的命令({len(facts['commands'])})", "",
        "```bash", *(facts["commands"][:40] or ["# (无)"]),
        *([f"# …另有 {len(facts['commands']) - 40} 条"] if len(facts["commands"]) > 40 else []),
        "```", "",
        "## 判断层(手写 —— hook 写不出这部分)", "",
        UNFILLED_MARKER, "",
        "- **试过又放弃的路径,以及为什么**:",
        "- **顺手发现但不在本次范围内的问题**:",
        "- **留下的尾巴 / 下一个人该知道的事**:",
        # [FEAT-040] Sub-agent transcripts are not archived (mechanising that is
        # an explicit non-goal), so this line is the whole mitigation: the main
        # session records what it dispatched and what came back.
        "- **派出的子代理及各自结论**:",
        "- **值得纳入项目的点**(规则候选、可复用命令、文档漏洞):",
        "",
    ]
    return f"{LOG_DIR}/{name}", "\n".join(lines)


def judgment_split(text: str) -> tuple[str, str] | None:
    """Cut a log into (mechanical head, judgment layer) at the `## 判断层` heading.

    The judgment layer runs from that heading to EOF — not to the next heading.
    Anything a human filed below it (an appendix, a second H2) is theirs and is
    kept; the rule is "nothing written below the line is ever lost", which is
    cheaper to trust than a rule about which subsections are in scope.
    """
    m = JUDGMENT_H2_RE.search(text)
    return None if m is None else (text[:m.start()], text[m.start():])


def judgment_is_filled(section: str) -> bool:
    """Did somebody actually write in this judgment layer?

    Answered on the SECTION, never on the whole file: `grep -rl UNFILLED
    ops/session-logs/` is a command this README recommends, so the string can
    legitimately appear in the mechanical half of a log whose judgment layer is
    complete. Judging the file would clobber exactly that log.
    """
    if UNFILLED_MARKER in section:
        return False
    body = section.split("\n", 1)[1] if "\n" in section else ""
    return any(
        line.strip()
        and not HTML_COMMENT_RE.match(line)
        and not EMPTY_PROMPT_RE.match(line)
        for line in body.splitlines()
    )


def merge_log(fresh: str, existing: str) -> str | None:
    """Fresh mechanical layer + the existing file's judgment layer, or None.

    None means "nothing in the existing file is worth keeping" — the caller just
    writes `fresh`. Returning the assembled text (rather than writing here) keeps
    the whole decision in one pure, self-tested function; RULE-002 wants hook
    logic testable, and this is the part that can silently destroy work.
    """
    split = judgment_split(existing)
    if split is None or not judgment_is_filled(split[1]):
        return None
    kept = split[1]
    fresh_split = judgment_split(fresh)
    head = (fresh_split[0] if fresh_split else fresh).replace(
        NOTE_TWO_LAYER, NOTE_PRESERVED, 1)
    # The preserved half decides the line endings: matching it is what makes
    # "byte for byte" true on a CRLF file written by a Windows session.
    if "\r\n" in kept:
        head = head.replace("\r\n", "\n").replace("\n", "\r\n")
    return head + kept


def resolve_target(log_dir: Path, name: str, sid8: str) -> Path:
    """The file this session already owns, else the canonical name.

    Keyed on the session id, because the canonical NAME can move between the
    pre-write and SessionEnd — the date is local and a long session crosses
    midnight, and task-intake switches branch mid-session on every task. Keyed on
    the name alone, that produces a second file and orphans the judgment layer in
    the first, breaking the README's one-session-one-file invariant.
    """
    exact = log_dir / name
    if exact.exists():
        return exact
    try:
        same = sorted(p for p in log_dir.glob(f"*-{sid8}.md") if p.is_file())
    except OSError:
        return exact
    return same[0] if len(same) == 1 else exact


def read_existing(target: Path) -> str | None:
    """Existing text, or None when there is nothing to merge with.

    `newline=""` so line endings survive the round trip untranslated. A file that
    is not UTF-8 raises rather than decoding lossily: those bytes might be
    somebody's judgment layer, and the caller's answer to "I cannot read this" is
    to leave it alone, not to overwrite it.
    """
    try:
        with open(target, encoding="utf-8", newline="") as fh:
            return fh.read()
    except FileNotFoundError:
        return None


def main() -> int:
    force_utf8_stdio()
    try:
        payload = json.load(sys.stdin)
        if not isinstance(payload, dict):
            raise ValueError(f"hook payload was {type(payload).__name__}, not an object")
    except (json.JSONDecodeError, ValueError, OSError) as e:
        payload = {"session_id": "unparsed-payload", "reason": "unknown"}
        facts = parse_transcript(Path("/nonexistent"), "")
        facts["problem"] = f"SessionEnd hook payload could not be parsed: {e}"
    else:
        cwd = str(payload.get("cwd") or "")
        facts = parse_transcript(Path(str(payload.get("transcript_path") or "")), cwd)

    relpath, text = build_log(payload, facts)
    log_dir = REPO / LOG_DIR
    sid8 = str(payload.get("session_id") or "unknown-session")[:8]
    target = resolve_target(log_dir, Path(relpath).name, sid8)
    try:
        existing = read_existing(target)
    except (OSError, UnicodeDecodeError) as e:
        # Unreadable is not the same as absent. Those bytes could be somebody's
        # judgment layer, and this is a logger — refusing to write costs one
        # mechanical layer, writing anyway could cost the half that mattered.
        print(f"session-log: 拒绝覆盖 {target.name}(读不出来:{e.__class__.__name__} — {e})")
        return 0

    merged = merge_log(text, existing) if existing else None
    try:
        log_dir.mkdir(parents=True, exist_ok=True)
        with open(target, "w", encoding="utf-8", newline="") as fh:
            fh.write(merged if merged is not None else text)
    except OSError as e:
        # Last resort: say it on stdout, since the artifact itself failed.
        print(f"session-log: could not write {relpath}: {e}")
        return 0
    shown = target.relative_to(REPO).as_posix()
    if merged is not None:
        print(f"session-log: 合并写入 {shown} — 机械层已刷新,判断层原样保留")
    else:
        print(f"session-log: wrote {shown} — 判断层待手写(见文件末尾)")

    # [FEAT-040] The distilled archive, keyed on the log's RESOLVED name so the
    # two artifacts of one session always share a stem — the log's name can move
    # between SessionEnds (local date crosses midnight, task-intake switches
    # branch) and only the resolved one is stable.
    # No transcript read => no archive: an empty shell would assert that a session
    # did nothing, when the truth is that nothing could be recorded.
    if facts.get("archivable"):
        archive = REPO / ARCHIVE_DIR / f"{target.stem}.jsonl"
        try:
            write_archive(archive, facts.get("archive") or [])
        except OSError as e:
            # Best-effort, exactly like the log's own last resort: the mechanical
            # log is already on disk and must not be undone by the archive.
            print(f"session-log: could not write {ARCHIVE_DIR}/{archive.name}: {e}")
        else:
            print(f"session-log: 蒸馏归档 {archive.relative_to(REPO).as_posix()} "
                  f"({len(facts.get('archive') or [])} 条)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
