// Source-text discipline for the approval-config page (jsdom-free repo:
// component behavior contracts are pinned by reading the source; the data
// layer is unit-tested in approval-config-client.test.ts).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = dirname(fileURLToPath(import.meta.url));
const page = readFileSync(join(SRC, "ApprovalConfigs.tsx"), "utf8");
const client = readFileSync(join(SRC, "..", "lib", "approval-config-client.ts"), "utf8");
const app = readFileSync(join(SRC, "..", "..", "App.tsx"), "utf8");
const rail = readFileSync(join(SRC, "..", "shell", "rail-groups.ts"), "utf8");

describe("approval lines page rulings (#221)", () => {
  it("路由注册在 /system/approvals,System 区 rail 有一行", () => {
    expect(app).toContain('<Route path="/system/approvals" element={<ApprovalConfigs />} />');
    expect(rail).toContain('{ to: "/system/approvals", label: "Approval lines", nav: "approval-lines"');
  });

  it("页面的第一句话就把三条纪律说在前头:编辑只管之后的请求、键不复用、停用线不接新单", () => {
    expect(page).toContain("requests submitted from now on");
    expect(page).toContain("requests already in flight keep the levels they were submitted with");
    expect(page).toContain("The\n          key is never reused");
    expect(page).toContain("a deactivated line\n          stops taking new submissions");
  });

  it("键是身份:创建面板说 permanent,编辑面板不提供 key/subjectType 输入", () => {
    expect(page).toContain("Key (lower_snake_case, permanent)");
    const editForm = page.slice(page.indexOf('data-testid="approval-configs-edit-form"'));
    expect(editForm).not.toContain('data-testid="approval-configs-edit-key"');
    expect(editForm).not.toContain('data-testid="approval-configs-edit-subject"');
    expect(page).toContain("The key is permanent.");
  });

  it("customer 永远不是审批人:客户端词表不提供(服务端 refine 同守)", () => {
    expect(page).toContain('APPROVAL_ROLES.map((role) => (');
    expect(client).toContain('APPROVAL_ROLES = [');
    expect(client).not.toMatch(/APPROVAL_ROLES = \[[^\]]*"customer"/);
  });

  it("每个状态各有各的话:加载/无权限/不可达/空表", () => {
    expect(page).toContain('data-testid="approval-configs-loading"');
    expect(page).toContain('data-testid="approval-configs-forbidden"');
    expect(page).toContain('data-testid="approval-configs-unavailable"');
    expect(page).toContain('data-testid="approval-configs-empty"');
  });

  it("409 撞键把「键永不复用」的出路说出来;422 说级别缺什么", () => {
    expect(page).toContain("keys are never reused. Deactivate the old line and create a new key.");
    expect(page).toContain("every level needs a name and at least one approver");
  });

  it("级别编辑器:点名人员 ∪ 角色持有人,票签带票数,签名级带含义", () => {
    // testid 由 idPrefix + 级别序号模板拼出(create/edit 两表共用同一编辑器)
    expect(page).toContain("${idPrefix}-level-name-${index}");
    expect(page).toContain("${idPrefix}-level-users-${index}");
    expect(page).toContain("${idPrefix}-level-role-${index}-${role}");
    expect(page).toContain("${idPrefix}-level-quorum-${index}");
    expect(page).toContain("${idPrefix}-level-signature-${index}");
    expect(page).toContain("${idPrefix}-level-meaning-${index}");
    expect(page).toContain('idPrefix="approval-create"');
    expect(page).toContain('idPrefix="approval-edit"');
    expect(page).toContain("Approvals needed (2–50)");
    expect(page).toContain("Require an electronic signature to approve this level");
    expect(page).toContain("Signature meaning (fixed by the line, shown to the signer)");
  });

  it("历史与回滚:回滚是前滚新版本,历史不改写", () => {
    expect(page).toContain('data-testid="approval-configs-rollback-version"');
    expect(page).toContain("A rollback restores the chosen version's definition as a NEW");
    expect(page).toContain("history is never rewritten");
  });
});
