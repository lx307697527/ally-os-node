import type { Permission } from "../authz/permissions.ts";

/**
 * API 路由的授权声明清单（#23 验收第 2 条：「每个 API 路由都有授权声明，缺失时
 * lint / 测试会报错」）。
 *
 * 每个落在 /api/* 下的路由必须在这里有一行 auth 声明；`route-auth.test.ts` 把
 * app.routes 的实际路由和这份清单做双向比对——新路由没声明、或声明指向已不存在的
 * 路由，测试都会红。声明是给人审的（PR diff 上一眼可见）、测试是逼人写的：
 * kind: "permission" 的路由还必须有覆盖 403 的集成测试。
 *
 * /api/auth/*（Better Auth 自管端点）、/health、/ready 不在会话中间件之后，也逐条
 * 列在这里（auth: "public"），保证清单是完整的路由册而不是「受保护路由的补遗」。
 */
export type RouteAuth =
  | { kind: "public" }
  | { kind: "session" }
  | { kind: "permission"; permission: Permission };

export interface RouteDecl {
  /** HTTP 方法；"*" = 该路径的任意方法（用于 /api/auth/* 这类方法集合端点） */
  method: string;
  /** Hono 路径模式，与 app.route 注册的一致（含 :param、* 通配） */
  path: string;
  auth: RouteAuth;
}

export const API_ROUTES: readonly RouteDecl[] = [
  // 公开：登录前可访问（健康检查在 /health、/ready，不在 /api/* 下，不列）
  { method: "*", path: "/api/auth/*", auth: { kind: "public" } },
  { method: "GET", path: "/api/auth-providers", auth: { kind: "public" } },
  // 登录即可
  { method: "GET", path: "/api/me", auth: { kind: "session" } },
  // 角色/权限管理（#23）：admin / owner（R-16-6 的高级角色门在路由内部再加一层）
  { method: "GET", path: "/api/users/:userId/roles", auth: { kind: "permission", permission: "roles.assign" } },
  { method: "POST", path: "/api/users/:userId/roles", auth: { kind: "permission", permission: "roles.assign" } },
  { method: "DELETE", path: "/api/users/:userId/roles/:role", auth: { kind: "permission", permission: "roles.assign" } },
  // 站内通知（#129）：铃铛的单读摘要 + 已读/全读，全部只操作本人行
  { method: "GET", path: "/api/notifications/summary", auth: { kind: "session" } },
  { method: "POST", path: "/api/notifications/:id/read", auth: { kind: "session" } },
  { method: "POST", path: "/api/notifications/read-all", auth: { kind: "session" } },
  // 通知渠道偏好（#116）：本人数据面（与已读端点同扇），登录即可
  { method: "GET", path: "/api/notifications/preferences", auth: { kind: "session" } },
  { method: "PUT", path: "/api/notifications/preferences", auth: { kind: "session" } },
  // 反馈上报（#129）：任何登录者可提交
  { method: "POST", path: "/api/feedback-reports", auth: { kind: "session" } },
  // 任务（#113 切片 1）：创建人/经办人本人数据，登录即可；团队全局视图的
  // 权限点随 RBAC 模块切片裁决
  { method: "GET", path: "/api/tasks", auth: { kind: "session" } },
  { method: "POST", path: "/api/tasks", auth: { kind: "session" } },
  { method: "GET", path: "/api/tasks/assignee-options", auth: { kind: "session" } },
  { method: "GET", path: "/api/tasks/:id", auth: { kind: "session" } },
  { method: "PATCH", path: "/api/tasks/:id", auth: { kind: "session" } },
  // 任务删除（#29 切片 2）：创建人动词（软删 + 台账快照），登录即可——动词的
  // 行属门（delete_creator_only）在路由内，与改派门同一家族
  { method: "DELETE", path: "/api/tasks/:id", auth: { kind: "session" } },
  // 评论（#110 切片 1）：多态 subject 的行属门在路由内逐域裁决（task =
  // 创建人/经办人），登录即可——可评即可见，无新权限点
  { method: "GET", path: "/api/comments", auth: { kind: "session" } },
  { method: "POST", path: "/api/comments", auth: { kind: "session" } },
  { method: "PATCH", path: "/api/comments/:id", auth: { kind: "session" } },
  { method: "DELETE", path: "/api/comments/:id", auth: { kind: "session" } },
  // 评论附件（#110 收尾切片）：名单与下载门 = subject 可见者（与评论同扇），
  // 上传与摘除 = 评论作者（与编辑/删除同一家族），均登录即可，无新权限点
  { method: "GET", path: "/api/comments/:id/attachments", auth: { kind: "session" } },
  { method: "POST", path: "/api/comments/:id/attachments", auth: { kind: "session" } },
  { method: "GET", path: "/api/comments/:id/attachments/:attachmentId/url", auth: { kind: "session" } },
  { method: "DELETE", path: "/api/comments/:id/attachments/:attachmentId", auth: { kind: "session" } },
  // 活动流（#110 切片 3）：audit_events 的按对象读投影，subject 可见者门与
  // 评论同扇（subjects/registry.ts），登录即可——投影只含该 subject 自己的
  // 行，看得到对象就看得到对象的历史；全公司日志仍走 audit.read
  { method: "GET", path: "/api/activity", auth: { kind: "session" } },
  // 关注（#110 切片 4）：多态 subject 的行属门在路由内逐域裁决（与评论同一
  // 扇门），登录即可——看得到才能关注，关注者集合是可见者集合的子集
  { method: "GET", path: "/api/follows/:subjectType/:subjectId", auth: { kind: "session" } },
  { method: "PUT", path: "/api/follows/:subjectType/:subjectId", auth: { kind: "session" } },
  { method: "DELETE", path: "/api/follows/:subjectType/:subjectId", auth: { kind: "session" } },
  // 电子签名（#219）：签名仪式（重输密码 + 2FA 门在路由内）与签名墙读法，
  // subject 可见性门与评论同扇；可签名类型由属主域注册（esign/registry.ts），
  // Part 11 不设「无需双因素即可签名」的例外，故无新权限点
  { method: "POST", path: "/api/esignatures", auth: { kind: "session" } },
  { method: "GET", path: "/api/esignatures", auth: { kind: "session" } },
  // 流程模板（#220）：配置工作室的流程配置面，改流程 = 改全员的工作方式，
  // workflow.configure 权限点门（owner/admin 默认持有）
  { method: "POST", path: "/api/workflow-templates", auth: { kind: "permission", permission: "workflow.configure" } },
  { method: "GET", path: "/api/workflow-templates", auth: { kind: "permission", permission: "workflow.configure" } },
  { method: "GET", path: "/api/workflow-templates/:id", auth: { kind: "permission", permission: "workflow.configure" } },
  { method: "PATCH", path: "/api/workflow-templates/:id", auth: { kind: "permission", permission: "workflow.configure" } },
  // 流程实例（#220）：状态读法 / 推进 / 历史三读，subject 可见性门与评论同扇
  // （推进另过员工地板 + 模板 roles/gates，在服务层）；可挂流程类型由属主域
  // 注册（workflow/registry.ts），实例启动是属主域进程内调用，无 HTTP 面
  { method: "GET", path: "/api/workflow-instances/:subjectType/:subjectId", auth: { kind: "session" } },
  { method: "POST", path: "/api/workflow-instances/:subjectType/:subjectId/transitions", auth: { kind: "session" } },
  { method: "GET", path: "/api/workflow-instances/:subjectType/:subjectId/transitions", auth: { kind: "session" } },
  // 审批线管理（#221）：配置工作室的审批配置面，改审批路线 = 改「谁有权裁决
  // 什么」，approval.configure 权限点门（owner/admin 默认持有）
  { method: "POST", path: "/api/approval-configs", auth: { kind: "permission", permission: "approval.configure" } },
  { method: "GET", path: "/api/approval-configs", auth: { kind: "permission", permission: "approval.configure" } },
  // 就地改写/停用（#221 配置 UI）：真变更 bump 版本记 #226 台账,回滚端点随
  // applyRevision 对审批族开放（config-versions 路由,动态按族同一权限点）
  { method: "PATCH", path: "/api/approval-configs/:id", auth: { kind: "permission", permission: "approval.configure" } },
  // 审批请求（#221）：提交与详情过单据可见性门（subjects/registry.ts）；待办
  // 与裁决由配置点名授权（users/roles 命中即审批人），要求签名的级别在服务层
  // 过 2FA 门 + 签名仪式（#219 内核），自批合法（R-16-5），无新权限点
  { method: "POST", path: "/api/approval-requests", auth: { kind: "session" } },
  { method: "GET", path: "/api/approval-requests/todo", auth: { kind: "session" } },
  { method: "GET", path: "/api/approval-requests/:id", auth: { kind: "session" } },
  { method: "POST", path: "/api/approval-requests/:id/actions", auth: { kind: "session" } },
  // 自定义字段（#222）：字段配置在 custom_fields.configure 权限点门（owner/admin
  // 默认持有）；表单 schema 合成与字段值读写是填表人的面——登录即可，字段级
  // viewableBy/editableBy 与 subject 可见性门在路由内逐字段裁决
  { method: "POST", path: "/api/custom-fields", auth: { kind: "permission", permission: "custom_fields.configure" } },
  { method: "GET", path: "/api/custom-fields", auth: { kind: "permission", permission: "custom_fields.configure" } },
  { method: "PATCH", path: "/api/custom-fields/:id", auth: { kind: "permission", permission: "custom_fields.configure" } },
  { method: "GET", path: "/api/custom-fields/schema", auth: { kind: "session" } },
  { method: "GET", path: "/api/subjects/:subjectType/:subjectId/custom-fields", auth: { kind: "session" } },
  { method: "PUT", path: "/api/subjects/:subjectType/:subjectId/custom-fields", auth: { kind: "session" } },
  // 自动化规则（#224 切片 1）：规则配置 + 执行日志读面，全部在
  // automations.configure 权限点门（owner/admin）——新增规则 = 改全公司的连锁
  // 反应，执行面在 worker（pg-boss），API 只开配置与观测
  { method: "POST", path: "/api/automations", auth: { kind: "permission", permission: "automations.configure" } },
  { method: "GET", path: "/api/automations", auth: { kind: "permission", permission: "automations.configure" } },
  { method: "GET", path: "/api/automations/runs", auth: { kind: "permission", permission: "automations.configure" } },
  { method: "PATCH", path: "/api/automations/:id", auth: { kind: "permission", permission: "automations.configure" } },
  { method: "DELETE", path: "/api/automations/:id", auth: { kind: "permission", permission: "automations.configure" } },
  // 编号规则（#225）：配置工作室的编号配置面，改格式 = 改所有之后发出的单据号，
  // numbering.configure 权限点门（owner/admin 默认持有）；发号无 HTTP 面——
  // 分配是属主域创建单据事务里的进程内调用（numbering/service.ts）
  { method: "POST", path: "/api/numbering-rules", auth: { kind: "permission", permission: "numbering.configure" } },
  { method: "GET", path: "/api/numbering-rules", auth: { kind: "permission", permission: "numbering.configure" } },
  { method: "GET", path: "/api/numbering-rules/subjects", auth: { kind: "permission", permission: "numbering.configure" } },
  { method: "PATCH", path: "/api/numbering-rules/:id", auth: { kind: "permission", permission: "numbering.configure" } },
  // 配置版本台账（#226）：subjects 列表登录即可（只有族名与展示名）；史/差异/
  // 回滚按族动态裁决 = 各族配置面的同一权限点（config-versions/registry.ts 注册
  // 时声明，路由内检查——回滚 = 改那族的配置，不能比配置面宽松），403 面在
  // config-versions.test.ts 覆盖
  { method: "GET", path: "/api/config-versions/subjects", auth: { kind: "session" } },
  { method: "GET", path: "/api/config-versions/:subjectType/:subjectId", auth: { kind: "session" } },
  { method: "GET", path: "/api/config-versions/:subjectType/:subjectId/revisions/:version", auth: { kind: "session" } },
  { method: "GET", path: "/api/config-versions/:subjectType/:subjectId/diff", auth: { kind: "session" } },
  { method: "POST", path: "/api/config-versions/:subjectType/:subjectId/rollback", auth: { kind: "session" } },
  // 配置草稿与一键发布（#226 切片 2）：存/读/弃/发都是「改那族配置」，同一扇
  // 动态族门（路由内检查），403 面在 config-drafts.test.ts 覆盖
  { method: "GET", path: "/api/config-drafts/:subjectType/:subjectId", auth: { kind: "session" } },
  { method: "PUT", path: "/api/config-drafts/:subjectType/:subjectId", auth: { kind: "session" } },
  { method: "DELETE", path: "/api/config-drafts/:subjectType/:subjectId", auth: { kind: "session" } },
  { method: "POST", path: "/api/config-drafts/:subjectType/:subjectId/publish", auth: { kind: "session" } },
  // 规则注册表（#233）：读面登录即可（全公司共用的业务参数，非敏感数据）；
  // PATCH 的改权是逐规则的（行上角色数组 + owner 恒可 + 开关启用过 enableBy），
  // 路由内裁决，403 面在 rules.test.ts 覆盖——刻意不走 rules.configure 权限点门
  { method: "GET", path: "/api/rules", auth: { kind: "session" } },
  { method: "GET", path: "/api/rules/:key", auth: { kind: "session" } },
  { method: "PATCH", path: "/api/rules/:key", auth: { kind: "session" } },
  // 审计日志查询（#29）：owner / admin（audit.read 权限点）
  { method: "GET", path: "/api/audit-events", auth: { kind: "permission", permission: "audit.read" } },
  // 删除记录的查看与恢复（#29 切片 2）：audit.read 同门——恢复把全公司可见性
  // 已关闭的行重新打开，是合规面动词，不随消费域给行属开 Trash 入口
  { method: "GET", path: "/api/deleted-records", auth: { kind: "permission", permission: "audit.read" } },
  { method: "POST", path: "/api/deleted-records/:id/restore", auth: { kind: "permission", permission: "audit.read" } },
  // 发票（#192 切片 1）：草稿状态机 + 财务确认面，invoices.manage 权限点门
  // （finance/owner 默认持有）。触发点的系统生成是属主域进程内调用，无 HTTP 面
  { method: "POST", path: "/api/invoices", auth: { kind: "permission", permission: "invoices.manage" } },
  { method: "GET", path: "/api/invoices", auth: { kind: "permission", permission: "invoices.manage" } },
  { method: "GET", path: "/api/invoices/:id", auth: { kind: "permission", permission: "invoices.manage" } },
  { method: "PATCH", path: "/api/invoices/:id", auth: { kind: "permission", permission: "invoices.manage" } },
  { method: "POST", path: "/api/invoices/:id/confirm", auth: { kind: "permission", permission: "invoices.manage" } },
  { method: "POST", path: "/api/invoices/:id/void", auth: { kind: "permission", permission: "invoices.manage" } },
  // 收款台账（#192 切片 2）：发票锚定的记账/读法与更正动词，invoices.manage
  // 同门（#232 §12 财务「认领收款」）。#193 的 webhook 记账是进程内接缝
  // （billing/payments.ts recordPayment），不走这扇财务门
  { method: "POST", path: "/api/invoices/:id/payments", auth: { kind: "permission", permission: "invoices.manage" } },
  { method: "GET", path: "/api/invoices/:id/payments", auth: { kind: "permission", permission: "invoices.manage" } },
  { method: "POST", path: "/api/payments/:id/void", auth: { kind: "permission", permission: "invoices.manage" } },
  // Stripe 渠道（#193）：checkout 链接是财务面（invoices.manage 同门）；webhook
  // 是 provider 面——公开指「不过会话中间件」，认证 = Stripe-Signature 验签
  // （routes/stripe-webhook.ts），漏登记才是真的口子
  { method: "POST", path: "/api/invoices/:id/stripe-checkout", auth: { kind: "permission", permission: "invoices.manage" } },
  { method: "*", path: "/api/webhooks/stripe", auth: { kind: "public" } },
  // 实时连接令牌（#110 切片 2）：把调用者自己会话的令牌发还给本人，WS auth
  // 帧用（cookie HttpOnly，浏览器拿不到）——session 门，令牌即会话本身
  { method: "GET", path: "/api/realtime/token", auth: { kind: "session" } },
];
