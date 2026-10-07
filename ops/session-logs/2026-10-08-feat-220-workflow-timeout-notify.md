---
session_id: hand-written-220-workflow-timeout
branch: feat/220-workflow-timeout-notify
date: 2026-10-08
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

# Session log — feat/220-workflow-timeout-notify — 2026-10-08

> 机械层本次由 agent 手写(ZCode 定时迁移会话);判断层为本次会话手写。

## 机械层(自动)

- **引用的 issue**:#220(配置工作室:流程与状态机,phase-1)——剩余项「超时提醒
  投递」。PR 正文写 **Part of #220**(第一张真实模板/第一个注册 subject 随
  #227/#231/#243、草稿发布 UI、拖拽设计器、#206 regulated gate 未完,保持 open)。
- **前置收尾(第 0 步)**:无 open PR、无残留 worktree、主检出干净。留意到昨日
  其他会话合并了 billing 系列 PR(#300/#303/#307/#308)与 #309,选题时避开
  #221/#192(金额域首接线大概率是别人的下一步)。
- **选题**:①优先续做有未完成切片的 open issue。#220 的「超时提醒投递」在
  #268 落内核时明确延后(「等属主域 + #116 渠道层」),而 #116 渠道层切片评论
  原文写着「#220 超时送达……自此解锁」——延后条件已满足,施工图(approval
  -reminders 同形)现成。选它。
- **claim**:`claim_issue.py claim --issue 220` 成功(接替此前会话释放的租约)。
- **数据库**:本地 postgres 可用(docker-in-docker 的 ally-os-node-postgres-1),
  verify 全程带 DATABASE_URL,**124 文件 / 1230 测试零 skip**(基线 123/1220:
  +1 文件 +10)。

### 本切片改动的文件

- `packages/db/src/schema.ts`:`workflow_instances.state_reminder_at`(0035,
  expand-only)——超时提醒台账,注释写明「推进随进状态一次重置」与
  approval_requests.last_reminder_* 同裁。
- `packages/db/migrations/0035_bright_wild_pack.sql` + meta:db:generate 产物
  (单条 ADD COLUMN)。
- `apps/api/src/workflow/service.ts`:applyTransition 的状态推进 UPDATE 补
  `stateReminderAt: null`(与 stateEnteredAt/stateDueAt 同一次写入);findDueInstances
  注释更新(投递半边已落 worker,本函数是 api 侧内核读法)。
- `apps/worker/src/workflow/reminder.ts`(新):`runWorkflowTimeoutScan`——超时且
  到再催间隔的实例 → 收件人(发起人 ∪ 出边 roles 持有者)各一行
  `workflow.state_overdue`;窄读取 schema 投影 definition 快照(states → on →
  roles,流转两形态都认);事务内盖章(带 currentState 条件)+ 落通知行;提交后
  逐人 pg_notify 催铃(approval-reminders 同通道)。
- `apps/worker/src/workflow/index.ts`(新):`workflowJobs` 登记
  `workflow-timeout-reminders`,每小时 :50,retryLimit 1。
- `apps/worker/src/index.ts`:注册 workflowJobs。
- `apps/worker/src/workflow/reminder.test.ts`(新,9 例,真库):超时首催(收件人
  并集、台账盖章、逐人催)、未到期不催、催后 24h 再催、坏快照跳过告警、收件人
  为空跳过告警、发起人持角色去重、无限角色出边不贡献收件人、多角色并集、
  24h 常量契约、job 注册 cron 断言。
- `apps/api/src/routes/workflow-instances.test.ts`(+1 例):推进重置台账(旧占用
  的盖章痕迹随 CONTACT 清空,contacted 无超时 → stateDueAt null)。
- `docs/workflow.md`:新「已落地:超时提醒投递」专节(谁到期/负责人读法/怎么送/
  没有超时动作);「刻意不做」清单划掉该项。
- `docs/notifications.md`:worker-side producer 小节(state_overdue 不进白名单、
  title/detail 兜底面、台账幂等)。

## 判断层(手写)

### 关键判断

1. **「负责人」在内核的读法 = 发起人 ∪ 能推当前状态的角色持有者,而非只发
   起人**。#268 延后时说「等第一个有负责人的属主域」,属主域至今未进场(可挂
   流程 subject 注册表为空),但实例行上有 startedById、快照里有出边 roles——
   内核已知的数据足够给出一个诚实的读法:催「轮到谁还没推」(出边 roles 的
   并集持有者),与审批催办催当前级审批人是同一语义;发起人是兜底(无角色约束
   的状态 = 可见者中的员工皆可推,给全员工发信是灾难,此时只催发起人)。属主域
   进场后若负责人另有其人(客户负责人等),由属主域自己的扇出补,内核不猜——
   这条写进了 docs/workflow.md 专节,给第一个属主域留了明确的接手位置。

2. **台账放实例行 + 推进方重置,而不是扫描时对比 stateEnteredAt**。备选是
   「无台账,每次扫描看 stateDueAt 已过即催」+ 用 waitingHours 判 24h 节奏——
   被否:节奏会跟 timeoutAfterHours 的值耦合(超时 1h 的状态每 24h 才催一次
   就形同虚设),且「催过」没有事实载体,重试/重扫会重复投递。落列
   state_reminder_at 的成本一行 migration,换来:计时严格按状态占用(A→B→A
   的再占用重新计时,推进写 null 与 stateEnteredAt 同一次写入)、盖章带
   currentState 条件挡扫描期间被推进的实例。与 approval 0026 同构,审查面
   熟悉。

3. **不进铃铛白名单,payload 带 title/detail 走兜底面**。白名单的 parity 测试
   要求每个去处是真实路由,流程实例没有任何页面;昨天合并的 #193 失败付款
   提醒切片(0034)给出了最新先例——「没有承载页的生产者不进白名单,payload
   带 title/detail 事实走兜底面,摘要读同一份事实」。照做;第一个属主域
   (#227/#231/#243)带出实例页时再进白名单指过去。文案是英文事实句
   (`standard_lead has been in "review"`),与 ops/rules「用户可见文案英文」一致。

4. **worker 自己写窄查询,不 import api 的 findDueInstances**。「worker 不跨
   app 依赖」纪律下 approval-reminders 对 approval_requests 也是自查询;照搬
   会把 apps/api 源码吸进 worker 依赖图。findDueInstances 保留为 api 侧内核
   读法(测试仍在用、lifecycle 断言超时语义),注释更新为「投递半边已落
   worker」——诚实标注两个半边的位置,不留「谁消费谁」的悬案。

5. **没有超时动作(只提醒,不自动推进/作废)**。issue 只要求「提醒负责人」;
   R-16-5(业务自批)之下系统不替操作者做决定——审批催办切片同款裁决
   (「没有超时拒绝」)。「超时 N 小时未办即取消」这类后果已经属于 #224
   自动化的 due 触发器(昨天 #285 落的 task due 首成员),写进 docs 提示
   「要后果走自动化」,不让流程内核长出第二套动作执行器。

6. **节奏:每小时 :50 + 24h 再催 + retryLimit 1**。approval-reminders :45 的
   错峰邻位(两个扫描都是稀疏集的小表顺序扫);每小时跑让「刚超时」的实例
   当轮被催到;对账语义幂等后重试 1 次足够,下一轮扫描是天然兜底。

7. **选题裁法:延后条件要验证而非照抄**。#268 说「等属主域 + #116」,若照字面
   等属主域,本切片还会再悬一周——但 #116 评论明确写「#220 超时送达自此
   解锁」,把「等」拆成了「渠道层已就绪,负责人读法内核可自裁」。延后项的
   复活条件是切片自己的裁决,不完全是原注释的字面。

### 踩坑

- **afterEach 清库第一版写成了裸字符串 + `as never` + `.catch(() => {})`**——
  三重错:绕开 drizzle sql 模板的表名解析、as never 骗类型、吞掉清库错误会让
  下一例假绿(残留行污染断言,报错位置离根因一个测试远)。改回
  `sql\`truncate table ${schema.workflowInstances}, ${schema.notifications} cascade\``
  (approval reminder.test.ts 同款)。教训:抄夹具要抄语义(为什么这么写),不
  只抄形状。
- **migration 编号竞争窗口**:0034 是昨天另一会话的 dedupe_key 切片,我
  db:generate 拿到 0035。若合并前 main 又进新 migration,按既定程序解(gotcha
  75:merge origin/main、以对方编号为准重生成、保留双方 snapshot)。
- **老系统参考为空但必须验证过才能说空**:grep 了 ally-os 的
  overdue/timeout_reminder——只有 card-over-cap/invoice_reminder 等财务提醒,
  无任何流程超时类比(与 #268「全仓库无可配置流程」普查一致);docs 里的
  「老系统无对应物」结论引用普查而不新造。
