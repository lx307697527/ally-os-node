---
session_id: hand-written-193-card-surcharge
branch: feat/193-card-surcharge
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

# Session log — feat/193-card-surcharge — 2026-10-08

> 机械层与判断层均为本次会话手写(ZCode 定时迁移会话,接续
> 2026-10-08-feat-193-stripe-payments.md 留下的剩余清单)。

## 机械层

- **引用的 issue**:#193(Stripe 在线支付发票,phase-2)。PR 正文写
  **Part of #193** 并注明也挂 **Part of #192**(发票剩余清单第 2 条的
  「附加费 R-12-2/3」半边);#193/#192 均保持 open。
- **前置收尾(第 0 步)**:无 open PR、无残留 worktree、主检出干净(与
  origin/main 同步在 261af22,即昨日 #305 的 squash)。
- **选题**:①优先续做未完成切片。候选盘点:#233(余项 JDM 编辑器 + 两项随
  #206/#220)、#192/#193(附加费标注「接缝已就绪」)、#113(余项等 #118)、
  #222(等 §16 设计裁决)、#226(等 #206)。选 #193 的附加费消费切片——
  #303/#304 的评论两次点名「#233 已就绪」。
- **claim**:`claim_issue.py claim --issue 193` 成功。
- **数据库**:本地 postgres 可用(docker compose),verify 全程带
  DATABASE_URL:**119 文件 / 1123 测试零 skip**(基线 119/1107,+16 测试,
  无新测试文件——全部长在既有 billing/routes 两个套件里)。

### 本切片改动的文件

- `apps/api/src/billing/surcharge.ts`(新):R-12-2/3 的纯函数面——
  `computeSurchargeCents`(费率先量化到基点再整数分运算)、
  `splitSurchargedCapture`(webhook 对账:无键 = 存量普通会话;拆分 ≠ 实扣、
  半申报、非正整数四种命名拒绝,老系统 surcharge_split_test 同名案例全部随行)、
  `surchargeRateSchema`(消费方 zod 收口 0–5%)、metadata 两键常量(写读同源)。
- `apps/api/src/billing/stripe.ts`:CheckoutSessionInput 增可选
  `surchargeCents`(网关写实扣额 = principal + fee,拆分搭 metadata 回去;0 =
  普通会话,不写键);normalizeStripeEvent 在金额读出后做拆分对账,拒绝 →
  unparsable(502),归一结果的 `amountCents` 语义收敛为 principal,另带
  `surchargeCents`。
- `apps/api/src/billing/payments.ts`:RecordPaymentInput 增可选
  `surchargeCents`(webhook 专属;手工记账不收费);台账读法行带 surchargeCents。
- `packages/db/src/schema.ts` + `0033_great_giant_girl.sql`(db:generate 产物):
  payments.surcharge_cents 可空 integer + CHECK > 0(expand-only;NULL = 无
  附加费,「没有」与「算了 0」两态不可并存)。表注释第 4 条:amount_cents 恒为
  结清额,附加费单列,发票面不变(FEAT-581 裁决)。
- `apps/api/src/routes/stripe-checkout.ts`:读
  `payments.card_surcharge_pct`(getRule + 消费方 zod)→ 算附加费 → 传网关;
  三种读不出 → 409 `surcharge_rule_unusable` fail closed(细节进日志);响应
  `amountCents` 改实扣 gross + `principalCents`/`surchargeCents`;审计
  `invoice.payment_link_created` 同构。
- `apps/api/src/routes/stripe-webhook.ts`:principal 入账、费成分随行
  (recordPayment + payment.recorded 审计 detail,有则记);502 文档扩一条
  「拆分对不上」。
- docs:billing.md「附加费拆分(R-12-2/3)」专节(三裁决/费率面/契约变化表/
  剩余更新)、audit.md(payment.recorded 增 `surchargeCents` 有则记;
  payment_link_created 记实扣额 + 拆分快照)。
- 测试:`billing/stripe.test.ts` +12(computeSurchargeCents 的 bp 量化与
  kill-switch、splitSurchargedCapture 四拒绝、归一 principal/fee 携带、网关
  metadata 写与省略)、`routes/stripe.test.ts` +4(checkout 实扣额披露 +
  0% 关闸 + 规则不可用 409;带费入账全链「费不碰发票面」;对不上/半申报
  502 零副作用)。既有断言随 gross 语义更新(checkout 150000 → 155850)。

## 判断层(手写)

### 关键判断

1. **老系统 FEAT-581 的承重裁决原样带过来:发票面金额不变,费单列**。
   老 migration 的论证是五处「已收多少」的投影都读 `Σ amount`——把实扣额存进
   amount 就是 FEAT-550 形状的坑(一个写入、五个投影被甩下,客户看到的余额和
   实付对不上)。新系统没有把这个教训当历史,而是当结构:`payments.amount_cents`
   的语义钉死为「结清额」,paid 派生(computePaymentStatus)、#241 发货门槛、
   #181 QuickBooks 全部只读它,没有一个读法需要学会扣费。`surcharge_cents`
   是「收银条上多出来的那行」,不是 amount 的修饰。

2. **拆分拒绝在归一层,不在记账层**(与老系统的一处刻意分叉,想清楚了才分)。
   老系统只在入账分支调 splitSurchargedCapture,无锚点(非本系统 session)的
   投递直接 ack;本切片把对账放进 normalizeStripeEvent——拆不开的钱连「结清
   多少、费是多少」都说不清,锚不锚都一样不确认。推过另一头(无锚点且拆分
   成立 → 照旧 200 ack 留给 #181 认领):一条测试都没有新增行为变化,而
   「带拆分键却无发票锚点」的 session 只可能是手工在 Stripe 侧拼的,响声大
   (502 重投)比埋进认领队列诚实。

3. **0% 是关闸,由「会话形状」承载,不由 webhook 的开关感知**。费率为 0 时
   不写拆分键 → session 与存量会话完全同形 → webhook 的四条拒绝天然不触发。
   这与「0 不是没有附加费」的列语义互补:DB 层拒绝「算了 0」的行,会话层
   不产生「算了 0」的会话——两态不可并存在两边各自成立,中间没有一面要
   特判 0。

4. **消费方边界 0–5% 是机械护栏不是业务裁决**。老系统 card_payment_policy 的
   0–500bp CHECK 同一位置:注册表写面只有一个 `z.number()`(域无关,这是
   #233 的设计),「管理员手滑多打个零」只能在消费方拦——拦的方式是 409
   `surcharge_rule_unusable`(修复动作是去配置工作室,numbering_not_configured
   同一先例),不是静默按 0 处理。3.9% 本身带着 ⚠(可能超卡组织 3% 与州上限,
   业主知情维持)——种子行的 risk_flag/risk_note 在 0021 就落好了,本切片
   只是第一个消费者。

5. **PayPal 不顺手一起做**。`payments.paypal_surcharge_pct` 种子已在,但
   PayPal 渠道(验签轨道、事件形状、sandbox)是独立的一片;一个周期一个
   可独立验收的切片。本切片把「同一接缝」兑现成:PayPal 进场时读自己的
   规则键、复用同一个 splitSurchargedCapture 与同一条 recordPayment 路径,
   零额外接缝。

### 踩的坑

1. **zod v4 的 `.finite()` 已废弃**(z.number() 默认拒 Infinity/NaN)——lint
   的 no-deprecated 抓的。仓库在 zod v4,写消费方 schema 时按 v4 语义,
   不要按 v3 记忆补链式方法。

2. **3.995 的量化陷阱**:3.995 的 float64 表示偏上,×100 后是
   399.50000000000006 → round 出 400bp 而不是「该有的」399。测试例子换成
   二进制可精确表示的 4.25(→425bp),并在 surcharge.ts docblock 写明:
   费率第三位小数在 bp 量化中丢弃、两位小数是定义精度——浮点边界的具体行为
   不进断言,进文档。

3. **Windows 探活**:Git Bash 无 psql,`node -e "net.connect(5432)"` 探端口
   足够;本地 postgres 是 docker compose 常驻(非本次会话起的,不要顺手
   stop)。`psql postgres://… -c "select 1"` 这种命令在这台机器上写进脚本
   会挂。

4. **exactOptionalPropertyTypes 下的可选入参**:路由给网关传
   `surchargeCents` 用条件展开(`...(n > 0 ? { surchargeCents } : {})`)
   而不是显式 undefined——后者在 exactOptionalPropertyTypes 下类型不符,
   而且语义上「键不存在」与「键存在但 undefined」在本切片就是两个事实
   (会话形状)。

5. **主检出与 worktree 同名文件**:Read 主检出的 stripe.ts 之后直接 Edit
   worktree 副本会被工具拒绝(文件状态按路径记)。worktree 流程里所有
   编辑前先 Read worktree 自己的那份,别省这一步。
