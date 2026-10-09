import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NOINDEX_KEYS, TITLES } from "./lib/pages.js";

// NEW GUARD for the port (#45 slice 1). The old repo's pages.test.js checked
// TITLES against a hand-maintained key list; this version derives the route
// list from App.jsx's source instead, so a route added without a title — or a
// title left pointing at a deleted route — fails here rather than shipping
// `undefined` into a search result. Source-text over real-browser matches the
// repo's testing culture; App.jsx is a literal, stable file.
const HERE = dirname(fileURLToPath(import.meta.url));
const APP_SOURCE = readFileSync(join(HERE, "App.jsx"), "utf-8");

const TITLES_TABLE: Record<string, string> = TITLES;

function routedPaths(): string[] {
  const paths: string[] = [];
  for (const m of APP_SOURCE.matchAll(/<Route path="([^"]+)"/g)) {
    const path = m[1];
    if (path === undefined) continue;
    if (path === "/" || path === "*") continue; // client redirect + catch-all
    paths.push(path);
  }
  return paths;
}

describe("App.jsx routes ↔ pages.js TITLES", () => {
  it("routes exactly the titled pages", () => {
    expect(routedPaths().sort()).toEqual(
      Object.keys(TITLES)
        .map((key) => `/${key}`)
        .sort(),
    );
  });

  it("titles every routed page", () => {
    for (const path of routedPaths()) {
      const key = path.slice(1);
      expect(TITLES_TABLE[key], `no title for routed page ${path}`).toBeTruthy();
    }
  });

  it("keeps the noindex set inside the routed pages", () => {
    for (const key of NOINDEX_KEYS) {
      expect(routedPaths(), `noindex key ${key} is not routed`).toContain(`/${key}`);
    }
  });

  it("marks noindex pages in the source, not just in the set", () => {
    // The chrome branch reads NOINDEX_KEYS; this only pins that the set is the
    // single source (no stray per-route robots meta smuggled into a view).
    for (const key of NOINDEX_KEYS) {
      const view = readFileSync(join(HERE, "views", `${keyToView(key)}.jsx`), "utf-8");
      expect(view.includes('name="robots"'), `${key} sets its own robots meta`).toBe(false);
    }
  });
});

function keyToView(key: string): string {
  return key
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}
