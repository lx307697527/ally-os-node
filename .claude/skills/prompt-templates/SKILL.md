---
name: prompt-templates
description: Copy-paste prompt templates for AI-driven development in this repo — feature requests, schema/migration generation, convention-correction, and rule-authoring. Use when someone asks "how do I phrase this for Claude", "give me a prompt for X", "怎么写提示词", or wants a starting template before kicking off feature-dev / a migration. This skill only HANDS BACK a template to fill in; it does not execute the work — route the filled-in prompt through task-intake → feature-dev / bug-fix as usual. Full rationale: docs/zh-CN/PROMPTING.md.
---

# Prompt Templates(提示词模板库)

在本仓库,**好提示词是「薄」的**:规范已固化在 `CLAUDE.md` + `.claude/skills` +
`ops/specs` 三层,prompt 只写「意图 + 锚点 + 可判定验收 + 边界」,重活交给 skill。
完整心法见 `docs/zh-CN/PROMPTING.md`。

**用法**:挑下面对应场景的模板 → 填空 → 作为正式请求发出(仍走
`task-intake → feature-dev / bug-fix`)。本 skill 只给模板,不代替工作流执行。

---

## 通用骨架

```
【目标】 一句话,动词开头
【锚点】 相关模块 / spec / 表:src/modules/<m>/CLAUDE.md、FEAT-xxx、<schema>.<table>
【流程】 走 task-intake → feature-dev;自主级别 L1 | L2 | L3
【约束】 遵守 CLAUDE.md 与对应 skill,不赘述;额外只强调:<本次特有边界>
【验收】 <可判定的 done:哪些 AC / 哪条命令通过 / 哪个测试变绿>
```

---

## `feature` — 新功能 / 变更

```
给 <模块> 加 <能力>。
锚点:src/modules/<模块>/CLAUDE.md、<相关表/spec>。
走 feature-dev,L2。
验收:<可判定条件,如「AE 只能看到自己 account 下的行,复用现有 RLS,不新开写路径」>。
不要:<边界,如「不要直接写表 / 不要动 core 表」>。
```

---

## `schema` — 数据库 schema / 迁移生成

```
为 <feature> 新增 <schema>.<table> 及其治理写路径。
先分级:判断是否触及 ops/rules/core-tables.txt。触及 → 标 T1、design.md 贴 code-graph
        blast-radius 并说明 SQL 侧影响;未触及 → T2/T3。T1 不需要审批标签。
产物顺序:
  1. ops/specs/FEAT-xxx/design.md 的 "Schema Changes" 段:表结构/字段/FK/索引/RLS 策略/
     新增哪个 RPC/发什么 event。
  2. supabase/migrations/ 迁移:头注释带 FEAT-xxx;create table(snake_case,可变表带
     created_at/updated_at);enable row level security + staff-read 策略;写 RPC
     (SECURITY DEFINER、pin search_path、revoke anon/public、grant authenticated、内部
     调 core.emit_event 带 dedup_key)。
  3. 更新 supabase/TABLE-INDEX.md(全量表索引,FEAT-065 p1 起独立成文件;
     新 schema 才需顺带更新 supabase/CLAUDE.md 的概览段)。
参照:照最接近的既有迁移风格(如 pricing.create_quote / set_quote_lines)。
自检:迁移头有 spec ID?每表开 RLS?无 client INSERT/UPDATE grant?RPC 发了 event?
      碰 core 表是否已标 T1?supabase/TABLE-INDEX.md 索引已更新?
```

---

## `correct` — 纠偏(把产物拉回规范)

引用**具体规范出处**,别泛泛说「要规范」:

```
这里 <具体偏离,如「直接对 crm.inquiries 做 update」>。按 CLAUDE.md 的 <规则名,如
Governed Action> 规则,<应有做法,如「写必须走 SECURITY DEFINER RPC + core.emit_event」>。
请改成 <具体动作>。
```

---

## `rule` — 沉淀 / 演进团队规范

```
把「<隐性约定>」提炼成一条显式团队规则。
证据:<它被哪个 CI 隐式强制 + ≥2 次同源事故,满足 reflect 门槛>。
产物:走 reflect skill 的规则提案流程,在 ops/rules/ 落规则 + PR;必要时同步
      <某模块 CLAUDE.md / supabase/CLAUDE.md>。
约束:根 CLAUDE.md Global conventions 有 HARD CAP 15 条 —— 逼近上限就提合并/淘汰,别硬加。
```

---

## `bug` — 缺陷修复

```
<现象:输入 X → 期望 Y,实际 Z>。
锚点:<可疑模块/文件/表>。
走 bug-fix skill(不是 feature-dev)。
验收:先加一个能复现的失败测试(红),修复后转绿;记 ops/incidents/BUG-xxx.md。
```

---

## 远程环境(手机 / web)提醒

远程沙箱跑不了本地验证层(pgTAP / e2e / deno),它们也不在 CI 里 → 迁移/RLS/RPC 类改动
在手机上只能到「设计 + 撰写」,验证留到带 Docker 的本地环境。前端/TS 逻辑/文档/spec 类
改动则很适合远程环境。详见 `docs/zh-CN/PROMPTING.md` §5。
