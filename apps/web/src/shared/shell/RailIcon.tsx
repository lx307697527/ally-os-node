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

export type RailIconName = "overview" | "ledger";

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
