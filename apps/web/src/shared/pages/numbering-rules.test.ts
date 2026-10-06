// Source-text discipline for the numbering config page (jsdom-free repo:
// component behavior contracts are pinned by reading the source; the data
// layer is unit-tested in numbering-client.test.ts).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = dirname(fileURLToPath(import.meta.url));
const page = readFileSync(join(SRC, "NumberingRules.tsx"), "utf8");
const client = readFileSync(join(SRC, "..", "lib", "numbering-client.ts"), "utf8");
const app = readFileSync(join(SRC, "..", "..", "App.tsx"), "utf8");
const rail = readFileSync(join(SRC, "..", "shell", "rail-groups.ts"), "utf8");

describe("numbering rules page rulings (#225)", () => {
  it("路由注册在 /system/numbering,System 区 rail 有一行", () => {
    expect(app).toContain('<Route path="/system/numbering" element={<NumberingRules />} />');
    expect(rail).toContain('{ to: "/system/numbering", label: "Numbering rules", nav: "numbering-rules"');
  });

  it("页面的第一句话就是把纪律说在前头:改格式只影响之后发出的号", () => {
    expect(page).toContain("documents issued from now on");
    expect(page).toContain("issued numbers never change");
  });

  it("startNumber 不可改:编辑面板不提供该输入,改说重开系列的路", () => {
    expect(page).toContain("The start number is");
    expect(page).toContain("deactivate this rule and create a");
    // 编辑面板只有这五个受控字段,没有 start number 的 input
    const editForm = page.slice(page.indexOf('data-testid="numbering-edit-form"'));
    expect(editForm).not.toContain('data-testid="numbering-edit-start"');
  });

  it("每个状态各有各的话:加载/无权限/不可达/空表/注册表空", () => {
    expect(page).toContain('data-testid="numbering-rules-loading"');
    expect(page).toContain('data-testid="numbering-rules-forbidden"');
    expect(page).toContain('data-testid="numbering-rules-unavailable"');
    expect(page).toContain('data-testid="numbering-rules-empty"');
    expect(page).toContain('data-testid="numbering-subjects-empty"');
  });

  it("写失败的每种结局都按内核给的 reason 说话,含 409 撞生效规则", () => {
    expect(page).toContain("An active rule already exists for this document type");
    expect(page).toContain("Another active rule already exists for this document type");
    expect(page).toMatch(/reason === "unavailable"\s*\?\s*"The change could not be saved/);
  });

  it("下一号预览走 client 的渲染器,与服务器发号的形状一致", () => {
    expect(page).toContain("previewNumber(");
    expect(client).toContain("export function previewNumber(");
    expect(client).toContain("getUTCFullYear");
  });
});
