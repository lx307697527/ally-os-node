import type { Logger } from "pino";
import type { Env } from "@ally/config";
import type { RealtimeAuthenticator } from "./hub.ts";

/**
 * 实时连接的鉴权器。完整认证体系在 #22 落地，落地后这里换成
 * 校验会话令牌的实现（hub 接口不变）。
 *
 * 生产环境在 #22 之前没有可信的令牌来源：拒绝所有连接是唯一安全的默认值，
 * 服务启动时打一次 warn 提醒接线状态。
 */
export function createRealtimeAuthenticator(env: Env, logger: Logger): RealtimeAuthenticator {
  if (env.NODE_ENV === "production") {
    logger.warn("realtime: no authenticator wired yet (waiting on #22); connections will be rejected");
    return () => Promise.resolve(null);
  }
  // 开发/测试：接受 dev:<userId> 令牌，本地联调不依赖认证体系
  return (token) => {
    if (!token.startsWith("dev:")) return Promise.resolve(null);
    const userId = token.slice("dev:".length);
    if (userId.length === 0) return Promise.resolve(null);
    return Promise.resolve({ userId });
  };
}
