import { describe, expect, it } from "vitest";
import { computeErrorFingerprint, firstLine, topStackFrame, truncate } from "./capture.ts";

// 指纹与裁剪是纯函数，行为在这里穷举；落库路径走 routes/errors.test.ts 的
// 集成套件（真库读回）。

describe("firstLine", () => {
  it("takes the first line and trims", () => {
    expect(firstLine("TypeError: x is not a function\n    at foo (bar.ts:1:1)")).toBe(
      "TypeError: x is not a function",
    );
  });

  it("keeps a single-line message intact", () => {
    expect(firstLine("  boom  ")).toBe("boom");
  });

  it("caps at 500 so a huge first line cannot inflate the hash input", () => {
    expect(firstLine("x".repeat(2000)).length).toBe(500);
  });
});

describe("topStackFrame", () => {
  it("returns the first 'at ' line, trimmed", () => {
    expect(topStackFrame("Error: boom\n    at foo (a.ts:1:1)\n    at bar (b.ts:2:2)")).toBe(
      "at foo (a.ts:1:1)",
    );
  });

  it("returns empty for undefined or frame-less stacks (cross-origin Script error)", () => {
    expect(topStackFrame(undefined)).toBe("");
    expect(topStackFrame("Script error.")).toBe("");
  });
});

describe("truncate", () => {
  it("keeps short values and slices long ones", () => {
    expect(truncate("abc", 5)).toBe("abc");
    expect(truncate("abcdef", 5)).toBe("abcde");
  });
});

describe("computeErrorFingerprint", () => {
  const message = "TypeError: x is not a function";
  const stack = `TypeError: x is not a function\n    at onClick (Widget.tsx:42:10)\n    at runEffects`;

  it("is stable for the same source/message/stack", () => {
    expect(computeErrorFingerprint({ source: "web", message, stack })).toBe(
      computeErrorFingerprint({ source: "web", message, stack }),
    );
  });

  it("separates sources: the same error on web and api groups apart", () => {
    expect(computeErrorFingerprint({ source: "web", message, stack })).not.toBe(
      computeErrorFingerprint({ source: "api", message, stack }),
    );
  });

  it("separates same-message errors that happen at different sites", () => {
    const otherSite = `TypeError: x is not a function\n    at onHover (Other.tsx:7:3)`;
    expect(computeErrorFingerprint({ source: "web", message, stack })).not.toBe(
      computeErrorFingerprint({ source: "web", message, stack: otherSite }),
    );
  });

  it("groups messages that differ only after the first line", () => {
    const withCause = `${message}\nCaused by: deeper failure`;
    expect(computeErrorFingerprint({ source: "web", message, stack })).toBe(
      computeErrorFingerprint({ source: "web", message: withCause, stack }),
    );
  });

  it("is a 64-char hex sha256 and never throws on junk-free inputs", () => {
    const fp = computeErrorFingerprint({ source: "web", message: "boom" });
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });
});
