---
session_id: hand-written-233-rule-registry
branch: feat/233-rule-registry
date: 2026-10-06
reason: issue-233
prompts: 1
unparseable_transcript_lines: 0
models: (zcode)
tokens_in: 0
tokens_out: 0
cache_creation_tokens: 0
cache_read_tokens: 0
thinking_blocks: 0
---

# Session log — feat/233-rule-registry — 2026-10-06

> 机械层本次由 agent 手写(ZCode 定时迁移会话);判断层为本次会话手写。

## 机械层(自动)

- **引用的 issue**:#233(规则注册表:参数、开关、门槛,含业务门槛例外开关默认
  关)——**切片 1:规则注册表内核 + 首批规则种子**,PR 正文写 Part of #233
  (决策表/门槛种子/cron 接线/周报未完,严禁 Closes 关键字)。
- **前置收尾(第 0 步)**:无 open PR、无残留 worktree、主检出干净。选题:记忆
  与 #221/#222/#225 剩余项共同指向 #233(注册表是 #220~#226 之外最后一个没动
  的配置工作室内核,也是多个内核注释里点名的消费前置)。

### 本切片改动的文件

- `packages/db/src/schema.ts`:`registry_rules` 表(键唯一索引、三类 category、
  六种 valueType、changeableBy/enableBy、adjudicationRefs、riskFlag/riskNote、
  三个运行计数、scheduled* 四列、version 列)+ `config_revision_source` 枚举加
  `scheduled`
- `packages/db/migrations/0021_flashy_chronomancer.sql`(新):drizzle 生成的
  DDL + **手写种子**(57 条首批规则,临时 node 脚本生成 SQL 后粘贴;每条规则
  `INSERT…SELECT jsonb_build_object(…)` 补 source='created' 的 v1 台账行,
  WHERE NOT EXISTS 幂等)
- `apps/api/src/config-versions/registry.ts`:`ConfigSubjectSpec` 加
  `authorizeWrite` 逐主体写面钩子(新增 `SubjectWriteDenial` 类型)
- `apps/api/src/config-versions/http.ts`:共享 `authorizeSubjectWrite`
- `apps/api/src/routes/config-versions.ts` / `routes/config-drafts.ts`:回滚、
  存草稿、发布三个写面接入逐主体钩子(读面不加)
- `apps/api/src/rules/service.ts`(新):内核——`getRule`/`isRuleEnabled`(消费方
  带 zod,fail closed)、`changeRuleValue`(立即/定时,依据必填,谁能改含 owner
  直通与 enableBy 门)、`applyDueRuleChanges`(FOR UPDATE 认领到点变更,台账记
  source='scheduled',审计在事务外以调度者为 actor)、`recordRuleOutcome`、
  `requestGateException`(质量门槛无条件拒绝)
- `apps/api/src/config-versions/families.ts`:第六族 `registry_rule`(快照
  schema/落列 applyRevision 清 scheduled*/authorizeWrite 按 changeableBy)
- `apps/api/src/authz/permissions.ts`:`rules.configure` 权限点(owner/admin)
- `apps/api/src/routes/rules.ts`(新) + `routes/registry.ts` 三行 + `app.ts`
  接线
- 测试:`apps/api/src/routes/rules.test.ts`(18 例,独立 scratch DB);修正三处
  因新权限点硬编码断言的既有测试(authz.test.ts、app.test.ts)与 subjects 列表
  断言(config-versions.test.ts 五族→六族)
- 文档:`docs/rules.md`(新)

## 判断层(手写)

### 关键判断

1. **「谁能改」不走权限点,走行上角色数组**。#233 的谁能改按裁决逐规则不同
   (管理员/销售主管/老板),而权限点矩阵是静态的。裁法:族权限点
   `rules.configure` 只管配置工作室面(读史/回滚/台账),改值面在路由内按行的
   `changeableBy` 裁(owner 恒可,同 R-16-5 owner 直通);回滚/草稿/发布写面通过
   给 `ConfigSubjectSpec` 加 `authorizeWrite` 钩子把同一裁决强制到第二扇门——
   不靠调用方自觉,与「关注者集合 ⊆ 可见者集合在关注与投递两端各查一次」同一
   裁法。代价是出现唯一一个「族权限点 ≠ 改权」的族,销售主管能改自己治理的
   规则但回滚要 owner/admin(admin 回滚销售主管治理的规则也会被逐主体门挡下,
   测试钉住)。
2. **定时变更不在调度时刻记台账,在激活时刻记**。台账语义是「生效了什么」,
   调度意图由审计(`rules.change_scheduled`)+ 行上 scheduled* 字段承载;激活时
   刻记 source='scheduled' 的新版(actor = 调度者)。由此推论:回滚落列时清空
   scheduled*(快照是「当时的现状」,待生效变更不在其中)——不存在「回滚了还
   定时改回去」的暗门,测试钉住。
3. **种子进迁移(0019 补账先例),不做 seed 机制**。#233 要求首批规则以默认值
   上线;种子含 57 条规则 + 57 条 v1 台账行。用一次性 node 脚本生成 SQL 再粘贴
   进迁移,避免手写 57 行 jsonb 的笔误;测试套件依赖种子 v1 快照(回滚测试),
   因此 rules.test.ts **不做 beforeEach 清库**(与其它套件不同),隔离靠「每个
   测试动自己那条规则」+ 按 rule id/key 限定断言。
4. **硬底线的测试形式**:§4.5 说硬底线不进注册表,可测的是「不存在且改不了」
   ——断言一批哨兵键(hardline.*)GET 不在列表、PATCH 404。质量门槛不可越过则
   在内核层测(`requestGateException kind:"quality"` 对 owner 也抛)。
5. **业务门槛例外做成内核函数而非路由**:当前没有任何门槛消费者(流程门槛
   enforcement seam 空),开 HTTP 面是猜测消费者形状;`requestGateException(db,
   {kind, gate, reason, roles})` 让消费域在自己的门槛判定处调用,越过与否的
   放行语义归消费域。开关默认关、仅 owner、必填原因、审计 + override 计数都在
   内核钉死。

### 踩的坑

- **jsonb 种子字面量**:`20::jsonb` 不是合法转换(numeric 无法 cast 到 jsonb),
  统一用 `'20'::jsonb`(text→jsonb 解析 JSON)。
- **prefer-optional-chain 与窄化的冲突**:`x === null || x.getTime()` 会被
  eslint 判红,但把链拆成局部变量后 TS 又因别名链不窄化报 possibly-undefined;
  最终形态 `const dueAt = rule?.scheduledEffectiveAt ?? null; if (dueAt === null
  || dueAt.getTime() …)` ——`?? null` 先收敛 undefined,再 `=== null` 窄化。
- **审计不能在事务闭包里走外连**:applyDueRuleChanges 最初把 recordAudit(db,…)
  写在事务回调里(外连与未提交事务并发,回滚会留下孤儿审计);改成事务返回
  结果、提交后写审计(与 custom-fields PATCH 同纪律)。
- **既有测试的权限点硬编码**:加 `rules.configure` 后 authz.test.ts 与
  app.test.ts 的 admin 默认集断言红——这是「新增权限点必须同步两处断言」的
  机械活,不是语义冲突。
- **test 里的 `app.request` 返回类型**:Hono 的 request 在测试环境推断出
  `Response | Promise<Response>`,helper 显式 async/await 收窄。

### 流程备忘

- 第 0 步:无 open PR/无残留;`claims/issue-233` 租约正常。
- 本机 postgres(ally-os-node-postgres-1)健康,scratch DB 全绿;verify 全绿
  (85 文件 669 测试,DATABASE_URL 显式传入)。
- 剩余项(写给下次):决策表值类型(GoRules,随 #221/#223 消费域)、gate 类别
  种子(随 #220 条件积木消费者)、applyDueRuleChanges 的 worker cron 接线、
  待填规则待办提醒(#261)、周报(#225)、治理字段编辑 + #206 受监管变更、前端
  UI。
