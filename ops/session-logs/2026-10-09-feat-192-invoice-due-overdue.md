---
session_id: hand-written-192-invoice-due-overdue
branch: feat/192-invoice-due-overdue
date: 2026-10-09
reason: issue-192
prompts: 1
unparseable_transcript_lines: 0
models: (zcode)
tokens_in: 0
tokens_out: 0
cache_creation_tokens: 0
cache_read_tokens: 0
thinking_blocks: 0
---

# Session log — feat/192-invoice-due-overdue — 2026-10-09

> 机械层本次由 agent 手写(ZCode 定时迁移会话);判断层为本次会话手写。

## 机械层(自动)

- **引用的 issue**:#192(发票草稿 + 财务确认,phase-2)——剩余清单第 3 条
  「到期前提醒(R-12-7,渠道层 + due 扫描)」的 **due 扫描半边**。PR 正文写
  **Part of #192**(触发点接线、客户面提醒、#241 回写、#181 QuickBooks、#128
  PDF、红冲动词未完,保持 open)。
- **前置收尾(第 0 步)**:open PR #313(收款动作 web 面,同 issue)。CI 首跑
  四项全红——三红是 runner 基础设施抖动(Lint job 的 Docker 端口占用、Terraform
  全 step 绿但 job 结论红、Docker server 卡 23 分钟),重跑一轮后仅剩 Docker web
  红(buildx 往 GHA cache 服务传 layer blob 时 unexpected EOF + npm registry 一串
  socket timeout,均非代码),再重跑单 job 后全绿。squash 合并(bb75076)、
  #192 评论成果、删除分支与 worktree。
- **选题**:①优先续做有未完成切片的 issue——#192 评论里剩余清单明确,due
  扫描是其中最自包含的一项(不依赖未建域);施工图(workflow 超时提醒 #310 的
  台账 + 条件盖章范式)三天前刚合并,现成。
- **claim**:`claim_issue.py claim --issue 192` 成功(接替已过期的租约)。
- **数据库**:本地 postgres 可用(localhost:5432),verify 全程带 DATABASE_URL,
  结果见文末。
- **rebase**:实现中途 #313 进 main(动了 invoices-client.ts 与 billing.md,
  与本切片有文件重叠)——WIP 提交后 `git rebase origin/main` 干净通过,再继续。

### 本切片改动的文件

- `packages/db/src/schema.ts`:`invoices.due_at`(到期日,null = 未约定账期)+
  `invoices.overdue_reminder_at`(逾期提醒台账)+ 部分索引
  `invoices_issued_due_idx`(候选集:issued ∧ due_at 非空);表头 R-12-7 注释
  从「本内核零通知」更新为「内部半边已落,客户面等门户」。
- `packages/db/migrations/0037_flippant_chameleon.sql` + meta:db:generate 产物
  (两列 + 一个部分索引,expand-only)。
- `apps/api/src/billing/service.ts`:confirmInvoice 收可选 `dueInDays`,服务端算
  `dueAt = issuedAt + N 天`(MS_PER_DAY 整数加法);already 分支不改写 dueAt。
- `apps/api/src/routes/invoices.ts`:confirm body zod(`dueInDays` 0–365 整数,
  body 可省);审计 `invoice.confirmed` 带 `dueInDays` + `dueAt`;presentInvoice
  (列表/详情)带 `dueAt`。
- `apps/worker/src/billing/overdue.ts`(新):`runInvoiceOverdueScan`——候选集
  (issued ∧ 到期已过 ∧ 未催或催满 24h)两条分组查询实时派生 total/paid,
  paid < total 才催;收件人 = invoices.manage 持有者(api invoiceAlertRecipients
  同矩阵的 worker 窄读取);事务内盖章(带 status 条件)+ 落
  `invoice.overdue` 通知(dedupe_key 日粒度);提交后逐人 pg_notify 催铃。
- `apps/worker/src/billing/index.ts`(新):`billingJobs` 登记
  `invoice-overdue-reminders`,每日 13:10 UTC,retryLimit 1。
- `apps/worker/src/index.ts`:注册 billingJobs。
- `apps/worker/src/billing/overdue.test.ts`(新,10 例,真库):逾期首催(收件人
  三方、台账盖章、金额事实成句、逐人催)、付清/部分收款、void 钱行不抵扣、
  未到期/无账期/草稿不进候选、$0 票 vacuously paid、24h 再催节奏、dedupe_key
  吃重复投递、无收件人整轮跳过(临时清矩阵验证真分支)+ bystander 对照、
  24h 常量契约、job 注册 cron 断言。
- `apps/api/src/routes/invoices.test.ts`(+1 例,原 confirm 例扩展):无 terms
  dueAt null;dueInDays 30 → dueAt = issuedAt + 30d、审计带 terms、重复确认
  不改写;负数/小数/366 → 400;0(见票即付)合法。
- `apps/web/src/shared/lib/notification-face.ts`:`invoice.overdue` 进白名单 +
  case(亮 worker 拼好的 title/detail,深链 `/invoices/:invoiceId`)。
- `apps/web/src/shared/lib/notification-face.test.ts` / `notification-href-routes.test.ts`:
  白名单清单、逾期 face、href parity 三处同步。
- `apps/web/src/shared/lib/invoices-client.ts`:invoiceSchema 补 `dueAt`
  (API 契约同步;展示随后续切片)。
- `docs/billing.md`:新「已落地:发票到期日与逾期对账扫描」专节(terms 口径/
  UTC/扫描节奏/两层幂等/老系统对照);剩余清单第 3 条改为「客户面提醒 + web
  展示待做」。
- `docs/notifications.md`:worker-side producer 补 invoice.overdue 小节。
- `docs/cron-migration.md`:表 A 补 A29(billing-invoice-overdue-sweep →
  invoice-overdue-reminders 的处置与不搬清单)。

## 判断层(手写)

### 关键判断

1. **R-12-7 切成两半,先落内部半边**。原文「到期前自动提醒客户;逾期由财务
   人工催」——前半的收件人是客户,而客户域(#235)与门户(#186)都未建,
   「没有收件人的邮件不存在」(#192 内核注释的既定裁法,0011 时就写下了);
   后半「人工催」的前提是财务得先**看见**什么逾期了——这正是系统能落的部分:
   due 扫描 + 铃铛。老系统普查证实这个切法:FEAT-765 落的正是内部告警
   (stage 1/7/30 + Slack 日报),客户催款同样刻意不做(员工手动重发)。新系统
   的对应物是通知域,不是 Slack。

2. **due_at 存时刻(issuedAt + N 天,UTC),不存日期**。老系统是 `date` 列 +
   纽约时区日界换算(读写两处 `at time zone 'America/New_York'`);新系统
   numbering 已裁「维持 UTC」,terms 又是「N 天」的整数事实——
   `issuedAt + N × 86400000` 纯整数加法,没有日界就没有漂移,也不需要
   「13/14 UTC 双触发、函数内只在纽约 09:00 做事」这类时区对冲技巧。读面
   要日期时 `toISOString().slice(0, 10)`,展示层的事不回写存储。

3. **terms 进 confirm 的 body(dueInDays 整数),不进 createDraft、不落客户
   主数据**。到期日是发行事实:草稿阶段谈 terms 为时过早(草稿可能作废),
   issued 时刻由财务按合同给账期——与「确认即发出」同一道人闸。枚举
   (due_on_receipt/net_15/30/60)被否:那是老系统 per-account credit_terms 的
   词表,新系统客户域未建,per-invoice 的整数天数更诚实(0 = 见票即付,
   合同写什么就给什么);#241 客户账期进场后再做缺省读取。already 幂等分支
   不改写 dueAt——「到期日只随第一次确认落」与「审计不落第二行」同一纪律。

4. **付清的票由 paid ≥ total 过滤出局,台账不因收款清零**。备选是「收款写面
   顺带清 overdue_reminder_at」——被否:收款路径有三个写面(手工记账、两个
   webhook),漏一个就是永远不再提醒的逾期票(bug554 快照漂移家族的提醒版);
   而派生过滤只有一处真理(computePaymentStatus 的同构读法),每次扫描都
   重算。台账只回答「上次催是什么时候」,$0 票 vacuously paid 的裁决顺带
   保证了「零金额票永不提醒」。

5. **扫描时点 13:10 UTC,夹在 rules(13:00)与摘要(13:30)之间**。逾期提醒
   的价值一半在当天进摘要邮件;放摘要之后就是晚一天。这不是巧合可依赖的
   顺序而是登记时的错峰设计,写进了 job 注释与 notifications.md。

6. **收件人矩阵在 worker 侧窄读取,formatMoney 镜像一份**。「worker 不跨 app
   依赖」是 #310 已立的纪律(api 的 billing 内核过不来);invoiceAlertRecipients
   的查询(owner/finance ∪ 个人授权)照形重写,formatMoney 同语义镜像并注释
   指向 api 侧原版——两处各自拥有自己的渲染面,与 workflow reminder 侧的
   resolveRoleHolderIds 同款取舍。

7. **老任务名不沿用**:cron-migration 的「任务名沿用老任务名」是为了切换日
   `cron.unschedule` 对照,但本任务与老 sweep 语义不同构(无档位、无 Slack、
   单触发),沿用老名会造成「已迁移」的错觉。以新名 `invoice-overdue-reminders`
   登记 + 表 A 补 A29 行写明处置差异,对照表的作用反而更完整——老任务在
   FEAT-765 后加入,原表 A 的 28 项快照漏了它,本次顺带补上。

### 踩坑

- **#313 中途进 main 造成文件重叠**:我的分支基于 fd6db40,实现过半时 #313
  合并(bb75076 动了 invoices-client.ts +215 行与 billing.md 剩余清单)。
  WIP 提交后 rebase,重叠两文件都干净通过(zod schema 区域稳定、剩余清单
  #313 已自行改写我不再碰旧句)。教训:开工前 `gh pr list` 里 open 的同域
  PR 要当作「即将进 main 的重叠源」记在心上,docs 的「剩余」小节最容易撞。
- **dueAt 在 already 分支返回 null 的类型语义曾犹豫**:返回形状里 dueAt
  承担两个角色(写入结果 vs 行现状),最后只让它表达「本次写入的到期日」
  (issued 带值、already 恒 null——审计只在 issued 落,消费面唯一),注释
  写明;比加一次 header 重读便宜,比假装「行现状」诚实。
- **测试夹具直落表行而非走服务**:扫描读的是表不是 createDraftInvoice 的
  服务语义,票例行直插(number 自增字符串绕开 numbering 夹具)更接近被测
  对象;付款行只给必填列(method/amountCents/receivedAt)。workflow
  reminder.test.ts 的「夹具抄语义不抄形状」教训的反面应用:这次语义就是
  「表上的事实」,那就直落表。

## 验证

`DATABASE_URL=postgres://ally:ally@localhost:5432/ally corepack pnpm verify`
全绿(数字见 PR 正文)。迁移 0037 在本地库 apply 无错;worker 扫描 10 例、
路由 14 例、web 面 28 例均绿后再跑全量。
