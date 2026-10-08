---
session_id: hand-written-192-installment-web
branch: feat/192-installment-web
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

# Session log — feat/192-installment-web — 2026-10-09

> 机械层本次由 agent 手写(ZCode 定时迁移会话);判断层为本次会话手写。

## 机械层(自动)

- **引用的 issue**:#192(发票草稿 + 财务确认,phase-2)——剩余清单里「分期
  的 web 面」(上一切片 PR #319 的注释明确预留:API 合同已就绪,分期内核
  `invoice_plans` + POST/GET /api/invoice-plans 已落)。PR 正文写 **Part of
  #192**(触发点接线、客户面提醒、#241 回写、#181 QuickBooks、#128 PDF 等
  未完,保持 open)。
- **前置收尾(第 0 步)**:`git fetch origin --prune`;无 open PR、无残留
  worktree、主检出干净(HEAD = b0183f3,即 #319 分期内核的 merge commit)。
- **选题**:规则①——#192 评论里有明确剩余清单且最近活跃;剩余项逐一过依赖:
  触发点接线被属主域(#238/#231/批次域)阻塞,客户面提醒被 #186 阻塞,
  #241/#181/#128 各自依赖未进场的域,**分期的 web 面是计费域内自洽、API
  合同已就绪、可独立验收的切片**(纯 web:零 API 改动、零 migration)。
- **claim**:`claim_issue.py claim --issue 192` 成功(接替过期租约)。
- **worktree**:`.claude/worktrees/192-installment-web`,分支
  `feat/192-installment-web` 自 origin/main;`corepack pnpm install` 后
  基线 verify 全绿(本地 postgres 在跑,全程零 skip)。

### 本切片改动的文件

- `apps/web/src/shared/lib/invoices-client.ts`:planPartSchema /
  invoicePlanSchema / invoicePlanCreatedSchema(zod,API 响应按外部输入收口);
  InvoicePlan / InvoicePlanPart / InvoicePlanCreated / InvoicePlanResult /
  InvoicePlanActionFailure / InvoicePlanCreateInput / InvoicePlanCreateResult
  类型(409 携带服务端状态码,同动词家族先例);两个适配器(invoicePlan 读
  计划台账、createInvoicePlan 拆票——body 只有 label + parts 金额,没有
  「总额」字段,subject 留给订单域);文件头注释同步。
- `apps/web/src/shared/pages/InvoiceDetail.tsx`:成员票 meta 行带
  `part i of n`(i/n 都是服务端事实);**PlanSection**(仅 `data.plan` 非空
  渲染——计划是成员事实,不是装饰)+ PlanLedger(label、part i of n、
  n 期与在世数、Agreed / Invoiced / Paid / Outstanding 四格全部读服务端
  台账、uninvoicedCents 两个方向的漂移各成一句、逐期行链到各自发票页、
  void 期划线留痕);**计划区刻意零动词**——纪律句「The plan is the
  ledger — confirm, collect and void live on each part's own invoice page」。
  section 位置在行区之后、Payments 之前:计划是「这张票属于哪个约定」的
  语境,先于本票的钱的事实。
- `apps/web/src/shared/pages/Invoices.tsx`:筛选行右侧新增「Split into
  installments」;CreatePlanDialog(label 必填 + 2–12 期金额行,精确字符串
  解析、无总额字段、合计超 int4 表单层先拒);planActionError——409
  numbering_not_configured 逐码成句(修复动作是配置,不是重试);成功
  flash 报服务端盖章的约定额与全部期号;行 meta 带 `part i of n`。
  对话框外壳在本页本地持有(SignatureDialog 先例:各对话框自带 overlay
  chrome,不为第二处使用做提前抽象)。
- 测试:`invoices-client.test.ts`(+5 例,fake fetch——端点与 body、404/403/
  junk 分类、409 numbering 透传、死网 unavailable);`invoices-page.test.ts`
  (+9 例,源文本——端点、section 仅成员票渲染、状态齐全、part i of n 不
  在客户端推导、漂移双向成句、计划零动词、拆票对话框纪律、numbering 句)。
- 文档:`docs/billing.md` 分期小节补「web 面已落」、剩余清单第 4 条同步。

### 验证

- 全量 `DATABASE_URL=… corepack pnpm verify`(lint → typecheck → test)
  全绿:**132 文件 / 1390 测试,零 skip**(基线 132 / 1376,+14 用例,零
  新文件——本切片只落 web 面)。
- 首轮全量有一处 `apps/worker/src/rules/effect-digest.test.ts` afterAll
  钩子超时(pool.end / drop database 30s);单跑 2.4s 全过,全量重跑绿——
  基础设施抖动,非代码问题。零 as any、零 eslint-disable。

## 判断层(手写)

### 关键判断

1. **计划台账长在成员票详情页,不新开路由**。备选:独立路由
   `/invoice-plans/:id`——被否:计划没有任何「不经过成员票就能到达」的入口
   (API 只有按 id 读,没有列表端点;拆票动作创建后 flash 直接报期号),为
   唯一入口造一个顶级路由是在给导航添第二个答案。详情页已有 section 家族
   (Payments / Credit notes),Installment plan 作为第三员,queryKey 挂在
   `["invoices"]` 前缀下——成员票上的任何动词 invalidate 时计划台账一起刷,
   约定 vs 现状永远不会看到陈旧值。
2. **计划区刻意零动词**。逐期就是普通发票,confirm/收款/void 的全部闸门
   (R-12-6、R-12-7、作废留痕)都在各期自己的页面原样生效——在计划区复刻
   这些按钮等于发明第二套动词面,两处 UI 迟早漂移。计划区回答的问题只有
   一个:「这个约定切成了什么、走到哪了」。逐期行的箭头(链接)是唯一的
   动作——去那张票的页面做那张票的事。
3. **section 只对成员票渲染,而不是渲染但显示空**(CreditNotesSection 只对
   issued 渲染同裁)。plan 为 null 的票(手工票、其他触发点的票)名下没有
   计划,渲染一个「不属于任何分期计划」的空区块是在说一句永远为真的废话。
   区块的出现本身就是信息:看见 Installment plan 区 = 这张票是一次拆票的
   其中一刀。
4. **uninvoicedCents 两个方向各成一句,不合并成一条中性的「有差异」**。
   内核的裁决是漂移原样暴露不 clamp(>0 有期被作废/行被改少,<0 行被改到
   超过约定);两个方向对财务是完全不同的下一步(前者找作废的期、后者查
   谁改了行),合并成一句话就是把两个问题揉成一团雾。0 不显示——没漂移就
   没有要说的。
5. **拆票对话框在列表页而不是详情页**。拆票不属于任何一张已有的票——它
   创建 n 张新票。发票列表是财务的计费工作台(待确认草稿的主读法也在
   这),拆票动作放这里与读法同屏:拆完 flash 报出全部期号,成员草稿就落
   在缺省的 Draft 筛选里,「拆出来就等确认」一眼可见,不需要跳页。
6. **客户端镜像服务端准入,但不镜像服务端的算术**。2–12 期、逐期正数、
   合计 ≤ int4 是 createBody 的 zod 准入,表单层先拒(parseDueInDays 同裁
   ——注定失败的提交死在表单不过网络);但「约定总额」这个数客户端既不算
   也不显示,RULE-007 的减法应用:合计检查是为准入做的一次性数值比较,
   不是展示——展示出来的数字必须是服务端盖章的(成功 flash 里的
   totalCents 来自 201 响应)。
7. **CreatePlanDialog 的外壳在本页本地持有,不抽共享组件**。InvoiceDetail
   的 DialogFrame、SignatureDialog 的 overlay chrome 各自持有同款样式——
   本仓库的先例是重复而非提前抽象。为第二处使用把 DialogFrame 挪进
   shared/components 是一次「顺手重构」,本切片不做;第三个消费者出现时
   再抽,那时才知道抽什么。

### 踩坑

- **源码级测试断言要对齐 JSX 换行**(上个 session log 记过,这次又踩了一
  次):`toContain("The total is stamped by the server from the parts")` 红,
  因为 JSX 文案里这个短语跨了行。断言改成单行内真实存在的片段
  ("The total is stamped by the" / "stamped by the server")。教训升级:
  写源文本断言时先看文案在源码里断在哪一行,不要凭渲染后的句子猜。
- **一次编辑事故当场修复**:给 InvoiceDetail 插入 PlanSection 时
  Edit 的 old/new 写错,把 DialogFrame 函数体截断(tsc 立即红)。下一个
  Edit 完整补回并插入新组件。教训:大文件插入组件时,old_string 锚点选
  「完整的小节边界」,不要手写被替换函数的签名行。
- **工具调用不继承 shell 的 cwd**(前两期 session log 同款,提前规避):
  本次所有 Read/Edit/Write 一律带 worktree 绝对路径
  (`d:\Code\ally-os-node\.claude\worktrees\192-installment-web\…`),没有
  重演「编辑落在主检出」的事故。
- **全量 verify 的 afterAll 超时**:effect-digest.test.ts 首轮在清理钩子
  (pool.end + drop database)超时 30s,单跑与全量重跑均绿。与 #313/#319
  记录的 runner 侧抖动同族,本地版是 Windows 上 postgres 连接回收慢。
  存疑不记结论,CI 是第二道裁决。

## 验证

全量 `DATABASE_URL=postgres://ally:ally@localhost:5432/ally corepack pnpm
verify`(lint → typecheck → test)全绿 **132 文件 / 1390 测试零 skip**
(基线 132/1376,+14 用例,零新文件)。零 as any、零 eslint-disable、零
新依赖。CI:见 PR(github.com/lx307697527/ally-os-node)。
