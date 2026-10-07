// The workflow definition, read for RENDERING (#220's config-studio face).
// The server's engine (apps/api/src/workflow/engine.ts) is the authority on
// what a definition is — it validates topology, reachability and block
// existence at save time. This module is the web's read-side twin: it
// normalizes the two transition forms the engine accepts (XState string
// shorthand and the constraint object) into one shape the diagram can draw,
// and it fails loud — a definition this side cannot understand renders as an
// error line, never as a plausible-looking half-truth.
//
// Deliberately liberal in one direction only: unknown KEYS are ignored, not
// rejected, so a template saved by a newer server (new optional fields)
// still renders its known facts. Structure the engine rejects (dangling
// initial, unknown target, self-loop) fails here too — the server should
// never have stored it, and if it somehow did the operator must see that.
//
// The structural walk below is HAND-ROLLED on purpose: the definition is
// small, the failures deserve per-field sentences an operator can act on
// (a zod shape error flattens them into one line), and unknown keys must be
// tolerated rather than stripped-into-a-generic-error. The workflow-client
// uses zod for the response envelopes, where the composition is flat and a
// schema earns its keep.

const STATE_NAME = /^[a-z][a-z0-9_]*$/;
const EVENT_NAME = /^[A-Z][A-Z0-9_]*$/;

export interface DiagramTransition {
  event: string;
  target: string;
  /** Empty = unrestricted (visible staff can push; the kernel's floor holds). */
  roles: readonly string[];
  gateNames: readonly string[];
  requireNote: boolean;
}

export interface DiagramState {
  name: string;
  isInitial: boolean;
  timeoutAfterHours?: number;
  entryActionNames: readonly string[];
  transitions: readonly DiagramTransition[];
}

export interface WorkflowModel {
  initial: string;
  /** Sorted by name — rendering never depends on jsonb key order. */
  states: readonly DiagramState[];
}

export type ParseResult =
  | { ok: true; model: WorkflowModel }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A named block reference ({ name, config? }); the config payload is
 *  owner-domain data the diagram never renders, so it passes unchecked. */
function blockNames(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const names: string[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.name !== "string" || entry.name === "") return null;
    names.push(entry.name);
  }
  return names;
}

function parseTransition(
  name: string,
  event: string,
  shape: unknown,
): DiagramTransition | string {
  let target: string;
  let roles: readonly string[] = [];
  let gateNames: readonly string[] = [];
  let requireNote = false;
  if (typeof shape === "string") {
    target = shape;
  } else if (isRecord(shape)) {
    if (typeof shape.target !== "string") {
      return `"${name}" --${event}--> has no target state`;
    }
    target = shape.target;
    if (shape.roles !== undefined) {
      if (
        !Array.isArray(shape.roles) ||
        shape.roles.some((role) => typeof role !== "string")
      ) {
        return `"${name}" --${event}--> has malformed roles`;
      }
      roles = shape.roles;
    }
    if (shape.gates !== undefined) {
      const names = blockNames(shape.gates);
      if (names === null) {
        return `"${name}" --${event}--> has malformed gates`;
      }
      gateNames = names;
    }
    if (shape.requireNote !== undefined) {
      if (typeof shape.requireNote !== "boolean") {
        return `"${name}" --${event}--> has a malformed requireNote`;
      }
      requireNote = shape.requireNote;
    }
  } else {
    return `"${name}" --${event}--> is not a state name or a transition object`;
  }
  return { event, target, roles, gateNames, requireNote };
}

export function parseWorkflowDefinition(raw: unknown): ParseResult {
  if (!isRecord(raw)) {
    return { ok: false, error: "the definition is not an object" };
  }
  const { initial, states } = raw;
  if (typeof initial !== "string") {
    return { ok: false, error: "the definition has no initial state name" };
  }
  if (!isRecord(states)) {
    return { ok: false, error: "the definition has no states object" };
  }
  if (!STATE_NAME.test(initial)) {
    return { ok: false, error: `initial state name "${initial}" must be lower_snake_case` };
  }
  for (const name of Object.keys(states)) {
    if (!STATE_NAME.test(name)) {
      return { ok: false, error: `state name "${name}" must be lower_snake_case` };
    }
  }
  if (Object.keys(states).length === 0) {
    return { ok: false, error: "template has no states" };
  }
  const stateNames = new Set(Object.keys(states));
  if (!(initial in states)) {
    return { ok: false, error: `initial state "${initial}" is not defined` };
  }
  const model: { initial: string; states: DiagramState[] } = { initial, states: [] };
  for (const [name, stateValue] of Object.entries(states)) {
    if (!isRecord(stateValue)) {
      return { ok: false, error: `state "${name}" is not an object` };
    }
    let timeoutAfterHours: number | undefined;
    if (stateValue.timeoutAfterHours !== undefined) {
      const rawTimeout = stateValue.timeoutAfterHours;
      if (typeof rawTimeout !== "number" || !Number.isFinite(rawTimeout) || rawTimeout <= 0) {
        return { ok: false, error: `state "${name}" has a malformed timeoutAfterHours` };
      }
      timeoutAfterHours = rawTimeout;
    }
    const entryActionNames = blockNames(stateValue.entryActions ?? []);
    if (entryActionNames === null) {
      return { ok: false, error: `state "${name}" has malformed entryActions` };
    }
    const on = stateValue.on ?? {};
    if (!isRecord(on)) {
      return { ok: false, error: `state "${name}" has a malformed on object` };
    }
    const transitions: DiagramTransition[] = [];
    for (const [event, shape] of Object.entries(on)) {
      if (!EVENT_NAME.test(event)) {
        return { ok: false, error: `event name "${event}" must be UPPER_SNAKE_CASE` };
      }
      const parsed = parseTransition(name, event, shape);
      if (typeof parsed === "string") {
        return { ok: false, error: parsed };
      }
      if (!stateNames.has(parsed.target)) {
        return { ok: false, error: `"${name}" --${event}--> unknown target "${parsed.target}"` };
      }
      if (parsed.target === name) {
        return { ok: false, error: `"${name}" --${event}--> itself is a self-loop` };
      }
      transitions.push(parsed);
    }
    transitions.sort((a, b) => (a.event < b.event ? -1 : a.event > b.event ? 1 : 0));
    model.states.push({
      name,
      isInitial: name === initial,
      ...(timeoutAfterHours !== undefined ? { timeoutAfterHours } : {}),
      entryActionNames,
      transitions,
    });
  }
  model.states.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { ok: true, model: model };
}

// ---------------------------------------------------------------------------
// Layout: a deterministic layered drawing. States sit in columns by hop
// distance from the initial state (BFS layers); within a column they read
// alphabetically; forward edges run right-to-left side; anything that points
// backward or sideways routes beneath the boxes so it never crosses one.
// Same discipline as the server's save-time checks: same input, same drawing.
// ---------------------------------------------------------------------------

export interface DiagramNode {
  name: string;
  isInitial: boolean;
  layer: number;
  x: number;
  y: number;
  width: number;
  height: number;
  timeoutAfterHours?: number;
  entryActionNames: readonly string[];
}

export interface DiagramEdge {
  from: string;
  to: string;
  event: string;
  roles: readonly string[];
  gateNames: readonly string[];
  requireNote: boolean;
  /** SVG path data for the curve. */
  path: string;
  /** Where the event label anchors (the curve's midpoint). */
  labelX: number;
  labelY: number;
}

export interface WorkflowDiagramLayout {
  nodes: readonly DiagramNode[];
  edges: readonly DiagramEdge[];
  width: number;
  height: number;
}

const NODE_WIDTH = 168;
const NODE_HEIGHT = 56;
const GAP_X = 88;
const GAP_Y = 40;
const MARGIN = 24;
const PARALLEL_LANE = 14;
const BACK_DIP = 64;

/** Cubic bezier point at t — the edge labels anchor at t = 1/2. */
function bezierAt(
  p0x: number,
  p0y: number,
  p1x: number,
  p1y: number,
  p2x: number,
  p2y: number,
  p3x: number,
  p3y: number,
): { x: number; y: number } {
  return {
    x: (p0x + 3 * p1x + 3 * p2x + p3x) / 8,
    y: (p0y + 3 * p1y + 3 * p2y + p3y) / 8,
  };
}

export function layoutWorkflowDiagram(model: WorkflowModel): WorkflowDiagramLayout {
  const byName = new Map(model.states.map((state) => [state.name, state]));

  // BFS from the initial state assigns layers = hop distance. States the
  // BFS cannot reach (the engine forbids them at save; render defensively
  // rather than drop them) layer after the last reached one, name-ordered.
  const layerOf = new Map<string, number>();
  const queue: string[] = [model.initial];
  layerOf.set(model.initial, 0);
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    const currentLayer = layerOf.get(current) ?? 0;
    const transitions = byName.get(current)?.transitions ?? [];
    for (const transition of transitions) {
      if (layerOf.has(transition.target)) continue;
      layerOf.set(transition.target, currentLayer + 1);
      queue.push(transition.target);
    }
  }
  let maxLayer = 0;
  for (const layer of layerOf.values()) {
    maxLayer = Math.max(maxLayer, layer);
  }
  for (const state of model.states) {
    if (!layerOf.has(state.name)) {
      maxLayer += 1;
      layerOf.set(state.name, maxLayer);
    }
  }

  // Columns: layer → names, alphabetical. Rows: index within the column.
  const columns = new Map<number, string[]>();
  for (const state of model.states) {
    const layer = layerOf.get(state.name) ?? 0;
    const column = columns.get(layer) ?? [];
    column.push(state.name);
    columns.set(layer, column);
  }
  for (const column of columns.values()) {
    column.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }

  const nodes: DiagramNode[] = [];
  const rowOf = new Map<string, number>();
  for (const [layer, column] of [...columns.entries()].sort((a, b) => a[0] - b[0])) {
    for (const [row, name] of column.entries()) {
      rowOf.set(name, row);
      const state = byName.get(name);
      if (state === undefined) throw new Error(`unexpected missing state "${name}"`);
      nodes.push({
        name,
        isInitial: name === model.initial,
        layer,
        x: MARGIN + layer * (NODE_WIDTH + GAP_X),
        y: MARGIN + row * (NODE_HEIGHT + GAP_Y),
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        ...(state.timeoutAfterHours !== undefined
          ? { timeoutAfterHours: state.timeoutAfterHours }
          : {}),
        entryActionNames: state.entryActionNames,
      });
    }
  }

  // Lane bookkeeping: parallel edges between the same pair fan out around
  // the shared centerline so both the curves and their labels stay legible.
  const laneCounts = new Map<string, number>();
  for (const state of model.states) {
    for (const transition of state.transitions) {
      const key = `${state.name}->${transition.target}`;
      laneCounts.set(key, (laneCounts.get(key) ?? 0) + 1);
    }
  }
  const laneSeen = new Map<string, number>();

  // Walk the NODES (layer by layer, name by name), not the model's states —
  // the edges array reads in the same order the boxes do.
  const edges: DiagramEdge[] = [];
  for (const source of nodes) {
    const state = byName.get(source.name);
    if (state === undefined) throw new Error(`unexpected missing state "${source.name}"`);
    for (const transition of state.transitions) {
      const target = nodes.find((node) => node.name === transition.target);
      if (target === undefined) throw new Error(`unexpected missing node "${transition.target}"`);
      const key = `${source.name}->${transition.target}`;
      const count = laneCounts.get(key) ?? 1;
      const lane = laneSeen.get(key) ?? 0;
      laneSeen.set(key, lane + 1);
      const offset = (lane - (count - 1) / 2) * PARALLEL_LANE;

      let path: string;
      let label: { x: number; y: number };
      if (target.layer > source.layer) {
        // Forward: source's right midline to target's left midline, a curve
        // that leaves and enters horizontally.
        const x0 = source.x + source.width;
        const y0 = source.y + source.height / 2 + offset;
        const x3 = target.x;
        const y3 = target.y + target.height / 2 + offset;
        const dx = Math.max(GAP_X / 2, Math.abs(x3 - x0) / 2);
        path = `M ${x0} ${y0} C ${x0 + dx} ${y0}, ${x3 - dx} ${y3}, ${x3} ${y3}`;
        label = bezierAt(x0, y0, x0 + dx, y0, x3 - dx, y3, x3, y3);
      } else {
        // Backward or same-layer: dip beneath both boxes, endpoint to
        // endpoint along the bottom edges.
        const dip = BACK_DIP + lane * PARALLEL_LANE;
        const x0 = source.x + source.width / 2;
        const y0 = source.y + source.height;
        const x3 = target.x + target.width / 2;
        const y3 = target.y + target.height;
        path = `M ${x0} ${y0} C ${x0} ${y0 + dip}, ${x3} ${y3 + dip}, ${x3} ${y3}`;
        label = bezierAt(x0, y0, x0, y0 + dip, x3, y3 + dip, x3, y3);
      }
      edges.push({
        from: state.name,
        to: transition.target,
        event: transition.event,
        roles: transition.roles,
        gateNames: transition.gateNames,
        requireNote: transition.requireNote,
        path,
        labelX: label.x,
        labelY: label.y,
      });
    }
  }

  const maxColumn = Math.max(...[...columns.keys()], 0);
  const maxRows = Math.max(...[...columns.values()].map((column) => column.length), 1);
  return {
    nodes,
    edges,
    width: MARGIN * 2 + maxColumn * (NODE_WIDTH + GAP_X) + NODE_WIDTH,
    height:
      MARGIN * 2 +
      // The back-edge dip must stay inside the canvas too.
      maxRows * (NODE_HEIGHT + GAP_Y) +
      BACK_DIP -
      GAP_Y,
  };
}
