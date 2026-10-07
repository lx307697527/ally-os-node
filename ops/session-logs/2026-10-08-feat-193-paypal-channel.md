---
session_id: hand-written-193-paypal-channel
branch: feat/193-paypal-channel
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

# Session log — feat/193-paypal-channel — 2026-10-08

> 机械层与判断层均为本次会话手写(ZCode 定时迁移会话,接续
> 2026-10-08-feat-193-card-surcharge.md 留下的剩余清单)。

## 机械层

- **引用的 issue**:#193(Stripe 在线支付发票,phase-2)。PR 正文写
  **Part of #193** 并注明也挂 **Part of #192**(发票剩余清单第 2 条的
  「PayPal 渠道」半边);#193/#192 均保持 open。
- **前置收尾(第 0 步)**:fetch 后无 open PR、无残留 worktree、主检出干净
  (与 origin/main 同步在 d1add92,即昨日 #306 附加费切片的 squash)。
- **选题**:①优先续做未完成切片。候选盘点:#192/#193(剩余明确:#193 ②
  「PayPal 渠道——同一接缝,sourceType paypal,读 paypal_surcharge_pct,
  splitSurchargedCapture 与 recordPayment 路径零改动复用」)、#233(余项
  JDM 拖拽编辑器重 UI + 两项随 #206/#220)、#224(余项等 SMS/#118)、
  #226(等 #206)、#29(余项接线在 #227)。选 #193 的 PayPal 渠道切片——
  剩余清单点名、接缝已就绪、可独立验收。
- **claim**:`claim_issue.py claim --issue 193` 成功(接管原子租约)。
- **数据库**:本地 postgres 可用(docker compose 常驻),verify 全程带
  DATABASE_URL:**121 文件 / 1170 测试零 skip**(基线 119/1123,+2 文件
  +47 测试)。

### 本切片改动的文件

- `apps/api/src/billing/paypal.ts`(新):渠道内核——`PayPalGateway`
  (createOrder:client-credentials 令牌 → POST /v2/checkout/orders,实扣额进
  amount、锚点与拆分声明坐 custom_id;captureOrder:POST …/capture,
  ORDER_ALREADY_CAPTURED 归一为 already_captured)+ `PayPalWebhookVerifier`
  (token → POST /v1/notifications/verify-webhook-signature,五根 transmission
  头 + webhook_id + 原事件,非 SUCCESS/形状读不出全部 fail closed)+
  `normalizePayPalEvent`(CAPTURE.COMPLETED → payment/APPROVED →
  capture_request/退款拒绝类 → ignored)、`parseCustomId`(裸形式 = 空声明;
  p=/s= 各恰一段,半申报/重复 = null,段值验证交给 splitSurchargedCapture)、
  `payPalAmountToCents`(十进制字符串 → 整数分,正则拆部纯整数运算)、
  `centsToPayPalAmount`(反方向,同精度)、`PayPalChannel` 注入面。
- `apps/api/src/routes/paypal-checkout.ts`(新):财务过渡面
  POST /api/invoices/:id/paypal-checkout——与 stripe-checkout.ts 同构
  (issued 门、$0 拒、`payments.paypal_surcharge_pct` 消费方 zod 收口、
  0% 关闸、surcharge_rule_unusable 409),审计沿用
  `invoice.payment_link_created`(detail 带 provider/orderId)。
- `apps/api/src/routes/paypal-webhook.ts`(新):provider 面
  POST /api/webhooks/paypal,挂在会话中间件之前——transmission 头缺失/
  验签不过 401 零副作用、坏 JSON 400(验签要吃解析后的事件)、CAPTURE.
  COMPLETED 记账(recordPayment source ("paypal", captureId)+ payment.
  recorded 审计同事务;PaymentExistsError → 200 replay;状态门 → 502)、
  APPROVED → 服务端 capture 决策(见判断层 1)。
- `packages/config/src/index.ts`:PAYPAL_CLIENT_ID/CLIENT_SECRET/WEBHOOK_ID
  (三者成组,缺一启动即失败)、PAYPAL_API_BASE(留空 = 生产,沙箱注入
  sandbox 域)、启用即要求 WEB_APP_URL(Stripe 同裁)。
- `apps/api/src/billing/surcharge.ts`:+ `PAYPAL_SURCHARGE_RULE_KEY`
  常量(与卡片费率刻意两个键);card 侧注释的「进场时」改为现状。
- 接线:`apps/api/src/app.ts`(AppDeps.paypal;webhook 挂会话中间件前、
  checkout 挂 2FA 门后)、`apps/api/src/index.ts`(三变量齐 + WEB_APP_URL
  才建渠道)、`apps/api/src/routes/registry.ts`(+2 行路由册)、
  `route-auth.test.ts`(public allowlist + /api/webhooks/paypal)、
  30 个既有测试文件的 createApp 夹具补 `paypal: undefined`。
- `.env.example`(+4 变量,含 webhook 端点路径注释)、`docs/billing.md`
  (「PayPal 渠道」专节:载体裁决/活体验签/金额精确换算/webhook 驱动
  capture/费率面/端点表;剩余清单第 2 条更新)、`docs/audit.md`
  (payment.recorded 词条扩成 Stripe/PayPal 双渠道;payment_link_created
  记 orderId/provider)。
- 测试:`billing/paypal.test.ts`(新,21:金额换算含 8.45 浮点陷阱、载体
  四拒绝、归一全分支、网关订单形状/令牌 Basic/四类失败、capture
  already/失败、验签五字段与 fail-closed 四分支)、`routes/paypal.test.ts`
  (新,22:checkout 全门 + 订单形状断言 + 0% 关闸 + 规则不可用;webhook
  全链记账/拆分入账/重放幂等/草稿 502→confirm→重投 200/void·未知 502/
  无锚点 ack/对不上 502/退款忽略/五根头逐一缺失 401/坏 JSON 400/405/
  misconfigured;APPROVED capture 四态)。

## 判断层(手写)

### 关键判断

1. **capture 的归属是本切片最大的结构决定:webhook 驱动,不做第二个
   capture 路径**。老系统由门户回跳页的服务端 capture(BUG-121);本系统
   门户还没建(#186),若照搬「capture 留给门户切片」,渠道的 happy path
   就是一次死链——客户批准后永远没人扣款,比不发货更糟。改为收到验签过的
   CHECKOUT.ORDER.APPROVED 后由服务端 capture,渠道即刻端到端可用;将来
   门户进场**只做展示**(#193 要点原文「付款状态以 webhook 为准,前端结果
   只用于提示」),不新增 capture 面。重试语义借 PayPal 自己的重投:
   capture 网络失败回 502 → APPROVED 重投(约 3 天)→ 重试,与订单有效期
   同量级,自然收敛;ORDER_ALREADY_CAPTURED 是重放不是错误。
   fail-safe 门:APPROVED 上找不到我们的锚点或票不在 issued → 不 capture
   直接 ack——这里钱还没动,502 重投一个「正确动作是什么都不做」的投递
   只会空转;与 CAPTURE.COMPLETED 上「present-but-invalid → 502 响」的
   刻意不对称,分界线就是「钱是否已经动了」。

2. **「零改动复用」的兑现方式:把 PayPal 的载体翻译成 Stripe 的形状,
   而不是让对账逻辑长出第二个实现**。剩余清单承诺 splitSurchargedCapture
   与 recordPayment 零改动复用;custom_id 的 `;p=;s=` 声明解析成 Stripe
   metadata 的同两个键(principal_amount_cents/surcharge_amount_cents),
   四种命名拒绝一字不改地管住第二条渠道。老系统两处读法各写一份
   (stripe 读 metadata、paypal 读 custom_id),格式漂移的风险在结构上
   不存在了。custom_id 本身仍是老系统的载体裁决(items 活不到 capture 上、
   purchase_units[].invoice_id 有 DUPLICATE_INVOICE_ID 陷阱)。

3. **金额换算不带老系统的浮点乘法**。老系统 `Number(value) * 100` 对
   "8.45" 会得到 844.999…,再 round 回 845——对账等式两侧跑在两个算术
   世界里。新读法正则拆整数/小数部做纯整数运算,round-trip 测试钉死
   (含 0.29/8.45 两个二进制不可精确表示的代表);订单侧 centsToPayPalAmount
   同一纪律。这是「钱的对账等式必须单精度世界」的又一次落地(与附加费
   基点量化同一家族)。

4. **验签没有本地重放窗,是平台事实不是疏漏**。Stripe 轨道的 300 秒窗
   防的是「HMAC 证明字节来源但不证明现在」;PayPal 没有共享密钥签名,
   transmission_time 的新鲜度由 verify-webhook-signature 的服务端把守,
   本侧唯一的重放防线是 (source_type, source_key) 唯一索引——它恰好
   也是最硬的一道。不照搬一个在本地无意义的数字。

5. **费率两键的坚持**:`payments.paypal_surcharge_pct` 与卡片费率刻意
   不共用一个键(0021 里各自有种子)。卡组织规则与 PayPal 费表互不相干,
   「先用同一个键、将来要拆再说」会让那次拆分变成数据迁移;0021 当初
   种两个键是对的,本切片只做消费者。

### 踩的坑

1. **给 30 个既有测试文件补 `paypal: undefined` 用 perl 批量替换,
   `\s*$` 会吞换行**:捕获组里带 `\s*` 时,替换串里手动拼的 `\n` 加上
   被吞的换行产生了合并行(`paypal: undefined,    logger,`)和孤立空行,
   还顺带吃掉一处 `});` 的缩进。第二次修复又误伤了同名 `res`(三个
   `app.request` 的 Response.json 是方法、`deliverWebhook` 的 json 是
   属性——同名不同型)。教训:跨文件的机械修改之后,先 `git diff` 逐文件
   扫一遍再跑 typecheck/lint,别让批量脚本的输出直接进提交。

2. **hono 的 Context 类型别从 `Hono["fetch"]` 反推**:
   `Parameters<Parameters<Hono<AppEnv>["fetch"]>[1]>[0]` 解析成 never;
   正确做法是 `import type { Context } from "hono"` + `Context<AppEnv>`。
   另外 AppDeps 里收窄过的可选渠道(`deps.paypal === undefined` 早退之后)
   传给闭包外的 helper 时会丢失收窄——作参数传入而不是在 helper 里重取。

3. **zod v4:`.passthrough()` 已废弃**,报 no-deprecated;写 loose 形状用
   `z.looseObject({...})`(与上一切片 `.finite()` 废弃同一族——v3 记忆
   的链式方法在这仓库一律先查 v4)。

4. **eslint 的 no-base-to-string 管测试代码**:`String(init?.body)`
   (BodyInit 可能是对象)会被拦,确定只传字符串时用 `as string` 收窄;
   `delete obj[computedKey]` 也被禁(no-dynamic-delete),用
   `Object.fromEntries(Object.entries(...).filter(...))` 表达「去掉一根头」。

5. **Windows Git Bash 下 `grep -rln` 输出反斜杠路径**,直接喂给 while/perl
   会打不开文件——先 `tr '\\' '/'`(这台机器的常规操作,与上一会话的
   psql 缺失同属环境账)。
