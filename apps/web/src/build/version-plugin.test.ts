// The build side of the version watch (#129 slice 3), checked as units (the
// id resolution and the two artifacts are pure) plus source-text rulings on
// the plugin that wires them — the same jsdom-free split the runtime suites
// use. What this guards: one id, two ends — the bundle's `__ALLY_BUILD_ID__`
// and dist/version.json MUST carry the same build id, or the watch either
// cries wolf on every load or never fires at all.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  BUILD_ID_DEFINE,
  VERSION_FILE_NAME,
  resolveBuildId,
  versionAsset,
  versionDefine,
  versionJsonSource,
} from "./version-plugin.ts";

const SRC = dirname(dirname(fileURLToPath(import.meta.url)));

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("resolveBuildId", () => {
  it("prefers the git short SHA — one commit, one id", () => {
    expect(resolveBuildId({ git: () => "9a3f2c1" })).toBe("9a3f2c1");
  });

  it("falls back to the build timestamp when no repository answers", () => {
    expect(resolveBuildId({ git: () => null, now: () => 1_700_000_000_000 })).toBe(
      (1_700_000_000_000).toString(36),
    );
  });

  it("treats an empty git answer as no answer (a repo with no commits)", () => {
    expect(resolveBuildId({ git: () => "", now: () => 5 })).toBe((5).toString(36));
  });
});

describe("the two artifacts", () => {
  it("version.json names its build id (and is valid JSON with the same id)", () => {
    const asset = versionAsset("9a3f2c1", "2026-10-05T12:00:00.000Z");
    expect(asset.fileName).toBe(VERSION_FILE_NAME);
    expect(asset.type).toBe("asset");
    expect(JSON.parse(asset.source)).toEqual({ buildId: "9a3f2c1", builtAt: "2026-10-05T12:00:00.000Z" });
  });

  it("the define pins the id as a string literal under the agreed name", () => {
    expect(versionDefine("9a3f2c1")).toEqual({ [BUILD_ID_DEFINE]: '"9a3f2c1"' });
  });

  it("versionJsonSource ends in a newline and serializes the file shape", () => {
    const source = versionJsonSource({ buildId: "x", builtAt: "t" });
    expect(source.endsWith("\n")).toBe(true);
    expect(JSON.parse(source)).toEqual({ buildId: "x", builtAt: "t" });
  });
});

describe("versionPlugin wiring", () => {
  // SRC = apps/web/src; the plugin lives beside this test, the vite config
  // one level above src.
  const plugin = stripComments(readFileSync(join(SRC, "build", "version-plugin.ts"), "utf8"));
  const viteConfig = stripComments(readFileSync(join(SRC, "..", "vite.config.ts"), "utf8"));

  it("the plugin feeds the SAME build id into define and the emitted asset", () => {
    // One `buildId` binding is closed over by both hooks; this pins the
    // structure so a future edit cannot let the two ends drift.
    expect(plugin).toContain("config() {");
    expect(plugin).toContain("versionDefine(buildId)");
    expect(plugin).toContain("this.emitFile(versionAsset(buildId,");
  });

  it("vite.config installs the plugin with a resolved id — both ends live", () => {
    expect(viteConfig).toContain("versionPlugin({ buildId: resolveBuildId() })");
  });
});

