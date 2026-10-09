import { Hono } from "hono";
import { cors } from "hono/cors";
import { requestId } from "hono/request-id";
import type { Logger } from "pino";
import type { Db } from "@ally/db";
import type { Storage } from "@ally/storage";
import type { AppEnv, ResolveSession } from "./auth/session.ts";
import { sessionMiddleware } from "./auth/session.ts";
import { authzMiddleware, requireTwoFactorGate } from "./authz/middleware.ts";
import type { AuthzStore } from "./authz/service.ts";
import { captureServerError } from "./errors/capture.ts";
import "./approval/registry.ts";
// R-16-6 消费方接线（#221 切片 2）：user_role 的可见性门 + 批准即生效 outcome
import "./authz/role-approval.ts";
// 发票域注册（#192 切片 1）：invoice 注册进编号注册表（第一个生产注册）
import "./billing/registry.ts";
import { activityRoutes } from "./routes/activity.ts";
import { approvalsRoutes } from "./routes/approvals.ts";
import { authProvidersRoutes } from "./routes/auth-providers.ts";
import { auditEventsRoutes } from "./routes/audit-events.ts";
import { automationsRoutes } from "./routes/automations.ts";
import { commentsRoutes } from "./routes/comments.ts";
import { creditNotesRoutes } from "./routes/credit-notes.ts";
import { configDraftsRoutes } from "./routes/config-drafts.ts";
import { configVersionsRoutes } from "./routes/config-versions.ts";
import { customFieldsRoutes } from "./routes/custom-fields.ts";
import { deletedRecordsRoutes } from "./routes/deleted-records.ts";
import { esignaturesRoutes } from "./routes/esignatures.ts";
import { errorEventsRoutes } from "./routes/error-events.ts";
import { errorIngestRoutes } from "./routes/errors.ts";
import { feedbackRoutes } from "./routes/feedback.ts";
import { filesRoutes } from "./routes/files.ts";
import { followsRoutes } from "./routes/follows.ts";
import { healthRoutes } from "./routes/health.ts";
import { pdfTemplateConfigRoutes } from "./routes/pdf-template-config.ts";
import { invoicesRoutes } from "./routes/invoices.ts";
import { invoicePlansRoutes } from "./routes/invoice-plans.ts";
import { meRoutes } from "./routes/me.ts";
import { notificationsRoutes } from "./routes/notifications.ts";
import { numberingRulesRoutes } from "./routes/numbering-rules.ts";
import { paymentsRoutes } from "./routes/payments.ts";
import { rateLimitDenialsRoutes } from "./routes/rate-limit-denials.ts";
import { stripeCheckoutRoutes } from "./routes/stripe-checkout.ts";
import { stripeWebhookRoutes } from "./routes/stripe-webhook.ts";
import type { StripeChannel } from "./billing/stripe.ts";
import { paypalCheckoutRoutes } from "./routes/paypal-checkout.ts";
import { paypalWebhookRoutes } from "./routes/paypal-webhook.ts";
import type { PayPalChannel } from "./billing/paypal.ts";
import { realtimeRoutes } from "./routes/realtime.ts";
import { rulesRoutes } from "./routes/rules.ts";
import { tasksRoutes } from "./routes/tasks.ts";
import { templatesRoutes } from "./routes/templates.ts";
import { userRolesRoutes } from "./routes/user-roles.ts";
import { usersRoutes } from "./routes/users.ts";
import { workflowInstancesRoutes } from "./routes/workflow-instances.ts";
import { workflowTemplatesRoutes } from "./routes/workflow-templates.ts";
// 配置版本台账（#226）：五族配置的快照契约与回滚实现在 families.ts 模块装载时注册——
// 台账读面与回滚端点（routes/config-versions.ts）依赖这批注册先于任何请求发生
import "./config-versions/families.ts";
// 删除记录（#29 切片 2）：task 注册为第一个可恢复 subject——恢复端点
// （routes/deleted-records.ts）依赖这批注册先于任何请求发生
import "./records/task-restorer.ts";
// 认证面限流（#27 切片 1）：公开写面的 PG 固定窗口计数
import { authRateLimitMiddleware } from "./security/rate-limit.ts";

// 依赖通过参数注入，测试时可以传假的实现，不需要真数据库。
export interface AppDeps {
  logger: Logger;
  corsOrigins: string[];
  /** 主数据库连接：角色管理端点查用户存在性、写审计（#23） */
  db: Db;
  checkDatabase: () => Promise<void>;
  /** Better Auth 的入口：处理 /api/auth/*（登录、注册、登出…），返回完整 Response */
  authHandler: (request: Request) => Promise<Response>;
  /** 会话解析：生产是 auth.api.getSession，测试注入假实现 */
  resolveSession: ResolveSession;
  /** 本部署启用的社交登录提供商（#22）：登录页据此渲染按钮；空 = 全密码登录 */
  socialProviders: readonly string[];
  /** 角色与授权数据的读写口（#23）：生产查 user_role/user_permission，测试注入假实现 */
  authzStore: AuthzStore;
  /**
   * 通知实时「催」信号（#110 切片 2）：事务提交后对拿到新通知的用户各发一次
   * notifications.changed。实现方（index.ts 走 realtime 总线）**不得 reject**
   * —— 推送是 at-most-once 的加速器，失败只降级回 60s 轮询，不能让业务请求
   * 失败。测试注入收集调用的假实现。
   */
  notifyUsers: (userIds: string[]) => Promise<void>;
  /**
   * 对象存储（#110 附件切片）：评论附件的字节面。生产是 S3 协议客户端
   * （@ally/storage，桶与凭证走 env），测试注入内存假实现；业务代码只见
   * Storage 接口，不见 SDK。
   */
  storage: Storage;
  /**
   * Stripe 收款渠道（#193）：checkout session 网关 + webhook 验签密钥。未配置 =
   * undefined（渠道不启用）：checkout 端点与 webhook 都答 500 misconfigured
   * （fail closed——配置缺失是部署问题，不是认证失败）。webhook 端点挂在会话
   * 中间件之前：Stripe 没有本系统会话，验签就是它的认证。
   */
  stripe: StripeChannel | undefined;
  /**
   * PayPal 收款渠道（#193）：checkout 订单网关 + webhook 活体验签器。未配置 =
   * undefined（渠道不启用）：checkout 端点与 webhook 都答 500 misconfigured。
   * webhook 端点同 Stripe 挂在会话中间件之前：PayPal 没有本系统会话，
   * verify-webhook-signature 就是它的认证。
   */
  paypal: PayPalChannel | undefined;
  /**
   * 给指定邮箱发「设密码激活」邮件（#26）：生产走 better-auth 的
   * requestPasswordReset（重用 sendResetPassword 回调，按凭据存在性分流邀请/
   * 重置措辞）。实现方**不得 reject**——发送失败只降级日志（与认证邮件回调
   * 同裁定），建号不因邮件失败回滚。测试注入记录器。
   */
  sendPasswordSetupEmail: (email: string) => Promise<void>;
}

export function createApp(deps: AppDeps) {
  const app = new Hono<AppEnv>();

  app.use("*", requestId());
  app.use("/api/*", cors({ origin: deps.corsOrigins, credentials: true }));

  app.onError(async (err, c) => {
    deps.logger.error({ err, requestId: c.get("requestId") }, "unhandled error");
    // 前后端错误进同一张表（#28 切片 1）：api 侧的 unhandled 500 在这里被
    // 捕获（capture 内部 catch，遥测失败不再扰动 500 的响应路径）
    await captureServerError(deps.db, deps.logger, err, {
      requestId: c.get("requestId"),
      url: new URL(c.req.url).pathname,
      now: new Date(),
    });
    // 不把内部错误细节返回给客户端
    return c.json({ error: "internal_error", requestId: c.get("requestId") }, 500);
  });

  app.notFound((c) => c.json({ error: "not_found" }, 404));

  app.route("/", healthRoutes(deps));

  // 登录页要用的提供商列表：公开（未登录是常态），先于会话中间件注册
  app.route("/", authProvidersRoutes(deps));

// 认证面限流（#27 切片 1）：公开写面的固定窗口计数在 Better Auth 之前——
// 429 短路凭据填充与邮件轰炸；计数走 PG 表，多个 API 实例共享同一把钥匙
// （进程内 Map 是老系统明确不继承的形态）。规则册见 security/rate-limit.ts
app.use("/api/auth/*", authRateLimitMiddleware(deps));

// 前端错误上报（#28 切片 1）：公开接收面挂会话中间件之前——报错最常见的
// 时刻恰恰是会话不在/刚断的时刻，登录门会把最重要的样本挡在门外。自带
// errors.ingest 限流（PG 内核的第一个非认证消费域）
app.route("/", errorIngestRoutes(deps));

  // 认证端点自己管理会话（未登录也要能登录），先于会话中间件注册
  app.on(["POST", "GET"], "/api/auth/*", (c) => deps.authHandler(c.req.raw));

  // Stripe webhook（#193）：provider 面，同样先于会话中间件——Stripe 没有本系统
  // 会话，Stripe-Signature 验签就是这一面的认证（渠道未配置时端点答 500
  // misconfigured，见 routes/stripe-webhook.ts 的响应契约）
  app.route("/", stripeWebhookRoutes(deps));
  // PayPal webhook（#193）：provider 面，同 Stripe 挂在会话中间件之前——PayPal
  // 没有本系统会话，verify-webhook-signature 活体验签就是这一面的认证（渠道未
  // 配置时端点答 500 misconfigured）
  app.route("/", paypalWebhookRoutes(deps));

  // 其余 /api/* 一律要求已登录会话（#22 验收：业务代码统一经中间件拿当前用户），
  // 随后加载角色与生效权限集（#23），业务路由上的 requireRole/requirePermission 直接读
  app.use("/api/*", sessionMiddleware(deps.resolveSession));
  app.use("/api/*", authzMiddleware(deps.authzStore));

  // /api/me 在强制门之前（#24）：返回的正是调用者自己的角色与 twoFactorEnabled，
  // 未绑定 2FA 的管理员靠它得知自己被强制、该去绑定——把它拦在门外，前端就
  // 失去了得知状态的通道。自己的数据对自己的会话可见，不构成越权面。
  app.route("/", meRoutes());
  // 双因素强制门（#24）：持有强制角色而未启用 2FA 的用户，业务路由一律 403
  // two_factor_required；2FA 管理端点都在 /api/auth/*（上文已分流），绑定流程
  // 不被自己拦住。此后注册的业务路由默认都在门后——新模块忘了接门也不开口子。
  app.use("/api/*", requireTwoFactorGate());
  app.route("/", userRolesRoutes(deps));
  // 用户生命周期（#26）：花名册、创建邀请、改名、停用/启用（users.manage
  // 权限点，owner/admin 默认）。角色本身的授予/撤销在 user-roles 端点
  // （roles.assign + R-16-6 门）——建号面与授权面各开各的门，见 routes/users.ts
  app.route("/", usersRoutes(deps));
  // 通知与反馈（#129）：本人数据、登录即可，无需权限点
  app.route("/", notificationsRoutes(deps));
  app.route("/", feedbackRoutes(deps));
  // 文件内核（#31 切片 1）：预签名直传 + 权限签发下载，字节不经 API。可挂文件
  // 的 subject 由属主域在 files/registry.ts 注册（feedback_report 是第一个），
  // 准入参数（类型/大小/数量/下载 TTL）与「谁能传/谁看得到」逐域裁决
  app.route("/", filesRoutes(deps));
  // 任务（#113 切片 1）：创建人/经办人本人数据，登录即可；notifyUsers =
  // 分配通知落库后的实时「催」（#110 切片 2）
  app.route("/", tasksRoutes(deps));
  // 评论（#110 切片 1）：多态 subject 的行属门在路由内逐域裁决，登录即可
  app.route("/", commentsRoutes(deps));
  // 活动流（#110 切片 3）：audit_events 的按对象读投影，subject 可见者门
  // （subjects/registry.ts，与评论同一扇），登录即可
  app.route("/", activityRoutes(deps));
  // 关注（#110 切片 4）：多态 subject 的行属门在路由内逐域裁决，登录即可
  app.route("/", followsRoutes(deps));
  // 电子签名（#219）：签名仪式（重输密码 + 2FA）、签名墙读法；可签名 subject
  // 由属主域在 esign/registry.ts 注册，本切片注册表为空（机制先行）
  app.route("/", esignaturesRoutes(deps));
  // 流程与状态机（#220）：模板管理（workflow.configure 权限点）+ 实例读/推
  // （可见性门）；可挂流程的 subject 由属主域在 workflow/registry.ts 注册，
  // 实例启动是属主域的进程内调用，不开 HTTP 面
  app.route("/", workflowTemplatesRoutes(deps));
  app.route("/", workflowInstancesRoutes(deps));
  // 审批（#221）：审批线管理（approval.configure 权限点）+ 请求提交/详情/待办/
  // 裁决（单据可见性门 + 配置点名）。approval/registry.ts 在模块装载时接线三个
  // 消费方向：工作流门槛积木 approval.passed、esign 的第一个可签名 subject、
  // approval_action 的可见性门——上面 import 的副作用，顺序在本文件不敏感
  app.route("/", approvalsRoutes(deps));
  // 自定义字段（#222）：字段配置（custom_fields.configure 权限点）+ 表单引擎的
  // schema 合成与字段值读写（subject 可见性门 + 字段级 viewableBy/editableBy）。
  // 表单 subject 注册表（custom-fields/registry.ts）本切片为空——询价向导和
  // 清场检查表两个消费域进场时注册各自的内置字段
  app.route("/", customFieldsRoutes(deps));
  // 自动化规则（#224 切片 1）：规则配置 + 执行日志读面（automations.configure
  // 权限点）。规则的执行不在 API：worker 扫描器消费审计事件流（触发命中 →
  // 条件 → 落 run 行），动作经 pg-boss 执行、重试与告警——保存即生效，无发布开关
  app.route("/", automationsRoutes(deps));
  // 编号规则（#225）：配置工作室的编号配置面（numbering.configure 权限点）。
  // 可编号 subject 注册表（numbering/registry.ts）本切片为空——发票/报价/PO 等
  // 单据域（phase-2+）进场时注册；发号是属主域事务里的进程内调用，无 HTTP 面
  app.route("/", numberingRulesRoutes(deps));
  // 内容模板（#225 切片 2）：配置工作室的模板配置面（templates.configure 权限点）。
  // 消费方（认证邮件的模板解析）是进程内调用，无 HTTP 面——发号无端点的同一裁法
  app.route("/", templatesRoutes(deps));
  // 实时连接令牌（#110 切片 2）：发还调用者自己会话的令牌给 WS auth 帧用
  app.route("/", realtimeRoutes(deps));
  // 审计日志查询（#29）：audit.read 权限点门（owner/admin 默认）
  app.route("/", auditEventsRoutes(deps));
  // 错误事件读面（#28 切片 1）：前后端错误「同一个地方查看」的读半边，
  // audit.read 同门；写半边一在公开上报端点（本文件上方，会话门之前）、
  // 一在 onError 捕获
  app.route("/", errorEventsRoutes(deps));
  // 限流拒绝台账读面（#27 切片 2）：被拦请求的管理可见面——验收第 3 条的
  // API 半边，audit.read 同门。台账是遥测不是闸门：429 的权威在计数器，
  // 这里只回答「谁在撞、撞什么、撞多狠」
  app.route("/", rateLimitDenialsRoutes(deps));
  // 删除记录（#29 切片 2）：软删台账的查看与恢复，audit.read 同门。task 的
  // 恢复器在 records/task-restorer.ts 模块装载时注册（上面 import 的副作用）
  app.route("/", deletedRecordsRoutes(deps));
  // 配置版本台账（#226 切片 1）：五族配置的版本史/差异/回滚读面，回滚 = 写操作。
  // 权限按族动态裁决（= 各族配置面的同一权限点）；受监管变更控制门是 #226
  // 后续切片（随 #206 进场）
  app.route("/", configVersionsRoutes(deps));
  // 配置草稿与一键发布（#226 切片 2）：先在测试环境试（草稿 overlay，发布前
  // 活配置读路径看不见），一键发布 = 前滚 published 新版本 + 审计。同一扇族门
  app.route("/", configDraftsRoutes(deps));
  // 规则注册表（#233 切片 1）：裁决即配置的内核——读面登录即可（全公司共用的
  // 业务参数），改值按每条规则的「谁能改」逐规则裁决（路由内，owner 恒可）；
  // 第六配置族 registry_rule 在 config-versions/families.ts 注册，史/回滚走
  // 台账。定时生效的到点前滚是内核函数（rules/service.ts），cron 接线随 worker
  // 消费域进场
  app.route("/", rulesRoutes(deps));
  // 发票（#192 切片 1）：草稿状态机 + 财务确认的内核面（invoices.manage 权限
  // 点，finance/owner 默认持有）。触发点的系统生成不走 HTTP——属主域在自己的
  // 业务事务里调 billing/service.ts，草稿与触发事实同事务生灭
  app.route("/", invoicesRoutes(deps));
  // 收款台账（#192 切片 2）：发票锚定的记账面 + 更正动词（invoices.manage 同
  // 门）。#193 的 webhook 不走这扇财务门——它有自己的 provider 端点（本文件
  // 上方，验签即认证），在自己的业务事务里调 billing/payments.ts 的
  // recordPayment，source 幂等键兜重放
  app.route("/", paymentsRoutes(deps));
  // 贷项单（#192 红冲切片）：issued 票的更正动词——不改写已发行行，冲抵是
  // 一张新单据（invoices.manage 同门；服务接缝 billing/credits.ts 供 #239
  // 触发域进场复用）
  app.route("/", creditNotesRoutes(deps));
  // 分期拆票（#192 分期切片）：一个约定总额一次切成 n 期草稿票（invoices.manage
  // 同门；成员票走发票既有动词，零新动词语义；服务接缝 billing/installments.ts
  // 供订单域 #231 按比例拆期进场复用）
  app.route("/", invoicePlansRoutes(deps));
  // PDF 模板配置（#128）：品牌 + 公司信息 + 收款指示的展示事实（invoices.manage
  // 同门——银行信息是财务的脸面）。渲染权威在 @ally/pdf；发票确认时刻存档，
  // 已发出的票不受这里之后的影响
  app.route("/", pdfTemplateConfigRoutes(deps));
  // Stripe 渠道（#193）：财务建支付链接的过渡面（invoices.manage 同门；客户门户
  // #186 进场后复用同一 StripeGateway 接归属校验）
  app.route("/", stripeCheckoutRoutes(deps));
  // PayPal 渠道（#193）：财务建审批订单的过渡面（同门同构；批准后的 capture 由
  // APPROVED webhook 驱动，回跳页永远不做钱的行为）
  app.route("/", paypalCheckoutRoutes(deps));

  return app;
}

export type App = ReturnType<typeof createApp>;
