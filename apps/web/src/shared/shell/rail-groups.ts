// The rail's table — the regions of the Ally OS back office and everything
// derived from the route against it. Data and pure derivations, no React at
// runtime: the shell renders this table, the pages read it, and the unit
// suite asserts against it directly. Ported from ally-os apps/allyos
// InternalShell.tsx (#129 slice 1).
//
// THE SHELL GOES AND GETS NOTHING. Everything below is derived from the
// ROUTE, which is what keeps it testable as plain functions and honest as
// chrome.
import type { RailIconName } from "./RailIcon.tsx";

export interface RailItem {
  /** The route it points at. */
  readonly to: string;
  /** The row's only line — also the section name the context band prints. */
  readonly label: string;
  /** The stable test/automation anchor, `data-nav`. Label text is neither. */
  readonly nav: string;
  /**
   * Which glyph the row draws. Optional so a row can exist before its mark is
   * chosen — an unnamed glyph must cost the labels nothing, not ragged-edge
   * them (the placeholder branch in `railRow` keeps the column).
   */
  readonly icon?: RailIconName;
}

export interface RailGroup {
  readonly key: string;
  readonly label: string;
  /**
   * What an EMPTY group prints, in the rail and on its region overview page.
   * A rail link to a page that does not exist yet is a dead link; an empty
   * group says what will fill it instead, and the note must be TRUE.
   */
  readonly note: string;
  readonly items: readonly RailItem[];
}

/**
 * The regions of the Ally OS back office, in value-chain order — the same
 * eight the ally-os shell draws, so navigation reads the same. Business pages
 * arrive with their migration slices; until then each group is empty and says
 * which module fills it (see `note`).
 *
 * `home` leads the table and is NOT a business region: it is where a
 * signed-in operator lands. It is a table row rather than a special case
 * because the top bar's tabs are derived from this table — giving it its own
 * branch would introduce a second list of regions to keep in step with this
 * one, which costs more than one extra tab.
 *
 * Exported because the shell's test asserts the markup against THIS table
 * rather than against a second hand-written list that could drift from it.
 */
export const RAIL_GROUPS: readonly RailGroup[] = [
  {
    key: "home",
    label: "Home",
    note: "Where a signed-in operator lands — the company-wide rollup and their own to-dos.",
    items: [
      { to: "/overview", label: "Dashboard", nav: "overview", icon: "overview" },
      { to: "/tasks", label: "Tasks", nav: "tasks", icon: "tasks" },
      { to: "/approvals", label: "Approvals", nav: "approvals", icon: "approvals" },
    ],
  },
  {
    key: "sales",
    label: "Sales",
    note: "Arrives with the revenue module — inquiry through accepted order.",
    items: [],
  },
  {
    key: "support",
    label: "Support",
    note: "Arrives with the quality module — the after-sales desk and traceability.",
    items: [],
  },
  {
    key: "marketing",
    label: "Marketing",
    note: "Arrives with acquisition — the public site, forms and lead capture.",
    items: [],
  },
  {
    key: "procurement",
    label: "Procurement",
    note: "Arrives with the supply-chain module — RFQs, purchase orders and materials.",
    items: [],
  },
  {
    key: "billing",
    label: "Billing",
    note: "Arrives with the finance module — invoices, receipts and refunds.",
    items: [],
  },
  {
    key: "production",
    label: "Production",
    note: "Arrives with the quality & production module — scheduling, batch records and release.",
    items: [],
  },
  {
    key: "system",
    label: "System",
    note: "System administration — the audit log is here; users, roles and the configuration studio follow.",
    items: [
      { to: "/system/audit", label: "Audit log", nav: "audit-log", icon: "ledger" },
    ],
  },
];

/** Every region the chrome offers an entry point to. No group is hidden today. */
export const VISIBLE_RAIL_GROUPS: readonly RailGroup[] = RAIL_GROUPS;

/** Every destination on the rail, in rail order, across every region. */
export const RAIL_ITEMS: readonly RailItem[] = RAIL_GROUPS.flatMap(
  (group) => group.items,
);

/**
 * The product area — the FALLBACK the brand block and the band's crumb print
 * when the route belongs to no region. `Ally OS` is the umbrella name the
 * ally-os business ruled on (issue #1259).
 */
export const PRODUCT_AREA = "Ally OS";

/**
 * The region a route belongs to, or `null` for a route in none. The
 * `/regions/:region` overview routes answer for their key; every other route
 * is matched against the rail's destinations, longest prefix first, so
 * `/quotes/new` would never light `/quotes`'s row.
 */
export function regionForPath(pathname: string): string | null {
  const overview = /^\/regions\/([^/]+)/.exec(pathname);
  const key = overview?.[1];
  if (key !== undefined) {
    return RAIL_GROUPS.some((group) => group.key === key) ? key : null;
  }
  const match = [...RAIL_ITEMS]
    .sort((a, b) => b.to.length - a.to.length)
    .find((entry) => pathname.startsWith(entry.to));
  if (match === undefined) return null;
  return RAIL_GROUPS.find((group) => group.items.includes(match))?.key ?? null;
}

/** What the brand block and the band's crumb name: the region the route is
 *  in, or the product area when it is in none. */
export function areaLabelFor(pathname: string): string {
  const key = regionForPath(pathname);
  return RAIL_GROUPS.find((group) => group.key === key)?.label ?? PRODUCT_AREA;
}

/** The band's title: the rail row the route shows, or "Internal" for a route
 *  in no rail row (the region overviews name themselves in their page). */
export function sectionTitle(pathname: string): string {
  if (pathname === "/") return sectionTitle("/overview");
  const item = [...RAIL_ITEMS]
    .sort((a, b) => b.to.length - a.to.length)
    .find((entry) => pathname.startsWith(entry.to));
  return item?.label ?? "Internal";
}

/**
 * Rail entries whose `to` is a PREFIX of another entry's. `NavLink` matches by
 * path-segment prefix unless `end` is set, so once a nested destination joins
 * the rail its parent lights up too and BOTH rows read as current. Derived
 * rather than hard-coded, so the next nested destination is handled without
 * anyone remembering this rule — and it is derived across ALL groups, because
 * a region this one cannot see can introduce the collision.
 */
export const RAIL_PREFIX_OF_ANOTHER: ReadonlySet<string> = new Set(
  RAIL_ITEMS.filter((item) =>
    RAIL_ITEMS.some((other) => other !== item && other.to.startsWith(`${item.to}/`)),
  ).map((item) => item.to),
);
