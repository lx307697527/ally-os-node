// The client-side reporter (#28 slice 1), checked as units: injected clock and
// fetch, a structurally-faked window — no jsdom, the house shape. What this
// guards: reporting is best-effort (a failing transport never surfaces), the
// throttle and same-shape cooldown bound what a crash-looping page can send,
// and the production wiring in main.tsx installs exactly once before render.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  createErrorReporter,
  installErrorReporter,
  normalizeError,
  type CapturedEvent,
  type ErrorReporterHost,
  type ReportFetch,
} from "./error-reporter.ts";

const SRC = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

function fakeFetch(shouldFail = false): { fetch: ReportFetch; bodies: string[] } {
  const bodies: string[] = [];
  const fetch: ReportFetch = (_url, init) => {
    if (shouldFail) return Promise.reject(new Error("network gone"));
    bodies.push(init.body);
    return Promise.resolve({ ok: true, status: 202 });
  };
  return { fetch, bodies };
}

function fakeHost(): {
  host: ErrorReporterHost;
  fireError: (event: CapturedEvent) => void;
  fireRejection: (event: CapturedEvent) => void;
} {
  const errorListeners: ((event: CapturedEvent) => void)[] = [];
  const rejectionListeners: ((event: CapturedEvent) => void)[] = [];
  return {
    host: {
      addEventListener(type, listener) {
        if (type === "error") {
          errorListeners.push(listener);
        } else {
          rejectionListeners.push(listener);
        }
      },
      removeEventListener(type, listener) {
        if (type === "error") {
          const index = errorListeners.indexOf(listener);
          if (index >= 0) errorListeners.splice(index, 1);
        } else {
          const index = rejectionListeners.indexOf(listener);
          if (index >= 0) rejectionListeners.splice(index, 1);
        }
      },
    },
    fireError: (event) => {
      errorListeners.forEach((listener) => {
        listener(event);
      });
    },
    fireRejection: (event) => {
      rejectionListeners.forEach((listener) => {
        listener(event);
      });
    },
  };
}

describe("normalizeError", () => {
  it("keeps message and stack from real Errors", () => {
    const err = new TypeError("x is not a function");
    const normalized = normalizeError(err);
    expect(normalized.message).toBe("x is not a function");
    expect(normalized.stack).toContain("at ");
  });

  it("falls back to the name when an Error has an empty message", () => {
    expect(normalizeError(new TypeError("")).message).toBe("TypeError");
  });

  it("accepts thrown strings and returns a stable placeholder for junk", () => {
    expect(normalizeError("boom").message).toBe("boom");
    expect(normalizeError(42).message).toBe("unknown error");
    expect(normalizeError(undefined).message).toBe("unknown error");
  });
});

describe("createErrorReporter", () => {
  let clock = 1_000_000;
  const now = () => clock;
  const pageUrl = () => "https://admin.example/invoices";

  it("reports message, stack and page url; never rejects the caller", async () => {
    const { fetch, bodies } = fakeFetch();
    const reporter = createErrorReporter({ fetchFn: fetch, now, pageUrl });
    reporter.capture(new Error("cart totals NaN"));
    await Promise.resolve();
    expect(bodies.length).toBe(1);
    const parsed = JSON.parse(bodies[0] ?? "{}") as { message: string; url: string; stack?: string };
    expect(parsed.message).toBe("cart totals NaN");
    expect(parsed.url).toBe("https://admin.example/invoices");
    expect(parsed.stack).toContain("at ");
  });

  it("a failing transport is swallowed — capture stays silent and returns nothing", () => {
    const { fetch } = fakeFetch(true);
    const reporter = createErrorReporter({ fetchFn: fetch, now, pageUrl });
    expect(() => {
      reporter.capture(new Error("boom"));
    }).not.toThrow();
  });

  it("throttles at 10 reports per rolling minute", () => {
    const { fetch, bodies } = fakeFetch();
    const reporter = createErrorReporter({ fetchFn: fetch, now, pageUrl });
    for (let i = 0; i < 25; i += 1) {
      reporter.capture(new Error(`distinct error ${String(i)}`));
      clock += 1_000;
    }
    expect(bodies.length).toBe(10);
    expect(reporter.sentCount()).toBe(10);
  });

  it("the same error inside the cooldown is a loop, not news — sent once", () => {
    const { fetch, bodies } = fakeFetch();
    const reporter = createErrorReporter({ fetchFn: fetch, now, pageUrl });
    const recur = (): Error => new Error("render loop");
    reporter.capture(recur());
    clock += 5_000;
    reporter.capture(recur());
    clock += 5_000;
    reporter.capture(recur());
    expect(bodies.length).toBe(1);
    // after the cooldown passes, the same shape is reportable again
    clock += 60_000;
    reporter.capture(recur());
    expect(bodies.length).toBe(2);
  });

  it("throttle and cooldown key on the top stack frame, not the message alone", () => {
    const { fetch, bodies } = fakeFetch();
    const reporter = createErrorReporter({ fetchFn: fetch, now, pageUrl });
    const make = (site: string): Error => {
      const err = new Error("same message");
      err.stack = `Error: same message\n    at ${site}`;
      return err;
    };
    reporter.capture(make("a.ts:1:1"));
    reporter.capture(make("b.ts:2:2"));
    expect(bodies.length).toBe(2);
  });
});

describe("installErrorReporter", () => {
  it("routes window error and unhandledrejection into the reporter; uninstall detaches", async () => {
    const { fetch, bodies } = fakeFetch();
    const { host, fireError, fireRejection } = fakeHost();
    const uninstall = installErrorReporter(host, { fetchFn: fetch, now: () => 1, pageUrl: () => "https://x/" });

    fireError({ message: "script error", error: new Error("from window") });
    fireRejection({ reason: "from rejection" });
    await Promise.resolve();
    expect(bodies.length).toBe(2);

    uninstall();
    fireError({ error: new Error("after uninstall") });
    fireRejection({ reason: "after uninstall" });
    await Promise.resolve();
    expect(bodies.length).toBe(2);
  });

  it("production wiring: installed once in main.tsx, before the tree renders", () => {
    const main = readFileSync(join(SRC, "main.tsx"), "utf8");
    expect(main.match(/installErrorReporter\(window\)/g)?.length).toBe(1);
    // the install call precedes the render call (not the import lines)
    expect(main.indexOf("installErrorReporter(window)")).toBeLessThan(main.indexOf("createRoot(root)"));
  });
});
