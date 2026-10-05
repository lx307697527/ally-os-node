// Better Auth client (#129 slice 1; server side is #22's apps/api/src/auth).
// 同源部署：开发走 Vite 代理，线上由负载均衡按路径分流，所以不设 baseURL ——
// 客户端默认请求当前 origin 的 /api/auth/*。
//
// SESSION POLLING STAYS OFF (#129 slice 2): better-auth accepts
// `sessionOptions.refetchInterval`, but a poll IS a get-session, and the
// server refreshes the session row on every one — a tab that polled forever
// would never idle out, and with it dies #129's 闲置超时后需要重新登录.
// Window-focus revalidation (on by default) is the one automatic refresher:
// coming back to the tab counts as showing up, so the server re-checks the
// cookie — and kills the session — at that moment.
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient();
