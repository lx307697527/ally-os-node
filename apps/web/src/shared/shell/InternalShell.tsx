// The authenticated shell: navy top bar with one tab per region, the grouped
// rail, the context band and the session cluster. Ported from ally-os
// apps/allyos InternalShell.tsx (#129 slice 1), reduced to what this repo's
// rail has today and restructured where this repo differs.
//
// WHAT IS NOT HERE YET, AND WHERE IT RETURNS:
//   · pinned pages  — issue #129 later slice (needs the pin model)
//   · notification bell — issue #129 later slice (needs the notifications
//     domain); the shell takes no slot yet, the header keeps the session
//     cluster only
//   · record chip / parent crumb — return with the first record route
//   · per-role menu visibility — #23 RBAC; until then every group renders and
//     the rail answers "where is it", not "may you see it"
//
// THE SHELL GOES AND GETS NOTHING. It reads no application data: it renders
// the identity its caller hands it, and derives everything else from the
// ROUTE (see ./rail-groups.ts). That is what keeps it testable as text and
// honest as chrome.
import { type ReactElement, type ReactNode } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";

import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@ally/ui";
import { sessionIdentityDisplay, type SessionIdentity } from "../lib/session-identity.ts";
import {
  RAIL_GROUPS,
  RAIL_PREFIX_OF_ANOTHER,
  VISIBLE_RAIL_GROUPS,
  areaLabelFor,
  regionForPath,
  sectionTitle,
  type RailItem,
} from "./rail-groups.ts";
import { RailIcon } from "./RailIcon.tsx";
import { ShellContextBand, ShellFrame, ShellHeader, ShellRail, ShellRailCaption, ShellRailGroup } from "./ShellFrame.tsx";

/** The chip's copy when nobody has said who is signed in — the shell's state
 *  before it is handed an identity. */
const BRAND_INITIALS = "AN";
const SIGNED_IN_LABEL = "Signed in";

export function InternalShell({
  children,
  onSignOut,
  identity,
}: {
  children?: ReactNode;
  /** Optional because a shell rendered outside the auth gate has no session to end. */
  onSignOut?: () => void;
  /**
   * WHO is signed in, as the composition root resolved it. Optional; absent
   * means the chip keeps the brand initials and the words `Signed in`.
   */
  identity?: SessionIdentity | undefined;
}): ReactElement {
  const location = useLocation();
  const { pathname } = location;
  const section = sectionTitle(pathname);
  const areaLabel = areaLabelFor(pathname);
  const railRegion = regionForPath(pathname);
  const sessionDisplay = identity === undefined ? null : sessionIdentityDisplay(identity);

  /**
   * One region of the rail. `key` is the address rather than the item, because
   * the same item can one day render at two addresses on one rail.
   */
  function railRow(item: RailItem, to: string = item.to): ReactElement {
    return (
      <NavLink className="relative flex items-center gap-3 rounded-small p-[var(--rail-row-pad)] text-[length:var(--fs-body)] leading-[var(--lh-ui)] text-[var(--rail-ink)] no-underline transition-colors duration-[var(--dur)] ease-[var(--ease)] hover:bg-[var(--surface-rail-active)] hover:text-[var(--rail-ink-strong)] hover:no-underline aria-[current=page]:bg-[var(--surface-rail-active)] aria-[current=page]:font-medium aria-[current=page]:text-[var(--rail-ink-strong)] aria-[current=page]:before:absolute aria-[current=page]:before:inset-y-2 aria-[current=page]:before:left-0 aria-[current=page]:before:w-[var(--rail-marker-w)] aria-[current=page]:before:rounded-r-card aria-[current=page]:before:bg-accent"
        key={to}
        to={to}
        data-nav={item.nav}
        end={RAIL_PREFIX_OF_ANOTHER.has(to)}
      >
        {item.icon !== undefined ? (
          <RailIcon name={item.icon} />
        ) : (
          /* Keeps the glyph column, so a region that has not named a
             mark does not ragged-edge every label beside it. */
          <span className="size-[var(--rail-glyph-size)] shrink-0" aria-hidden="true" />
        )}
        <span data-rail-name className="min-w-0 text-ui font-medium">{item.label}</span>
      </NavLink>
    );
  }

  return (
    <ShellFrame>
      <ShellHeader>
        <div className="flex min-w-[var(--nav-width)] shrink-0 items-center gap-3 p-[var(--pad-brand)]">
          {/* The canonical logo, the same `logo-white.png` the sign-in bar
              renders — the two bars cannot drift apart by accident. */}
          <img className="block h-[var(--logo-height)] w-auto" src="/logo-white.png" alt="Ally Nutra" />
          {/* Names the CURRENT REGION, from the same `areaLabel` the band's
              crumb prints two inches below it — derived ONCE, so the bar and
              the band cannot disagree about where the operator is. */}
          <span className="inline-flex items-center whitespace-nowrap font-mono text-[length:var(--fs-rail-caption)] tracking-[var(--ls-crumb)] text-[var(--text-on-navy-mute)] uppercase" data-testid="brand-area">{areaLabel}</span>
        </div>
        {/* ONE TAB PER REGION. The bar answers WHICH REGION, the rail answers
            WHICH PAGE INSIDE IT. `Link`, NOT `NavLink`: react-router-dom 6
            silently drops a passed `aria-current` whenever the NavLink's own
            `to` is not active, so the bar lost its current region on every
            page but one per region; a plain `Link` passes the attribute
            through and `regionForPath` is the one source of "which region".
            A region with no destinations yet links to its own overview route,
            so its tab still opens something instead of being dead. */}
        <div className="flex min-w-0 items-stretch gap-1 overflow-hidden">
          {VISIBLE_RAIL_GROUPS.map((group) => (
            <Link
              key={group.key}
              className="inline-flex h-full items-center px-3 text-ui whitespace-nowrap text-[var(--text-on-navy-soft)] no-underline hover:text-[var(--text-on-navy)] hover:no-underline aria-[current=page]:text-[var(--text-on-navy)] aria-[current=page]:shadow-[inset_0_calc(var(--rule-tab)*-1)_0_var(--ally-amber)]"
              data-region-tab={group.key}
              to={group.items[0]?.to ?? `/regions/${group.key}`}
              aria-current={railRegion === group.key ? "page" : undefined}
            >
              {group.label}
            </Link>
          ))}
        </div>
        <span className="flex-1" />
        <div className="flex shrink-0 items-center gap-3">
          {onSignOut && (
            // `data-testid` sits on a wrapper because `Menu` renders no element
            // of its own.
            <span data-testid="session-cluster" className="relative inline-flex">
              <Menu>
                <MenuTrigger
                  // The navy chrome the session chip reads as its default tone;
                  // a className and not a component default, because this
                  // family's other call sites sit on light surfaces.
                  className="rounded-pill py-1 pr-2 pl-1 text-ui text-[var(--text-on-navy-soft)] hover:bg-[var(--surface-navy-2)]"
                >
                  <span className="grid size-[var(--session-avatar-size)] shrink-0 place-items-center rounded-pill bg-[var(--surface-navy-2)] font-mono text-[length:var(--text-mono-sm)] font-semibold text-[var(--text-on-navy)] shadow-[inset_0_0_0_var(--border-width)_var(--rule-on-navy)]" aria-hidden="true" data-testid="session-initials">
                    {sessionDisplay?.initials ?? BRAND_INITIALS}
                  </span>
                  <span className="whitespace-nowrap" data-testid="session-label">
                    {sessionDisplay?.label ?? SIGNED_IN_LABEL}
                  </span>
                </MenuTrigger>
                <MenuPopup align="end">
                  {/* The address, not the name: the chip is narrow and shows
                      the name, and the address is the unambiguous answer to
                      "which account". A plain span rather than a MenuItem: it
                      is not a choice, so it must not claim role="menuitem"
                      and take a turn in the arrow-key walk. */}
                  {identity?.email ? (
                    <span
                      className="block border-b border-line px-2 pt-1 pb-2 text-ui-sm break-all text-ink-soft"
                      data-testid="session-email"
                    >
                      {identity.email}
                    </span>
                  ) : null}
                  <MenuItem testId="sign-out" onClick={onSignOut}>
                    Sign out
                  </MenuItem>
                </MenuPopup>
              </Menu>
            </span>
          )}
        </div>
      </ShellHeader>
      <div className="flex min-h-0 flex-1">
        <ShellRail aria-label="Internal navigation">
          {RAIL_GROUPS.map((group) => (
            // A group with no pages yet prints WHY instead of shipping a dead
            // link — the same discipline ally-os applies, and for the same
            // reason: an empty state that reads like "nothing happened" is a
            // lie; a note that says what arrives is not.
            <ShellRailGroup key={group.key} data-rail-group={group.key}>
              <ShellRailCaption>{group.label}</ShellRailCaption>
              {group.items.length === 0 ? (
                <span
                  className="px-3 pb-1 text-[length:var(--fs-meta)] leading-[var(--lh-ui)] text-[var(--rail-ink-mute)]"
                  data-testid={`rail-group-empty-${group.key}`}
                >
                  {group.note}
                </span>
              ) : (
                group.items.map((item) => railRow(item))
              )}
            </ShellRailGroup>
          ))}
        </ShellRail>
        <div className="flex min-w-0 flex-1 flex-col border-l border-line">
          <ShellContextBand data-testid="context-band">
            <div className="min-w-0">
              {/* The crumb names the region, then where you are. The parent
                  link (the way BACK on record routes) returns with the first
                  record route. */}
              <div className="whitespace-nowrap font-mono text-[length:var(--fs-crumb)] tracking-[var(--ls-crumb)] text-ink-soft uppercase max-[899px]:overflow-hidden max-[899px]:text-ellipsis" data-testid="context-crumb">
                {areaLabel} · {section}
              </div>
              <h1 className="mt-[calc(var(--space-1)-var(--border-width))] mb-0 font-slab text-[length:var(--fs-h3)] font-semibold tracking-[var(--ls-display)] text-ink" data-testid="context-title">
                {section}
              </h1>
            </div>
            <span className="flex-1" />
          </ShellContextBand>
          <div className="px-[var(--layout-pad)] pt-8 pb-12 max-[899px]:pt-6 max-[899px]:pb-8">{children}</div>
        </div>
      </div>
    </ShellFrame>
  );
}
