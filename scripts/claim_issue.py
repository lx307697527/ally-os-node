#!/usr/bin/env python3
"""Atomically claim an ISSUE before working it — [FEAT-483 p2], born from #2995.

WHY THIS EXISTS

This repository already has one mutex that works. `scripts/claim_spec_id.py`
takes a spec id by creating a GitHub milestone titled with the bare id: the
server accepts the first writer and refuses the rest with 422. Its docstring
states the principle this file inherits:

    A file in git is not an atomic allocator. A remote object is: the server
    accepts the first writer and refuses the rest.

That mutex is sound. It also guards the wrong object.

MEASURED, issue #2995 on 2026-09-13/14: two sessions both picked up the same
issue. Session A claimed it with a COMMENT at 19:09. Session B read the comment,
judged the lock stale after 12 hours, and re-claimed at 07:11. Both then went to
the spec-id allocator — and both succeeded, because they asked for DIFFERENT
numbers (FEAT-467 and FEAT-459). The mutex fired perfectly and prevented
nothing: two full implementations of the same issue were written, and the
collision surfaced only when the second session merged main before `git push`
(PR #3144's own body records the wreckage).

Two structural defects produced that:

  1. THE CLAIM WAS A COMMENT. Read-then-write with a window in between: two
     sessions can both read "unclaimed" and both write "claimed". A comment is
     a memo, not a lock.
  2. THE RECLAIM WAS A JUDGEMENT CALL. A session read a 12-hour rule out of
     prose and hand-checked three conditions. The judgement was right, but it
     sits inside an automated loop, and it races with itself: two reclaimers
     can both conclude "expired".

So: claim the ISSUE, atomically, BEFORE taking a number — the lock belongs at
the contention point, not downstream of it — and make the expiry mechanical.

THE MECHANISM, AND WHY THIS SHAPE (all four measured 2026-09-15, this container)

A lease is a git ref whose commit message carries the lease. Creating and
advancing that ref is the compare-and-swap:

    push refs/heads/*          create + fast-forward     OK
    push refs/claims/*                                   403
    ref delete (git AND REST)                            403
    REST git/trees|commits|refs write                    403 (agent proxy)

Hence `refs/heads/claims/issue-<N>`, driven by `git push` rather than the REST
git-data API, and a RELEASE THAT IS A TOMBSTONE COMMIT rather than a deletion —
the namespace cannot be pruned from here, and a release must not depend on a
capability the caller may not have. The tombstone is better anyway: it leaves
who-held-and-released in the history instead of erasing it.

THE COMPARE-AND-SWAP IS `git push` WITHOUT `--force`, and this is the whole
safety argument. A writer builds its new lease commit with the sha it READ as
the parent. If anyone advanced the ref in between, the push is no longer a
fast-forward and the server rejects it. Measured directly: two "reclaimers"
both parented on the same sha, first push accepted, second rejected as
non-fast-forward. Exactly one winner, no coordination, no clock agreement.

FAIL CLOSED (RULE-002). Every uncertainty resolves to "someone may hold this":
a remote that cannot be read, a lease whose `expires_at` will not parse, a
commit whose message cannot be fetched — all exit 2, never "looks free to me".
The one thing this must never do is hand two sessions the same issue because it
could not see.

    exit 0   the lease is yours (claimed, renewed, or released)
    exit 1   someone else holds it, or you lost the race — actionable, quiet
    exit 2   could not judge (unreadable remote, unparseable lease, no identity)

Run:
    python3 scripts/claim_issue.py claim  --issue 3220 --ttl-minutes 90
    python3 scripts/claim_issue.py renew  --issue 3220
    python3 scripts/claim_issue.py release --issue 3220
    python3 scripts/claim_issue.py status --issue 3220
    python3 scripts/claim_issue.py --selftest
"""

import argparse
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from guard_io import GuardIoError, force_utf8_stdio, run_text  # noqa: E402

# The empty tree, which every git repository has by construction — a lease
# carries no files, only a message, so there is nothing to write into a tree.
EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

CLAIM_REF = "refs/heads/claims/issue-{issue}"
DEFAULT_TTL_MINUTES = 90

HELD = "held"
RELEASED = "released"

# `key: value`, one per line. Deliberately not JSON: this message is read by
# humans in `git log` at least as often as by this script, and a lease nobody
# can read at a glance is a lease nobody will trust.
FIELD_RE = re.compile(r"^(?P<key>[a-z_]+):[ \t]*(?P<value>.*?)[ \t]*$", re.M)


class RemoteError(RuntimeError):
    """The remote could not be read or written. Never means 'it is free'."""


class GitRemote:
    """The real transport. Isolated behind three calls so the contract suite
    can drive every branch without a network (RULE-006)."""

    def __init__(self, repo: Path, remote: str = "origin"):
        self.repo = repo
        self.remote = remote

    def _git(self, *args, check=True, **kwargs):
        # run_text, never bare subprocess [BUG-020 / BUG-027, the encode-decode
        # ratchet in scripts/tests/test_guard_io.py]: a lease carries session
        # URLs and holder names that are not guaranteed ASCII, and a strict
        # decode that dies in Windows' reader thread comes back as returncode 0
        # with stdout None — a lock that reads "nobody holds this" because the
        # text could not be decoded is the exact failure this file exists to
        # prevent. run_text also turns a missing `git` into GuardIoError rather
        # than a traceback.
        try:
            p = run_text(["git", "-C", str(self.repo), *args], **kwargs)
        except GuardIoError as exc:
            raise RemoteError(str(exc)) from exc
        if check and p.returncode != 0:
            raise RemoteError(f"git {' '.join(args[:3])}… failed: "
                              f"{(p.stderr or p.stdout or '').strip()[:300]}")
        return p

    def read_ref(self, ref: str):
        """The sha the ref points at, or None if it does not exist."""
        p = self._git("ls-remote", self.remote, ref)
        line = p.stdout.strip()
        if not line:
            return None
        return line.split()[0]

    def read_message(self, sha: str) -> str:
        """The commit message at `sha`, fetching it if this clone lacks it."""
        p = self._git("cat-file", "-p", sha, check=False)
        if p.returncode != 0:
            # A lease written by another session is not in this clone yet.
            self._git("fetch", "--quiet", self.remote, sha, check=False)
            p = self._git("cat-file", "-p", sha, check=False)
            if p.returncode != 0:
                raise RemoteError(
                    f"lease commit {sha[:10]} could not be read even after "
                    f"fetching it. Refusing to treat an unreadable lease as an "
                    f"absent one (RULE-002).")
        body = p.stdout.split("\n\n", 1)
        return body[1] if len(body) > 1 else ""

    def commit(self, message: str, parent: str | None) -> str:
        args = ["commit-tree", EMPTY_TREE]
        if parent:
            args += ["-p", parent]
        p = self._git(*args, check=False, input=message)
        if p.returncode != 0:
            raise RemoteError(f"could not build the lease commit: "
                              f"{(p.stderr or '').strip()[:200]}")
        return (p.stdout or "").strip()

    def push(self, sha: str, ref: str) -> bool:
        """Advance `ref` to `sha`. False = the server refused (someone else won).

        NO `--force`, and that is the compare-and-swap: the caller parented
        `sha` on the sha it read, so a refusal means the ref moved underneath
        it. `--no-verify` because the pre-push hook runs this repository's whole
        guard chain (~5 minutes) and a lease write is not a code push.
        """
        p = self._git("push", "--no-verify", self.remote,
                      f"{sha}:{ref}", check=False)
        if p.returncode == 0:
            return True
        blob = (p.stderr or "") + (p.stdout or "")
        if "non-fast-forward" in blob or "fetch first" in blob or "rejected" in blob:
            return False
        raise RemoteError(f"pushing the lease failed for a reason that is not a "
                          f"lost race, so whether anyone holds this issue is "
                          f"unknown: {blob.strip()[:300]}")


def parse_lease(message: str) -> dict:
    return {m.group("key"): m.group("value")
            for m in FIELD_RE.finditer(message or "")}


def render_lease(issue: int, state: str, holder: str, session: str,
                 acquired_at: str, expires_at: str, now: str) -> str:
    subject = (f"claim(issue-{issue}): {state} by {holder}"
               if state == HELD else f"claim(issue-{issue}): released by {holder}")
    return (
        f"{subject}\n"
        f"\n"
        f"state: {state}\n"
        f"holder: {holder}\n"
        f"issue: {issue}\n"
        f"acquired_at: {acquired_at}\n"
        f"expires_at: {expires_at}\n"
        f"heartbeat_at: {now}\n"
        f"session: {session}\n"
        f"\n"
        f"[FEAT-483 p2] The lease is this ref. Advancing it is the lock: a\n"
        f"writer parents its commit on the sha it read, so a non-fast-forward\n"
        f"rejection means someone else won the race.\n"
    )


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(value: str):
    """A timestamp, or None when it will not parse.

    None is NOT 'expired'. Callers must treat it as held — an unreadable expiry
    is the fail-closed case, and reading it as free is how two sessions get the
    same issue.
    """
    try:
        return datetime.strptime(value.strip(), "%Y-%m-%dT%H:%M:%SZ").replace(
            tzinfo=timezone.utc)
    except (ValueError, AttributeError):
        return None


def lease_is_claimable(lease: dict, now: datetime):
    """(claimable, why). Anything unclear answers False."""
    if not lease:
        return False, ("the lease commit carries no readable fields, so who "
                       "holds it is unknown")
    if lease.get("state") == RELEASED:
        return True, f"released by {lease.get('holder', '?')}"
    expires = parse_iso(lease.get("expires_at", ""))
    if expires is None:
        return False, (f"expires_at {lease.get('expires_at', '(absent)')!r} does "
                       f"not parse; refusing to read an unreadable expiry as an "
                       f"expired one")
    if now >= expires:
        return True, (f"the lease held by {lease.get('holder', '?')} expired at "
                      f"{lease.get('expires_at')}")
    return False, (f"held by {lease.get('holder', '?')} until "
                   f"{lease.get('expires_at')} (session: "
                   f"{lease.get('session', 'n/a')})")


def identity(explicit: str | None) -> str:
    """Who is claiming. Absent identity is exit 2, never an anonymous lease."""
    for candidate in (explicit,
                      os.environ.get("CLAIM_HOLDER"),
                      os.environ.get("GITHUB_ACTOR")):
        if candidate and candidate.strip():
            return candidate.strip()
    # run_text here too: a configured identity is free text and routinely
    # non-ASCII, and it ends up written into the lease that later readers parse.
    try:
        p = run_text(["git", "config", "--get", "user.email"])
        who = (p.stdout or "").strip()
    except GuardIoError:
        who = ""
    if who:
        return who
    raise RemoteError(
        "no holder identity: pass --holder, or set CLAIM_HOLDER / GITHUB_ACTOR, "
        "or configure git user.email. An anonymous lease cannot be renewed or "
        "audited, so it is refused rather than written.")


def run(argv, remote_factory=None, now=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("command",
                    choices=["claim", "renew", "release", "status"])
    ap.add_argument("--issue", type=int, required=True)
    ap.add_argument("--ttl-minutes", type=int, default=DEFAULT_TTL_MINUTES)
    ap.add_argument("--holder", default=None)
    ap.add_argument("--session",
                    default=os.environ.get("CLAUDE_SESSION_URL", "n/a"))
    ap.add_argument("--repo", default=".")
    args = ap.parse_args(argv)

    now = now or utcnow()
    ref = CLAIM_REF.format(issue=args.issue)
    remote = (remote_factory or (lambda: GitRemote(Path(args.repo))))()

    try:
        head = remote.read_ref(ref)
        lease = parse_lease(remote.read_message(head)) if head else {}
    except RemoteError as exc:
        print(f"::error::cannot judge issue #{args.issue}: {exc}")
        return 2

    if args.command == "status":
        if not head:
            print(f"issue #{args.issue}: unclaimed")
            return 0
        claimable, why = lease_is_claimable(lease, now)
        print(f"issue #{args.issue}: {'claimable' if claimable else 'HELD'} — {why}")
        return 0

    # A ref that exists but whose commit carries no lease fields is CORRUPT, not
    # merely occupied. Both outcomes stop this session taking the issue, so it
    # would be easy to fold this into exit 1 — but that is the wrong report: a
    # garbled lease makes the issue permanently unclaimable, and exit 1 is the
    # quiet "someone is on it, pick another" that a dispatcher skips past
    # without anyone ever looking. Exit 2 is the one that gets read.
    if head and not lease:
        print(f"::error::issue #{args.issue} carries a lease commit "
              f"({head[:10]}) with no readable fields. That is a corrupt lease, "
              f"not a held one: nothing can renew or expire it, so the issue "
              f"would stay unclaimable forever. Inspect "
              f"`git show {head[:10]}` and advance "
              f"{ref} to a released lease to clear it.")
        return 2

    try:
        me = identity(args.holder)
    except RemoteError as exc:
        print(f"::error::{exc}")
        return 2

    if args.command == "release":
        if not head:
            print(f"issue #{args.issue} was never claimed — nothing to release")
            return 0
        if lease.get("state") == RELEASED:
            print(f"issue #{args.issue} is already released (idempotent)")
            return 0
        message = render_lease(
            args.issue, RELEASED, me, args.session,
            lease.get("acquired_at", iso(now)), iso(now), iso(now))
    elif args.command == "renew":
        if not head:
            print(f"::error::issue #{args.issue} holds no lease to renew — "
                  f"claim it first")
            return 1
        if lease.get("holder") != me:
            print(f"::error::issue #{args.issue} is held by "
                  f"{lease.get('holder', '?')}, not by {me} — a lease is renewed "
                  f"only by its holder")
            return 1
        message = render_lease(
            args.issue, HELD, me, args.session,
            lease.get("acquired_at", iso(now)),
            iso(now + timedelta(minutes=args.ttl_minutes)), iso(now))
    else:  # claim
        if head:
            claimable, why = lease_is_claimable(lease, now)
            if not claimable:
                print(f"issue #{args.issue} is already claimed — {why}")
                return 1
            print(f"issue #{args.issue}: taking over — {why}")
        message = render_lease(
            args.issue, HELD, me, args.session, iso(now),
            iso(now + timedelta(minutes=args.ttl_minutes)), iso(now))

    try:
        new = remote.commit(message, head)
        won = remote.push(new, ref)
    except RemoteError as exc:
        print(f"::error::cannot judge issue #{args.issue}: {exc}")
        return 2

    if not won:
        # The ref moved between the read and the push. This is the race being
        # lost, which is a normal outcome and not an error: another session
        # holds the issue and this one should pick a different one.
        print(f"issue #{args.issue}: lost the race — another session advanced "
              f"the lease after this one read it. Not retrying: re-reading and "
              f"pushing again is how a lock becomes a suggestion.")
        return 1

    print(f"issue #{args.issue}: {args.command} OK as {me} "
          f"({ref} -> {new[:10]})")
    return 0


# ---------------------------------------------------------------------------


class _FakeRemote:
    """A remote in memory. Used by --selftest and the contract suite."""

    def __init__(self, head=None, messages=None, push_wins=True):
        self.head, self.messages = head, dict(messages or {})
        self.push_wins, self.pushed, self.n = push_wins, [], 0

    def read_ref(self, ref):
        return self.head

    def read_message(self, sha):
        return self.messages.get(sha, "")

    def commit(self, message, parent):
        self.n += 1
        sha = f"{self.n:040x}"
        self.messages[sha] = message
        return sha

    def push(self, sha, ref):
        self.pushed.append((sha, ref))
        if not self.push_wins:
            return False
        self.head = sha
        return True


def selftest():
    now = datetime(2026, 9, 15, 12, 0, 0, tzinfo=timezone.utc)
    held = render_lease(1, HELD, "alice", "s", iso(now),
                        iso(now + timedelta(minutes=30)), iso(now))
    expired = render_lease(1, HELD, "alice", "s", iso(now),
                           iso(now - timedelta(minutes=1)), iso(now))

    # Round-trips, and stays human-readable in `git log`.
    assert parse_lease(held)["holder"] == "alice"
    assert parse_lease(held)["state"] == HELD

    # A live lease blocks; an expired or released one does not.
    assert lease_is_claimable(parse_lease(held), now)[0] is False
    assert lease_is_claimable(parse_lease(expired), now)[0] is True
    rel = render_lease(1, RELEASED, "alice", "s", iso(now), iso(now), iso(now))
    assert lease_is_claimable(parse_lease(rel), now)[0] is True

    # FAIL CLOSED: unreadable is never free.
    assert lease_is_claimable({}, now)[0] is False
    assert lease_is_claimable({"state": HELD, "expires_at": "soon"}, now)[0] is False
    assert lease_is_claimable({"state": HELD}, now)[0] is False
    assert parse_iso("not a date") is None

    def go(cmd, remote, extra=()):
        return run([cmd, "--issue", "1", "--holder", "bob", *extra],
                   remote_factory=lambda: remote, now=now)

    assert go("claim", _FakeRemote()) == 0                      # free
    assert go("claim", _FakeRemote("a", {"a": held})) == 1       # held by alice
    assert go("claim", _FakeRemote("a", {"a": expired})) == 0    # expired
    assert go("claim", _FakeRemote("a", {"a": ""})) == 2         # unreadable

    # Losing the CAS is exit 1, and must not be retried into a success.
    lost = _FakeRemote("a", {"a": expired}, push_wins=False)
    assert go("claim", lost) == 1 and len(lost.pushed) == 1

    # Renewal belongs to the holder alone.
    assert go("renew", _FakeRemote("a", {"a": held})) == 1        # bob != alice
    mine = render_lease(1, HELD, "bob", "s", iso(now),
                        iso(now + timedelta(minutes=5)), iso(now))
    assert go("renew", _FakeRemote("a", {"a": mine})) == 0
    assert go("renew", _FakeRemote()) == 1                       # nothing to renew

    # Release is idempotent and never needs a delete.
    assert go("release", _FakeRemote()) == 0
    assert go("release", _FakeRemote("a", {"a": rel})) == 0
    assert go("release", _FakeRemote("a", {"a": mine})) == 0

    print("selftest OK: lease round-trip, expiry, fail-closed unknowns, "
          "CAS loss, holder-only renewal, idempotent release")
    return 0


def main(argv=None):
    # FIRST thing, before any print: both this file's output and a lease's own
    # fields can be non-ASCII, and an unpinned stdout raises UnicodeEncodeError
    # as soon as it is a pipe on a non-UTF-8 codepage (BUG-020). It sits here
    # rather than in run() because --selftest never reaches run() — which is
    # exactly the hole the encode ratchet caught.
    force_utf8_stdio()
    argv = list(sys.argv[1:] if argv is None else argv)
    if "--selftest" in argv:
        return selftest()
    return run(argv)


if __name__ == "__main__":
    sys.exit(main())
