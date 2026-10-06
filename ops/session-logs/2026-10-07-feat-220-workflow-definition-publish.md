---
session_id: hand-written-220-workflow-definition-publish
branch: feat/220-workflow-definition-publish
date: 2026-10-07
reason: issue-220
prompts: 1
unparseable_transcript_lines: 0
models: (zcode)
tokens_in: 0
tokens_out: 0
cache_creation_tokens: 0
cache_read_tokens: 0
thinking_blocks: 0
---

# Session log — feat/220-workflow-definition-publish — 2026-10-07

> 机械层本次由 agent 手写(ZCode 定时迁移会话);判断层为本次会话手写。

## 机械层(自动)

- **引用的 issue**:#220 正文要点「流程配置有版本,走配置版本、审计与发布」+
  #232 §4.9「状态机 JSON 按 #226 的版本走」。#220 切片 1(#268)落了流程内核,
  但模板行「创建即冻结」(无改写端点),台账对 workflow_template 只有创建 v1、
  回滚/草稿答 409。本切片 = **定义改写面 + 配置发布**:PATCH 就地改写、
  draftContentSchema + applyRevision 注册(草稿/发布/回滚三端点对
  workflow_template 自动生效)、回滚撞结构不变式的 409。PR 正文写 Part of
  #220(第一张真实模板/subject 仍等 #227/#231/#243,超时送达等属主域)。
- **前置收尾(第 0 步)**:无 open PR;#116(#281)四项收尾事务各自独立核验
  全齐(合并态 / 远程分支已删 / issue 成果评论在 / 租约已释放),无残留
  worktree,主检出干净。
- **选题**:规则①(评论里有未完成切片的 issue 优先)。记忆推进计划里 #226
  slice 3 被 #206 阻塞后,config-studio 剩余项第一个可做项就是本切片;
  #220 的验收 1/3 分别等业务对象与通知投递,唯有定义改写是纯配置工作室工作。
  claim 原子租约一次拿到。
- **数据库**:本地 postgres(docker)可用,全部测试带 DATABASE_URL 跑(无 skip)。

### 本切片改动的文件

- `apps/api/src/config-versions/families.ts`:`workflowTemplateDraftContentSchema`
  (strict 四键 = 快照形状,superRefine 里跑与 POST/PATCH 同一道四门:zod 结构 →
  拓扑 → XState 可达 → 积木存在性)+ `workflowTemplateSnapshotSchema`(回滚落列
  的结构收口)+ spec 挂上 draftContentSchema/applyRevision;族注释同步
- `apps/api/src/routes/workflow-templates.ts`:PATCH `/api/workflow-templates/:id`
  (strict patchBody:productType/isDefault/active/definition;definitionSave
  helper 供 POST/PATCH 共用;实效变更同事务 nextConfigVersion + UPDATE +
  recordConfigRevision(source `updated`,changes 顶层 from/to,definition 用
  jsonEqual 判真变更)+ 审计 `workflow.template_updated`;无实效变更幂等返回;
  23505 → 409 default_template_exists);文件 docblock 重写(不可变裁决退役)
- `apps/api/src/routes/config-versions.ts`:回滚路由加 23505 → 409
  `rollback_conflict`(isUniqueViolation 沿 cause 链,第 4 份同款 helper)
- `apps/api/src/routes/registry.ts`:PATCH 路由授权声明一行(permission 面,
  403 集成测试随新测试块覆盖)
- `packages/db/src/schema.ts`:仅注释同步(「定义就地改写端点随 #226 后续切片」
  的预告已兑现);`db:generate` 确认零迁移(No schema changes)
- `apps/api/src/routes/workflow-templates.test.ts`:TRUNCATE 清单加台账+草稿表;
  模块级夹具 registerWorkflowSubject("lead");新增 6 个集成测试:PATCH 记账/
  幂等/校验失败不落账、plain 用户 403(PATCH+草稿)、默认两步切换、
  草稿→发布+在飞实例快照、过期/no-op/丢弃语义、回滚+rollback_no_change+
  rollback_conflict
- `apps/api/src/routes/config-drafts.test.ts` / `config-versions.test.ts`:
  「workflow 未支持」断言翻转——409 断言改挂 approval_config(仍是 409 族),
  workflow 侧改正面断言(回滚 200 v3)
- `docs/workflow.md`(新增「定义改写与配置发布」一节 + 表格行/剩余项更新)、
  `docs/config-versions.md`(能力清单四族 + 回滚语义补 rollback_conflict)、
  `docs/audit.md`(词表加 workflow.template_updated)

### 验证

- `DATABASE_URL=… corepack pnpm verify` 全绿:lint ✓、typecheck ✓、
  **92 个测试文件 / 743 测试全过**(此前 92/737;workflow-templates.test.ts
  4 → 10)
- 迁移纪律:无新 migration(schema.ts 仅注释);无新 env、无新依赖

## 判断层(手写)

1. **切片边界 = 「模板行从创建即冻结变成可版本化改写」,不碰属主域**。#220 的
   三条验收里,「为四个对象配流程」等 #227/#231/#243 的业务对象、「超时提醒
   负责人」等属主域给负责人 + 通知投递——都阻塞;唯一不阻塞的验收残项是
   正文要点「流程配置有版本,走配置版本、审计与发布」。它恰好也是 #268 切片 1
   刻意留的口子(families.ts 注释原文:「定义改写端点进场时同步补
   applyRevision 与草稿契约」)——本切片就是来兑现那句预告的,零新机制:
   草稿/发布/回滚三个通用端点对 workflow_template 是注册即生效。
2. **键与内容的边界是本切片最重要的产品裁决**。templateKey/subjectType 不进
   patchBody(strict 400)——键是身份,消费方按字面量引用,改键 = 换一个模板,
   同 custom_field_defs.fieldKey / registry_rules 键的既有裁法。于是快照形状
   (productType/isDefault/active/definition 四键)恰好就是全部可改内容,
   PATCH、草稿、快照、回滚四方共用同一形状,没有「部分可改」的特例。
3. **默认模板切换拒绝「静默降级」,坚持两步**。第一直觉是 PATCH isDefault=true
   时同事务把旧默认摘掉(一步到位,体验好);但降级是**另一行的内容变更**,
   不走那行的台账就把「行内容 = 台账最新版快照」的不变式弄断——旧行账上说
   isDefault=true、行上却是 false,回滚/差异面从此说谎。所以 409
   default_template_exists(与 POST 同答案),两步切换、各记各的账。这个「体验
   让位于账本完整性」的取舍值得留在判断层。
4. **回滚撞结构不变式是 workflow 家族特有的新失败形态,内核路由补了一个通用
   映射**。历史版快照带 isDefault=true、而默认位已被别的模板接管时,applyRevision
   的 UPDATE 撞部分唯一索引 → 23505。发布面早有 publish_conflict 409 兜这个,
   回滚面没有——不加映射就是 500。补 409 rollback_conflict(整个事务已回滚,
   提示先摘位再回滚);它是通用路由的通用语义,不特判 workflow。
5. **在飞实例快照语义是这次敢开「就地改写」的安全前提,必须有测试钉住**。
   切片 1 冻结定义的真正原因是「改模板不能改写在飞流程」;实例启动时已快照
   definition,这个不变式在内核里本来就有——切片 1 的冻结是把数据不变式当
   API 裁决用。测试专门钉:发布 v2 后,v1 上启动的实例推不了 WAIT 事件
   (event_not_allowed)、CONTACT 照常;新启动的实例才吃 v2。冻结退役、快照
   承责,语义写进 docs/workflow.md。
6. **草稿保存面跑全量四门校验(含积木存在性),是「发布后能直接生效」的必要
   条件**。gate 积木缺失在运行时是 fail-closed 的 gate_unavailable,如果草稿
   面只查 JSONB 形状,一份引用幽灵积木的定义能一路发布到产线才炸。这与
   custom-field 草稿带 select 选项规则、automation 草稿复用 ruleSpecSchema
   是同一条纪律的 workflow 版。
7. **坑(本次新踩/复核)**:
   - zod v4 的 `.superRefine()` 返回 this 类型(检查内联进 schema),所以
     `workflowTemplateDraftContentSchema` 能直接赋给 `draftContentSchema?:
     z.ZodType<Record<string, unknown>>`——v3 的 ZodEffects 包裹在这里不存在,
     与同文件 `.refine()` 先例一致,无需适配层。
   - 「测试翻转」要连根:两处 409 断言(workflow_template)翻成 approval_config
     时,config-drafts.test.ts 需要现建审批线夹具(levels 形状照抄
     config-versions.test.ts),beforeEach 的 TRUNCATE 已含审批表所以零改动。
   - workflow-templates.test.ts 的 beforeEach TRUNCATE 清单必须随断言面扩张
     (加 config_revisions/config_drafts)——本文件从「只断言行/审计」变成
     「也断台账版本号」,不清表的话跨测试的 ledger 断言会互相污染。
   - noUncheckedIndexedAccess 下 `revs[0]` 是 `T | undefined`,toMatchObject
     挂在可能 undefined 的值上运行时才炸——`must(revs[0])` 先收窄(仓库既有
     must<T> helper,gotcha #73 的日常形态)。
   - schema.ts 只改注释时 `db:generate` 输出「No schema changes」,无产物可
     提交是预期——CI 的 schema/migration 一致性检查对注释不敏感,放心改。
