// The decision-table grid editor (#233 JDM editor slice): the authoring face
// for decision_table rules in the rules registry's change form, replacing the
// raw-JSON textarea for values the grid can draw.
//
// The page's rulings, kept visible:
//  - ALL table surgery goes through the pure helpers in rules-client.ts
//    (moveTableRow / moveTableColumn / addTableColumn / …) so every mutation
//    is unit-testable without a DOM and the component stays dumb.
//  - Cells are keyed by the column's stable handle, never by its editable id —
//    renaming an id mid-keystroke cannot re-key cells underneath the editor.
//  - Drag-to-reorder uses native HTML5 drag events from handle spans only
//    (never the whole row/column — cell inputs own pointer interactions
//    there). Rows reorder freely (first-hit policy makes row order the
//    routing order); columns reorder within their own kind, an input can
//    never cross into the outputs.
//  - The editor never talks to the network: serializeTableDraft runs in the
//    page on submit, and the server's zod + compile probe stay the only
//    authority. Cell syntax errors come back as the server's per-cell issues,
//    verbatim — same discipline as the JSON path.
//  - The compile probe's per-cell refusals are worn by their cells: the page
//    resolves the server's issues onto the grid (locateTableCellIssues) and
//    this component only paints what it is handed — the marks are annotations
//    of the last refusal, lifted when the next save re-judges.
//  - Empty cell semantics are said out loud: an empty input cell is always
//    true, an empty output cell produces nothing.
import type { DragEvent, ReactElement } from "react";
import { useState } from "react";
import { Button, Input, Paragraph } from "@ally/ui";

import {
  addTableColumn,
  addTableRow,
  cellIssueKey,
  moveTableColumn,
  moveTableRow,
  patchTableColumn,
  removeTableColumn,
  removeTableRow,
  setTableCell,
  type TableDraft,
  type TableColumnKind,
} from "../lib/rules-client.ts";

const CELL_PLACEHOLDER: Record<TableColumnKind, string> = {
  input: "== 'value'  (empty = always true)",
  output: "'result'  (empty = produces nothing)",
};

interface DecisionTableEditorProps {
  draft: TableDraft;
  onChange: (draft: TableDraft) => void;
  /** The last save's compile-probe refusals, resolved onto this grid by the
   *  page via locateTableCellIssues — keyed by cellIssueKey. A marked cell is
   *  one the server named; the marks lift when the next save re-judges. */
  cellIssues?: ReadonlyMap<string, string>;
}

export function DecisionTableEditor({
  draft,
  onChange,
  cellIssues,
}: DecisionTableEditorProps): ReactElement {
  const [dragRowKey, setDragRowKey] = useState<string | null>(null);
  const [dragColumnKey, setDragColumnKey] = useState<string | null>(null);
  const [dropRowKey, setDropRowKey] = useState<string | null>(null);
  const [dropColumnKey, setDropColumnKey] = useState<string | null>(null);

  const outputs = draft.columns.filter((column) => column.kind === "output");
  const lastOutputKey = outputs.length === 1 ? outputs[0]?.key : undefined;

  function dropRowOn(targetKey: string): void {
    setDropRowKey(null);
    if (dragRowKey === null || dragRowKey === targetKey) return;
    const from = draft.rows.findIndex((row) => row.key === dragRowKey);
    const to = draft.rows.findIndex((row) => row.key === targetKey);
    if (from >= 0 && to >= 0) onChange(moveTableRow(draft, from, to));
    setDragRowKey(null);
  }

  function dropColumnOn(targetKey: string): void {
    setDropColumnKey(null);
    if (dragColumnKey === null || dragColumnKey === targetKey) return;
    const dragged = draft.columns.find((column) => column.key === dragColumnKey);
    const target = draft.columns.find((column) => column.key === targetKey);
    if (dragged?.kind !== target?.kind || dragged === undefined || target === undefined) return;
    const slice = draft.columns.filter((column) => column.kind === dragged.kind);
    onChange(
      moveTableColumn(draft, dragged.kind, slice.indexOf(dragged), slice.indexOf(target)),
    );
    setDragColumnKey(null);
  }

  function startDrag(
    event: DragEvent<HTMLElement>,
    kind: "row" | "column",
    key: string,
  ): void {
    event.dataTransfer.effectAllowed = "move";
    // Firefox ignores a drag that never sets data.
    event.dataTransfer.setData("text/plain", key);
    if (kind === "row") setDragRowKey(key);
    else setDragColumnKey(key);
  }

  return (
    <div data-testid="rules-edit-table">
      <div className="flex flex-wrap items-center gap-3">
        <label className="text-ui-sm text-ink">
          Hit policy
          <select
            className="mt-1 block rounded-control border border-line bg-card p-[var(--pad-control)] text-ui text-ink"
            data-testid="rules-edit-table-policy"
            value={draft.hitPolicy}
            onChange={(e) => {
              onChange({ ...draft, hitPolicy: e.target.value as TableDraft["hitPolicy"] });
            }}
          >
            <option value="first">first — first matching row wins</option>
            <option value="collect">collect — every matching row</option>
          </select>
        </label>
        <Paragraph className="text-ui-sm text-ink-soft" data-testid="rules-edit-table-hint">
          Input cells are unary tests, output cells are expressions; an empty
          input cell is always true, an empty output cell produces nothing. The
          server compiles every cell on save.
        </Paragraph>
      </div>

      <div className="mt-2 flex gap-2">
        <Button
          variant="default"
          size="sm"
          data-testid="rules-edit-table-col-add-input"
          onClick={() => {
            onChange(addTableColumn(draft, "input"));
          }}
        >
          + Input column
        </Button>
        <Button
          variant="default"
          size="sm"
          data-testid="rules-edit-table-col-add-output"
          onClick={() => {
            onChange(addTableColumn(draft, "output"));
          }}
        >
          + Output column
        </Button>
      </div>

      <div className="mt-2 overflow-x-auto">
        <table className="border-collapse text-left text-ui-sm">
          <thead>
            <tr>
              <th className="border border-line bg-card px-1 py-1" aria-label="row handle" />
              {draft.columns.map((column) => (
                <th
                  key={column.key}
                  className={`border border-line bg-card px-2 py-1 align-top ${
                    dropColumnKey === column.key && dragColumnKey !== column.key
                      ? "outline-2 outline-dashed outline-[var(--accent)]"
                      : ""
                  }`}
                  data-testid="rules-edit-table-col"
                  onDragOver={(e) => {
                    if (dragColumnKey !== null) e.preventDefault();
                  }}
                  onDrop={() => {
                    dropColumnOn(column.key);
                  }}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className="cursor-grab select-none text-ink-soft"
                      title="Drag to reorder within input/output columns"
                      data-testid="rules-edit-table-col-handle"
                      draggable
                      onDragStart={(e) => {
                        startDrag(e, "column", column.key);
                      }}
                      onDragEnd={() => {
                        setDragColumnKey(null);
                        setDropColumnKey(null);
                      }}
                      onDragOver={(e) => {
                        if (dragColumnKey !== null) e.preventDefault();
                      }}
                      onDrop={() => {
                        dropColumnOn(column.key);
                      }}
                    >
                      ⠿
                    </span>
                    <span className="font-mono text-[length:var(--fs-meta)] uppercase tracking-[var(--ls-crumb)] text-ink-soft">
                      {column.kind}
                    </span>
                    <button
                      type="button"
                      className="cursor-pointer border-0 bg-transparent p-0 text-ui-sm text-ink-soft hover:text-err disabled:cursor-not-allowed disabled:opacity-40"
                      title={
                        column.key === lastOutputKey
                          ? "A table needs at least one output column"
                          : "Remove this column and its cells"
                      }
                      data-testid="rules-edit-table-col-remove"
                      disabled={column.key === lastOutputKey}
                      onClick={() => {
                        onChange(removeTableColumn(draft, column.key));
                      }}
                    >
                      ✕
                    </button>
                  </div>
                  <Input
                    className="mt-1 block w-36 font-mono"
                    aria-label={`${column.kind} column id`}
                    placeholder="id"
                    data-testid="rules-edit-table-col-id"
                    value={column.id}
                    onChange={(e) => {
                      onChange(patchTableColumn(draft, column.key, { id: e.target.value }));
                    }}
                  />
                  <Input
                    className="mt-1 block w-36 font-mono"
                    aria-label={`${column.kind} column field`}
                    placeholder="field path"
                    data-testid="rules-edit-table-col-field"
                    value={column.field}
                    onChange={(e) => {
                      onChange(patchTableColumn(draft, column.key, { field: e.target.value }));
                    }}
                  />
                  <Input
                    className="mt-1 block w-36"
                    aria-label={`${column.kind} column label`}
                    placeholder="label (optional)"
                    data-testid="rules-edit-table-col-name"
                    value={column.name}
                    onChange={(e) => {
                      onChange(patchTableColumn(draft, column.key, { name: e.target.value }));
                    }}
                  />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {draft.rows.map((row) => (
              <tr
                key={row.key}
                className={dropRowKey === row.key && dragRowKey !== row.key ? "bg-card" : ""}
                data-testid="rules-edit-table-row"
                onDragOver={(e) => {
                  if (dragRowKey !== null) {
                    e.preventDefault();
                    setDropRowKey(row.key);
                  }
                }}
                onDrop={() => {
                  dropRowOn(row.key);
                }}
              >
                <td className="border border-line bg-card px-1 py-1 text-center">
                  <span
                    className="cursor-grab select-none text-ink-soft"
                    title="Drag to reorder rows — with the first hit policy, row order is the routing order"
                    data-testid="rules-edit-table-row-handle"
                    draggable
                    onDragStart={(e) => {
                      startDrag(e, "row", row.key);
                    }}
                    onDragEnd={() => {
                      setDragRowKey(null);
                      setDropRowKey(null);
                    }}
                  >
                    ⠿
                  </span>
                </td>
                {draft.columns.map((column) => {
                  const issue = cellIssues?.get(cellIssueKey(row.key, column.key));
                  return (
                    <td key={column.key} className="border border-line p-0">
                      <textarea
                        className={`block min-w-[10rem] resize-y border-0 bg-transparent p-2 font-mono text-ui text-ink outline-none ${
                          issue !== undefined ? "outline-2 outline-[var(--err-line)]" : ""
                        }`}
                        rows={1}
                        aria-label={`${column.id} cell`}
                        aria-invalid={issue !== undefined}
                        placeholder={CELL_PLACEHOLDER[column.kind]}
                        data-testid="rules-edit-table-cell"
                        title={issue}
                        value={row.cells[column.key] ?? ""}
                        onChange={(e) => {
                          onChange(setTableCell(draft, row.key, column.key, e.target.value));
                        }}
                      />
                    </td>
                  );
                })}
                <td className="border border-line px-2 py-1 text-center">
                  <button
                    type="button"
                    className="cursor-pointer border-0 bg-transparent p-0 text-ui-sm text-ink-soft hover:text-err"
                    title="Remove this row"
                    data-testid="rules-edit-table-row-remove"
                    onClick={() => {
                      onChange(removeTableRow(draft, row.key));
                    }}
                  >
                    ✕
                  </button>
                </td>
              </tr>
            ))}
            {draft.rows.length === 0 ? (
              <tr>
                <td
                  colSpan={draft.columns.length + 2}
                  className="border border-line px-2 py-2 text-ink-soft"
                  data-testid="rules-edit-table-empty"
                >
                  No rows yet — an empty table matches nothing, so the rule answers
                  every request with fail-closed until a row is added.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <div className="mt-2">
        <Button
          variant="default"
          size="sm"
          data-testid="rules-edit-table-row-add"
          onClick={() => {
            onChange(addTableRow(draft));
          }}
        >
          + Row
        </Button>
        {cellIssues !== undefined && cellIssues.size > 0 ? (
          <Paragraph
            className="mt-2 text-ui-sm text-err"
            data-testid="rules-edit-table-cell-errors"
          >
            Red cells are the ones the server refused on the last save — fix
            them and save again; the server re-judges every cell either way.
          </Paragraph>
        ) : null}
      </div>
    </div>
  );
}