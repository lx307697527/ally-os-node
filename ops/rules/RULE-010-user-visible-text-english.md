---
rule_id: RULE-010
scope: global
ladder: ci-check
status: active
born_from: [FEAT-183, "2026-09-02 盘点（issue #1505）：apps/allyos 24 行中文页面文案、db-health-cron 31 行中文 Slack 正文、四个 RPC 的中文 raise 消息，三处同根因——仓库没有展示语言规则", "FEAT-045 p1 告警正文与 FEAT-049 p2 raise 消息各自用中文写成，评审当时没有可引用的规则"]
created: 2026-09-02
last_triggered: 2026-09-02
---

# RULE-010: 用户可见文本一律英文；例外只有明确标注的中文名数据值与静态样机页

## 规则

**任何用户会看到的文本一律英文**——UI 文案、占位符、空态 / 错误提示、发给客户或团队的
邮件 / PDF / Slack 通知、迁移里 `raise` 的消息（它会原样透到前端错误条）。例外只有两类，且都要
在代码里看得出来：① `name_zh` 这类"中文名"数据字段的**值**可以是中文，字段**标签**仍是英文
（Chinese name）；② 用户明确裁定不动的静态样机页（`apps/landing/public/admin/index.html`，
2026-09-02 裁定）。本规则**只约束源码里写死的文案**：数据库中用户录入的数据（客户名、供应商中文名、
原料名、备注等）一律不碰，不得为此写任何 DML；改 RPC 消息只用 `create or replace function`。

不适用：代码注释、commit / PR / issue 正文（走既有双语约定）、会话日志、`docs/`、`ops/specs`、
`comment on function` 等目录文本。

## 缘由（born from）

- FEAT-183（issue #1505）：2026-09-02 以 `origin/main` 扫描非注释、非测试行，三类用户可见文本仍是中文——
  `apps/allyos` 24 行（空态、说明段、示例 JSON、RFQ 投递状态）、`supabase/functions/db-health-cron`
  的 Slack 告警正文 31 行、`pricing.publish_quote` / `production.record_actual_qty` / `billing.create_invoice` /
  `billing.confirm_order_settlement` 的 8 条 `raise exception`。团队有只读英文的成员，这些页面和告警对他们等于不可用。
- 同一根因出现在不同时间、不同层：FEAT-045 p1（2026-08）把告警正文写成中文，FEAT-049 p2（2026-08-19）把
  `raise` 消息写成中文，FEAT-054 / FEAT-056 的页面文案也是中文；每一次评审都没有可引用的规则，
  `20260828010000` 甚至在注释里写明"deliberately not translated"。规则缺席时，语言由作者习惯决定。

## 强制 / 升级

当前阶梯：`ci-check`（[FEAT-666] 起 CI 里还跑的是数据库层与下面那条 deno 测试；前端层见下）。

- 前端层：`src/harness/__tests__/user-visible-text-english.test.ts`（vitest，只随本地 `pnpm test` 跑——
  [FEAT-666] 起 CI 的 unit 作业与 pre-push 都不再跑 vitest）扫描
  `apps/allyos/src`、`apps/portal/{app,lib,components}`、`apps/landing/src` 的非测试源文件，去掉注释后
  出现 CJK 字符（U+3000–303F、3400–4DBF、4E00–9FFF、F900–FAFF、FF00–FFEF）即红；允许清单只有含
  `name_zh` 的行；扫描根缺失或扫不到文件时判红（fail closed）。
- 数据库层：`guards/check_migration_raise_english.py`（`pnpm lint` 链；`harness check --all` 也会发现它）
  按"最后一次 `create [or replace] function` 定义生效"读取 `supabase/migrations`，当前生效函数体里的
  `raise` 语句含 CJK 即红。历史迁移不改：用新迁移 `create or replace` 重述即可清零。
- 未机械覆盖、靠评审的部分：`supabase/functions/**` 的对外输出（邮件 / PDF / Slack）——deno 测试
  `db-health-cron/english_copy_test.ts` 只覆盖该函数；其它函数新增文案时评审按本规则看。

## 归置与审批

- 全局规则 → 根 `CLAUDE.md` Global conventions（第 12 条，上限 15）→ **CTO（T1）**。
