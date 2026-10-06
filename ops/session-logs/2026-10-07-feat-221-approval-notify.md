---
session_id: hand-written-221-approval-notify
branch: feat/221-approval-notify
date: 2026-10-07
reason: issue-221
prompts: 1
unparseable_transcript_lines: 0
models: (zcode)
tokens_in: 0
tokens_out: 0
cache_creation_tokens: 0
cache_read_tokens: 0
thinking_blocks: 0
---

# Session log — feat/221-approval-notify — 2026-10-07

> 机械层本次由 agent 手写(ZCode 定时迁移会话);判断层为本次会话手写。

## 机械层(自动)

- **引用的 issue**:#221 剩余项「pg-boss 催办与多级通知扇出(#116)」——#116
  渠道层(#281)合并后评论明确「#221 多级扇出自此解锁」,本切片把通知半边落掉。
  PR 正文写 Part of #221(会签/票签、金额域接线、配置 UI 仍在,严禁 Closes)。
- **前置收尾(第 0 步)**:无 open PR、无残留 worktree、main 与远端同步
  (576a7a2 = #282);主检出干净,全程 worktree 流程。
- **选题**:按优先级①先把候选过了一遍——#219 剩余(签名墙页面)需要第一个有
  签署历史的承载页且上会话明确「随消费域进场」;#220 超时投递无真实 workflow
  模板(注册表空,内核空转);#221 本切片有真实消费(R-16-6 审批线 + 待办页)
  且刚被 #281 解锁。claim 原子租约拿到。
- **数据库**:本地 postgres 容器健康,全部测试带 DATABASE_URL 跑(无 skip)。

### 本切片改动的文件

- `packages/db/src/schema.ts`:`approval_requests` 加 `last_reminder_at` /
  `last_reminder_step`(催办台账,注释写明与 digest_sent_at 同一裁法)
- `packages/db/migrations/0026_faulty_thing.sql`(db:generate):两条
  expand-only ADD COLUMN,无数据回填
- `apps/api/src/approval/service.ts`:`resolveAdjudicatorIds`(点名 ∪ 角色持有者,
  app_role 枚举防御过滤)+ `notifyAdjudicators`(approval.pending 行,事务内;
  事实字段 configName/levelName/actorName/detail,文案在展示层)+ submit 加
  `opts.notifyUsers` 首级扇出 + act 推进时下一级扇出(与推进同事务)+ 终态通知
  payload 补事实 + 提交后「催」名单扩展(终态催发起人 / 推进催下一级)
- `apps/api/src/routes/approvals.ts`、`routes/user-roles.ts`:两条提交路径接
  `deps.notifyUsers`(user-roles deps 类型同步扩)
- `apps/worker/src/approval/reminder.ts`(新):`approval-reminders` 扫描——
  在飞请求本级停满 24h → 当前级审批人各一行 `approval.reminder`;台账盖章先行
  且带 current_step/status 条件(扫描期间被推进/关闭的不催,盖章与通知行同
  事务);进入时刻 = 最后一条 action 的 createdAt(首级回落提交时刻);worker 侧
  窄读取 schema 投影 levels(不跨 app 依赖,读不准跳过+告警)
- `apps/worker/src/approval/index.ts`(新):job 登记,cron `45 * * * *` 每小时,
  retryLimit 1(对账幂等,下轮扫描即兜底)
- `apps/worker/src/index.ts`:注册 approvalJobs
- `apps/web/src/shared/lib/notification-face.ts`:白名单 + `approval.pending` /
  `approval.reminder` 两脸(去处 `/approvals`);终态事件刻意不进白名单(注释
  写明理由);`hoursWaiting` 事实读法
- 测试:`apps/api/src/routes/approvals.test.ts`(bellNudges 记录面 + 3 个扇出
  测试:首级点名+角色、推进/终态时序、自批线不自我通知)、
  `apps/worker/src/approval/reminder.test.ts`(新,9 测试:到期/未到期/再催
  间隔/级推进重计时/action 基线/空审批人集/坏快照/并集去重/24h 常量契约 +
  job 登记形状)、`apps/web/src/shared/lib/notification-face.test.ts`(+4)
- 文档:`docs/approval.md` 新增「已落地:多级通知扇出 + pg-boss 催办」小节,
  「刻意不在」清单划掉已落地项

### 验证

- `DATABASE_URL=… corepack pnpm verify` 全绿:93 文件 / 759 测试
  (基线 92/737,+1 文件 +22 测试);lint / typecheck / test 三段全过。

## 判断层(手写)

1. **催办载体 = 铃铛通知行,不是提醒任务**:规则待办提醒(#233 切片 2)用任务
   做载体,是因为规则注册表没有别的「等谁」的面;审批已经有 `/approvals` 待办页
   ——再造一批「去催审批」的任务等于同一事实亮在两个面上,还得处理关闭同步。
   通知行走铃铛 + 每日邮件摘要(#116 渠道层自动拾取 payload 的 detail 事实),
   一条投递路径都不用新造。
2. **台账在请求行上,不在通知表里查**:`last_reminder_at/step` 两列(0026)让
   「本轮催没催过」是一个行读,不用按 (aggregate, eventType, step) 反查通知表
   ——通知行是给用户的,台账是给扫描的,digestSentAt 先例同裁。盖章 UPDATE 带
   `current_step/status` 条件且先行:扫描期间请求被推进/关闭 → 匹配 0 行,本轮
   不催;盖章与通知行同一事务,要么都在要么都不在。
3. **24h 是常量不是配置**:没有消费域要求可调节奏之前不抬进配置面(与
   applyDueRuleChanges「随首个消费域进场」同一裁法);注释里写明了抬升路径
   (expand-only)。审批**没有超时拒绝**:R-16-5 之下没人有权替审批人做决定,
   催办只是把「这儿等着」再递一次——这个负面裁决写进了 docs 与模块注释。
4. **终态事件不进铃铛白名单**:href parity 守卫要求白名单事件的去处命中真实
   路由;completed/rejected 的承载页(「我发起的审批」)还不存在,挂 `/approvals`
   是死链面(守卫存在的意义就是抓这种)。落法:payload 补 configName/actorName/
   detail 事实,兜底面亮事件类型 + 事实、去处 null——诚实的占位,承载页进场后
   再白名单。pending/reminder 的去处是 `/approvals`(裁决发生地,配置点名的
   裁决人必然可达)。
5. **worker 窄读 levels,不抽共享包**:内核在 apps/api、worker 不跨 app 依赖是
   既有裁决(rules/index.ts 注释明写);读投影用窄 zod 只认 name/users/roles,
   写面校验仍是一处收口——两处 schema 的漂移风险由「窄投影 + 跳过告警」的
   fail-open-to-skip 语义兜住(坏快照只少一条提醒,不挡业务)。
6. **扇出的 exclude 只有动作方**:自批线提交人不给自己报信、推进者(可能兼任
   下一级)不给自己报信;发起人在中间级推进时不收进度信,铃铛只在终态响——
   「轮到谁」的信只发给「该裁的人」。

### 踩的坑

- **`approval_actions` append-only 触发器拒 DELETE**:测试清库 `db.delete` 直接
  P0001,且 afterEach 半途抛错让 requests 残留、后续测试计数全歪。清库只能
  TRUNCATE(行级触发器不 fired),requests 被 actions 引用必须一条语句一起清
  (gotcha #61 的变体:这次是 DELETE vs TRUNCATE 的差别)。
- **drizzle 裸 sql 聚合不走列类型映射**:`sql<Date>\`max(created_at)\`` 运行时
  给的是 ISO 串,`.getTime is not a function`;声明 `sql<string>` + `new Date()`
  归一(Date 入参也兼容)。
- **`Pick<Db,"select">` 上的 `selectDistinct` 链让 eslint「type could not be
  resolved」**:同文件 `select({...})` 链没事——换成 select + JS Set 去重(结果
  等价,本来就要 Set)。
- **单用途泛型过不了 `no-unnecessary-type-parameters`**:gotcha #65 的
  `<TDb extends Pick<…>>` 只在泛型出现在返回值/嵌套位置时才值得;本 helper 直接
  用具体 `Pick<Db,"select" | "insert">`(drizzle tx 结构性可赋值)。
- **`require-await` 连记录型 fake 都咬**:async 函数体只有同步 push 也不行,
  fake 的 query/notifyUsers 写成同步体 + `return Promise.resolve()`。

### 遗留 / 下一步

- #221 剩余:会签/票签、金额域首接线(#229/#231)、审批配置 UI(随配置工作室)。
- 催办节奏(24h)与「提醒要不要带邮件直发」等第一个消费域说话。
- 终态通知的承载页(我发起的审批)随 phase-2 属主域进场后补白名单脸。
