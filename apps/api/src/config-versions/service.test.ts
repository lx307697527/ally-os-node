import { describe, expect, it } from "vitest";
import { diffSnapshots, jsonEqual, topLevelChanges } from "./service.ts";

// 纯函数单测：差异引擎（读面 diff 端点与回滚 no-op 判定共用 jsonEqual）。
// 数组是有序整体（逐项对位不归差异引擎管），对象按字典序稳定展开。

describe("jsonEqual", () => {
  it("compares JSON values structurally, independent of key order", () => {
    expect(jsonEqual({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true);
    expect(jsonEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(jsonEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(jsonEqual([1, 2], [2, 1])).toBe(false);
    expect(jsonEqual(null, false)).toBe(false);
    expect(jsonEqual(0, false)).toBe(false);
  });
});

describe("topLevelChanges", () => {
  it("summarizes top-level field drift as from/to pairs", () => {
    expect(
      topLevelChanges(
        { name: "old", trigger: { action: "a" }, enabled: true },
        { name: "new", trigger: { action: "b" }, enabled: true },
      ),
    ).toEqual({
      name: { from: "old", to: "new" },
      trigger: { from: { action: "a" }, to: { action: "b" } },
    });
  });

  it("covers added and removed keys with null on the absent side", () => {
    expect(topLevelChanges({ keep: 1, gone: 2 }, { keep: 1, added: 3 })).toEqual({
      gone: { from: 2, to: null },
      added: { from: null, to: 3 },
    });
  });
});

describe("diffSnapshots", () => {
  it("expands nested objects into dot paths and treats arrays as leaves", () => {
    expect(
      diffSnapshots(
        { definition: { states: { a: { on: { GO: "b" } } }, initial: "a" }, tags: [1, 2] },
        { definition: { states: { a: { on: { GO: "c" } } }, initial: "a" }, tags: [1, 3] },
      ),
    ).toEqual([
      { path: "definition.states.a.on.GO", from: "b", to: "c" },
      { path: "tags", from: [1, 2], to: [1, 3] },
    ]);
  });

  it("reports added and removed subtrees with null on the absent side", () => {
    expect(diffSnapshots({ a: { b: 1 } }, { a: { c: 2 } })).toEqual([
      { path: "a.b", from: 1, to: null },
      { path: "a.c", from: null, to: 2 },
    ]);
  });

  it("reports type changes (object to scalar) as one leaf change", () => {
    expect(diffSnapshots({ a: { b: 1 } }, { a: 5 })).toEqual([{ path: "a", from: { b: 1 }, to: 5 }]);
    expect(diffSnapshots({}, {})).toEqual([]);
    expect(diffSnapshots({ a: 1 }, { a: 1 })).toEqual([]);
  });
});
