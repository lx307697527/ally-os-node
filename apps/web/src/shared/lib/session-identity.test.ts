// The session chip's copy rules (ally-os ruling, issue #2127): show the
// signed-in user's name; with no name, the part of the email before `@`; the
// initials in the circle follow the signed-in user. Ported from ally-os
// apps/allyos session-identity.test.ts, keeping the cases that pin the rules.
import { describe, expect, it } from "vitest";

import {
  sessionIdentityDisplay,
  sessionIdentityFromUser,
} from "./session-identity.ts";

describe("sessionIdentityDisplay", () => {
  it("a name prints as itself; initials are the first letters of the first two words", () => {
    expect(sessionIdentityDisplay({ name: "Jordan Lee", email: "jordan@ally.example" })).toEqual({
      label: "Jordan Lee",
      initials: "JL",
    });
    expect(sessionIdentityDisplay({ name: "aost", email: "aost@ally.example" })).toEqual({
      label: "aost",
      initials: "A",
    });
  });

  it("with no name, the local part of the address prints, with its first two characters", () => {
    expect(sessionIdentityDisplay({ name: null, email: "aost@ally.example" })).toEqual({
      label: "aost",
      initials: "AO",
    });
  });

  it("a name of spaces is an absent name", () => {
    expect(sessionIdentityDisplay({ name: "   ", email: "lee@ally.example" })?.label).toBe("lee");
  });

  it("an account with neither a name nor a local part prints nothing", () => {
    expect(sessionIdentityDisplay({ name: null, email: "@example.com" })).toBeNull();
  });

  it("a surrogate pair is one character, not half of one", () => {
    const display = sessionIdentityDisplay({ name: "🅰️ONA SMITH", email: "ona@ally.example" });
    expect(display?.initials.startsWith("🅰")).toBe(true);
  });
});

describe("sessionIdentityFromUser", () => {
  it("reads the better-auth user's name and address", () => {
    expect(sessionIdentityFromUser({ name: "Jordan Lee", email: "jordan@ally.example" })).toEqual({
      name: "Jordan Lee",
      email: "jordan@ally.example",
    });
  });

  it("a trimmed-empty name arrives as null, not as whitespace in the chip", () => {
    expect(sessionIdentityFromUser({ name: "  ", email: "lee@ally.example" })).toEqual({
      name: null,
      email: "lee@ally.example",
    });
  });

  it("an account with nothing to read answers null — the shell keeps its brand chip", () => {
    expect(sessionIdentityFromUser(null)).toBeNull();
    expect(sessionIdentityFromUser({ name: null, email: null })).toBeNull();
    expect(sessionIdentityFromUser({ name: null, email: "" })).toBeNull();
  });
});
