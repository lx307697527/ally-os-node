// Source-text discipline for the automations config page (jsdom-free repo:
// component behavior contracts are pinned by reading the source; the data
// layer is unit-tested in automations-client.test.ts). Prose assertions run
// against whitespace-collapsed text so line wraps never flake them.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = dirname(fileURLToPath(import.meta.url));
const page = readFileSync(join(SRC, "Automations.tsx"), "utf8");
const client = readFileSync(join(SRC, "..", "lib", "automations-client.ts"), "utf8");
const app = readFileSync(join(SRC, "..", "..", "App.tsx"), "utf8");
const rail = readFileSync(join(SRC, "..", "shell", "rail-groups.ts"), "utf8");

const collapsedPage = page.replace(/\s+/g, " ");

describe("automations page rulings (#224)", () => {
  it("路由注册在 /system/automations,System 区 rail 有一行(独占 bolt 字形)", () => {
    expect(app).toContain('<Route path="/system/automations" element={<Automations />} />');
    expect(rail).toContain('{ to: "/system/automations", label: "Automation rules", nav: "automation-rules"');
    const icons = [...rail.matchAll(/icon: "(\w+)"/g)].map((match) => match[1]);
    expect(new Set(icons).size, "no two rows share a glyph").toBe(icons.length);
  });

  it("页面的第一句话就是把纪律说在前头:保存即生效,没有发布开关", () => {
    expect(collapsedPage).toContain("Saving goes live immediately");
    expect(collapsedPage).toContain("there is no publish step");
    // 客户端也不存在草稿面:adapter 没有 drafts 调用
    expect(client).not.toContain("config-drafts");
  });

  it("每次执行留痕:runs 读面接到页面,失败重试的语义进了文案", () => {
    expect(client).toContain("/api/automations/runs");
    expect(collapsedPage).toContain("Every execution leaves a run row below");
    expect(collapsedPage).toContain("failed actions retry with backoff");
    expect(collapsedPage).toContain("Skipped rows record why the conditions said no");
  });

  it("开集 spec 不被 UI 悄悄毁掉:未知 trigger/action 形状走原样 JSON 往返", () => {
    expect(page).toContain("not drawn by this build");
    // testid 以模板字符串拼 prefix(create/edit),源码里断言模板本体(gotcha:
    // 拼好的字面量在源码中不存在)
    expect(page).toContain("automations-${prefix}-trigger-json");
    expect(page).toContain("automations-${prefix}-action-json");
    expect(client).toContain("specToDraft");
    expect(client).toContain("kind: \"json\"");
    // 编辑装填走 liberal 解析,而不是按已知形状硬拆
    expect(page).toContain("specToDraft({ trigger: rule.trigger, conditions: rule.conditions, actions: rule.actions })");
  });

  it("删除说清后果:规则没了,执行日志还在", () => {
    expect(collapsedPage).toContain("Deleting removes the rule; it cannot be re-enabled.");
    expect(collapsedPage).toContain("The run log outlives the config");
    expect(collapsedPage).toContain("Rule deleted — its run log stays on the record.");
  });

  it("每个读状态各有各的话:加载/无权限/不可达/空表,runs 同样齐", () => {
    expect(page).toContain('data-testid="automations-loading"');
    expect(page).toContain('data-testid="automations-forbidden"');
    expect(page).toContain('data-testid="automations-unavailable"');
    expect(page).toContain('data-testid="automations-empty"');
    expect(page).toContain('data-testid="automations-runs-loading"');
    expect(page).toContain('data-testid="automations-runs-forbidden"');
    expect(page).toContain('data-testid="automations-runs-unavailable"');
    expect(page).toContain('data-testid="automations-runs-empty"');
    // 无权限是整页答案:这一页没有公司级只读半边
    expect(collapsedPage).toContain("the page has no read-only half");
  });

  it("due 触发把 fail-closed 说在前头:未注册的锚点能存但永不触发", () => {
    expect(collapsedPage).toContain("an unregistered pair saves fine but never fires");
  });

  it("写失败按内核 reason 说话,编辑区分「无实效变化」与「真变更」", () => {
    expect(collapsedPage).toContain("No effective change — version");
    expect(collapsedPage).toContain("is live now, the ledger has the change");
    expect(collapsedPage).toContain("someone removed it while you were editing");
  });

  it("版本史与一键回滚走 #226 台账的 automation_rule 族", () => {
    expect(client).toContain('AUTOMATION_RULE_SUBJECT = "automation_rule"');
    expect(client).toContain("/api/config-versions/${AUTOMATION_RULE_SUBJECT}/");
    expect(page).toContain('data-testid="automations-rollback-form"');
    expect(collapsedPage).toContain("history is never rewritten");
  });
});
