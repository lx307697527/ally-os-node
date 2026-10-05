// The runtime half of the version watch (#129 slice 3), checked as units with
// injected fetches, clocks and a structurally-faked window — no jsdom, the
// house shape. What this guards: a poll costs one small request, failure is
// "no news" (never a crash, never a false alarm), and NOTHING here ever
// reloads the page — the old system's ruling that survives this port. The
// production fetch wiring (no-store, same-origin) is policed as source text
// in version-check.test.ts.
import { describe, expect, it, vi } from "vitest";

import {
  VERSION_CHECK_INTERVAL_MS,
  VERSION_CHECK_MIN_GAP_MS,
  createVersionWatch,
  scheduleVersionWatch,
  type VersionWatchHost,
} from "./version-watch.ts";

const json = (buildId: string): unknown => ({ buildId });

describe("createVersionWatch", () => {
  it("reports nothing while the live build matches this tab's", async () => {
    const watch = createVersionWatch({
      current: "aaa",
      fetchVersionJson: () => Promise.resolve(json("aaa")),
    });
    await watch.check();
    expect(watch.newerBuildId()).toBeNull();
  });

  it("reports the live build once a new build is up", async () => {
    const watch = createVersionWatch({
      current: "aaa",
      fetchVersionJson: () => Promise.resolve(json("bbb")),
    });
    await watch.check();
    expect(watch.newerBuildId()).toBe("bbb");
  });

  it("never fetches when this bundle has no build id (dev, tests)", async () => {
    const fetchVersionJson = vi.fn(() => Promise.resolve(json("bbb")));
    const watch = createVersionWatch({ current: null, fetchVersionJson });
    await watch.check();
    expect(fetchVersionJson).not.toHaveBeenCalled();
    expect(watch.newerBuildId()).toBeNull();
  });

  it("a failed check is no news, and never throws", async () => {
    const watch = createVersionWatch({
      current: "aaa",
      fetchVersionJson: () => Promise.reject(new Error("offline")),
    });
    await expect(watch.check()).resolves.toBeUndefined();
    expect(watch.newerBuildId()).toBeNull();
  });

  it("a body without a usable build id (an SPA fallback HTML page) is not news", async () => {
    for (const body of ["<!doctype html><html>Bad gateway</html>", { buildId: "" }, { buildId: 42 }, {}]) {
      const watch = createVersionWatch({
        current: "aaa",
        fetchVersionJson: () => Promise.resolve(body),
      });
      await watch.check();
      expect(watch.newerBuildId()).toBeNull();
    }
  });

  it("keeps known news when a later check fails or answers garbage", async () => {
    let body: unknown = json("bbb");
    let t = 0;
    const watch = createVersionWatch({
      current: "aaa",
      fetchVersionJson: () => Promise.resolve(body),
      now: () => t,
    });
    await watch.check();
    expect(watch.newerBuildId()).toBe("bbb");
    body = "<html>maintenance page</html>";
    t += VERSION_CHECK_MIN_GAP_MS;
    await watch.check();
    expect(watch.newerBuildId()).toBe("bbb");
  });

  it("asks at most once per gap", async () => {
    const fetchVersionJson = vi.fn(() => Promise.resolve(json("bbb")));
    let t = 0;
    const watch = createVersionWatch({ current: "aaa", fetchVersionJson, now: () => t });
    await watch.check();
    t += VERSION_CHECK_MIN_GAP_MS - 1;
    await watch.check();
    expect(fetchVersionJson).toHaveBeenCalledTimes(1);
    t += 1;
    await watch.check();
    expect(fetchVersionJson).toHaveBeenCalledTimes(2);
  });

  it("never runs two fetches at once", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchVersionJson = vi.fn(async () => {
      await gate;
      return json("bbb");
    });
    let t = 0;
    const watch = createVersionWatch({ current: "aaa", fetchVersionJson, now: () => t });
    const first = watch.check();
    t += VERSION_CHECK_MIN_GAP_MS;
    await watch.check();
    release();
    await first;
    expect(fetchVersionJson).toHaveBeenCalledTimes(1);
  });

  it("announces the verdict after every completed check, null included", async () => {
    const news: (string | null)[] = [];
    let body: unknown = json("aaa");
    let t = 0;
    const watch = createVersionWatch({
      current: "aaa",
      fetchVersionJson: () => Promise.resolve(body),
      now: () => t,
      onNews: (id) => news.push(id),
    });
    await watch.check();
    body = json("bbb");
    t += VERSION_CHECK_MIN_GAP_MS;
    await watch.check();
    expect(news).toEqual([null, "bbb"]);
  });
});

interface FakeHost extends VersionWatchHost {
  ticks: (() => void)[];
  timeouts: (number | undefined)[];
  visibilityListeners: (() => void)[];
  cleared: number[];
}

function fakeHost(visibility: "visible" | "hidden" = "visible"): FakeHost {
  const host: FakeHost = {
    ticks: [],
    timeouts: [],
    visibilityListeners: [],
    cleared: [],
    setInterval(handler, timeout) {
      host.ticks.push(handler);
      host.timeouts.push(timeout);
      return host.ticks.length;
    },
    clearInterval(handle) {
      host.cleared.push(handle);
    },
    addEventListener(_type, listener) {
      host.visibilityListeners.push(listener);
    },
    removeEventListener(_type, listener) {
      host.visibilityListeners = host.visibilityListeners.filter((l) => l !== listener);
    },
    document: { visibilityState: visibility },
  };
  return host;
}

describe("scheduleVersionWatch", () => {
  it("registers one interval at the poll cadence and listens for visibility", () => {
    const host = fakeHost();
    const watch = createVersionWatch({
      current: "aaa",
      fetchVersionJson: () => Promise.resolve(json("aaa")),
    });
    const stop = scheduleVersionWatch(watch, host);
    expect(host.ticks).toHaveLength(1);
    expect(host.timeouts[0]).toBe(VERSION_CHECK_INTERVAL_MS);
    expect(host.visibilityListeners).toHaveLength(1);
    stop();
  });

  it("ticks ask only while the tab is visible", async () => {
    const fetchVersionJson = vi.fn(() => Promise.resolve(json("aaa")));
    let t = 0;
    const host = fakeHost("visible");
    const watch = createVersionWatch({ current: "aaa", fetchVersionJson, now: () => t });
    scheduleVersionWatch(watch, host);
    host.ticks[0]?.();
    await vi.waitFor(() => {
      expect(fetchVersionJson).toHaveBeenCalledTimes(1);
    });
    host.document = { visibilityState: "hidden" };
    t += VERSION_CHECK_MIN_GAP_MS;
    host.ticks[0]?.();
    expect(fetchVersionJson).toHaveBeenCalledTimes(1);
  });

  it("a visibility change asks immediately, per the tab's state at that moment", async () => {
    const host = fakeHost("hidden");
    const watch = createVersionWatch({
      current: "aaa",
      fetchVersionJson: () => Promise.resolve(json("bbb")),
    });
    scheduleVersionWatch(watch, host);
    // Still hidden when the event fires: the tab cannot see a banner anyway.
    host.visibilityListeners[0]?.();
    expect(watch.newerBuildId()).toBeNull();
    // Became visible, then the event fires: this is the moment to ask.
    host.document = { visibilityState: "visible" };
    host.visibilityListeners[0]?.();
    await vi.waitFor(() => {
      expect(watch.newerBuildId()).toBe("bbb");
    });
  });
});
