// The session as the app reads it. better-auth's react client owns the
// transport (cookie credentials against /api/auth/*) and revalidates on focus;
// this module is the one place that maps its shape onto ours, so RequireAuth,
// the shell host and Login all read one vocabulary. #129 slice 1.
//
// Slice 2 (#129) adds the deadline the server published and the one round
// trip that can extend it. The parse rides session-expiry.ts because
// better-auth's types claim `Date` for `expiresAt` while the wire delivers a
// string — the mapping layer is where that gap gets absorbed, once.
import { authClient } from "./auth-client.ts";
import { parseSessionExpiry } from "./session-expiry.ts";

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  /** #24：是否已启用双因素。服务端强制门（管理员未绑定 → 业务路由 403）的
   *  客户侧读数——设置页与提示条据此渲染，访问控制本身始终在服务端。 */
  twoFactorEnabled: boolean;
}

export interface SessionState {
  /** The signed-in user, or `null` while loading and when signed out. */
  user: SessionUser | null;
  /** True until the first session read has answered. */
  loading: boolean;
  /** The server's deadline as epoch ms; `null` while loading, signed out, or
   *  when the payload defied parsing — in which case the local watch stays
   *  quiet and the server keeps being the only authority. */
  expiresAtMs: number | null;
  /** Revalidate the cookie against the server. The ONLY way the session gets
   *  extended — a new deadline comes back through the store when the server
   *  agrees the session is alive, and the user disappears when it does not. */
  refreshSession: () => Promise<void>;
}

export function useSession(): SessionState {
  const { data, isPending, refetch } = authClient.useSession();
  return {
    user:
      data?.user === undefined
        ? null
        : {
            id: data.user.id,
            name: data.user.name,
            email: data.user.email,
            // 插件把字段声明为可选，线上载荷早期可能缺位——收敛成确定的布尔，
            // 不让 better-auth 的可空性渗进业务组件。
            twoFactorEnabled: data.user.twoFactorEnabled === true,
          },
    loading: isPending,
    expiresAtMs: parseSessionExpiry(data?.session),
    refreshSession: () => refetch(),
  };
}

/** End the session server-side, then clear the client's cached state. */
export async function signOut(): Promise<void> {
  await authClient.signOut();
}
