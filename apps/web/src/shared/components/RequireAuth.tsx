// Route guard: unauthenticated visitors go to /login. Ported from ally-os
// apps/allyos RequireAuth.tsx (#129 slice 1).
//
// The loading branch renders the shell's silhouette (ShellLoadingFrame) instead
// of null — a null render here was the app's first white-screen beat: this gate
// runs before ANY chrome exists, and a blank page reads as a broken app.
import type { ReactElement } from "react";
import { Navigate, useLocation } from "react-router-dom";

import { useSession } from "../lib/session.ts";
import { ShellLoadingFrame } from "./ShellLoadingFrame.tsx";

export function RequireAuth({
  children,
}: {
  children: ReactElement;
}): ReactElement | null {
  const { user, loading } = useSession();
  const location = useLocation();
  if (loading) {
    return <ShellLoadingFrame data-testid="require-auth-loading" />;
  }
  // Carry the page that was asked for, so Login can resume it. Without this
  // the redirect is lossy and a deep link into any internal page silently
  // becomes the landing page — no error, nothing to say the link was understood.
  if (!user) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }
  return children;
}
