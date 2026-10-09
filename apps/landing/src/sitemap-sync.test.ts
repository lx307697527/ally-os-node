import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NOINDEX_KEYS, SITE_ORIGIN, TITLES, canonicalUrl } from "./lib/pages.js";

// The sitemap is a HAND-MAINTAINED static file. The old repo kept it in sync
// with pages.js "by convention — nothing checks them against each other yet"
// (its own words). This port closes that gap: the sitemap must list exactly
// the canonical set, so a route added without a sitemap entry is invisible to
// search engines, and a sitemap entry for a dead route poisons crawling —
// both fail here instead.

const HERE = dirname(fileURLToPath(import.meta.url));
const SITEMAP = readFileSync(join(HERE, "..", "public", "sitemap.xml"), "utf-8");

function sitemapUrls(): string[] {
  return [...SITEMAP.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1] ?? "");
}

function expectedUrls(): string[] {
  const urls: string[] = [];
  for (const key of Object.keys(TITLES)) {
    if (NOINDEX_KEYS.has(key)) continue;
    const url = canonicalUrl(key);
    if (typeof url === "string") urls.push(url);
  }
  return urls.sort();
}

describe("public/sitemap.xml ↔ pages.js", () => {
  it("lists exactly the canonical set — no more, no fewer", () => {
    expect(sitemapUrls().sort()).toEqual(expectedUrls());
  });

  it("carries every URL with the production origin, absolutely", () => {
    for (const url of sitemapUrls()) {
      expect(url.startsWith(`${SITE_ORIGIN}/`), `${url} is not absolute`).toBe(true);
    }
  });

  it("omits the noindex pages", () => {
    for (const key of NOINDEX_KEYS) {
      expect(SITEMAP).not.toContain(`/${key}<`);
    }
  });

  it("lists home as the bare origin, not /home", () => {
    expect(SITEMAP).toContain(`<loc>${SITE_ORIGIN}/</loc>`);
    expect(SITEMAP).not.toContain(`<loc>${SITE_ORIGIN}/home</loc>`);
  });
});
