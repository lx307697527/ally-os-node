// Unit tests for the pure half of the session-timeout watch (#129 slice 2):
// turning the server's published deadline into a phase. The React half is
// covered as source text (session-timeout.test.ts) — this file gets the real
// clock arithmetic, including the boundaries a countdown lives or dies by.
import { describe, expect, it } from "vitest";

import {
  SESSION_EXPIRED_NOTICE_KEY,
  clearSessionExpiredNotice,
  markSessionExpiredNotice,
  peekSessionExpiredNotice,
  SESSION_WARNING_LEAD_MS,
  parseExpiryMs,
  phaseFor,
} from "./session-expiry.ts";

function fakeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
}

describe("parseExpiryMs", () => {
  it("reads the ISO string better-auth actually delivers on the wire", () => {
    const ms = parseExpiryMs("2026-10-05T12:00:00.000Z");
    expect(ms).toBe(Date.parse("2026-10-05T12:00:00.000Z"));
  });

  it("accepts an epoch-ms number and a Date instance", () => {
    expect(parseExpiryMs(1_700_000_000_000)).toBe(1_700_000_000_000);
    const date = new Date("2026-10-05T12:00:00.000Z");
    expect(parseExpiryMs(date)).toBe(date.getTime());
  });

  it("refuses what it cannot trust — garbage, empty, wrong shapes", () => {
    expect(parseExpiryMs("not-a-date")).toBeNull();
    expect(parseExpiryMs("")).toBeNull();
    expect(parseExpiryMs(undefined)).toBeNull();
    expect(parseExpiryMs(null)).toBeNull();
    expect(parseExpiryMs({ expiresAt: "2026-10-05T12:00:00.000Z" })).toBeNull();
    expect(parseExpiryMs(Number.NaN)).toBeNull();
    expect(parseExpiryMs(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("the expired-session note", () => {
  it("marks, peeks without consuming, and clears on demand", () => {
    const storage = fakeStorage();
    expect(peekSessionExpiredNotice(storage)).toBe(false);
    markSessionExpiredNotice(storage);
    expect(storage.getItem(SESSION_EXPIRED_NOTICE_KEY)).toBe("1");
    // Peek is pure: StrictMode replays state initializers, so the read the
    // latch depends on must be repeatable.
    expect(peekSessionExpiredNotice(storage)).toBe(true);
    expect(peekSessionExpiredNotice(storage)).toBe(true);
    clearSessionExpiredNotice(storage);
    expect(peekSessionExpiredNotice(storage)).toBe(false);
  });
});

describe("phaseFor", () => {
  const now = 1_000_000_000_000;
  const far = now + 12 * 60 * 60 * 1000;

  it("no deadline means no claim — the server stays the authority", () => {
    expect(phaseFor({ expiresAtMs: null, nowMs: now })).toBe("active");
  });

  it("plenty of time left is active", () => {
    expect(phaseFor({ expiresAtMs: far, nowMs: now })).toBe("active");
  });

  it("inside the lead window is warning — boundary inclusive", () => {
    const atBoundary = now + SESSION_WARNING_LEAD_MS;
    expect(phaseFor({ expiresAtMs: atBoundary, nowMs: now })).toBe("warning");
    expect(phaseFor({ expiresAtMs: atBoundary - 1, nowMs: now })).toBe("warning");
    expect(phaseFor({ expiresAtMs: atBoundary + 1, nowMs: now })).toBe("active");
  });

  it("at and past the deadline is expired — boundary inclusive", () => {
    expect(phaseFor({ expiresAtMs: now, nowMs: now })).toBe("expired");
    expect(phaseFor({ expiresAtMs: now - 1, nowMs: now })).toBe("expired");
  });

  it("a custom lead moves the warning boundary", () => {
    const options = { expiresAtMs: now + 5_000, nowMs: now, warningLeadMs: 10_000 };
    expect(phaseFor(options)).toBe("warning");
  });
});
