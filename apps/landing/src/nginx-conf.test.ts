import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateFromRepo, sourceToLocation } from "../scripts/gen-nginx-conf.mjs";

// The committed nginx.conf is the generator's OUTPUT (scripts/gen-nginx-conf.mjs
// compiling vercel.json). This file is the drift-guard: regenerate and diff, so
// nobody edits either side by hand and the two deployments stop agreeing.
//
// It also pins the nginx-side crawl-control property: the $host map's default
// is empty (nginx omits an empty add_header value), so the noindex header can
// only ever be emitted on the staging host.

const HERE = dirname(fileURLToPath(import.meta.url));
const LANDING_DIR = join(HERE, "..");

describe("generated nginx.conf", () => {
  it("is byte-identical to a fresh generation from vercel.json", () => {
    const committed = readFileSync(join(LANDING_DIR, "nginx.conf"), "utf-8");
    expect(generateFromRepo()).toBe(committed);
  });

  it("redirects every legacy source with a 308", () => {
    const config = JSON.parse(
      readFileSync(join(LANDING_DIR, "vercel.json"), "utf-8"),
    ) as { redirects: { source: string; destination: string }[] };
    const conf = generateFromRepo();
    expect(config.redirects.length, "the redirect table is the old one, verbatim").toBe(45);
    for (const rule of config.redirects) {
      const loc = sourceToLocation(rule.source);
      const locationLine =
        loc.kind === "exact"
          ? `location = ${loc.path} {`
          : `location ~ ${loc.pattern} {`;
      expect(conf, `missing location for ${rule.source}`).toContain(locationLine);
      expect(
        conf.includes(`return 308 ${rule.destination};`),
        `missing 308 to ${rule.destination} for ${rule.source}`,
      ).toBe(true);
    }
  });

  it("keeps the crawl-control map host-scoped with an empty default", () => {
    const conf = generateFromRepo();
    expect(conf).toMatch(/map \$host \$crawl_control \{\n {4}default "";/);
    expect(conf).toContain('~^dev\\.allynutra\\.com$ "noindex, nofollow";');
    // And nothing else in the map: a second, broader branch could follow the
    // app to production.
    expect(conf.match(/~\^/g)?.length).toBe(1);
  });

  it("serves the prototype mock prefixes an honest 404 instead of the homepage", () => {
    const conf = generateFromRepo();
    expect(conf).toContain("location ~ ^/(visitor|super-admin|employee)(/|$) {");
    const blockStart = conf.indexOf("location ~ ^/(visitor|super-admin|employee)(/|$) {");
    const blockEnd = conf.indexOf("}", conf.indexOf("return 404;", blockStart));
    expect(blockStart).toBeGreaterThan(-1);
    expect(conf.slice(blockStart, blockEnd)).toContain("return 404;");
  });

  it("keeps /quote out of the generic redirect compiler (the infinite-loop guard)", () => {
    // `/quote → /quote/` must be the exact-match location, never the regex
    // ^/quote(/.*)?$ — see gen-nginx-conf.mjs's module comment.
    const conf = generateFromRepo();
    expect(conf).toContain("location = /quote {");
    expect(conf).toContain("location ^~ /quote/ {");
    expect(conf).not.toContain("location ~ ^/quote(/.*)?$");
  });

  it("serves directory indexes in the SPA fallback so /schedule/ keeps working", () => {
    expect(generateFromRepo()).toContain("try_files $uri $uri/ /index.html;");
  });
});
