# 测试运行策略 —— 本地只跑相关的，pgTAP 与 lint 的全量交给 CI

> 来源：FEAT-056 p15a 实现会（2026-08-22）。痛点实录：每次改动后跑全量
> （全部 pgTAP 文件 + 全仓 vitest + 跨项目 typecheck）慢且浪费——本地与
> CI 是同一套测试，CI 每 PR 必跑全量，本地重复全量只为"心理保险"。
> **[FEAT-666] 2026-09-23 起 vitest 不在此列**：CI 的 `unit` 作业只跑 `pnpm run lint`，
> pre-push 也不再跑单测——单测只剩你本地跑的那些，没有任何地方替你跑全量。

## 原则：三层过滤，pgTAP 与 lint 的全量留给 CI

| 层 | 命令 | 时机 |
|---|---|---|
| **改动文件单测** | `node node_modules/vitest/vitest.mjs run <glob>`（worktree 内） | 每次编辑后（秒级） |
| **相关 pgTAP** | `supabase test db --db-url postgresql://postgres:postgres@127.0.0.1:54432/postgres <file>` | 改了 SQL/迁移时（秒级） |
| **相关 lint** | `npx eslint <files>` + `tsc --project tsconfig.json --noEmit` | 每次编辑后 |

**全量（`supabase test db` 无参数 / `pnpm lint`）只在两类时机跑**（`vitest run` 无参数的
全量已没有自动时机，见上）：
1. PR 开起来后 CI 自动全量（`db-contracts` 跑 pgTAP——PR 改了迁移或 DB 测试时；`unit`
   跑 `pnpm run lint`）；
2. 提交前跑一个 `harness check --all --changed $(git diff --name-only origin/main...HEAD)`
   （diff-scoped，秒级）当最后一层网——它含 doc-sync / spec 完整性 / cross-schema DML
   等**本地唯一能查**的 verdict；CI 自 [FEAT-679] 起不再查它们（doc-sync 与
   cross-schema DML 还有 `pre-push` 兜底，spec 完整性只剩这一道）。

## Test file layout: a unit test lives in `__tests__/`

A unit test belongs in a `__tests__/` directory **beside the code it covers**, not
next to it:

```
src/modules/security/rpc.ts
src/modules/security/__tests__/rpc.test.ts      # yes
src/modules/security/rpc.test.ts                # no -- the guard below rejects this
```

Checked by `scripts/check_colocated_tests.py` (FEAT-271 p6). It ran in the `guards`
job, which [FEAT-679] deleted; since p4 `scripts/hooks/pre-push` runs it.
`scripts/move_tests_into_tests_dir.py --apply <dir>` moves an offender and rewrites
its relative specifiers.

**Why `__tests__/` and not a mirrored `tests/` tree.** The tests stay inside each
app's `src/`, so every `tsconfig` include, ESLint config, Vite root and build path
keeps working untouched. A parallel `tests/` tree would need all of them changed and
kept in step forever. Measured on this repo, nothing else needed changing either: the
manifest globs already cross directories, and both coverage excludes match on basename.

**The exemption, and why it is not a loophole.** A directory named `tests` is exempt
as well as `__tests__`, because `apps/portal/tests/e2e/*.spec.ts` and `supabase/tests/`
are already dedicated test directories -- those files are not co-located with any
source, and nesting a `__tests__/` inside them would mean nothing. The rule is "no test
sitting next to the source it covers", not "every test under `__tests__/`". Dropping
the `tests` half turns 8 innocent Playwright specs red; that case is pinned by
`test_e2e_specs_are_not_colocated`.

**Writing a new test:** put it straight into `__tests__/`. Vitest (when you run it --
nothing runs it automatically since [FEAT-666]) and the amendment guard treat both
layouts alike, so nothing except this guard will tell you that you drifted.

## 单测怎么选范围

`vitest` 的 include 来自 `ops/rules/test-manifest.json`（BUG-013 单一真相）。本地跑相关文件：

```bash
# 改了一个模块的 rpc.ts → 跑同目录测试（含你新增的独立测试文件）
node node_modules/vitest/vitest.mjs run src/modules/security/

# 改了 apps/allyos 一个页面 → 跑该 app 的测试
node node_modules/vitest/vitest.mjs run apps/allyos/src/sales/pages/  # 按需换区/具体文件

# 精确到文件（推荐：最快、噪音最小）
node node_modules/vitest/vitest.mjs run src/modules/security/__tests__/rpc-portal-identity.test.ts
```

⚠️ **worktree 里 node_modules 常缺失**——建 worktree 后先跑一次
`pnpm install --frozen-lockfile`（2–3s，链接主 checkout 的 store），否则 vitest
报 `Cannot find module` 的假红。**不要**用主 checkout 的 vitest 跑 worktree 测试
（`--root` 会乱、绝对路径过滤不掉 include 的相对 glob）——在 worktree 内跑才对。

## pgTAP 怎么选范围

`supabase test db` 接受文件路径参数；DB 语义（RLS/outbox/事件）权威在 pgTAP：

```bash
# 单文件（最快）
supabase test db --db-url postgresql://postgres:postgres@127.0.0.1:54432/postgres \
  supabase/tests/security_portal_identity_test.sql

# 相关一组
supabase test db --db-url postgresql://postgres:postgres@127.0.0.1:54432/postgres \
  supabase/tests/security_*.sql
```

⚠️ **前置条件：本地 DB 基线必须等于 origin/main 的最新迁移**。`supabase test db`
不自动应用新迁移——本地栈是若干小时前启动的容器快照，pull/rebase 到新 main 后
里面的函数/表是旧的，单文件跑会撞上"环境噪音红"（实例如 FEAT-048 p5 迁移缺失
导致 feat048_p3 测试红——不是你的改动）。**规则：rebase/pull 后先
`supabase db reset --db-url <url>`（~8s 全量重放），再跑任何 pgTAP。**

## 执行了多少会被对账 [BUG-504 / AUD-supa-tests-real-005 / #4348]

CI 的两条 pgTAP 腿把 `supabase test db` 的输出 tee 进捕获并交给
`scripts/check_pgtap_tap_floor.py`：执行文件数与断言数须过
`ls supabase/tests/*.sql | wc -l` 派生的下限，`Bad plan`/`Bail out!`/
`Result: FAIL` 等零执行签名一律判红（BUG-378 的 13 条零执行断言压 584 绿
文件就是这么漏过去的）。本地跑也顺手能对账：
`supabase test db … 2>&1 | tee /tmp/pgtap.tap` 后对该文件跑同一脚本。

## pgTAP 是 CI-only，不进 `pre-push`——原因写在这里 [AUD-supa-tests-real-007 / #4350]

`scripts/hooks/pre-push` 跑几十个静态守卫（含两条只读文本的 pgTAP 相关检查：
`pgTAP dblink target`、`idempotency evidence`），但**从不调用 `supabase test db`**，
即不实际执行任何一条 pgTAP 断言。这不是遗漏，是刻意的分工：

- 执行 pgTAP 需要一个跑着的本地 Supabase/Postgres 栈（`supabase start`，背后是
  Docker）。这台机器**有没有**这个栈在跑，`pre-push` 无法假设——而 CI 的
  `db-contracts` 作业每次都从零起一个，所以它是唯一保证"跑过"的地方。
- `db-contracts` 与 `sql-lint` **不受** `CI_PAUSED` / `CI_UNIT_OFF` /
  `CI_PR_OFF`（[FEAT-679] 起已无读者）任何一个开关影响（FEAT-267/#1751 的裁定：
  「schema deferral is not survivable」）——所以"pgTAP 只在 CI 跑"不等于
  "pgTAP 可能不跑"，它就是每个改了 DB 路径的 PR（`db-contracts`）和每次 push 到 main
  （`db-contracts-main`）都会跑的那一条。
- 全量 pgTAP 今天有 **`ls supabase/tests/*.sql | wc -l` 条**（这条命令本身就是
  当前值——写死一个数字进本文档正是本节要修的那次腐烂：2026-08-22 记录时是 185，
  到 2026-09-22 已经是 643，没有任何 PR 因为这个数字变了而红过）。把它塞进
  `pre-push` 当门禁，会让这个本该是"改完立刻可跑"的钩子变成本身最慢的一段。

**改动 `.claude/test-strategy.md` 里这句表述时**，别把某次实测的数字重新写成固定
值——`scripts/check_pgtap_count_freshness.py`（`pnpm lint` 与 `pre-push` 都跑）
会为此判红，用意就是不让这条已经腐烂过一次的说法悄悄再烂一次。

## typecheck / lint 怎么选范围

- `tsc --project tsconfig.json --noEmit`：根项目秒级，每次都跑（抓跨模块漂移）。
- 跨项目全覆盖 `python3 scripts/check_typecheck_coverage.py`（~15s）：至少每次
  提交前跑一次。
- eslint 只跑改动文件即可（`npx eslint <files>`）。

## 什么时候必须全量（别省）

1. **迁移 / core-table DDL**：pgTAP 全量必跑——你动的是全仓共用的 DB 契约，
   单文件绿不代表其他人（新 schema 暴露、config.toml、RLS）没被你弄红。
2. **提 PR 前**：`harness check --all --changed` 必跑（本地唯一入口）。

**单测全量不在此列**：改公共工具 / 共享 rpc 包装时，共享模块的回归只有 vitest 全量才现形，而
[FEAT-666] 起 CI 与 pre-push 都不跑它、业主裁定也不强制——想确认，只能本地 `pnpm test -- --run`。

## 常见噪音（不是你的错，识别即可）

| 现象 | 原因 | 处置 |
|---|---|---|
| 全量 pgTAP 里某文件红但你没碰它 | 本地 DB 陈旧（缺新迁移） | `supabase db reset` 后重跑 |
| vitest 报 Cannot find module 'react' 等 | worktree 缺 node_modules | `pnpm install` 一次 |
| test-amendment 报改了你没碰的测试文件 | base SHA 竞态（并发 PR 合并后 base 前移） | rebase 到最新 main 再 push |