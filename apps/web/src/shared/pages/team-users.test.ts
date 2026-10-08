// Source-text discipline for the team page (#26) (jsdom-free repo: component
// behavior contracts are pinned by reading the source; the data layer is
// unit-tested in users-client.test.ts).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = dirname(fileURLToPath(import.meta.url));
const page = readFileSync(join(SRC, "TeamUsers.tsx"), "utf8");
const client = readFileSync(join(SRC, "..", "lib", "users-client.ts"), "utf8");
const approvalClient = readFileSync(join(SRC, "..", "lib", "approval-config-client.ts"), "utf8");
const app = readFileSync(join(SRC, "..", "..", "App.tsx"), "utf8");
const rail = readFileSync(join(SRC, "..", "shell", "rail-groups.ts"), "utf8");

describe("team page rulings (#26)", () => {
  it("路由注册在 /system/team,System 区 rail 有一行", () => {
    expect(app).toContain('<Route path="/system/team" element={<TeamUsers />} />');
    expect(rail).toContain('{ to: "/system/team", label: "Team", nav: "team-users" }');
  });

  it("第一屏把三条纪律说在前头:创建邮件激活链接、停用即登出且不删除、特权角色走 owner 审批", () => {
    expect(page).toContain("cannot sign in until its password is");
    expect(page).toContain("signs the person out everywhere");
    expect(page).toContain("never deleted");
    // 断言挑行内短语:JSX 源码的换行会把整句切开,跨行子串永远红
    expect(page).toContain("privileged roles (owner, admin, finance) need the");
  });

  it("创建面的角色勾选来自 INVITE_ROLES(11 个),特权角色的复选框根本不存在", () => {
    expect(client).toContain("export const INVITE_ROLES = APPROVAL_ROLES.filter");
    // 页面创建表单只迭代 INVITE_ROLES;授予下拉才迭代 STAFF_ROLES
    const createForm = page.slice(page.indexOf('data-testid="team-create-form"'));
    expect(createForm).toContain("INVITE_ROLES.map");
    expect(createForm).not.toContain("STAFF_ROLES.map");
    expect(page).toContain("STAFF_ROLES.filter((role) => !row.roles.includes(role))");
  });

  it("角色词表与审批编辑器同一份(不抄第二份清单)", () => {
    expect(client).toContain("import { APPROVAL_ROLES } from \"./approval-config-client.ts\"");
    expect(approvalClient).toContain("export const APPROVAL_ROLES = [");
  });

  it("每个状态各有各的话:加载/无权限/不可达/空表", () => {
    expect(page).toContain('data-testid="team-users-loading"');
    expect(page).toContain('data-testid="team-users-forbidden"');
    expect(page).toContain('data-testid="team-users-unavailable"');
    expect(page).toContain('data-testid="team-users-empty"');
  });

  it("写失败的每种结局都按内核给的 reason 说话:owner_required、self、审批在飞、需 owner 审批", () => {
    expect(page).toContain("The owner's account can only be disabled or re-enabled by the owner.");
    expect(page).toContain("You cannot disable your own account while signed in.");
    expect(page).toContain("is already waiting for the owner");
    expect(page).toContain("needs the owner's approval");
    expect(page).toMatch(/reason === "unavailable"\s*\?\s*"The change could not be saved/);
  });

  it("停用与启用是两个动词按钮,自己也标出来(服务端 409 的样子在页面上可预期)", () => {
    expect(page).toContain('data-testid={`team-disable-${row.id}`}');
    expect(page).toContain('data-testid={`team-enable-${row.id}`}');
    expect(page).toContain("(you)");
  });
});
