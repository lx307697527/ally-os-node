---
session_id: hand-written-192-installment-plans
branch: feat/192-installment-plans
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

# Session log — feat/192-installment-plans — 2026-10-09

> 机械层本次由 agent 手写(ZCode 定时迁移会话);判断层为本次会话手写。

## 机械层(自动)

- **引用的 issue**:#192(发票草稿 + 财务确认,phase-2)——剩余清单第 4 条
  「分期(拆期开票)」:红冲的贷项单内核(PR #316)与贷项动作 web 面(PR
  #317)已落,分期是 #232 §10「分期、更正、贷项」三件里最后一件。PR 正文写
  **Part of #192**(触发点接线、客户面提醒、#241 回写、#181 QuickBooks、
  #128 PDF、分期 web 面等未完,保持 open)。
- **前置收尾(第 0 步)**:`git fetch origin --prune`;无 open PR、无残留
  worktree、主检出干净(HEAD = 4e39501)。
- **选题**:规则①——#192/#193/#233 三租约均显示 released(claimable)。
  #193 剩余压在门户(#186)/真渠道 E2E/#240 上;#233 剩余全部路由到
  #220/#206/#223;**#192 的分期是唯一计费域内自洽、可独立验收的未完成切片**
  (内核 + API,与贷项单内核同形态)。
- **claim**:`claim_issue.py claim --issue 192` 成功(接替过期租约)。
- **worktree**:`.claude/worktrees/192-installment-plans`,分支
  `feat/192-installment-plans` 自 origin/main;`corepack pnpm install` 后
  基线 verify 全绿(本地 postgres 在跑,全程零 skip)。
- **老系统参考**(只读):`apps/allyos/src/billing/invoices/view/invoice-plan.ts`
  与 `apps/allyos/docs/invoices-and-billing.md`——`installment` 是老系统的第
  8 个发票类型,建票弹窗按订单总额百分比算额,母子票 `parent_invoice_id`
  是计划的事实落点;BUG-274:「Part i of n」从当前页行集推导,三期计划印成
  "Part 1 of 1"。

### 本切片改动的文件

- `packages/db/src/schema.ts`(0039,expand-only):**`invoice_plans` 表**
  (label 必填、可选 subject 锚点、`total_cents` 创建时盖章的约定拆分额、
  currency 成员票抄录源);**invoices expand `plan_id` + `plan_index`**(两列
  皆 null = 非分期票)+ `invoices_plan_id_idx`;**`invoice_type` expand
  `installment`**(老系统第 8 类同款)。
- `apps/api/src/billing/installments.ts`(新模块):`createInvoicePlan`
  (计划行 + n 张单行草稿票同一事务生灭;每期 quantity 1 × 该期金额,行合计
  生成列即金额,无二次算术)、`getInvoicePlan`(头 + 逐期钱态 + 在世口径
  合计 + uninvoicedCents)、`countPlanMembers` / `countAllPlanMembers`
  (「Part i of n」的 n 读时派生)。
- `apps/api/src/billing/service.ts`:`INVOICE_TYPES` + `installment`;
  `CreateDraftInvoiceInput` + `plan?: { id, index }`(拆票接缝在创建事务里
  同时落成员身份,一次 insert 不二次写)。
- `apps/api/src/routes/invoice-plans.ts`(新):`POST /api/invoice-plans`
  (zod:label 1–200、parts 2–12、每期整数分必为正、合计 ≤ int4、subject 成
  对;409 numbering_not_configured;审计 `invoice_plan.created` 带
  partNumbers)、`GET /api/invoice-plans/:id`(404 反探测同发票)。
- `apps/api/src/routes/registry.ts`:两条新路由的授权声明(invoices.manage,
  #23 双向比对要求)。
- `apps/api/src/routes/invoices.ts`:presentInvoice 带 `plan` 事实
  ({ id, index, count } | null)——列表读 countAllPlanMembers 一次分组,
  详情读 countPlanMembers 逐票问。
- `apps/web/src/shared/lib/invoices-client.ts`:invoiceSchema 同步 `plan`
  契约(z.object{id,index,count}.nullable)——展示随分期 web 面切片。
- 测试:`invoice-plans.test.ts`(新,10 例:拆票/成员是普通票/逐期生命周期/
  void 不重排序数/贷项读穿/uninvoiced 负数暴露/验证矩阵/403/发号失败整计划
  回滚/404 与 400);`invoices-client.test.ts` +1(成员票的 plan 事实过
  zod)。
- 文档:`docs/billing.md` 分期小节 + 剩余清单更新;`docs/audit.md` 词表 +
  `invoice_plan.created`。

## 判断层(手写)

### 关键判断

1. **计划是实体,约定额是盖章的事实,不是派生状态**。备选:不建表,只在
   invoices 上加 plan 键,「计划总额」从成员合计推导——被否:成员票是草稿,
   行可改、可 void,live 合计会漂;老系统「计划总额没有权威落点」正是它要
   屏幕推导的根因。`invoice_plans.total_cents` 在创建事务里 = 各期之和盖章后
   恒不变,计划读面把「约定 vs 现状」作为 uninvoicedCents 原样暴露(负数 =
   成员被改到超过约定,不 clamp,effectiveDueCents 同裁)。这是快照禁令的
   刻意例外:它不是钱的现状,是「当时说好的数」——同 confirm 审计里的
   totalCents 快照一个性质。

2. **「Part i of n」两半分开:i 是身份,n 是现状**。plan_index 创建时按提交
   顺序落定、永不重编号(void 不重排——被作废的期仍是「这刀切过的事实」);
   n(成员数,**含 void**)读时 COUNT 派生,绝不从调用方手里的行集数出来。
   老系统 BUG-274 的教训反过来用:它错在从「读到了哪几行」推导序数,本内核
   把序数铸进行、把计数交给数据库。在世口径(livePartCount/liveInvoiced)
   是计划读面另答的另一组问题,不与身份混写。

3. **body 里没有「总额」字段**。POST /api/invoice-plans 只收 parts,总额 =
   各期之和由服务端盖章——「拆出来的合计」与「另报的总额」结构性不可能打架,
   少一个对不上的字段就少一类对不上的 bug(RULE-007 的减法应用)。

4. **成员票复用发票的全部动词,零新动词语义**。分期的每期就是一张普通发票:
   confirm 带账期(R-12-7)、收款、void 全部既有闸门原样适用;计划读面的
   逐期付款态直接调 computePaymentStatus + effectiveDueCents,不各算各的。
   集成测试里贷项单读穿计划(冲抵成员票 → 该期 vacuously paid、outstanding
   回落)是这条裁决的验收:分期与红冲在同一个算术宇宙里,不互相发明规则。
   代价:计划读面对 credited 逐票查询(N ≤ 12,N+1 by design)——正确性的
   唯一口径优先于查询高尔夫,量级有 parts 上限兜着。

5. **`installment` expand 进 invoice_type,而非另立枚举或杂项桶**。老系统
   第 8 类同款;它的触发事实是「一个约定总额被切成 n 期」。手工建票的
   z.enum(INVOICE_TYPES) 自动收下它(不设特例)——财务手工开一张分期性质的
   票是老系统的正常用法,不带成员身份而已;系统拆票是唯一写 plan_id/plan_index
   的路径,成员身份的真相源唯一。

6. **无 source 幂等列**(贷项单同裁):当前唯一入口是财务手工拆票;订单域
   (#231)按比例拆期进场时走 createInvoicePlan 服务接缝并 expand 唯一索引,
   届时不需要回填(expand-only)。计划不设「往计划里补一期」动词——那会让
   plan_index 的身份语义(创建时定死)与成员数(n 的派生口径)同时失义;
   真需求出现时应当是新计划,不是旧计划改刀。

7. **一期数量 2–12**:1 期不是分期(手工建票已有那个入口);>12 是融资安排
   不是发票拆分。机械护栏拦误操作,不是业务裁决——真要 24 期先改 zod 并在
   PR 里说清。

### 踩坑

- **新路由必须进 routes/registry.ts 的授权声明清单**。第一次全量 verify 红:
  route-auth.test.ts 的 #23 双向比对(app 实际注册的路由 ↔ 声明清单)抓出
  两条未声明路由。声明后绿。教训:本仓库「每条 /api 路由都有授权声明」是
  测试强制的,新路由文件 + app.ts 挂载之外还有第三处要登记。
- **exactOptionalPropertyTypes 下 RequestInit.body 不收 undefined**:测试
  helper 里 `body: body === undefined ? undefined : JSON.stringify(body)`
  被 TS2379 拒,改成条件展开 `...(body === undefined ? {} : { body: ... })`。
  同类坑此前切片记录过,本次按实际编译器行为处理。
- **一次 verify 的输出自相矛盾**(Tests 1376 passed 且 ELIFECYCLE failed,
  无任何 ✕):重跑 exit 0、日志无 unhandled error,未复现。存疑不记结论,
  CI 是第二道裁决;若复现再立案。

## 验证

全量 `DATABASE_URL=postgres://ally:ally@localhost:5432/ally corepack pnpm
verify`(lint → typecheck → test)全绿 **132 文件 / 1376 测试零 skip**
(基线 131/1365,+1 文件 +11 用例)。migration 0039 随 runMigrations 在
每个临时库上真实执行(ALTER TYPE ADD VALUE 与建表同迁移,未在同事务使用
新值,PG 12+ 安全)。零 as any、零 eslint-disable。
