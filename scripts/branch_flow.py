#!/usr/bin/env python3
"""
[FEAT-683] The develop flow's branch vocabulary, in one place.

WHAT THE FLOW IS

  feature / fix branch --PR--> develop --(deploys)--> the TEST environment
  develop --(daily 09:00 Beijing, after a machine smoke)--> release
  release --PR, approved by a person after testing--> main --(deploys)--> PRODUCTION
  hotfix/* --PR--> main, then main --PR--> develop (the back-merge)

WHY ONE MODULE

Four consumers need the same answers — `check_branch_policy.py` (which PRs may
enter `main`), `check_test_amendments.py` (which PRs are promotions judged
upstream), and in phase 2 the release train and backlog-close. Each carrying its
own copy of "what is the release branch called" and "is the flow switched on"
is how two of them end up disagreeing on the day someone renames one.

THE SWITCH

The flow is live exactly when the repository variable `TEST_DB_SOURCE_BRANCH`
names a branch other than `main` — the same variable FEAT-544 built to choose
which branch feeds the test database. In this flow "the branch that feeds the
test environment" and "the integration branch" are one thing, and a second
variable could only ever disagree with the first (design.md decision 3).
Unset, empty, blank or `main` all mean OFF, and every consumer then behaves
exactly as it did before FEAT-683.

GitHub's default branch stays `main` (design.md decision 1): the `prod`
environment admits only `main`, and `workflow_run` deploy jobs run on the
default branch's ref.
"""
from __future__ import annotations

PRODUCTION_BRANCH = "main"
# The one branch the daily release train moves; the head of every release PR.
RELEASE_BRANCH = "release"
HOTFIX_PREFIX = "hotfix/"
# What the switch is expected to name. Local tooling (the worktree alignment,
# the pre-push base) cannot read repository variables, so it keys on this name
# and on whether `origin/develop` exists; CI reads the switch itself.
INTEGRATION_BRANCH_NAME = "develop"

# The two promotion shapes: PRs whose every commit was already judged on the PR
# that brought it into their head branch.
PROMOTION_RELEASE = "release"  # release -> main
PROMOTION_BACK_MERGE = "back-merge"  # main -> the integration branch


def integration_branch(raw: str | None) -> str | None:
    """The integration branch the switch names, or None when the flow is off.

    `raw` is the value of `TEST_DB_SOURCE_BRANCH` as a workflow passes it: an
    unset variable arrives as the empty string.
    """
    value = (raw or "").strip()
    if not value or value == PRODUCTION_BRANCH:
        return None
    return value


def is_hotfix(head: str) -> bool:
    return head.startswith(HOTFIX_PREFIX) and len(head) > len(HOTFIX_PREFIX)


def promotion_shape(base: str, head: str, integration: str | None) -> str | None:
    """Which promotion (base, head) is, or None.

    Only meaningful while the flow is live: with the switch off there is no
    integration branch, so nothing is a promotion.
    """
    if integration is None:
        return None
    if base == PRODUCTION_BRANCH and head == RELEASE_BRANCH:
        return PROMOTION_RELEASE
    if base == integration and head == PRODUCTION_BRANCH:
        return PROMOTION_BACK_MERGE
    return None
