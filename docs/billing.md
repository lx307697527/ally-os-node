# 发票内核(#192)

设计权威:#232 §10「模块五 财务」——「所有发票由系统出草稿,**财务确认后才发出**」
(R-12-6);尾款按批开票(R-11-6);金额按整数分计算。issue:#192(发票草稿 +
财务确认),所属模块 #190(M5 财务)。

老系统对照:`billing.*`(20260724143856_billing_core.sql)——发票靠手工创建/拆期
(#88),`amount_due numeric(14,2)` 快照列;行合计 `total_price` 是 SQL 生成列(本
内核沿用这一裁决)。

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
- 付款态(paid/partially_paid)随收款切片(#193 webhook 面)expand 进场;
  发出后的通知(到期提醒 R-12-7、逾期不自动催款)随客户门户与渠道层接线——
  本内核零通知,没有收件人的邮件不存在。

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

## 剩余(#192 保持 open,Part of #192)

1. **触发点接线**(属主域各自进场):打样/调味费(#238)、定金(#231,比例
   50%–100%,低于 50% 走财务审批 R-08-2——审批线 #221 已可表达)、每批尾款
   (完工 + 实际产量 + 运营确认 R-11-6;结算量 = min(实际, 报价×110%),少产
   超 10% 拦开票 R-11-4)——调 `createDraftInvoice` 传 source 幂等键;
2. 收款与发票状态(paid/partially_paid)、Stripe/PayPal webhook(#193)、附加费
   规则(R-12-2/3,规则注册表 #233 已就绪);
3. 到期前提醒(R-12-7,渠道层 + due 扫描)、收款状态回写订单/批次(#241 发货
   门槛)、QuickBooks 推送(#181);
4. PDF 存档(#128 统一 PDF 服务)、分期/更正/贷项(红冲动词)、财务确认页
   (web)。
