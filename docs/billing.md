# 发票内核（#192）

设计权威：#232 §10「模块五 财务」——「所有发票由系统出草稿，**财务确认后才发出**」
（R-12-6）；尾款按批开票（R-11-6）；金额按整数分计算。issue：#192（发票草稿 +
财务确认），所属模块 #190（M5 财务）。

老系统对照：`billing.*`（20260724143856_billing_core.sql）——发票靠手工创建/拆期
（#88），`amount_due numeric(14,2)` 快照列；行合计 `total_price` 是 SQL 生成列（本
内核沿用这一裁决）。收款对照 `billing.payments` + `record_payment_atomic`
（20260724181634）——`UNIQUE(provider, external_id)` 幂等、到账自动推进
invoice_status（draft 跳 sent、按 SUM 落 paid/partially_paid）。

## 已落地:发票内核(切片 1)

### 数据模型(packages/db/src/schema.ts,0029)

- **`invoices`**:`invoice_type` 枚举(七个触发点命名的类型:deposit / balance /
  sampling_fee / flavor_dev / label_design / storage_fee / customer_material——
  「等」出现时 expand 新值,不建杂项桶)、`invoice_status` 枚举(刻意三态:
  draft / issued / void)、`currency`(列先落地,当前唯一合法值 USD——R-13-7
  销售税暂不征收,多币种无消费方)。
- **多态锚点** `subject_type`/`subject_id`(tasks.subject 同裁,text 不用枚举):
  产生发票的业务事实(报价/订单/批次/打样确认…),属主域逐个进场;手工票两列
  皆 null。
- **触发点幂等**:(source_type, source_key) 唯一索引——#192 验收第 6 条「同一
  触发事件不会重复生成草稿」由结构保证,不靠先查后插。键由属主域给(如
  `("quote_accepted", "<quoteId>")`);重复投递映射 409 `invoice_exists`,手工票
  (null, null) 不受约束(PG NULLS DISTINCT)。
- **`invoice_lines`**:`quantity numeric(12,3)`(三位小数,工时/称量)、
  `unit_price_cents integer`(整数分)、**`line_total_cents` 是生成列**
  `round(quantity * unit_price_cents)`(PG numeric round = half away from zero,
  金额非负即四舍五入),应用读不写;`line_number` 由写入侧按提交顺序 1..n 落
  (行没有身份键,顺序即语义——报价行文顺序是商业文件的一部分,uuid 随机序
  不能当行文序)。空票不存在(老 bug500 在创建面收口:lines 至少一行)。

### 三个金额裁决

1. **整数分贯穿**(#192 要点):API 面只有 `unitPriceCents`(整数分)与三位小数
   `quantity`;zod 收口(quantity ≤ 三位小数、行合计 ≤ int4 生成列边界),服务端
   是唯一权威(RULE-007),客户端不提交金额合计。
2. **行合计是生成列,发票合计不落列**:读面实时 `SUM(line_total_cents)`。
   老系统 `amount_due` 快照与行漂移一类的缺陷(bug554 家族)在表结构上不可能
   存在——行是唯一真相,draft 阶段随便改,发出后行锁定,合计恒定。
3. **取整语义**:half away from zero(PG numeric round),0.005 分边界有集成
   测试钉住。

### 状态机与动词

```
draft ──confirm(finance)──▶ issued        draft ──void(finance)──▶ void
```

- **draft**:行可整体替换(PATCH;与现行逐位相同则幂等返回不留审计——
  「审计只记真变更」纪律)。发出后的票不可改:更正/贷项(红冲)是 #192 后续
  切片的**新动词**,不改写已发出的行(与 esign「签后记录锁定」同一底线,发票
  面靠状态机而非签名)。
- **issued**:财务确认(R-12-6「确认后发出」),记 issued_at/issued_by。重复
  confirm 幂等返回 `already`,审计不落第二行(no-op 不写审计)。
- **void**:只对草稿(作废 = 行随 CASCADE 留存,票可查不可用);issued 票
  409 `not_voidable`;重复作废幂等。
- **付款态不 expand 进 invoice_status**(0023 注释里的预告被收款切片推翻,
  裁决见下「收款内核」):invoice_status 只回答「单据走到哪一步」,「钱收了
  多少」是收款台账对实时 SUM 的回答。**给客户的**到期前提醒(R-12-7 前半)
  随客户门户与渠道层接线——没有收件人的邮件不存在;逾期的内部提醒(财务
  人工催的路标)已随 due 扫描落地,见下「发票到期日与逾期扫描」。

### 权限:`invoices.manage`(finance / owner)

发票全生命周期(手工建草稿、改草稿、确认发出、作废)在这一个权限点后面
(#232 §12 财务「确认发送发票」+ 老板「全部查看」)。三处刻意不在权限点后面:

- **触发点的系统生成**:属主域(打样确认 #238 / 报价接受 #231 / 批次完工
  phase-4)在自己的业务事务里调 `billing/service.ts` 的 `createDraftInvoice`
  ——草稿与触发事实同事务生灭,有没有权生成由触发点自己的业务门裁决;
- **销售的记录级可见**(「只看自己单子的发票」):随订单域(#231)的可见性门
  进场;
- **admin 不默认持有**:管理员是分配权限与配置工作室的角色(§12),发票是业务
  单据;要持有时走授权(授 finance 级需老板确认,R-16-6)。

### 编号:第一个生产注册(numbering subject `invoice`)

`billing/registry.ts` 在 app.ts 模块装载时把 invoice 注册进编号注册表(#225
留下的口子自此闭合)——配置面 `/system/numbering` 的 subjects 下拉亮起
Invoice。创建事务里 `allocateDocumentNumber(tx, "invoice")`;**无生效规则 =
创建失败**(fail closed,HTTP 映射 409 `numbering_not_configured`:没有编号的
单据不存在,修复动作是去配置工作室建规则,不是 500 的配置事故)。

**时区裁决**(numbering/service.ts 注释预留的「随第一个真实消费方一起定」,
本切片收口):**维持 UTC**。日期段只服务号串的人读性(INV-202610-1000 的月份
标签),不承载会计期间语义;+8 时区月初 8 小时的标签偏移在「号串可读」这个
用途下无业务后果。将来出现真实按期出账需求时,经 `@ally/config` 注入时区,
注册与分配内核不动。

### 审计词(docs/audit.md 同步)

`invoice.created`(detail: number/invoiceType/subject·source 引用/lineCount/
totalCents)、`invoice.updated`(fields:["lines"] + lineCount/totalCents,no-op
不落)、`invoice.confirmed`(number/totalCents——财务确认的金额快照;带账期时
加 dueInDays + dueAt)、`invoice.voided`(number/totalCents/reason?)。

## 端点

| 方法与路径 | 门 | 语义 |
| --- | --- | --- |
| `POST /api/invoices` | invoices.manage | 手工建草稿(老系统的过渡面);body 含 source 字段与属主域触发同形 |
| `GET /api/invoices?status=` | invoices.manage | 列表(含 totalCents;财务「待确认发票」主读法) |
| `GET /api/invoices/:id` | invoices.manage | 详情(头 + 行 + totalCents) |
| `PATCH /api/invoices/:id` | invoices.manage | 草稿换行(整体替换,行序即语义);仅 draft |
| `POST /api/invoices/:id/confirm` | invoices.manage | draft → issued;幂等;可选 `dueInDays`(0–365)→ 服务端算 dueAt(R-12-7) |
| `POST /api/invoices/:id/void` | invoices.manage | draft → void(可带 reason);幂等 |

404 用于票不存在(反探测,与任务详情同裁);409 用于「票在但状态不允许」
(`invoice_exists` / `numbering_not_configured` / `not_draft` / `invoice_voided`
/ `not_voidable`)。

## 已落地:收款内核(切片 2)

设计权威:#232 §10「Stripe / PayPal 以 webhook 为准,幂等记账并自动匹配发票」;
付款方式三种(R-12-1,不收支票)。issue 位置:#192 剩余第 2 条「收款与 paid 态」;
webhook 消费面是 #193。

### 数据模型(packages/db/src/schema.ts,0032)

- **`payments`**:`payment_method` 枚举(card / paypal / wire_ach)、
  `amount_cents` 整数分、`currency` 从发票行抄录(收款行自描述,#181 QuickBooks
  推送的路标)、`received_at`(钱实际到账的时刻,电汇可能是昨天到的;不未来)、
  `note`(电汇流水号等)、`recorded_by_id`(手工记账是财务本人;webhook 记账
  null)。
- **source 幂等与发票同构**:(source_type, source_key) 唯一索引——webhook
  重放在结构上只可能有一行;手工记账两列皆 null 不受约束(PG NULLS DISTINCT)。
- **void 三列**(voided_at/voided_by_id/void_reason):钱行永不 DELETE/改写,
  误录用 void 更正(SUM 剔除、审计留痕);退款是 #240 的独立流程(原路退回),
  不是对本行的冲销。

### 两个核心裁决(与老系统刻意差异)

1. **付款态是派生值,不落 invoice_status**。`computePaymentStatus(total, paid)`
   (billing/payments.ts)是唯一权威定义:paid(含超收)/ partial / unpaid;
   total = 0 的票 vacuously paid(没有可收的钱,财务不追 $0 的票)。两个输入
   各自结构性无漂移(行合计是生成列、发出后行锁定;收款行只增不删),落列则
   每个写方都得记得重算——漏一个写方就是一条卡在「paid」的发票,财务会信它
   (老 bug554 快照漂移家族的收款版)。门槛跨越的「事实」由 `payment.recorded`
   审计的 `paymentStatus` 携带;#241 发货门槛等消费方读同一个函数,不各算各的。
2. **到账不推进发票状态**。老系统 `record_payment_atomic` 收到款把 draft 票
   自动跳 sent 再落 paid;本系统财务确认(R-12-6「核对后发出」)是人的闸门,
   到账不替财务放行——draft/void 票记账 fail closed(409 `not_issued` /
   `invoice_voided`),webhook 靠 provider 重试等财务确认(老系统「未知发票
   返回 NULL 让 provider 重试」同一去向,只是多分了两种可读码)。

### 权限与 webhook 接缝

全部在 `invoices.manage` 后(finance/owner,#232 §12 财务「认领收款」)。跨票
的收款总览与「待认领银行流水」随 #181 进场。**#193 的 webhook 不走 HTTP 面**:
验签 + 规范化后在自己的业务事务里调 `billing/payments.ts` 的 `recordPayment`
传 source(如 `("stripe", "<event_id>")`);`PaymentExistsError` 对 webhook 是
「重放,已记账成功」(吃掉回 2xx),对 HTTP 面映射 409。

锁纪律:recordPayment / voidPayment 都先锁发票行再动钱——同票动词串行,审计
里记账后的付款态是精确值,不依赖隔离级别的善意。

## 端点

| 方法与路径 | 门 | 语义 |
| --- | --- | --- |
| `POST /api/invoices/:id/payments` | invoices.manage | 记一笔款(手工;webhook 走服务接缝);409 `not_issued` / `invoice_voided` / `payment_exists` |
| `GET /api/invoices/:id/payments` | invoices.manage | 一张票的收款台账(totalCents/paidCents/paymentStatus + 行) |
| `POST /api/payments/:id/void` | invoices.manage | 作废误录(reason 必填);幂等 `already` |

发票读写面(列表/详情)随本切片带 `paidCents` + `paymentStatus`(列表合计按
票分组两次查询取齐——drizzle 在 sql`` 模板里渲染不带表限定的裸列名,相关
子查询会被内层表影子化,实测 total 恒 0,故不用)。付款态错误码:409 表示
「票/款在但状态不允许」,与发票端点同一约定。

## 已落地:Stripe 渠道(#193)

设计权威:#232 §10「Stripe / PayPal 以 webhook 为准,幂等记账并自动匹配发票」;
付款方式信用卡走 Stripe(R-12-1)。issue:#193;记账本体是上节的 recordPayment
接缝,本渠道是它的第一个消费方。

### 渠道内核(billing/stripe.ts)

- **无 SDK,fetch 适配器**(mailer 同裁):`StripeGateway` 是域内接口,生产实现
  POST 表单到 `checkout/sessions`,响应 zod 校验;测试注入假网关。一个调用不值得
  引入 SDK 依赖,业务代码不见 HTTP 细节(AGENTS.md「依赖注入、无厂商锁定」)。
- **先验签后解析**(老系统同一铁律):HMAC 只对原始字节有意义,先 parse 就给了
  「改字段带旧签名」的口子。`Stripe-Signature` 的 HMAC-SHA256 用 node:crypto
  常数时间比较,密钥轮换的多 v1 候选任一命中即过;300 秒重放窗双向拒绝
  (垃圾时间戳 NaN 用正向提问 `<= window` 读成「不新鲜」,fail closed 方向,
  老系统同款注释)。
- **金额无客户端入口**(#193 验收「篡改金额被拒」的结构性答案):checkout session
  的金额 = 发票行实时合计(发出后行锁定),币种从发票行抄录;webhook 记的金额 =
  事件里的 `amount_received ?? amount_total`(Stripe 签过名的银行事实)。全程
  没有一个字段叫「客户端提交的金额」。
- **幂等键 = payment_intent ?? 对象 id**:completed 与 succeeded 对同一笔钱各发
  一次,externalId 归一到 PaymentIntent(银行借记无 intent 回退 session id),
  第二发撞 `payments_source_idx` → `PaymentExistsError` → 200「已记账成功」。
- **事件信封 zod 收口**:paid 事件缺可信整数金额 / 缺外部 id → unparsable(502,
  拿不准的钱不确认);metadata 缺 invoice_id → 200 ack(不是本系统建的 session,
  认领面随 #181 进场);invoice_id 非 UUID(有人在 Stripe 侧动过元数据)→ 502 响。
  失败类(async_payment_failed / payment_failed)与退款类(refund.*,#240 流程)
  显式 no-op。

### 端点与响应契约

| 方法与路径 | 门 | 语义 |
| --- | --- | --- |
| `POST /api/invoices/:id/stripe-checkout` | invoices.manage | 给已发出的票建支付链接(财务过渡面);409 `not_issued` / `invoice_voided` / `nothing_to_collect`($0 票无可收);渠道未配置 500 `misconfigured` |
| `POST /api/webhooks/stripe` | Stripe-Signature 验签 | provider 面,挂在会话中间件**之前**(Stripe 无本系统会话,验签即认证);POST-only 405 |

checkout 的 success/cancel 回跳 = `${WEB_APP_URL}/portal/invoices/:id`,成功带
`{CHECKOUT_SESSION_ID}` 占位符;**付款状态以 webhook 为准,回跳页只做提示**
(#193 要点原文)。WEB_APP_URL 随渠道启用成为必配(@ally/config 成对校验,Google
同裁:只配一个启动即失败)。

webhook 响应契约(Stripe 按非 2xx 重投):

- **200** `received: true`——记账成功 / 幂等重放 / 无关事件 / 无锚点入账;
- **502**——钱到了但这边记不了:票未确认(`not_issued`)、已作废
  (`invoice_voided`)、找不到(`invoice_not_found`)、事件读不出可信金额。
  **绝不 2xx 确认记不了的钱**——确认一次,Stripe 永远不再投,这笔钱就丢了;
  502 让 provider 重试,等财务确认(R-12-6 人的闸门,webhook 靠重试跨过它)。
  集成测试钉住整条链:草稿票 502 → confirm → 重投 200 paid。

审计与记账**同事务**(webhook 面):recordPayment + `payment.recorded`(actor
null,detail 带 `eventType`)一个 commit——「钱记了、审计没了」的中间态不存在,
重投从原点重来。财务面的手工记账(现有端点)审计在事务外,行为不变。

### 门户与渠道的分工(现状)

客户门户(M1 #186)还没有登录身份与发票归属映射(发票 → 客户要等订单域 #231
给出 subject 锚点),「支付他人发票被拒」的归属门随门户面进场;本切片
把同一条服务路径先开给财务(invoices.manage)——财务确认后把链接发给客户是当下就成立
的收款动作。门户将来复用同一 `StripeGateway`,不新增第二套建会话的路径。

## 已落地:附加费拆分(R-12-2/3,#193 切片)

设计权威:#232 §10 参数表「信用卡与 PayPal 附加费 3.9% ⚠(管理员可调)」+ §4.8
风险登记(3.9% 可能超卡组织 3% 规则与个别州上限,业主知情维持,种子行
`risk_note` 同文)。老系统对照 FEAT-581(supabase/functions/stripe-webhook 的
splitSurchargedCapture + billing.card_payment_policy):对账纪律原样带过来,
费率存储换规则注册表(#233 的 registry_rules,不再单设 policy 表),告警分流
(Sentry/Slack)刻意不带——失败付款站内提醒随通知域进场(已落地,见下
「失败付款与记不了的站内告警」节)。

### 三个裁决

1. **发票面金额不变**:费在 checkout 加收、结账前向客户披露,绝不写进发票行。
   `payments.amount_cents` 保持「这笔款结清多少」的唯一语义,附加费单列
   `surcharge_cents`(0033,expand-only;NULL = 无附加费,CHECK 拒 0——「没有」
   与「算了 0」两态不可并存)。paid 派生、#241 发货门槛、#181 QuickBooks 全部
   只读 amount_cents,没有一个读法需要学会扣费(老系统 migration 原话:五个
   投影都得学会减费是 FEAT-550 形状的坑)。
2. **拆分只能在 session 创建时算好,搭 metadata 回来**:Stripe 事件只报一个
   总数,principal/fee 拆分是我们自己的算术。webhook 端四种命名拒绝
   (billing/surcharge.ts,老系统同名测试全部随行):无拆分键 = 存量普通会话
   (gross 即 principal,回归锚点);拆分 ≠ 实扣额、半申报、非正整数 → 502
   拿不准的钱不确认——「两个数字必有一个是错的而这里无法分辨」。
3. **费率先量化到基点再整数运算**:`computeSurchargeCents` = round(principal ×
   bp / 10000),两位小数的百分比是费率的定义精度,中途不出浮点金额。

### 费率面

- `payments.card_surcharge_pct`(0021 种子 3.9%,param,管理员可调,⚠);
  PayPal 渠道读自己的 `payments.paypal_surcharge_pct`(同种子同裁法),两键不共用。
- 消费方 zod 收口 0–5%(surchargeRateSchema):机械护栏拦配置事故,不是业务
  裁决——真要超 5% 先过配置工作室,再放宽消费方。读不出(未种/待填/出界)
  → checkout 409 `surcharge_rule_unusable` fail closed(numbering_not_configured
  同一先例:修复动作是去配置工作室,不是 500 的配置事故)。
- **0% = 管理员关闸**:session 与存量无附加费会话完全同形(不写拆分键)——
  「关掉」由「会话形状」承载,webhook 无需知道开关存在。

### 端点与契约变化

| 面 | 变化 |
| --- | --- |
| `POST /api/invoices/:id/stripe-checkout` | 响应 `amountCents` 改为实扣 gross,另带 `principalCents`/`surchargeCents`;审计 `invoice.payment_link_created` 同构(实扣额 + 拆分快照) |
| `POST /api/webhooks/stripe` | 拆分对账:metadata 两键齐全且 principal+surcharge = 实扣额才入账,否则 502 |
| `GET /api/invoices/:id/payments` | 台账行带 `surchargeCents`(null = 无附加费) |
| 手工记账 `POST /api/invoices/:id/payments` | **不变**:电汇/ACH 无费;附加费无手工入口(它来自签名 metadata 的对账,不是人填的字段) |

## 已落地:PayPal 渠道(#193)

设计权威:#232 §10「Stripe / PayPal 以 webhook 为准,幂等记账并自动匹配发票」;
付款方式 PayPal 走 R-12-1 枚举。issue:#193;记账本体与 Stripe 完全同一个
recordPayment 接缝,source = ("paypal", "<capture id>"),method `paypal`。

### 渠道内核(billing/paypal.ts)

- **无 SDK,fetch 适配器**(StripeGateway 同裁):`PayPalGateway`(订单创建 +
  capture)与 `PayPalWebhookVerifier`(活体验签)是域内接口,生产实现走 PayPal
  REST API(client-credentials 令牌逐调用取,老系统同款,webhook 体量下不做过期
  缓存),响应 zod 校验;测试注入假 API。
- **验签是活体 API 调用,不是本地 HMAC**:PayPal 没有 Stripe 式共享密钥签名方案,
  防伪靠 server-to-server 的 verify-webhook-signature(五根 transmission 头 +
  webhook_id + 原事件,`verification_status` 必须 SUCCESS)。缺 transmission 头
  401;token/verify 失败或非 SUCCESS 401 fail closed;配置缺失 500 misconfigured
  (FEAT-063 同裁)。**本地没有重放窗**:transmission_time 的新鲜度由 PayPal 验签
  端把守,本侧重放防线是记账幂等(payments 唯一索引)。
- **锚点与拆分声明坐 `custom_id`**(老系统 FEAT-581 p5 载体裁决原样带过来):
  capture 事件只回带 purchase_units[0].custom_id,items[] 活不到 capture 上;
  purchase_units[].invoice_id 被 PayPal 按商户全局唯一校验(DUPLICATE_INVOICE_ID
  拒绝重试)——能拒绝第二次尝试的载体不是载体。格式 `<invoiceId>`(无费)/
  `<invoiceId>;p=<principal 分>;s=<surcharge 分>`(有费);声明解析成 Stripe
  metadata 的同两个键后**原样走 splitSurchargedCapture**——四种命名拒绝与
  Stripe 渠道一字不差(无声明 = 存量/无费订单的回归锚点;拆分 ≠ 实扣、半申报、
  非正整数 → 502 拿不准的钱不确认)。
- **金额十进制字符串精确换算**:PayPal 金额是 "1558.50" 一类的字符串,老系统
  `Number(value) * 100` 浮点乘法刻意不带过来——正则拆整数/小数部做纯整数运算
  (payPalAmountToCents),"8.45" 一类二进制不可精确表示的值不会产生先舍入再比较
  的隐患;0–2 位小数之外形状一律 unparsable(502)。
- **退款/拒绝类显式 no-op**:PAYMENT.CAPTURE.REFUNDED / REVERSED(#240 流程)、
  DECLINED / DENIED(没有钱进账)ack 掉不拦投递。

### 批准 ≠ 扣款:webhook 驱动 capture(billing/paypal.ts 文件头第 3 条)

PayPal 订单要商户显式 capture 钱才动。老系统在门户回跳页由服务端 capture
(BUG-121);本系统门户还没建(#186),渠道必须能独立走完真钱闭环,故改为
**webhook 驱动**:收到(验签过的)CHECKOUT.ORDER.APPROVED 后按订单 custom_id
找回发票——票处于 issued 才 capture;找不到/草稿/作废一律**不 capture、ack 了事**
(订单自然过期,客户没被扣款——fail-safe,不是失败,不需要 502 重投一个「正确
动作是什么都不做」的投递);capture 网络失败回 502 让 PayPal 重投 APPROVED
(重投窗口约 3 天,订单有效期同量级,自然收敛);ORDER_ALREADY_CAPTURED 是
APPROVED 重投的正常重放,ack。capture 成功后钱的事实仍由
PAYMENT.CAPTURE.COMPLETED 入账——与 Stripe 同一条记账路径,审计 `payment.recorded`
(actor null,method `paypal`,detail 带 `eventType`)与记账同事务。

这也兑现 #193 要点原文「**付款状态以 webhook 为准,前端结果只用于提示**」:
门户回跳页(`?paypal=return|cancel`)永远只展示,永远不 capture。

### 费率与端点

- `payments.paypal_surcharge_pct`(0021 种子 3.9%,⚠ 风险标记随行):与卡片费率
  **刻意两个键**——两个渠道的费率独立可调(卡组织规则与 PayPal 费表互不相干)。
  消费方 zod 收口 0–5%、0% = 关闸(裸 custom_id,与无费订单同形)、读不出 →
  checkout 409 `surcharge_rule_unusable`,全部与 Stripe 渠道同一套纪律
  (billing/surcharge.ts)。

| 方法与路径 | 门 | 语义 |
| --- | --- | --- |
| `POST /api/invoices/:id/paypal-checkout` | invoices.manage | 给已发出的票建 PayPal 订单,返回审批跳转 URL(财务过渡面);409 `not_issued` / `invoice_voided` / `nothing_to_collect`;渠道未配置 500 `misconfigured` |
| `POST /api/webhooks/paypal` | verify-webhook-signature 活体验签 | provider 面,挂在会话中间件**之前**;POST-only 405;坏 JSON 400(验签要吃解析后的事件) |

webhook 响应契约与 Stripe 渠道同构:200 记账成功/幂等重放/无关事件/无锚点入账/
不该 capture 的 APPROVED;401 验签不过(零副作用);502 钱到了记不了(票未确认/
已作废/找不到/金额读不出/拆分对不上)或该 capture 而 capture 失败。审计
`invoice.payment_link_created` 沿用(detail 带 `provider: "paypal"` 与 `orderId`,
Stripe 半边带 `sessionId`——同一词条记两个渠道的发链动作)。

## 已落地:失败付款与记不了的站内告警(#193 剩余③切片)

老系统对照:stripe-webhook 的 Sentry/Slack 分流——银行借记失败(FEAT-802)、
支付尝试被拒(BUG-774:2026-10-02 一笔 $4,000 的银行借记被拦,唯一的发现渠道
是客户自己开口)、附加费拆分对不上(FEAT-581)三类告警,Sentry fingerprint 按
externalId 去重。新系统的告警面是**通知域**(既定裁法:外部聊天分流刻意不带),
告警即铃铛一行,收件人 = `invoices.manage` 持有者(owner/finance 角色默认 +
user_permission 个人授权)。

两类告警(billing/payment-alerts.ts,两渠道共用):

1. **支付尝试失败**(`payment.attempt_failed`):新消费 `payment_intent.payment_failed`
   与 `checkout.session.async_payment_failed`——钱没动、票还欠着,客户重试或换
   渠道之前财务该知道。只报带我们有效锚点的尝试(老裁决原文:only attempts that
   carry our invoice_id are ours to report);payload 带方式标签(card /
   bank account / 渠道原词)、Stripe 的拒绝词(code — decline_code — message,
   500 字符收口)、金额与票号。**告警是这个事件的全部事实**:写入成功才 200;
   写不进 502 让 Stripe 重投(dedupe 保幂等)——绝不 ack 一条没人看见的失败。
2. **钱到了记不了**(`payment.unbookable`):两个 webhook 的每一条 502 路径
   (not_issued / invoice_voided / invoice_not_found / unparsable_event /
   capture_failed)先落告警再答 502。502 本身让 provider 重投等财务确认(R-12-6
   人的闸门),但「有笔钱在等处理」必须有人知道——重投只会重试,不会通知。尽力面:
   告警写不进只记日志,响应照旧 502,重投会重试告警写入。无锚点入账
   (metadata/custom_id 缺席)维持 200 ack 不告警——认领面随 #181 进场。

**幂等靠结构**:notifications.dedupe_key(0034,expand-only,注释预告的
「老 (user_id, outbox_id) 唯一约束一并补列」)+ `(user_id, dedupe_key)` 部分唯一
索引。键由事实拼出(`pay:attempt-failed:<渠道>:<外部id>` /
`pay:unbookable:<渠道>:<外部id>:<拒绝码>`),provider 对同一事实的重投被
onConflictDoNothing 吃掉 = 「已提醒过」——每条事实对每人是至多一行,与 payments
的 source 唯一索引同一「由结构保证,不靠先查后插」纪律。拒绝码在键里:状态演变
(草稿→作废)是新事实,值得新提醒。实时「催」只催真正拿到新行的人。

**展示面**:这两种事件类型刻意不进 web 铃铛白名单——href parity 测试强制白名单
事件有真实去处,而发票页(#192 剩余④)未落地;payload 携带 title/detail 事实走
兜底面(approval.completed 同款裁决:诚实的占位,有了承载页再进白名单)。邮件
摘要的 payloadDetail 读 title/detail,自动带走。PayPal 的失败尝试类事件
(DECLINED/DENIED)维持既有 no-op 裁决:其载荷形状无老系统参照,不猜 provider
载荷;告警面先落钱的事实,渠道侧失败事件随真实载荷样例进场。

## 已落地:财务确认页(web,#192 切片 4)

设计权威:#232 §10「所有发票由系统出草稿,**财务确认后才发出**」(R-12-6)。
老系统对照:billing.* 全靠手工建票(发票靠手工创建/拆期,#88)——本页是财务
第一次有地方看到系统出的草稿。issue:#192 剩余④;纯 web 面,零新路由、零
migration(API 半边是切片 1/2 已落的读写面与收款台账)。

### 页面(`/invoices`、`/invoices/:invoiceId`,Billing 区 rail 第一行)

- **列表**:draft 是默认筛选——「待确认发票」就是财务的主读法;Issued/Void/All
  可切。行 = 号(链到详情)/ 类型 / 锚点对象 / 合计 / 已收 / 付款态。第一屏把
  纪律说在前面:确认前不碰客户,确认即发出,发出后行锁定。
- **详情**:头(号/类型/状态/锚点/时间/作废原因)+ 金额块(totalCents/
  paidCents/paymentStatus 三个派生读法)+ 行表(行合计是生成列,只展示)。
- **确认发出**:对话框亮出它承诺的金额,并说明发出后行不可再改——R-12-6 的人
  闸在 UI 上是一道显式的确认,不是一个恰好在那里的按钮。重复确认幂等回
  `already`,flash 原样说「nothing changed」。
- **作废草稿**:可选 reason;对话框说明作废不可逆、留档为 void、补开 = 新票。
- **改草稿行**:整体替换(行序即行文序),编辑器只收数量与单价——服务端算
  合计(RULE-007),编辑面刻意不算也不显示合计,保存后以生成列的答案为准;
  单价输入是美元文本,`parseDollarsToCents` 纯字符串精确换算("8.45" → 845
  分,浮点永不碰金额),数量限三位小数与 `parseQuantity` 同规。
- **收款台账(只读)**:切片 2 的 GET 端点直接上页——每行方式/金额(+附加费
  单列)/到账时间/备注;void 更正行划线留痕(钱行永不删)。草稿票记账本就
  409 fail closed,页面用「发出后才开始收钱」的文案对齐这条状态门。
- **409 状态门逐码成句**:not_draft / invoice_voided / not_voidable 各有各的
  「重载看现状」句子,机器码不与用户见面(与任务详情同一铁律)。

### 铃铛白名单收口(#193 遗留的最后一半)

`payment.attempt_failed` / `payment.unbookable` 进 `NOTIFIED_EVENT_TYPES`
(href parity 测试从此把 `/invoices/:invoiceId` 对着 App.tsx 校验):face 沿用
payload 里服务端拼好的 title/detail 事实(两渠道共用的文案内核,客户端不二次
拼句),深链走 aggregate(aggregateType "invoice");无锚点的行(unbookable 且
票找不到)href null,点击只标已读——不猜去处。

## 已落地:收款动作 web 面(#192 剩余切片)

R-12-6 的下一站:财务确认发出之后的收款动词上页。纯 web 面,零新路由、零
migration(记账/作废/两渠道建链接的 API 半边是切片 2 与 #193 渠道切片已落的)。

### 发出票的三个收款动词(`/invoices/:invoiceId`,仅 issued 状态渲染)

- **手工记账**:对话框只收「到账的事实」——金额(美元文本,
  `parseDollarsToCents` 纯字符串精确换算)、方式(wire_ach / card / paypal)、
  到账时刻(datetime-local,可空 = 现在;未来时刻在表单里拒绝——到账是过去的
  事实,服务端 400 之前先被表单拦下)、备注(可空)。金额刻意不预填未收余额:
  实收是财务才知道的事实,超收/少收都是真实世界,预填会诱导记没有的钱。对话框
  把「链接支付的钱不由手记」的纪律说在页面上——provider 确认的收款由 webhook
  记,手记一遍就是双计。
- **收款作废**:台账里每行活款(live 行)带作废动词,对话框必填 reason(服务端
  min 1,表单先拒空);文案说明钱行永不删——作废行划线留痕,已收合计随 void
  即刻回落。退款是 #240 的流程,不在这里。
- **收款链接**:Stripe / PayPal 两按钮(共用同一接缝的两渠道)——成功打开交付
  对话框:客户链接(只读框聚焦全选 + 复制按钮)、客户将看到的实扣额
  (gross = principal + surcharge,拆分披露与渠道端点同一份事实);失败**不开
  对话框**——没有链接可交付,拒绝落在页面的错误行。409 逐码成句
  (not_issued / invoice_voided / nothing_to_collect /
  surcharge_rule_unusable→指向规则注册表;500 `misconfigured` 说环境缺渠道,
  是配置事实,不说「重载」)。
- 客户端适配器四个动词(record/void/stripeLink/paypalLink)zod 收口响应体,
  失败分相与发票动词同构(409 带机器码);交付对话框只收成功形状
  (`Extract<PaymentLinkResult, { ok: true }>`),拒绝分支在类型上进不来。

## 已落地:发票到期日与逾期对账扫描(#192 due 扫描切片,R-12-7 内部半边)

设计权威:#232 §10「到期前自动提醒客户;**逾期由财务人工催,系统不发催款**
(R-12-7)」。老系统对照:FEAT-765 的 `billing-invoice-overdue-sweep`
(stage 1/7/30 三档内部告警 + Slack 日报)+ FEAT-447 的 due_date 写入口径。
本切片的裁决:

### 到期日(0037,expand-only)

- **`invoices.due_at`**:`confirm` 时由可选 `dueInDays`(0–365 整数,0 = 见票
  即付)算出 `issuedAt + N 天`(UTC——numbering 的同一时区裁决;存时刻不存
  日期,terms 是「N 天」的整数事实,没有日界换算就没有日界漂移)。body 只收
  天数不收时刻(RULE-007);缺省 = 未约定账期,due_at null 不进扫描(老系统
  「NULL = 未约定」同款语义)。重复 confirm 幂等 already,**不改写 dueAt**——
  到期日是发行事实,只随第一次确认落;存量已发行票(切片前)没有 terms,
  恒 null,语义自洽。
- 读面:列表/详情带 `dueAt`(web client 的 zod 同步收口);审计
  `invoice.confirmed` 带 `dueInDays` + `dueAt`。
- **web 面**:confirm 对话框的 terms 选择器——预设是合同词(No agreed
  terms / Due on receipt / Net 15/30/60),「Custom days…」展开天数输入,客户端
  `parseDueInDays` 镜像服务端 zod 准入(整数 0–365),注定被拒的提交死在表单
  不过网络;预览行用服务端同款整数加法(`issuedAt + N × 86 400 000` ms)给出
  「Due <日期>」,权威值仍由服务端在发行时刻盖章(RULE-007)。缺省即
  「No agreed terms」——不替财务决定账期。到期日在详情页金额区占一个
  Due 槽位、列表行 meta 行带 `due <日期>`;**逾期标记**用扫描同一条规则在
  渲染时派生(`dueAt` 已过 ∧ `paymentStatus ≠ paid`,$0 票 vacuously paid),
  只是展示事实——谁真的挨铃由台账决定,不看时钟。
- 账期 per 客户(#232「老板批准的账期客户,额度由老板设」,R-12-4/5 → #241)
  进场后,confirm 的 terms 缺省可从客户主数据读——当前无客户域,terms 由财务
  按合同逐票给。

### 逾期扫描(worker,`invoice-overdue-reminders`)

- **每日 13:10 UTC**(pg-boss,`apps/worker/src/billing/`):排在 rules 每日
  扫描(13:00)之后、通知摘要(13:30)之前——逾期的铃铛当天进摘要。候选集
  = issued ∧ due_at 已过 ∧ (从未催过 ∨ 上次催满 24h),`invoices_issued_due_idx`
  部分索引;对候选集两条分组查询实时派生 total/paid(workflow 提醒的窄读取
  投影同一姿态,worker 不跨 app 依赖),**还欠钱的才催**——paid ≥ total(含
  超收、$0 票 vacuously paid)没有逾期语义。
- **只提醒内部**:收件人 = invoices.manage 持有者(owner/finance 角色 + 个人
  授权,api `invoiceAlertRecipients` 的同一矩阵,worker 侧窄读取);落一行
  `invoice.overdue` 通知(payload 带 worker 拼好的 title/detail:金额 + 到期日),
  进铃铛白名单深链 `/invoices/:invoiceId`,催收(人工)从台账页发起。**不发
  客户催款**:R-12-7 的前半(到期前提醒客户)随客户门户与渠道层接线。
- **幂等两层**:台账 `invoices.overdue_reminder_at`(盖章带 status 条件、通知
  行同事务,24h 再催——approval/workflow 催办同一节奏)+ notifications
  `dedupe_key` 日粒度(`invoice-overdue:<id>:<UTC 日>`)。付清不清零台账:
  收款是派生值,付清的票由 paid ≥ total 过滤结构性出局,台账只回答「上次催
  是什么时候」。老系统的 stage 1/7/30 档位与 Slack 日报刻意不搬——24h 节奏
  与既有催办一致,Slack 通道留给 job 失败告警(runner.ts),业务提醒走通知域。
- 老任务处置见 `docs/cron-migration.md`(billing-invoice-overdue-sweep →
  invoice-overdue-reminders)。

## 已落地:贷项单内核(#192 红冲切片)

设计权威:#232 §10「分期、更正、**贷项**」。发票内核切片预留的承诺在此兑现:
已发出的票行锁定不可改,红冲**不是对已发行行的改写,而是一张新单据**。
老系统对照:billing.invoices 没有贷项概念,更正靠 `status='refunded'` 直接改写
快照(#88 手工时代);credit memo 是 QuickBooks 的一等公民(#181 推送的路标)。

### 数据模型(0038,expand-only)

- **`credit_notes`**:`credit_note_status` 枚举(与发票同构的三态:
  draft / issued / void)、硬外键 `invoice_id`(被冲抵对象无歧义,不需要多态
  锚点)、`reason` 必填(贷项单是更正的叙事本体,无因之冲不可考)、`currency`
  从原票抄录(自描述,收款行同裁)。编号走 numbering subject `credit_note`
  (billing/registry.ts 注册,无生效规则 409 fail closed 同发票)。
- **`credit_note_lines`**:与 invoice_lines 同构(三位小数、整数分、生成列
  行合计、行序即行文序)。贷项行是「负向的行」,但金额照记非负——冲抵方向由
  单据类型携带,读法不需要学会处理负数。
- **无 source 幂等列**:当前唯一入口是财务手工创建(#239 变更单触发域进场时
  expand 唯一索引,expand-only 不需要回填)。

### 四个口径裁决

1. **状态机与发票同构,draft → issued 是 R-12-6 同一道人闸**:贷项单和发票
   一样是发给客户的钱面文件,不存在「系统自动冲抵」——草稿确认前不计入有效
   应付(草稿贷项不能让发票提前变「paid」)。issued 是终态:开错的贷项单按
   QuickBooks 同款模式用新发票冲回,不在本表翻烧饼。
2. **冲抵边界是结构约束**:一张票名下**在世(draft + issued)贷项合计 ≤ 原票
   合计**,由创建事务在发票行锁内校验(原票 issued 后行合计冻结、贷项只增或
   经 void 缩小,边界自此无漂移窗口);草稿也占边界——两张草稿各自都在边界内、
   先后确认就超冲的窗口在这里关死。超冲 409 `credit_exceeds_invoice`:把应付
   冲成负数不是更正,是另一笔交易(退款走 #240)。
3. **有效应付的唯一权威算术**:`effectiveDueCents = 发票合计 − 有效贷项合计`
   (billing/credits.ts)。付款态派生(`computePaymentStatus` 的应付口径)、
   Stripe/PayPal checkout 的结算额、逾期扫描的 outstanding 全部从这里取——
   全冲抵的票 vacuously paid,结构性出局逾期扫描;链接/订单不能按原面额把
   客户多收一遍。发票面金额(`totalCents`)**恒不变**,读面新增
   `creditedCents`。
4. **金额纪律三层防线与发票同款**:整数分、生成列行合计(PG numeric round 是
   唯一舍入权威)、读面实时 SUM 不落快照——发票合计、有效贷项、有效收款三个
   派生值各自结构性无漂移(bug554 家族的三重不可能)。

### 端点(全部 invoices.manage 门)

- `POST /api/invoices/:id/credit-notes`(开贷项草稿;409: not_issued /
  invoice_voided / credit_exceeds_invoice / numbering_not_configured)、
  `GET /api/invoices/:id/credit-notes`(台账:有效合计只数 issued,行含
  void 留痕)、`GET /api/credit-notes/:id`(详情含行)。
- `POST /api/credit-notes/:id/confirm`(draft → issued,冲抵自此计入;重复
  幂等 already 不落审计)、`POST /api/credit-notes/:id/void`(draft → void;
  issued 终态不可作废 409 not_voidable)。审计 credit_note.created /
  confirmed / voided(detail 恒记 number + invoiceNumber + creditedCents)。
- **贷项动作的 web 面(本切片)**:发票详情页的冲抵台账与动作——金额区新增
  Credited 统计(> 0 才显示)、Credit notes 台账区(仅 issued 票渲染:草稿
  行带 Confirm/Void 按钮,void 行划线留痕带 voidReason,有效合计行口说「只数
  已确认」)、开贷项草稿对话框(reason 必填 = 更正的叙事本体;行编辑同发票
  草稿纪律——数量/单价精确字符串解析,客户端不算合计,边界由服务端行锁校验)、
  确认与作废对话框各自把 R-12-6 的后果说在提交前。六个 409 码逐码成句
  (not_issued / invoice_voided / credit_exceeds_invoice /
  numbering_not_configured / credit_note_voided / not_voidable),机器码不见
  用户。纯 web 切片:零 API 改动、零 migration。

## 已落地:分期拆票内核(#192 分期切片)

设计权威:#232 §10「分期、更正、贷项」的最后一个单据族。老系统对照(#88 手工
时代):分期散在 `installment` 发票类型 + 母子票 `parent_invoice_id` 接缝 +
「Part i of n」的屏幕推导里——序数从当前页行集算出来,三期计划印成
"Part 1 of 1"(老系统 BUG-274),计划总额没有权威落点。本内核的裁决:

### 数据模型(0039,expand-only)

- **`invoice_plans`**:`label` 必填(这笔钱在还什么——分期是约定的叙事本体,
  reason 之于贷项单同位)、可选 subject 锚点(invoices.subject 同裁多态开集)、
  **`total_cents` 是创建事务里盖章的约定拆分额**(= 各期之和,之后恒不变——
  它是「约定」的事实,不是派生状态;成员票是草稿、行可改、可 void,live 合计
  会漂,约定额不跟着漂)。币种落计划行,成员票从计划抄录。无 source 幂等列
  (当前唯一入口是财务手工拆票;订单域 #231 按比例拆期进场时 expand 唯一索引,
  贷项单同裁)。
- **invoices expand 两列**:`plan_id`(成员外键)+ `plan_index`(创建时按提交
  顺序落定的稳定序数,1-based,永不重编号)。两列皆 null = 非分期票。
- **`invoice_type` expand `installment`**(老系统第 8 类同款):它的触发事实
  是「一个约定总额被切成 n 期」,不是某次业务确认——手工建票入口同样收这个
  类型,但系统拆票走 `createInvoicePlan` 是唯一带成员身份的路径。

### 四个口径裁决

1. **计划是事实,票是文档**:一次拆票 = 计划行 + n 张 `installment` 类型单行
   草稿票在**同一个事务**里生灭(第 3 期发号失败 → NoActiveRuleError → 整个
   计划从未存在,无半张计划);每期是一张单行的票(quantity 1、单价 = 该期
   金额,行合计生成列即该期金额,无二次算术),此后各自走发票的既有动词
   (confirm 的账期、收款、void)——分期不引入第二套单据状态机。
2. **「Part i of n」两半分开**:i(plan_index)是身份,n(成员数,**含 void**)
   是成员关系的现状,读时 COUNT 派生(`countPlanMembers`,列表一次分组取齐
   全体)——绝不从调用方手里的行集数出来(BUG-274 的教训反过来用)。被作废
   的期仍是「这刀切过的事实」,序号不重排;在世口径由计划读面另答。
3. **约定 vs 现状的漂移原样暴露**:计划读面给 `livePartCount` /
   `liveInvoicedCents`(在世成员行合计之和)与 `uninvoicedCents`(约定额 −
   在世已开;>0 有期被作废/未开足,<0 成员行被改到超过约定)——两种漂移都
   必须看得见,不 clamp(effectiveDueCents 同裁)。
4. **付款态不另立算术**:逐期的 paymentStatus 与发票读写面同一条权威算术
   (computePaymentStatus + effectiveDueCents);计划合计 `paidCents` /
   `outstandingCents` 只取在世成员,未收逐票 max(0, 有效应付 − 已收)——
   一张票的超收不冲抵另一张票的欠款。全冲抵的成员票 vacuously paid。

### 端点(全部 invoices.manage 门)

- `POST /api/invoice-plans`:一次切成 n 期(2–12;一期不是分期,手工建票已有
  那个入口;>12 是融资安排不是发票拆分)。body 只有 `label`、可选 subject
  对、`parts[{ amountCents }]`——整数分、必为正、合计 ≤ int4;**没有「总额」
  字段**:约定额是切出来的结果,不是谁另报的数(RULE-007)。409
  numbering_not_configured(发号失败整计划回滚)。201 带各期 id/号/序数/金额。
- `GET /api/invoice-plans/:id`:计划台账(约定额、逐期钱态、在世口径合计、
  uninvoicedCents);404 反探测同发票。审计 `invoice_plan.created`(target =
  计划行,detail 记 label/totalCents/partCount/partNumbers——一次动作一行,
  全部期号可查;成员票的后续动词走既有词条)。

## 剩余(#192 保持 open,Part of #192)

1. **触发点接线**(属主域各自进场):打样/调味费(#238)、定金(#231,比例
   50%–100%,低于 50% 走财务审批 R-08-2——审批线 #221 已可表达)、每批尾款
   (完工 + 实际产量 + 运营确认 R-11-6;结算量 = min(实际, 报价×110%),少产
   超 10% 拦开票 R-11-4)——调 `createDraftInvoice` 传 source 幂等键;
2. 剩真渠道测试环境的端到端(部署面:webhook URL + 密钥)与客户门户的发起面
   (#186)——收款动作的 web 面(手工记账/收款作废/两渠道链接)已上页;
3. 到期前提醒的**客户面**(R-12-7 前半:渠道层邮件/门户,内部 due 扫描与
   terms/due 的 web 面已落)、收款状态回写订单/批次(#241 发货门槛,读
   `computePaymentStatus`)、QuickBooks 推送(#181,含银行流水认领)、第一笔款
   到账转正式客户(R-02-5)等收款触发业务;
4. PDF 存档(#128 统一 PDF 服务)、**分期的 web 面**(拆票动作与计划台账上页;
   内核与 API 已落,web client 的 plan 契约已同步)、订单域按比例拆期触发
   (#231 进场时走 createInvoicePlan 服务接缝)。
