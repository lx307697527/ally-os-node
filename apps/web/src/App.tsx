// The composition root: routes, and the one place that reads the session to
// feed the shell its identity. Slice 1 of issue #129 — sign-in plus the
// internal shell. The health probe the old bootstrap page read moved to the
// Dashboard, where a signed-in operator can actually see it.
import { useState } from "react";
import type { ReactElement } from "react";
import { BrowserRouter, Navigate, Outlet, Route, Routes, useNavigate } from "react-router-dom";

import { Dashboard } from "./pages/Dashboard.tsx";
import { Region } from "./pages/Region.tsx";
import { FeedbackDialog } from "./shared/components/FeedbackDialog.tsx";
import { NotificationBell } from "./shared/components/NotificationBell.tsx";
import { TwoFactorSettings } from "./shared/pages/TwoFactorSettings.tsx";
import { ForgotPassword } from "./shared/pages/ForgotPassword.tsx";
import { Login } from "./shared/pages/Login.tsx";
import { ResetPassword } from "./shared/pages/ResetPassword.tsx";
import { VerifyEmail } from "./shared/pages/VerifyEmail.tsx";
import { NewVersionBanner } from "./shared/components/NewVersionBanner.tsx";
import { RequireAuth } from "./shared/components/RequireAuth.tsx";
import { SessionTimeoutWarning } from "./shared/components/SessionTimeoutWarning.tsx";
import { InternalShell } from "./shared/shell/InternalShell.tsx";
import { sessionIdentityFromUser } from "./shared/lib/session-identity.ts";
import { createNotificationAdapters } from "./shared/lib/notifications-client.ts";
import { signOut, useSession } from "./shared/lib/session.ts";
import { useSessionTimeout } from "./shared/lib/use-session-timeout.ts";
import { useVersionCheck } from "./shared/lib/use-version-check.ts";

// Module scope, like the old live-notifications adapters: ONE adapters object,
// so the bell's refresh identity is stable for the poll hook.
const notificationAdapters = createNotificationAdapters();

function ShellHost(): ReactElement {
  const { user } = useSession();
  const navigate = useNavigate();
  // The idle-logout watch (#129 slice 2): the server's deadline, counted
  // down locally; the overlay renders OVER the shell, unmounting nothing —
  // taking the page away IS the data loss the warning exists to prevent.
  const { phase, secondsRemaining, stayLoggedIn } = useSessionTimeout();
  // The deployment watch (#129 slice 3): "is a newer build live than the one
  // this tab loaded?" — announced as a prompt, never acted on behind the
  // operator's back; the banner's Refresh click is the only reload.
  const newBuildId = useVersionCheck();
  // The bell + the feedback dialog (#129 slice 4): the shell gets a finished
  // bell element and a callback; the data and the dialog live HERE.
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const identity = sessionIdentityFromUser(user);

  return (
    <>
      <InternalShell
        identity={identity ?? undefined}
        bell={<NotificationBell adapters={notificationAdapters} />}
        onSubmitFeedback={() => {
          setFeedbackOpen(true);
        }}
        onSignOut={() => {
          void (async () => {
            await signOut();
            navigate("/login", { replace: true });
          })();
        }}
      >
        <Outlet />
      </InternalShell>
      {feedbackOpen ? <FeedbackDialog onClose={() => { setFeedbackOpen(false); }} /> : null}
      {newBuildId !== null ? (
        <NewVersionBanner
          onRefresh={() => {
            window.location.reload();
          }}
        />
      ) : null}
      {phase === "warning" && secondsRemaining !== null ? (
        <SessionTimeoutWarning secondsRemaining={secondsRemaining} onStayLoggedIn={stayLoggedIn} />
      ) : null}
    </>
  );
}

export function App(): ReactElement {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        {/* Where the confirmation mail's link lands (#22 email-verification
            slice) — public: the operator confirming a mailbox is by
            definition not signed in yet. */}
        <Route path="/verify-email" element={<VerifyEmail />} />
        {/* The password-reset pair (#22 password-reset slice) — public for
            the same reason: whoever asks for a reset link or spends one has
            forgotten the password that would have signed them in. */}
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route
          element={
            <RequireAuth>
              <ShellHost />
            </RequireAuth>
          }
        >
          <Route path="/" element={<Navigate to="/overview" replace />} />
          <Route path="/overview" element={<Dashboard />} />
          <Route path="/regions/:region" element={<Region />} />
          {/* 2FA 自助（#24）：强制门把未绑定的管理员引到这里的合同,绑定流程
              本身不需要新的 API 面——走的都是 /api/auth/two-factor/*。 */}
          <Route path="/settings/two-factor" element={<TwoFactorSettings />} />
          {/* An address the router cannot reach is answered by the place a
              signed-in operator belongs — the same destination the index
              route picks. */}
          <Route path="*" element={<Navigate to="/overview" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
