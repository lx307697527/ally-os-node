// Client-side global error capture (#28 slice 1) — the ported shape of the old
// errorTracker, checked as units with injected fetches and a clock, and a
// structurally-faked window (no jsdom, the house shape). The ported rulings:
//   - Reporting is fire-and-forget and BEST-EFFORT: a failed report is a log
//     the server never saw, never a crash, never a retry storm — the reporter
//     must never become the second error while reporting the first.
//   - The throttle (10/min) and the same-shape cooldown (60s) bound what a
//     crash-looping page can send; the server enforces its own anyway.
//   - Nothing here inspects or changes app state: two window listeners in,
//     one fetch out.
// The dedupe shape uses the same message-first-line + top-stack-frame recipe
// the server fingerprints with (apps/api src/errors/capture.ts); the server's
// hash is the authority, this is only the loop breaker.

const REPORT_URL = "/api/errors";
const THROTTLE_LIMIT = 10;
const THROTTLE_WINDOW_MS = 60_000;
const SAME_ERROR_COOLDOWN_MS = 60_000;

/** fetch 的最小结构切片；全局 fetch 天然满足，测试注入也不用碰 DOM 类型 */
export type ReportFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<unknown>;

/** First stack line containing "at " — mirrors the server's fingerprint input. */
function topStackFrame(stack: string | undefined): string {
  if (stack === undefined) return "";
  const frame = stack.split("\n").find((line) => line.includes("at "));
  return frame === undefined ? "" : frame.trim();
}

export interface NormalizedError {
  message: string;
  stack?: string;
}

/** Accepts anything a `throw` can produce and returns what we can report. */
export function normalizeError(input: unknown): NormalizedError {
  if (input instanceof Error) {
    const message = input.message.trim() === "" ? input.name || "unknown error" : input.message;
    return { message, ...(input.stack === undefined ? {} : { stack: input.stack }) };
  }
  if (typeof input === "string" && input.trim() !== "") {
    return { message: input };
  }
  return { message: "unknown error" };
}

/**
 * The one shape both global handlers report through. Deliberately wider than
 * the DOM's ErrorEvent/PromiseRejectionEvent: a structurally-faked host (tests,
 * no jsdom) implements it without touching DOM types, and window itself
 * satisfies it — ErrorEvent has message+error, PromiseRejectionEvent has
 * reason.
 */
export interface CapturedEvent {
  message?: string;
  error?: unknown;
  reason?: unknown;
}

export interface ErrorReporterHost {
  addEventListener(type: "error" | "unhandledrejection", listener: (event: CapturedEvent) => void): void;
  removeEventListener(type: "error" | "unhandledrejection", listener: (event: CapturedEvent) => void): void;
}

export interface ErrorReporterOptions {
  /** Same-origin POST to the ingest endpoint; default global fetch */
  fetchFn?: ReportFetch | undefined;
  /** Injectable clock (ms); default Date.now */
  now?: (() => number) | undefined;
  /** Injectable page URL; default location.href — only read at report time */
  pageUrl?: (() => string) | undefined;
}

export interface ErrorReporter {
  /** Route anything throwable here; never throws itself. */
  capture(input: unknown): void;
  /** Test seam: reports actually handed to the transport so far. */
  sentCount(): number;
}

export function createErrorReporter(options: ErrorReporterOptions = {}): ErrorReporter {
  const fetchFn: ReportFetch = options.fetchFn ?? fetch;
  const now = options.now ?? Date.now;
  const pageUrl = options.pageUrl ?? (() => window.location.href);

  const sentAt: number[] = [];
  const lastSeenByShape = new Map<string, number>();
  let sent = 0;

  function throttled(nowMs: number): boolean {
    while (sentAt.length > 0 && nowMs - (sentAt[0] ?? nowMs) >= THROTTLE_WINDOW_MS) {
      sentAt.shift();
    }
    return sentAt.length >= THROTTLE_LIMIT;
  }

  function report(normalized: NormalizedError, nowMs: number): void {
    // Loop breaker: the identical error (message + top stack frame) inside the
    // cooldown is a render/tick loop, not new information.
    const shape = `${normalized.message}\n${topStackFrame(normalized.stack)}`;
    const lastSeen = lastSeenByShape.get(shape);
    if (lastSeen !== undefined && nowMs - lastSeen < SAME_ERROR_COOLDOWN_MS) {
      return;
    }

    if (throttled(nowMs)) {
      return;
    }

    lastSeenByShape.set(shape, nowMs);
    sentAt.push(nowMs);
    sent += 1;

    const body = JSON.stringify({
      message: normalized.message.slice(0, 2000),
      ...(normalized.stack === undefined ? {} : { stack: normalized.stack.slice(0, 8000) }),
      url: pageUrl().slice(0, 500),
    });
    void fetchFn(REPORT_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }).catch(() => {
      // Unreachable server: the report is gone, the page is not. Never retry.
    });
  }

  return {
    capture(input: unknown): void {
      try {
        report(normalizeError(input), now());
      } catch {
        // The reporter is the last thing that may never throw.
      }
    },
    sentCount(): number {
      return sent;
    },
  };
}

/**
 * Wires the two global handlers and returns the uninstaller. Called once in
 * the composition root (main.tsx) — never per-page.
 */
export function installErrorReporter(
  host: ErrorReporterHost,
  options: ErrorReporterOptions = {},
): () => void {
  const reporter = createErrorReporter(options);
  const onError = (event: CapturedEvent): void => {
    reporter.capture(event.error ?? event.message ?? "unknown error");
  };
  const onRejection = (event: CapturedEvent): void => {
    reporter.capture(event.reason ?? event.error ?? "unhandled rejection");
  };
  host.addEventListener("error", onError);
  host.addEventListener("unhandledrejection", onRejection);
  return () => {
    host.removeEventListener("error", onError);
    host.removeEventListener("unhandledrejection", onRejection);
  };
}
