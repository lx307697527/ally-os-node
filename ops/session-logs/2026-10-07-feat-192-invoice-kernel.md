---
session_id: hand-written-192-invoice-kernel
branch: feat/192-invoice-kernel
date: 2026-10-07
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

# Session log — feat/192-invoice-kernel — 2026-10-07

> 机械层本次由 agent 手写(ZCode 定时迁移会话);判断层为本次会话手写。

## 机械层(自动)

- **引用的 issue**:#192(发票草稿 + 财务确认)的**发票内核切片**——
  #232 §10「所有发票由系统出草稿,财务确认后才发出」(R-12-6)的表结构、
  状态机、金额纪律与触发点接缝。PR 正文写 Part of #192(#192 仍开:触发点
  接线随属主域、收款 #193、红冲/贷项、PDF、web 面等)。
- **前置收尾(第 0 步)**:无 open PR、无残留 worktree、无多余本地分支、
  主检出干净;origin/main 顶端 5d4d3f3(#299,任务事件投递)即基线。
- **选题**:①优先续做 issue 评论里的未完成切片——逐个核对 phase-1 开放
  issue 的最新评论:#113 剩余等 #118/#116/RBAC/ops 域,#110 剩余等 ops 域/
  #30 频道,#219 剩余等消费域,#220 剩余等属主域/通用草稿面板,#221 剩余
  等金额域,#222 剩余挂设计选型/消费域,#224 剩余等 SMS/#118/属主域,
  #226 剩余等 #206/「第一个真实先审后上需求」,#225 剩 Superset 部署,
  #233 剩余等 #225/#206——phase-1 全部挂外部前置;②#22→#34 已全关;
  ③按 phase-2 编号升序取 #192(发票),其可独立验收切片 = 发票内核
  (触发点属主域未进场,但「草稿状态机 + 财务确认 + 触发点幂等 + 整数分」
  是 #192 验收第 1/6 条的内核半边,与 #113 任务内核切片同裁法)。
  `claim_issue.py` 原子租约一次成功。
- **老系统参考(只读)**:`supabase/migrations/20260724143856_billing_core.sql`
  (billing.invoices/invoice_lines/payments:类型/状态 frozen 枚举、numeric
  金额、total_price 生成列、payments 的 UNIQUE(provider, external_id) 幂等
  键)、20260724181637_portal_invoices.sql(portal 视图的列白名单)。照搬
  的只有「行合计生成列」;金额(整数分取代 numeric)、锚点(多态 subject
  取代 order_id/account_id 硬外键)、幂等(source 键取代支付外部 id)按
  #192/#232 的裁决重做。
- **数据库**:本地 postgres(docker compose)可用,verify 全程带
  DATABASE_URL,零 skip。

### 本切片改动的文件

- `packages/db/src/schema.ts`:`invoice_type` 枚举(7 个触发点命名的类型,
  刻意不建杂项桶)、`invoice_status`(draft/issued/void 三态)、`invoices`
  (多态 subject 锚点、(source_type, source_key) 唯一索引、生命周期列)、
  `invoice_lines`(line_number 行序、quantity numeric(12,3)、unit_price_cents
  整数分、**line_total_cents 生成列** `round(quantity * unit_price_cents)`);
  migration `0029` 随本切片提交。
- `apps/api/src/authz/permissions.ts`:新权限点 `invoices.manage`(finance/
  owner 默认;admin 刻意不持有——职责注释写进注册表)。
- `apps/api/src/billing/service.ts`(新):`createDraftInvoice`(编号事务 +
  source 幂等 23505 → InvoiceExistsError)、`updateDraftLines`(FOR UPDATE
  行锁 + 逐位 no-op 判定 + 整体替换)、`confirmInvoice`/`voidInvoice`
  (状态机动词,重复动词幂等 already)、`sumLineTotals`(实时 SUM)。错误
  类型 InvoiceExistsError/InvoiceStateError 携带机器可读 code。这是**触发点
  的进程内接缝**——属主域(#238/#231/批次完工)在自己的业务事务里调它,
  草稿与触发事实同事务生灭。
- `apps/api/src/billing/registry.ts`(新):invoice 注册进编号注册表——
  numbering/registry.ts 自 #225 以来「刻意为空」的口子闭合,第一个生产注册。
- `apps/api/src/routes/invoices.ts`(新):六条路由(POST/GET 列表/GET 详情/
  PATCH/confirm/void),全在 invoices.manage 权限点后;zod 收口三位小数、
  int4 行合计边界、subject/source 成对出现;NoActiveRuleError → 409
  numbering_not_configured(fail closed 的可操作化);void 的 body 可省。
- `apps/api/src/routes/registry.ts`:六条路由的 auth 声明。
- `apps/api/src/app.ts`:billing/registry.ts 副作用 import + invoicesRoutes
  挂载。
- `apps/api/src/routes/invoices.test.ts`(新,13 用例,独立临时库):建草稿
  发号(INV-1000/1001 原子分配)、生成列合计与三位小数读回、0.005 分取整
  边界、400 家族(空票/负数/4 位小数/行溢出/subject-source 不成对)、source
  幂等 409 + 手工票自由、无编号规则 409(自清自建恢复夹具)、PATCH 换行 +
  no-op 幂等不留审计、confirm 状态/审计金额/幂等、void + not_voidable +
  invoice_voided、issued 行锁定、404 全动词、列表 + status 过滤、403 全动词
  (sales)+ owner 通过、会话门。
- `docs/billing.md`(新)、`docs/audit.md`(invoice.* 四词)、
  `docs/permissions.md`(finance 行 + invoices.manage 段)、`docs/numbering.md`
  (注册表现状 + 时区裁决收口)。

**验证**:`DATABASE_URL=… corepack pnpm verify` 全绿 110 文件 / 1014 测试
(基线 109/1001,+1 文件 +13,零 skip;lint/typecheck 含于 verify)。

## 判断层(本次的关键判断与踩的坑)

1. **phase-1 挂账全景与解锁方向的判断。** 选题时把 phase-1 十个开放 issue
   的最新评论全部核对了一遍:剩余项无一可立即开工,全部挂属主域(#227/
   #229/#231)、外部依赖(#118 AI、#116 渠道、SMS)、设计选型(#222 表单
   构建器)或「第一个真实需求」(#226/#224 草稿面)。此时按编号升序进
   phase-2 不是跳过 phase-1,而是解锁它——#192 的发票内核就是 numbering
   注释里预告的「第一个真实消费方」。切片内部还顺手收了两个 phase-1 的口
   :numbering 注册表第一个生产注册、时区裁决正式收口(维持 UTC,理由写进
   docs)。
2. **金额纪律的三层落点,一处都不能省。** 「金额整数分 + 取整边界一致」
   (#192 验收第 6 条)的防线:zod 收 quantity 三位小数(浮点直判会被
   0.1×1000 ≠ 100 的表示误差误伤,走 toFixed 往返)、行合计 ≤ int4 上限
   (生成列的存储边界,zod refine 挡住而不是 DB 报 500)、行合计是 SQL 生成
   列(PG numeric round half away from zero,JS 不复实现取整——单一真相在
   DB)。发票合计刻意不落快照列:实时 SUM,老系统 amount_due 快照漂移一类
   的 bug(bug554 家族)在表结构上不可能存在。少任何一层,验收边界测试就
   是假的。
3. **行序必须有一等公民的列。** 第一版读行按 uuid 排序,测试当场抓出
   [500, 250000] ≠ [250000, 500]——uuid 主键是随机序,不能当商业文件的行
   文序。加 line_number(写入侧按提交顺序 1..n,PATCH 整体替换),读法按它
   排。「行没有身份键,顺序即语义」由此从注释变成数据;整体替换 + 逐位
   no-op 判定同时消灭增量 diff 漂移(老 bug554「行与预期态不一致」的根因
   形态)。
4. **0029 迁移的 journal 残留坑。** 第一版 0029 生成后加了 line_number 列,
   删 SQL 文件重新生成会得到 0030——meta/_journal.json 里残留 idx 29 的
   条目指向已删除的文件,runMigrations 会在 0029 处炸。修复:0030 文件与
   snapshot、journal 的 idx 29/30 条目一并清掉,回到 0028 干净基线重新
   generate。教训:未推送的迁移可以重来,但 **journal/snapshot/SQL 三件套
   要一起清理**,drizzle-kit 不会替你发现孤儿条目。
5. **手工建票的过渡面与触发点接缝同形。** #192 的触发点(打样/定金/尾款)
   属主域全部未进场,但财务手工建票(老系统的现实)需要一个 HTTP 面。裁决:
   POST /api/invoices 就是过渡面,body 里的 subject/source 字段与属主域进程
   内调用的入参同形——属主域进场时不需要新的发票端点,只是把「人填的表单」
   换成「业务事实进程内调用」,HTTP 面原样保留给财务。fail closed 也做了
   可操作化:无编号规则 → 409 numbering_not_configured(修复动作明确:去
   配置工作室建规则),而不是 500。
6. **测试夹具的自清自建。** 「无编号规则」用例与套件夹具(numbering_rules
   行)冲突:rules 是配置不是业务行,beforeEach 不清它;用例内 delete 后
   POST 断言 409,再重建夹具行断言 201。比拆两个 suite 或依赖 it 执行顺序
   都诚实——顺序耦合的测试在并行化时是随机的。
