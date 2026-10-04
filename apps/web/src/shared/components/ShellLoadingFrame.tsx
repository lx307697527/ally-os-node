// The top-level gates' shared waiting face. Ported from ally-os apps/allyos
// ShellLoadingFrame.tsx (#129 slice 1).
//
// `RequireAuth` and the shell's own Suspense boundary render the shell's
// SILHOUETTE instead of a bare spinner on a blank page — the app's first
// white-screen beat. It draws top bar, rail column, content area.
//
// WHAT IT DELIBERATELY DOES NOT DRAW: rail destination names, a brand mark, an
// identity chip. The shell renders none of those until a session exists, and
// this frame runs BEFORE even the session is confirmed, so anything it named
// would be fabricated. Static bars only, no motion; `role="status"` +
// `aria-busy` and no claim about what will appear.
import type { HTMLAttributes, ReactElement } from "react";
import { cn } from "@ally/ui";

/** The rail silhouette's placeholder rows, ragged on purpose — uniform bars
 *  read as text; a rag reads as a list of rows. */
const RAIL_ROWS = ["w-3/4", "w-full", "w-5/6", "w-2/3", "w-full", "w-4/5"] as const;

export function ShellLoadingFrame({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>): ReactElement {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading"
      className={cn("flex min-h-screen flex-col bg-page", className)}
      data-slot="shell-loading-frame"
      {...props}
    >
      {/* The top bar's silhouette: a brand block, a wide band, the session chip's slot. */}
      <div className="flex h-[var(--app-bar-h)] flex-none items-center gap-3 border-b border-line bg-panel px-4">
        <span className="block size-8 flex-none rounded-card bg-line" />
        <span className="block h-4 w-44 rounded-card bg-line" />
        <span className="ml-auto block h-4 w-24 rounded-card bg-line" />
      </div>
      <div className="flex min-h-0 flex-1">
        {/* The rail's silhouette. Hidden on the widths the real rail collapses at. */}
        <div
          aria-hidden="true"
          className="hidden w-[var(--nav-width)] flex-none flex-col gap-3 border-r border-line bg-panel p-3 sm:flex"
        >
          {RAIL_ROWS.map((width, index) => (
            <span key={index} className={`block h-9 rounded-card bg-line ${width}`} />
          ))}
        </div>
        {/* The content area's silhouette: a page title and one card of facts. */}
        <div className="min-w-0 flex-1 p-6">
          <span className="block h-7 w-52 max-w-full rounded-card bg-line" />
          <div className="mt-6 flex flex-col gap-3 rounded-card border border-line bg-panel p-[var(--pad-card)]">
            <span className="block h-4 w-4/5 max-w-full rounded-card bg-line" />
            <span className="block h-4 w-3/5 max-w-full rounded-card bg-line" />
            <span className="block h-4 w-2/3 max-w-full rounded-card bg-line" />
          </div>
        </div>
      </div>
    </div>
  );
}
