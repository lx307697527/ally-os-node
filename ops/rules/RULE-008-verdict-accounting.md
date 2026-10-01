---
rule_id: RULE-008
scope: global
ladder: prose           # 目标 ci-check —— 见「强制 / 升级」，机器已有一半（FEAT-044 p5 的裁决图）
status: proposed        # T1/CTO 待批：全局规则 + 需动根 CLAUDE.md + 动 .github/**
born_from: [BUG-037, BUG-038]
created: 2026-08-10
last_triggered: null
---

# RULE-008: 汇总裁决的作业必须为**每一条预期裁决**结账，"未评估"要判红而不是消失

## 规则

任何把多条裁决汇总进一个 CI 作业的工作流，必须拿一份**预期裁决清单**对账本次运行
真正评估了哪些；任何 `skipped` / 未记账的裁决一律等同判红。
**汇总步骤不得在有裁决未被评估的情况下打印通过。**

## 缘由（born from）

- **BUG-037**（ci / spec-gap，`recurrence_of: BUG-035`，spec FEAT-042）：`guards` 作业停在它
  第一道前置（RULE-002 的自测循环），于是**后面 19 个裁决全部 `skipped`**（文档同步、模块映射、
  backlog 归属、RLS、跨 schema 写、迁移编号、规格三件套、测试改动审批、治理标签……），
  而作业最后那步 `Guard verdict` **照旧打印 `FAILED=0`**。
  **在 PR 页面上，这与「全部通过、零违规」不可区分。** 实测连续 **8/8** 次运行如此
  （2026-08-07 16:37 → 18:57，8 条互不相关的分支）。后果不是红叉，是**静默失效**。
- **BUG-038**（ci / config-error，`recurrence_of: BUG-036`，spec FEAT-044）：同一形状再来一次。
  自 FEAT-044 p5 起 `Install claude-dev-harness (pinned — RULE-001)` 一步因凭据缺失死在
  git clone，前置一红，**21 个裁决全部 skipped/unaccounted**。
  最后一次 guards 绿是 2026-08-07T21:32Z —— 那还是不含该步骤的版本。

两起，一个机制：**前置中止式失败会让整套裁决集合凭空消失，而摘要仍然读起来是干净的。**

## 为什么现有规则盖不住

**RULE-002（guards fail closed）管的是单个守卫** —— 缺前置须报错、不得 `exit 0`、判定逻辑须可自测。
这两起里**每一个守卫都规规矩矩地 fail-closed 了**：坏的是**作业层的记账**。
21 条 `skipped` 之和被汇总成了 `FAILED=0`。RULE-002 那句 "a guard must prove it ran" 是对单条裁决说的；
本规则要求的是**对整个集合**说同一句话：不只是"我跑过的都过了"，而是"该跑的都跑了，且都过了"。

FEAT-034 建了"前置中止、裁决累加"的设计，FEAT-044 p5 建了裁决图
（`ops/rules/harness-verdict-map.json`）与等价性自测
（scripts/tests/test_harness_verdict_equivalence.py）—— 但**没有任何东西断言
「本次运行真的评估了图里那 20 条」**。机器的两半都在，缺的是把它们接起来的那一句。

## 强制 / 升级（毕业答案：能上 ci-check，且大部分零件已存在）

`ops/rules/harness-verdict-map.json` 已经是机器可读的**预期裁决清单**。
把 `guards.yml` 最后那步从"数我收集到的失败"改成"拿这份图对账本次运行的裁决集合"：
任何图里有、本次没评估的行 → 判红并**点名**。
反向棘轮已经有了（等价性自测保证图不被悄悄删行），本规则补的是正向的那一半。
这条落地后 BUG-037 与 BUG-038 都会在**第一次**发生时判红，而不是 8 次之后由人发现。

> [FEAT-679] 2026-09-23：本提案要改的那个作业已不存在——`guards.yml` 的 `guards` 作业已按业主要求删除
> （自 2026-09-20 起它在 PR 上本就被 `CI_PR_OFF` 跳过），上文的等价性自测也一并删除，「反向棘轮已经有了」
> 一句因此不再成立。`ops/rules/harness-verdict-map.json` 保留，作为 FEAT-044 p5 迁移的历史记录。
> [FEAT-679 p4] 同日：该文件也已删除——它唯一的机器读者（等价性自测）随 p2 删了，同一张表的
> 可读版仍在 `ops/specs/FEAT-044-harness-package-extraction/phases/phase-5-design.md` 的
> 「裁决归属表」，要看历史的 JSON 从 git 历史取。
