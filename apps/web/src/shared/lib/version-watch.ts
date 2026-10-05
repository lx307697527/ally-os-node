// The runtime half of the version watch (#129 slice 3). The question it
// answers is the old system's (ally-os deployment-watch.ts): "is a newer
// build live than the one this tab loaded?" — because a tab that stayed open
// across a deployment keeps running stale code until it reloads.
//
// THE SIGNAL is `/version.json`, written by every production build (see
// src/build/version-plugin.ts) and compared against the `__ALLY_BUILD_ID__`
// compiled into this very bundle. nginx serves the file with the same
// no-cache policy as index.html, so a poll costs one small same-origin
// request and always sees the live answer.
//
// WHAT IT NEVER DOES, by the old system's ruling that still stands: reload on
// its own. A timer that reloads can land mid-form. The watch only reports
// (onNews); the one action is the operator's own click on the refresh prompt
// (NewVersionBanner), and nothing here reloads behind their back.
import { z } from "zod";

/** How often a visible tab asks. The file is under 100 bytes; the cost is noise. */
export const VERSION_CHECK_INTERVAL_MS = 5 * 60 * 1000;

/** Floor between two checks, so a flurry of tab switches is one request. */
export const VERSION_CHECK_MIN_GAP_MS = 60 * 1000;

// /version.json is an external input like any other response — nginx could
// answer with an error page and a proxy with anything; only a body naming a
// build id counts as news. Extra keys are stripped, a missing id is not news.
const versionFileSchema = z.object({ buildId: z.string().min(1) });

export type VersionFile = z.infer<typeof versionFileSchema>;

export interface VersionWatch {
  /** Ask the server once (throttled). Never throws: a failed check is "no news". */
  check(): Promise<void>;
  /** The live build id when it differs from this tab's, else null. */
  newerBuildId(): string | null;
}

export interface VersionWatchOptions {
  /** The build id this bundle was compiled with; null parks the watch in dev/tests. */
  current: string | null;
  fetchVersionJson: () => Promise<unknown>;
  now?: (() => number) | undefined;
  /** Called after each COMPLETED check with the verdict — null means no news. */
  onNews?: ((buildId: string | null) => void) | undefined;
}

export function createVersionWatch(options: VersionWatchOptions): VersionWatch {
  const now = options.now ?? Date.now;
  let live: string | null = null;
  let lastCheck = Number.NEGATIVE_INFINITY;
  let inFlight = false;

  const watch: VersionWatch = {
    async check(): Promise<void> {
      if (options.current === null || inFlight) return;
      const at = now();
      if (at - lastCheck < VERSION_CHECK_MIN_GAP_MS) return;
      lastCheck = at;
      inFlight = true;
      try {
        const parsed = versionFileSchema.safeParse(await options.fetchVersionJson());
        // A body without a build id (an SPA-fallback HTML page, a truncated
        // file) is not evidence of a new build; keep whatever was known.
        if (parsed.success) live = parsed.data.buildId;
      } catch {
        // Offline, blocked, 5xx, dev server's 404: no news.
      } finally {
        inFlight = false;
      }
      options.onNews?.(watch.newerBuildId());
    },
    newerBuildId(): string | null {
      return live !== null && live !== options.current ? live : null;
    },
  };
  return watch;
}
export function liveVersionWatch(options?: {
  onNews?: ((buildId: string | null) => void) | undefined;
}): VersionWatch {
  return createVersionWatch({
    // The define from src/build/version-plugin.ts replaces the IDENTIFIER
    // `__ALLY_BUILD_ID__` at build time, so a production bundle reads
    // `current: "9a3f2c1"`. Under vitest/node nothing defines it — typeof on
    // an undeclared identifier is legal (no ReferenceError) and answers
    // "undefined", which parks the watch on "no news" exactly like dev.
    current: typeof __ALLY_BUILD_ID__ === "string" ? __ALLY_BUILD_ID__ : null,
    fetchVersionJson: async () => {
      const res = await fetch("/version.json", { cache: "no-store", credentials: "same-origin" });
      if (!res.ok) throw new Error(`version.json answered ${res.status}`);
      const body: unknown = await res.json();
      return body;
    },
    onNews: options?.onNews,
  });
}

/**
 * The smallest window shape the schedule needs — NOT Pick<Window, ...>, so a
 * test can fake it with plain structural typing and the browser's own window
 * still satisfies it.
 */
export interface VersionWatchHost {
  setInterval(handler: () => void, timeout?: number): number;
  clearInterval(handle: number): void;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
  document: { visibilityState: "visible" | "hidden" };
}

/** Check on an interval while visible, and the moment the tab becomes visible. */
export function scheduleVersionWatch(watch: VersionWatch, host: VersionWatchHost = window): () => void {
  const tick = (): void => {
    if (host.document.visibilityState === "visible") void watch.check();
  };
  const handle = host.setInterval(tick, VERSION_CHECK_INTERVAL_MS);
  host.addEventListener("visibilitychange", tick);
  return () => {
    host.clearInterval(handle);
    host.removeEventListener("visibilitychange", tick);
  };
}
