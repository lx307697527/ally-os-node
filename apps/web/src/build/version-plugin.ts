// The build side of the version watch (#129 slice 3): every production build
// emits a `version.json` carrying its build id, and the same id is compiled
// into the bundle as `__ALLY_BUILD_ID__`. The old system (ally-os
// deployment-watch.ts) needed no version file because it compared the hashed
// entry script inside index.html; here the issue's design prescribes
// `/version.json` + 构建号 instead, which nginx serves verbatim out of dist
// (the SPA fallback only answers misses) with the same no-cache policy as
// index.html.
//
// Build id source: the git short SHA when a repository is present — one
// commit, one id, a redeploy of the same commit stays quiet. Docker builds
// have no .git (see .dockerignore) and node:24-slim has no git binary, so
// there the id falls back to the build timestamp: each image build is a
// deployment of its own, which is exactly what the watch must announce.
import { execFileSync } from "node:child_process";

import { type Plugin } from "vite";

/** The static file the watch polls; served by nginx next to index.html. */
export const VERSION_FILE_NAME = "version.json";

/** The compile-time global the runtime watch reads its own id from. */
export const BUILD_ID_DEFINE = "__ALLY_BUILD_ID__";

export interface VersionFile {
  buildId: string;
  builtAt: string;
}

export function versionJsonSource(version: VersionFile): string {
  return `${JSON.stringify(version, null, 2)}\n`;
}

/** The `define` entry that pins the id into the bundle as a string literal. */
export function versionDefine(buildId: string): Record<string, string> {
  return { [BUILD_ID_DEFINE]: JSON.stringify(buildId) };
}

/** The dist asset the runtime watch polls. */
export function versionAsset(buildId: string, builtAt: string): {
  type: "asset";
  fileName: string;
  source: string;
} {
  return { type: "asset", fileName: VERSION_FILE_NAME, source: versionJsonSource({ buildId, builtAt }) };
}

/**
 * The build id for THIS build: the git short SHA, or a timestamp when no
 * repository answers (docker context, tarball). Injectable for tests.
 */
export function resolveBuildId(options?: {
  git?: ((args: string[]) => string | null) | undefined;
  now?: (() => number) | undefined;
}): string {
  const git = options?.git ?? defaultGit;
  const now = options?.now ?? Date.now;
  const id = git(["rev-parse", "--short", "HEAD"]);
  return id !== null && id.length > 0 ? id : now().toString(36);
}

function defaultGit(args: string[]): string | null {
  try {
    const out = execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const id = out.trim();
    return id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

/**
 * Wires the build id into both ends: `config` compiles it into the bundle via
 * `define` (dev included, where it is merely cosmetic — the dev server has no
 * version.json, so the watch never has news), and `generateBundle` drops
 * version.json into dist next to index.html.
 */
export function versionPlugin(options: { buildId: string }): Plugin {
  const { buildId } = options;
  return {
    name: "ally-version",
    config() {
      return { define: versionDefine(buildId) };
    },
    generateBundle() {
      this.emitFile(versionAsset(buildId, new Date().toISOString()));
    },
  };
}
