// Source-text discipline for the decision-table grid editor (jsdom-free repo:
// component behavior contracts are pinned by reading the source; the pure
// layer it delegates to is unit-tested in rules-client.test.ts).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = dirname(fileURLToPath(import.meta.url));
const editor = readFileSync(join(SRC, "DecisionTableEditor.tsx"), "utf8");
const client = readFileSync(join(SRC, "..", "lib", "rules-client.ts"), "utf8");

describe("decision-table grid editor rulings (#233 JDM editor)", () => {
  it("所有表格手术走 rules-client 纯函数:组件只做接线,改动可离 DOM 单测", () => {
    for (const op of [
      "addTableColumn(",
      "removeTableColumn(",
      "patchTableColumn(",
      "addTableRow(",
      "removeTableRow(",
      "moveTableRow(",
      "moveTableColumn(",
      "setTableCell(",
    ]) {
      expect(editor).toContain(op);
    }
    expect(client).toContain("export function moveTableRow(");
    expect(client).toContain("export function serializeTableDraft(");
  });

  it("拖拽只从手柄发起:行/列单元格的输入不被拖拽劫持;跨类拖动在纯函数层被拒", () => {
    // draggable 只出现在手柄 span 上,绝不落在整行/整列
    const draggableCount = editor.split("draggable").length - 1;
    expect(draggableCount).toBe(2);
    expect(editor).toContain('data-testid="rules-edit-table-row-handle"');
    expect(editor).toContain('data-testid="rules-edit-table-col-handle"');
    // 列拖拽跨 kind 直接忽略(inputs 永远越不进 outputs)
    expect(editor).toContain("dragged?.kind !== target?.kind");
    // first 命中策略下行序即路由序:拖拽换位走 moveTableRow
    expect(editor.replace(/\s+/g, " ")).toContain(
      "row order is the routing order",
    );
  });

  it("单元格以稳定句柄为键,永不以可编辑的列 id 为键——改名不会在击键中途搬走单元格", () => {
    expect(client).toContain("key: string");
    expect(editor).toContain("setTableCell(draft, row.key, column.key");
    expect(editor).not.toContain("cells[column.id]");
  });

  it("空单元格语义说人话:输入空=恒真,输出空=不产出;编译权威在服务端", () => {
    expect(editor.replace(/\s+/g, " ")).toContain("an empty input cell is always true");
    expect(editor.replace(/\s+/g, " ")).toContain("an empty output cell produces nothing");
    expect(editor.replace(/\s+/g, " ")).toContain("The server compiles every cell on save.");
  });

  it("最后一个输出列不可删:一张没有产出的表不是表", () => {
    expect(editor).toContain("lastOutputKey");
    expect(editor.replace(/\s+/g, " ")).toContain(
      "A table needs at least one output column",
    );
  });

  it("行删列随之删格;空表状态自己开口说 fail closed", () => {
    expect(client.replace(/\s+/g, " ")).toContain(
      "Removes a column and every cell keyed by it",
    );
    expect(editor).toContain('data-testid="rules-edit-table-empty"');
    expect(editor.replace(/\s+/g, " ")).toContain(
      "an empty table matches nothing",
    );
  });

  it("hit policy 面向编辑者:first 与 collect 语义各说清楚", () => {
    expect(editor).toContain('data-testid="rules-edit-table-policy"');
    expect(editor).toContain("first — first matching row wins");
    expect(editor).toContain("collect — every matching row");
  });
});
