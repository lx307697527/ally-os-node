---
session_id: hand-written-226-config-drafts
branch: feat/226-config-drafts
date: 2026-10-06
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

# Session log — feat/226-config-drafts — 2026-10-06

> 机械层本次由 agent 手写(ZCode 定时迁移会话);判断层为本次会话手写。

## 机械层(自动)

- **引用的 issue**:#226(配置工作室:配置版本、审计与发布;#232 §4.4「先在
  测试环境试,再一键发布到生产」+ §4.9)——**切片 2:草稿层 + 一键发布**,
  PR 正文写 Part of #226(受监管变更控制门依赖 #206,切片未完,严禁 Closes)
- **前置收尾(第 0 步)**:无 open PR、无残留 worktree、主检出干净。
  选题:#226 评论明列剩余切片(优先级①),claim 成功。

### 本切片改动的文件

- `packages/db/src/schema.ts`:`config_revision_source` 枚举加 `published`;
  新表 `config_drafts`(subject_type + subject_id 唯一 = 一对象一份草稿、
  content jsonb、base_version、note、created/updated 审计列)——草稿**不是**
  append-only(再存即整份替换、发布/丢弃即删,versions 只属于台账)
- `packages/db/migrations/0020_curious_miss_america.sql`(新,drizzle 生成):
  ALTER TYPE ADD VALUE(同事务安全,新值未在迁移内使用)+ CREATE TABLE
- `apps/api/src/config-versions/registry.ts`:`ConfigSubjectSpec` 加
  `draftContentSchema?` 接缝(缺省 = 该族无内容改写路径,草稿/发布答 409);
  `ConfigRevisionTx` 加 `"delete"`(发布事务要删草稿行)
- `apps/api/src/config-versions/families.ts`:三族严格草稿契约并注册——
  custom_field_def(strict + roleSchema + select 选项规则 refine)、
  automation_rule(strict + 复用 `ruleSpecSchema` 的 trigger/conditions/actions)、
  numbering_rule(strict,同 PATCH 面,起始号不在内容契约里)
- `apps/api/src/config-versions/drafts.ts`(新):saveConfigDraft(校验 +
  upsert,baseVersion 服务端取台账最新版)/ getConfigDraft / deleteConfigDraft /
  publishConfigDraft(草稿行 FOR UPDATE → 过期门 → no-change 门 →
  nextConfigVersion → applyRevision → 记 source='published' 版 → 删草稿)/
  describeConfigDraft(stale 标记 + 相对最新现状的顶层变更摘要,过期时照样
  现算);领域错误类 DraftUnsupported/ConfigDraftNotFound/DraftStale/
  PublishNoChange/DraftContentInvalid
- `apps/api/src/config-versions/http.ts`(新):permissionFailure 从
  routes/config-versions.ts 提出共享(台账读面与草稿面同一扇族门)
- `apps/api/src/routes/config-drafts.ts`(新):GET(读草稿 + stale + changes)/
  PUT(存草稿)/ DELETE(丢弃)/ POST publish(一键发布 + 审计
  `config.published` 带 reason 与草稿 note);23505 → 409 `publish_conflict`;
  权限 = 各族配置面的同一权限点(动态按族)
- `apps/api/src/routes/config-versions.ts`:permissionFailure 改用共享件
- `apps/api/src/routes/registry.ts`:4 条新路由声明(session 门,族内动态裁决)
- `apps/api/src/app.ts`:挂载 configDraftsRoutes
- 测试:`apps/api/src/routes/config-drafts.test.ts`(7 条集成,独立临时库:
  存草稿+diff+活配置不被污染 / 族契约拒绝 strict+业务 / 权限三反例一正例
  / 发布全链路+审计+草稿清除 / 过期门+重存再发 / no-change+丢弃 404 /
  numbering 发布+发布版可回滚+custom-field select 规则)
- 文档:`docs/config-versions.md`(切片 2 节 + 剩余项改写)、`docs/numbering.md`、
  `docs/custom-fields.md`、`docs/workflow.md`、`docs/automations.md` 的 #226
  待做表述同步
- **无新依赖、无新 env**

### 验证

- `DATABASE_URL=… corepack pnpm verify` 全绿:**84 文件 / 651 测试**(+1 文件
  /+7 测试;含 DB 集成;本地 postgres = docker ally-os-node-postgres-1)
- route-auth 契约测试首跑抓到未声明路由——声明清单补 4 条后绿(该测试正是
  为此设计的,工作正常)

## 判断层(手写)

### 本次的关键判断

1. **「测试环境」裁成配置对象上的草稿层,不是另一套部署**(本切片最大的
   架构判断)。设计原文「先在测试环境试,再一键发布到生产」容易读成
   staging/prod 两套环境;本系统是单库单部署,双环境是运维投机。裁法:
   草稿存独立 overlay 表(`config_drafts`),活配置读路径在发布前**结构性地**
   看不见它——「试不碰生产」由表边界保证,不靠给五族运行时读法全部加
   `status='published'` 过滤。这条路顺便救了爆炸半径:不加 status 列,五族
   写面、worker 扫描、发号、表单合成、流程/审批解析、既有测试全部零改动。
   PR #274 剩余清单里写的「读侧过滤」由此落成「结构性不可见」,语义更强。
2. **发布复用 applyRevision 接缝,零新机制**。切片 1 的回滚已经回答了
   「快照怎么变回行」;发布是同一问题的另一个方向(草稿快照 → 行),走同一
   条 applyRevision + nextConfigVersion + recordConfigRevision 协议。发布不是
   特殊通道:发布版 source='published' 入台账,之后照常可 diff 可回滚
   (测试钉住:发布 → 回滚 v1 → v3 rolled_back 全链路)。
3. **草稿校验强度 = 配置面业务校验,不是只查 JSONB 形状**。切片 1 的快照
   schema 是 JSONB 边界收口(trigger 是任意 record);草稿若用同一强度,存进
   去一份语义非法的规则,发布后 worker 直接执行垃圾——PATCH 面过不了
   ruleSpecSchema 的内容从草稿后门进了生产。裁法:`draftContentSchema` 对齐
   各族配置面的业务校验(automation 复用 ruleSpecSchema、custom-field 带
   select 选项 refine、strict 拒未知键);发布面不做比保存面弱的第二次放行。
4. **无盲发:baseVersion 由服务端在保存时刻盖章,过期 = 409 拒绝发布**。
   草稿是在旧现状上写的,期间线上 PATCH 前进后,一键发布若放行就把别人的
   变更悄悄盖掉。裁法:发布 409 `draft_stale`,重存(在新现状之上)是唯一
   路径;GET 草稿在过期时照样返回相对最新现状的变更摘要——「草稿想改什么、
   现状已变成什么」正是重存/丢弃决策要看的画面,不裁成 null。
5. **竞态三层的落点**:草稿行 FOR UPDATE(并发保存/发布在草稿行上串行化,
   输者 404 或重插,绝不删掉别人刚存的草稿);台账 unique(subject,version)
   (发布与线上 PATCH 同时在飞,后到者撞 23505 → 事务整体回滚 → 409
   `publish_conflict`,与切片 1「fail loud、静默重号比失败严重」同一裁决);
   no-change 发布 409(与回滚 no-op 同一纪律,不记假变更)。顺序测试覆盖
   (双发布第二次 404),真并发测试不写——两输家结果都是合法 409/404,
   确定性测试钉不变式比 flaky 竞态脚本更有价值(坑 70 的既有教训)。
6. **workflow/approval 诚实不支持**:两族无内容改写路径,草稿/发布答 409
   `publish_unsupported`(与回滚 `rollback_unsupported` 同一裁法)——宁可
   明说「这族还不能」,不假装成功。能力随定义改写端点(#226 后续切片)进场。
7. **受监管门不预埋**:验收第 3 条依赖 #206 变更控制域(phase-5),本切片
   只保证发布端点是唯一的门位(所有生效内容变更经它或经 PATCH 面),不提前
   加 `regulated` 字段——无消费者的字段是投机设计,门随 #206 进场即插。

### 踩的坑(都花时间修了)

1. **erasableSyntaxOnly 又咬构造器参数属性**(TS1294,坑 64 的老坑):
   DraftStaleError/DraftContentInvalidError 想写 `constructor(..., readonly x)`
   直接红——显式字段赋值。这个坑在错误类上第三次出现了,写领域错误类时
   应默认手写字段。
2. **ConfigRevisionTx 的 Pick 面不够宽**:发布事务要删草稿行,原类型只有
   select/insert/update;`Pick<ConfigRevisionTx, "select" | "delete">` 约束
   不满足报 TS2344——直接把共享类型加 `"delete"`(调用方传 db 或 tx 都自然
   满足,零破坏)。
3. **route-auth 契约测试(设计内的红)**:新路由必须同时在
   routes/registry.ts 声明认证要求——首跑 verify 红,补 4 条 session 声明
   后绿。这是该测试第一次在真实开发流里拦住遗漏,机制按设计工作。
4. **numbering GET 不回 version 列**:断言行.version 时红——presentRule
   形状本就没有 version(并非 bug);行版本断言改走台账 history(source
   序列)才是这个切片的本意断言面。
5. **错误类重复插入**:编辑时把 DraftContentInvalidError 类插了两遍
   (先挪前、又忘了删原位)——grep 类名立刻暴露,教训:移动声明用一次
   编辑完成,不要「先加后删」两步走。
