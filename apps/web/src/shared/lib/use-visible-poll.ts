// A poll that pauses while its tab is hidden and catches up the moment the
// tab is visible again. Ported verbatim from ally-os
// apps/allyos/src/shared/lib/use-visible-poll.ts (#129 slice 4).
//
// WHY PAUSE. This timer is the app's only unconditional background request:
// one read a minute, per open tab, for as long as the tab exists. A staff tab
// parked behind a spreadsheet for an afternoon spends ~240 reads on a bell
// nobody can see. Browsers do throttle a backgrounded `setInterval`, but
// throttling decides how OFTEN our callback runs — it never decides not to
// send the request. That decision is this hook's, and `document.hidden` is
// the only thing that knows whether anyone is looking.
//
// WHY THE CATCH-UP IS NOT OPTIONAL. Pausing alone would make this surface
// WORSE than never pausing: the operator switches back to a badge frozen at
// whatever it said when they left, for up to a full interval, with nothing on
// screen saying it is stale. A count on a bell is a claim about right now,
// and a stale claim is the failure this component refuses elsewhere ("a
// failed count is not zero"). Becoming visible is itself a read trigger, for
// the same reason opening the dropdown has always been one.
//
// The timer is started FRESH on return rather than resumed, so the next tick
// is a full `intervalMs` after real data instead of a remainder carried over
// from before the tab went away. `timer !== null` IS the "we believe we are
// visible" state, which makes the handler idempotent.
//
// Still polling, still not a subscription — the old system's ruling, kept
// until the realtime bus (#30) grows a notifications publisher; pausing a
// poll is a decision about when to ask, a channel is a different mechanism.
import { useEffect, useRef } from "react";

/**
 * Call `tick` every `intervalMs` while the document is visible; stop while it
 * is hidden; on becoming visible again call `onReturn` (if any) and `tick`
 * once immediately, then restart a FULL interval.
 *
 * - `intervalMs` of `0` means NO timer at all, visibility included: the caller
 *   opted out (the tests), and `onReturn` never fires either.
 * - The mount read is NOT this hook's job: it is the initial load, not a
 *   poll, and the caller does it.
 * - `tick` and `onReturn` are read through refs, so they may change identity
 *   on every render without restarting the timer; only `intervalMs` does.
 */
export function useVisiblePoll(
  tick: () => void | Promise<void>,
  intervalMs: number,
  options: { onReturn?: () => void | Promise<void> } = {},
): void {
  const latestTick = useRef(tick);
  const latestOnReturn = useRef(options.onReturn);
  latestTick.current = tick;
  // `??=` keeps the last defined handler; the callers here never un-set one.
  latestOnReturn.current ??= options.onReturn;

  useEffect(() => {
    if (!intervalMs) return undefined;

    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      timer ??= setInterval(() => void latestTick.current(), intervalMs);
    };
    const stop = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };

    const onVisibilityChange = () => {
      if (document.hidden) {
        stop();
        return;
      }
      if (timer !== null) return;
      void latestTick.current();
      void latestOnReturn.current?.();
      start();
    };

    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [intervalMs]);
}
