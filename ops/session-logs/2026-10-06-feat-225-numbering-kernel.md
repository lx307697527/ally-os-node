---
session_id: hand-written-225-numbering-kernel
branch: feat/225-numbering-kernel
date: 2026-10-06
reason: issue-225
prompts: 1
unparseable_transcript_lines: 0
models: (zcode)
tokens_in: 0
tokens_out: 0
cache_creation_tokens: 0
cache_read_tokens: 0
thinking_blocks: 0
---

# Session log — feat/225-numbering-kernel — 2026-10-06

> 机械层本次由 agent 手写(ZCode 定时迁移会话);判断层为本次会话手写。

## 机械层(自动)

- **引用的 issue**:#225(配置工作室:报表与模板;#232 §4.6 + §4.9 v2.2)
  ——**切片 1:编号规则内核**,PR 正文写 Part of #225(切片未完,严禁
  Closes 关键字)
- **前置收尾(第 0 步)**:无 open PR;worktree `224-automation-kernel` 是
  **另一会话的在飞工作**(#224 租约 HELD 至 19:44Z,worktree 23 分钟前还有
  改动)——不动它。选题跳过 #224(被租约)落到 #225(未租约,phase-1 配置
  工作室序位下一个)。
- **占位**:`claim_issue.py claim --issue 225` 成功(refs/heads/claims/issue-225)。

### 本切片改动的文件

- `packages/db/src/schema.ts`:`numbering_rules`(subject 开集 + prefix/
  dateFormat 枚举/padding/startNumber/active,version=1 预埋 #226;**active
  上的部分唯一索引** = 一对象一套生效规则,停用留档)+ `numbering_sequences`
  (每规则一行计数,last_issued 语义 = 已发出的最大号)
- `packages/db/migrations/0017_opposite_domino.sql`(新,drizzle 生成)
- `apps/api/src/numbering/registry.ts`(新):可编号 subject 注册表,**刻意
  为空**——发票/报价/PO 域在 phase-2+(#229/#231);`registerNumberedSubject`
  接缝 + `numberedSubjects()` 列表(配置 UI 下拉数据源)
- `apps/api/src/numbering/service.ts`(新):`allocateDocumentNumber(tx,
  subject, { now })`——INSERT(首号 = startNumber)+ ON CONFLICT DO UPDATE
  (+1)RETURNING,行锁串行化并发;`formatDocumentNumber`(prefix + 日期段
  (有则后跟 "-") + 零填充序号,承 INV-3092 / INV-202608-0001 形态);
  `NoActiveRuleError`(fail closed);`dateSegment` 取 **UTC**(时区裁决随
  第一个消费方走 @ally/config)
- `apps/api/src/routes/numbering-rules.ts`(新):POST/GET/PATCH
  `/api/numbering-rules` + GET `/api/numbering-rules/subjects`,全部
  `numbering.configure` 门(owner/admin);PATCH real-change-only 审计
  (changes: {field: {from,to}}),**strict body**——startNumber 显式 400
- `apps/api/src/authz/permissions.ts`:`PERMISSIONS` + owner/admin 矩阵加
  `numbering.configure`
- `apps/api/src/routes/registry.ts`:4 条路由声明;`apps/api/src/app.ts`:挂载
- 测试:`numbering/service.test.ts`(格式/日期段纯单测 9 条)+
  `routes/numbering-rules.test.ts`(独立临时库,12 条集成:403 全路由、
  201+审计、409 rule_exists(23505 因果链)、未注册 400、PATCH 审计/幂等、
  **首号 = startNumber(BUG-054 回归护栏)**、8 并发分配互不相同、停用 fail
  closed + 恢复续号、**AC3 改格式后新号用新格式且不重复**、回滚归还、
  注入时钟)
- 文档:`docs/numbering.md`(新:号的语义与老系统两处刻意差异、改写纪律、
  剩余项);`docs/permissions.md`(权限点现状加 numbering.configure)

## 判断层(手写)

### 本次的关键判断

1. **切片裁法**:#225 三条验收里两条(自助报表加仪表盘、报表权限接口测试)
   是 **Superset 的**(#232 §4.9 v2.2:单独部署 `infra/`、嵌入 SDK + 访客
   令牌行级过滤)——那是部署面,不是本仓库代码,硬凑等于在错误的层交付。
   本切片只做自建半边的「编号规则」,验收第 3 条(「修改编号规则后新单据使用
   新格式,编号不重复」)端到端可验;模板管理(PDF/邮件/短信)留切片 2,
   Superset 列为 infra 依赖的剩余项,PR 写 Part of #225。
2. **唯一性裁决:每规则一条单调计数,日期段只渲染不重置**。老系统 FEAT-060
   给发票否决过年月前缀,理由是「跨年重置状态」;但「格式可配置」是本验收
   的题意,所以把日期段做成**纯渲染段**(改日期格式只改外形,序号继续),
   兼得两者:业务能配 `QT-202610-000001` 形态,内核不背上「每期从 1 开始」
   的重置状态机(那会带来跨格式碰撞证明负担)。真要按年重启,随第一个
   消费方与 #226 版本化一起裁决——不预支。
3. **计数器随事务回滚(与老 nextval 刻意不同)**:最初照搬老系统「回滚烧号
   gap 是预期」写进了注释与测试,集成测试当场打脸——计数器是普通表行,回滚
   时 INSERT 一起回滚,下一个号还是 1。想清楚后这是**更好的语义**:回滚的
   单据从未存在,号归还复用,已提交单据之间无 gap 不重复;老系统烧号是
   nextval 非事务的代价(买「不做串行化点」),而本内核的分配本来就在属主
   事务里(要的就是号与单据同生共死),行锁串行化的代价在本系统单据量级下
   可忽略。三处注释 + 测试 + docs/numbering.md 按新语义统一改写。
4. **首号语义与 BUG-054**:老系统 seed「下一个号」/ mint「上一个号」两套读法
   打架,首个号被永久跳过。本内核 `INSERT (startNumber) ON CONFLICT (+1)
   RETURNING` 让首号 = startNumber 恰好成立,并写专项测试(BUG-054 回归
   护栏)——老 bug 的教训直接变成新内核的测试名。
5. **分配无 HTTP 面**(与 workflow 实例启动同一裁法):发号发生在属主域创建
   单据的事务里,配置工作室只管规则;`GET /subjects` 是注册表唯一的读面,
   给将来配置 UI 的下拉做数据源,否则注册表只写不可见。
6. **UTC 日期段 + 拒绝投机配置**:时区是有业务后果的裁决(+8 每月头 8 小时
   拿上月标签),但 `NUMBERING_TIMEZONE` 环境变量在零消费方的切片里是投机
   配置(与空注册表的「接缝先行」不同:env 没有接缝语义,只有默认值)。
   裁 UTC + docs 写明升级路径,`{ now }` 可注入保证可测。
7. **PATCH strict**:编号规则的 startNumber 被静默忽略是真实业务伤害
   (管理员以为系列已重开),patchBody 用 `.strict()` 让打错的键显式 400
   ——与 custom-fields 的宽松 patch 有意不同,注释写明理由。

### 踩的坑(都花时间修了)

1. **测试桩满足不了 drizzle 链型**:想给 `allocateDocumentNumber` 写个
   no-DB 的 NoActiveRuleError 单测,手写 `select().from().where()` 桩过不了
   typecheck(缺 fields/session/dialect…)。想通了:错误路径已被集成测试
   用真 DB 覆盖(停用规则 → NoActiveRuleError),桩是在冒充 drizzle——删掉
   桩测试,集成测试里语义更真。
2. **权限矩阵测试是「矩阵即测试」的双刃**:`PERMISSIONS` 加
   `numbering.configure` 后,`authz.test.ts` 的 admin 全集断言与
   `app.test.ts` 的 /api/me 精确形状断言双双变红——这正是该机制的用途
   (加权限点必须过矩阵),按预期改两处断言即绿。
3. **并发会话下的 migration 号碰撞**:本切片生成 `0017_opposite_domino.sql`
   时,#224 会话的 worktree 里已有未推送的 `0017_goofy_shinko_yamashiro.sql`
   ——两边都从 origin/main 起步,drizzle 各自生成 0017。本 PR 先合并,
   #224 的 PR rebase 时 `_journal.json` 会冲突、需要改名重排(已知的多会话
   代价,属正常流程,在第 0 步已经确认不动对方 worktree)。
4. **本机 5432 的 Postgres 归属不明**:canonical DATABASE_URL 探活通过
   (TCP open),但同机还有一个 testcontainers 容器映射 65488(Up 28 秒,
   疑似 #224 会话刚起的)。本次直接用 5432 跑集成测试全绿、临时库模式
   (create database/drop with (force))互不干扰;若未来出现串扰,临时库
   纪律本来就是防线。
