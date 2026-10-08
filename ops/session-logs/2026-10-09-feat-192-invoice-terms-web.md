---
session_id: hand-written-192-invoice-terms-web
branch: feat/192-invoice-terms-web
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

# Session log — feat/192-invoice-terms-web — 2026-10-09

> 机械层本次由 agent 手写(ZCode 定时迁移会话);判断层为本次会话手写。

## 机械层(自动)

- **引用的 issue**:#192(发票草稿 + 财务确认,phase-2)——剩余清单第 3 条的
  尾巴「confirm 的 terms 选择器与到期日的 web 展示」。PR 正文写
  **Part of #192**(触发点接线、客户面到期提醒、#241 回写、#181 QuickBooks、
  #128 PDF、红冲动词未完,保持 open)。
- **前置收尾(第 0 步)**:无 open PR、无残留 worktree、主检出干净;远端遗留
  的 claims/feat 分支均为已合并切片的残迹,未动。
- **选题**:①优先续做有未完成切片的 issue——#110/#113/#116/#233 的剩余项全部
  路由到未建域(ops、#118 AI 客户端、#115 Slack、RBAC、#220/#206),只有 #192
  的本切片自包含(API 的 `dueInDays`/`dueAt` 合同已由 #314 落地,纯 web 半边)。
- **claim**:`claim_issue.py claim --issue 192` 成功(接替已释放的租约)。
- **数据库**:本切片零 schema、零 API 改动,未动 migration;verify 带
  DATABASE_URL 跑全量(结果见文末)。

### 本切片改动的文件

- `apps/web/src/shared/lib/invoices-client.ts`:`confirm(id, dueInDays?)`——
  给天数时才带 JSON body(省略时保持无 body,服务端 body 可省的合同不变);
  新增纯函数 `parseDueInDays`(镜像 confirm zod 准入:整数 0–365,0 = 见票
  即付)与 `isInvoiceOverdue`(扫描同款派生:dueAt 已过 ∧ paymentStatus ≠
  paid,now 参数化可单测);schema 注释「展示随后续切片」收口为已落。
- `apps/web/src/shared/pages/InvoiceDetail.tsx`:confirm 对话框加 terms
  选择器(`TERMS_OPTIONS`:No agreed terms 缺省 / Due on receipt / Net
  15/30/60 / Custom days…)、自定义天数输入(客户端先拒一轮)、due 预览行
  (服务端同款整数加法);金额区加第四个统计槽 Due(逾期时 `text-err` +
  ` · overdue` 后缀)。
- `apps/web/src/shared/pages/Invoices.tsx`:列表行 meta 带 `due <日期>` 与
  ` · overdue` 标记(同一 `isInvoiceOverdue`)。
- `apps/web/src/shared/lib/invoices-client.test.ts`(+3 例):confirm body
  三态(30 → `{dueInDays:30}`、0 → `{dueInDays:0}`、缺省无 body);
  `parseDueInDays` 准入/拒绝两侧;`isInvoiceOverdue` 逾期/付清/未到期/无账期。
- `apps/web/src/invoices-page.test.ts`(+4 例,源文本断言):terms 选择器与
  自定义天数字段的 testid 与词表、due 预览与「never chases the customer」
  纪律句、详情 Due 槽与列表 due 展示、逾期着色的派生来源;原 confirm 动词
  测试补带 terms 的调用形状。
- `docs/billing.md`:R-12-7 节补「web 面」小节(预设词表/客户端准入镜像/
  预览的权威边界/逾期标记只是展示事实);剩余清单第 3 条去掉 terms 选择器
  与 web 展示尾巴。

## 判断层(手写)

### 关键判断

1. **terms 的缺省是「No agreed terms」,不是 Net 30**。下拉的第一项就是它:
   服务端合同里缺省 = dueAt null = 不进逾期扫描,#314 的裁决(「缺省 = 未约定
   账期,老系统同款语义」)决定了 UI 不能替财务预选一个账期——预选 Net 30 就
   是把「未约定」从系统里挤掉了,存量票和手工票都会悄悄背上到期日。预设是
   加速正确输入的糖,缺省必须是无。

2. **预设用合同词,自定义兜 0–365 全域**。枚举词表(Due on receipt/Net
   15/30/60)覆盖绝大多数合同,但 #314 的裁决明确拒绝过枚举收紧(「合同写什么
   就给什么」)——所以 Custom days 输入按服务端 zod 的全域(整数 0–365)镜像
   `parseDueInDays`,注定被拒的提交死在表单不过网络(parseQuantity 先例)。
   预设只是常用值的快捷方式,不是准入口径。

3. **预览行给了「这个选择意味着什么」,权威留给服务端**。财务选 Net 60 的
   时候脑子里该出现落点日期,而不是心算;预览用服务端同款整数加法
   (issuedAt + N × 86 400 000)对 now 算,并写明「server stamps the exact
   date at issue time」——客户端 now 与服务端发行时刻差几秒,对日期粒度的
   展示无感;RULE-007(客户端不算钱)的姊妹裁决:客户端不算事实,只演事实。
   预览行顺带说了 R-12-7 的纪律(逾期提醒内部、系统不追客户)——disciplines
   said on the page,不只藏在 API 里。

4. **逾期标记是扫描规则的渲染时投影,不是新状态**。备选是后端加 `overdue`
   派生字段——被否:那是把「时钟过了没有」存成行状态,每次读都要维护;而
   `isInvoiceOverdue(dueAt, paymentStatus)` 用扫描同一条规则(dueAt 已过 ∧
   还欠钱,$0 票 vacuously paid)在渲染时算,数据一处不落、与 worker 的候选集
   判定天然同源。now 参数化注入,单测确定;页面调用用缺省 now。标记只是
   「财务看得见」,谁真的挨铃由 overdue_reminder_at 台账决定。

5. **到期日上详情页占金额区的第四个槽位,不上 meta 行**。Total/Paid/Payment
   status 已经是财务扫读的一行,due 是同一族的钱面事实;meta 行塞第四个日期
   会把 created/issued/voided 的时间线搅浑。列表行则相反——meta 行是唯一的
   行内叙述位,`due <日期>` 与 ` · overdue` 做成文本后缀,不新开列,与 void
   划线同一克制。

6. **confirm adapter 的三态 body**:有 terms 带 `{dueInDays}`、0 是真值必须
   发(`{dueInDays: 0}` ≠ 缺省)、无 terms 保持无 body——测试逐态钉死。备选
   「恒发 JSON body、缺省 `{}`」被否:0/缺省/无 body 三态在服务端 zod 里本就
   同一形状,但线上契约(部分老代理对空 body POST 的处理)没必要去动,最小
   改动面。

### 踩坑

- **页面源文本测试的断言要照实现形状写,但不能写成实现本身**。第一版把
  逾期着色断言写成 `toContain("text-err")`——该串在 flash 错误行早就有,测试
  不红也能过,毫无判定力;改成断言派生表达式 `overdue ? "text-err" :
  "text-ink"` 才钉住「着色来自逾期派生」这个事实。#233 的教训(夹具照解析器
  写不照存储形状写)在断言侧的镜像:断言要照「被裁决的形状」写,且先验证
  它真的会红。
- **terms 状态机的 custom 分支先在渲染期 parse、提交期再校验**:两处都用同
  一个 `dueInDays` 派生值(渲染期算预览、提交期做闸),不是两套逻辑;写成分
  开的两份就会在下一张预设加入时漂移。
- 本切片纯 web 面,但 `invoices-page.test.ts` 的既有断言
  `invoiceAdapters.confirm(props.invoice.id)` 会因调用形状变化而红——测试先行
  让它先红,更新断言时保留了无 terms 分支的原字面量(三元两分支各保留一个
  可断言的调用形状),既收口新契约又不模糊旧合同。

## 验证

`corepack pnpm vitest run`(改动两文件)57 例全绿(测试先行:红 10 → 实现后
全绿);全量 `DATABASE_URL=postgres://ally:ally@localhost:5432/ally corepack
pnpm verify` 结果见 PR 正文。零 migration、零 API 改动。
