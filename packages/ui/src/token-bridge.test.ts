// The token bridge, checked as text — the same "read the stylesheet source"
// discipline the ally-os conformance suites use (jsdom does neither
// custom-property inheritance nor cross-scope cascade, so rendered values
// cannot be asserted here). Ported from ally-os packages/ui (#129 slice 1),
// minus the coexistence half that compared against apps/allyos's index.css:
// this repo has ONE canonical token layer from day one.
//
// Two halves, both load-bearing:
//  1. every name theme.css references exists in tokens.css (a dangling var()
//     would silently render as the fallback chain's next best guess);
//  2. tokens.css keeps the full scale and resolves its own alias graph.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = dirname(fileURLToPath(import.meta.url));

const tokensCss = readFileSync(join(SRC, "tokens.css"), "utf8");
const themeCss = readFileSync(join(SRC, "theme.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

function declarationsOf(css: string): Map<string, string> {
  const found = new Map<string, string>();
  const block = /:root\s*\{([^}]*)\}/g;
  for (let hit = block.exec(css); hit !== null; hit = block.exec(css)) {
    const body = hit[1];
    if (body === undefined) continue;
    for (const decl of body.split(";")) {
      const colon = decl.indexOf(":");
      if (colon < 0) continue;
      const name = decl.slice(0, colon).trim();
      if (name.startsWith("--")) found.set(name, decl.slice(colon + 1).trim());
    }
  }
  return found;
}

const tokens = declarationsOf(tokensCss);

describe("token bridge", () => {
  it("every custom property theme.css references is defined in tokens.css", () => {
    const references = [...themeCss.matchAll(/var\((--[\w-]+)\)/g)]
      .map((m) => m[1])
      .filter((name) => name !== undefined);
    expect(references.length).toBeGreaterThan(0);
    const missing = [...new Set(references)].filter((name) => !tokens.has(name));
    expect(missing, `theme.css references names tokens.css never defines: ${missing.join(", ")}`).toEqual([]);
  });

  it("canonical tokens keep the full scale and resolve every token alias", () => {
    expect(tokens.size).toBeGreaterThan(100);
    const aliases = [...tokensCss.matchAll(/var\((--[\w-]+)\)/g)]
      .map((match) => match[1])
      .filter((name) => name !== undefined);
    expect(aliases.length).toBeGreaterThan(0);
    const missing = [...new Set(aliases)].filter((name) => !tokens.has(name));
    expect(missing, `tokens.css references names it never defines: ${missing.join(", ")}`).toEqual([]);
  });
});
