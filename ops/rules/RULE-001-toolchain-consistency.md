---
rule_id: RULE-001
scope: global
ladder: ci-check
status: active
born_from: [BUG-001, BUG-002, d3fbfc7 (unfiled — backfill chored), BUG-015]
created: 2026-07-23
last_triggered: 2026-07-26
---

# RULE-001: 换工具链时，一切"自动发现"假设必须显式化并在同一变更内验证

## 规则

更换包管理器/运行时/CI runner 等工具链时，所有依赖**自动发现或隐式布局**的
消费方（lockfile 缓存、插件发现、bin hoisting、版本解析）必须在同一变更集内
显式化配置，并有一次 CI 级启动验证；工具版本一律以 `package.json`
`packageManager` 为单一事实源。

并且：CI 里交给 `setup-*` action 的**运行时工具链版本**不得完全浮动 ——
`<lang>-version:` 或 setup/install action 的 `version:` 不得取 `latest` / `*` /
`main` / `master` / 任意 `.x` 通配（如 `v2.x`、`1.2.x`）。给出具体大版本
（`node-version: 20`）或小版本（`python-version: '3.12'`）即可;精确到 patch 更
好但交由 reviewer 判断，以免 LTS 大版本钉法徒增噪声。理由:第三方工具链在浮动
区间内升级时，应表现为一次**显式、可复现**的变更,而非静默把未改动的合法代码
判红(BUG-015 的 deno 半正是 `deno-version: v2.x` 区间内 TS lib 漂移所致)。

## 缘由（born from）

同根因三连发 —— npm→pnpm 迁移（FEAT-002 p5）逐个击穿隐式环境假设，每次都
由事后审计而非门禁发现：

- **BUG-001**：workflows 仍用 `npm ci`/`cache: npm`，lockfile 缺失 → 测试
  gate 在所有 PR 上从未真正跑过，红态照常合并。
- **BUG-002**（`recurrence_of: BUG-001`）：Stryker 依赖 npm 扁平 hoisting 自动
  发现 vitest-runner 插件，pnpm 隔离布局下从未启动；夜跑连续 4 秒即崩、无人
  认领。
- **d3fbfc7（未建案，reflect 已列 chore 回填）**：`vite-node` 靠 npm hoisting
  出现在根 `.bin`，pnpm 下不可解析 → SECURITY DEFINER 审计测试空输出失败；
  提交正文自认"Same root-cause family as BUG-001"。

另有活体旁证：本机 pnpm 11 与仓库钉定 8.15.4 不兼容导致 `pnpm lint` 无效
（2026-07-23 审计"健康项"节）——版本漂移仍在发生。

- **BUG-015（reflect 2026-07-24 纳入；deno 半）**：pnpm 轴已钉，但交给 `setup-*`
  的运行时版本没钉。`test.yml` 用了最松的 `deno-version: v2.x`,deno 2.x 区间内
  捆绑的 TS lib 把 `Uint8Array` 改成泛型后,原先合法且**未改动**的 `importKey`
  代码静默 `TS2769` 判红;`supabase/setup-cli` 同样坐在 `version: latest` 上。
  与前述同族(工具链版本浮动 → 静默击穿),只是换了运行时。

## 强制 / 升级

当前阶梯：`ci-check`（部分机器化；语义部分保留 prose）。

- 已有机器件：`scripts/check_workflow_lockfile.py`（BUG-001 修复时诞生）——
  workflow 所用包管理器必须与仓库 lockfile 一致。
  > [FEAT-679 p4] 2026-09-23：它原先在 `guards.yml` 的 `guards` 作业里跑，那个作业 p2 已删；
  > 现在由 `scripts/hooks/pre-push` 按改动集（`--changed`）在本地跑，没有 CI 作业再跑它。
- 前次 PR 机器件（reflect 2026-07-23）：同脚本扩展 —— 改动的 workflow 若给
  `<pm>/action-setup` 显式钉版本，必须与 `packageManager` 钉版前缀一致（推荐
  不钉、让 action 读 `packageManager`）。已本地验证：现状绿 / `version: 9`
  报错 / `version: 8.15` 兼容通过。
- 本 PR 机器件（reflect 2026-07-24，BUG-015）：`check_floating_toolchain_versions`
  —— 改动的 workflow 中任何 `<lang>-version:` 或 setup/install action 的
  `version:` 取完全浮动值（`latest`/`*`/`main`/`master`/`.x` 通配）即报错;
  具体大/小版本放行。兼容 block 与 inline `with: { ... }` 两种写法。本地自证:
  `test.yml` 命中两处(`version: latest` @ supabase-cli、`deno-version: v2.x`),
  `mutation.yml`(`node-version: 20`)/`doc-sync-check.yml`(`python-version: 3.12`)
  绿。
- ~~**存量债**：`test.yml` 的 `deno-version: v2.x` 与 `supabase/setup-cli
  version: latest` 两处浮动~~ → **已清偿(FEAT-026 p1)**,钉为 `v2.9.3` /
  `2.109.1`。清偿时机不是原计划的「下一个触及 functions/db 的 PR」:FEAT-026 因
  AC-1 必须改 `test.yml`,diff-scoped 的 `check_workflow_lockfile` 随即把这两处
  判为阻塞,不钉就是红 PR。**验证依据要如实记录**:两个版本取自本仓库实际开发
  所用的本地工具链(`deno 2.9.3`、`supabase 2.109.1`),不是猜的;但
  `edge-functions`/`db-contracts` 受 path-filter 门控,而 FEAT-026 不触
  `supabase/**`,所以**这两个钉版在该 PR 的 CI 上未被真正执行** —— 首次真执行落在
  下一个触及 `supabase/functions|migrations` 的 PR。若那次红,按本规则处理:显式
  改版本,而非退回浮动。
- **生效证据（reflect-2026-07-26，`last_triggered` 据此更新）**：上一条债务的清偿
  不是自愿的 —— FEAT-026 相 1 因 AC-1 必须改 `test.yml`，diff-scoped 的
  `check_workflow_lockfile` **当场把那两处浮动版本判为阻塞**，不钉版就是红 PR。
  规则确实拦下过一次，并按其自身设计的方式（显式改版本而非退回浮动）结案。
- 无法机器化的残余（保留 prose）："迁移 PR 必须包含各消费工具的一次启动
  验证" —— 依赖 reviewer 检查；若未来出现第四次同族事故，升级为
  迁移-PR 检查单模板。
- 本 PR 机器件（FEAT-030 phase 3；非新增事故，是 phase 1 自己记录并搁置的债务
  的偿还——`fact_layer_ready_hook.py` 当时明写"pinning a dependency is not this
  phase's scope"）：`scripts/check_codegraph_version_pin.py`，挂在 `pnpm lint`
  链上（每次 CI 的 always-on `unit` job 都跑，同 `test:coverage` 那条"CI-level
  startup verification that it resolves under pnpm's isolated node_modules"注释
  的先例）。两件事都查：① `package.json` 的 `@colbymchenry/codegraph` 必须是精确
  版本（拒绝 `^`/`~`/`*`/`latest`/`workspace:`/git-url 等任何浮动形式）；
  ② 实际跑一次 `pnpm exec codegraph --version`，核对输出与 pin 一致——这才是
  "CI 启动校验"，不是只查文本里有没有插入符。同一变更把 `.mcp.json` 的 codegraph
  server 命令从裸 `npx`（不保证解析到 lockfile 钉定的版本）换成 `pnpm exec`
  （严格走 pnpm 自己的依赖解析）。本地已自证：当前仓库 `1.4.1` 精确 pin + 实际
  `pnpm exec codegraph --version` 输出一致 → 绿；反向 fixture 覆盖浮动 pin /
  依赖缺失 / pin 与实际版本不一致三种红态。

## 归置与审批

- 全局规则 + 触及 CI 脚本 → **CTO（T1）**。根 CLAUDE.md 一行由 reflect
  报告 PR 统一落placement。
