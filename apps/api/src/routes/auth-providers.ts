import { Hono } from "hono";

/**
 * 本部署启用的社交登录提供商（#22 切片 4）。挂在会话中间件之前：登录页自己
 * 就要用它，未登录是常态。
 *
 * 老系统（FEAT-167）把这件事放在前端构建期环境变量里；新系统改为运行时问
 * 服务器——提供商的真相源是 API 的环境（它 owns better-auth），前端不再需要
 * 第二份部署配置。响应体就是名字数组：未启用的提供商不在列，登录页据它决定
 * 渲不渲染按钮（给没配置的提供商一个按钮 = 提供一个必然失败的动作，FEAT-167）。
 */
export function authProvidersRoutes(deps: { socialProviders: readonly string[] }) {
  return new Hono().get("/api/auth-providers", (c) => {
    return c.json({ providers: deps.socialProviders });
  });
}
