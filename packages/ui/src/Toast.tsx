// [FEAT-297] Toast / ToastViewport — ported from ally-os packages/ui (#129
// slice 4), REDUCED to what this repo consumes today: the navy `brand` notice
// with its Undo / action links and the auto-dismiss timer. Deferred until the
// surfaces that need them port (they ride the bell's popup slice and the
// record pages): `appearance="card"` (FEAT-638), `motion="slide"` with its
// dwell countdown (FEAT-638), and `title`/`meta` (card-only lines).
//
// Colors ride the ruled navy surface (bg-brand-deep / text-on-brand /
// text-on-brand-soft), not new literals. Undo/action read as links via
// underline, not amber text — `--ally-amber` fails AA on a light surface and
// the conformance rule bans `text-accent` as a LIVE text color for exactly
// that reason.
import { useEffect, useState } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

import { cn } from "./lib/cn.ts";

/** Enter/leave durations, in ms, mirroring `--toast-enter-dur` /
 *  `--toast-leave-dur`. Kept (not dropped with the motion feature) so the
 *  constants' contract with the token file survives the deferred port; the
 *  reduced Toast animates nothing today. */
export const TOAST_ENTER_MS = 260;
export const TOAST_LEAVE_MS = 220;

export type ToastPosition = "top-right" | "top-left" | "bottom-right" | "bottom-left";

const VIEWPORT_POSITION: Record<ToastPosition, string> = {
  "top-right": "top-4 right-4 items-end",
  "top-left": "top-4 left-4 items-start",
  "bottom-right": "bottom-4 right-4 items-end",
  "bottom-left": "bottom-4 left-4 items-start",
};

export interface ToastViewportProps {
  /** Where notices anchor. Component parameter, never hard-coded on a page. */
  position?: ToastPosition;
  children?: ReactNode;
  className?: string;
}

// Positions itself at one viewport corner and stacks its children with a gap,
// so several toasts (or one replaced in place) never overlap.
export function ToastViewport({ position = "top-right", children, className }: ToastViewportProps) {
  return (
    <div
      data-slot="toast-viewport"
      role="region"
      aria-label="Notifications"
      className={cn("fixed z-40 flex flex-col gap-3", VIEWPORT_POSITION[position], className)}
    >
      {children}
    </div>
  );
}

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastProps {
  message: ReactNode;
  onDismiss: () => void;
  /** Present only when the action is offered; omit to hide the control entirely. */
  onUndo?: () => void;
  undoLabel?: string;
  action?: ToastAction;
  /** Auto-dismiss after this many ms. Unset = stays until the caller dismisses it. */
  autoDismissMs?: number;
  className?: string;
  "data-testid"?: string;
  actionTestId?: string;
}

const NOTICE_LINK = "p-0! border-0! bg-transparent! font-sans! text-ui-sm font-semibold underline underline-offset-2";

const BRAND =
  "flex max-w-160 items-center gap-3.5 rounded-control bg-brand-deep px-4 py-3 text-on-brand shadow-raised";

export function Toast({
  message,
  onDismiss,
  onUndo,
  undoLabel = "Undo",
  action,
  autoDismissMs,
  className,
  "data-testid": testId,
  actionTestId,
}: ToastProps) {
  // [BUG-547] THE REGION IS COMMITTED EMPTY, AND THE WORDS ARRIVE ONE COMMIT
  // LATER. A live region is announced when its CONTENT CHANGES while the region
  // is already in the accessibility tree; a region that appears already holding
  // its text is, from the screen reader's side, nothing having happened — the
  // Undo offer was never spoken. A PASSIVE effect, not `useLayoutEffect`: a
  // layout effect would land both commits in the same frame, before the browser
  // has processed the first one — the state we are trying to get out of.
  //
  // Keyed on MOUNT, not on `message`: once the region is in the tree a changed
  // message is already a mutation, so re-emptying it would only delay the next
  // announcement.
  const [regionReady, setRegionReady] = useState(false);
  useEffect(() => {
    setRegionReady(true);
  }, []);

  useEffect(() => {
    if (autoDismissMs === undefined) return undefined;
    const timer = setTimeout(onDismiss, autoDismissMs);
    return () => {
      clearTimeout(timer);
    };
  }, [autoDismissMs, message, onDismiss]);

  return (
    <div role="status" data-slot="toast" data-testid={testId} className={cn(BRAND, className)}>
      {regionReady && (
        <>
          <span className="text-ui-sm">{message}</span>
          {onUndo && (
            <button type="button" onClick={onUndo} className={cn(NOTICE_LINK, "text-on-brand")}>
              {undoLabel}
            </button>
          )}
          {action && (
            <button
              type="button"
              onClick={action.onClick}
              data-testid={actionTestId}
              className={cn(NOTICE_LINK, "whitespace-nowrap text-on-brand")}
            >
              {action.label}
            </button>
          )}
          <DismissButton onClick={onDismiss} />
        </>
      )}
    </div>
  );
}

function DismissButton(props: Pick<ButtonHTMLAttributes<HTMLButtonElement>, "onClick">) {
  return (
    <button
      type="button"
      aria-label="Dismiss"
      className={cn(NOTICE_LINK, "flex", "text-on-brand-soft")}
      {...props}
    >
      <svg
        width={13}
        height={13}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
      >
        <line x1="18" y1="6" x2="6" y2="18" />
        <line x1="6" y1="6" x2="18" y2="18" />
      </svg>
    </button>
  );
}
