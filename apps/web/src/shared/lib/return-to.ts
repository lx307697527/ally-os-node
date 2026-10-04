// Where a sign-in (or sign-out) sends the operator back to. Ported from
// ally-os apps/allyos return-to.ts (#129 slice 1), minus the hooks this repo
// has no caller for yet.
//
// The answer is "/" for "nothing said" AND for "what was said was not an
// internal path" — a protocol-relative `//evil.example` is an open redirect
// waiting to happen, so anything that does not start with exactly one slash is
// refused, and every caller treats "/" the same as "nothing said".

export interface ReturnToState {
  from?: { pathname?: unknown } | null;
}

export function returnPathFrom(state: ReturnToState | null | undefined): string {
  const pathname = state?.from?.pathname;
  if (typeof pathname !== "string") return "/";
  if (!pathname.startsWith("/") || pathname.startsWith("//")) return "/";
  return pathname;
}
