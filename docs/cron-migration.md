# 定时任务迁移对照表(pg_cron + pg_net → pg-boss)

对应 issue:#32(所属模块 #185,phase-1)。老系统用 pg_cron 定时、pg_net 从数据库发 HTTP
敲 edge function;新系统统一为 `apps/worker` 里的 pg-boss 任务(队列和定时都存在 PostgreSQL,
不需要 Redis / SQS)。

## 本次交付与登记策略

- **框架(已落地)**:任务在 `apps/worker/src/jobs/` 登记(名字 + cron + 处理函数),
  `runner.ts` 负责建队列、注册 cron、执行、重试与失败告警(默认重试 3 次、60s 指数退避;
  失败每次尝试都发 Slack 告警,重试耗尽的消息会标明 gave up)。未配置 `SLACK_WEBHOOK_URL`
  时只记日志不推送。
- **任务逐个随领域迁移登记**,不在框架 PR 里登记只有空壳的处理函数——一个"会跑但什么都不做"
  的定时任务比没有更糟(占用告警通道、制造已在迁移的错觉)。每个任务登记时:**cron 表达式
  原样照搬(UTC)、任务名沿用老任务名**(便于切换期与老库 `cron.unschedule` 逐个对照)。
- 下表是全量对照:每个老任务 → 新任务归属(随哪个领域/issue 登记)或废弃原因。

> 老系统状态有两个来源:① issue #32 正文(2026-09-30 从线上 `cron.job` 抄的旧时代任务名);
> ② 老仓库迁移文件 HEAD(FEAT-043 重构后的任务名)。两份名单都对不上的部分以切换日
> `SELECT * FROM cron.job` 的实测为准(见文末切换手册)。

## 表 A:老仓库迁移 HEAD 上的任务(重构后现状,29 个)

| # | 老任务 | cron(UTC) | 干什么 | 新系统归属 |
|---|--------|------------|--------|------------|
| A1 | outbox-dispatcher | `* * * * *` | 消费出站队列(邮件/短信/通知发送) | 随通信域(#110/#116/#131),任务名 `outbox-dispatcher` |
| A2 | outbox-reconcile-cron | `10 4 * * *` | 扫描价值链不变量 + 死信,聚合告警 | 随通信域(同上),任务名 `outbox-reconcile` |
| A3 | comms-sequence-advance-cron | `*/5 * * * *` | 邮件序列引擎推进 | 随邮件域 #131 |
| A4 | sms-quiet-hours-retry-cron | `*/5 * * * *` | 免打扰时段短信到点重发 | 随通信域;新系统优先用 pg-boss 延迟投递(sendAfter)实现,登记时由通信域 PR 定 |
| A5 | calendly-reconcile-cron | `25 * * * *` | Calendly 预约对账回填 | 随自建预约 #207(过渡期外部日历对账) |
| A6 | iclosed-reconcile-cron | `8 * * * *` | iClosed 预约对账回填 | 废弃:iClosed 被 #207 自建预约取代(#207 上线前的过渡期如仍在用 iClosed,临时保留) |
| A7 | fx-rate-sync | `40 5 * * *` | 拉取 USD 参考汇率入库 | 随原料价格域 #132/#149 |
| A8 | pricing-expire-due-quotes | `15 * * * *` | 到期报价作废 | 随报价域 #229/#127 |
| A9 | pricing-summarize-reprice-flags-cron | `22 14 * * *` | 每日重报价标记汇总报表 | 随报价域 #127/#230 |
| A10 | signing-reminder-cron | `37 14 * * *` | 滞留签名提醒 | 随合同签署 #236 |
| A11 | quickbooks-wire-pull-cron | `5 * * * *` | QuickBooks 银行流水拉取暂存待认领 | 随财务域 #181/#183 |
| A12 | wire-registration-patrol-cron | `50 13 * * *` | 发票超期未登记收款巡检告警 | 随财务域 #183 |
| A13 | hubspot-fetch-activities-cron | `15 * * * *` | HubSpot 活动(通话/会议/邮件)增量拉取 | 随 CRM 域(M1,#186;暂无独立 issue) |
| A14 | hubspot-reconcile-cron | `0 3 * * *` | HubSpot 漂移修复(哈希不一致/孤儿映射) | 随 CRM 域(同上) |
| A15 | supplier-qualification-patrol-cron | `56 13 * * *` | 供应商资质到期回落 + 提醒 | #216 |
| A16 | rfq-reminder-cron | `7 14 * * *` | 询价 3 天未回自动跟催 | 随采购域(M3,#188;暂无独立 issue) |
| A17 | rfq-auto-close-cron | `12 14 * * *` | 询价第 8 天自动关闭并通知采购 | 随采购域(同上) |
| A18 | feedback-github-sync-cron | `*/10 * * * *` | 反馈单 ↔ GitHub 状态同步 | 随反馈域(暂无独立 issue) |
| A19 | core-audit-roll | `0 0 * * *` | 审计表分区滚动 | 随审计日志 #29(新系统表是否分区由 #29 设计定) |
| A20 | comms-partition-roll | `0 0 * * *` | 通信表分区滚动 | 随通信域 |
| A21 | marketing-interaction-roll | `0 0 * * *` | 营销互动表分区滚动 | 随营销/获客域(M1) |
| A22 | platform-rate-limits-cleanup | `20 3 * * *` | 限流计数清理 | **已落地**(#27 切片 1,2026-10-09):任务名 `rate-limit-cleanup`、每 10 分钟。每日定点改高频小扫描——删除是纯年龄扫描,跑空白来;计数器留 1 天、拒绝台账留 30 天(docs/abuse-prevention.md) |
| A23 | platform-cleanup-funnel | `25 4 * * *` | 漏斗事件过期清理 | 随营销/获客域(M1) |
| A24 | scheduling-sweep-appointment-tokens | `30 3 * * *` | 过期预约令牌清扫 | 随自建预约 #207 |
| A25 | platform-backup-history-cleanup | `35 3 * * *` | 备份历史过期清理 | 随备份 #33 |
| A26 | platform-scheduler-runs-cleanup | `45 3 * * *` | 老调度器运行台账清理 | **废弃**:pg-boss 自带保留策略(队列 `deleteAfterSeconds`/`retentionSeconds`)取代,无需自建台账 |
| A27 | platform-collect-http-responses | `*/5 * * * *` | 收割 pg_net 异步 HTTP 响应 | **废弃**:pg-boss worker 同步执行并持有结果,不存在异步响应需要收割 |
| A28 | marketing-abandoned-forms-cleanup | `20 3 * * *` | 半途表单提交数据清理 | 随营销/获客域(M1) |
| A29 | billing-invoice-overdue-sweep | `0 13,14 * * *` | 发票逾期三档内部告警 + Slack 日报(FEAT-765;13/14 UTC 双触发、函数内只在纽约 09:00 做事) | **已落地**(#192 due 扫描切片,2026-10-09):任务名 `invoice-overdue-reminders`、每日 13:10 UTC 单触发。档位节奏(stage 1/7/30)刻意不搬——24h 再催与 approval/workflow 催办一致;Slack 日报不搬——业务提醒走通知域,Slack 通道留给 job 失败告警 |

## 表 B:issue #32 正文所列线上任务(旧时代任务名,2026-09-30 快照)

这些名字在老仓库当前迁移文件里已不存在(FEAT-043 调度重构时被合并/改名/停用),
线上库可能仍在跑(指向已被删除或换名的函数)。切换日以 `cron.unschedule` 逐个下线。

| 旧任务名 | 功能 | 判定 |
|----------|------|------|
| appointment-auto-status | 预约状态自动流转 | 由 #207 自建预约按新设计决定(2026-08-06 裁定已把会前提醒交给 iClosed 侧;大概率废弃) |
| auth-config-drift-check | Supabase Auth 配置漂移检测 | **废弃**(#34:自建认证后不再需要) |
| auto-extend-availability | 可约时段自动延长 | 随 #207 自建预约 |
| daily-backup | 数据库每日备份 | 随 #33 备份与恢复 |
| drain-slack-queue | Slack 发送队列 | 随 #115 Slack 集成(新系统直接 pg-boss 队列 + Slack API) |
| enroll-abandoned-bqa-leads | 半途 BQA 表单线索自动注册 | 随营销/获客域(M1) |
| enroll-abandoned-partial-leads | 半途线索表单自动注册 | 随营销/获客域(M1) |
| error-spike-alert | 错误激增告警 | 随 #28 错误追踪 |
| expire-stale-admin-status | 过期管理员在线状态清理 | 随后台用户 #26;新系统若不做 presence 则废弃(由 #26 设计定) |
| expire-stale-available-presence | 过期可用坐席状态清理 | 同上 |
| fx-rate-sync | 汇率同步 | = 表 A A7 |
| hubspot-dedup | HubSpot 重复项合并 | 并入 A14 hubspot-reconcile |
| hubspot-fetch-activities | HubSpot 活动拉取 | = 表 A A13(hubspot-fetch-activities-cron) |
| hubspot-garbage-email-scan | 垃圾邮件扫描 | 并入 A14 hubspot-reconcile |
| hubspot-orphan-reconcile | HubSpot 孤儿记录对账 | 并入 A14 hubspot-reconcile |
| hubspot-reconcile | HubSpot 对账 | = 表 A A14 |
| ingredient-batch-refresh | 原料价格/批次数据刷新 | 随原料价格域 #132/#149 |
| lead-scoring-ai | 单条线索 AI 评分 | 随 CRM 线索域 #227/#234 |
| nightly-lead-scoring | 每夜线索评分 | 随 CRM 线索域(同上) |
| ops-projects-to-orders | ops 项目批量转订单 | 随 #154 订单履约看板(新看板由事实驱动,大概率废弃,由 #154 设计定) |
| payment-linking | 支付平台回款关联 | 随 #183 收款归属(新系统改为 QB 银行流水认领,取代回调推断) |
| process-appointment-reminder-emails | 会前提醒邮件 | 2026-08-06 裁定废弃(iClosed 自带提醒);#207 自建预约上线后由 #207 恢复 |
| process-appointment-reminder-sms | 会前提醒短信 | 同上 |
| process-scheduled-emails | 定时邮件发送 | 并入 A1 outbox-dispatcher |
| process-scheduled-sms | 定时短信发送 | 并入 A1 outbox-dispatcher |
| process-email-sequences | 邮件序列推进 | 随邮件域 #131(功能后继:表 A A3) |
| process-signing-reminders | 签名提醒 | 随合同签署 #236(功能后继:表 A A10) |
| refresh-appointment-rooms | Daily.co 房间刷新 | **废弃**:Daily.co 已退役(老仓库 issue #133 跟踪,待最终确认) |
| resend-health-check | 邮件服务健康检查 | 随 #34 监控(worker 定时依赖检查) |
| stale-lead-check | 僵尸线索检查 | 随 CRM 线索域 #234(公海回收规则) |
| synthesize-email-style-guide | AI 邮件风格指南合成 | 随邮件域 #131 / AI 配置 #118 |
| twilio-call-sync | 电话记录同步 | 随 #125(回拨预约、未接来电) |
| purge-mcp-authorization-codes | 过期 MCP OAuth 授权码清理 | 随 #119 MCP server(issue #32 评论补充) |

## 切换手册(避免两边同时执行)

1. **新 worker 先上线并验证**:每个任务登记合入后,观察 `pgboss.job` 记录、worker 日志、
   Slack 告警通道(可先用 heartbeat 类任务验证告警链路)。
2. **逐个下线老任务**:对应任务在新系统验证后,在老库执行
   `SELECT cron.unschedule('<老任务名>');`,一次只下线一个,当天观察。
3. **观察期**:关键任务(发邮件/收款相关)建议交叉核对一周:老库 `cron.job_run_details`
   不再有新运行、新系统对应任务按点执行。
4. **切换日先实测**:`SELECT jobname, schedule, active FROM cron.job ORDER BY 1;`
   与本文两表对照——本文基于老仓库迁移 HEAD 与 issue 快照,线上可能有未入库的手工改动。

## 验收标准对照(issue #32)

- [x] 每个任务一行对照表:老任务 → 新任务 / 废弃原因 —— 即本文表 A + 表 B
- [ ] 每个任务有单元测试,关键任务有集成测试 —— **随各任务登记时交付**;框架本身已有
      单元测试(slack 告警器、消息格式)与集成测试(投递、重试+告警、cron 登记)
- [x] 失败会重试,并在 Slack 告警 —— 框架级实现:默认重试 3 次(60s 指数退避,可按任务
      覆盖),每次失败尝试发 Slack 告警(含 attempt/重试上限,重试耗尽标明 gave up);
      未配置 `SLACK_WEBHOOK_URL` 时降级为只记日志
