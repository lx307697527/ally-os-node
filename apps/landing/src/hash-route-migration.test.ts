import { describe, expect, it } from "vitest";
import { hashRouteToPath } from "./lib/hashRouteMigration.js";

// FEAT-586 — catching the old hash addresses after the move to path routing.
// Ported from the old repo's src/lib/__tests__/hash-route-migration.test.js.
//
// Until the 2026 change every marketing page lived after a `#`: `/#/about`.
// Those addresses are indexed, printed in ads, and cached as PERMANENT (308)
// redirects by every browser that ever visited — deleting the server rule does
// not un-cache them. Only something running IN the page can undo it, which is
// why main.jsx rewrites the address before first render instead of a server
// redirect existing.
//
// RETURNING null IS LOAD-BEARING. It means "nothing to migrate" and main.jsx
// skips replaceState on that answer. Rewriting unconditionally would eat
// `#book`, the in-page anchor on /work-with-us.

describe("[FEAT-586] hashRouteToPath", () => {
  describe("addresses that must be migrated", () => {
    it("should turn a bare hash route into the matching path", () => {
      expect(hashRouteToPath("/", "#/about", "")).toBe("/about");
      expect(hashRouteToPath("/", "#/work-with-us", "")).toBe("/work-with-us");
    });

    it("should keep the role prefix in front of the migrated route", () => {
      expect(hashRouteToPath("/visitor/", "#/about", "")).toBe("/visitor/about");
      expect(hashRouteToPath("/visitor", "#/about", "")).toBe("/visitor/about");
    });

    it("should preserve a query string that sat before the fragment", () => {
      // `https://…/?utm_source=google#/work-with-us` is the shape a paid click
      // arrives in. Dropping the query would silently break attribution.
      expect(hashRouteToPath("/", "#/work-with-us", "?utm_source=google")).toBe(
        "/work-with-us?utm_source=google",
      );
    });

    it("should carry a query string that sat inside the fragment", () => {
      expect(hashRouteToPath("/", "#/contact?ref=email", "")).toBe("/contact?ref=email");
    });

    it("should keep both query strings when the fragment and the path each carried one", () => {
      expect(hashRouteToPath("/", "#/contact?ref=email", "?utm_source=google")).toBe(
        "/contact?utm_source=google&ref=email",
      );
    });

    it("should migrate the bare root route to the site root when the fragment was just a slash", () => {
      expect(hashRouteToPath("/", "#/", "")).toBe("/");
    });
  });

  describe("addresses that must be left alone", () => {
    it("should return null when there is no fragment at all", () => {
      expect(hashRouteToPath("/about", "", "")).toBeNull();
      expect(hashRouteToPath("/", "", "")).toBeNull();
    });

    it("should return null for an in-page anchor so a fragment is never read as a route", () => {
      expect(hashRouteToPath("/work-with-us", "#book", "")).toBeNull();
      expect(hashRouteToPath("/work-with-us", "#", "")).toBeNull();
    });

    it("should return null for a fragment that does not open a path so only `#/` migrates", () => {
      expect(hashRouteToPath("/", "#about", "")).toBeNull();
      expect(hashRouteToPath("/", "#!/about", "")).toBeNull();
    });
  });
});
