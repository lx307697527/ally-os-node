# 会话日志：跨域热路径性能切片（直接推送 main，无 PR）

2026-10-10 凌晨，用户交互会话。任务：用户点名「优化 node 项目」，并显式裁定流程——**不写测试先行（非 TDD）、直接提交推 main、不开 PR（单人项目）**。

## 执行层

1. step-0：主检出 main 干净、与 origin 同步。无 issue 挂钩（跨域切片），无租约、无 worktree。
2. Explore 子代理全量扫描（62 次工具调用）：串行 await / N+1 / 热路径重复计算 / 无界查询四类，产出 14 个带代码定位的候选。
3. 按「行为不变、可验证」落地 9 项：
   - `routes/invoices.ts`：列表 5 查询（头行+三个分组 SUM+planCounts）Promise.all；详情 4 查询（行+贷项+收款+成员数）Promise.all。
   - `billing/payments.ts` `summarizeInvoicePayments`、`billing/pdf.ts`：独立 SUM 并行。
   - `billing/installments.ts` `getInvoicePlan`：逐成员 `sumCreditCents`（≤12 次/页）→ 单条 `inArray`+groupBy 分组查询（镜像同函数 paidRows 的既有形态）。
   - `routes/comments.ts` / `routes/tasks.ts`：提及+关注者、状态流转关注者扇出逐人 insert → 一次多行 insert（缩短写事务占锁时长）。
   - `routes/comments.ts` 附件上传：对象 put 从**事务内串行**（FOR UPDATE 行锁 + 连接按最慢 S3 RTT 排队）改为事务外并行，行批量 insert；quota 落空分支（并发抢占）补对象清理——原路径该分支发生在任何 put 之前，现在对象已落桶必须删。
   - `approval/service.ts` `approvalTodo`：每行一次 `requiredApprovals`（all 模式 = authUser⋈user_role 查询）→ 抽出 `resolveRoleHolders`，循环内按角色集 Promise 缓存去重（口径不变：|users ∪ holders|）。
   - `workflow/engine.ts`：`parseWorkflowTemplate` 结果按 definition JSON 有界缓存（Map≤500，超限清空；definition 是静态快照，纯函数）；`applyWorkflowEvent` 机器经 WeakMap 挂靠 ParsedTemplate 实例（解析缓存命中 ⇒ 同一实例 ⇒ 跨请求命中）。
   - worker `workflow/reminder.ts` / `approval/reminder.ts`：角色持有者查询按排序角色集去重缓存；approval acted 行逐请求查询 → 全在飞集一次批量取齐（当前级过滤挪内存）。
   - worker `notifications/digest.ts`：发信 4 并发小池（按人失败隔离不变）；`files/pending-cleanup.ts`：对象删 8 并行 + 行删单条批语句（status 条件保留）。
4. 验证：`pnpm verify` 全绿；另起 compose Postgres 跑 DATABASE_URL 全量——1661/1661 通过（默认环境 582 个 DB 集成用例 skip）。

## 判断层

- **筛掉 5 个候选及理由**：authz 中间件两查询合单——store 是注入接缝（测试内存假实现），改接口侵入大于 1 RTT 收益，且两查询本已并行；`audit_events` 过滤索引——schema 注释明确裁决「等真实过滤查询慢了再加」，单方面推翻设计裁定属范围外；automations scanner / digest 无界扫描加 limit——截断破坏「每事件×规则恰好一次」与摘要台账语义，宁可保持无界；invoices 列表分页——API 契约变更连带 web 翻页 UI，是产品变更不是纯优化（真数据量上来再做）。
- **通知批量 insert 的形状风险**：多行 insert 的 returning 顺序 PG 实践按插入序返回但不属承诺——附件审计改为遍历 returned 行（行自带 fileName），不与 staged 数组按下标配对，顺序假设不进代码。
- **Promise.all 与事务连接**：同一 tx 上的并行查询由 node-pg 在连接上排队，无交错风险；`deps.db`（池）上列表 5 并发占 5 连接，池 max=10，管理面低并发场景安全。

## 新坑

(66) **本机 eslint 默认 4GB 堆 OOM**：`pnpm verify` 在 lint 阶段 280s 后 mark-compact 失败 exit 134；`NODE_OPTIONS=--max-old-space-size=8192` 下秒级全绿。CI 不受影响（CI 步骤本就带 `NODE_OPTIONS=…4096`）；本机跑 verify / pre-push 钩子（钩子继承 git 进程环境）都需前缀注入，例如 `NODE_OPTIONS="--max-old-space-size=8192" git push`。仓库脚本保持不动（不为一台机器改 lint 命令）。

(67) **`pool.end()` 优雅关闭与 `drop database with (force)` 的竞态会以 unhandled error 形式击穿 CI**（本切片推送后 main 上真实发生，run 37974397465）：160 个测试文件与全部用例通过，vitest 却捕获 2 个 `57P01 terminating connection due to administrator command`（payments/workflow-templates 两个临时库）退出 1。机制：afterAll 里 `pool.end()` 的 Terminate 还在途，`drop … with (force)` 先杀掉后端，被杀空闲连接的错误经 pg 转发到 **pool 的 'error' 事件**——无监听器即 uncaught exception，vitest 记为 unhandled error。这是夹具形态的既有竞态（时序敏感，非本切片引入；并发的 Promise.all 查询改变时序使其显形）。修复一行：`createDb` 给 pool 挂空 'error' 监听器（pg 文档建议形态；坏客户端由池下次 acquire 自愈，查询面错误照常上抛）。**因果用一次性脚本双跑验证**：无修复=同款 unhandled crash，有修复=clean exit。

- **顺带观察（未动）**：main 上 #330、#331、landing 三个 Deploy run 先后 failure，均挂在 **Terraform validate / Docker 构建**（基础设施层，测试任务本身通过）——与本切片无关，属 infra 域待办（#226/#34 方向）。

## 状态

- 已直接推送 main（perf(api) / perf(worker)+会话日志），首推 CI 测试任务败于新坑 (67)，修复以 fix commit 补推；无 PR、无 issue 挂钩、无租约遗留
- compose Postgres 起于本地（5432），复测后留存
- 下一候选：回迁移主线（#131 吃内核或 #34 app 层，然后 #227）
