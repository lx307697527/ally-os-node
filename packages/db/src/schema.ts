import { desc, sql } from "drizzle-orm";
import {
  bigint,
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

// ── 评论（#110 切片 1：评论内核）────────────────────────────────────────────
// 老系统（这一代）从未建成评论/@提及——issue 正文里的 workspace_comments 属于
// 更老一代、在本仓库立项前已不可考；设计依据是 #232 §11「评论、@、关注与附件：
// 每个业务对象都有」。评论是内核机制：多态附着（subject_type/subject_id，老
// crm.tasks 的多态形态），合法的 subject 类型与「谁能看/评」由 API 侧的注册表
// 逐域裁决（第一个注册的是 task，行属 = 创建人或经办人）——列用 text 不用枚举，
// 新业务域注册不動数据库（与 notifications.event_type 同一裁法）。
// 作者与用户行共生灭（CASCADE，与 notifications.user_id 同裁）：评论是对话性
// 内容，不是记录；人删则其言论随之（审计里的 comment.* 行留下，actor 是 text）。
// edited_at（#110 切片 5）只标记「作者改过」，null = 从未编辑——不是通用
// updated_at（行只有 body 可变，编辑历史由审计行的 comment.updated 承载，
// 列只服务「(已编辑)」这一个读者）。
export const comments = pgTable(
  "comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subjectType: text("subject_type").notNull(),
    subjectId: uuid("subject_id").notNull(),
    authorId: uuid("author_id")
      .notNull()
      .references(() => authUser.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    editedAt: timestamp("edited_at", { withTimezone: true }),
  },
  // 唯一读法：「这条记录上的评论，按时间正序」；作者维度暂无读者，不建索引
  (t) => [index("comments_subject_created_idx").on(t.subjectType, t.subjectId, t.createdAt)],
);

// ── 关注（#110 切片 4：关注内核）────────────────────────────────────────────
// 老系统从未建成关注（issue 正文里没有任何对应表/函数，与评论同一处境）；设计
// 依据是 #232 §11「评论、@、关注与附件：每个业务对象都有」。关注是内核机制：
// 多态附着（subject_type/subject_id，与 comments 同一形态），合法的 subject
// 类型与「谁能关注」由 subjects/registry.ts 的同一扇可见性门裁决——看得到才
// 能关注，关注者集合永远是可见者集合的子集；可见者后来缩小（任务改派）时，
// 陈旧关注者不越过门（通知扇出按当前可见者过滤，路由内逐域同裁）。
// 关注者与用户行共生灭（CASCADE，与 comments.authorId 同裁）：关注是协作意图，
// 不是记录；人删则其关注随之（审计里的 follow.* 行留下，actor 是 text）。
// 主键即全部读法：「这个 subject 的关注者名单」和「(subject, me) 是否已关注」
// 都是前缀查询；「我关注的全部对象」暂无读者，不预置第二索引（与 comments
// 同一裁法）。没有 id 列：行的身份就是三元组本身，审计行的 subject 引用在
// detail（docs/audit.md 多态子对象约定）。
export const follows = pgTable(
  "follows",
  {
    subjectType: text("subject_type").notNull(),
    subjectId: uuid("subject_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUser.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.subjectType, t.subjectId, t.userId] })],
);

// ── 电子签名（#219：Part 11 底座）───────────────────────────────────────────
// 受监管记录（批记录、检验、偏差、放行…）共用的签名内核（#232 §12「审批与签名」、
// §13「签名时重新输入密码，记录含义，签后记录锁定；一人一号；签名用户双因素」）。
// 老系统没有对应物（greenfield）；多态附着与评论/关注同一形态，合法的 subject
// 类型由 apps/api/src/esign/registry.ts 逐域注册裁决（与 subjects/registry.ts
// 的可见性门并存：看得到才签得到，注册表随首个消费域进场，机制先行不留产线）。
//
// Part 11 的三条结构化落点：
// - 签名行不可改写：0012 migration 的触发器拒绝行级 UPDATE/DELETE（与 audit_events
//   同一裁决——签名是「发生过的事实」，更正走新记录，不走改写）；
// - 签名人外键不带 CASCADE：签名是监管记录不是社交内容，挂着签名的账号行删不掉
//   （默认 NO ACTION 即拒），与 comments.authorId 的 CASCADE 刻意相反；
// - signedAt 与 receivedAt 分列：平板离线签名联网后补同步时保留原签名时间
//   （#219 验收第 4 条），服务端只断言收到时刻，两者之差就是离线窗口。
//
// recordVersion 是被签记录在签名时刻的版本标（由注册域给出）；recordHash 是
// { subjectType, subjectId, version, record } 规范化 JSON 的 SHA-256——签名绑定
// 「签的是什么」（Part 11.70 签名与记录的联结），事后可验内容未被改写。
//
// 唯一约束即业务规则：同一人对同一记录同一含义只签一次（一人一号的写侧不变式，
// 并发路径撞约束同样拒绝）；clientToken 是签名端生成的幂等键，离线补同步的重放
// （弱网重试、多端排队上传）按它去重返回同一行。
export const esignatureMeaning = pgEnum("esignature_meaning", [
  "performed",
  "reviewed",
  "approved",
]);

export const esignSignatures = pgTable(
  "esign_signatures",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subjectType: text("subject_type").notNull(),
    subjectId: uuid("subject_id").notNull(),
    signerId: uuid("signer_id").notNull().references(() => authUser.id),
    meaning: esignatureMeaning("meaning").notNull(),
    recordVersion: text("record_version").notNull(),
    recordHash: text("record_hash").notNull(),
    signedAt: timestamp("signed_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    clientToken: text("client_token").notNull(),
  },
  (t) => [
    // 唯一读法：这条记录上的签名墙（锁定判断与展示共用前缀）；签名人是过滤维度
    // 暂无读者，不预置第二索引
    index("esign_signatures_subject_idx").on(t.subjectType, t.subjectId),
    uniqueIndex("esign_signatures_signer_meaning_idx").on(
      t.subjectType,
      t.subjectId,
      t.signerId,
      t.meaning,
    ),
    uniqueIndex("esign_signatures_client_token_idx").on(t.clientToken),
  ],
);

// ── 流程与状态机（#220 切片 1：可配置内核）──────────────────────────────────
// 老系统的阶段流转全是「SQL 迁移里 frozen 边表 + TS 硬编码镜像 + parity 测试」
// 三件套（crm.change_inquiry_status 边表、production.advance_job_phase 前置门、
// billing.invoice_transition_allowed……），改流程要发版。新设计（#232 §4.4/§4.9）
// 把流程做成配置：XState v5 的 JSON 定义存成模板，服务端只用它计算「当前状态 +
// 事件 → 下一状态」，结果写库；门槛/进入后动作按名字引用代码里的条件积木、动作
// 积木。subject 是开集 text（线索/商机/订单履约/偏差……与 subjects/registry.ts
// 同一裁法），属主域切片注册加载器，不加列不动库。
//
// 版本列 = 配置版本台账（config_revisions，#226）里该模板的最新版本号，创建时
// 记 v1；定义尚无就地改写路径（替换 = 停旧行建新行，新行自为一版事实），在飞
// 实例的 definition 快照读法不受台账影响。
export const workflowTemplates = pgTable(
  "workflow_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subjectType: text("subject_type").notNull(),
    // 流程模板键 = XState machine id 的宿主身份（如 standard_lead）；一个 subject
    // 类型下键唯一，模板替换 = 停用旧行 + 新键（定义就地改写端点随 #226 后续切片）
    templateKey: text("template_key").notNull(),
    // 按产品类型选模板（#220「按产品类型切换模板」）：null = 不分类型的兜底模板
    productType: text("product_type"),
    isDefault: boolean("is_default").notNull().default(false),
    active: boolean("active").notNull().default(true),
    definition: jsonb("definition").notNull(),
    version: integer("version").notNull().default(1),
    createdById: uuid("created_by_id").references(() => authUser.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("workflow_templates_key_idx").on(t.subjectType, t.templateKey),
    // 每个 subject 类型至多一个默认模板——「产品类型精确命中，否则落默认」的
    // 解析语义由唯一部分索引钉成结构不变式，双默认在写入侧即被拒绝
    uniqueIndex("workflow_templates_default_idx")
      .on(t.subjectType)
      .where(sql`is_default`),
    index("workflow_templates_resolution_idx").on(t.subjectType, t.active),
  ],
);

// 流程实例：一条业务记录同一时刻至多一个流程（ERPNext 工作流形态，状态是记录的
// 一个面向）。definition 是启动时刻的模板快照——模板后续改版/停用不改写在飞
// 实例的语义（与签名绑定 recordVersion 的同一裁法）；currentState 只存状态名，
// 推进时用快照重新解析，服务端无驻留机。
export const workflowInstances = pgTable(
  "workflow_instances",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subjectType: text("subject_type").notNull(),
    subjectId: uuid("subject_id").notNull(),
    templateId: uuid("template_id").references(() => workflowTemplates.id),
    templateKey: text("template_key").notNull(),
    definition: jsonb("definition").notNull(),
    currentState: text("current_state").notNull(),
    // 当前状态的进入时刻 = 超时提醒的时间基准（#220「停留超过设定时间时提醒」）；
    // stateDueAt 由推进方按快照里的 timeoutAfterHours 一次性算好，到期扫描不碰 jsonb
    stateEnteredAt: timestamp("state_entered_at", { withTimezone: true }).notNull().defaultNow(),
    stateDueAt: timestamp("state_due_at", { withTimezone: true }),
    startedById: uuid("started_by_id").references(() => authUser.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("workflow_instances_subject_idx").on(t.subjectType, t.subjectId),
    index("workflow_instances_due_idx").on(t.stateDueAt),
  ],
);

// 流转历史：状态机的「发生过的事实」流水。actor 与用户行不共生灭（不带 CASCADE，
// 与 esign 签名人同裁——历史是对真实的人的事实，删人不得连带抹史）；整表
// append-only（0013 触发器，与 audit_events/esign_signatures 同一底线）。
export const workflowTransitions = pgTable(
  "workflow_transitions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    instanceId: uuid("instance_id")
      .notNull()
      .references(() => workflowInstances.id),
    fromState: text("from_state").notNull(),
    toState: text("to_state").notNull(),
    event: text("event").notNull(),
    // 人工推进的原因（§4.7「必须写原因」的承接列；requireNote 门在引擎侧强制）
    note: text("note"),
    actorId: uuid("actor_id").notNull().references(() => authUser.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // 历史时间线唯一读法：按实例倒序翻页
    index("workflow_transitions_instance_idx").on(t.instanceId, t.createdAt),
  ],
);

// ── 审批（#221 切片 1：可配置内核）──────────────────────────────────────────
// 老系统的审批散落各域：报价超阈值走 pricing.quote_approval_threshold() +
// security 域的 approval_requests/outbox（feat349 只是把「该谁批」的通知接通），
// SFP 审批只在前端判断——规则写死、记录不全（#221 正文原话）。新设计（#232 §4.9
// v2.2）：审批流转自建（执行后续随 pg-boss 与现有后台作业同轨），审批路线的
// 触发条件（金额区间 → 谁批）随 #233 的 GoRules 决策表进场——本切片先立
// 「配置 → 多级流转 → 签名 → 审计」的内核，单据的自动进入是属主域的进程内调用。
//
// 三张表的分工与 workflow 同构：config 是配置（改它 = 改全员的工作方式，走
// approval.configure 权限点），request 是在飞实例（levels 是提交时刻的配置快照
// ——配置后续改版不改写在飞请求，与流程实例快照 template definition 同一裁法），
// action 是「发生过的事实」流水（0014 触发器 append-only，与 audit_events /
// esign_signatures / workflow_transitions 同一底线）。
//
// 驳回的语义（NocoBase 审批节点，#232 §4.9）：rejected 是请求的终态——单据回到
// 发起人（通知落库），修改后重新提交 = 新请求（历史逐请求可溯，不改写旧请求）。
// 同一单据同一审批线至多一个在飞请求：部分唯一索引钉成结构不变式，双提交在
// 写入侧即被拒。
export const approvalStatus = pgEnum("approval_status", ["pending", "approved", "rejected"]);

export const approvalDecision = pgEnum("approval_decision", ["approved", "rejected"]);

export const approvalConfigs = pgTable(
  "approval_configs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subjectType: text("subject_type").notNull(),
    // 审批线键（如 role_grant、quote_discount）：一个 subject 类型下键唯一，
    // 与 workflow_templates_key_idx 同构；定义改写/停用端点随 #226 后续切片进场
    configKey: text("config_key").notNull(),
    name: text("name").notNull(),
    // 有序级别数组（[{ name, users, roles, requireSignature, signatureMeaning }]），
    // 形状由 apps/api/src/approval/service.ts 的 zod 在保存时收口；审批人 = 指定
    // 人员 ∪ 指定角色（R-16-5 业务审批可自批，内核不做职责分离——质量放行的
    // 例外在 R-15-4，随 phase-3/4 的属主域进场）
    levels: jsonb("levels").notNull(),
    active: boolean("active").notNull().default(true),
    // 版本列 = 配置版本台账（#226）里的最新版本号，创建时记 v1；levels 的
    // 提交时刻快照读法（approval_requests）不受台账影响
    version: integer("version").notNull().default(1),
    createdById: uuid("created_by_id").references(() => authUser.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("approval_configs_key_idx").on(t.subjectType, t.configKey),
    index("approval_configs_resolution_idx").on(t.subjectType, t.active),
  ],
);

export const approvalRequests = pgTable(
  "approval_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    configId: uuid("config_id")
      .notNull()
      .references(() => approvalConfigs.id),
    // 配置键 / 级别数组都是提交时刻的快照：配置改版、停用、换 levels 不改写在飞
    // 请求的审批路线（与流程实例的 definition 快照同一裁决）
    configKey: text("config_key").notNull(),
    subjectType: text("subject_type").notNull(),
    subjectId: uuid("subject_id").notNull(),
    levels: jsonb("levels").notNull(),
    // 请求参数（属主域在进程内提交时带上，如 R-16-6 角色变更的 {action, role}）：
    // 审批人必须看得见「批的到底是什么」，终审批准后属主域的 outcome 处理器按它
    // 执行业务效果（批准即生效，与终审同一事务）。带 outcome 自动化的 subject
    // 提交时必须带 payload（service 层强制），纯记录线可以不带。
    payload: jsonb("payload"),
    // 当前级下标（0 基）。推进用乐观并发控制：UPDATE 带 current_step/status 条件，
    // 两个审批人同时裁决同级只有一个生效——不覆盖别人，也不落第二行 action
    currentStep: integer("current_step").notNull().default(0),
    status: approvalStatus("status").notNull().default("pending"),
    // 发起人 = 驳回后单据回到的人（终态通知的收件人）
    submittedById: uuid("submitted_by_id")
      .notNull()
      .references(() => authUser.id),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // 一张单据一条审批线至多一个在飞请求（驳回后重新提交 = 新请求行）
    uniqueIndex("approval_requests_pending_idx")
      .on(t.subjectType, t.subjectId, t.configKey)
      .where(sql`status = 'pending'`),
    // 「待我审批」扫描的入口索引：在飞请求是稀疏集
    index("approval_requests_todo_idx").on(t.status, t.currentStep),
  ],
);

// 审批裁决流水：谁、在哪一级、何时、同意或驳回、意见。actor 与用户行不共生灭
// （不带 CASCADE，与 esign 签名人 / workflow_transitions.actor 同裁——历史是对
// 真实的人的事实）；整表 append-only（0014 触发器）。要求签名的级别，签名经
// esign 内核落在 esign_signatures（subjectType = approval_action、subjectId =
// 本行 id）——签名与裁决行的联结走 subject 引用（docs/audit.md 多态子对象约定），
// 不在本表加第二份引用列。
export const approvalActions = pgTable(
  "approval_actions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => approvalRequests.id),
    stepIndex: integer("step_index").notNull(),
    levelName: text("level_name").notNull(),
    decision: approvalDecision("decision").notNull(),
    note: text("note"),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => authUser.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // 一级一裁决：并发路径撞唯一约束与 CAS 抢输同答 409
    uniqueIndex("approval_actions_request_step_idx").on(t.requestId, t.stepIndex),
  ],
);

// ── 自定义字段（#222 切片 1：可配置内核）────────────────────────────────────
// 老系统没有任何自定义字段机制：询价向导是 3686 行写死 HTML，同一组字段在
// 前端 HTML、intake-fields.ts、SQL 函数签名与 CHECK 约束四处手工同步（靠 parity
// 测试防漂移），加一个字段要发版；「动态」的 submission_payload jsonb 用 CHECK
// 约束把未知 key 钉死（feat288 p2「UNREPRESENTABLE」）。新设计（#232 §4.4/§4.9
// v2.2）：字段定义存元数据表（Twenty 的元数据表 + ERPNext「不改表结构加字段」的
// 裁法），内置字段由属主域用 zod 定义、自定义字段存成约束收口过的 JSON Schema
// 形状，两者合成一份 schema 供前端渲染（react-jsonschema-form）和服务端校验共用。
//
// subject_type 是开集 text（与 workflow/approval 同一裁法）：哪些对象「能挂自定义
// 字段」、其内置字段形状是什么，由属主域切片在 custom-fields/registry.ts 注册；
// 未注册类型由 schema 端点回 400，不出现「能配字段但没地方渲染」的半开机状态。
export const customFieldType = pgEnum("custom_field_type", [
  "text",
  "number",
  "boolean",
  "date",
  "select",
]);

export const customFieldDefs = pgTable(
  "custom_field_defs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subjectType: text("subject_type").notNull(),
    // 字段键 = 合成 schema 里的属性名，也是值表的外部键（lower_snake_case，
    // 校验在 API 层）；一个对象类型下键唯一，停用后键不复用（同 workflow
    // template_key 纪律）
    fieldKey: text("field_key").notNull(),
    label: text("label").notNull(),
    fieldType: customFieldType("field_type").notNull(),
    // select 类型的可选项（API 层强制非空、无重复）；其余类型必须为空
    options: jsonb("options").$type<string[]>(),
    required: boolean("required").notNull().default(false),
    // 字段级权限（#222「哪些角色可以查看、哪些可以编辑」）：角色名数组（zod
    // roleSchema 在保存时收口），空数组 = 不限制——任何能看到该记录的人可见/可改；
    // 提交侧「可写必须同时可见」（写一个看不见的字段是瞎写，fail closed）。
    // 老系统对应物只有静态列级 GRANT（按表写死），没有「角色 × 字段」配置。
    viewableBy: jsonb("viewable_by").$type<string[]>().notNull().default([]),
    editableBy: jsonb("editable_by").$type<string[]>().notNull().default([]),
    active: boolean("active").notNull().default(true),
    // 版本列 = 配置版本台账（#226）里的最新版本号；定义一经创建不改写（内容
    // 改写端点随 #226 后续切片），停用/恢复 = active 翻转，每次翻转记一个新版本
    version: integer("version").notNull().default(1),
    createdById: uuid("created_by_id").references(() => authUser.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("custom_field_defs_key_idx").on(t.subjectType, t.fieldKey),
    // 「这个对象有哪些生效字段」的解析索引（表单合成与值读取共用前缀）
    index("custom_field_defs_resolution_idx").on(t.subjectType, t.active),
  ],
);

// 自定义字段的值：多态侧表（subject_type, subject_id）+ 每字段一行，形态与
// comments/follows 相同（subject 无外键，属主记录删除时各域自清）。不往二十个
// 业务表各加一列 jsonb 的反面（Twenty 把值放元数据侧表的同一裁法）：报表 /
// 流程门槛 / 自动化规则（#222「自定义字段可在报表、流程门槛、自动化规则中使用」）
// 能按字段键统一查询，属主表零改动。upsert 语义：一记录一字段一值，写侧唯一
// 约束防并发双插。
export const customFieldValues = pgTable(
  "custom_field_values",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subjectType: text("subject_type").notNull(),
    subjectId: uuid("subject_id").notNull(),
    fieldDefId: uuid("field_def_id")
      .notNull()
      .references(() => customFieldDefs.id),
    // 形状由 service 层按字段定义的 zod 校验后入库（number/boolean/date/select
    // 不可能是别的形状；text 上限 10k）；null = 显式清值（仅可选字段）
    value: jsonb("value").$type<unknown>().notNull(),
    updatedById: uuid("updated_by_id").references(() => authUser.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // 一记录一字段一值：并发提交撞约束与 upsert 竞态同答（onConflictDoUpdate 兜住）
    uniqueIndex("custom_field_values_unique_idx").on(t.subjectType, t.subjectId, t.fieldDefId),
  ],
);

// ── 自动化规则（#224 切片 1：触发 → 条件 → 动作 内核）────────────────────────
// 取代老系统写在数据库触发器里的业务逻辑（#134 清单）与部分定时任务：规则存成
// 数据（触发、条件、动作三段 JSON，形状由 @ally/automations 的 zod 收口），由
// worker 的扫描/执行任务消费审计事件流——触发是「审计事件 action 精确命中」，
// 条件对事件语境（action/target/actor/detail）做点路径断言，动作第一批发
// create_task / notify。老触发器的逻辑分散在 887 个迁移文件里「看不见、难测试」，
// 新模型一条规则一行数据、一次执行一行日志（automation_runs）。
//
// trigger/conditions/actions 用 jsonb 不用列：动作类型是开集（email/sms/webhook/
// AI 步骤随所属域进场），新类型不改表（与 notifications.event_type 同一裁法）。
export const automationRules = pgTable("automation_rules", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  description: text("description"),
  trigger: jsonb("trigger").$type<Record<string, unknown>>().notNull(),
  conditions: jsonb("conditions").$type<unknown[]>().notNull().default([]),
  actions: jsonb("actions").$type<unknown[]>().notNull(),
  enabled: boolean("enabled").notNull().default(true),
  // 版本列 = 配置版本台账（#226）里的最新版本号：任何真实变更（改名/启停/
  // spec 替换）都经台账记一个新版本，无实效变更不记
  version: integer("version").notNull().default(1),
  // 规则删了，它建的任务还在（SET NULL，与 tasks.created_by_id 同裁）；
  // createdById 同时是 create_task 动作的创建人快照来源
  createdById: uuid("created_by_id").references(() => authUser.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// 每次执行留日志（#224 验收「触发了哪条规则、条件结果、动作结果」）。扫描器对
// 「触发命中」的 (规则 × 事件) 各插一行：条件不过 = skipped（记录条件结果，不发
// 执行任务）；条件过 = pending → 执行任务把它推到 succeeded/failed。唯一约束
// (rule_id, source_event_id) 是扫描窗口重叠（90s 窗 × 60s 周期）下的防重发闸；
// 规则删除后 run 仍在（SET NULL）且 rule_name 快照照旧可读——执行日志是不可少
// 的观测面，不随配置消失。
export const automationRunStatus = pgEnum("automation_run_status", [
  "pending",
  "skipped",
  "succeeded",
  "failed",
]);

export const automationRuns = pgTable(
  "automation_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ruleId: uuid("rule_id").references(() => automationRules.id, { onDelete: "set null" }),
    ruleName: text("rule_name").notNull(),
    sourceEventId: uuid("source_event_id").notNull(),
    status: automationRunStatus("status").notNull(),
    // 逐条件结果（@ally/automations ConditionOutcome[]），skipped 行靠它回答「为什么没触发」
    conditionResults: jsonb("condition_results").$type<unknown[]>().notNull().default([]),
    // 逐动作结果（@ally/automations ActionResult[]）：重试只补失败的同一个动作，
    // 已成功的动作靠这份记录跳过（幂等闸）
    actionResults: jsonb("action_results").$type<unknown[]>(),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("automation_runs_rule_event_idx").on(t.ruleId, t.sourceEventId),
    // 后台「最近执行」读法（最新在前翻页），与 audit_events_created_at_idx 同裁
    index("automation_runs_created_at_idx").on(desc(t.createdAt)),
    // 扫描器的滞留重发：pending 超过阈值的行按这条前缀找
    index("automation_runs_pending_idx").on(t.status, t.createdAt),
  ],
);

// ── 编号规则（#225 切片 1：报表与模板里「自建」的那半边）────────────────────
// 老系统的单据编号散在各处且形态分裂：发票是专用 sequence（FEAT-060，start 1000，
// 刻意否决年月前缀——「没有可读性收益，只添跨年重置状态」），询价引用是计数器表
// （20260825140000），采购单又是另一套——全被触发器/列默认值写死，改格式要发版；
// 两套语义还分裂过一次（BUG-054：seed 把计数当「下一个要发的号」、mint 当「上一个
// 已发的号」，首个号被永久跳过）。新设计（#232 §4.6）：编号规则是配置工作室的
// 数据——前缀、日期段、位宽、起始号皆可配；哪些对象「能有编号」由属主域在
// numbering/registry.ts 注册（开集，与 workflow/esign/custom-fields 同一裁法），
// 未注册类型配置面回 400，不出现「能配规则但没人发号」的半开机状态。
//
// 唯一性裁决：计数器是唯一性的承担者，每规则一条**单调计数，不按日期段重置**——
// 老系统 FEAT-060 的同一裁法；日期段只渲染进号串，不做「每期从 1 开始」。按年
// 重启属于业务裁决，随第一个真实消费方（报价 #229 / 发票等）与 #226 配置版本化
// 一起进场。改前缀/日期段/位宽只影响之后发出的号，序号继续单调——「改格式后
// 新单据使用新格式，编号不重复」（#225 验收第 3 条）由单调性结构性保证，不靠
// 事后查重。
//
// 与老系统 sequence 的关键差异：老 nextval 非事务（回滚烧号，gap 是「不把开单
// 做成串行化点」的代价，FEAT-060 原话）；本计数器是普通表行，随属主事务回滚——
// 回滚的单据从未存在，号归还后可复用，**已提交的单据之间编号无 gap 不重复**。
// 代价：分配在属主事务期间持有计数行锁（同规则的并发开单在分配处串行化），
// 本系统单据量级下可忽略；真要非事务序列由属主域自建 PG sequence，不进本内核。
export const numberingDateFormat = pgEnum("numbering_date_format", [
  "YYYY",
  "YYYYMM",
  "YYYYMMDD",
]);

export const numberingRules = pgTable(
  "numbering_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // 编号对象（开集 text）：invoice / quote / po / receipt…，须先在
    // numbering/registry.ts 注册
    subject: text("subject").notNull(),
    label: text("label").notNull(),
    // 号串 = prefix + 日期段（有则后跟 "-"）+ 零填充序号；连字符由前缀自带
    // （老系统形态 INV-3092 / QR-0001，mockup 的 INV-202608-0001 同构）
    prefix: text("prefix").notNull().default(""),
    dateFormat: numberingDateFormat("date_format"),
    // 序号位宽下限；序号超宽自然加长（padStart 不截断），0 = 不补零
    padding: integer("padding").notNull().default(4),
    // 起始号只对「从未发过号」的规则生效；已在发的系列不可改起始号（改了也会被
    // 既有计数行盖过——语义误导，配置面直接拒绝），重开系列 = 停用旧规则另建
    startNumber: bigint("start_number", { mode: "number" }).notNull().default(1),
    active: boolean("active").notNull().default(true),
    // 版本列 = 配置版本台账（#226）里的最新版本号。编号规则与字段定义不同：
    // 格式字段（前缀/日期段/位宽）允许就地改——改格式 = 改之后发出的号，这正是
    // #225 验收第 3 条的题意；每次就地改经台账记一个新版本，不改建前行的号
    version: integer("version").notNull().default(1),
    createdById: uuid("created_by_id").references(() => authUser.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // 一对象一套在发生效规则（部分唯一索引：停用的历史规则留档，同对象可另建
    // 新系列——重开编号 = 停旧建新，起始号随之重置）
    uniqueIndex("numbering_rules_active_subject_idx")
      .on(t.subject)
      .where(sql`${t.active}`),
  ],
);

// 发号计数：每规则一行，last_issued = 本规则已发出的最大序号。语义一个列只有
// 一种读法——「已发的最大号」（BUG-054 的教训），首号 = startNumber 由
// INSERT 分支给出并有专项测试。行锁（ON CONFLICT DO UPDATE）把并发分配串行化。
export const numberingSequences = pgTable(
  "numbering_sequences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ruleId: uuid("rule_id")
      .notNull()
      .references(() => numberingRules.id),
    lastIssued: bigint("last_issued", { mode: "number" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("numbering_sequences_rule_idx").on(t.ruleId)],
);

// ── 配置版本台账（#226 切片 1：版本、审计与回滚的统一内核）─────────────────────
// 配置工作室的五族配置（流程模板 / 审批线 / 自定义字段 / 自动化规则 / 编号规则）
// 的 JSON 内容统一记进同一本台账：每次真实变更一行（谁、何时、改了什么、当时
// 的全量快照），#232 §4.9「状态机、决策表、表单 schema 都是 JSON,统一纳入同一
// 套版本、审计、回滚」。台账只回答「配置曾经是什么样」；「该不该改」仍由各族
// 配置面的权限点裁决,「改了之后发布到哪」(draft → 生产 + 受监管变更控制)是
// #226 后续切片。
//
// 各配置行的 version 列自此 = 台账里的最新版本号(写入侧同事务同步),不再是
// 恒 1 的预埋;workflow_instances / approval_requests 拿定义/级别快照的读法不变。
export const configRevisionSource = pgEnum("config_revision_source", [
  // 该版本对象的第一次入账(创建,或 0019 迁移对存量行的一次性补账)
  "created",
  // 内容变更(配置面 PATCH / 就地改写)
  "updated",
  // 经回滚端点恢复到历史版本——回滚本身也是一个新版本,不改写历史
  "rolled_back",
  // 经发布端点把草稿内容应用为生效版本(#226 切片 2:先试后发,发布即入账)
  "published",
]);

export const configRevisions = pgTable(
  "config_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // 配置族(subject_type 开集 text):在 apps/api/src/config-versions/registry.ts
    // 注册才能读史/回滚;与 custom_field_values 的 subject 同一裁法——多态、无
    // 外键,配置行删除后台账行仍在(历史是对「存在过的配置」的事实,不随配置
    // 消失;automations DELETE 后规则史可查,同一裁决)
    subjectType: text("subject_type").notNull(),
    subjectId: uuid("subject_id").notNull(),
    // (subject_type, subject_id) 内从 1 单调递增;唯一索引把并发记版撞成 23505
    // (fail loud),各族配置行的 version 列与之同事务同步
    version: integer("version").notNull(),
    // 该版本时刻配置内容的全量快照(只含用户可编辑字段,不含 id/时间戳/审计
    // 元数据;形状由各族在 config-versions/families.ts 声明并在写入侧收口)。
    // 回滚 = 把某个历史快照应用回配置行,快照是回滚的唯一事实来源。
    snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
    // 逐字段变更摘要:null = created(没有「从哪来」)。updated/rolled_back 是
    // { 字段: { from, to } } 的顶层摘要(与审计 detail 的 from/to 同形),嵌套
    // 内容的路径级差异由读面 diff 端点从两份快照现算,不入库
    changes: jsonb("changes").$type<Record<string, { from: unknown; to: unknown }>>(),
    source: configRevisionSource("source").notNull(),
    changedById: uuid("changed_by_id").references(() => authUser.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // 版本号在 (subject_type, subject_id) 内唯一:并发记版撞约束当场炸(fail
    // loud),静默重号比失败严重——版本号是回滚的寻址方式
    uniqueIndex("config_revisions_version_idx").on(t.subjectType, t.subjectId, t.version),
    index("config_revisions_subject_idx").on(t.subjectType, t.subjectId),
  ],
);

// ── 配置草稿(#226 切片 2:先在测试环境试,再一键发布到生产)─────────────────────
// 「测试环境」在本系统里是配置对象上的草稿层,不是另一套部署:草稿存在独立的
// overlay 表里,活配置的读路径(流程实例解析、审批线快照、表单合成、worker 扫描、
// 发号)在发布前看不见它——「试」不碰生产行为是结构性保证,不靠读侧自觉过滤。
// 发布 = 把草稿内容经该族的 applyRevision 接缝(与回滚同一条「快照落列」契约)
// 前滚成一个 source='published' 的新版本并入账留审计;一对象至多一份草稿,再存
// 即整份替换(草稿不是版本史, versions 只属于台账)。
export const configDrafts = pgTable(
  "config_drafts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // 配置族 + 对象 id,与 config_revisions 的 subject 同一多态裁法(开集 text、
    // 无外键);只有带内容改写路径的族(注册了 draftContentSchema/applyRevision)
    // 才能有草稿,workflow/approval 的草稿面随其定义改写端点进场
    subjectType: text("subject_type").notNull(),
    subjectId: uuid("subject_id").notNull(),
    // 草稿内容:形状 = 该族快照契约的同一形状(用户可编辑内容,不含 id/键/
    // 时间戳/审计元数据),保存时经族 schema 收口
    content: jsonb("content").$type<Record<string, unknown>>().notNull(),
    // 保存草稿时刻台账里的最新版本号:发布时行版与其不符 = 草稿过期(草稿是在
    // 旧现状上写的,发布会把期间的线上变更悄悄盖掉),409 拒绝,重存后再发
    baseVersion: integer("base_version").notNull(),
    // 草稿意图说明(可选):「这份草稿想改什么、为什么」。发布时随审计留档
    note: text("note"),
    createdById: uuid("created_by_id").references(() => authUser.id, { onDelete: "set null" }),
    updatedById: uuid("updated_by_id").references(() => authUser.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // 一对象至多一份草稿:草稿是「待发布的下一版」,不是多方案比选板
    uniqueIndex("config_drafts_subject_idx").on(t.subjectType, t.subjectId),
  ],
);
