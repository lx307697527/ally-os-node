session_id: hand-written-193-stripe
branch: feat/193-stripe-invoice-payments
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

# Session log — feat/193-stripe-invoice-payments — 2026-10-08

> 机械层本次由 agent 手写(ZCode 定时迁移会话);判断层为本次会话手写。

## 机械层(自动)

- **引用的 issue**:#193(Stripe 在线支付发票,phase-2,#232 §10「Stripe /
  PayPal 以 webhook 为准,幂等记账并自动匹配发票」)。PR 正文写
  **Part of #193**(门户发票页/归属校验/真 Stripe 测试环境 E2E 未完,保持 open)。
- **前置收尾(第 0 步)**:无 open PR(#303 已于昨日 16:49 squash 合并,即
  main 顶端 7424aa8)、无残留 worktree、主检出干净。
- **选题**:①优先续做有未完成切片的 open issue。候选盘点:#226(余项阻塞在
  #206/配置工作室 UI 随真实需求)、#225(Superset 部署 + 模板管理等 #128)、
  #222(表单构建器等 #232 §16 设计裁决/消费域)、**#193(#303 收款内核评论
  明确铺好接缝:「验签后调 recordPayment 传 source 即可」)**。选 #193。
- **claim**:`claim_issue.py claim --issue 193` 成功(原子租约)。
- **数据库**:本地 postgres 可用(docker compose 的 ally-os-node-postgres-1,
  MinIO 镜像拉不动但测试用注入假 storage 不需要),verify 全程带 DATABASE_URL,
  117 文件 / 1097 测试零 skip(基线 115/1063:+2 文件 +34)。

### 本切片改动的文件

- `packages/config/src/index.ts`:`STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET`
  (成对校验,Google 同裁)+ 「渠道启用即要求 WEB_APP_URL」(checkout 回跳必须
  绝对地址)。`.env.example` 同步(含 webhook 端点路径注释)。
- `apps/api/src/billing/stripe.ts`(新):`StripeGateway` 域内接口 +
  `createStripeGateway`(fetch 适配器,表单编码 POST checkout/sessions,响应
  zod 收口——无 SDK,mailer 同裁)、`verifyStripeSignature`(先验签后解析、
  node:crypto 常数时间比较、多 v1 候选、300 秒重放窗双向拒绝、NaN 正向提问)、
  `normalizeStripeEvent`(信封 zod;paid 三事件 completed/async_succeeded/
  succeeded;externalId = payment_intent ?? 对象 id;金额 = amount_received ??
  amount_total;received_at 钟差夹到 now;metadata 缺席 vs 非 UUID 分流)。
- `apps/api/src/routes/stripe-checkout.ts`(新):POST
  /api/invoices/:id/stripe-checkout(invoices.manage)。金额 = 服务端实时合计,
  body 无金额字段可传;$0 票 409 nothing_to_collect;draft/void 409 同收款门;
  审计 `invoice.payment_link_created`;成功/取消回跳 =
  `${WEB_APP_URL}/portal/invoices/:id`(带 {CHECKOUT_SESSION_ID} 占位符)。
- `apps/api/src/routes/stripe-webhook.ts`(新):POST /api/webhooks/stripe,
  app.ts 挂在会话中间件**之前**(Stripe 无本系统会话,验签即认证)。响应契约:
  200 = 记账/重放/无关事件/无锚点;502 = 钱到但记不了(not_issued/
  invoice_voided/invoice_not_found/unparsable)——绝不 2xx 确认记不了的钱。
  方法集合显式枚举(不用 app.all,路由普查对册可见,见判断层 5)。
- `apps/api/src/app.ts` / `index.ts`:AppDeps.stripe(StripeChannel | undefined,
  未配置 = 两端点 500 misconfigured);index.ts 按 env 装配。
- 27 个既有测试文件的 createApp 夹具补 `stripe: undefined`(必选注入面)。
- `apps/api/src/routes/registry.ts`:2 条新声明(checkout = invoices.manage,
  webhook = public);`route-auth.test.ts` 公开路由钉死清单加
  /api/webhooks/stripe(公开指「不过会话中间件」,漏登记才是口子)。
- docs:billing.md「Stripe 渠道(#193)」专节(渠道内核/端点与响应契约/门户分工/
  剩余更新)、audit.md(payment.recorded 的 webhook 形态:actor null +
  同事务;新词 invoice.payment_link_created)。
- 测试:`billing/stripe.test.ts`(新,19 例:验签矩阵/事件归一/网关表单编码)、
  `routes/stripe.test.ts`(新,11 例,独立 scratch DB):checkout 链接(金额
  服务端出/409 矩阵/403/404/misconfigured)、webhook 全链(签名事件 → 收款行 →
  审计 → 票 paid;重放与 completed+succeeded 双发幂等;坏签名/陈旧时间戳/
  GET 405 零副作用;**草稿票 502 → 财务 confirm → 重投 200 paid**;void/未知票
  恒 502;无 metadata 200 ack;签了名的坏 payload 400;部分入账记 partial)。

## 判断层(手写)

### 关键判断

1. **门户不存在,财务过渡面先行**(与 `POST /api/invoices` 手工建票同一先例)。
   #193 的「门户发票页」要等 M1 #186 的客户身份,而「支付他人发票被拒」的归属
   门在结构上依赖发票 → 客户映射——发票的多态锚点要等订单域(#231)给出
   subject 才有处可查,现在硬做归属校验就是替不存在的域编映射。所以本切片把
   同一条服务路径(StripeGateway + webhook 匹配)先开给财务
   (invoices.manage):财务确认后把链接发给客户是当下就成立的收款动作;门户
   进场复用同一网关 + 归属校验,不长出第二套建会话的路径。

2. **拿不准的钱不确认——502 语义是本切片的承重墙**。webhook 一旦 2xx,Stripe
   永远停止重投;记不了的钱(票未确认/已作废/找不到/事件读不出金额)若被
   ack,就只在日志里存在了。所以非记账成功一律 502 让 provider 重试:草稿票
   重投等财务确认(R-12-6 是人的闸门,webhook 靠重试跨过它——集成测试钉住
   502 → confirm → 重投 200 paid 整条链),作废票恒 502(钱卡在 Stripe 侧,
   退款走 #240 的人工流程,比静默吞掉诚实)。唯一刻意 ack 的是「无 metadata
   的入账」:不是本系统建的 session,没有可记账的家(payments.invoice_id 非空),
   认领面随 #181 进场,ack 比让 Stripe 空转三天诚实。

3. **审计与记账同事务(webhook 面)**。 Payments 路由的审计在事务外(有人的
   重试兜底),webhook 不行:审计写失败 → 500 → Stripe 重投 →
   PaymentExistsError → 200「已记账成功」→ 那行审计永远缺失。recordAudit 接受
   `Pick<Db,"insert">` 正好塞进同一事务:commit 前任何一步失败整体回滚,重投
   从原点重来。「钱记了、审计没了」的中间态在结构上不存在。

4. **无 SDK,fetch 适配器**(mailer 同裁)。全片只需要「创建 checkout session」
   一个出站调用,`StripeGateway` 域内接口 + 表单编码 fetch + zod 响应收口,
   不为它引入 SDK 依赖;入站验签手写(node:crypto + timingSafeEqual,40 行,
   与老系统同一形状且完全可测)。业务代码只见接口,AGENTS.md 的「依赖注入、
   无厂商锁定」在这里的含义就是:换 provider = 换一个网关实现。

5. **webhook 不用 app.all**。第一版 `app.all("/api/webhooks/stripe", …)` 被
   route-auth 普查漏掉——普查把 method "ALL" 当中间件过滤,而注册表承诺的是
   「完整路由册」,一个普查看不见的公开端点恰恰是最不该存在的东西。改为
   `app.on(["POST","GET","PUT","PATCH","DELETE"], …)`(非 POST 处理器第一行
   405),声明 `{ method: "*", kind: "public" }`,公开钉死清单显式加一行。
   「公开」在注册表里的语义是「不过会话中间件」,不是「不设防」——漏登记
   才是口子。

6. **部分入账照记**(Stripe 签过名的银行事实是唯一事实)。旧链接金额与票面
   不一致、或客户分两笔付:金额照落,付款态按实时 SUM 派生为 partial——
   这是 #303 派生态裁决的直接红利,webhook 面不需要任何「金额必须相等」的
   特判;篡改防护在结构层(body 无金额字段、session 金额服务端出、webhook
   金额要过签名),不在业务层比对。

### 踩的坑

1. **批量改 27 个测试夹具,两类一次性翻车**:(a) 正则只匹配
   `= createApp({`,漏掉 `=> createApp({`(auth.test.ts 的 appFactory)和
   `return createApp({`(app.test.ts 的 makeApp);(b) 后续清理「对
   deliverWebhook 返回值误再调 .json()」时,盲替换把 checkout 面同名变量
   (真 Response)的 `onVoid.json()` 也改坏了。两处都是全量 typecheck 抓住的
   ——**批量动夹具后必须跑全仓 typecheck,不能只跑目标套件**;同名变量在
   两个 describe 里语义不同,脚本替换无分辨力,收尾一律人工核对 diff。

2. **require-await 的假实现**:假 fetch 网关写 `async (input) => { …; return
   new Response(…) }` 触发 @typescript-eslint/require-await。非 async 函数
   显式 `Promise.resolve(…)` / `Promise.reject(…)` 是仓库既有写法mailer.test
   同款);测试假实现统一照此,不为此关 lint 规则。

3. **route-auth 双向比对再次上岗**(继承 #192 session 的坑记录):新增两条
   路由必须逐条声明,public 还要动 route-auth.test.ts 的钉死清单——这个测试
   的存在意义就是逼人显式回答「新端点凭什么不用登录」。

4. **pg 不在 worktree 根 node_modules**(pnpm strict):`node -e "require('pg')"`
   探活失败不代表库没起;`docker exec ally-os-node-postgres-1 psql -c "select 1"`
   才是对全部事实的探活。

### 验收对照(#193 验收三条)

- [x] **验签失败的 webhook 被拒绝;重复的 webhook 不会重复记账**——集成测试:
  缺头/错密钥/陈旧时间戳 401 零副作用;原样重放与 completed+succeeded 双发
  归一同一 source key,恒一行恒一审计。
- [x] **篡改金额或支付他人发票的请求被拒绝**——篡改:金额在结构上无客户端
  入口(checkout 金额服务端按行合计出、webhook 金额过签名,集成测试断言网关
  入参);他人发票:归属门要等门户身份(#186)+ 发票→客户映射(#231),
  结构性后置,PR 剩余清单明示。
- [~] **Stripe 测试环境完整走通**——本环境无 Stripe 账号与公网回调,以
  「Stripe 线格式真实签名的事件 → 全链记账」的集成测试等价钉住;真测试环境
  E2E(webhook 端点配置 + test clock 走完 checkout)需要部署与密钥,随部署
  面进场,列入剩余。

### 剩余(#193 保持 open)

1. 客户门户发票页(M1 #186):登录身份、发票列表/详情、「用 Stripe 支付」
   按钮(复用同一 StripeGateway,加归属校验——等 #231 的 subject 锚点);
2. 真 Stripe 测试环境 E2E(部署面:webhook 端点 URL 配置 + 密钥);
3. PayPal 渠道(同一接缝,sourceType paypal,#89);附加费 R-12-2/3
   (session 金额带 principal/surcharge 拆分,#233 已就绪;老系统
   splitSurchargedCapture 的「两半互证、对不上拒绝」教训带过去);
4. 失败付款/银行借记拒付的站内提醒(老系统 Sentry/Slack 分流在新系统走
   通知域,#116);退款事件消费(refund.*,#240)。
