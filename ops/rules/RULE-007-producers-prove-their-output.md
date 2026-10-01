---
rule_id: RULE-007
scope: global
ladder: prose           # 目标 ci-check —— 见「强制 / 升级」
status: proposed        # T1/CTO 待批：全局规则 + 需动根 CLAUDE.md
born_from: [BUG-022, BUG-024, BUG-028, BUG-030, BUG-031, BUG-034, BUG-035]
created: 2026-08-03
last_triggered: null
---

# RULE-007: 自动化写产物必须自证写出了什么，而不只是自证没报错

## 规则

任何自动写仓库产物的自动化（hook / Action / 生成脚本）必须校验它**实际写出的内容**并让
"没跑"与"跑了但写空"可被区分；改写人类可编辑的文件必须先读后并（merge），绝不整篇覆盖。

## 缘由（born from）

- **BUG-022**（harness / validation-missing）：`write_session_log.py` 的文件名两个组成部分都取自
  **transcript** 且各有兜底值（`facts.get("branch") or ""`），于是 transcript 里没有 `gitBranch`
  时产出的是**空/畸形文件名的空日志**。脚本一次没报错。
- **BUG-024**（harness / validation-missing，`recurrence_of: BUG-022`）：同一脚本最后一步是
  `target.write_text(text)` —— **整篇覆盖**，把人类手写的「判断层」冲掉。而判断层恰恰是
  `reflect` 与 `drift-audit` 要挖的原料，也就是这条产线唯一不可再生的部分。
- **BUG-028**（harness / validation-missing，`recurrence_of: BUG-006`）：`backlog-close` Action
  在 `2026-07-30 11:19Z` 到 `2026-08-02 13:38Z` 之间**一次都没跑**（GitHub 跨全部 8 个 workflow
  零 run 记录），于是已合并的相位始终没被写 `done`，**没有任何人或任何检查发现**。
  根因原文第一句就是"**不是 `backlog_close.py` 的缺陷 —— 那个 Action 一次都没跑**"。

三个不同的面（文件名 / 文件内容 / 根本没执行），一个机制：
**生产者报告成功，而实际什么都没写、写错了、或压根没跑。**

### 2026-08-10 reflect 追加的四条（n 从 3 涨到 7，同一台机器）

同一个 `backlog-close` Action 又暴了四次，全部 `harness/validation-missing`，
链条 `BUG-028 → 030 → 031 → 034 → 035`：

- **BUG-030**：只判「合并了」不判「合并进了哪个分支」，给没进 `main` 的代码写 `done`。
  已触发 **5 次，5 次运行全部报 success**（`scripts/backlog_close.py` 里 `grep base` 无结果）。
- **BUG-031**：相号留空 = 无凭据强制全关，把没开工的相刷成 `done`。**造成真实损失并已回滚**；
  BUG-028 的 incident 第 108–111 行**逐字预言过它**。
- **BUG-034**：`PHASE_RE` 在复数 `phases 1-4` 上失配（区间相号解析不出任何号），
  且「治愈缺日期的行」只落了一半。
- **BUG-035**：BUG-034 给 Action 加的「推送前校验」方向对，但校验**整份签出文件**而非
  **本次改了什么**，于是成了一把**自锁** —— backlog 一坏，此后没有任何相能被关掉
  （`Flip → Validate(硬失败) → Commit 被 skip`）。

这四条把本规则的论据从"三个不同的面"变成"**同一个生产者，五次**"。
最锋利的是 BUG-035：**给生产者补的那道校验本身也是个生产者，也需要证明自己写出了什么** ——
它证明了本规则不是一次性检查清单，而是一条要持续适用的不变量。
注意 BUG-030 的形状与硬约束 6（`done` 只由 merge Action 写）互为因果：
正因为只有它能写，写错了就没人能改回来。

## 为什么现有规则盖不住

**RULE-002（guards fail closed）管的是消费侧** —— 守卫缺前置须报错、须自证跑过。
它把"检查"这一类纳了管，却没管"**产出**"这一类。三起事故里没有一个是守卫判错，
全都是一个 producer 悄悄地什么也没交付。RULE-002 那句"a guard must prove it ran"是对的方向，
本规则是它在生产侧的对偶。

## 强制 / 升级

当前阶梯：`prose`，但**三次修复已经各留下一块机器**，升级主要是把它们收成一条通则：

- BUG-022 → 文件名成分校验（不接受空 branch/date 兜底）。
- BUG-024 → 先读后并：保留 `## 判断层` 及其以下**逐字节**不变，只刷新上方机械段。
- BUG-028 → `scripts/check_backlog_reconciliation.py`：一条**对账扫描**，
  把"已合并但没被关"的相位数出来（它今天仍在响，见下）。
  > [FEAT-679 p4] 2026-09-23：这个脚本读的是 `ops/backlog/backlog.yaml`,backlog 搬上 GitHub
  > issues（FEAT-055 p2）之后它只会对冻结档案作答,已删除。同一形状的现行实现是
  > `scripts/check_backlog_issue_reconciliation.py` 与 `scripts/check_stranded_phases.py`
  > （task-intake 第 2 步两个都跑）。下文保留原文，作为本规则提出时的记录。

升级为 `ci-check` 的具体做法：给每个写仓库产物的自动化配一条对账断言（"我声称写了 N 条，
仓库里真有 N 条"），并把 `check_backlog_reconciliation.py` 与
`check_audit_freshness.py`（FEAT-026 p3 的同形先例）作为该形状的两个参考实现。
落地后从根 `CLAUDE.md` 删散文、替换为 "enforced by CI: `<check-name>`"。

## 现行证据（本规则一提出就在响）

2026-08-03 的 drift-audit 跑 `check_backlog_reconciliation.py`：35 个已合并相位中 **4 个**
仍是 `in_review`（FEAT-010 p2 / FEAT-012 p3 / FEAT-030 p3 / FEAT-033 p1，均 1 天前合入）
—— 经核实**不是 BUG-028 的复发，而是那次停机的残留**：四者的合并时间
（`2026-08-02 07:53–08:59Z`）都落在 BUG-028 记录的停机窗口内，`backlog-close` 从未被触发，
Actions 恢复后无人补关。**这对本规则是更强的论据，不是更弱的**：探测器把停机造成的欠账
如实报了出来（RULE-002 那半有效），但**没有任何机制去催那笔欠账被清掉** —— 一个 producer
在停机期间静默漏写，恢复后也不会自己补，正是本规则要求的"自证写出了什么"所指的空档。
按**硬约束 6**，任何 session 都不得代 Action 写 `done`，故该发现只被报告与开 issue，未被"修掉"。

## 归置与审批

全局规则 + 需在根 `CLAUDE.md` Global conventions 增一行 + 附带 CI 检查 → **CTO（T1）**。
提出于 2026-08-03 的 reflect 运行（无人值守 Routine），因此**只落了本提案文件，没有改根地图**
（硬约束 5：tier 压 autonomy）。与 RULE-006 同批批准则 root budget 为 12/15。
