---
session_id: hand-written-110-activity-stream
branch: feat/110-activity-stream
date: 2026-10-06
reason: issue-110
prompts: 1
unparseable_transcript_lines: 0
models: (zcode)
tokens_in: 0
tokens_out: 0
cache_creation_tokens: 0
cache_read_tokens: 0
thinking_blocks: 0
---

# Session log — feat/110-activity-stream — 2026-10-06

> 机械层本次由 agent 手写(ZCode 定时迁移会话);判断层为本次会话手写。

## 机械层(自动)

- **引用的 issue**:#110(评论、@提及、通知与活动流;#232 M6)——**切片 3:
  活动流(每个业务对象的活动时间线)**,PR 正文写 Part of #110(关注、评论
  编辑未做,附件/阶段笔记/邮件汇总被阻塞,严禁 Closes 关键字)
- **前置收尾(第 0 步)**:fetch 后无 open PR、无残留 worktree、主检出干净
  (main = 4fa6080)。选题:候选续做 issue 里 #25/#23/#113 的剩余项全部等
  #227/#235/#116/#221 等别的模块,#110 的活动流、关注、评论编辑是无阻塞
  剩余项,按编号取第一个。`claim_issue.py claim --issue 110` 成功。
- **老系统参考**:issue 正文的 workspace_comments/workspace_activity 在
  d:\Code\ally-os 当前 main 已不可考(与 #113 切片 1 的发现一致,老仓库在
  issue 撰写后又演进了);实际对应物是 `crm.activities`(subject_type/
  subject_id 多态、业务写入时手工落行,crm_core.sql)——形态参考,未照搬。

### 本切片改动的文件

- `apps/api/src/subjects/registry.ts`(新):多态 subject 注册表从
  comments.ts 抽出成共享模块(SUBJECT_LOADERS / SubjectContext /
  loadVisibleSubject)——评论与活动流是两套读法、同一扇可见性门,门不能长出
  两份裁决
- `apps/api/src/routes/activity.ts`(新):`GET /api/activity`,audit_events
  的按对象读投影;行 → subject 归属 = `target = subjectId` 或
  `detail.subjectType/subjectId` 双 clause;actor 经 auth_user 联名
  (uuid::text 比较,避免对 text 列做 uuid cast 在 cli: 前缀上炸);最新在前,
  limit/offset + 精确 total(与 audit 页/评论同一分页语义)
- `apps/api/src/routes/comments.ts`:改用共享注册表,删除本地副本(行为不变,
  9 条既有测试全绿)
- `apps/api/src/routes/registry.ts` + `app.ts`:声明 + 挂载(session 类;
  投影只含 subject 自己的行,看得到对象就看得到历史,无新权限点)
- `apps/web`:`shared/lib/activity-client.ts`(zod + notfound/unavailable
  两态失败面);`TaskDetail.tsx` 加 Activity 区(loading/unavailable/empty/
  时间线四态不撒谎;comment.created 行深链 `?comment=` 复用铃铛高亮;发评/
  删评后两个读者一起失效);`task-detail-activity.test.ts`(jsdom-free 源码
  断言,audit-log.test.ts 同款)
- `docs/audit.md`:新增「第二个读者:按对象的活动流投影」——一条事实流两个
  读者的门表、行 → subject 归属约定、以及「新域活动行默认自动进时间线,例外
  靠不带 subject 引用而非投影端黑名单」的理由
- 测试:`apps/api/src/routes/activity.test.ts`(7 条集成,独立临时库样板:
  未注册类型 400、反探测 404、投影行序与 actor 联名、跨 subject 隔离、
  分页、纯读不写审计、已删评论行仍归属 subject);`activity-client.test.ts`
  (3 条)

### 验证

- `DATABASE_URL=… corepack pnpm verify` 全绿:62 文件 / 453 测试(上一个
  切片是 59/437;+3 文件 +16 测试),lint/typecheck 通过,无 schema 改动
  (纯读投影,无 migration)。

## 判断层(本次的关键判断)

1. **活动流 = audit_events 的读投影,不建第二张活动表**(本切片最大的裁决)。
   老系统 crm.activities 是「业务写入时手工再落一行活动」,前提是审计由触发
   器按另一套形态记录;新系统 #29 已把「业务变更同事务落审计」立成纪律,
   task.created/status_changed/assigned、comment.created/deleted 都是真实
   生产者——活动流再立表,每个域就要写两遍同一事实。选投影后,新域的活动行
   「零接线」自动进时间线,代价是「行 → subject」需要一个归属约定,落在
   docs/audit.md(target 直指 或 detail.subject 双路径)。
2. **两个读者、两扇门,不共用 audit.read**。审计页是合规面向(全公司记录,
   owner/admin);活动流是协作面向(单对象历史,subject 可见者)。投影只含
   该 subject 自己的行,「看得到对象就看得到对象的历史」不构成越权面——这
   也是路由用 session 门而非新权限点的依据,与「可评即可见」同一先例。
3. **例外靠数据形态,不靠投影端黑名单**:若将来某审计行不该出现在协作时间
   线,让该行不带 subject 引用(target 指别的凭据、detail 不带 subject 键),
   而不是在端点维护动作黑名单——黑名单的失败模式是「新域忘了登记 → 该显示
   的不显示」,静默漏比多显严重。裁决原文在 docs/audit.md。
4. **注册表抽取是切片内重构,不是顺手重构**:comments.ts 的 SUBJECT_LOADERS
   本是私有副本,活动流是第二个消费者,抽到 subjects/registry.ts 让「门只有
   一份」可执行;comments 9 条测试原样绿证行为不变。没动任何无关文件。
5. **实时推送不做在本切片**:活动流自刷新只挂在本页动作(发评/删评)上,
   他人变更要实时到需要 subject 维度的频道(task:<id>)与 hub 逐对象鉴权,
   属 #30 推送基础设施的下一步;本切片不预置。PR 剩余项里写明。

## 踩的坑

- **noUncheckedIndexedAccess 对数组解构不豁免**:`const [a, b] = events` 后
  a/b 是 `T | undefined`,typecheck 红了 8 处——用 `expectDefined` 辅助
  (断言 + 收窄)而不是 `as T` 硬转,越界在测试自己的辅助函数里炸。
- **drizzle 的 `or()` 返回 `SQL | undefined`**:归属条件收尾 `?? sql\`false\``
  保持返回类型为 `SQL`,不用 `as SQL` 断言。
- **uuid 联名方向**:`actor(text) = auth_user.id(uuid)` 不能把 text cast 成
  uuid(`cli:grant-role` 会炸整条查询),反过来 `auth_user.id::text = actor`
  永不抛错——测试里 Alice/Bob 联名成功、cli 行的 System 显示留给 UI。
- **老仓库的表名漂移再确认一次**(与 #113 切片 1 同坑):issue 正文引用的
  workspace_* 表在当前老 main 不存在,按纪律以老仓库实际状态为准、issue
  正文只作意图参考。
