import { randomUUID } from "node:crypto";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { and, eq, gt } from "drizzle-orm";
import type { Db } from "@ally/db";
import { schema } from "@ally/db";
import type { Logger } from "pino";
import type { Mailer } from "../mailer/mailer.ts";
import { renderVerificationEmail } from "../mailer/mailer.ts";
import type { ResolveSession } from "./session.ts";

/**
 * 认证核心（#22）：Better Auth + Drizzle（PG），邮箱密码登录，HttpOnly Cookie 会话。
 *
 * 与老系统的对应：
 * - 老系统是 Supabase Auth（GoTrue）+ 前端 localStorage 会话；新系统会话在自家
 *   PG 里（auth_user / auth_session / auth_account / auth_verification），cookie
 *   HttpOnly，业务代码一律走中间件拿当前用户，不再各自解析令牌。
 * - 会话 12h 不活动超时（老系统 config.toml [auth.sessions] inactivity_timeout，
 *   FEAT-019）：expiresIn 12h，活跃访问按 updateAge 节流续期；老系统刻意不设
 *   绝对 timebox，这里同样不设。
 * - id 用 uuid 并由我们生成（advanced.database.generateId）：后续数据迁移按原
 *   auth.users 的 uuid 导入，业务表外键不用改写。
 * - 注册强制邮箱验证（FEAT-634 裁定，邮件基建切片）：未验证不能登录（403），
 *   注册响应不建会话；链接落在后台控制台 /verify-email，由用户点击确认，
 *   避免邮件扫描器预取直接消耗掉 GET 验证端点的令牌。
 */
export interface AuthDeps {
  db: Db;
  secret: string;
  /** 允许携带会话 cookie 的前端来源（CSRF 防线之一），复用 CORS_ORIGINS */
  trustedOrigins: string[];
  /** 对外基准地址；留空 = Better Auth 从请求推导（本地开发够用） */
  baseURL: string | undefined;
  /** 后台控制台的对外地址：验证邮件链接落到它身上；留空退回 Better Auth 的 API 链接 */
  webAppUrl: string | undefined;
  /** 验证邮件经它发出；发送失败只记日志，注册流程照常完成（老系统 auth-send-email 裁定） */
  mailer: Mailer;
  logger: Logger;
}

// 12h 不活动超时；updateAge 1h 限流续期写库
const SESSION_EXPIRES_IN_SECONDS = 60 * 60 * 12;
const SESSION_UPDATE_AGE_SECONDS = 60 * 60;
// 验证链接 24h 有效：老系统 otp_expiry = 86400（FEAT-056 phase 15b，为员工
// 邀请的 set-password 链接定的值，注册确认链接同款）
const VERIFICATION_EXPIRES_IN_SECONDS = 60 * 60 * 24;
const VERIFICATION_EXPIRY_LABEL = "24 hours";

export function createAuth(deps: AuthDeps) {
  return betterAuth({
    secret: deps.secret,
    trustedOrigins: deps.trustedOrigins,
    baseURL: deps.baseURL,
    emailAndPassword: {
      enabled: true,
      // FEAT-634：填注册表单不等于注册完成，邮箱确认了才算
      requireEmailVerification: true,
    },
    emailVerification: {
      expiresIn: VERIFICATION_EXPIRES_IN_SECONDS,
      sendOnSignUp: true,
      sendVerificationEmail: async ({ user, url, token }) => {
        // 链接指向控制台的确认页（由用户点击后前端再调验证端点）；webAppUrl
        // 未配置时退回 Better Auth 自己的 API 链接——能验证，但邮件扫描器
        // 预取 GET 会消耗令牌，所以生产必须配置 WEB_APP_URL。
        const base = deps.webAppUrl?.replace(/\/+$/, "") ?? "";
        const link =
          base !== ""
            ? `${base}/verify-email?token=${encodeURIComponent(token)}`
            : url;
        const content = renderVerificationEmail({
          to: user.email,
          name: user.name,
          link,
          expiry: VERIFICATION_EXPIRY_LABEL,
        });
        // 发送失败绝不阻塞注册（老系统 auth-send-email「永远 200」的同款裁定）：
        // 邮件可以重发，卡死的注册没法接受。
        try {
          await deps.mailer.send({ to: user.email, ...content });
        } catch (err) {
          deps.logger.error(
            { err, userId: user.id, to: user.email },
            "verification email send failed — sign-up continues",
          );
        }
      },
    },
    session: {
      expiresIn: SESSION_EXPIRES_IN_SECONDS,
      updateAge: SESSION_UPDATE_AGE_SECONDS,
    },
    advanced: {
      database: {
        generateId: () => randomUUID(),
      },
    },
    database: drizzleAdapter(deps.db, {
      provider: "pg",
      schema: {
        user: schema.authUser,
        session: schema.authSession,
        account: schema.authAccount,
        verification: schema.authVerification,
      },
    }),
  });
}

export type Auth = ReturnType<typeof createAuth>;

/**
 * 生产环境的会话解析：Better Auth 读请求头里的会话 cookie,查库校验。
 * 返回形状按 session.ts 的业务接口收敛,业务代码不依赖 better-auth 类型。
 */
export function createSessionResolver(auth: Auth): ResolveSession {
  return (headers) => auth.api.getSession({ headers });
}

/**
 * 会话令牌 → userId 的校验器，给 WebSocket 等不走 cookie 的通道用
 * （realtime 的 auth 帧）。令牌可以是 cookie 里的完整值（"token.signature"）
 * 或裸 token——库里只存裸 token，所以先取第一段再比对；过期即视为无效。
 */
export function createSessionTokenVerifier(
  db: Db,
): (token: string) => Promise<{ userId: string } | null> {
  return async (token) => {
    const raw = token.split(".")[0] ?? "";
    if (raw.length === 0) return null;
    const rows = await db
      .select({ userId: schema.authSession.userId })
      .from(schema.authSession)
      .where(and(eq(schema.authSession.token, raw), gt(schema.authSession.expiresAt, new Date())))
      .limit(1);
    return rows[0] ?? null;
  };
}
