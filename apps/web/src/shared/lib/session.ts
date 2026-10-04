// The session as the app reads it. better-auth's react client owns the
// transport (cookie credentials against /api/auth/*) and revalidates on focus;
// this module is the one place that maps its shape onto ours, so RequireAuth,
// the shell host and Login all read one vocabulary. #129 slice 1.
import { authClient } from "./auth-client.ts";

export interface SessionUser {
  id: string;
  name: string;
  email: string;
}

export interface SessionState {
  /** The signed-in user, or `null` while loading and when signed out. */
  user: SessionUser | null;
  /** True until the first session read has answered. */
  loading: boolean;
}

export function useSession(): SessionState {
  const { data, isPending } = authClient.useSession();
  return {
    user: data?.user ?? null,
    loading: isPending,
  };
}

/** End the session server-side, then clear the client's cached state. */
export async function signOut(): Promise<void> {
  await authClient.signOut();
}
