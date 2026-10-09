import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TITLES } from "./lib/pages.js";

// The legacy-URL redirect table (#45). vercel.json IS the table — copied
// verbatim from the old deployment — so this suite pins its shape and, more
// importantly, that every site-internal destination is still a page this app
// serves. A redirect to a dead path is worse than no redirect: it converts a
// cached old URL into a soft-404 under the site's own 200 shell.

const HERE = dirname(fileURLToPath(import.meta.url));
const LANDING_DIR = join(HERE, "..");

const config = JSON.parse(readFileSync(join(LANDING_DIR, "vercel.json"), "utf-8")) as {
  redirects: { source: string; destination: string; permanent: boolean }[];
};

/** Paths this app serves: the routed pages (App.jsx redirects `/` to `/home`),
 *  the static quote flow, and the bare root. */
function servedPaths(): Set<string> {
  const paths = new Set<string>(["/", "/quote/", "/home"]);
  for (const key of Object.keys(TITLES)) paths.add(`/${key}`);
  return paths;
}

describe("the legacy redirect table", () => {
  it("carries the old deployment's 45 redirects, all permanent", () => {
    expect(config.redirects).toHaveLength(45);
    for (const rule of config.redirects) {
      expect(rule.permanent, `${rule.source} must stay a permanent (308) redirect`).toBe(true);
    }
  });

  it("has no duplicate sources", () => {
    const sources = config.redirects.map((r) => r.source);
    expect(new Set(sources).size).toBe(sources.length);
  });

  it("redirects the recorded spot checks to the recorded destinations", () => {
    const bySource = new Map(config.redirects.map((r) => [r.source, r.destination]));
    // Legacy SEO landing URLs collapse onto their real service pages.
    expect(bySource.get("/capsules-supplement-manufacturer(/)?")).toBe("/capsule-manufacturing");
    expect(bySource.get("/private-label-supplements(/)?")).toBe("/private-label");
    expect(bySource.get("/custom-formulation-supplements(/)?")).toBe("/services");
    // The old plurals and aliases.
    expect(bySource.get("/faqs(/)?")).toBe("/faq");
    expect(bySource.get("/contact-us(/)?")).toBe("/contact");
    expect(bySource.get("/about-us(/.*)?")).toBe("/about");
    // Quote entry points all meet at the static quote flow.
    expect(bySource.get("/get-quote(/)?")).toBe("/quote/");
    expect(bySource.get("/request-quote(/)?")).toBe("/quote/");
    // Cross-app handoffs still point at the old production hosts until those
    // apps migrate; repointing them is a later slice with its own cutover.
    expect(bySource.get("/auth(/)?")).toBe("https://portal.allynutra.com/login");
    expect(bySource.get("/admin")).toBe("https://allyos.allynutra.com/");
    expect(bySource.get("/sms-optin(/)?")).toBe("https://portal.allynutra.com/sms-optin");
  });

  it("never redirects into a dead site-internal path", () => {
    const served = servedPaths();
    for (const rule of config.redirects) {
      if (rule.destination.startsWith("https://")) continue;
      expect(
        served.has(rule.destination),
        `${rule.source} → ${rule.destination}, which this app does not serve`,
      ).toBe(true);
    }
  });

  it("keeps the quote entry points pointing at the quote flow, not at each other", () => {
    // A redirect chain (/get-quote → /request-quote → /quote/) would work in a
    // browser but costs a round trip per hop and confuses analytics; the old
    // table is flat by design.
    for (const source of ["/get-quote(/)?", "/request-quote(/)?", "/quote-requested(/)?"]) {
      const rule = config.redirects.find((r) => r.source === source);
      expect(rule?.destination).toBe("/quote/");
    }
  });
});
