import type { Logger } from "pino";
import type { Env } from "@ally/config";
import type { RealtimeAuthenticator } from "./hub.ts";

/**
 * 校验 auth 帧令牌的函数（#22 接线）：生产实现是查 auth_session 表
 * （createSessionTokenVerifier）。返回 null 表示令牌无效或已过期。
 */
export type VerifySessionToken = (token: string) => Promise<{ userId: string } | null>;

/**
 * 实时连接的鉴权器（hub 接口不变）：
 * - 令牌是 Better Auth 会话令牌（cookie 值或裸 token 均可），走注入的校验器；
 * - 开发/测试保留 dev:<userId> 直通，本地联调不依赖登录；生产永不放行；
 * - 生产环境没接校验器 = 没有可信令牌来源，拒绝所有连接是唯一安全的默认值，
 *   服务启动时打一次 warn 提醒接线状态。
 */
export function createRealtimeAuthenticator(
  env: Env,
  logger: Logger,
  verifySessionToken?: VerifySessionToken  ,
): RealtimeAuthenticator {
  if (env.NODE_ENV === "production" && !verifySessionToken) {
    logger.warn("realtime: no session token verifier wired; connections will be rejected");
    return () => Promise.resolve(null);
  }
  return (token) => {
    if (env.NODE_ENV !== "production" && token.startsWith("dev:")) {
      const userId = token.slice("dev:".length);
      return Promise.resolve(userId.length > 0 ? { userId } : null);
    }
    if (!verifySessionToken) return Promise.resolve(null);
    return verifySessionToken(token);
  };
}
