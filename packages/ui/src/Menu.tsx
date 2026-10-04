// [FEAT-428 / #2888] Menu — recipe source: the approved unified-dropdown
// preview ruled on 2026-09-12: ONE popup surface and ONE option row for the
// whole system. Ported verbatim from ally-os packages/ui (#129 slice 1).
// Base UI's `Menu` owns open/close, roving focus, typeahead and aria.
import { Menu as BaseMenu } from "@base-ui-components/react";
import type { ReactElement, ReactNode } from "react";

import { cn } from "./lib/cn.ts";

/**
 * The layer EVERY portaled popup in this package sits on — above every dialog.
 *
 * A popup is moved to the end of `<body>` so no ancestor's `overflow` can clip
 * its list; dialogs portal the same way, so the two are SIBLINGS and which one
 * covers the other is settled by z-index. The contract is an ORDER, not a
 * number: strictly greater than the dialog layer. It goes on the POSITIONER,
 * not the popup — the positioner is the outermost element of the portaled
 * subtree and the only one the browser compares against the dialog.
 * Tailwind's `z-*` scale stops at 50, hence the arbitrary value.
 */
export const POPUP_LAYER = "z-[70]";

/**
 * The ruled popup surface. The width pair is the ruling's, not a guess: the
 * popup is at least as wide as its trigger (`--anchor-width`, written onto the
 * positioner by Base UI at runtime) and never narrower than the 160px floor; it
 * is at most the shorter of the space actually available and the 320px ceiling,
 * scrolling past that. `rounded-badge` and `--rule-tab` reuse the ruling's 2px
 * values rather than minting new ones inside the closed `--radius-*` set.
 */
export const POPUP_SURFACE =
  "z-30 overflow-y-auto border border-line bg-card rounded-badge shadow-popup " +
  "border-t-[length:var(--rule-tab)] border-t-accent " +
  "max-h-[min(var(--available-height),var(--height-menu-max))] " +
  "transition-[opacity,transform] duration-[var(--dur-fast)] ease-[var(--ease)] " +
  "data-[starting-style]:opacity-0 data-[starting-style]:translate-y-[var(--rise-popup)] " +
  "data-[ending-style]:opacity-0";

/**
 * The ruled option row. `--pad-menu-item` is read rather than branched on: a
 * popup that wants the wider row re-points that one custom property on its own
 * subtree, so the row never carries a second copy of the size vocabulary.
 * No focus ring, deliberately — the highlight background IS the focus indicator.
 */
export const POPUP_ROW =
  "flex cursor-pointer items-center justify-between gap-2 p-[var(--pad-menu-item)] rounded-badge " +
  "font-sans text-menu-item leading-[var(--lh-ui)] text-ink outline-none select-none " +
  "data-highlighted:bg-muted data-disabled:cursor-not-allowed data-disabled:text-ink-soft";

/** The page-wide amber keyboard focus treatment (2px, pulled 1px inside the edge). */
const FOCUS_RING =
  "focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-accent";

export type MenuAlign = "start" | "end";
export type MenuSize = "default" | "wide";

// `children` is OPTIONAL on every interface below: `createElement(Menu, props,
// ...children)` — the shape unit suites use — hands children variadically, and
// TypeScript cannot fold those into a prop the interface marks required.

export interface MenuProps {
  /** Controlled open state. Omit for an uncontrolled menu. */
  open?: boolean;
  /** Initial open state for the uncontrolled case. */
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  children?: ReactNode;
}

/** Groups the trigger and the popup. Renders no element of its own. */
export function Menu({ open, defaultOpen, onOpenChange, children }: MenuProps): ReactElement {
  return (
    <BaseMenu.Root
      // exactOptionalPropertyTypes: an omitted prop must stay OMITTED, not
      // passed as explicit undefined, so each optional is spread conditionally.
      {...(open === undefined ? {} : { open })}
      {...(defaultOpen === undefined ? {} : { defaultOpen })}
      // Base UI hands a second `eventDetails` argument the callers of this layer
      // have no use for; narrowing it here keeps `onOpenChange` a plain boolean sink.
      onOpenChange={(next) => { onOpenChange?.(next); }}
    >
      {children}
    </BaseMenu.Root>
  );
}

export interface MenuTriggerProps {
  className?: string;
  testId?: string;
  disabled?: boolean;
  children?: ReactNode;
}

/**
 * The button that opens the menu. It carries NO border and NO surface — the
 * ruling says a trigger "keeps the original control's size and border", and the
 * call sites (navy top-bar session menu, light table rows) do not agree on
 * either. Only what is true everywhere ships here; each caller passes its own
 * chrome through `className`, which `cn` appends last.
 */
export function MenuTrigger({
  className,
  testId,
  disabled,
  children,
}: MenuTriggerProps): ReactElement {
  return (
    <BaseMenu.Trigger
      data-slot="menu-trigger"
      data-testid={testId}
      {...(disabled === undefined ? {} : { disabled })}
      className={cn(
        "inline-flex cursor-pointer items-center gap-2 transition-[border-color,background-color,color] duration-[var(--dur)] ease-[var(--ease)]",
        FOCUS_RING,
        "disabled:cursor-not-allowed",
        className,
      )}
    >
      {children}
    </BaseMenu.Trigger>
  );
}

export interface MenuPopupProps {
  /** Which trigger edge the popup lines up with. Closed vocabulary — `cn` is clsx. */
  align?: MenuAlign;
  /**
   * `default` is the ruling's generic popup (6px of padding, at least as wide as
   * the trigger). `wide` is its version-menu shape: a fixed 250px with no padding
   * of its own, the rows running edge to edge.
   */
  size?: MenuSize;
  children?: ReactNode;
}

/**
 * Portals the menu to `<body>`, positions it under the trigger, and draws the
 * ruled surface.
 *
 * THE GROUP IS HERE RATHER THAN INSIDE `MenuGroupLabel`: Base UI's `Menu.Group`
 * renders `role="group"` and points `aria-labelledby` at the `GroupLabel` inside
 * it. Had the label wrapped its own group, that group would hold the heading and
 * nothing else — assistive technology would announce an empty section beside a
 * run of items belonging to no one. With no label present the label id is absent
 * and `aria-labelledby` is simply omitted.
 */
export function MenuPopup({
  align = "start",
  size = "default",
  children,
}: MenuPopupProps): ReactElement {
  return (
    <BaseMenu.Portal>
      <BaseMenu.Positioner
        data-slot="menu-positioner"
        className={POPUP_LAYER}
        align={align}
        side="bottom"
        sideOffset={4}
      >
        <BaseMenu.Popup
          data-slot="menu-popup"
          className={cn(
            POPUP_SURFACE,
            size === "wide"
              ? // One knob, not two: re-pointing the row token on this subtree is
                // what makes the wider row happen, so `MenuItem` keeps a single recipe.
                "w-[var(--width-menu-wide)] p-0 [--pad-menu-item:var(--pad-menu-item-wide)]"
              : "min-w-[max(var(--anchor-width),var(--width-menu-min))] p-[var(--pad-popup)]",
          )}
        >
          <BaseMenu.Group data-slot="menu-group">{children}</BaseMenu.Group>
        </BaseMenu.Popup>
      </BaseMenu.Positioner>
    </BaseMenu.Portal>
  );
}

export interface MenuGroupLabelProps {
  children?: ReactNode;
}

/**
 * The heading above a group of items: 9px monospace, uppercase, widely tracked,
 * with a hairline under it.
 */
export function MenuGroupLabel({ children }: MenuGroupLabelProps): ReactElement {
  return (
    <BaseMenu.GroupLabel
      data-slot="menu-group-label"
      className="block border-b border-line p-[var(--pad-menu-item)] font-mono text-menu-label font-semibold tracking-menu-label text-ink-soft uppercase"
    >
      {children}
    </BaseMenu.GroupLabel>
  );
}

/**
 * The hairline between a run of rows and the row under it. Hand-written rather
 * than wrapped: Base UI's `Menu` ships no `Separator` part. It has to be a
 * separator to assistive technology and NOT a stop on the keyboard walk, which
 * Base UI's list navigation gives it by only collecting items. It draws edge to
 * edge on purpose: pushed inside a row's padding, the line would read as an
 * underline of the words above it rather than as the seam between two parts.
 */
export function MenuSeparator(): ReactElement {
  return <div data-slot="menu-separator" role="separator" className="border-t border-line" />;
}

export interface MenuItemProps {
  onClick?: () => void;
  disabled?: boolean;
  /**
   * The row the user is looking at right now, carrying the page ground. A prop
   * and not a caller class because `cn` is clsx: a caller's `bg-page` would be
   * emitted alongside the recipe's own background and the winner decided by
   * stylesheet order.
   */
  current?: boolean;
  /** Keeps the menu open after the click — for rows that toggle rather than navigate. */
  keepOpen?: boolean;
  /** Extra `data-*` attributes for the row, written out verbatim. */
  dataAttributes?: Readonly<Record<`data-${string}`, string>>;
  /**
   * The element this row IS.
   *
   * `href` (below) cannot solve the SPA case: the anchor it renders is a native
   * `<a>`, and inside a single-page app every click on one is a full page reload.
   * A router's own link component avoids that, and this package must not import
   * one — it is consumed by apps with different routers. Base UI's `Menu.Item`
   * already accepts `render` for exactly this; passing it through keeps
   * `role="menuitem"`, the roving focus order, `closeOnClick` and the recipe.
   *
   * Takes precedence over `href`: a caller handing over a whole element is saying
   * "this row is mine to render", and a router link carries its own destination.
   */
  render?: ReactElement<Record<string, unknown>>;
  /** Makes the row a real native anchor (marketing-nav case: middle-click, ⌘-click, copy link). */
  href?: string;
  testId?: string;
  children?: ReactNode;
}

/** One interactive row. */
export function MenuItem({
  onClick,
  disabled,
  current = false,
  keepOpen = false,
  dataAttributes,
  href,
  render,
  testId,
  children,
}: MenuItemProps): ReactElement {
  // Three states, resolved once: `render` wins, then `href`'s native anchor,
  // then nothing — which leaves Base UI's own `<div>`.
  const renderAs = render ?? (href === undefined ? undefined : <a href={href} />);
  return (
    <BaseMenu.Item
      data-slot="menu-item"
      data-testid={testId}
      {...dataAttributes}
      {...(disabled === undefined ? {} : { disabled })}
      closeOnClick={!keepOpen}
      onClick={() => { onClick?.(); }}
      {...(renderAs === undefined ? {} : { render: renderAs })}
      className={cn(POPUP_ROW, current && "bg-page")}
    >
      {children}
    </BaseMenu.Item>
  );
}
