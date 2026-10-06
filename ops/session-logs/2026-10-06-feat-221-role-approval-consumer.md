---
session_id: hand-written-221-role-approval-consumer
branch: feat/221-role-approval-consumer
date: 2026-10-06
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

# Session log — feat/221-role-approval-consumer — 2026-10-06

> 机械层本次由 agent 手写(ZCode 定时迁移会话);判断层为本次会话手写。

## 机械层(自动)

- **引用的 issue**:#221(配置工作室:审批)——**切片 2:批准即生效 +
  第一个真实消费方(R-16-6 角色授予走审批)**,PR 正文写 Part of #221
  (pg-boss 催办、会签/票签、#226 版本化、配置/待办 UI 未完,严禁 Closes)
- **前置收尾(第 0 步)**:无 open PR、无残留 worktree、主检出干净。
  选题按切片顺序续做 #221(切片 1 = #269 已合并,评论点名切片 2 是
  R-16-6 user-roles 改造,审批内核第一个真实消费方)。
- **claim**:claim_issue.py 接手了一个已释放的旧租约(release by owner),
  原子占位成功。

### 本切片改动的文件

- `packages/db/src/schema.ts`:approval_requests 加 `payload` jsonb(可空)
- `packages/db/migrations/0015_nervous_solo.sql`(新,expand-only):加列,
  向后兼容
- `apps/api/src/approval/outcomes.ts`(新):结果自动化注册表
  `registerApprovalOutcome(subjectType, handler)` + 终审语境类型
  (payload/submittedById/actorId)——批准即生效的属主域接缝,与
  subjects/esign/workflow 三个注册表同一裁法,本表第一个成员是 user_role
- `apps/api/src/approval/service.ts`:SubmitCommand 加 payload;
  `payload_required` 拒绝(带 outcome 注册的 subjectType 不带参数不放行,
  通用提交端点天然被挡);提交审计 detail 带 payload;终审批准在**同一事务**
  调 outcome 处理器(处理器抛错 = 整个裁决回滚);请求视图暴露 payload
- `apps/api/src/routes/approvals.ts`:通用提交端点映射 `payload_required`
  → 422
- `apps/api/src/authz/role-approval.ts`(新):R-16-6 消费方接线——
  user_role 的可见性门(目标用户 + roles.assign 持有者)、批准即生效
  处理器(grant/revoke + role.granted/revoked 审计,detail 带
  via/requestId/submittedBy,幂等收场不重复审计)、payload zod
  (OWNER_APPROVAL_ROLES 收口)
- `apps/api/src/authz/service.ts`:createAuthzStore 参数收窄为结构子集
  `Pick<Db, "select" | "insert" | "delete">`(outcome 处理器拿终审事务
  连接造同款 store)
- `apps/api/src/routes/user-roles.ts`:高权限角色门改造——owner 直接执行
  (R-16-5);其余 roles.assign 持有者:线已配置 → 202 建审批请求
  (payload 记 action/role),已在飞 → 409 `owner_approval_pending`,
  线未配置/停用 → 403 `owner_approval_required`(切片 1 fail-closed
  保持);无变化的操作(已持有/本没持有)不进线
- `apps/api/src/app.ts`:装载 `authz/role-approval.ts` 接线
- `apps/api/src/authz/permissions.ts`:OWNER_APPROVAL_ROLES 注释更新
- `vitest.config.ts`:`hookTimeout: 30_000`(见判断层 5)
- 测试:`apps/api/src/routes/user-roles.test.ts` 转**独立临时库**模式
  (+10 条消费方测试,共 18);`apps/api/src/routes/approvals.test.ts`
  (+2 条内核 payload/outcome 测试,共 15)
- 文档:`docs/approval.md`(切片 2 章节 + 剩余项收缩)、
  `docs/permissions.md`(R-16-6 三处)、`docs/audit.md`(role.granted/
  revoked 的 via:approval detail 约定)

### 验证

- `DATABASE_URL=… corepack pnpm verify` 全绿:74 文件 / 559 测试
  (新增 12);本地 postgres
- 基线对照:主检出(无本分支改动)同库全绿 547,证明 realtime/tasks
  偶发 teardown 超时由本分支引入并按判断层 5 处置,处置后 4 连绿

## 判断层(手写)

### 本次的关键判断

1. **「哪个角色」必须在审批请求自身上(payload 列),而不是编码在
   configKey 里**:审批人必须看得见「批的到底是什么」——#221 要点
   「审批记录可追溯」的申请侧。备选是每角色一条线(role_grant_admin 等
   三个 configKey),零 schema 改动,但把业务参数伪装成配置身份,audit
   和请求视图都只能靠字符串反解析。payload 是通用机制(折扣审批带金额、
   采购审批带阈值都是同一形态),一次把接缝做对。代价是 0015 一列
   (expand-only)。
2. **批准即生效裁成「内核终审事务内调属主域处理器」**,而不是「批准后
   发起重试」或「定时对账」。重试模型有永久绿灯问题(批准过的请求永远
   放行后续同名操作,撤销后重授都不再过门);outcome-in-tx 让角色生效与
   老板的裁决原子——不存在「批了但没生效」的中间态,与「审计行与裁决同
   事务」的既有纪律同构。处理器抛错回滚整个裁决(fail closed,修好数据
   重裁),集成测试覆盖了这条回滚路径。
3. **审批线未配置时保持 403 fail-closed,不预置种子数据**:把
   `user_role`/`role_grant` 种进 migration 会让 owner 被一条不可改写的
   线定义锁死(配置不可变,#226 才有停用/版本化)——替 owner 定终身是
   越权。线由持 approval.configure 的人经 API 按需建;线不存在的世界里,
   行为与切片 1 完全一致(既有测试原样绿)。
4. **撤销与授予同门进审批**(R-16-6 字面只说「授予」):不对称会留下
   「管理员申请授予、却永远要老板亲手撤销」的怪状态;且这不是放松——
   老板终审的门槛没变,变的只是谁来填表。payload 的 action 字段让两条
   路径共享一条线。
5. **vitest hookTimeout 10s → 30s(全局一处)**:本切片把临时库测试文件
   +1 后,并行跑全量时 realtime/tasks 的 afterAll(pool.end/drop with
   force)开始确定性超时——主检出基线全绿,单文件全绿,纯负载型。teardown
   慢不是测试失败,全局给足窗口比逐文件加 timeout 参数诚实;顺手给本文件
   补上房规 pool.on("error") 消音。若 CI 上再出同类超时,下一档是压
   fileParallelism,不在本切片动。
6. **user-roles.test.ts 转独立临时库是硬需求不是洁癖**:审批请求的
   submitted_by_id 对 auth_user 是 no-action FK,approval_actions 又是
   append-only(行级触发器拒删)——共享库上「测完删用户」的 afterEach
   第一条审批测试就会炸;TRUNCATE 是唯一清库通道,而共享库 TRUNCATE 会
   抹并行文件的断言面(#29 的老坑)。纪律与 approvals.test.ts 完全一致。

### 踩的坑

1. **worktree 里 cwd 漂移**:corepack pnpm db:generate 第一次在
   packages/db 里跑,报 Command not found(gotcha 34,老坑重现)——
   一律显式 cd 到 worktree 根。
2. **eslint 两连**:泛型参数只用一次被 no-unnecessary-type-parameters 打回
   (esign 的 signSubject 用泛型是因为 TDb 出现在多参数位;工厂函数直接用
   Pick 子集即可);异步箭头无 await 被 require-await 打回(fixture 处理器
   用 Promise.reject 显式表达)。都是结构修正,没压 lint。
3. **局部修改类型收窄时差点重蹈 gotcha 65**:第一版 createAuthzStore 用
   泛型收窄想绕逆变,被 lint 打回后才想清楚——这里是工厂函数参数不是
   存储的回调,结构子集直收,无逆变问题。教训:gotcha 的适用条件也要记。
