---
session_id: hand-written-226-approval-draft-contract
branch: feat/226-workflow-approval-draft
date: 2026-10-07
reason: issue-226
prompts: 1
unparseable_transcript_lines: 0
models: (zcode)
tokens_in: 0
tokens_out: 0
cache_creation_tokens: 0
cache_read_tokens: 0
thinking_blocks: 0
---

# Session log — feat/226-workflow-approval-draft — 2026-10-07

> 机械层本次由 agent 手写(ZCode 定时迁移会话);判断层为本次会话手写。

## 机械层(自动)

- **引用的 issue**:#226(配置版本、审计与发布)剩余项②「workflow/approval
  定义改写端点 + 草稿契约」的收尾——approval 的草稿契约。PR 正文写 Part of
  #226(#226 仍开:受监管配置变更控制门等 #206、配置工作室通用草稿面 UI)。
- **前置收尾(第 0 步)**:无 open PR、无残留 worktree、主检出干净;
  origin/main 顶端 deac7f3(#295,custom-field null 清值)即基线。
- **选题**:①优先续做 issue 评论里的未完成切片。逐个核对 phase-1 开放
  issue 的最新评论:#219/#220/#221 剩余等消费域(#227/#229/#231/#243)进场,
  #222 表单构建器有未定设计器选型、rjsf 接线等消费域,#224 剩余全部等外部
  依赖(SMS 通道、#118 AI、序列域不存在),#225 剩 Superset 部署,#233 剩项
  等 #225 报表域/消费域/#206——唯有 #226 ② 的 approval 草稿契约零依赖、
  边界清晰(workflow 半边已随 #282 落地)。claim 时接管了上一会话的残留
  租约(claim_issue.py 原子接管成功)。
- **老系统参考(只读)**:老系统无配置版本/草稿机制(审批路线写死在代码与
  SQL 里),本切片无直接对标物;「先试后上」语义是 #232 §4.4 与 #226 自己
  的设计。
- **数据库**:本地 postgres 可用,verify 全程带 DATABASE_URL(无 skip)。

### 本切片改动的文件

- `apps/api/src/config-versions/families.ts`:`approvalConfigDraftContentSchema`
  (strict { name: trim 1..200, levels: approvalLevelsSchema, active })注册到
  `approvalConfigSpec.draftContentSchema`——形状 = 快照同一形状(三键整体替换;
  subjectType/configKey 是身份不在内容里),校验强度 = POST/PATCH 面同一道
  approvalLevelsSchema;头注释的族覆盖清单同步(五族带草稿契约,registry_rule
  刻意不带)。
- `apps/api/src/config-versions/registry.ts`:两处过时注释改写——applyRevision
  与 draftContentSchema 的「缺省 = 该族没有内容改写路径(approval)」改为
  registry_rule(定时生效是它的「先试后上」,#233)。
- `apps/api/src/routes/config-drafts.ts`:文件头注释同改(409 反例族从
  approval 换成 registry_rule)。
- `packages/db/src/schema.ts`:**仅注释**——approvalConfigs.configKey 的旧
  注释「定义改写/停用端点随 #226 后续切片进场」已过时(#289 落了 PATCH),
  改为现行裁决正述(键是身份、PATCH/草稿面都不收它);db:generate 确认零
  schema 变更、零迁移。
- 测试(+3,`apps/api/src/routes/config-drafts.test.ts`):
  ①approval 端到端(存草稿 → GET 差异 → 活线不被污染 → 发布 v2 = published
  → 行.version 同步 → 台账 [published, created] → 草稿清 → config.published
  审计带 reason + note);②契约拒绝(空 levels、customer 角色、quorum 缺票数、
  未知顶层键全 400 invalid_content,坏草稿没写进去);③在飞快照隔离(发布换
  审批人后,旧请求仍在原审批人待办、照常可裁,新提交走新路线)。
  另:409 无草稿面钉从 approval 挪到 registry_rule(种一行 registry 规则,
  changeableBy 显式带 admin——effectiveChangeableBy 只恒加 owner,admin 角色
  不在数组里会被 authorizeWrite 403 挡在 409 之前);registryRules 进本文件
  TRUNCATE;夹具单据域 draft-doc(内存 loader,与 approvals.test.ts 的
  approval-doc 同裁法)供在飞测试提交请求。
- `docs/config-versions.md`:族覆盖清单改写(五族带草稿契约 + registry_rule
  刻意不带的理由);剩余项②划掉并补 #226 切片 3 进场记录。
  `docs/approval.md`:「审批线无草稿面」一节改写为草稿契约已开放(先试后上
  = 离线改 levels、发布只改之后的提交、在飞请求带提交时刻快照)。

**验证**:`DATABASE_URL=… corepack pnpm verify` 全绿 106 文件 / 961 测试
(基线 106/958,+3,零 skip;lint/typecheck 含于 verify)。

## 判断层(本次的关键判断与踩的坑)

1. **issue 评论会过时,代码才是现状。** #226 切片 2 的评论说「workflow/approval
   无内容改写路径 → 草稿与发布 409」,但那之后 #282 给 workflow 落了 PATCH +
   草稿 + 回滚、#289 给 approval 落了 PATCH + 回滚——实际剩下的只有 approval
   的 draftContentSchema 一个缺口。若按评论原文去做「定义改写端点」,会做出
   重复的端点。选题时逐个 issue 对照代码现状核对剩余清单,评论只当线索不当
   真相。
2. **409 钉挪窝要连理由一起搬。** 原 409 钉在 approval(当时真的不支持),
   契约补上后钉子不能删(「未注册族不支持」的语义仍要测试钉住),挪到
   registry_rule——它是唯一刻意不带草稿的族,且「刻意」有裁决依据(#233:
   定时生效已承担「先试后上」,草稿会长出第二套同一机制)。测试注释把裁决
   原文带上,下一个读到 409 的人不用翻 issue。
3. **种 registry 规则行时踩了 authorizeWrite 的角色门。** 第一版种子没带
   changeableBy(schema 默认 []),请求会先被逐主体写面门 403 role_required
   挡住、根本到不了 409——effectiveChangeableBy 只恒加 owner,admin 角色
   不在数组里就不算。反例测试要打到目标错误码,前置门必须先放行;集成测试
   失败时先看是不是死在了半路,而不是目标断言。
4. **在飞快照隔离是 approval 草稿面独有的验收点,值得专属测试。** 草稿内核
   的过期门/no-op/竞态是族无关的(automation 已钉),approval 族真正要钉的
   是业务语义:发布换审批人 → 旧请求仍在原审批人待办且可裁决、新提交走新
   路线。这条测试同时覆盖「发布只改之后的提交」的操作者预期——比再抄一遍
   通用机制的测试有价值得多。
5. **切面的分寸:API only,UI 不顺手加。** #224 切片 3 已裁决「配置工作室的
   草稿面 UI 刻意不接,随第一个真实先审后上需求进场」;本次若给
   /system/approvals 单独加草稿面板,会与那条裁决打架(单族 UI 先行 = 未来
   通用面板重做)。服务端契约完成即收,通用草稿面 UI 留给 #226 ③。
6. **过时注释当切片内的顺手正述,不当顺手重构。** schema.ts 里 approval
   configKey 的旧注释指向不存在的「后续切片」——这是本切片主题(审批线写
   路径)的直接事实错误,改;customFieldDefs 的同类注释(内容改写端点确实
   还没进场)是准确的,不动。「顺手」的边界 = 本切片是否恰好把这个事实
   变了。
