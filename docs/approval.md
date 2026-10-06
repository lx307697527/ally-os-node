# 审批（#221）

老系统的审批散落各域、规则写死：报价超阈值走 `pricing.quote_approval_threshold()`
+ `security` 域的 approval_requests/outbox（feat349 只是把「该谁批」的通知接通），
SFP 审批只在前端判断——记录不全、没有统一的「谁、何时、结论、签名含义」可查
（#221 正文原话）。

新设计（#232 §4.9 v2.2）：审批流转**自建**（执行后续随 pg-boss 与现有后台作业
同轨），审批路线的触发条件（金额区间 → 谁批）用 GoRules 决策表、随规则注册表
（#233）进场。多级审批、驳回回到发起人的形态参考 NocoBase 审批节点；「业务审批
可以自批」（R-16-5）是内核默认——职责分离只用于质量放行（R-15-4），随 phase-3/4
的属主域落地。表结构上 config / request / action 与流程内核（#220）的
template / instance / transition 同构。

## 已落地：审批内核（#221 切片 1，API only）

| 部分 | 位置 | 说明 |
| --- | --- | --- |
| 数据模型 | `packages/db/src/schema.ts`（migration `0014`） | `approval_configs`（subject 开集 text + configKey 唯一 + levels jsonb + version = #226 台账版本）、`approval_requests`（**levels 提交时刻快照** + currentStep/status + 同单同线至多一个在飞请求的部分唯一索引）、`approval_actions`（裁决流水，**append-only 触发器**，与 audit_events/esign_signatures/workflow_transitions 同一裁决） |
| 级别形状 | `apps/api/src/approval/service.ts` | `[{ name, users, roles, requireSignature, signatureMeaning }]`——审批人 = 指定人员 ∪ 指定角色（app_role 闭集，customer 不可为审批人）；保存时 zod 收口，1–10 级 |
| 服务 | `apps/api/src/approval/service.ts` | `submitApprovalRequest`（读 active 配置 → levels 快照进请求 → 部分唯一索引挡并发双提交）、`actOnApproval`（审批人匹配 → 2FA 门 → 签名仪式 → **事务内**：action 行 + esign 签名 + CAS 推进 + 审计 + 终态通知发起人；驳回任何一级 = 终态，单据回到发起人）、`approvalTodo`（待我审批：在飞请求当前级点名我或我的角色命中） |
| 接缝注册 | `apps/api/src/approval/registry.ts` | 模块装载时接线三个消费方向：① 工作流门槛积木 **`approval.passed`**（#220 blocks 注册表的第一批成员：门槛 = 该单据该线存在 approved 请求，未提交/被驳回都不过门）；② esign 可签名 subject **`approval_action`**（#219 预告的第一个消费域：签名绑定裁决行的版本与内容快照）；③ approval_action 的可见性门（发起人 + 点名审批人 + 已裁决人 + 配置角色现任持有者） |
| 路由 | `routes/approvals.ts` | 配置两端点在 `approval.configure` 权限点后（owner/admin 默认）；请求提交/详情过**单据可见性门**（subjects/registry.ts，看得到单据才看得到它的审批），待办与裁决由**配置点名**授权——两扇门各管各的：角色审批人不要求恰好是单据可见者 |
| 权限点 | `authz/permissions.ts` | `approval.configure`：改审批路线 = 改「谁有权裁决什么」，配置工作室归 owner/admin；提交与裁决不在此点后（配置点名即授权，自批合法 R-16-5） |
| 审计 | `docs/audit.md` 词表 | `approval.config_created` / `approval.requested` / `approval.action_recorded`（detail 带 level/decision/note/signatureMeaning）/ `approval.completed` / `approval.rejected` |

## 级别配置

```jsonc
[
  {
    "name": "lead review",
    "users": ["<uuid>"],        // 指定人员（最多 20）
    "roles": ["sales_lead"],    // 指定角色（app_role 闭集，customer 拒收）
    "requireSignature": false,  // 这级的「同意」是否要求电子签名
    "signatureMeaning": "reviewed" // 签名含义（Part 11.50）：reviewed | approved
  }
]
```

- 审批人集合 = `users ∪ 持有 roles 的人`，任一命中即可裁决（NocoBase 的
  多人审批方式——会签/票签——不在本切片，见剩余项）；
- `requireSignature` 只约束**同意**：驳回不签（回到发起人是内部协作，不是
  监管事实）；签名仪式复用 #219 内核（重输密码 + 双因素 + 幂等 clientToken），
  签名含义取级别配置；
- 请求提交时整份 levels 快照进 `approval_requests`——配置改版/停用不改写在飞
  请求的审批路线（与流程实例的 definition 快照同一裁决）。

## 失败语义（fail closed 的层次）

1. 请求已终态后再裁决 → 409 `request_closed`；
2. 调用者不在当前级的审批人集合 → 403 `not_approver`；
3. 要求签名而审批人未启用 2FA → 403 `two_factor_required`（先于密码判定，
   与 esignatures 路由同一语义）；
4. 要求签名而请求没带 `password`+`clientToken` → 422 `signature_required`；
   密码错 → 401 `invalid_credentials`（**整包回滚**：裁决行、签名行、推进、
   审计全都不存在）；clientToken 重放按 #219 幂等语义返回原行；
5. 并发裁决同级：action 行的 `(request_id, step_index)` 唯一约束串行化，
   CAS（UPDATE 带 current_step/status 条件）守住状态迁移 → 输家 409
   `concurrent_conflict`（晚到读到终态的同答 `request_closed`——不变式是
   只有一个赢家，不是拒绝理由的唯一性）；
6. 提交时配置不存在/停用 → 404 `config_not_found`；已有在飞请求 → 409
   `already_pending`（附 requestId）；subject 类型未注册 400 / 不可见 404
   （反探测，与评论同扇）。

## 已落地：批准即生效 + 第一个消费方（#221 切片 2）

| 部分 | 位置 | 说明 |
| --- | --- | --- |
| 请求参数 | `packages/db/src/schema.ts`（migration `0015`） | `approval_requests.payload` jsonb（可空）：属主域进程内提交时带上（如角色变更的 `{action, role}`）——审批人必须看得见「批的到底是什么」，纯记录线可不带 |
| 结果自动化注册表 | `apps/api/src/approval/outcomes.ts` | `registerApprovalOutcome(subjectType, handler)`：终审**批准**的同一事务里调用属主域处理器（角色生效、折扣放开……），业务效果与裁决要么全成要么全不算；处理器抛错 = 整个裁决回滚（fail closed，修好数据可重裁）。驳回与中间级通过不触发；未注册 subjectType 走纯记录线 |
| payload 门 | `approval/service.ts` `submitApprovalRequest` | 带 outcome 注册的 subjectType 提交时必须带 payload，否则 `payload_required`——通用提交端点（`POST /api/approval-requests`）不收 payload，天然被挡（422），无参数死请求进不了在飞位；带自动化线的唯一提交路径是属主域自己的路由 |
| 第一个消费方（R-16-6） | `apps/api/src/authz/role-approval.ts` + `routes/user-roles.ts` | 管理员授予/撤销 owner/admin/finance 走审批：审批线（`user_role`/`role_grant`）已配置 → 202 建请求（payload 记 `{action, role}`），老板终审批准即生效（同一事务写 user_role + `role.granted`/`role.revoked` 审计，detail 带 `via`/`requestId`/`submittedBy`，actor 记终审批准人）；线未配置/停用 → 保持切片 1 的 fail-closed（403 `owner_approval_required`，只允许 owner 直接执行，不预置配置数据）；owner 本人任何时候直接执行（R-16-5 自批）；无变化的操作（已持有/本没持有）不进线 |
| user_role 可见性门 | `subjects/registry.ts`（`authz/role-approval.ts` 注册） | `user_role` subject 的可见者 = 目标用户本人 + 持 `roles.assign` 角色（owner/admin）的人——审批详情（含 payload、各级裁决）给审批人看，与角色管理端点同一扇权限门 |

## 已落地：待办页 + 签名对话框首消费（#221 切片 3）

| 部分 | 位置 | 说明 |
| --- | --- | --- |
| 待办行裁决语境 | `apps/api/src/approval/service.ts` `approvalTodo` | 待办行携带裁决所需的一切：`submittedBy`（谁在等）、`payload`（批的到底是什么，与详情读法同字段）、`requireSignature`/`signatureMeaning`（当前级同意要不要签名仪式、什么含义）——配置点名的裁决人不必恰好是单据可见者，**行本身就得够裁**；422 `signature_required` 仍是服务端底线，不是 UI 的发现路径 |
| 待办页 | `apps/web/src/shared/pages/Approvals.tsx`（`/approvals`，Home 区） | 在飞请求逐行展开：payload 渲染成标签/值行（`payload-rows.ts` 纯函数，snake_case 读成词）、备注（可选）、批准/驳回；陈旧收件箱（`gone`/`conflict`/`not_approver`）收起面板 + 换来实话——绝不说「Decision recorded」，这条裁决没落就是没落 |
| 两扇门在页面里都说话 | `Approvals.tsx` ReviewPanel | 详情记录仍过单据可见性门：看得到 → 完整历史（各级谁批/驳、备注、签名含义与时刻）；看不到（404）→ 明说「完整记录限于能看到单据的人,按上方摘要裁决」——点名授权与单据可见性各管各的，不装作另一扇不存在 |
| 签名对话框（#219 前端半边） | `apps/web/src/shared/components/SignatureDialog.tsx` | 仪式三件：会话外重输密码、含义按级别配置**展示**（Part 11.50 签名展示，不由签署人挑）、每次尝试新铸 `clientToken`（重放幂等靠它，被拒的重试是真新事件）；组件只管仪式，裁决调用与错误归消费页——#204 批次放行等后续签署场景扩展而非分叉 |

## 已落地：审批路线决策表（#221 决策表进线 × #233）

「进哪条线」不再由属主域硬编码 configKey——`approval.routing.<subjectType>`
（规则注册表 decision_table 值类型，见 docs/rules.md 决策表专节）裁决：

| 部分 | 位置 | 说明 |
| --- | --- | --- |
| 路由解析 | `apps/api/src/approval/routing.ts` | `resolveApprovalRoute(db, subjectType, facts)`：读路由决策表 → `hitPolicy first` 命中行 → 输出 `configKey`（输出列 field 必须叫 configKey 的字符串单值）。matched → 调用方提交；unmatched 折叠六因（表缺失/未设/坏表/求值失败/无命中/输出不合法）由调用方 **fail closed**——未命中不是「不用审批」，是「不许跳过审批的暗门也不开」 |
| 首个路由种子 | migration `0023` | `approval.routing.user_role`（gate 类别，R-16-6）：`{action} → configKey`，grant/revoke → `role_grant`，与切片 2 的硬编码行为逐条等价；台账补 source='created' 的 v1。改线 = 按裁决 PATCH 这条规则（谁能改 admin+owner），回滚走 #226 台账 |
| 消费方改造 | `routes/user-roles.ts` | 授予/撤销的高级角色门前先问路由表；unmatched 与线不存在同答 403 `owner_approval_required`（reason 进日志）；owner 直通（R-16-5）不查表 |

验收对照（#221「触发条件：如折扣超过阈值、采购金额超过阈值（阈值由配置决定）」
的机制半边）：决策表形态已可表达金额区间 → 谁批（测试里有 25 万美元 PO → boss
线的演练表），属主域把 `{amount, ...}` 交给 `resolveApprovalRoute` 即接线；
真实的金额域消费（报价 #229 / 采购 #231）随各自域切片进场。

## 刻意不在这切片里的（#221 保持 open）

- ~~**触发条件与自动进入**~~：机制半边已落地（路由决策表 + R-16-6 消费）；剩余
  是金额域的首次接线（#229/#231）。
- ~~**pg-boss 执行与提醒**~~：已落地（见下一节）。剩余是会签/票签等需要 pg-boss
  编排的多人推进形态。
- **多人审批方式**：会签（全员同意）/票签（多数决）——现在任一命中即过。
- **配置面管理（#226）**：configKey 替换 = 建新键 + 停用旧行，停用端点与定义
  改写端点随 #226 后续切片；版本台账已进场——审批线创建即记 v1，版本史/差异
  可读（docs/config-versions.md），回滚对该族答 409（无就地改写路径）。
- **后台审批配置 UI**：随配置工作室前端进场（R-16-6 的审批线配置目前由持
  `approval.configure` 的人经 API 创建一次）。

## 已落地：多级通知扇出 + pg-boss 催办（#221 通知切片）

**扇出（api 内核，apps/api/src/approval/service.ts）**：轮到谁审，谁就在铃铛里。
提交 → 首级审批人各一行 `approval.pending`；非末级同意 → 下一级审批人（与推进
同一事务：推进回滚 = 通知不存在）；终态 → 发起人（`approval.completed` /
`approval.rejected`，切片 1 已有，payload 补了 configName/actorName 事实）。
审批人集合 = 点名 users ∪ 角色持有者（app_role 枚举过滤）；动作方不给自己报信
（自批线不自我通知，task.assigned「派给自己不发」同一裁法）。行只存事实
（configName/levelName/actorName/detail），文案在展示层
（apps/web notification-face：白名单收 pending/reminder → `/approvals`；终态
刻意不在白名单——还没有承载页，兜底面亮类型 + 事实）。实时「催」在事务提交后
发（notifyUsers at-most-once，失败只降级轮询）。

**催办（worker，apps/worker/src/approval/reminder.ts）**：`approval-reminders`
每小时 ：45 对账扫描（与规则提醒 13:00、邮件摘要 13:30 同锚错峰）。在飞请求在
本级停满 24h（`APPROVAL_REMIND_AFTER_MS`）没人裁 → 当前级审批人各一行
`approval.reminder`；再催要隔另一个 24h；级推进后按新级重新计时。停留时刻 =
最后一条 action 的 createdAt（在飞请求上已有 action 都是已完成级），首级回落
提交时刻。台账 `approval_requests.last_reminder_at/last_reminder_step`（0026，
expand-only）：盖章先行且带 current_step/status 条件——扫描期间被推进/关闭的
请求本轮不催，盖章与通知行同一事务。开邮件摘要的人，催办行自动进每日摘要
（#116 渠道层，digest 拾取 payload 的 detail 事实），无需单独邮件通道。

**worker 侧 levels 读法（不跨 app 依赖的裁法）**：审批内核在 apps/api，worker
用窄读取 schema 只投影提醒需要的 name/users/roles 三字段——写面的完整校验仍是
api 的 approvalLevelsSchema 一处收口；读不准的快照跳过并告警（含审批人集合为空：
配置只点了无人持有的角色是合法配置，但一条没人看得见的提醒是假成功）。

**刻意不做**：审批没有超时拒绝——业务自批（R-16-5）之下没人有权替审批人做决定，
催办只是把「这儿等着」再递一次。24h 常量目前不进配置面：需要调的人还没有，
第一个要调的消费域把它抬进审批线配置（expand-only）。
