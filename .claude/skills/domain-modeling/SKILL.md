---
name: domain-modeling
description: Build and sharpen this project's domain model while designing. Use when challenging codebase terminology, when a term needs to land in a module map, or when a decision needs an ADR or a ruling-register entry.
---

<!--
Source: mattpocock/skills — skills/engineering/domain-modeling/SKILL.md (MIT).
Vendored 2026-09-20. The DISCIPLINE below (challenge terms, sharpen language,
invent scenarios, cross-reference code, write it down as it crystallises) is
upstream's and is kept. The FILE TARGETS are rewritten for this repo: upstream
tells you to create a root `CONTEXT.md` and `docs/adr/0001-*.md`, and this repo
has neither — it keeps terminology in module maps and decisions in
`ops/architecture/ADR-xxx`, both under CI guards. Following upstream literally
would grow a second, unguarded glossary and a competing ADR series.
-->

# Domain Modeling

Actively build and sharpen the project's domain model as you design. This is the
*active* discipline: challenging terms, inventing edge-case scenarios, and
writing the glossary and decisions down the moment they crystallise. (Merely
*reading* a module map for vocabulary is not this skill: that's a one-line habit
any skill can do. This skill is for when you're changing the model, not just
consuming it.)

## Where things land in THIS repo

There is no root `CONTEXT.md` and no `docs/adr/`. Use these instead:

| What you settled | Where it goes |
|---|---|
| A term, an invariant, "what this module owns" | that module's `CLAUDE.md` map (`src/modules/<mod>/CLAUDE.md`, `apps/<app>/CLAUDE.md`, `supabase/CLAUDE.md`) — same PR as the code, the pre-push hook enforces this (no CI job since FEAT-679) |
| A cross-cutting term used by several modules | the root `CLAUDE.md` § Global conventions — **hard cap 15 rules**, so displace one or don't add it |
| An architecture decision with rejected alternatives | a new `ops/architecture/ADR-xxx-<slug>.md`, front-matter and section order copied from an existing ADR (e.g. `ADR-001`) |
| A BUSINESS rule someone with authority ruled on | the GitHub wiki 裁决登记, as an `R-<issue>` entry — recipe in `docs/zh-CN/rulings/README.md`. Check 裁决登记-90-待裁定 first; if it is listed there it is genuinely unruled, so do not invent one |
| A decision that is really a spec | `ops/specs/FEAT-xxx/` (`prd.md` + `design.md` + `testplan.md`, all three, CI-validated) |

Create lazily: only when you have something to write.

## During the session

### Challenge against the existing vocabulary

When the user uses a term that conflicts with the language already in the module
map, call it out immediately. "The crm map defines an inquiry as X, but you seem
to mean Y. Which is it?"

### Sharpen fuzzy language

When the user uses vague or overloaded terms, propose a precise canonical term.
"You're saying 'account': do you mean the Account record or the logged-in User?
Those are different things here."

### Discuss concrete scenarios

When domain relationships are being discussed, stress-test them with specific
scenarios. Invent scenarios that probe edge cases and force the user to be
precise about the boundaries between concepts.

### Cross-reference with code

When the user states how something works, check whether the code agrees — the
code graph and the module maps both answer this cheaply. If you find a
contradiction, surface it: "The cancel RPC cancels the whole order, but you just
said partial cancellation is possible. Which is right?"

### Write it down inline

When a term is resolved, put it in the right place from the table above right
there. Don't batch these up: capture them as they happen. A module map is a map,
not a spec — keep implementation detail out of it.

### Offer an ADR sparingly

Only offer to create an ADR when all three are true:

1. **Hard to reverse**: the cost of changing your mind later is meaningful
2. **Surprising without context**: a future reader will wonder "why did they do it this way?"
3. **The result of a real trade-off**: there were genuine alternatives and you picked one for specific reasons

If any of the three is missing, skip the ADR. An ADR here is a T1 artifact: it
needs an explicit impact record, but no approval is required to merge it.

### A business ruling is not yours to make

If the open question is "what should the business do" rather than "how should we
build it", you do not answer it and you do not record an answer. Open a GitHub
issue assigned to `allydasi` and leave the branch of the tree unsettled.
