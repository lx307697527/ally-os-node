import { randomUUID } from "node:crypto";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { and, eq, gt } from "drizzle-orm";
import type { Db } from "@ally/db";
import { schema } from "@ally/db";
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
 */
export interface AuthDeps {
  db: Db;
  secret: string;
  /** 允许携带会话 cookie 的前端来源（CSRF 防线之一），复用 CORS_ORIGINS */
  trustedOrigins: string[];
  /** 对外基准地址；留空 = Better Auth 从请求推导（本地开发够用） */
  baseURL: string | undefined;
}

// 12h 不活动超时；updateAge 1h 限流续期写库
const SESSION_EXPIRES_IN_SECONDS = 60 * 60 * 12;
const SESSION_UPDATE_AGE_SECONDS = 60 * 60;

export function createAuth(deps: AuthDeps) {
  return betterAuth({
    secret: deps.secret,
    trustedOrigins: deps.trustedOrigins,
    baseURL: deps.baseURL,
    emailAndPassword: { enabled: true },
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
