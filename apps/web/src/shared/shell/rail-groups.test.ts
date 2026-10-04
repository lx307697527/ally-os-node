// The rail table, asserted as data — the shell's markup is generated from
// RAIL_GROUPS, so asserting the table asserts the chrome. The text-level
// counterpart (rail rendered as note vs rows) is checked in
// internal-shell.test.ts by scanning the component source.
import { describe, expect, it } from "vitest";

import {
  RAIL_GROUPS,
  RAIL_ITEMS,
  VISIBLE_RAIL_GROUPS,
  areaLabelFor,
  regionForPath,
  sectionTitle,
} from "./rail-groups.ts";

describe("rail table", () => {
  it("home leads the table and is not a business region", () => {
    expect(RAIL_GROUPS[0]?.key).toBe("home");
  });

  it("every group carries a key, a label and a note; keys are unique", () => {
    const keys = RAIL_GROUPS.map((group) => group.key);
    for (const group of RAIL_GROUPS) {
      expect(group.key, "group key").toBeTruthy();
      expect(group.label, "group label").toBeTruthy();
      expect(group.note, `${group.key} note`).toBeTruthy();
    }
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("every LIVE row has a unique destination, anchor and mark", () => {
    const tos = RAIL_ITEMS.map((item) => item.to);
    const navs = RAIL_ITEMS.map((item) => item.nav);
    const icons = RAIL_ITEMS.filter((item) => item.icon !== undefined).map((item) => item.icon);
    for (const item of RAIL_ITEMS) {
      expect(item.to.startsWith("/"), `${item.nav} destination is app-internal`).toBe(true);
      expect(item.label, `${item.nav} label`).toBeTruthy();
    }
    expect(new Set(tos).size, "no two rows share a destination").toBe(tos.length);
    expect(new Set(navs).size, "no two rows share an anchor").toBe(navs.length);
    // The 2026-09-14 ruling (ally-os): no two rows share a mark.
    expect(new Set(icons).size, "no two rows share a glyph").toBe(icons.length);
  });

  it("every EMPTY group says truthfully what fills it", () => {
    for (const group of RAIL_GROUPS) {
      if (group.items.length > 0) continue;
      // A note in the past tense ("Arrives") would be a lie the day the group
      // fills; the discipline is the note is GONE when the items land.
      expect(group.note, `${group.key} explains its emptiness`).toMatch(/Arrives|lands/);
    }
  });

  it("the chrome offers an entry point to every group", () => {
    expect(VISIBLE_RAIL_GROUPS).toEqual(RAIL_GROUPS);
  });
});

describe("route derivations", () => {
  it("regionForPath answers from the rail and the region overviews", () => {
    expect(regionForPath("/overview")).toBe("home");
    expect(regionForPath("/regions/sales")).toBe("sales");
    expect(regionForPath("/regions/no-such-region")).toBeNull();
    expect(regionForPath("/nowhere")).toBeNull();
  });

  it("the band and the brand block name the route's region, or Ally OS", () => {
    expect(areaLabelFor("/overview")).toBe("Home");
    expect(areaLabelFor("/regions/procurement")).toBe("Procurement");
    expect(areaLabelFor("/nowhere")).toBe("Ally OS");
  });

  it("sectionTitle names the rail row the route shows", () => {
    expect(sectionTitle("/overview")).toBe("Dashboard");
    expect(sectionTitle("/")).toBe("Dashboard");
    expect(sectionTitle("/nowhere")).toBe("Internal");
  });
});
