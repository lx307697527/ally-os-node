// The template adapters' contracts, against a fake fetch — same discipline as
// numbering-client.test.ts: reads report the failure mode instead of
// flattening it, every parse is zod, the writes speak the kernel's specific
// rejections (unknown channel, subject rules, duplicate row, missing
// template, missing version), the PATCH body is the complete content object,
// and the known-type table documents real consumers without pretending the
// type field is a closed enum.
import { describe, expect, it, vi } from "vitest";

import {
  createTemplatesAdapters,
  KNOWN_TEMPLATE_TYPES,
  sampleVariableValue,
  templateTypeLabel,
  type TemplateRow,
} from "./templates-client.ts";

function fetchJson(body: unknown, status = 200): typeof fetch {
  return vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status })));
}

function fetchFailing(): typeof fetch {
  return vi.fn(() => Promise.reject(new Error("network down")));
}

const ROW: TemplateRow = {
  id: "0e8d1c2a-6f7b-4c1e-9a5a-0b6f3f7c1a01",
  channel: "email",
  templateType: "password_reset",
  subjectTemplate: "Reset your password",
  bodyTemplate: "<p>Hello {{name}},</p><a href=\"{{link}}\">Reset</a>",
  isActive: true,
  version: 2,
  createdAt: "2026-10-09T00:00:00.000Z",
  updatedAt: "2026-10-09T01:00:00.000Z",
};

describe("templates adapters — reads (#225)", () => {
  it("list 解析 channels 注册表与模板行(含停用行)", async () => {
    const fetchFn = fetchJson({
      channels: [{ channel: "email", label: "Email" }],
      templates: [ROW, { ...ROW, id: "b", isActive: false, version: 1 }],
    });
    const result = await createTemplatesAdapters(fetchFn).list();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.channels).toEqual([{ channel: "email", label: "Email" }]);
    expect(result.data.templates).toHaveLength(2);
    expect(result.data.templates[1]?.isActive).toBe(false);
  });

  it("list 的 403 说 forbidden,网络失败说 unavailable——表格空不冒充答案", async () => {
    const forbidden = await createTemplatesAdapters(fetchJson({ error: "forbidden" }, 403)).list();
    expect(forbidden).toEqual({ ok: false, reason: "forbidden" });
    const down = await createTemplatesAdapters(fetchFailing()).list();
    expect(down).toEqual({ ok: false, reason: "unavailable" });
  });

  it("list 遇到不合形状的响应体按 unavailable 报,不把垃圾喂进表格", async () => {
    const result = await createTemplatesAdapters(fetchJson({ templates: "all of them" })).list();
    expect(result).toEqual({ ok: false, reason: "unavailable" });
  });

  it("detail 带回版本史;404 说 not_found", async () => {
    const ok = await createTemplatesAdapters(
      fetchJson({ template: ROW, versions: [{ version: 1, subjectTemplate: null, bodyTemplate: "x", changedById: null, changedAt: "2026-10-09T00:00:00.000Z" }] }),
    ).detail(ROW.id);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.data.versions[0]?.version).toBe(1);
    const missing = await createTemplatesAdapters(fetchJson({ error: "not_found" }, 404)).detail(ROW.id);
    expect(missing).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("templates adapters — writes (#225)", () => {
  it("create 发完整内容对象,201 交回 id;409 说 exists", async () => {
    let seenUrl = "";
    let seenMethod = "";
    let seenBody = "";
    const fetchFn: typeof fetch = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
      if (typeof url === "string") seenUrl = url;
      seenMethod = init?.method ?? "";
      const body = init?.body;
      if (typeof body === "string") seenBody = body;
      return Promise.resolve(new Response(JSON.stringify({ id: ROW.id }), { status: 201 }));
    });
    const result = await createTemplatesAdapters(fetchFn).create({
      channel: "email",
      templateType: "password_reset",
      subjectTemplate: "Reset your password",
      bodyTemplate: "<p>Hello {{name}}</p>",
    });
    expect(result).toEqual({ ok: true, data: { id: ROW.id } });
    expect(seenUrl).toBe("/api/templates");
    expect(seenMethod).toBe("POST");
    expect(JSON.parse(seenBody)).toEqual({
      channel: "email",
      templateType: "password_reset",
      subjectTemplate: "Reset your password",
      bodyTemplate: "<p>Hello {{name}}</p>",
    });

    const duplicate = await createTemplatesAdapters(fetchJson({ error: "template_exists" }, 409)).create({
      channel: "email",
      templateType: "password_reset",
      subjectTemplate: "s",
      bodyTemplate: "b",
    });
    expect(duplicate).toEqual({ ok: false, reason: "exists" });
  });

  it("create 把内核的内容校验词逐一接住:unknown_channel / subject_required / subject_not_allowed", async () => {
    const unknown = await createTemplatesAdapters(fetchJson({ error: "unknown_channel" }, 400)).create({
      channel: "fax", templateType: "t", subjectTemplate: "s", bodyTemplate: "b",
    });
    expect(unknown).toEqual({ ok: false, reason: "unknown_channel" });
    const noSubject = await createTemplatesAdapters(fetchJson({ error: "subject_required" }, 400)).create({
      channel: "email", templateType: "t", subjectTemplate: null, bodyTemplate: "b",
    });
    expect(noSubject).toEqual({ ok: false, reason: "subject_required" });
    const withSubject = await createTemplatesAdapters(fetchJson({ error: "subject_not_allowed" }, 400)).create({
      channel: "sms", templateType: "t", subjectTemplate: "s", bodyTemplate: "b",
    });
    expect(withSubject).toEqual({ ok: false, reason: "subject_not_allowed" });
  });

  it("PATCH 发完整对象(subject+body+isActive),幂等 updated=false 原样交回", async () => {
    let seenMethod = "";
    let seenBody = "";
    const fetchFn: typeof fetch = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      seenMethod = init?.method ?? "";
      const body = init?.body;
      if (typeof body === "string") seenBody = body;
      return Promise.resolve(
        new Response(JSON.stringify({ template: ROW, updated: false }), { status: 200 }),
      );
    });
    const result = await createTemplatesAdapters(fetchFn).update(ROW.id, {
      subjectTemplate: "Reset your password",
      bodyTemplate: ROW.bodyTemplate,
      isActive: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.updated).toBe(false);
    expect(seenMethod).toBe("PATCH");
    expect(JSON.parse(seenBody)).toEqual({
      subjectTemplate: "Reset your password",
      bodyTemplate: ROW.bodyTemplate,
      isActive: true,
    });
  });

  it("rollback 交 {version};404 按内核两种 404 分说:模板没了 vs 版本没了", async () => {
    let seenBody = "";
    const fetchFn: typeof fetch = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body;
      if (typeof body === "string") seenBody = body;
      return Promise.resolve(new Response(JSON.stringify({ template: ROW }), { status: 200 }));
    });
    const ok = await createTemplatesAdapters(fetchFn).rollback(ROW.id, 1);
    expect(ok.ok).toBe(true);
    expect(JSON.parse(seenBody)).toEqual({ version: 1 });

    const versionGone = await createTemplatesAdapters(fetchJson({ error: "version_not_found" }, 404)).rollback(ROW.id, 99);
    expect(versionGone).toEqual({ ok: false, reason: "version_not_found" });
    const rowGone = await createTemplatesAdapters(fetchJson({ error: "not_found" }, 404)).rollback(ROW.id, 1);
    expect(rowGone).toEqual({ ok: false, reason: "not_found" });
  });

  it("preview 原样交回渲染结果与 missingVariables;403 说 forbidden", async () => {
    const body = {
      subject: "Reset your password, Alex",
      body: "<p>Hello Alex</p>",
      referencedVariables: ["name", "link"],
      missingVariables: ["link"],
    };
    let seenBody = "";
    const fetchFn: typeof fetch = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      const raw = init?.body;
      if (typeof raw === "string") seenBody = raw;
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    });
    const ok = await createTemplatesAdapters(fetchFn).preview({
      subjectTemplate: "Reset your password, {{name}}",
      bodyTemplate: "<p>Hello {{name}}</p>",
      vars: { name: "Alex" },
    });
    expect(ok).toEqual({ ok: true, data: body });
    expect(JSON.parse(seenBody)).toEqual({
      subjectTemplate: "Reset your password, {{name}}",
      bodyTemplate: "<p>Hello {{name}}</p>",
      vars: { name: "Alex" },
    });

    const forbidden = await createTemplatesAdapters(fetchJson({ error: "forbidden" }, 403)).preview({
      subjectTemplate: null, bodyTemplate: "b", vars: {},
    });
    expect(forbidden).toEqual({ ok: false, reason: "forbidden" });
  });
});

describe("known template types — documentation, not an enum (#225)", () => {
  it("已知类型给人话;未知类型原样——类型字段是开集,页面不装成枚举", () => {
    expect(templateTypeLabel("password_reset")).toBe("Password reset");
    expect(templateTypeLabel("custom_greeting")).toBe("custom_greeting");
    expect(KNOWN_TEMPLATE_TYPES.custom_greeting).toBeUndefined();
  });

  it("三封认证邮件都在表上,变量四件套与 resolveAuthEmail 注入的一致", () => {
    for (const known of ["email_verification", "password_reset", "account_invite"]) {
      expect(KNOWN_TEMPLATE_TYPES[known]?.variables).toEqual(["name", "email", "link", "expiry"]);
    }
  });

  it("样例值给已知变量人话,未知变量空串起手", () => {
    expect(sampleVariableValue("name")).toBe("Alex Chen");
    expect(sampleVariableValue("customer_id")).toBe("");
  });
});
