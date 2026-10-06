import { describe, expect, it } from "vitest";

import { humanizeIdentifier, payloadRows } from "./shared/lib/payload-rows.ts";

describe("payload rows (#221 todo page)", () => {
  it("a record-only line carries nothing", () => {
    expect(payloadRows(null)).toEqual([]);
    expect(payloadRows(undefined)).toEqual([]);
  });

  it("a plain object reads as label/value rows; snake_case keys read as words", () => {
    expect(payloadRows({ action: "grant", role: "sales_lead" })).toEqual([
      { key: "action", label: "Action", value: "Grant" },
      { key: "role", label: "Role", value: "Sales lead" },
    ]);
  });

  it("non-identifier strings pass through untouched", () => {
    expect(payloadRows({ note: "cover the Q4 co-packers" })).toEqual([
      { key: "note", label: "Note", value: "cover the Q4 co-packers" },
    ]);
  });

  it("structured values render as JSON, arrays and scalars take the fallback row", () => {
    expect(payloadRows({ lines: [{ sku: "A", qty: 2 }] })).toEqual([
      { key: "lines", label: "Lines", value: '[{"sku":"A","qty":2}]' },
    ]);
    expect(payloadRows(42)).toEqual([{ key: "", label: "Payload", value: "42" }]);
    expect(payloadRows(["a", "b"])).toEqual([{ key: "", label: "Payload", value: '["a","b"]' }]);
  });

  it("humanizeIdentifier is word-safe", () => {
    expect(humanizeIdentifier("owner")).toBe("Owner");
    expect(humanizeIdentifier("already_signed")).toBe("Already signed");
    expect(humanizeIdentifier("")).toBe("");
  });
});
