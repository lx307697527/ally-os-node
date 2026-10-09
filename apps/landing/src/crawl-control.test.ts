import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// FEAT-096 — crawl control for the staging host. Ported from the old repo's
// src/lib/__tests__/crawl-control.test.js (the it() titles are the testplan's).
//
// The thing being defended is NOT "a noindex header exists" — it is that the
// header is CONDITIONAL. An unconditional X-Robots-Tag would be correct on
// today's staging-only host and would silently de-index the marketing site the
// day production cuts over, with nothing in the diff to explain it. The same
// property is enforced twice: once in vercel.json (this file) and once in the
// generated nginx map (nginx-conf.test.ts), because during the migration the
// site is served from BOTH.

const HERE = dirname(fileURLToPath(import.meta.url));
const LANDING_DIR = join(HERE, "..");
const LANDING_CONFIG = join(LANDING_DIR, "vercel.json");

const ROBOTS_HEADER = "x-robots-tag";

/** The one host this app's staging serves. */
const STAGING_HOST = "dev.allynutra.com";

/** The hosts a crawl-control header must never reach. `allynutra.com` is still
 *  the legacy stack today; the trap is the cutover, not the present. */
const PRODUCTION_HOSTS = ["allynutra.com", "www.allynutra.com"];

interface VercelHeaderRule {
  source: string;
  has?: { type: string; key?: string; value: string }[];
  headers?: { key: string; value: string }[];
}

interface VercelConfig {
  redirects?: unknown[];
  rewrites?: unknown[];
  headers?: VercelHeaderRule[];
}

function readConfig(): VercelConfig {
  expect(existsSync(LANDING_CONFIG), `${LANDING_CONFIG} does not exist`).toBe(true);
  return JSON.parse(readFileSync(LANDING_CONFIG, "utf-8")) as VercelConfig;
}

function crawlControlRules(headerRules: VercelHeaderRule[]): VercelHeaderRule[] {
  return headerRules.filter((rule) =>
    (rule.headers ?? []).some((h) => String(h.key).toLowerCase() === ROBOTS_HEADER),
  );
}

/** THE invariant: every rule that sets X-Robots-Tag is gated on a host
 *  condition that matches the staging host and no production host. */
function assertCrawlControlIsHostScoped(headerRules: VercelHeaderRule[]): void {
  const rules = crawlControlRules(headerRules);
  expect(rules.length, "no header rule sets X-Robots-Tag at all").toBeGreaterThan(0);

  for (const rule of rules) {
    const hostConditions = (rule.has ?? []).filter((c) => c.type === "host");
    expect(
      hostConditions.length,
      `"${rule.source}" sets X-Robots-Tag with no host condition — it would follow this app to production`,
    ).toBeGreaterThan(0);

    for (const condition of hostConditions) {
      expect(Object.keys(condition).sort(), "a host condition takes type + value only").toEqual([
        "type",
        "value",
      ]);
      const hostMatcher = new RegExp(`^${condition.value}$`);
      expect(
        hostMatcher.test(STAGING_HOST),
        `host condition ${condition.value} does not match the staging host`,
      ).toBe(true);
      for (const productionHost of PRODUCTION_HOSTS) {
        expect(
          hostMatcher.test(productionHost),
          `host condition ${condition.value} also matches ${productionHost}`,
        ).toBe(false);
      }
    }
  }
}

describe("apps/landing staging crawl control (vercel.json)", () => {
  it("should tell crawlers not to index any path of the staging host when vercel.json is read", () => {
    const config = readConfig();
    const rules = crawlControlRules(config.headers ?? []);

    expect(rules.length, "expected exactly one crawl-control rule").toBe(1);
    const rule = rules[0];
    if (rule === undefined) return;

    expect(rule.source).toBe("/(.*)");
    const value = (rule.headers ?? []).find(
      (h) => String(h.key).toLowerCase() === ROBOTS_HEADER,
    )?.value;
    expect(value).toBe("noindex, nofollow");
  });

  it("should gate the crawl-control header on the staging host and never match a production host when vercel.json is read", () => {
    assertCrawlControlIsHostScoped(readConfig().headers ?? []);
  });

  it("should fail the host-scoping assertion against a hand-built unconditional noindex", () => {
    const unconditional: VercelHeaderRule[] = [
      {
        source: "/(.*)",
        headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }],
      },
    ];
    expect(() => assertCrawlControlIsHostScoped(unconditional)).toThrow();

    const hostPatternThatAlsoCatchesProduction: VercelHeaderRule[] = [
      {
        source: "/(.*)",
        has: [{ type: "host", value: ".*allynutra\\.com" }],
        headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }],
      },
    ];
    expect(() =>
      assertCrawlControlIsHostScoped(hostPatternThatAlsoCatchesProduction),
    ).toThrow();

    const properlyScoped: VercelHeaderRule[] = [
      {
        source: "/(.*)",
        has: [{ type: "host", value: "dev\\.allynutra\\.com" }],
        headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }],
      },
    ];
    expect(() => assertCrawlControlIsHostScoped(properlyScoped)).not.toThrow();
  });

  // AC-6 — a recorded decision, not a law of nature: a committed robots.txt has
  // the same unconditional problem as a hardcoded header, plus it is a file
  // people forget exists. The sitemap is submitted via Search Console instead.
  // Changing this needs the reasoning changed with it.
  it("should ship no robots.txt when the landing app directory is read", () => {
    for (const candidate of [
      join(LANDING_DIR, "public", "robots.txt"),
      join(LANDING_DIR, "robots.txt"),
    ]) {
      expect(existsSync(candidate), `${candidate} exists`).toBe(false);
    }
  });
});
