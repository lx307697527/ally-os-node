---
session_id: hand-written-224-email-action
branch: feat/224-email-action
date: 2026-10-07
reason: issue-224
prompts: 1
unparseable_transcript_lines: 0
models: (zcode)
tokens_in: 0
tokens_out: 0
cache_creation_tokens: 0
cache_read_tokens: 0
thinking_blocks: 0
---

# Session log — feat/224-email-action — 2026-10-07

> 机械层本次由 agent 手写(ZCode 定时迁移会话);判断层为本次会话手写。

## 机械层(自动)

- **引用的 issue**:#224 剩余项 1「动作类型扩展:发邮件(随 #116 统一通道)」
  ——**send_email 动作切片**。PR 正文写 Part of #224(短信/webhook/改字段/
  报名序列/AI 步骤、条件积木、效果度量等剩余项仍在,严禁 Closes)。
- **前置收尾(第 0 步)**:无 open PR、无残留 worktree、主检出干净;fetch 后
  origin/main 顶端 46362ae(#290,本地 main 落后一拍,worktree 从 origin/main
  开出,不受影响)。
- **选题**:①优先续做有未完成切片的 issue。候选盘点:#116 剩余全等 #115/
  共享 face 包;#219 剩签名墙承载页;#220 剩首模板等消费域;#221 剩金额域
  首接线;#222 form builder 面对空注册表;#225 剩 Superset 部署面与模板管理
  (后者依赖 #128 PDF 服务,未动工);#233 剩周报/cron 接线随消费域。**#224
  的邮件动作是唯一刚被 #281(#116 渠道层,`@ally/mailer` 沉为共享包)解锁、
  又不依赖未进场域的切片**,按续做优先选它。
- **老系统参考(只读)**:ally-os 的邮件 = comms 层统一传输(`_shared/resend.ts`,
  「transport ONLY,内容是调用方策略」的平移规矩)+ core.outbox →
  outbox-dispatcher 的重试;业务侧(如 signing-reminder-cron)只解析收件人、
  自己不碰邮件代码(issue #1334 明裁「提醒投递 ride the comms layer」)。新系统
  对应物:`@ally/mailer` 是传输接缝,重试由 pg-boss + action_results 承担——
  **自动化不需要第二套传输,只需要一个新的动作类型**。
- **数据库**:本地 docker postgres 可用,verify 全程带 DATABASE_URL(无 skip)。

### 本切片改动的文件

- `packages/automations/src/index.ts`:`sendEmailActionSchema`
  (userIds 1..50 / subject 1..200 / body 1..5000,收件人是站内用户的 uuid
  白名单)进动作 discriminated union——API 保存面与 worker 运行时同一份
  schema,零 migration(动作是 jsonb 开集,扩展不改表)。
- `apps/worker/src/automations/actions.ts`:`executeSendEmail`——按 id 解析
  `auth_user.email`、去重、逐人一封、`@ally/mailer` 传输;正文纯文本转义成
  HTML(escapeHtml + `\n`→`<br>`,规则名同判)、text 从 html 推导
  (htmlToPlainText)、尾注署名规则;收件人缺失抛错进重试协议。ActionDeps/
  ActionServices 增 `mailer`。
- `apps/worker/src/automations/runner.ts`:分发从 ternary 链改为**穷举
  switch**(漏派执行器 = 编译期「使用前未赋值」)。
- `apps/worker/src/automations/index.ts` + `apps/worker/src/index.ts`:
  worker 引导把既有 mailer 实例注入 automationJobs(与通知摘要同一实例)。
- `apps/web/src/shared/lib/automations-client.ts`:ActionDraft 联合 +
  actionToDraft + buildActions 的 send_email 结构化编辑(明显坏提交挡线下,
  服务端 zod 仍是唯一权威)。
- `apps/web/src/shared/pages/Automations.tsx`:类型选择器新选项、编辑器三件
  (收件人/主题/正文,第一段文案把收件人裁决说在前头)、ActionCard 展示分支。
- 测试:包形状矩阵 2 例(worker 集成 4 例:端到端含转义/去重/无通知行、
  收件人缺失 fail loud、at-least-once 重试重复、+due-scanner 夹具注桩)、web
  client 往返 1 例、页面源码纪律 1 例。
- `docs/automations.md`:「send_email 动作」专节(收件人/传输/投递语义/不进
  审计四条裁决)+ 剩余项 1 改写(邮件已落,短信等 SMS 通道)。
- 无 API 路由改动(保存面由共享 schema 自动收口)、无迁移、无新 env。

## 判断层(本次的关键判断与踩的坑)

1. **选题判断:续做切片选「刚被解锁」的,不选「还在等依赖」的。** 十个
   open issue 都带未完成切片,但多数剩余项的真实依赖(#207/#227 消费域、
   #128 PDF、#115 Slack、#206 受监管门)未进场——硬做就是空转复杂度。#224
   的邮件动作被 #281 精确解锁(`@ally/mailer` 已是共享包,worker 已有实例),
   是当下唯一「依赖齐、边界清、可独立验收」的切片。选题先看依赖图,再看
   编号顺序。
2. **收件人裁决:站内 userIds,不收任意外部地址。** 与 notify 的「保存时
   点死 uuid 白名单」同裁:自动化无人值守地发信,任意外部地址入口等于给
   规则作者一条从公司域名发出的、不经审批的邮件通道;对外邮件的正当入口是
   属主域写路径(报价/订单)与 #237 的营销审批面。代价是「自动化邮件客户」
   这类需求被挡——那是刻意的,等真实域进场走自己的写路径。
3. **投递语义 at-least-once,与铃铛 at-most-once 刻意相反。** 便宜的加速器
   可以丢(通知行是真相),付费的真信不能凭空消失。重复窗口 = 部分失败后
   重试时失败点之前的收件人 + 动作事务回滚的极端情形;测试把「第一封成功、
   第二封失败、重试后第一人两封」钉死,文档明说——不装 exactly-once。
   老系统的 Idempotency-Key 头是传输层去重,Resend API 在这里不承担,语义
   由 action_results 的幂等闸给(动作行存在 ⟺ 已提交)。
4. **runner 分发改穷举 switch 是顺手补的洞,不是重构。** 原 ternary 链的
   `else` 会静默吞掉未来新动作类型——执行器没接上就静默漏派,run 显示
   succeeded 但动作没跑,这类 bug 最难被发现。穷举 switch 让「联合进新成员
   而分发没接」变成编译错误。改动局限在分发行,不碰重试/锁协议。
5. **邮件不写审计、不进通知表、不吃通知偏好。** 发送事实在 action_results
   (与 notify「通知行即台账」同裁);通知偏好轴(#116)管的是通知域的分渠,
   send_email 是规则作者的直接点名,混进偏好轴会让「为什么没收到」变成
   两个系统的相互推诿。审计词表零新增。
6. **坑:共享 deps 形状进花的两个测试夹具。** ActionDeps 加 mailer 后
   automations.test.ts / due-scanner.test.ts 编译错——预期内(due-scanner
   只执行 due 规则不发电邮),注桩 `send: () => Promise.resolve()` 即可;
   这也验证了「依赖注入让测试不用真 SMTP」的设计意图。
7. **零迁移、零新路由、零新 env 的切片也要写全文档。** docs/automations.md
   的四条裁决(收件人/传输/at-least-once/不进审计)是后续短信、webhook
   动作的判例——下一个动作类型的作者应该从这份文档读出「外部副作用类动作
   的语义怎么定」,而不是从代码反推。

## 验收对照(本切片范围)

- [x] 「动作:……发邮件或短信」的邮件半边——send_email 进动作联合,保存面
      zod 收口、worker 执行、runs 留逐动作结果,端到端集成测试覆盖
- [x] 「动作通过 pg-boss 执行,可重试、可观测,失败告警」对邮件动作同样成立
      (复用 runner 重试协议,失败抛给 pg-boss、每次尝试告警、重试只补失败动作)
- [ ] 短信/webhook/改字段/报名序列/AI 步骤(剩余项 1 其余半边)
- [ ] 条件积木注册表、效果度量、#134 逐域迁移(#224 保持 open)

测试:`DATABASE_URL=… corepack pnpm verify` 全绿 105 文件 / 902 测试
(基线 105/895,+7:包 2、worker 集成 3、web client 1、页面纪律 1;
due-scanner 夹具随 ActionDeps 形状注桩,不新增用例);docs/automations.md
send_email 专节;session log
`ops/session-logs/2026-10-07-feat-224-email-action.md`。
