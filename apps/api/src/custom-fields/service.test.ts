import { describe, expect, it } from "vitest";
import { z } from "zod";
import { schema } from "@ally/db";
import {
  CUSTOM_FIELD_TYPES,
  canEditField,
  canViewField,
  composeFormSchema,
  fieldValueZod,
  parseValueSubmission,
  type CustomFieldDefLike,
} from "./service.ts";

/** 夹具字段定义：只带纯函数层关心的形状 */
function def(overrides: Partial<CustomFieldDefLike> & { fieldKey: string }): CustomFieldDefLike {
  return {
    id: `id-${overrides.fieldKey}`,
    label: overrides.fieldKey,
    fieldType: "text",
    options: null,
    required: false,
    viewableBy: [],
    editableBy: [],
    active: true,
    ...overrides,
  };
}

describe("custom field types (#222)", () => {
  it("type word list matches the custom_field_type pg enum value for value", () => {
    // service 层的 zod 词表与 DB 枚举是同一词表的两处拼写——漂移在此炸出
    expect([...CUSTOM_FIELD_TYPES].sort()).toEqual([...schema.customFieldType.enumValues].sort());
  });
});

describe("fieldValueZod (#222)", () => {
  it("text enforces the length cap and select enforces the option list", () => {
    expect(fieldValueZod({ fieldType: "text", options: null, required: true }).safeParse("x".repeat(10_001)).success).toBe(false);
    expect(fieldValueZod({ fieldType: "select", options: ["a", "b"], required: true }).safeParse("c").success).toBe(false);
    expect(fieldValueZod({ fieldType: "select", options: ["a", "b"], required: true }).safeParse("a").success).toBe(true);
  });

  it("number/boolean/date shapes are strict", () => {
    expect(fieldValueZod({ fieldType: "number", options: null, required: true }).safeParse("1").success).toBe(false);
    expect(fieldValueZod({ fieldType: "boolean", options: null, required: true }).safeParse("true").success).toBe(false);
    expect(fieldValueZod({ fieldType: "date", options: null, required: true }).safeParse("2026-02-30").success).toBe(false);
    expect(fieldValueZod({ fieldType: "date", options: null, required: true }).safeParse("2026-10-06").success).toBe(true);
  });

  it("optional fields accept null (explicit clear), required fields reject it", () => {
    const optional = fieldValueZod({ fieldType: "text", options: null, required: false });
    const required = fieldValueZod({ fieldType: "text", options: null, required: true });
    expect(optional.safeParse(null).success).toBe(true);
    expect(required.safeParse(null).success).toBe(false);
  });
});

describe("composeFormSchema (#222)", () => {
  it("merges builtin fields and custom fields into one input-side JSON Schema", () => {
    const jsonSchema = composeFormSchema({ company: z.string().min(1) }, [
      def({ fieldKey: "annual_revenue", fieldType: "number", required: true }),
      def({ fieldKey: "notes", fieldType: "text" }),
      def({ fieldKey: "tier", fieldType: "select", options: ["a", "b"] }),
    ]);
    expect(jsonSchema.type).toBe("object");
    const properties = jsonSchema.properties as Record<string, { type?: string; enum?: string[] }>;
    expect(Object.keys(properties).sort()).toEqual(["annual_revenue", "company", "notes", "tier"]);
    // input 侧：必填进 required 数组，可选字段不进（顺序 = shape 铺开顺序）
    expect(jsonSchema.required).toEqual(["company", "annual_revenue"]);
    // 可选 select 导出为 anyOf（值枚举 ∪ null）——rjsf 可渲染的标准 JSON Schema
    const tier = properties.tier as { anyOf?: { enum?: string[] }[] };
    expect(tier.anyOf?.[0]?.enum).toEqual(["a", "b"]);
  });

  it("refuses to let a custom field key shadow a builtin field", () => {
    expect(() =>
      composeFormSchema({ company: z.string() }, [def({ fieldKey: "company" })]),
    ).toThrow(/collides/);
  });
});

describe("field permission semantics (#222 字段级权限)", () => {
  const salesOnly = def({ fieldKey: "commission", viewableBy: ["sales", "sales_lead"] });
  const qaEdit = def({ fieldKey: "judgement", viewableBy: [], editableBy: ["qa"] });

  it("empty restriction = unrestricted, non-empty = intersection", () => {
    expect(canViewField(salesOnly, ["sales"])).toBe(true);
    expect(canViewField(salesOnly, ["qa"])).toBe(false);
    expect(canViewField(qaEdit, ["customer"])).toBe(true);
  });

  it("editing requires visibility first (fail closed), then the edit list", () => {
    expect(canEditField(qaEdit, ["qa"])).toBe(true);
    expect(canEditField(qaEdit, ["sales"])).toBe(false);
    // 看不见的字段即便 editableBy 放行也不可写——写看不见的字段是瞎写
    const hiddenEditable = def({ fieldKey: "x", viewableBy: ["qa"], editableBy: [] });
    expect(canEditField(hiddenEditable, ["sales"])).toBe(false);
  });
});

describe("parseValueSubmission (#222 必填与权限的服务端校验)", () => {
  const defs = [
    def({ fieldKey: "po_number", fieldType: "text", required: true }),
    def({ fieldKey: "annual_revenue", fieldType: "number" }),
    def({ fieldKey: "tier", fieldType: "select", options: ["a", "b"] }),
    def({ fieldKey: "commission", fieldType: "number", viewableBy: ["finance"] }),
  ];

  it("accepts a full submission and returns parsed writes", () => {
    const result = parseValueSubmission(
      defs,
      ["sales"],
      { po_number: "PO-1", annual_revenue: 120_000, tier: "a" },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.writes.map((w) => w.def.fieldKey).sort()).toEqual([
        "annual_revenue",
        "po_number",
        "tier",
      ]);
      const revenue = result.writes.find((w) => w.def.fieldKey === "annual_revenue");
      expect(revenue).toMatchObject({ action: "set", value: 120_000 });
    }
  });

  it("parses an explicit null on an optional field as a clear write, not a value", () => {
    const result = parseValueSubmission(defs, ["sales"], { po_number: "PO-1", tier: null });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const tier = result.writes.find((w) => w.def.fieldKey === "tier");
      expect(tier?.action).toBe("clear");
      expect(tier).not.toHaveProperty("value");
    }
  });

  it("an explicit null on a required field is invalid, not a clear", () => {
    const result = parseValueSubmission(defs, ["sales"], { po_number: null });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const po = result.issues.find((issue) => issue.fieldKey === "po_number");
      expect(po?.code).toBe("invalid");
    }
  });

  it("rejects unknown keys, wrong types and off-list select options with per-field issues", () => {
    const result = parseValueSubmission(
      defs,
      ["sales"],
      { po_number: "PO-1", ghost: "x", annual_revenue: "heavy", tier: "z" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const byKey = new Map(result.issues.map((issue) => [issue.fieldKey, issue.code]));
      expect(byKey.get("ghost")).toBe("unknown_field");
      expect(byKey.get("annual_revenue")).toBe("invalid");
      expect(byKey.get("tier")).toBe("invalid");
    }
  });

  it("enforces required fields visible to the actor", () => {
    const result = parseValueSubmission(defs, ["sales"], { annual_revenue: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual({ fieldKey: "po_number", code: "required" });
    }
  });

  it("does not demand required fields the actor cannot view, and rejects writes to them", () => {
    // finance 专属字段：sales 提交不含它不算缺 required；越权写它报 not_editable
    const ok = parseValueSubmission(defs, ["sales"], { po_number: "PO-1" });
    expect(ok.ok).toBe(true);
    const forbidden = parseValueSubmission(defs, ["sales"], {
      po_number: "PO-1",
      commission: 999,
    });
    expect(forbidden.ok).toBe(false);
    if (!forbidden.ok) {
      expect(forbidden.issues).toContainEqual({
        fieldKey: "commission",
        code: "not_editable",
      });
    }
    // 持权角色可以写
    const finance = parseValueSubmission(defs, ["finance"], {
      po_number: "PO-1",
      commission: 999,
    });
    expect(finance.ok).toBe(true);
  });

  it("treats inactive defs as unknown keys", () => {
    const retired = def({ fieldKey: "old_field", active: false });
    const result = parseValueSubmission([retired], ["sales"], { old_field: "x" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual({ fieldKey: "old_field", code: "unknown_field" });
    }
  });

  it("rejects a non-object payload", () => {
    expect(parseValueSubmission(defs, ["sales"], "nope").ok).toBe(false);
    expect(parseValueSubmission(defs, ["sales"], null).ok).toBe(false);
  });
});
