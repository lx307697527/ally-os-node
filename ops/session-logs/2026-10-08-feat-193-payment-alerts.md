---
session_id: hand-written-193-payment-alerts
branch: feat/193-payment-alerts
date: 2026-10-08
reason: issue-193
prompts: 1
unparseable_transcript_lines: 0
models: (zcode)
tokens_in: 0
tokens_out: 0
cache_creation_tokens: 0
cache_read_tokens: 0
thinking_blocks: 0
---

# Session log — feat/193-payment-alerts — 2026-10-08

> 机械层与判断层均为本次会话手写(ZCode 定时迁移会话,接续
> 2026-10-08-feat-193-paypal-channel.md 留下的剩余清单)。

## 机械层

- **引用的 issue**:#193(Stripe 在线支付发票,phase-2)剩余清单第 ③ 条
  「失败付款/对账拒绝的站内提醒」;PR 正文写 **Part of #193**,同时挂
  **Part of #192**(发票剩余清单第 2 条的尾巴:附加费对账拒绝的可见性
  同批进场)。#193/#192 均保持 open。
- **前置收尾(第 0 步)**:fetch 后无 open PR、无残留 worktree、主检出干净
  (origin/main 在 f0acfe1,即昨日 PayPal 渠道切片的 squash)。
- **选题**:①优先续做未完成切片。#193 剩余三项:①门户 E2E(部署面,本地
  做不了)、③站内提醒(通知域 + webhook 骨架已就绪)、退款事件(挂 #240)。
  选 ③——docs/billing.md 写明「老系统 Sentry/Slack 分流在新系统走通知域;
  附加费对账拒绝的可见性同批进场」,接缝齐全,可独立验收。
- **claim**:`claim_issue.py claim --issue 193 --ttl-minutes 120`,实现中途
  renew 一次。
- **数据库**:本地 postgres 可用,verify 全程带 DATABASE_URL:**122 文件 /
  1196 测试零 skip**(基线 121/1170,+1 文件 +26 测试)。

### 本切片改动的文件

- `packages/db/src/schema.ts` + `0034_daily_doctor_spectrum.sql`(expand-only):
  notifications.dedupe_key(text,nullable)+ `(user_id, dedupe_key)` 部分唯一
  索引——注释里预告的「老 (user_id, outbox_id) 唯一约束一并补列」的兑现。
- `apps/api/src/billing/payment-alerts.ts`(新):两渠道共用的告警内核——
  事件类型常量(payment.attempt_failed / payment.unbookable)、
  `invoiceAlertRecipients`(invoices.manage = owner/finance 角色默认 +
  user_permission 个人授权,去重升序)、`recordPaymentAlert`(逐收件人插行 +
  onConflictDoNothing,返回**真正拿到新行**的用户)、纯函数文案面
  (formatMoney/paymentAlertTitle/paymentAlertDetail/paymentAlertPayload,
  RULE-010 英文,句尾句号削平)、`unbookableReasonText`(502 拒绝码 →
  人类说明的共用词表)。
- `apps/api/src/billing/stripe.ts`:归一层新分支——`payment_failed` kind
  (FAILED_ATTEMPT_EVENT_TYPES 两个事件的消费:method 标签/拒绝词/金额/锚点,
  老系统 paymentMethodLabel/paymentRefusalReason 的移植 + 500 字符收口;
  externalId 缺对象 id 时退信封 id——失败事件没有幂等键死路)、unparsable
  富化(externalId/grossCents/currency/invoiceId 读得出多少带多少,喂告警)、
  payment kind 补 currency 字段。
- `apps/api/src/billing/paypal.ts`:unparsable kind 同样富化(capture id 读得
  出就带,重投的告警靠它去重)。
- `apps/api/src/routes/stripe-webhook.ts`:payment_failed 路径(带锚点 →
  告警即事件本体,写入成功才 200,写不进 502;无锚点 ack——老裁决 BUG-774
  只报带我们锚点的尝试);502 路径(unparsable/invalid 锚点/invoice_not_found/
  PaymentStateError)各挂一次尽力告警;文件头响应契约注释同步改写。
- `apps/api/src/routes/paypal-webhook.ts`:四条 502 路径(unparsable/
  invoice_not_found/PaymentStateError/capture_failed)挂尽力告警;deps 补
  notifyUsers;DECLINED/DENIED 维持既有 no-op(文件头写明理由)。
- 测试:`billing/payment-alerts.test.ts`(新,11:文案纯函数 6 + 集成 5——
  收件人解析含个人授权、dedupe 结构性幂等、状态演变新键、业务行不受部分
  索引约束)、`billing/stripe.test.ts`(+5:failed 归一四分支 + unparsable
  富化;改 1:失败事件不再 ignored)、`routes/stripe.test.ts`(+7:failed
  尝试全链/重投不重催/bank account 标签/无锚点不报/草稿钱 502→告警→confirm
  →重投记账/void+unknown/capture 拆分对不上带金额)、`routes/paypal.test.ts`
  (+2:草稿钱告警与重投/APPROVED capture 失败按订单去重)、
  `apps/worker/src/notifications/digest.test.ts`(+1:告警事实行进摘要)。
  两个路由套件的夹具补 notifications truncate + notifyUsers 记录器。
- 文档:`docs/billing.md`(「失败付款与记不了的站内告警」专节:两类告警/
  结构幂等/展示面裁决/PayPal no-op 理由;剩余清单第 2 条收口为部署面 E2E +
  门户发起面;附加费节的「随通知域进场」改为已落地)、`docs/notifications.md`
  (webhook-face producer 段:重投事实 + dedupe_key 纪律、不进白名单的裁决)。

## 判断层(手写)

### 关键判断

1. **「告警即记账」:响应契约按事件的本体收口,不按响应码表面统一**。
   payment_failed 事件在系统里唯一可观察的效果就是告警——ack 而告警没写进去,
   等于把「客户付不了款」这条事实扔进垃圾桶(BUG-774 的原教训:客户开口才是
   发现渠道)。所以失败尝试路径:告警写入成功才 200,写不进 502 让 provider
   重投。而 502 的钱路径相反:响应必须是 502(拿不准的钱不确认,钱的契约
   不动),告警退化为尽力面——写不进只记日志,provider 的重投会带着同一把
   dedupe_key 重试告警写入,最多少一行提醒,钱的事实一个不少。老系统的
   never-throws alerter 是对外部 Slack/Sentry 的妥协;本地 DB 写 + 重投重试
   让两条路径都能比「尽力而为」更强。

2. **重投去重是结构问题,不是查询问题**。provider 对非 2xx 的重投是常态:
   草稿票上的重投每几小时一次、连发数天——没有幂等键,每次重投都是一行新铃铛
   噪声,告警面自己变成要被静音的通知。dedupe_key + (user_id, dedupe_key)
   部分唯一索引 + onConflictDoNothing,重投 = 「已提醒过」,与 payments 的
   source 唯一索引同一纪律(由结构保证,不靠先查后插)。两个次级裁决:
   拒绝码进键——状态演变(草稿→作废)是新事实值得新提醒,压键会把「票被作废、
   这笔钱永远记不进来了」藏进静音区;催只催拿到新行的人——重投的既有收件人
   已经看过那条铃铛,再催一次是噪声。schema.ts 注释里预告的「老 (user_id,
   outbox_id) 唯一约束一并补列,expand-only」正是这把钥匙,本切片是它的
   第一个消费者。

3. **两种事件类型刻意不进 web 铃铛白名单**。href parity 测试强制白名单事件
   的去处是真实路由——它的存在就是为了抓「深链静默落进 catch-all」的真 bug;
   而发票页(#192 剩余④)还没落地。给白名单塞 href: null 就要削弱这个守卫,
   守卫是为语义服务的,不该为文案让路。payload 携带 title/detail 事实走兜底
   面(approval.completed/rejected 的同款裁决:诚实的占位),digest 的
   payloadDetail 读同两个字段自动带走,web 端零改动;发票页落地时白名单 +
   深链一次进场(docs/billing.md 剩余清单已挂账)。

4. **收件人跟着权限矩阵走,不写死角色列表**。invoices.manage = owner/finance
   角色默认 + user_permission 个人授权(permissions.ts 的矩阵注释明说 admin
   刻意不持有)。告警收件人解析双查询(角色 + 授予)而不是 effect-digest 的
   单查询——effect-digest 的语义本来就是「老板和销售主管」两个角色,而告警
   的语义是「持票权」,两个词在矩阵里恰好不同构。没改 permissions.ts:读面
   的解析是消费方自己的事,矩阵不动。

5. **PayPal 的失败尝试(DECLINED/DENIED)维持 no-op,不猜载荷**。Stripe 的
   两个失败事件在老系统有完整的读法参照(paymentMethodLabel/
   paymentRefusalReason 可移植);PayPal 的失败类事件形状在老系统**没有
   webhook 参照**(老系统 capture 走门户回跳页),zod schema 写不出来——
   「Validate every external input with zod」的前半句是先有可信的形状知识。
   留在既有裁决里(显式 no-op 注释),文档写明进未来的路:随真实载荷样例进场。

6. **失败事件的 externalId 兜底信封 id,与钱路径的 unparsable 是刻意不对称**。
   钱的幂等键必须挂在对象上(completed + succeeded 双发归一),读不出对象 id
   只能 unparsable(502);失败事件的键只服务于告警去重,退到信封 id 仍然
   稳定(重投同一信封),「读不出」的死路不存在——事件形状坏到这个地步时,
   它至少以一行「说不清的失败」的形态被看见。

### 踩的坑

1. **drizzle `select({ n: count(*) })` 返回的是「一行」的数组**,`.length`
   恒为 1——count 断言要 `Number(rows[0]?.n ?? 0)`。测试里顺手写了
   `(await db.select({n: count}).from(t)).length` 还等于 2 的期望,当场被
   断言抓住,收口成 `notificationCount()` 助手。

2. **向测试文件中部插入 describe 块,把外层 describe 提前闭合了**:misconfigured
   测试成了孤儿,解析错误报在文件末尾(783 行)而不是插入点——oxc 的报错
   行号只告诉你括号在哪失衡,不告诉你在哪多塞了一层。教训:往长测试文件
   中部插结构,插完先看插入点前后各一屏,别只看报错行。

3. **exactOptionalPropertyTypes 不收 `method: undefined`**:测试里想表达
   「method 缺位」,对象字面量带 undefined 值直接类型错;`delete obj.method`
   (optional 属性可 delete)是这仓库的通行写法(上一会话踩过
   no-dynamic-delete——computed key 才是禁区,点名声明的 delete 没事)。

4. **eslint dot-notation 管测试的 payload 索引**:payload["title"] 15 处
   报错,`pnpm lint --fix` 全部机械修掉——verify 的顺序是 lint 在前,先
   --fix 再跑全量,别手改。

5. **Windows Git Bash 无 psql**(环境账,与上一会话同):DB 可用性检查改跑
   一个已有的小集成套件(notifications.test.ts)代替 `psql -c "select 1"`。
