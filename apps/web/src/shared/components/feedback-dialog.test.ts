// Source-text discipline for the feedback dialog (jsdom-free repo). The pure
// layer is unit-tested in feedback-draft.test.ts / feedback-client.test.ts;
// this file pins the form's structural rulings.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = dirname(fileURLToPath(import.meta.url));
const dialog = readFileSync(join(SRC, "FeedbackDialog.tsx"), "utf8");
const client = readFileSync(join(SRC, "..", "lib", "feedback-client.ts"), "utf8");

describe("FeedbackDialog rulings (#129 slice 4)", () => {
  it("提交前先过纯校验层，有问题不发请求", () => {
    expect(dialog).toMatch(/feedbackDraftProblems\(draft\)/);
    expect(dialog).toMatch(/if \(found\.length > 0\) return;/);
  });

  it("steps 仅 bug 报告显示（显隐规则在 draft 词表上）", () => {
    expect(dialog).toMatch(/draft\.type === "bug_report"[\s\S]*fb-field-steps/);
  });

  it("成功态亮 BR- 编号回执；表单消失", () => {
    expect(dialog).toContain('sentNumber !== null');
    expect(dialog).toContain("fb-number");
    expect(dialog).toContain("fb-done");
  });

  it("busy 期间不可重复提交", () => {
    expect(dialog).toMatch(/if \(busy\) return;/);
    expect(dialog).toContain('disabled={busy}');
  });

  it("submitFeedback 永不把异常抛进事件处理器", () => {
    expect(client).toContain("catch");
    expect(client).toContain("SubmitFeedbackResult");
  });

  it("对话框手骑 dialog 配方（ModalFrame 未移植），可关闭", () => {
    expect(dialog).toContain("bg-scrim");
    expect(dialog).toContain("fb-close");
  });
});
