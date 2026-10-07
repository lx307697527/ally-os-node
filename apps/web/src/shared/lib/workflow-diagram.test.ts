// The definition parser and diagram layout, asserted as pure functions —
// same discipline as numbering-client.test.ts: no DOM, every ruling
// reproducible from the module's own outputs. The server's engine
// (apps/api/src/workflow/engine.ts) is the authority on what a definition
// IS; this side only needs to render what the engine accepts and to fail
// LOUD (never render a lie) on what it would reject.
import { describe, expect, it } from "vitest";

import {
  layoutWorkflowDiagram,
  parseWorkflowDefinition,
  type WorkflowModel,
} from "./workflow-diagram.ts";

const LEAD_FLOW = {
  initial: "new",
  states: {
    new: { on: { CONTACT: "contacted", DISQUALIFY: "disqualified" } },
    contacted: { on: { QUALIFY: "qualified" } },
    qualified: {},
    disqualified: {},
  },
};

function must<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("unexpected missing value in test");
  return value;
}

function mustModel(raw: unknown): WorkflowModel {
  const parsed = parseWorkflowDefinition(raw);
  if (!parsed.ok) throw new Error(`unexpected parse failure: ${parsed.error}`);
  return parsed.model;
}

describe("parseWorkflowDefinition (#220 diagram)", () => {
  it("normalizes both transition forms the engine accepts", () => {
    const model = mustModel({
      initial: "new",
      states: {
        new: { on: { CONTACT: "contacted", ESCALATE: { target: "escalated", requireNote: true } } },
        contacted: {},
        escalated: {},
      },
    });
    const newState = model.states.find((state) => state.name === "new");
    expect(newState?.transitions).toEqual([
      { event: "CONTACT", target: "contacted", roles: [], gateNames: [], requireNote: false },
      { event: "ESCALATE", target: "escalated", roles: [], gateNames: [], requireNote: true },
    ]);
  });

  it("extracts the constraint facts per transition: roles, gate names, note", () => {
    const model = mustModel({
      initial: "draft",
      states: {
        draft: {
          on: {
            SUBMIT: {
              target: "in_review",
              roles: ["sales_lead", "admin"],
              requireNote: true,
              gates: [{ name: "deposit_paid", config: { withinDays: 30 } }, { name: "contract_signed" }],
            },
          },
        },
        in_review: {},
      },
    });
    expect(model.states[0]?.transitions[0]).toEqual({
      event: "SUBMIT",
      target: "in_review",
      roles: ["sales_lead", "admin"],
      gateNames: ["deposit_paid", "contract_signed"],
      requireNote: true,
    });
  });

  it("carries per-state facts: initial flag, timeout, entry action names", () => {
    const model = mustModel({
      initial: "new",
      states: {
        new: { timeoutAfterHours: 48, entryActions: [{ name: "notify_owner" }], on: { GO: "done" } },
        done: {},
      },
    });
    expect(model.initial).toBe("new");
    const newState = model.states.find((state) => state.name === "new");
    expect(newState?.isInitial).toBe(true);
    expect(newState?.timeoutAfterHours).toBe(48);
    expect(newState?.entryActionNames).toEqual(["notify_owner"]);
    const done = model.states.find((state) => state.name === "done");
    expect(done?.isInitial).toBe(false);
    expect(done?.timeoutAfterHours).toBeUndefined();
  });

  it("states come back sorted by name so rendering never depends on jsonb key order", () => {
    const model = mustModel(LEAD_FLOW);
    expect(model.states.map((state) => state.name)).toEqual([
      "contacted",
      "disqualified",
      "new",
      "qualified",
    ]);
    expect(model.initial).toBe("new");
  });

  it("is liberal in what it accepts: unknown keys survive for future server fields", () => {
    const model = mustModel({
      initial: "new",
      states: {
        new: { on: { GO: { target: "done", someday: "maybe" } }, note: "future" },
        done: {},
      },
    });
    expect(model.states).toHaveLength(2);
  });

  it("fails loud on what the engine would reject: dangling initial, unknown target, self-loop", () => {
    expect(parseWorkflowDefinition({ initial: "ghost", states: { new: {} } }).ok).toBe(false);
    expect(
      parseWorkflowDefinition({ initial: "new", states: { new: { on: { GO: "ghost" } } } }).ok,
    ).toBe(false);
    expect(
      parseWorkflowDefinition({ initial: "new", states: { new: { on: { GO: "new" } } } }).ok,
    ).toBe(false);
    expect(parseWorkflowDefinition({ initial: "new", states: {} }).ok).toBe(false);
    expect(parseWorkflowDefinition(null).ok).toBe(false);
    expect(parseWorkflowDefinition("nope").ok).toBe(false);
    expect(
      parseWorkflowDefinition({ initial: "New", states: { New: {} } }).ok,
    ).toBe(false);
  });
});

describe("layoutWorkflowDiagram (#220 diagram)", () => {
  it("layers by hops from the initial state; within a layer, alphabetical", () => {
    const layout = layoutWorkflowDiagram(mustModel(LEAD_FLOW));
    const layerOf = new Map(layout.nodes.map((node) => [node.name, node.layer]));
    expect(layerOf.get("new")).toBe(0);
    expect(layerOf.get("contacted")).toBe(1);
    expect(layerOf.get("disqualified")).toBe(1);
    expect(layerOf.get("qualified")).toBe(2);
    // Nodes read layer by layer, name by name.
    expect(layout.nodes.map((node) => node.name)).toEqual([
      "new",
      "contacted",
      "disqualified",
      "qualified",
    ]);
  });

  it("nodes never overlap and the canvas contains every node", () => {
    const layout = layoutWorkflowDiagram(mustModel(LEAD_FLOW));
    for (const node of layout.nodes) {
      expect(node.x).toBeGreaterThanOrEqual(0);
      expect(node.y).toBeGreaterThanOrEqual(0);
      expect(node.x + node.width).toBeLessThanOrEqual(layout.width);
      expect(node.y + node.height).toBeLessThanOrEqual(layout.height);
    }
    for (let i = 0; i < layout.nodes.length; i++) {
      for (let j = i + 1; j < layout.nodes.length; j++) {
        const a = layout.nodes[i];
        const b = layout.nodes[j];
        if (a === undefined || b === undefined) throw new Error("unexpected sparse nodes");
        const overlaps =
          a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
        expect(overlaps, `${a.name} overlaps ${b.name}`).toBe(false);
      }
    }
  });

  it("deeper layers sit to the right: x is monotonic in layer", () => {
    const layout = layoutWorkflowDiagram(mustModel(LEAD_FLOW));
    const byLayer = new Map<number, number>();
    for (const node of layout.nodes) {
      const seen = byLayer.get(node.layer);
      if (seen === undefined) {
        byLayer.set(node.layer, node.x);
      } else {
        expect(node.x).toBe(seen);
      }
    }
    const layers = [...byLayer.keys()].sort((a, b) => a - b);
    for (let i = 1; i < layers.length; i++) {
      const left = must(byLayer.get(must(layers[i - 1])));
      const right = must(byLayer.get(must(layers[i])));
      expect(right).toBeGreaterThan(left + 100);
    }
  });

  it("a forward edge runs from the source's right side to the target's left side", () => {
    const layout = layoutWorkflowDiagram(mustModel(LEAD_FLOW));
    const edge = layout.edges.find((candidate) => candidate.event === "CONTACT");
    expect(edge?.from).toBe("new");
    expect(edge?.to).toBe("contacted");
    const source = layout.nodes.find((node) => node.name === "new");
    const target = layout.nodes.find((node) => node.name === "contacted");
    expect(edge?.path.startsWith("M")).toBe(true);
    // The path's two endpoints sit at the boxes' right and left midlines.
    expect(edge?.path).toContain(String((source?.y ?? 0) + (source?.height ?? 0) / 2));
    expect(edge?.path).toContain(String((target?.y ?? 0) + (target?.height ?? 0) / 2));
  });

  it("parallel transitions between the same pair ride separate lanes", () => {
    const layout = layoutWorkflowDiagram(
      mustModel({
        initial: "a",
        states: { a: { on: { FAST: "b", SLOW: "b" } }, b: {} },
      }),
    );
    const lanes = layout.edges.filter((edge) => edge.from === "a" && edge.to === "b");
    expect(lanes).toHaveLength(2);
    expect(new Set(lanes.map((edge) => edge.path)).size).toBe(2);
    expect(new Set(lanes.map((edge) => edge.labelY)).size).toBe(2);
  });

  it("a back edge routes beneath the boxes, not through them", () => {
    const layout = layoutWorkflowDiagram(
      mustModel({
        initial: "new",
        states: {
          new: { on: { CONTACT: "contacted" } },
          contacted: { on: { BACK: "new", QUALIFY: "qualified" } },
          qualified: {},
        },
      }),
    );
    const back = layout.edges.find((edge) => edge.event === "BACK");
    expect(back).toBeDefined();
    const involved = layout.nodes.filter(
      (node) => node.name === "new" || node.name === "contacted",
    );
    const lowestBottom = Math.max(...involved.map((node) => node.y + node.height));
    // Every y coordinate the back edge's path mentions stays below both boxes.
    const ys = (back?.path.match(/[-0-9.]+/g) ?? [])
      .map(Number)
      .filter((_, index) => index % 2 === 1);
    for (const y of ys) {
      expect(y).toBeGreaterThanOrEqual(lowestBottom);
    }
  });

  it("cycles terminate and stay deterministic: same input, same output", () => {
    const cyclic = {
      initial: "new",
      states: {
        new: { on: { CONTACT: "contacted" } },
        contacted: { on: { WAIT: "waiting" } },
        waiting: { on: { RESUME: "contacted" } },
      },
    };
    const first = layoutWorkflowDiagram(mustModel(cyclic));
    const second = layoutWorkflowDiagram(mustModel(cyclic));
    expect(first).toEqual(second);
    expect(first.nodes).toHaveLength(3);
  });

  it("edges sort by source node order, then event name", () => {
    const layout = layoutWorkflowDiagram(mustModel(LEAD_FLOW));
    expect(layout.edges.map((edge) => `${edge.from}:${edge.event}`)).toEqual([
      "new:CONTACT",
      "new:DISQUALIFY",
      "contacted:QUALIFY",
    ]);
  });

  it("a lone state renders as one box with a usable canvas", () => {
    const layout = layoutWorkflowDiagram(mustModel({ initial: "new", states: { new: {} } }));
    expect(layout.nodes).toHaveLength(1);
    expect(layout.edges).toHaveLength(0);
    expect(layout.width).toBeGreaterThan(0);
    expect(layout.height).toBeGreaterThan(0);
  });
});
