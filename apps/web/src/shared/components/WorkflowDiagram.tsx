// The workflow diagram (#220's config-studio face): an SVG drawing of a
// template's definition — states as boxes in layers from the initial state,
// transitions as labeled arrows. Purely presentational: the geometry comes
// from layoutWorkflowDiagram (workflow-diagram.ts), the facts from the
// server's saved definition. The diagram describes the template, it never
// grades it — whether the flow is any GOOD is the editor's judgment.
//
// Everything an operator needs on hover or to a screen reader is in the
// <title> sentences: roles, gates and note requirements render in words,
// with the snake_case identifiers humanized (payload-rows' discipline).
import { useId } from "react";
import type { ReactElement } from "react";

import { humanizeIdentifier } from "../lib/payload-rows.ts";
import type { DiagramEdge, DiagramNode, WorkflowDiagramLayout } from "../lib/workflow-diagram.ts";

function nodeSentence(node: DiagramNode): string {
  const parts: string[] = [node.isInitial ? `Initial state "${node.name}"` : `State "${node.name}"`];
  if (node.timeoutAfterHours !== undefined) {
    parts.push(`stays here more than ${node.timeoutAfterHours}h and a reminder is due`);
  }
  if (node.entryActionNames.length > 0) {
    parts.push(
      `on entry runs: ${node.entryActionNames.map(humanizeIdentifier).join(", ")}`,
    );
  }
  return `${parts.join(" — ")}.`;
}

function edgeSentence(edge: DiagramEdge): string {
  const parts: string[] = [`${edge.event}: "${edge.from}" → "${edge.to}"`];
  if (edge.roles.length > 0) {
    parts.push(`allowed roles: ${edge.roles.map(humanizeIdentifier).join(", ")}`);
  }
  if (edge.gateNames.length > 0) {
    parts.push(`gates that must pass: ${edge.gateNames.map(humanizeIdentifier).join(", ")}`);
  }
  if (edge.requireNote) {
    parts.push("requires a note");
  }
  return `${parts.join("; ")}.`;
}

function edgeLabel(edge: DiagramEdge): string {
  const parts = [edge.event];
  if (edge.requireNote) parts.push("note");
  if (edge.gateNames.length > 0) {
    parts.push(`${edge.gateNames.length} gate${edge.gateNames.length === 1 ? "" : "s"}`);
  }
  if (edge.roles.length > 0) {
    parts.push(`${edge.roles.length} role${edge.roles.length === 1 ? "" : "s"}`);
  }
  return parts.join(" · ");
}

function nodeMeta(node: DiagramNode): string | null {
  const parts: string[] = [];
  if (node.timeoutAfterHours !== undefined) parts.push(`${node.timeoutAfterHours}h timeout`);
  if (node.entryActionNames.length > 0) {
    parts.push(`${node.entryActionNames.length} entry action${node.entryActionNames.length === 1 ? "" : "s"}`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function WorkflowDiagram({ layout }: { layout: WorkflowDiagramLayout }): ReactElement {
  // The detail view and the edit preview can both be on the page; SVG marker
  // ids are document-global, so each drawing mints its own.
  const markerId = useId();
  const initialNode = layout.nodes.find((node) => node.isInitial);
  const ariaLabel = `Workflow diagram: ${layout.nodes.length} states, ${layout.edges.length} transitions, initial state "${initialNode?.name ?? "?"}".`;
  return (
    <svg
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      className="max-w-full"
      role="img"
      aria-label={ariaLabel}
      data-testid="workflow-diagram-svg"
    >
      <title>{ariaLabel}</title>
      <defs>
        <marker
          id={markerId}
          markerWidth="8"
          markerHeight="8"
          refX="7"
          refY="4"
          orient="auto"
          markerUnits="userSpaceOnUse"
        >
          <path d="M0,0 L8,4 L0,8 z" fill="var(--color-ink-soft)" />
        </marker>
      </defs>

      {layout.edges.map((edge) => (
        <g key={`${edge.from}-${edge.event}-${edge.to}`}>
          <title>{edgeSentence(edge)}</title>
          <path
            d={edge.path}
            fill="none"
            stroke="var(--color-ink-soft)"
            strokeWidth="1.5"
            markerEnd={`url(#${markerId})`}
          />
        </g>
      ))}

      {layout.nodes.map((node) => {
        const meta = nodeMeta(node);
        return (
          <g key={node.name} data-testid="workflow-diagram-node">
            <title>{nodeSentence(node)}</title>
            <rect
              x={node.x}
              y={node.y}
              width={node.width}
              height={node.height}
              rx="4"
              fill="var(--color-card)"
              stroke={node.isInitial ? "var(--color-brand)" : "var(--color-line)"}
              strokeWidth={node.isInitial ? "2" : "1"}
            />
            {node.isInitial ? (
              <text
                x={node.x + 10}
                y={node.y + 15}
                fontSize="9"
                className="font-mono uppercase"
                fill="var(--color-brand)"
              >
                initial
              </text>
            ) : null}
            <text
              x={node.x + node.width / 2}
              y={node.y + (node.isInitial ? 34 : 28)}
              textAnchor="middle"
              fontSize="13"
              className="font-mono"
              fill="var(--color-ink)"
            >
              {node.name}
            </text>
            {meta !== null ? (
              <text
                x={node.x + node.width / 2}
                y={node.y + 46}
                textAnchor="middle"
                fontSize="10"
                fill="var(--color-ink-soft)"
              >
                {meta}
              </text>
            ) : null}
          </g>
        );
      })}

      {/* Labels paint AFTER the node boxes: a gap narrower than the label
          must not let the boxes eat the text (the card-colored halo keeps it
          legible where it crosses a box edge). */}
      {layout.edges.map((edge) => (
        <g key={`label-${edge.from}-${edge.event}-${edge.to}`} data-testid="workflow-diagram-edge">
          <text
            x={edge.labelX}
            y={edge.labelY - 4}
            textAnchor="middle"
            fontSize="11"
            className="font-mono"
            fill="var(--color-ink)"
            stroke="var(--color-card)"
            strokeWidth="4"
            paintOrder="stroke"
          >
            {edgeLabel(edge)}
          </text>
        </g>
      ))}
    </svg>
  );
}
