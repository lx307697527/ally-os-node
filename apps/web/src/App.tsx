// The composition root: routes, and the one place that reads the session to
// feed the shell its identity. Slice 1 of issue #129 — sign-in plus the
// internal shell. The health probe the old bootstrap page read moved to the
// Dashboard, where a signed-in operator can actually see it.
import type { ReactElement } from "react";
import { BrowserRouter, Navigate, Outlet, Route, Routes, useNavigate } from "react-router-dom";

import { Dashboard } from "./pages/Dashboard.tsx";
import { Region } from "./pages/Region.tsx";
import { Login } from "./shared/pages/Login.tsx";
import { RequireAuth } from "./shared/components/RequireAuth.tsx";
import { SessionTimeoutWarning } from "./shared/components/SessionTimeoutWarning.tsx";
import { InternalShell } from "./shared/shell/InternalShell.tsx";
import { sessionIdentityFromUser } from "./shared/lib/session-identity.ts";
import { signOut, useSession } from "./shared/lib/session.ts";
import { useSessionTimeout } from "./shared/lib/use-session-timeout.ts";

function ShellHost(): ReactElement {
  const { user } = useSession();
  const navigate = useNavigate();
  // The idle-logout watch (#129 slice 2): the server's deadline, counted
  // down locally; the overlay renders OVER the shell, unmounting nothing —
  // taking the page away IS the data loss the warning exists to prevent.
  const { phase, secondsRemaining, stayLoggedIn } = useSessionTimeout();
  const identity = sessionIdentityFromUser(user);

  return (
    <>
      <InternalShell
        identity={identity ?? undefined}
        onSignOut={() => {
          void (async () => {
            await signOut();
            navigate("/login", { replace: true });
          })();
        }}
      >
        <Outlet />
      </InternalShell>
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
          {/* An address the router cannot reach is answered by the place a
              signed-in operator belongs — the same destination the index
              route picks. */}
          <Route path="*" element={<Navigate to="/overview" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
