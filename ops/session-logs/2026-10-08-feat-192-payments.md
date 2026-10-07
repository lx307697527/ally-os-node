---
session_id: hand-written-192-payments
branch: feat/192-payments
date: 2026-10-08
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

# Session log — feat/192-payments — 2026-10-08

> 机械层本次由 agent 手写(ZCode 定时迁移会话);判断层为本次会话手写。

## 机械层(自动)

- **引用的 issue**:#192 剩余清单第 2 条「收款与 paid 态」(PR #300 切片评论
  同文)。PR 正文写 **Part of #192**(#192 尚余触发点接线/webhook(#193)/
  提醒/回写/QuickBooks/PDF,保持 open)。
- **前置收尾(第 0 步)**:无 open PR(#302 已于昨日 15:58 squash 合并,即
  main 顶端 00d1023)、无残留 worktree、主检出干净。
- **选题**:①优先续做有未完成切片的 open issue。候选盘点:#233(周报已随
  #302 落地,余项全部路由到 #225/#206/第一消费域,无可独立验收切片)、
  #113/#110/#222/#224/#226/#221/#219/#116(余项均阻塞在 ops 域/#118/#206/
  SMS/RBAC 裁决)、#225(Superset 部署 + 模板管理等 #128)、**#192(收款与
  paid 态——无阻塞,直连昨日发票内核)**。选 #192。
- **claim**:`claim_issue.py claim --issue 192` 成功(原子租约)。
- **数据库**:本地 postgres 可用(5432),verify 全程带 DATABASE_URL,
  115 文件 / 1063 测试零 skip(基线 114/1054:+1 文件 +9)。

### 本切片改动的文件

- `packages/db/src/schema.ts`:`payments` 表(payment_method 枚举 card/paypal/
  wire_ach、amount_cents 整数分、currency 抄发票、received_at 不未来、note、
  recorded_by_id 可空 = webhook 无用户上下文、void 三列)+ (source_type,
  source_key) 唯一索引(与发票同构的幂等)。同文件修正 invoice 状态机注释里
  「paid/partially_paid 随收款切片 expand 进场」的过时预告(裁决推翻,见判断层)。
  migration 0032 生成并提交(expand-only)。
- `apps/api/src/billing/payments.ts`(新):`computePaymentStatus`(付款态唯一
  权威定义:paid 含超收、$0 票 vacuously paid)、`recordPayment`(锁发票行 →
  状态门 fail closed → source 幂等插入 → 同事务实时 SUM)、`voidPayment`
  (先票后钱同序锁,重复作废幂等 already)、`sumPaidCents` /
  `summarizeInvoicePayments` / `listPaymentsForInvoice`。
- `apps/api/src/routes/payments.ts`(新):POST /api/invoices/:id/payments、
  GET /api/invoices/:id/payments、POST /api/payments/:id/void;receivedAt
  z.iso.datetime + 不未来;审计 `payment.recorded` / `payment.voided`(target =
  收款行 id,detail 带 invoiceNumber/amountCents/method/paymentStatus/paidCents
  ——门槛跨越的事实)。
- `apps/api/src/routes/invoices.ts`:发票读写面带 `paidCents` + `paymentStatus`;
  列表合计改为「头行 + 两个 GROUP BY 分组查询」三条固定查询(不再按票
  Promise.all 逐票补查,也不再随票数增长)。
- `apps/api/src/routes/registry.ts`:3 条新路由声明(invoices.manage)。
- docs:billing.md 收款内核专节(数据模型/两裁决/webhook 接缝/端点表/剩余
  更新)、audit.md 收款词表、permissions.md 财务行与 invoices.manage 段。
- 测试 `apps/api/src/routes/payments.test.ts`(新,9 例,独立 scratch DB):
  记账 partial→paid、source 幂等重放 409 + 手工行不受约束、draft/void 票
  fail closed、400 矩阵(零/负/小数/未知方式/未来到账/source 不成对)、
  过去 receivedAt 原样落库、void 降态 + SUM 剔除 + 幂等 + reason 必填、
  403/404 面、$0 票 vacuously paid、列表付款态读法。

## 判断层(手写)

### 关键判断

1. **付款态派生,不 expand invoice_status**——推翻 0023 时注释里的预告。
   预告说「paid/partially_paid 随收款切片 expand 进场」,但真落片时发现:
   付款态 = f(发票合计, 有效收款 SUM) 是纯函数,两个输入各自结构性无漂移
   (行合计是生成列 + 发出后行锁定;收款行只增不删、更正走 void)。落列则
   每个写方都要记得重算,漏一个就是卡死在「paid」的票,财务会信它——正是
   #300 切片花力气在表结构上消灭的 bug554 快照漂移家族的收款版。老系统
   record_payment_atomic 推状态机时要为每个组合写「合法边 + 静默跳过」,派生
   值没有边可违反。门槛跨越(尾款到账→可发货等)需要「事实」——由
   payment.recorded 审计的 paymentStatus 携带,消费域(#241)沿审计行接线,
   读面统一走 computePaymentStatus,不各算各的。schema.ts 与 billing.md 都
   写明预告被推翻与理由(注释说谎比没有注释糟)。

2. **到账不推进发票状态**(老系统 draft 自动跳 sent 被刻意抛弃)。#232 v2 的
   整个主题是「系统出草稿、财务确认后才发出」,到账替财务放行等于用 webhook
   绕过 R-12-6 的人闸。draft/void 票记账 409 fail closed,webhook 面靠
   provider 重试等财务确认——老系统「未知发票返回 NULL 让 provider 重试」
   的去向保留,只是分了 not_issued / invoice_voided 两种可读码。

3. **webhook 接缝是服务函数,不是 HTTP 面**。#193 验签后在自己的业务事务里
   调 recordPayment 传 source;PaymentExistsError 对 webhook 是「重放,已记账
   成功」(吃掉回 2xx),对财务 HTTP 面是 409——同一幂等结构,两种语义映射,
   与 createDraftInvoice 的属主域/手工票双面同构。

4. **钱的更正动词是 void,不是 delete**。手工录错电汇金额是必然事件,没有
   更正路径就只能 DB 手术;钱行永不删(void 三列 + SUM 剔除 + 审计),退款
   是 #240 的独立流程(原路退回),不混进本切片。

5. **选题判断**:#233 看似最近活跃(昨天连落三片),但剩余项已全部路由到
   #225/#206/「随第一个消费域」,没有可独立验收的切片——硬做就是越界替
   #206 裁治理字段编辑。#192 的收款切片无阻塞、直连昨日发票内核(读法/
   权限/审计/编号夹具全部现成),是优先级①里唯一「能整片干净落地」的。

### 踩的坑

1. **drizzle 在 sql`` 模板里渲染不带表限定的裸列名**。列表读法第一版用相关
   子查询(`(select sum(...) from invoice_lines where invoice_id = invoices.id)`
   的 drizzle 插值写法),实测渲染成 `where "invoice_id" = "id"`——内层表把
   外层影子化,关联断裂,total 恒 0,于是所有票 paymentStatus 恒「paid」
   ($0 票 vacuously paid 的裁决把 bug 伪装成了全票已结清,测试「unpaid 票
   应为 unpaid」当场抓出)。用独立 scratch DB 的集成测试从断言到定位 5 分钟;
   修复改为「头行 + 两个 GROUP BY 分组查询 + JS 合并」三条固定查询,全部
   结构化 API,顺带把列表从按票 N+1 查询变成不随票数增长。教训:多表
   sql`` 插值列名不可信,要么纯单表、要么全裸写 SQL 并自担表名耦合——仓库
   无裸表名先例,选了前者。

2. **route-auth registry 是双向比对**:`route-auth.test.ts` 把 app.routes 实际
   路由与 registry.ts 清单双向对照,新路由必须逐条声明(3 条全 invoices.manage),
   kind: "permission" 还必须有 403 集成测试——payments.test.ts 的权限用例
   同时是这条仓规的义务面。

3. **numbering 夹具的 startNumber 要换**:payments.test.ts 与 invoices.test.ts
   是两个独立 scratch 库不冲突,但同库跑两套件时 truncate 不及 numbering 行;
   本文件用 2000 起号(INV-2000…),与 invoices.test.ts(1000)天然可辨,
   断言号串时不怕串场。

### 验收对照(本切片范围:#192 剩余第 2 条的「收款与 paid 态」半边)

- [x] 收款幂等记账:source 唯一索引,同一 webhook 事件重放结构上只一行(集成测试)
- [x] 付款态实时正确:partial → paid → void 降态,SUM 剔除 void 行(集成测试)
- [x] 只对 issued 票收钱:draft/void fail closed,到账不替财务放行(R-12-6,集成测试)
- [x] 误录可更正:void + 必填 reason + 审计 + 幂等,钱行不删(集成测试)
- [x] 权限:invoices.manage(finance/owner)三门全覆盖,sales 403(集成测试)
- [x] 门槛跨越事实进审计:payment.recorded 的 paymentStatus(R-12-4 等消费域的路标)
- [ ] Stripe/PayPal webhook 消费面(#193)、附加费 R-12-2/3(接缝已就绪)
- [ ] 触发点接线/提醒/回写/QuickBooks/PDF/红冲(#192 剩余清单原样保持)
