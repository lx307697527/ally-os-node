// The idle-logout watch, rebuilt on the server's deadline (#129 slice 2).
//
// The old system (ally-os apps/allyos use-session-timeout.ts) ran its OWN
// clock: an activity timestamp in localStorage, a 12h idle threshold, a 60s
// warning grace, then signOut. This watch keeps the UX of that shape — a
// non-dismissible warning with one way out, "stay signed in" — but owns NONE
// of the decision: the session row already expires server-side 12h after its
// last update (apps/api/src/auth/auth.ts), every /api/* request revalidates
// and refreshes it through the session middleware, and this hook only counts
// down to the deadline the server published. Where the local deadline is
// wrong about anything, the server decides at /api/auth/get-session — which
// is exactly what the expiry moment asks for.
//
// Deliberately NOT here:
//   · activity listeners — the client never extends the session by itself;
//     only a server round trip does (stay-logged-in, focus revalidation).
//   · client session polling — a poll IS a getSession, which refreshes the
//     row; a tab that polled forever would never idle out, and with it dies
//     the acceptance criterion 闲置超时后需要重新登录. See auth-client.ts.
//   · localStorage — the deadline lives in one place, the session row; two
//     tabs cannot disagree about it because neither of them stores it.
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import {
  SESSION_WARNING_LEAD_MS,
  clearSessionExpiredNotice,
  markSessionExpiredNotice,
  phaseFor,
  type SessionExpiryPhase,
} from "./session-expiry.ts";
import { useSession } from "./session.ts";

const WARNING_TICK_MS = 1_000;
/** How long an already-expired deadline may sit without a server verdict
 * before the watch walks the operator out itself (offline, stuck store). */
const EXPIRY_VERDICT_GRACE_MS = 4_000;

export interface UseSessionTimeoutResult {
  phase: SessionExpiryPhase;
  /** Whole seconds left on the deadline; live only while the warning shows. */
  secondsRemaining: number | null;
  /** One server round trip: a new deadline comes back, or the session ends. */
  stayLoggedIn: () => void;
}

export function useSessionTimeout(): UseSessionTimeoutResult {
  const { user, expiresAtMs, refreshSession } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const [phase, setPhase] = useState<SessionExpiryPhase>("active");
  const [secondsRemaining, setSecondsRemaining] = useState<number | null>(null);
  // The deadline whose death was already taken to the server, so the ask is
  // made once per deadline — not once per tick.
  const verdictForRef = useRef<number | null>(null);
  // refreshSession's identity changes across renders (better-auth's hook
  // rebuilds it); a ref keeps it out of the verdict effect's dependencies so
  // an unrelated re-render cannot re-run the ask mid-verdict.
  const refreshRef = useRef(refreshSession);
  useEffect(() => {
    refreshRef.current = refreshSession;
  });

  // Scheduling: sleep until the deadline enters its final minute, then tick
  // once a second. Declared BEFORE the verdict effect below on purpose: on
  // the commit where a stay-logged-in lands with a new deadline, THIS effect
  // rewinds the phase, and the verdict effect — still holding the stale
  // phase — must find the NEW deadline and re-ask, never run ahead and walk
  // anybody out.
  useEffect(() => {
    if (user === null || expiresAtMs === null) {
      setPhase("active");
      setSecondsRemaining(null);
      return;
    }
    // A live deadline disproves any stale "you were logged out" note — set
    // when a previous deadline died in this tab and the server has since
    // said alive (a stay-logged-in here, another tab's extension).
    clearSessionExpiredNotice();
    // One of the two expiry detectors: arriving already past the deadline
    // (a resumed tab, a refresh that landed late) is an expiry the tick never
    // saw, so the note goes down here as well as in the verdict effect.
    const initialPhase = phaseFor({ expiresAtMs, nowMs: Date.now() });
    if (initialPhase === "expired") markSessionExpiredNotice();
    setPhase(initialPhase);
    let interval: ReturnType<typeof setInterval> | undefined;
    const timeout = setTimeout(() => {
      setPhase("warning");
      const tick = () => {
        const remaining = expiresAtMs - Date.now();
        if (remaining <= 0) {
          // The other expiry detector (the scheduler's phaseFor above) marks
          // too: whichever fires first, the note is down before any refetch
          // can flip the store and send RequireAuth running.
          markSessionExpiredNotice();
          setPhase("expired");
          setSecondsRemaining(0);
        } else {
          setSecondsRemaining(Math.ceil(remaining / 1000));
        }
      };
      tick();
      interval = setInterval(tick, WARNING_TICK_MS);
    }, Math.max(0, expiresAtMs - SESSION_WARNING_LEAD_MS - Date.now()));
    return () => {
      clearTimeout(timeout);
      if (interval !== undefined) clearInterval(interval);
    };
  }, [user, expiresAtMs]);

  // The expiry moment: ask the server, once. A verdict of ALIVE (another tab
  // stayed logged in) brings a new deadline through the store and the
  // scheduler above rewinds; a verdict of GONE empties the session and
  // RequireAuth already owns that redirect. This navigates only when no
  // verdict arrives at all — offline, stuck store — carrying the same
  // return-to state RequireAuth would have.
  useEffect(() => {
    if (phase !== "expired" || expiresAtMs === null) return;
    if (verdictForRef.current !== expiresAtMs) {
      verdictForRef.current = expiresAtMs;
      // Marked BEFORE the verdict is asked, because whichever navigator wins
      // the race — RequireAuth on the store flipping to null, or the
      // fallback below — cannot both explain the redirect; the note can.
      markSessionExpiredNotice();
      void refreshRef.current();
      const fallback = setTimeout(() => {
        navigate("/login", { replace: true, state: { from: location, sessionExpired: true } });
      }, EXPIRY_VERDICT_GRACE_MS);
      return () => {
        clearTimeout(fallback);
      };
    }
    // Asked and still sitting on the SAME deadline: the verdict never came
    // back, or came back and changed nothing — both mean gone.
    navigate("/login", { replace: true, state: { from: location, sessionExpired: true } });
  }, [phase, expiresAtMs, navigate, location]);

  const stayLoggedIn = useCallback(() => {
    void refreshRef.current();
  }, []);

  return { phase, secondsRemaining, stayLoggedIn };
}
