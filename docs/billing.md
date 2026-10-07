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
  多少」是收款台账对实时 SUM 的回答。发出后的通知(到期提醒 R-12-7、逾期不
  自动催款)随客户门户与渠道层接线——本内核零通知,没有收件人的邮件不存在。

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
不落)、`invoice.confirmed`(number/totalCents——财务确认的金额快照)、
`invoice.voided`(number/totalCents/reason?)。

## 端点

| 方法与路径 | 门 | 语义 |
| --- | --- | --- |
| `POST /api/invoices` | invoices.manage | 手工建草稿(老系统的过渡面);body 含 source 字段与属主域触发同形 |
| `GET /api/invoices?status=` | invoices.manage | 列表(含 totalCents;财务「待确认发票」主读法) |
| `GET /api/invoices/:id` | invoices.manage | 详情(头 + 行 + totalCents) |
| `PATCH /api/invoices/:id` | invoices.manage | 草稿换行(整体替换,行序即语义);仅 draft |
| `POST /api/invoices/:id/confirm` | invoices.manage | draft → issued;幂等 |
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
给出 subject 锚点),「支付他人发票被拒」的归属门随门户面进场;本切片把同一
服务路径先开给财务(invoices.manage)——财务确认后把链接发给客户是当下就成立
的收款动作。门户将来复用同一 `StripeGateway`,不新增第二套建会话的路径。

## 剩余(#192 保持 open,Part of #192)

1. **触发点接线**(属主域各自进场):打样/调味费(#238)、定金(#231,比例
   50%–100%,低于 50% 走财务审批 R-08-2——审批线 #221 已可表达)、每批尾款
   (完工 + 实际产量 + 运营确认 R-11-6;结算量 = min(实际, 报价×110%),少产
   超 10% 拦开票 R-11-4)——调 `createDraftInvoice` 传 source 幂等键;
2. Stripe webhook 已落地(#193:checkout 链接 + 验签消费 + 幂等记账);剩
   PayPal 渠道(同一接缝,sourceType paypal)、附加费规则(R-12-2/3,规则注册表
   #233 已就绪,session 金额带 principal/surcharge 拆分——老系统 splitSurchargedCapture
   的教训带过去)、失败付款/银行借记拒付的站内提醒(老系统 Sentry/Slack 分流在新
   系统走通知域);
3. 到期前提醒(R-12-7,渠道层 + due 扫描)、收款状态回写订单/批次(#241 发货
   门槛,读 `computePaymentStatus`)、QuickBooks 推送(#181,含银行流水认领)、
   第一笔款到账转正式客户(R-02-5)等收款触发业务;
4. PDF 存档(#128 统一 PDF 服务)、分期/更正/贷项(红冲动词)、财务确认页
   (web)。
