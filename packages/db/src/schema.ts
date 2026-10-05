import { desc, sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// 审计事件（#23：权限变更必须留审计，对应老系统 R-16-6；查询端点与 append-only
// 底线在 #29）。actor/target 是发起方 / 被操作方的用户 id（text 存 uuid，避免本表
// 反过来依赖 auth 表的存在性）；detail 放变更细节（授予/撤销了哪个角色；状态变更
// 类动作按 docs/audit.md 的词表约定带 from/to）。
//
// 本表 append-only：UPDATE/DELETE 被 0007 migration 的触发器拒绝（#232 数据底线
// 「审计日志不可删除」，老系统 audit_log_is_immutable() 的直译）；测试清库走
// TRUNCATE（行触发器不拦 DDL），生产代码没有这条路。
export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actor: text("actor"),
    action: text("action").notNull(),
    target: text("target"),
    detail: jsonb("detail").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // 日志页唯一的读法是「最新在前翻页」；过滤列不单独建索引——审计是追加上涨的
  // 表，等真实过滤查询慢了再加（老系统 core.audit_log 除主键外同样不建索引）
  (t) => [index("audit_events_created_at_idx").on(desc(t.createdAt))],
);

// ── 认证（#22）───────────────────────────────────────────────────────────────
// Better Auth 的四张核心表。表名带 auth_ 前缀、列名 snake_case；字段与 Better Auth
// 1.7 的核心模型一一对应（user / session / account / verification），由 drizzle
// 适配器按模型名映射。id 用 uuid：issue 要求保留老系统 auth.users 的 uuid 主键，
// 数据迁移（后续切片）按原 id 导入，业务外键不用全表改写。

export const authUser = pgTable(
  "auth_user",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    emailVerified: boolean("email_verified").notNull().default(false),
    // Better Auth two-factor 插件的 user 侧字段（#24）：TOTP 完成首次校验后置
    // true；管理员的强制门（authz/two-factor gate）读它放行或拦截。
    twoFactorEnabled: boolean("two_factor_enabled").notNull().default(false),
    image: text("image"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // 邮箱唯一约束在 lower(email) 上（#25 影子账号）：写入侧全部归一化为小写
  // （better-auth 注册自带 toLowerCase，导入与影子账号服务显式 trim+lower），
  // 索引把「同一邮箱不产生重复账号」从写侧约定升级为结构不变式——未来任何
  // 忘了归一化的写入路径也撞不进第二行，CRM 联系人预建账号的幂等性靠它兜底。
  (t) => [uniqueIndex("auth_user_email_idx").on(sql`lower(${t.email})`)],
);

export const authSession = pgTable(
  "auth_session",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUser.id, { onDelete: "cascade" }),
    token: text("token").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("auth_session_token_idx").on(t.token),
    index("auth_session_user_idx").on(t.userId),
  ],
);

// 一个登录身份一条 account：credential 登录 provider 固定为 "credential"，
// password 列存哈希；后续 Google OAuth / bcrypt 存量哈希导入都是新增 account 行。
export const authAccount = pgTable(
  "auth_account",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUser.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("auth_account_provider_account_idx").on(t.providerId, t.accountId),
    index("auth_account_user_idx").on(t.userId),
  ],
);

// 邮箱验证 / 密码重置等一次性令牌（验证与重置流程在 #22 的后续切片接入）
export const authVerification = pgTable(
  "auth_verification",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("auth_verification_identifier_idx").on(t.identifier)],
);

// ── 双因素认证（#24）────────────────────────────────────────────────────────
// Better Auth two-factor 插件的因子表，一行 = 一个用户的 TOTP 因子。secret 与
// backupCodes 都是密文：secret 是 TOTP 共享密钥（XChaCha20-Poly1305，密钥派生自
// BETTER_AUTH_SECRET，与老系统 GoTrue 的 at-rest 加密同级——老-老系统手搓
// admin-2fa 的明文密钥是审计点名缺陷，勿继承）；backupCodes 是整批备份码明文
// JSON 的加密体。verified = 该因子已完成过一次真实码校验（enable 只落半成品，
// 校验通过才算启用）；failedVerificationCount/lockedUntil 是登录挑战的
// 账号级尝试预算与锁定（NIST SP 800-63B §5.2.2，better-auth 内置）。
export const authTwoFactor = pgTable(
  "auth_two_factor",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    secret: text("secret").notNull(),
    backupCodes: text("backup_codes").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUser.id, { onDelete: "cascade" }),
    verified: boolean("verified").notNull().default(true),
    failedVerificationCount: integer("failed_verification_count").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
  },
  (t) => [index("auth_two_factor_user_idx").on(t.userId)],
);

// 实时推送的在线状态（#30）。一条记录 = 一个连接在一个 presence 频道上的成员资格；
// 同一用户多开标签页是多个连接、多条记录。实例每 30s 心跳刷新 last_seen_at，
// 列表查询和清理都以它判断存活，实例崩溃后的残留因此自动过期。
export const realtimePresence = pgTable(
  "realtime_presence",
  {
    connectionId: text("connection_id").notNull(),
    channelId: text("channel_id").notNull(),
    instanceId: text("instance_id").notNull(),
    userId: text("user_id").notNull(),
    // 客户端订阅 presence 频道时带来的自定义状态（光标位置、正在编辑等）
    state: jsonb("state").$type<Record<string, unknown>>().notNull(),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.connectionId, t.channelId] }),
    index("realtime_presence_channel_idx").on(t.channelId),
  ],
);

// ── 角色与权限（#23）────────────────────────────────────────────────────────
// 权限按「角色 = 一组权限点」建模（#232 §12）：一个人可同时有多个角色；角色之外的
// 附加权限点（如「标签设计」）单独授人。老系统对应物是 core.app_role 枚举 +
// core.user_roles 表 + SECURITY DEFINER 的 has_role()/has_any_role()——那套函数
// 服务于 679 条 RLS 策略；新系统授权在 API 层做（requireRole/requirePermission），
// 数据库不再承担逐表策略。

// 登录角色，闭集：#232 §12 的 14 个员工角色 + 客户门户，裁决原文见
// docs/permissions.md 的权限矩阵。老 core.app_role 的 16 个值（super_admin/ceo/
// cmo/account_executive/closer/ops…）按矩阵映射收敛，映射表同样在 docs/permissions.md。
// 加新角色 = 改这里 + db:generate（枚举是刻意选的闭集：角色变更走 migration，
// 有迹可查）；权限点是开集，见 user_permission.permission。
export const appRole = pgEnum("app_role", [
  "owner",
  "admin",
  "sales_lead",
  "sales",
  "customer_service",
  "sales_assistant",
  "ops_assistant",
  "formulator",
  "purchaser",
  "warehouse",
  "production_lead",
  "qa",
  "lab_technician",
  "finance",
  "customer",
]);

export const userRole = pgTable(
  "user_role",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => authUser.id, { onDelete: "cascade" }),
    role: appRole("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.role] }),
    index("user_role_role_idx").on(t.role),
  ],
);

// 附加权限点（跨出角色默认集的那部分，如给某个运营助理授「标签设计」，或给外部
// 设计师开无员工角色的受限账号）。permission 用 text 不用枚举：权限点随业务模块
// 持续增加（quotes.*、orders.*…），开集不该每次都动数据库；合法性由代码里的
// 注册表（apps/api/src/authz/permissions.ts）用 zod 收口，库里只存注册过的值。
export const userPermission = pgTable(
  "user_permission",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => authUser.id, { onDelete: "cascade" }),
    permission: text("permission").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.permission] }),
    index("user_permission_permission_idx").on(t.permission),
  ],
);

// ── 站内通知（#129）──────────────────────────────────────────────────────────
// 一行 = 一起业务事件对一个用户的投递（老系统 platform.notifications 的直译）。
// 老系统的写入方是 core.outbox 的 AFTER INSERT 触发器按 event_type 白名单扇出；
// 本系统还没有 outbox/事件总线，扇出生产者随各业务域迁移时落地（同 #30 realtime
// 的按域采纳策略）——届时事件携带的幂等键（老 (user_id, outbox_id) 唯一约束）
// 一并补列，expand-only。读路径只有本人；已读/全读走 API 且只允许操作自己的行。
export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUser.id, { onDelete: "cascade" }),
    // 事件类型是开集（quote.viewed、support.ticket.*…随业务域增长），text 收口：
    // 白名单的裁决在消费侧（前端展示层）做，与老系统「文案与深链在 TS 不在库」一致。
    eventType: text("event_type").notNull(),
    aggregateType: text("aggregate_type"),
    aggregateId: text("aggregate_id"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    isRead: boolean("is_read").notNull().default(false),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("notifications_user_recent_idx").on(t.userId, desc(t.createdAt)),
    // 铃铛的未读计数不 count(*)：部分索引让「有没有未读、封顶几条」只扫未读行
    index("notifications_user_unread_idx").on(t.userId).where(sql`${t.isRead} = false`),
  ],
);

// ── 反馈上报（#129）──────────────────────────────────────────────────────────
// 后台内提交问题（老系统 FEAT-198 platform.feedback_reports 的直译）。提交人是
// 服务端从会话解析的（不是请求参数，防冒名）；姓名/邮箱是提交时的快照，人后来
// 改资料不改历史单据。附件（老 ≤3 张图片、私有桶）随 @ally/storage 基建补列，
// expand-only。type/priority/status 是闭集，枚举与老 CHECK 词表逐值对齐。
export const feedbackReportType = pgEnum("feedback_report_type", [
  "bug_report",
  "feature_request",
  "process_gap",
]);

export const feedbackReportPriority = pgEnum("feedback_report_priority", [
  "low",
  "medium",
  "high",
  "critical",
]);

export const feedbackReportStatus = pgEnum("feedback_report_status", [
  "pending",
  "in_review",
  "resolved",
  "closed",
]);

export const feedbackReports = pgTable(
  "feedback_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // 对外编号 BR-xxxxxxxx（提交成功回执），与自增无关、撞号重掷
    reportNumber: text("report_number").notNull(),
    type: feedbackReportType("type").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    stepsToReproduce: text("steps_to_reproduce"),
    priority: feedbackReportPriority("priority").notNull(),
    status: feedbackReportStatus("status").notNull().default("pending"),
    submittedByUserId: uuid("submitted_by_user_id")
      .notNull()
      .references(() => authUser.id),
    submitterName: text("submitter_name").notNull(),
    submitterEmail: text("submitter_email").notNull(),
    adminNotes: text("admin_notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("feedback_reports_number_idx").on(t.reportNumber)],
);

// ── 任务（#113 切片 1：任务内核）────────────────────────────────────────────
// 老系统有三套任务表（tasks+task_projects 看板、workspace_tasks 工作区、crm_tasks
// 回拨），迁移要点要求评估合并：裁决是收敛为一套（#232 §11「一套任务系统，可挂
// 在任何记录上」）。业务对象的附着列（subject_type/subject_id，老 crm.tasks 的
// 多态形态）随第一个有附着对象的业务域切片 expand-only 进场——不在没有生产者时
// 预置空列（与 #29 切片 1「先建机制不留产线」同一裁决）。
// 状态词表与老 crm.tasks 的 CHECK 逐值对齐（open|done|cancelled，勾选式翻转）；
// ops 任务的六态（#156）进场时 ALTER TYPE ADD VALUE，向后兼容。
export const taskStatus = pgEnum("task_status", ["open", "done", "cancelled"]);

export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: text("title").notNull(),
    description: text("description"),
    status: taskStatus("status").notNull().default("open"),
    dueAt: timestamp("due_at", { withTimezone: true }),
    // 经办人/创建人都不与用户行共生灭：人被删任务还在（SET NULL）；「可分配面 =
    // 至少一个非 customer 角色」的裁决在 API 层，表不重复表达
    assigneeId: uuid("assignee_id").references(() => authUser.id, { onDelete: "set null" }),
    createdById: uuid("created_by_id").references(() => authUser.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // 「我的待办」主读法：按人 + 状态过滤；到期排序在查询侧表达（nulls last）
    index("tasks_assignee_status_idx").on(t.assigneeId, t.status),
    index("tasks_created_by_idx").on(t.createdById),
  ],
);
