// Employee shell structure. Face overrides belong on the frame, where their
// consumers inherit them. Ported verbatim from ally-os apps/allyos
// ShellFrame.tsx (#129 slice 1).
import type { HTMLAttributes, ReactElement } from "react";
import { cn } from "@ally/ui";

export function ShellFrame({ className, ...props }: HTMLAttributes<HTMLDivElement>): ReactElement {
  return <div data-shell="internal" className={cn(
    "flex min-h-screen flex-col bg-[var(--surface-canvas)] leading-[var(--lh-body)] " +
    "[--layout-pad:var(--internal-layout-pad)] [--surface-canvas:var(--surface-page-internal)] [--surface-panel:var(--surface-card)] " +
    "[--surface-rail:var(--ally-navy)] [--surface-rail-active:var(--internal-rail-active)] " +
    "[--rail-ink:var(--internal-rail-ink)] [--rail-ink-mute:var(--internal-rail-ink-mute)] " +
    "[--rail-ink-strong:var(--text-on-navy)] [--nav-width:var(--internal-nav-width)] [--lh-body:1.55] " +
    "max-[899px]:[--nav-width:168px] max-[899px]:[--layout-pad:var(--space-6)]",
    className,
  )} {...props} />;
}

// NO bottom rule on the header: the header and the rail are both navy, so a
// rule was drawing a seam down the middle of one surface, not separating two.
export function ShellHeader({ className, ...props }: HTMLAttributes<HTMLElement>): ReactElement {
  return <header data-shell-header className={cn("sticky top-0 z-[15] flex h-[var(--app-bar-h)] shrink-0 items-stretch gap-4 bg-[var(--surface-navy)] pr-6", className)} {...props} />;
}

export function ShellRail({ className, ...props }: HTMLAttributes<HTMLElement>): ReactElement {
  return <nav data-shell-rail className={cn("sticky top-[var(--app-bar-h)] flex h-[calc(100vh-var(--app-bar-h))] w-[var(--nav-width)] shrink-0 flex-col gap-0.5 self-start overflow-y-auto bg-[var(--surface-rail)] p-[var(--rail-pad)] text-[var(--rail-ink)]", className)} {...props} />;
}

export function ShellRailGroup({ className, pinned = false, ...props }: HTMLAttributes<HTMLDivElement> & { pinned?: boolean }): ReactElement {
  return <div className={cn("mt-3 flex flex-col gap-0.5 first-of-type:mt-0", pinned && "border-t border-[var(--rule-on-navy)] pt-3", className)} {...props} />;
}

// The group caption reads at `--fs-meta` (12px), not at `--fs-rail-caption`
// (10px) — the token keeps its value and its other reader; this is a per-call
// site size, not a scale change.
export function ShellRailCaption({ className, ...props }: HTMLAttributes<HTMLSpanElement>): ReactElement {
  return <span data-rail-label className={cn("px-3 font-mono text-[length:var(--fs-meta)] tracking-[var(--ls-rail-caption)] text-[var(--rail-ink-mute)] uppercase", className)} {...props} />;
}

// Below the top bar's `sticky top-0 z-[15]` so the band never draws over it,
// but above ordinary page content.
export function ShellContextBand({ className, ...props }: HTMLAttributes<HTMLDivElement>): ReactElement {
  return <div className={cn("sticky top-[var(--app-bar-h)] z-[14] flex items-center gap-4 border-b border-line bg-card p-[var(--pad-band)] max-[899px]:px-[var(--layout-pad)] max-[899px]:py-3", className)} {...props} />;
}
