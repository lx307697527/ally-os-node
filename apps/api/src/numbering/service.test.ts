import { describe, expect, it } from "vitest";
import { dateSegment, formatDocumentNumber, NoActiveRuleError } from "./service.ts";

// 纯函数单测（无 DB）：格式渲染与日期段。分配语义（首号、并发唯一、停用 fail
// closed、回滚归还）在 routes/numbering-rules.test.ts 的集成套件里——需要真
// PostgreSQL，桩满足不了 drizzle 的链式类型，也不该用桩冒充它。

// UTC 逐字段构造，避免本地时区让断言漂移
const utc = (year: number, month: number, day: number) => new Date(Date.UTC(year, month - 1, day, 12));

describe("dateSegment (#225 numbering)", () => {
  it("renders UTC calendar parts", () => {
    expect(dateSegment("YYYY", utc(2026, 10, 6))).toBe("2026");
    expect(dateSegment("YYYYMM", utc(2026, 10, 6))).toBe("202610");
    expect(dateSegment("YYYYMMDD", utc(2026, 10, 6))).toBe("20261006");
  });

  it("zero-pads single-digit months and days", () => {
    expect(dateSegment("YYYYMM", utc(2027, 1, 9))).toBe("202701");
    expect(dateSegment("YYYYMMDD", utc(2027, 1, 9))).toBe("20270109");
  });
});

describe("formatDocumentNumber (#225 numbering)", () => {
  it("matches the legacy shape: prefix + padded sequence (INV-3092)", () => {
    expect(formatDocumentNumber({ prefix: "INV-", dateFormat: null, padding: 4 }, 3092, utc(2026, 10, 6))).toBe(
      "INV-3092",
    );
  });

  it("renders the date segment between prefix and sequence (INV-202608-0001)", () => {
    expect(formatDocumentNumber({ prefix: "INV-", dateFormat: "YYYYMM", padding: 4 }, 1, utc(2026, 8, 17))).toBe(
      "INV-202608-0001",
    );
  });

  it("grows past the padding width instead of truncating", () => {
    expect(formatDocumentNumber({ prefix: "QT-", dateFormat: null, padding: 4 }, 12345, utc(2026, 1, 1))).toBe(
      "QT-12345",
    );
  });

  it("supports zero padding and empty prefix", () => {
    expect(formatDocumentNumber({ prefix: "", dateFormat: null, padding: 0 }, 7, utc(2026, 1, 1))).toBe("7");
  });

  it("keeps numbers identical for a fixed clock regardless of wall time", () => {
    const rule = { prefix: "HT-", dateFormat: "YYYY" as const, padding: 3 };
    expect(formatDocumentNumber(rule, 5, utc(2027, 6, 1))).toBe(formatDocumentNumber(rule, 5, utc(2027, 6, 1)));
  });
});

describe("NoActiveRuleError", () => {
  it("names the subject so owner domains can log which rule is missing", () => {
    const err = new NoActiveRuleError("quote");
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("quote");
  });
});
