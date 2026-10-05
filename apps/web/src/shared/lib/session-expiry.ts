// The session deadline as the frontend sees it. Slice 2 of issue #129: the
// server owns the expiry — better-auth's session row dies 12h after its last
// update (apps/api/src/auth/auth.ts), and every /api/* request revalidates it
// through the session middleware — the frontend only DERIVES a phase from the
// deadline the server published. No idle clock, no activity ledger, no local
// idea of "too long": that was the old system's useSessionTimeout mechanism
// (ally-os apps/allyos use-session-timeout.ts), retired on purpose per the
// issue's 迁移要点 — 会话超时改为服务端会话过期 + 前端提示，不能只靠前端计时.
//
// better-auth's wire format delivers `expiresAt` as an ISO string even though
// its types claim `Date` — so the parse accepts what actually arrives, not
// what the type says.

export type SessionExpiryPhase = "active" | "warning" | "expired";

/** Lead time of the "Still there?" overlay — the old system's 60s warning
 * grace (ally-os apps/allyos use-session-timeout.ts DEFAULT_WARNING_GRACE_MS). */
export const SESSION_WARNING_LEAD_MS = 60_000;

export function parseExpiryMs(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.length > 0) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

/** The deadline from the session payload object itself — the shape this app
 *  hands over is better-auth's business, so navigation happens defensively
 *  here rather than through optional chains the type system calls impossible. */
export function parseSessionExpiry(session: unknown): number | null {
  if (typeof session !== "object" || session === null || !("expiresAt" in session)) {
    return null;
  }
  return parseExpiryMs(session.expiresAt);
}

export function phaseFor(options: {
  expiresAtMs: number | null;
  nowMs: number;
  warningLeadMs?: number;
}): SessionExpiryPhase {
  const { expiresAtMs, nowMs, warningLeadMs = SESSION_WARNING_LEAD_MS } = options;
  if (expiresAtMs === null) return "active";
  const remaining = expiresAtMs - nowMs;
  if (remaining <= 0) return "expired";
  if (remaining <= warningLeadMs) return "warning";
  return "active";
}

// The "why am I on the login page" note. A one-shot sessionStorage message,
// NOT a clock: whoever walks the operator out on a dead session marks it, and
// Login consumes it once — this is how the notice survives the redirect even
// when it is RequireAuth (which cannot know WHY the user vanished) that wins
// the race to /login. It says nothing about whether the session may live;
// that stays the server's business.
export const SESSION_EXPIRED_NOTICE_KEY = "ally_session_expired_notice";

export function markSessionExpiredNotice(
  storage: Pick<Storage, "setItem"> = sessionStorage,
): void {
  storage.setItem(SESSION_EXPIRED_NOTICE_KEY, "1");
}

export function clearSessionExpiredNotice(
  storage: Pick<Storage, "removeItem"> = sessionStorage,
): void {
  storage.removeItem(SESSION_EXPIRED_NOTICE_KEY);
}

/** A pure read — the removal lives in clearSessionExpiredNotice, because
 *  reading inside a state initializer runs twice under dev StrictMode, and a
 *  side-effecting consume there would eat the note before the latch holds. */
export function peekSessionExpiredNotice(
  storage: Pick<Storage, "getItem"> = sessionStorage,
): boolean {
  return storage.getItem(SESSION_EXPIRED_NOTICE_KEY) !== null;
}
