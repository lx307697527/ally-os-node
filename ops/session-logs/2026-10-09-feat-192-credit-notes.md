---
session_id: hand-written-192-credit-notes
branch: feat/192-credit-notes
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

# Session log — feat/192-credit-notes — 2026-10-09

> 机械层本次由 agent 手写(ZCode 定时迁移会话);判断层为本次会话手写。

## 机械层(自动)

- **引用的 issue**:#192(发票草稿 + 财务确认,phase-2)——剩余清单里
  「红冲动词」的**贷项单内核**半边。PR 正文写 **Part of #192**(触发点接线、
  客户面提醒、#241 回写、#181 QuickBooks、#128 PDF、分期与贷项 web 面未完,
  保持 open)。
- **前置收尾(第 0 步)**:`git fetch origin --prune`;无 open PR、无残留
  worktree、主检出干净(与 origin/main 同步,HEAD = 905ce61)。
- **选题**:规则①——#192 是最近活跃且评论里有明确剩余清单的 issue;剩余项
  逐一过依赖:触发点接线被属主域(#238/#231/批次域)阻塞,客户面提醒被 #186
  阻塞,#241/#181/#128 各自依赖未进场的域,**贷项单是计费域内自洽、可独立
  验收的切片**(发票内核切片在 schema 注释里预留的「更正走贷项切片」承诺)。
- **claim**:`claim_issue.py claim --issue 192` 成功(接替过期租约)。
- **worktree**:`.claude/worktrees/192-credit-notes`,分支
  `feat/192-credit-notes` 自 origin/main;`corepack pnpm install` 后基线
  集成测试通过(本地 postgres 容器在跑)。
- **数据库**:本地 postgres 可用,verify 全程带 DATABASE_URL,零 skip。

### 本切片改动的文件

- `packages/db/src/schema.ts`:`credit_notes` + `credit_note_lines`(0038,
  expand-only)——与 invoices 同构的三态状态机、硬外键、reason 必填、生成列
  行合计;表头注释写明四个口径裁决。发票内核表注释的「红冲是后续切片」承诺
  更新为「已落」。
- `packages/db/migrations/0038_fuzzy_dark_beast.sql` + meta:db:generate 产物。
- `apps/api/src/billing/credits.ts`(新):createCreditNote(锁原票 → 状态门
  → 发号 → 插入 → 边界校验)、confirmCreditNote / voidCreditNote(先票后单
  锁序)、sumCreditCents(issued 口径)、sumActiveCreditCents(draft + issued
  口径,边界用)、effectiveDueCents(唯一权威算术)、台账与详情读法。
- `apps/api/src/routes/credit-notes.ts`(新):五个端点(invoices.manage 门),
  zod 与发票路由同款收口;错误统一映射 409 机器码。
- `apps/api/src/billing/payments.ts`:summarizeInvoicePayments 扩为四件套
  (totalCents/creditedCents/paidCents/paymentStatus),paymentStatus 的应付
  口径改为有效应付。
- `apps/api/src/routes/invoices.ts`:列表/详情读面带 `creditedCents`(列表
  第三条分组查询);paymentStatus 走有效应付。
- `apps/api/src/routes/payments.ts`:record/void 的响应与审计带 creditedCents。
- `apps/api/src/routes/stripe-checkout.ts` / `paypal-checkout.ts`:结算额改为
  有效应付(全冲抵 → nothing_to_collect)。
- `apps/worker/src/billing/overdue.ts`:候选集派生加第三条分组查询(issued
  贷项),还欠钱口径改为 paid < 有效应付,outstanding 同步。
- `apps/api/src/billing/registry.ts`:注册 numbering subject `credit_note`。
- `apps/api/src/routes/registry.ts`:五个新路由的授权声明。
- `apps/web/src/shared/lib/invoices-client.ts`:zod 契约同步(invoice /
  paymentsLedger / paymentRecorded / paymentVoided 四个 schema 带 creditedCents),
  record/void 结果类型与映射透出 creditedCents(纯契约同步,展示随 web 切片)。
- 测试:`routes/credit-notes.test.ts`(新,12 例,真库)、worker overdue.test.ts
  (+2 例:全冲抵出局/草稿与 void 贷项不算、部分冲抵压缩 outstanding)、
  stripe.test.ts / paypal.test.ts(+1 例各:结算额收缩、全冲抵拒链)、
  web invoices-client.test.ts 夹具与断言同步。
- 文档:`docs/billing.md` 新「已落地:贷项单内核」专节 + 剩余清单更新;
  `docs/numbering.md` 生产注册表补 credit_note。

### 验证

- `DATABASE_URL=… corepack pnpm verify` 全绿:**131 文件 / 1344 测试,零 skip**
  (基线 130 文件 / 1328 测试,+1 文件 +16 用例)。
- CI:见 PR(github.com/lx307697527/ally-os-node)。

## 判断层(手写)

1. **为什么是贷项单(新单据),不是给发票加负数行或改状态**:发票内核的承诺
   已经把方向定了——「红冲是动词,不是对已发行的改写」。给 issued 票加负数行
   要把「金额非负」这个全库金额纪律的基石凿开(生成列、zod、checkout 全要学
   会负数);改 status='refunded' 是老系统的快照改写,bug554 家族的来路。
   贷项单把冲抵变成「另一份只有非负金额的事实」,读法(有效应付 = 合计 −
   贷项)一条减法,QuickBooks 的 credit memo 也是这个形状。
2. **两个口径分离(本切片最关键的判断)**:`sumCreditCents`(issued only)喂
   付款态/checkout/逾期扫描;`sumActiveCreditCents`(draft + issued)喂冲抵
   边界。草稿贷项**不能**让发票提前变「paid」——R-12-6 的闸门是财务确认,
   草稿计入有效应付等于系统替财务放行;但边界校验**必须**数草稿——两张草稿
   各自在边界内、先后确认就超冲,这个窗口必须在创建时就关死,confirm 时再查
   就晚了(两 confirm 并发都要过同一边界,先查后改在锁外不可靠)。实现后跑
   测试立刻抓到我自己测试里的对应错误(断言草稿计入 credited → 修正断言),
   口径分离不是过度设计。
3. **checkout 的结算额必须跟着变,否则切片自打脸**:贷项单落地的瞬间,「按
   原面额建支付链接」就从既有行为变成多收客户——这个口子不能留到下一个切片。
   结算额 = 有效应付(发票合计 − 有效贷项),全冲抵 → nothing_to_collect,
   附加费按新结算额计。既有「部分收款后链接仍按全额」的口径**没有动**(那是
   pre-existing 行为,该不该收 remaining 属于收款动作域的另一个裁决)——PR
   正文里作为观察项列出。
4. **测试先行在这里救了一次算术**:stripe checkout 的「全冲抵拒链」用例,
   我第一版写了「150000 的票 + 两张 50000 贷项 → 期望 nothing_to_collect」,
   跑出来 checkout 201、台账 creditedCents = 100000——代码是对的,是我把
   「冲抵余款」算成了 50000(应为 100000)。集成测试用真 PG 生成列与真派生,
   谎言当场暴露;修的是测试不是实现。
5. **踩坑:Edit 工具落在主检出**。开完 worktree 后我按惯性把 schema 编辑写到
   `d:\Code\ally-os-node\packages\db\src\schema.ts`(主检出)而不是 worktree
   路径,`db:generate` 因此报「no schema changes」。发现后立刻
   `git checkout --` 回滚主检出、在 worktree 文件上重做。定时迁移会话的文件
   操作全部要带 worktree 绝对路径,工具调用不继承 shell 的 cwd。
6. **踩坑:测试文件里插 it() 要看清楚所在块的边界**。往 stripe/paypal 的
   「refuses drafts, voided and zero-total」用例中段插入新用例,把原用例的
   权限断言尾部困进了新用例(同名 `const invoice` 撞声明)。第一次修复的
   字符串手术又留了重复行——最后老老实实读出整个区域手写重排。教训:结构性
   编辑先读后改,别在正则里赌块边界。
7. **docstring 即规格**:credits.ts / schema.ts / billing.md 的注释按本仓库
   惯例写足「为什么」(两口径分离、边界为什么数草稿、为什么 issued 终态)。
   下一个切片(贷项动作 web 面)的 implementer 读注释就能拿到全部裁决依据,
   不用重推。
