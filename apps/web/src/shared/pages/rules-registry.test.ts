// Source-text discipline for the rules registry page (jsdom-free repo:
// component behavior contracts are pinned by reading the source; the data
// layer is unit-tested in rules-client.test.ts).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = dirname(fileURLToPath(import.meta.url));
const page = readFileSync(join(SRC, "RulesRegistry.tsx"), "utf8");
const client = readFileSync(join(SRC, "..", "lib", "rules-client.ts"), "utf8");
const app = readFileSync(join(SRC, "..", "..", "App.tsx"), "utf8");
const rail = readFileSync(join(SRC, "..", "shell", "rail-groups.ts"), "utf8");

describe("rules registry page rulings (#233)", () => {
  it("路由注册在 /system/rules,System 区 rail 有一行", () => {
    expect(app).toContain('<Route path="/system/rules" element={<RulesRegistry />} />');
    expect(rail).toContain('{ to: "/system/rules", label: "Rules registry", nav: "rules-registry" }');
  });

  it("无「新建」面:硬底线在代码里,规则随裁决进场,不由页面造", () => {
    expect(page).toContain("no rule can be created from this page");
    expect(page).toContain("rules arrive with their");
    expect(page).not.toContain('data-testid="rules-create');
    expect(page).not.toContain("New rule");
  });

  it("无草稿面:registry_rule 族对草稿答 409,页面只有台账史与回滚", () => {
    expect(client).not.toContain("config-drafts");
    expect(client).not.toContain("/publish");
    expect(page.replace(/\s+/g, " ")).toContain("One-click rollback");
    expect(page.replace(/\s+/g, " ")).toContain("history is never rewritten");
  });

  it("每次改动必须带依据:refs 逐行至少一条,否则不发请求", () => {
    expect(page).toContain('data-testid="rules-edit-refs"');
    expect(page).toContain("A change must cite its basis");
    expect(page).toContain("parseRefs(refsText)");
  });

  it("服务端是唯一权威:403 的角色与 400 的 issues 原样说话,不翻译成一句「无权」", () => {
    expect(page).toContain("result.roles.join(\", \")");
    expect(page).toContain('data-testid="rules-change-issues"');
    expect(client).toContain("issuesFrom(res.raw)");
    expect(client).toContain("rolesFrom(res.raw)");
  });

  it("决策表按表格画:先行后列,画不出回退原始 JSON,空表=fail closed 说清楚", () => {
    expect(page).toContain("parseDecisionTableDisplay(value)");
    expect(page).toContain('data-testid="rules-decision-table"');
    expect(page.replace(/\s+/g, " ")).toContain("fails closed until a row");
    expect(page).toContain("display never");
    expect(client).toContain("export function parseDecisionTableDisplay(");
  });

  it("决策表在网格编辑器里作成(#233 JDM 编辑器),JSON 是显式逃生口,两边过服务端同一道门", () => {
    expect(page).toContain('data-testid="rules-edit-table-face"');
    expect(page).toContain('data-testid="rules-edit-mode-grid"');
    expect(page).toContain('data-testid="rules-edit-mode-json"');
    expect(page).toContain("switchToGridEditor");
    expect(page).toContain("switchToJsonEditor");
    expect(page).toContain("<DecisionTableEditor");
    expect(page.replace(/\s+/g, " ")).toContain("server compiles every cell either way");
  });

  it("网格提交先过客户端结构闸:serialize 不过不发请求,issues 原样亮出", () => {
    expect(page).toContain("serializeTableDraft(tableDraft)");
    expect(page.replace(/\s+/g, " ")).toContain("The table cannot be saved yet:");
    // 服务器仍是唯一权威:编译探针逐格错误沿 issues 面板原样说话
    expect(page).toContain('data-testid="rules-change-issues"');
  });

  it("逐格错误穿到格子上:同一份 issues 喂定位器,坐标随编辑器走,面板照旧保留原话", () => {
    expect(page).toContain("locateTableCellIssues(changeIssues");
    expect(page).toContain("cellIssueKey(");
    expect(page.replace(/\s+/g, " ")).toContain("cellIssues={tableCellIssues}");
  });

  it("画不出的值退回 JSON 模式:打开表单按值定型,网格不假装什么都能画", () => {
    expect(page).toContain("formatTableDraft(rule.value)");
    expect(page).toContain('grid === null ? "json" : "grid"');
    expect(page).toContain("not shaped like a decision table");
    expect(page).toContain("emptyTableDraft()");
  });

  it("定时生效:值先落行,worker 到点前滚——页面不假装立即生效", () => {
    expect(page).toContain('data-testid="rules-scheduled"');
    expect(page.replace(/\s+/g, " ")).toContain("worker applies it when due");
    expect(page).toContain("until then the current value stays live");
  });

  it("开关启用过 enableBy 门:表单一开头就把「谁能确认」说出来", () => {
    expect(page).toContain("needs the enable-by confirmation");
    expect(page).toContain("owner always");
  });

  it("每个状态各有各的话:加载/不可达/空表/筛选空/史被拒", () => {
    expect(page).toContain('data-testid="rules-loading"');
    expect(page).toContain('data-testid="rules-unavailable"');
    expect(page).toContain('data-testid="rules-empty"');
    expect(page).toContain('data-testid="rules-filter-empty"');
    expect(page).toContain('data-testid="rules-history-forbidden"');
  });

  it("回滚自留审计:恢复版被记为新版,历史不改写", () => {
    expect(page.replace(/\s+/g, " ")).toContain("recorded as a new version");
    expect(page.replace(/\s+/g, " ")).toContain("the rollback itself is audited");
    expect(page).toContain("Rolled back to v");
  });

  it("值渲染按类型走,待填是明确的状态而非空白", () => {
    expect(page).toContain('data-testid="rules-value-pending"');
    expect(page).toContain("Pending fill-in — this rule is on record but has no value yet");
    expect(page).toContain("RuleValueDisplay");
  });

  it("列表筛选(文本/类别/待填)走 client 的纯函数,可单测", () => {
    expect(page).toContain("filterRules(rules, filters)");
    expect(client).toContain("export function filterRules(");
  });
});
