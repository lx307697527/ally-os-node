import { Hono } from "hono";
import { cors } from "hono/cors";
import { requestId } from "hono/request-id";
import type { Logger } from "pino";
import type { Db } from "@ally/db";
import type { AppEnv, ResolveSession } from "./auth/session.ts";
import { sessionMiddleware } from "./auth/session.ts";
import { authzMiddleware, requireTwoFactorGate } from "./authz/middleware.ts";
import type { AuthzStore } from "./authz/service.ts";
import { activityRoutes } from "./routes/activity.ts";
import { authProvidersRoutes } from "./routes/auth-providers.ts";
import { auditEventsRoutes } from "./routes/audit-events.ts";
import { commentsRoutes } from "./routes/comments.ts";
import { esignaturesRoutes } from "./routes/esignatures.ts";
import { feedbackRoutes } from "./routes/feedback.ts";
import { followsRoutes } from "./routes/follows.ts";
import { healthRoutes } from "./routes/health.ts";
import { meRoutes } from "./routes/me.ts";
import { notificationsRoutes } from "./routes/notifications.ts";
import { realtimeRoutes } from "./routes/realtime.ts";
import { tasksRoutes } from "./routes/tasks.ts";
import { userRolesRoutes } from "./routes/user-roles.ts";
import { workflowInstancesRoutes } from "./routes/workflow-instances.ts";
import { workflowTemplatesRoutes } from "./routes/workflow-templates.ts";

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
}

export function createApp(deps: AppDeps) {
  const app = new Hono<AppEnv>();

  app.use("*", requestId());
  app.use("/api/*", cors({ origin: deps.corsOrigins, credentials: true }));

  app.onError((err, c) => {
    deps.logger.error({ err, requestId: c.get("requestId") }, "unhandled error");
    // 不把内部错误细节返回给客户端
    return c.json({ error: "internal_error", requestId: c.get("requestId") }, 500);
  });

  app.notFound((c) => c.json({ error: "not_found" }, 404));

  app.route("/", healthRoutes(deps));

  // 登录页要用的提供商列表：公开（未登录是常态），先于会话中间件注册
  app.route("/", authProvidersRoutes(deps));

  // 认证端点自己管理会话（未登录也要能登录），先于会话中间件注册
  app.on(["POST", "GET"], "/api/auth/*", (c) => deps.authHandler(c.req.raw));

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
  // 通知与反馈（#129）：本人数据、登录即可，无需权限点
  app.route("/", notificationsRoutes(deps));
  app.route("/", feedbackRoutes(deps));
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
  // 实时连接令牌（#110 切片 2）：发还调用者自己会话的令牌给 WS auth 帧用
  app.route("/", realtimeRoutes(deps));
  // 审计日志查询（#29）：audit.read 权限点门（owner/admin 默认）
  app.route("/", auditEventsRoutes(deps));

  return app;
}

export type App = ReturnType<typeof createApp>;
