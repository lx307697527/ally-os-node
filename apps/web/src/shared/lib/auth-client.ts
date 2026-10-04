// Better Auth client (#129 slice 1; server side is #22's apps/api/src/auth).
// 同源部署：开发走 Vite 代理，线上由负载均衡按路径分流，所以不设 baseURL ——
// 客户端默认请求当前 origin 的 /api/auth/*。
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient();
