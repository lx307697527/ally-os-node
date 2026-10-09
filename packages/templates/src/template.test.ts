import { describe, expect, it } from "vitest";
import {
  extractTemplateVariables,
  missingTemplateVariables,
  registerTemplateChannel,
  renderTemplate,
  templateChannelSchema,
  templateChannels,
  templateContentError,
  templateTypeSchema,
} from "./template.ts";

// 渲染语义是老系统 renderPlaceholders 的直译（_shared/email_shells.ts）：
// 缺失变量保留 `{{name}}` 原样（可诊断的显性失败），值为空串照常替换。
// 这两个语义是消费方的合同——改任何一个都要先想过发出的信长什么样。
describe("renderTemplate", () => {
  it("substitutes provided variables", () => {
    expect(
      renderTemplate("Hi {{name}}, confirm {{link}}", { name: "Ada", link: "https://x.y/t=1" }),
    ).toBe("Hi Ada, confirm https://x.y/t=1");
  });

  it("keeps unknown placeholders verbatim (diagnosable, not silently emptied)", () => {
    expect(renderTemplate("Hi {{nmae}}", { name: "Ada" })).toBe("Hi {{nmae}}");
  });

  it("tolerates whitespace inside braces but preserves it when missing", () => {
    expect(renderTemplate("Hi {{  name  }}!", { name: "Ada" })).toBe("Hi Ada!");
    expect(renderTemplate("Hi {{  nmae  }}!", { name: "Ada" })).toBe("Hi {{  nmae  }}!");
  });

  it("substitutes empty string when provided (empty value ≠ missing variable)", () => {
    expect(renderTemplate("Hi {{name}}/{{other}}", { name: "" })).toBe("Hi /{{other}}");
  });

  it("leaves non-identifier braces alone", () => {
    expect(renderTemplate("json {{ a.b }} and {{{name}}}", { name: "Ada" })).toBe(
      "json {{ a.b }} and {Ada}",
    );
  });

  it("reuses the same pattern instance safely across calls (no lastIndex leak)", () => {
    expect(renderTemplate("{{a}}{{b}}", { a: "1", b: "2" })).toBe("12");
    expect(renderTemplate("{{a}}{{b}}", { a: "1", b: "2" })).toBe("12");
  });
});

describe("extractTemplateVariables", () => {
  it("collects names from subject and body in first-seen order, deduplicated", () => {
    expect(
      extractTemplateVariables("Welcome, {{name}}", "<p>Hi {{ user_name }}, {{name}}!</p>"),
    ).toEqual(["name", "user_name"]);
  });

  it("returns empty for a template without placeholders", () => {
    expect(extractTemplateVariables("static subject", "<p>static</p>")).toEqual([]);
  });
});

describe("missingTemplateVariables", () => {
  it("reports referenced names absent from vars", () => {
    expect(missingTemplateVariables(["name", "link", "name"], { name: "Ada" })).toEqual(["link"]);
  });

  it("treats empty-string value as provided", () => {
    expect(missingTemplateVariables(["name"], { name: "" })).toEqual([]);
  });
});

describe("channel registry", () => {
  it("registers email with subject required, sorted listing", () => {
    expect(templateChannels()).toEqual([{ channel: "email", label: "Email" }]);
    registerTemplateChannel("sms", { label: "SMS", subjectRequired: false });
    expect(templateChannels()).toEqual([
      { channel: "email", label: "Email" },
      { channel: "sms", label: "SMS" },
    ]);
    expect(templateContentError("sms", { subjectTemplate: null, bodyTemplate: "hi" })).toBeNull();
    expect(templateContentError("sms", { subjectTemplate: "no", bodyTemplate: "hi" })).toBe(
      "subject_not_allowed",
    );
  });

  it("rejects content for unknown channels (fail closed: no dead config)", () => {
    expect(templateContentError("emale", { subjectTemplate: "s", bodyTemplate: "b" })).toBe(
      "unknown_channel",
    );
    expect(templateContentError("email", { subjectTemplate: null, bodyTemplate: "b" })).toBe(
      "subject_required",
    );
    expect(templateContentError("email", { subjectTemplate: "s", bodyTemplate: "b" })).toBeNull();
  });
});

describe("input schemas", () => {
  it("normalizes channel casing/whitespace and rejects malformed identifiers", () => {
    expect(templateChannelSchema.safeParse(" Email ").success).toBe(true);
    expect(templateChannelSchema.safeParse("1bad").success).toBe(false);
    expect(templateChannelSchema.safeParse("has space").success).toBe(false);
  });

  it("constrains template types to lowercase identifiers", () => {
    expect(templateTypeSchema.safeParse("account_invite").success).toBe(true);
    expect(templateTypeSchema.safeParse("Account Invite").success).toBe(false);
    expect(templateTypeSchema.safeParse("").success).toBe(false);
  });
});
