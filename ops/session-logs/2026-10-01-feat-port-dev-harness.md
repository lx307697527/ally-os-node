---
session_id: hand-written-port-session
branch: feat/port-dev-harness
date: 2026-10-01
reason: port-ally-os-dev-harness
prompts: 1
unparseable_transcript_lines: 0
models: (zcode)
tokens_in: 0
tokens_out: 0
cache_creation_tokens: 0
cache_read_tokens: 0
thinking_blocks: 0
---

# Session log — feat/port-dev-harness — 2026-10-01

> 机械层本次由 agent 手写(ZCode 会话,Claude Code 的 SessionEnd hook 未触发);
> 判断层为本次会话手写。

## 机械层(自动)

- **时间跨度**:2026-10-01 上午
- **开出/引用的 PR**:本文件随首个 harness PR 提交

### 改动的文件

- `.claude/`(skills 12 个、agents 5 个、hooks 5 个、settings.json、state、test-strategy.md)
- `scripts/`(claim_issue、write_session_log、check_session_logs、align_worktree_base、
  check_checkout_not_bare、check_worktree_hooks_path、install_git_hooks、guard_io、
  hermetic_git_env、branch_flow、postinstall.mjs、hooks/pre-push)
- `ops/rules/`(RULE-001/002/006/007/008/010)+ ops 目录骨架
- `harness.toml`、`.gitignore`、`package.json`(postinstall)、`AGENTS.md`、
  `eslint.config.js`(scripts/*.mjs 关 type-aware)、`.python-version`
- `docs/guides/dev-harness-port.md`(移植清单与概念映射)

## 判断层(手写 —— hook 写不出这部分)

**做了什么判断,为什么:**

1. **没有整仓照搬。** ally-os 的 pre-push 引用约 40 个 Supabase/RLS/pgTAP 专属 guard,
   照搬会让本仓库每次 push 都红。改为:pre-push 直接跑 `pnpm verify`(本仓库唯一的
   done-standard),其余 guard 不搬,清单记录在 dev-harness-port.md。
2. **fast_mode 从 true 改回 false。** 拷来的 harness-fast-mode.json 是 ally-os CTO 的
   临时加速(跳过测试先行)。迁移项目正需要测试先行和 verify 门禁,保留 true 等于
   把最值钱的纪律搬过来又第一件事关掉。
3. **backlog → GitHub issues 的词汇映射而不是改写 12 个 skill。** skill 里的流程语言
   (阶段、验收、done 由 merge 写入)与 issues 模型一一对应;在 AGENTS.md 和
   dev-harness-port.md 给出映射表,比逐个改写 1800 行 skill 便宜且不会漂移。
4. **session-start-reinject 的 invariants 做了最小改写**:spec-ID 迁移 → drizzle
   schema+db:generate;backlog done → PR "Closes #n"。这两条是每次会话强制注入的
   硬约束,必须与本仓库真实规则一致,否则注入的是错误规则。
5. **未搬**:commit 签名检查(本仓库未配置签名)、serena/codegraph 事实层(可选加速器,
   缺席时降级不阻塞)、guard 自测套件(pytest 基建未引入,先在文档里记为已知缺口)。

**值得纳入项目的点:**

- claim_issue.py 的 git-ref 租约是防「两个 agent 抢同一 issue」的正确原语,定时任务
  提示词里必须先 claim 再开工。
- 「判断层/机械层」两层 session log 值得坚持:机械层 git log 可恢复,判断层才是挖矿处。
- postinstall 的「装完必须回读验证」模式(installer exit 0 不算证据)适用于以后所有
  bootstrap 脚本。

**坑:**

- write_session_log.py 不认 `--help`,空 stdin 会直接写日志 —— 冒烟测试时误产出一份
  unparsed 存根(已删)。给该脚本加 argparse 是个小改进,留给后续 issue。
- eslint projectService 默认不认根目录 scripts/*.mjs,需 allowDefaultProject + 关
  type-aware(与 eslint.config.js 同待遇)。
