---
session_id: hand-written-192-payment-actions
branch: feat/192-payment-actions
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

# Session log — feat/192-payment-actions — 2026-10-08

> 机械层本次由 agent 手写(ZCode 定时迁移会话);判断层为本次会话手写。

## 机械层(自动)

- **引用的 issue**:#192 剩余清单第 2 条尾巴「收款动作的 web 面(手工记账
  表单、收款作废、Stripe/PayPal 收款链接按钮——API 已就绪)」(上一份
  session log `2026-10-08-feat-192-finance-invoice-page.md` 结尾点名的
  「下一个收款切片」)。PR 正文写 **Part of #192**(#192 尚余触发点接线/
  到期提醒/回写/QuickBooks/PDF/红冲与真渠道 E2E,保持 open)。
- **前置收尾(第 0 步)**:fetch --prune 无异常;无 open PR;唯一非主
  worktree(26-admin-users)是**活跃会话**(WIP 文件几分钟内有改动、
  claims/issue-26 租约在持),按「别的会话正在工作」处理,未清理。
- **选题**:优先级①盘点有未完成切片的 issue——#192(收款动作 web 面,
  API 全就绪无阻塞)、#193(余项等门户 #186 部署与 #240)、#220(余项等
  属主域 #227/#231/#243)、#233(余项等 #220/#206)。选 #192 的收款动作
  切片。`claim_issue.py claim --issue 192 --ttl-minutes 120` 成功。
- **worktree**:`.claude/worktrees/192-payment-actions`,分支
  feat/192-payment-actions 自 origin/main(67841c8)。
- **数据库**:本地 postgres 可用(5432),verify 全程带 DATABASE_URL。
  全量 vitest 两次在共享库上 afterAll(drop database with (force)) 30s
  钩子超时(1281/1281 测试全过、纯 teardown 挂;邻居会话并发跑库测试
  的 catalog 锁竞争);`--maxWorkers=4` 重跑全绿——**126 文件 / 1281
  测试零 skip**(基线 126/1264:+17 测试 = client +11、page +6)。

### 本切片改动的文件

- `apps/web/src/shared/lib/invoices-client.ts`:四个收款动词适配器——
  `recordPayment`(POST /api/invoices/:id/payments,201 形状 zod 收口)、
  `voidPayment`(POST /api/payments/:id/void)、`stripeLink` /
  `paypalLink`(两渠道同一 `paymentLink` 读法:201 拆分披露 url/gross/
  principal/surcharge;500 逐 body 读码,仅 `error: "misconfigured"` 映射
  misconfigured,其余 500 仍 unavailable);共享 `actionFailure` 失败映射
  (403/404/409 带机器码)从 `verb` 抽出;`parseLocalDateTimeToIso`
  (datetime-local → UTC ISO,空/不可解析 null)。
- `apps/web/src/shared/pages/InvoiceDetail.tsx`:issued 票的收款动作行
  (Record payment / Stripe·PayPal payment link)进 PaymentsSection;
  三个对话框——RecordPaymentDialog(金额不预填、到账时刻拒未来、纪律
  「链接支付的钱不由手记,手记一遍就是双计」上墙)、VoidPaymentDialog
  (reason 必填、活款行才出动词、钱行永不删)、PaymentLinkDialog(只收
  成功形状,客户链接 + 实扣拆分 + 复制);`paymentActionError` 逐码成句
  (not_issued/invoice_voided/payment_exists/payment_voided/
  nothing_to_collect/surcharge_rule_unusable→注册表,misconfigured→环境
  缺渠道不说重载);flash 升级为 `{ text, kind: "ok" | "error" }`,链接
  拒绝不开对话框、落页面错误行。
- `docs/billing.md`:新增「已落地:收款动作 web 面」节;剩余清单第 2 条
  去掉已完成项,只剩真渠道 E2E(部署面)与门户发起面(#186)。
- 测试:`invoices-client.test.ts`(fake fetch 行为级:+11——端点/请求体
  取舍/409 带码/500 misconfigured 与其他 500 分相/201 坏形状不可信/死网
  络/parseLocalDateTimeToIso 矩阵)、`invoices-page.test.ts`(源码级:+6
  ——动作行仅 issued 渲染/记账对话框只收到账事实/作废必填 reason 且仅
  活款行/链接对话框拆分披露/逐 409 码成句/flash 双 kind)。

## 判断层(手写)

### 关键判断

1. **切片边界:交付「财务的手」,不动服务端语义**。记账/作废/两渠道建
   链接四个端点都是已测面(切片 2 与 #193 渠道切片),本切片零 API 改动、
   零 migration——把「财务确认之后的下一个动词家族」整个上页,而不顺手
   「改进」任何端点。验收说得清、PR 审得动,与前一切片「确认面不是收款
   面」是同一条按动词家族切的线。

2. **金额不预填未收余额**。确认对话框亮金额与记账表单不预填是两回事:
   前者亮的是服务端已算出的承诺(生成列的答案),后者问的是「实际到了多
   少」——只有财务知道的事实,超收/少收都是真实世界。预填会诱导把「应该
   到的」记成「实际到的」,这是把事实字段变成期望字段。

3. **「链接支付的钱不由手记」纪律上墙,因为双计在本系统里是结构性的**:
   webhook 记账与手工记账写同一张 payments 表,同一条服务路径。钱的事实
   每条只允许一个生产者——provider 确认进来的由 webhook 记,手记一遍就是
   两行。对话框文案直说,不等 409 兜底(等兜底 = 已经错了)。

4. **链接失败不开对话框**:对话框的用途是交付 URL;失败没有东西可交付,
   硬开一个只有错误文案的对话框是把拒绝包装成交付。拒绝落页面的消息行
   (flash kind: "error")——顺带让 flash 的 error 分支有了真实调用点,
   不是给未来预留的死类型(源码级测试断言 'kind: "error"' 逼出了这个
   判断:第一版把失败也塞进对话框,测试红了才发现形状不对)。

5. **500 逐 body 读码,不把服务器故障说成环境缺渠道**:`error:
   "misconfigured"` 才映射 misconfigured(句子指向环境配置),其他 500
   保持 unavailable(句子指向重载)。两种失败的修复动作不同——一个去找
   管理员配渠道,一个等部署恢复——同一个句子必然误导其中一种。

### 踩的坑

1. **共享本地 postgres 的 scratch 库拆除竞争**:全量 verify 连续两次
   afterAll(`drop database with (force)`)30s 钩子超时——1281/1281 测试
   全过、文件红。隔壁 worktree(#26)并发跑库测试 + 两个 CI-runner 容器
   常驻,catalog 锁排队,drop 等不到锁。单文件重跑 3.7 秒全绿;
   `--maxWorkers=4` 后 126 文件全绿。教训:**verify 红先看失败在不在
   hook**——测试体全绿而文件红 = 基建竞争,不是代码;限并发是本地共享库
   的正解,不要为了红 hook 去改测试。

2. **bash heredoc 追加 JSX 被拦腰截断**:往 InvoiceDetail.tsx 追加三个
   对话框组件用 heredoc,结束符没独占一行,文件在 1065 行
   `</Bu` 处截断、PaymentLinkDialog 整个丢失且无报错(warning 被吞)。
   大段代码追加走 Edit/Write 工具,不用 shell 拼接;截断修复靠唯一上下文
   (data-testid 行)定位断口。此后所有 JSX 编辑都走 Edit。

3. **抽共享失败映射时,成功分支的顺序就是语义**:`verb()` 重构成先调
   `actionFailure(res)` 再判 `res.ok`,而 actionFailure 把非 403/404/409
   一律按 unavailable 返回——200 也在内,confirm/updateLines 两个既有测试
   当场红。正确形状是 `if (!res.ok) return actionFailure(res)`(先判成功,
   再把失败交给共享映射)。抽共享逻辑时先列全调用方的旧顺序。

4. **源码级断言对齐 JSX 换行现实**(前一份 log 的坑 1 再次应验):断言全
   部挑单词级短语("double-count"、"books the payment"、
   'row.voidedAt === null'),无一跨行整句,一次全绿。

### 验收对照(本切片范围:#192 剩余「收款动作 web 面」)

- [x] 手工记账:金额(纯字符串换算)/方式/到账时刻(拒未来,空 = 现在 -/
      备注;草稿与作废票被服务端状态门挡,页面只对 issued 出动作
- [x] 收款作废:活款行出动词、reason 必填、作废行划线留痕、已收合计回落
- [x] 收款链接:Stripe/PayPal 两按钮 → 交付对话框(客户 URL + gross 拆分
      + 复制);失败逐码成句落错误行;misconfigured 指向环境不说重载
- [x] 双计纪律上墙(链接支付的钱不由手记);退款不在此(#240 独立流程)
- [ ] 触发点接线/到期提醒 R-12-7/回写 #241/QuickBooks #181/PDF #128/红冲
      /真渠道 E2E(#192 剩余清单原样保持 open)
