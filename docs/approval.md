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
| 数据模型 | `packages/db/src/schema.ts`（migration `0014`） | `approval_configs`（subject 开集 text + configKey 唯一 + levels jsonb + version 预埋 #226）、`approval_requests`（**levels 提交时刻快照** + currentStep/status + 同单同线至多一个在飞请求的部分唯一索引）、`approval_actions`（裁决流水，**append-only 触发器**，与 audit_events/esign_signatures/workflow_transitions 同一裁决） |
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

## 刻意不在这切片里的（#221 保持 open）

- **触发条件与自动进入**：「满足条件的单据自动进入审批」的路线（金额区间 →
  谁批）是 GoRules 决策表，存进规则注册表（#233）——决策表进场后，属主域在
  业务动作里调 `submitApprovalRequest`（进程内，与 startWorkflow 同形态）。
- **第一个真实消费方（R-16-6）**：授予 owner/admin/finance 角色需老板确认——
  `routes/user-roles.ts` 现在的 fail-closed 等价物（只允许 owner 本人执行）
  在审批内核接上后改为「创建审批请求」（切片 2）。
- **pg-boss 执行与提醒**：超时未裁决的催办、多级的通知扇出（#116 渠道层）。
- **多人审批方式**：会签（全员同意）/票签（多数决）——现在任一命中即过。
- **配置面管理（#226）**：configKey 替换 = 建新键 + 停用旧行，停用端点与
  版本化随 #226；version 列已预埋（恒 1）。
- **后台审批配置 UI 与待办页**：随配置工作室前端进场（待办数据面
  `GET /api/approval-requests/todo` 已就绪）。
