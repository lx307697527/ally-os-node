---
session_id: hand-written-192-finance-invoice-page
branch: feat/192-finance-invoice-page
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

# Session log — feat/192-finance-invoice-page — 2026-10-08

> 机械层本次由 agent 手写(ZCode 定时迁移会话);判断层为本次会话手写。

## 机械层(自动)

- **引用的 issue**:#192 剩余清单第 4 条「财务确认页(web;落地时把 payment.*
  两类告警进白名单并深链)」(docs/billing.md 剩余④同文)。PR 正文写
  **Part of #192**(#192 尚余触发点接线/提醒/回写/QuickBooks/PDF/红冲与收款
  动作 web 面,保持 open)。
- **前置收尾(第 0 步)**:无 open PR(#310 已于昨日合并,即 main 顶端
  53b53b2)、无残留 worktree、主检出干净。fetch --prune 清掉已合并远端分支
  feat/220-workflow-timeout-notify。
- **选题**:①优先续做有未完成切片的 open issue。候选盘点:#220(余项全部
  路由到属主域 #227/#231/#243、通用面板、#206)、#233(余项路由到
  #220/#206/#223 与格内高亮打磨)、#110/#113/#116/#219/#221/#222/#224/#226
  /#225(余项均阻塞在 ops 域/#118/#30/#115 SMS/RBAC/设计选型)、**#192
  (剩余④财务确认页——API 半边已全部就绪,无阻塞,且兑现 #193 留下的
  白名单承诺)**。选 #192。
- **claim**:`claim_issue.py claim --issue 192` 成功(原子租约;前一会话租约
  已正常释放)。
- **数据库**:本地 postgres 可用(5432,PG 16.15),verify 全程带
  DATABASE_URL,**126 文件 / 1264 测试零 skip**(基线 124/1230:+2 文件
  +34 测试)。

### 本切片改动的文件

- `apps/web/src/shared/lib/invoices-client.ts`(新):zod 收口发票/行/收款
  台账三个读法形状;适配器 list(带 status 筛选)/get/payments/updateLines
  (整体替换)/confirm/void;失败模式分相(forbidden/notfound/conflict+机器
  码/unavailable);`formatMoney`(从 billing/payment-alerts.ts 逐字移植,
  铃铛/列表/详情一个格式)、`parseDollarsToCents` 与 `parseQuantity`(纯
  字符串精确换算,浮点永不碰金额)。
- `apps/web/src/shared/pages/Invoices.tsx`(新):列表页——draft 默认筛选
  (「待确认发票」= 财务主读法),五种读状态各有各的话,行号链详情。
- `apps/web/src/shared/pages/InvoiceDetail.tsx`(新):详情页——头/金额块/
  行表(生成列合计只展示)、确认发出对话框(亮出承诺金额)、作废对话框
  (可选 reason)、草稿行编辑器(整体替换、不显示客户端算的合计)、收款
  台账(只读,void 行划线留痕);409 逐码成句。
- `apps/web/src/App.tsx`:两条路由(/invoices、/invoices/:invoiceId),
  Billing 区第一个页面。
- `apps/web/src/shared/shell/rail-groups.ts`:billing 组从空注记变为实项
  (note 换成现在时的事实——空组注记的「Arrives」纪律)。
- `apps/web/src/shared/lib/notification-face.ts`:`payment.attempt_failed` /
  `payment.unbookable` 进白名单,face 沿用 payload 的服务端文案,深链
  `/invoices/:id`(aggregate);无锚点 href null。
- docs:billing.md 新增「财务确认页」节 + 剩余清单更新;notifications.md
  收款告警的白名单裁决由「刻意不进」改写为「已进 + 规则」。
- 测试:`invoices-client.test.ts`(行为级,fake fetch:端点/失败分相/409 带
  码/纯函数矩阵)、`invoices-page.test.ts`(源码级:端点/状态 testid/纪律
  上墙/wiring 三方对齐)、`notification-face.test.ts`(白名单形状 + 两类
  收款告警的 face 与无锚点 null)、`notification-href-routes.test.ts`
  (payment 事件夹具 + /invoices/:invoiceId parity 钉住)。

## 判断层(手写)

### 关键判断

1. **选题:续做 #192 而不是开新 issue**。#220/#233 看似最近活跃,但剩余项
   已全部路由到别的 issue(属主域/#206/#223),硬做就是越界替别人裁设计;
   #192 剩余④的依赖面早已就绪(发票内核 #300、收款内核 #303、两渠道
   #304-#308、告警 #308),而且 #308 落告警时立了约:「白名单等发票页落地」
   ——本切片同时兑现两个 issue 的承诺,是优先级①里唯一「能整片干净落地」的。

2. **切片边界:确认面,不是收款面**。发票详情页只带只读收款台账,不带手工
   记账表单/收款作废/Stripe·PayPal 收款链接按钮——「财务确认页」是 R-12-6
   的闸门面(核对→发出/作废/改草稿);记账与收款链接是确认之后的下一个动词
   家族(API 已就绪,列进 billing.md 剩余)。切片按业务动词家族切,不按
   「一个页面把所有按钮堆齐」切——否则验收标准说不清,PR 也审不动。

3. **编辑面不算合计(把 RULE-007 裁到 UI 上)**:行合计是 DB 生成列、服务端
   唯一权威;编辑器若顺手算个「预览合计」,用户就会拿它当承诺——浮点与四舍
   五入的每一处分歧都是一次信任损耗。编辑面只收数量与单价,保存后让生成列
   的答案说话;对话框里亮出的金额来自服务端读法,不是客户端算术。

4. **金额输入走纯字符串换算**:老系统 `Number(value) * 100` 的浮点乘法是
   #307 刻意抛弃过的(PayPal 渠道 "8.45" 换算),web 输入面同裁——
   `parseDollarsToCents` 用正则拆整数/小数部做整数运算,「1,500.50」这类带
   千分位的输入先去逗号再验形;不合法的形状返回 null 在表单里拒绝,不送
   API 挨 400。

5. **收款告警的 face 不二次拼句**:payment-alerts 的 payload 自带服务端从
   银行事实拼好的 title/detail(两渠道共用一份文案内核),web 白名单面原样
   亮出、只补深链——客户端重拼一遍文案必然漂移(RULE-010 的事实组装只在
   生产者一侧发生)。无锚点行 href null 与兜底面同义:不猜去处。

6. **rail 组的 note 是合同**:billing 从空组变实项,「Arrives with the
   finance module」这条过去时注记立即成为谎言(rail-groups.test.ts 的既定
   纪律:空组注记说将来,组满注记退场)——note 换成现在时事实
   「The finance back office — …; refunds and QuickBooks follow」,把组内
   还没有的东西如实说成 follow。

### 踩的坑

1. **源码级测试断言的是文件原文,不是渲染结果**:invoices-page.test.ts 第一
   版断言对话框文案「An issued invoice can no longer be edited」,实际 JSX
   里 An 和 issued 之间隔着换行与缩进,toContain 当场红。源码断言要对齐
   JSX 的换行现实——断言挑短语,别挑跨行整句。

2. **可辨识联合的收窄要在类型上做,不是在运行时猜**:`verbError(result)` 先
   写成了收 `InvoiceVerbResult` 全体,函数体直接摸 `.reason`/`.code`——
   typecheck 六个 TS2339 当场红。正确做法是参数收
   `Exclude<InvoiceVerbResult, { ok: true }>`,让「只有失败分支才有 reason」
   在签名上成立。

3. **eslint 的 prefer-optional-chain / no-unnecessary-boolean-literal-compare
   是本仓库的实际门**:`x !== undefined && x.ok === false` 要写成
   `x?.ok === false`(语义相同:undefined 时可选链结果是 undefined,
   与 false 比较为假)。两个 lint error 都在第一版里,--fix 可修的那个修了,
   语义等价的那个手改。

4. **worktree 里 docker compose up 会新建项目名隔离的容器**:compose 项目名
   带目录前缀,worktree 目录起的 postgres 想绑 5432 撞上主检出已跑的实例
   ——好在 5432 本来就有主检出的 postgres 在服务,直接连 postgres://ally:
   ally@localhost:5432/ally 即可(packages/db 依赖树里自带 pg 驱动,系统
   没有 psql 也能验)。多 worktree 共享一台本地库是常态,scratch DB 的
   隔离由各测试套件自己管(invoices/payments 测试各用独立 scratch 库)。

### 验收对照(本切片范围:#192 剩余④「财务确认页」半边)

- [x] 财务有「待确认发票」的主读法:列表默认 draft 筛选(集成于 API 已测的
      GET /api/invoices?status=draft;页面测试钉住默认值)
- [x] 核对后发出:确认对话框亮金额、说明发出后行锁定;重复确认幂等回 already
- [x] 可修改:草稿行整体替换编辑器(端点 PATCH 已有 API 级测试;页面测试钉住
      「不算合计、整体替换、逐行校验」)
- [x] 可作废:作废对话框(可选 reason,幂等,API 级语义不变)
- [x] payment.* 两类告警进白名单并深链:notification-face / href-parity
      测试钉住(/invoices/:invoiceId 对着 App.tsx 注册路由校验)
- [x] 收款台账只读上页(void 行划线留痕、附加费单列)
- [ ] 触发点接线/提醒/回写/QuickBooks/PDF/红冲(#192 剩余清单原样保持)
- [ ] 收款动作 web 面(手工记账/收款作废/收款链接按钮)——下一个收款切片
