// The rail's glyphs. Ported from ally-os apps/allyos RailIcon.tsx (#129 slice
// 1), carrying only the rows this repo's rail has today.
//
// STROKE SPEC (measured off the ally-os rendered build):
//
//   viewBox="0 0 24 24" · rendered 17×17 · fill=none · stroke=currentColor
//   stroke-width=1.7 · linecap=round · linejoin=round
//
// `currentColor` is why there is no colour prop and no active variant: the row
// already resolves ink for current and muted for the rest, and the glyph
// inherits it.
//
// THE PATHS ARE OURS (ally-os ruling): hand-drawn on the 24 grid in the same
// stroke language — plain geometry, no third-party icon set, so no licence
// notice to carry.
//
// The set GROWS WITH THE RAIL: a later slice that adds a rail row names its
// glyph here in the same stroke spec. `railRow`'s placeholder branch keeps the
// glyph column for a row that has none, so an unnamed mark never ragged-edges
// the labels beside it.
import type { ReactElement, ReactNode } from "react";

export type RailIconName = "overview" | "ledger" | "tasks" | "approvals" | "hash" | "stages" | "bolt" | "fields";

const GLYPHS: Record<RailIconName, ReactNode> = {
  // A gauge: the arc, its baseline and one needle — where things stand.
  overview: (
    <>
      <path d="M4 17.5a8 8 0 1 1 16 0" />
      <path d="M4 17.5h16" />
      <path d="M12 17.5 16 11.5" />
    </>
  ),
  // A ledger page: the sheet and its ruled lines — the record that only grows.
  ledger: (
    <>
      <rect x="4.75" y="3.5" width="14.5" height="17" rx="1.5" />
      <path d="M8.25 8.25h7.5" />
      <path d="M8.25 12h7.5" />
      <path d="M8.25 15.75h4.5" />
    </>
  ),
  // A ticked box: the to-do and its check — a task, done or not yet.
  tasks: (
    <>
      <rect x="4.75" y="4.75" width="14.5" height="14.5" rx="1.5" />
      <path d="m8.5 12.25 2.5 2.5 4.75-5.5" />
    </>
  ),
  // A rubber stamp: handle, block, and the mark it leaves — a decision that
  // is recorded, not clicked.
  approvals: (
    <>
      <path d="M9.75 11V8.75a2.25 2.25 0 0 1 4.5 0V11" />
      <rect x="5.25" y="11" width="13.5" height="5.5" rx="1.2" />
      <path d="M7.75 20.5h8.5" />
    </>
  ),
  // A hash: the number sign itself — the series that counts documents out.
  hash: (
    <>
      <path d="M9.5 4 7.5 20" />
      <path d="M16.5 4l-2 16" />
      <path d="M4.5 9h16" />
      <path d="M3.5 15h16" />
    </>
  ),
  // A staircase: each step one level further along — an approval line's
  // ordered levels, climbed in sequence.
  stages: (
    <>
      <path d="M4.75 6.5h14.5" />
      <path d="M8.25 12h11" />
      <path d="M11.75 17.5h7.5" />
    </>
  ),
  // A bolt: the discharge that fires by itself — a rule that turns one event
  // into the chain of actions that follows it.
  bolt: <path d="M13 3.5 6.5 13.5h4.5l-1 7 6.5-10h-4.5z" />,
  // An input line with its cursor: the field a form waits on — a custom
  // column added to every form of an object without a line of code.
  fields: (
    <>
      <rect x="3.75" y="6.5" width="16.5" height="11" rx="1.5" />
      <path d="M7 12h6.5" />
      <path d="M16.75 9.75v4.5" />
    </>
  ),
};

export function RailIcon({ name }: { name: RailIconName }): ReactElement {
  return (
    <svg
      className="shrink-0"
      viewBox="0 0 24 24"
      width="17"
      height="17"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {GLYPHS[name]}
    </svg>
  );
}
