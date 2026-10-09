import { describe, expect, it } from "vitest";
import {
  NOINDEX_KEYS,
  SERVICE_KEYS,
  TITLES,
  canonicalUrl,
  pageKeyFromPathname,
  SITE_ORIGIN,
} from "./lib/pages.js";

// Coverage for the marketing site's route vocabulary. Ported from the old
// repo's src/lib/__tests__/pages.test.js — the failure this defends against is
// quiet: a route added with no entry here ships `undefined` as its document
// title, which is what a search engine indexes and what a shared link shows.
//
// The JS module is inferred through allowJs; widening to Record<string,string>
// lets the loops index it with arbitrary keys the way the original test did.
const TITLES_TABLE: Record<string, string> = TITLES;

describe("SERVICE_KEYS", () => {
  it("names the services hub plus its five child routes", () => {
    expect([...SERVICE_KEYS]).toEqual([
      "services",
      "contract-manufacturing",
      "private-label",
      "capsule-manufacturing",
      "vitamin-manufacturing",
      "stick-pack-manufacturing",
    ]);
  });

  it("includes the hub itself, so the dropdown stays active on /services", () => {
    expect(SERVICE_KEYS).toContain("services");
  });

  it("has a title for every service key", () => {
    for (const key of SERVICE_KEYS) {
      expect(TITLES_TABLE[key]).toBeTruthy();
    }
  });

  it("has no duplicates", () => {
    expect(new Set(SERVICE_KEYS).size).toBe(SERVICE_KEYS.length);
  });

  it("does not claim a non-service page is a service view", () => {
    for (const key of ["home", "about", "contact", "faq", "facility", "certifications"]) {
      expect(SERVICE_KEYS).not.toContain(key);
    }
  });
});

describe("TITLES", () => {
  it("titles every page the site routes to", () => {
    for (const key of [
      "home",
      "services",
      "facility",
      "certifications",
      "about",
      "faq",
      "contact",
      "contract-manufacturing",
      "private-label",
      "capsule-manufacturing",
      "vitamin-manufacturing",
      "stick-pack-manufacturing",
      "work-with-us",
      "work-with-us-b",
      "thank-you-booked",
      "privacy-policy",
      "terms-of-service",
    ]) {
      expect(TITLES_TABLE[key]).toBeTruthy();
    }
  });

  it("brands every title", () => {
    for (const title of Object.values(TITLES)) {
      expect(title).toContain("Ally Nutra");
    }
  });

  it("separates the page from the brand with a pipe on every page but home", () => {
    for (const [key, title] of Object.entries(TITLES)) {
      if (key === "home") continue;
      expect(title).toMatch(/ \| Ally Nutra$/);
    }
  });

  it("gives home the brand-first form", () => {
    expect(TITLES_TABLE.home).toBe("Ally Nutra — Contract supplement manufacturing");
    expect(TITLES_TABLE.home).not.toContain(" | ");
  });

  it("has no empty or duplicated title", () => {
    const titles = Object.values(TITLES);
    for (const title of titles) expect(title.trim()).not.toBe("");
    expect(new Set(titles).size).toBe(titles.length);
  });

  it("does not title a format or page the site does not present", () => {
    // Tablets are deactivated site-wide (FEAT-310, owner decision 2026-09-02).
    for (const title of Object.values(TITLES)) {
      expect(title.toLowerCase()).not.toContain("tablet");
    }
  });
});

describe("canonicalUrl", () => {
  it("canonicalises home to the bare origin", () => {
    expect(canonicalUrl("home")).toBe(`${SITE_ORIGIN}/`);
  });

  it("canonicalises every indexed page to its own absolute path", () => {
    for (const key of Object.keys(TITLES)) {
      if (key === "home" || NOINDEX_KEYS.has(key)) continue;
      expect(canonicalUrl(key)).toBe(`${SITE_ORIGIN}/${key}`);
    }
  });

  it("names no canonical for a noindex page", () => {
    for (const key of NOINDEX_KEYS) {
      expect(canonicalUrl(key)).toBeNull();
    }
  });

  it("returns null for a key that is not a page", () => {
    expect(canonicalUrl("not-a-page")).toBeNull();
  });
});

describe("pageKeyFromPathname", () => {
  it("strips the leading slash", () => {
    expect(pageKeyFromPathname("/contact")).toBe("contact");
    expect(pageKeyFromPathname("/stick-pack-manufacturing")).toBe("stick-pack-manufacturing");
  });

  it("maps the root path to home", () => {
    expect(pageKeyFromPathname("/")).toBe("home");
  });

  it("maps an empty pathname to home", () => {
    expect(pageKeyFromPathname("")).toBe("home");
  });

  it("strips only the FIRST slash, so a nested path stays distinguishable", () => {
    expect(pageKeyFromPathname("/services/private-label")).toBe("services/private-label");
    expect(TITLES_TABLE[pageKeyFromPathname("/services/private-label")]).toBeUndefined();
  });

  it("resolves every titled key back from its own path", () => {
    for (const key of Object.keys(TITLES)) {
      const path = key === "home" ? "/" : `/${key}`;
      expect(pageKeyFromPathname(path)).toBe(key);
    }
  });

  it("leaves a key with no leading slash alone", () => {
    expect(pageKeyFromPathname("about")).toBe("about");
  });
});
