// Source-text discipline for the custom-fields page (jsdom-free repo:
// component behavior contracts are pinned by reading the source; the data
// layer is unit-tested in custom-fields-client.test.ts).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = dirname(fileURLToPath(import.meta.url));
const page = readFileSync(join(SRC, "CustomFields.tsx"), "utf8");
const client = readFileSync(join(SRC, "..", "lib", "custom-fields-client.ts"), "utf8");
const app = readFileSync(join(SRC, "..", "..", "App.tsx"), "utf8");
const rail = readFileSync(join(SRC, "..", "shell", "rail-groups.ts"), "utf8");

describe("custom fields page rulings (#222)", () => {
  it("路由注册在 /system/custom-fields,System 区 rail 有一行", () => {
    expect(app).toContain('<Route path="/system/custom-fields" element={<CustomFields />} />');
    expect(rail).toContain('{ to: "/system/custom-fields", label: "Custom fields", nav: "custom-fields"');
  });

  it("第一屏把四条纪律说在前头:键是身份、编辑落新版本不改旧值、停用即离场、空角色=不限制", () => {
    expect(page).toContain("they never change after");
    expect(page).toContain("a taken key is never reused");
    expect(page).toContain("values already written keep the JSON they were written with");
    expect(page).toContain("A deactivated field disappears from forms and stops");
    expect(page).toContain("An empty role list");
    expect(page).toContain("no restriction");
  });

  it("subject 与 key 是身份:创建面板说 permanent,编辑面板不提供 subject/key 输入", () => {
    expect(page).toContain("Key (lower_snake_case, permanent)");
    const editForm = page.slice(page.indexOf('data-testid="custom-fields-edit-form"'));
    expect(editForm).not.toContain('data-testid="custom-fields-edit-key"');
    expect(editForm).not.toContain('data-testid="custom-fields-edit-subject"');
    expect(editForm).toContain("The key is permanent.");
  });

  it("customer 在字段角色词表里(与审批人词表相反):字段可以给客户看", () => {
    expect(client).toContain('FIELD_ROLES = [');
    expect(client).toMatch(/FIELD_ROLES = \[[^\]]*"customer"/s);
    expect(page).toContain("a field may be visible to");
    expect(page).toContain("the customer");
  });

  it("每个状态各有各的话:加载/无权限/不可达/空表/筛后空", () => {
    expect(page).toContain('data-testid="custom-fields-loading"');
    expect(page).toContain('data-testid="custom-fields-forbidden"');
    expect(page).toContain('data-testid="custom-fields-unavailable"');
    expect(page).toContain('data-testid="custom-fields-empty"');
    expect(page).toContain('data-testid="custom-fields-filter-empty"');
  });

  it("select 的选项规则两条路都说话:创建与编辑的 422 都指回「非空、无重复」", () => {
    expect(page).toContain("a dropdown needs a non-empty list of unique options");
  });

  it("历史与回滚:回滚是前滚新版本,历史不改写", () => {
    expect(page).toContain('data-testid="custom-fields-rollback-version"');
    expect(page).toContain("A rollback restores the chosen version's definition as a NEW");
    expect(page).toContain("the history is never rewritten");
  });
});
