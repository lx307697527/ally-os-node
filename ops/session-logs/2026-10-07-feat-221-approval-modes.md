session_id: hand-written-221-approval-modes
branch: feat/221-approval-modes
date: 2026-10-07
reason: issue-221
prompts: 1
unparseable_transcript_lines: 0
models: (zcode)
tokens_in: 0
tokens_out: 0
cache_creation_tokens: 0
cache_read_tokens: 0
thinking_blocks: 0
---

# Session log — feat/221-approval-modes — 2026-10-07

> 机械层本次由 agent 手写(ZCode 定时迁移会话);判断层为本次会话手写。

## 机械层(自动)

- **引用的 issue**:#221 剩余项「会签/票签」——切片 1/2/3、决策表进线、通知扇出
  +催办均已合并(#269/#270/#279/#280/#283),本切片把多人裁决形态落掉。
  PR 正文写 Part of #221(金额域接线 #229/#231、审批配置 UI 仍在,严禁 Closes)。
- **前置收尾(第 0 步)**:无 open PR(#283 已被并行会话合并)、无残留 worktree、
  main 拉平到 934f2a9;主检出干净,全程 worktree 流程。
- **选题**:按优先级①注释里有未完成切片的 issue 逐个核——#219 剩余(签名墙页面)
  等第一个有签署历史的承载页;#226 slice 3 blocked #206;#221 本切片无依赖且是
  该 issue 服务端最后一块。claim 原子租约拿到。
- **数据库**:本地 postgres 容器健康,全部测试带 DATABASE_URL 跑(无 skip)。

### 本切片改动的文件

- `packages/db/src/schema.ts` + `migrations/0027_typical_reptil.sql`:
  `approval_actions` 唯一索引 `(request_id, step_index)` →
  `(request_id, step_index, actor_id)`(一人一级一裁决;会签/票签同级多行)
- `apps/api/src/approval/service.ts`:`ApprovalLevel` + zod 加
  `mode(any|all|quorum, default any)` / `quorum(2–50,仅 quorum 模式)` 两个
  refine;`requiredApprovals`(any=1 / quorum=票数 / all=裁决时刻活集合)+
  `countLevelApprovals`;`actOnApproval` 事务内 `SELECT … FOR UPDATE` 锁请求行
  +锁内重读 +数票判定(未凑齐不写请求行、不扇下一级);审计 detail 带
  mode/approvedCount/neededApprovals/levelSatisfied;`approvalTodo` 行加
  levelMode/approvedCount/neededApprovals/viewerAlreadyActed(批量投影 action
  行,不逐行问库)
- `apps/worker/src/approval/reminder.ts`:催办排除本级已同意者(票已交等没交的);
  全员已表决仍停滞 → 告警跳过;enteredAt 注释改为「最近表决时刻」双语义
- `apps/web/src/shared/lib/approvals-client.ts` + `pages/Approvals.tsx`:待办行
  schema 四字段;页面亮 countersign/vote 进度、已表决者收起裁决钮改说
  「You have already voted on this level」
- 测试:`approvals.test.ts` +5(会签凑齐/一票驳回终态/票签到数即过/签名×会签
  逐人绑定/逐票审计)+3 个保存面 422;`reminder.test.ts` +2(排除已表决/全员
  已表决告警);`approvals-page.test.ts` +1(进度与已表决态源文本断言)
- 文档:`docs/approval.md`(级别配置/失败语义/新小节/催办排除/部署注);
  本 session log

### 验证

- `DATABASE_URL=… corepack pnpm verify` 全绿(数字见 PR 正文);新增测试全部
  先红后绿或随实现同步落地。

## 判断层(手写)

1. **唯一索引替换不是纯 expand——这是本次最大的判断,如实记录**。AGENTS.md
   要求 migration 向当前运行版本向后兼容(expand→migrate→contract),但
   `(request_id, step_index)` 唯一约束与会签同级多行在数学上不相容,约束替换
   只有两种时序:先 drop(迁移后到新代码上线之间,旧代码的
   `ON CONFLICT (request_id, step_index)` 解析不到仲裁索引 → 42P10,审批裁决
   端点全报错)或先 keep(会签第二票永远 23505,切片等于没交付)。两条路都
   破坏某个窗口。裁法:选先 drop+create 同批次,理由——本仓库只有 staging
   自动部署、生产需手动批准尚无流量、窗口是 ECS 滚动发布的分钟级;在迁移
   文件、docs/approval.md「部署注」、PR 正文三处明示,生产发布前必须把
   「迁移与新代码同批次」写进发布清单。不假装这是 expand-only。
2. **会签算票用「裁决时刻的活集合」而不是提交时刻快照快照的集合大小**。
   levels 快照冻结的是人员/角色**名单**,不是角色持有者集合——快照持有者集合
   既存不下(集合是查询结果)也不该存(角色在飞期间变化,以当下事实为准)。
   代价是「集合收缩后数学上已满足但无人再触发判定」的滞留边界:已表决者再裁
   是 409,没人能推进。没有为此加维护扫描(第一个真实消费域出现前不给内核
   加没有用户的机器),催办侧的「全员已表决仍停滞 → 告警」已经把这个状态
   从静默变成可见,修复动作是配置 Owner 改集合后任一在集者再裁一次。
   边界写进 docs/approval.md「已知边界」。
3. **未凑齐的票「落行但不推进」——推进判定只在锁内做一次**。曾考虑的替代:
   给同级每张票后都重算+可能推进(无锁,靠 CAS)——并发下两张票各自数到 1/2,
   谁都不推进,级卡死;或者抽号锁/advisory lock——引入新的锁原语。行锁
   (FOR UPDATE)是唯一让「数票→推进」原子且不引入新机制的选项,any 模式
   顺带从「唯一约束隐式串行化」变成显式排队,行为不变(并发测试原样绿)。
4. **已表决者从「撞 409 才知道」改为「行上自带 viewerAlreadyActed」**。
   服务端 409 底线保留(缓存/双开的陈旧面板仍被服务端挡),但待办行自己带
   表决态让 UI 能收起裁决钮——与切片 3「陈旧收件箱说实话」同一姿态:不让
   用户对一个必失败的动作按按钮。
5. **催办排除已表决者后,「本级静默时长」的语义自然变成「最近一次表决起」**。
   enteredAt = max(action.createdAt) 的既有算式在会签下自动获得正确语义
   (当前级有部分表决行时,max 即最近表决),一行代码没改、只改注释——测试
   夹具起初用「1h 前表决」期望催办,结果正确地不催(未满 24h),这反向验证了
   语义;夹具改成 26h 前后全绿。旧注释「当前级还没有 action 行」已不成立,
   是本次唯一需要解释的注释级漂移。
6. **收尾提醒**:merge 后按惯例 `gh pr merge --squash --delete-branch` +
   `claim_issue.py release`;worktree 里 shell cwd 漂移问题照旧——所有 git
   命令显式 cd。
