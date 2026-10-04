// returnPathFrom answers "/" for "nothing said" AND for "what was said was
// not an internal path" — one comparison covers both, because every caller
// treats "/" the same as "nothing said".
import { describe, expect, it } from "vitest";

import { returnPathFrom } from "./return-to.ts";

describe("returnPathFrom", () => {
  it("nothing said is /", () => {
    expect(returnPathFrom(null)).toBe("/");
    expect(returnPathFrom(undefined)).toBe("/");
    expect(returnPathFrom({})).toBe("/");
    expect(returnPathFrom({ from: {} })).toBe("/");
    expect(returnPathFrom({ from: { pathname: 42 } })).toBe("/");
  });

  it("an internal path passes", () => {
    expect(returnPathFrom({ from: { pathname: "/quotes/new" } })).toBe("/quotes/new");
  });

  it("a protocol-relative address is refused — that is an open redirect", () => {
    expect(returnPathFrom({ from: { pathname: "//evil.example" } })).toBe("/");
  });

  it("a foreign scheme is refused", () => {
    expect(returnPathFrom({ from: { pathname: "https://evil.example" } })).toBe("/");
  });
});
