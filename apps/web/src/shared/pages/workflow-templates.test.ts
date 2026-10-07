// Source-text discipline for the workflow config page (jsdom-free repo:
// component behavior contracts are pinned by reading the source; the data
// layer is unit-tested in workflow-client.test.ts and the parser/layout in
// workflow-diagram.test.ts).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = dirname(fileURLToPath(import.meta.url));
const page = readFileSync(join(SRC, "WorkflowTemplates.tsx"), "utf8");
const diagram = readFileSync(join(SRC, "..", "components", "WorkflowDiagram.tsx"), "utf8");
const client = readFileSync(join(SRC, "..", "lib", "workflow-client.ts"), "utf8");
const parser = readFileSync(join(SRC, "..", "lib", "workflow-diagram.ts"), "utf8");
const app = readFileSync(join(SRC, "..", "..", "App.tsx"), "utf8");
const rail = readFileSync(join(SRC, "..", "shell", "rail-groups.ts"), "utf8");

describe("workflow templates page rulings (#220)", () => {
  it("路由注册在 /system/workflows,System 区 rail 有一行", () => {
    expect(app).toContain('<Route path="/system/workflows" element={<WorkflowTemplates />} />');
    expect(rail).toContain(
      '{ to: "/system/workflows", label: "Workflow templates", nav: "workflow-templates" }',
    );
  });

  it("页面的第一句话就是把纪律说在前头:在飞实例持有启动时的定义", () => {
    expect(page).toContain("keeps the definition");
    expect(page).toContain("it started with");
    expect(page).toContain("flows started from now on");
  });

  it("身份不可改:编辑面板没有 templateKey/subjectType 的输入,并说出口", () => {
    expect(page).toContain("cannot change here");
    const editForm = page.slice(page.indexOf('data-testid="workflow-edit-form"'));
    expect(editForm).not.toContain('data-testid="workflow-edit-key"');
    expect(editForm).not.toContain('data-testid="workflow-edit-subject"');
  });

  it("每个状态各有各的话:加载/无权限/不可达/空表", () => {
    expect(page).toContain('data-testid="workflow-templates-loading"');
    expect(page).toContain('data-testid="workflow-templates-forbidden"');
    expect(page).toContain('data-testid="workflow-templates-unavailable"');
    expect(page).toContain('data-testid="workflow-templates-empty"');
  });

  it("写失败的每种结局都按内核给的 reason 说话,含默认撞车与 422 明细", () => {
    expect(page).toContain("make that one non-default first");
    expect(page).toContain("The definition was refused");
    // invalid 带 detail 时原文透出——引擎的四门话是操作者改 JSON 的依据
    expect(page).toMatch(/reason === "invalid" \? invalidMessage\(result\.detail\)/);
    expect(client).toContain('"default_template_exists"');
  });

  it("编辑与新建都画实时预览:预览画得出来说的是形状,保存的权威在服务端四门", () => {
    expect(page).toContain("Preview — what the server would store:");
    expect(page).toContain("Not valid JSON yet:");
    expect(page).toContain("Not renderable yet:");
    // 预览走 parse + layout 的纯链路,与详情视图同一渲染路径
    expect(page).toContain("parseDraft(");
    expect(diagram).toContain("export function WorkflowDiagram(");
    expect(parser).toContain("export function layoutWorkflowDiagram(");
  });

  it("创建表单的 subject type 是开集:业务域未进场也能先把流程配好", () => {
    expect(page).toContain('placeholder="lead, opportunity, …"');
    expect(page).not.toContain("workflow-create-subject-select");
  });
});
