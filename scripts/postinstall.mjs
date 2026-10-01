#!/usr/bin/env node
/**
 * Root `postinstall` — ported from ally-os [BUG-301].
 *
 * Why this is Node and not a one-line shell string. The line it replaced there was
 *
 *     python3 scripts/install_git_hooks.py || true; uv tool install serena-agent || echo '…'
 *
 * pnpm runs lifecycle scripts through `cmd.exe` on Windows, where `;` is not a
 * command separator and `true` is not a command. Where `python3` is the Microsoft
 * Store app-execution alias (WindowsApps\python3 — a stub that prints "Python was
 * not found" and exits 9009) the whole line collapsed into one failing chain whose
 * trailing `|| echo` returned 0 — and `core.hooksPath` was never set, so the
 * pre-push hook never ran on that machine.
 *
 * Node is the one interpreter guaranteed to exist whenever this runs (pnpm is
 * running on it), and `spawnSync` with an argv array has no shell to disagree with.
 *
 * Contract, and where it deliberately differs from RULE-002:
 *   - The install itself still never fails over the hook. That asymmetry is
 *     ally-os FEAT-034 p3's ruling (install_git_hooks.py rule 3): CI still runs
 *     every check the hook runs, while an install that dies takes the whole toolchain.
 *   - But a hook that did not install is NEVER silent. No usable Python, a
 *     failing installer, or a `core.hooksPath` that does not read back as ours
 *     afterwards each print a banner on stderr naming the exact repair.
 *   - `ALLY_POSTINSTALL_STRICT=1` turns the banner into exit 1.
 *   - `ALLY_PYTHON=<path-or-command>` pins the interpreter when none of the
 *     usual names resolve to a real one.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOOKS_PATH = "scripts/hooks";
const STRICT = process.env.ALLY_POSTINSTALL_STRICT === "1";

// No .git → not a git checkout: a docker build layer (the Dockerfile copies
// package.jsons + this script BEFORE the source; .git never enters the context
// — see .dockerignore). There is nothing to install hooks for, and probing for
// python there would only print a banner into every image build.
if (!existsSync(join(ROOT, ".git"))) {
  process.stdout.write("postinstall: no .git (docker build context) — skipping git hook install.\n");
  process.exit(0);
}

/** Interpreters to try, in order. `py -3` first on Windows: the launcher is a real
 * .exe installed by python.org, and it is never the Store stub. */
function pythonCandidates(platform = process.platform, env = process.env) {
  const pinned = env.ALLY_PYTHON?.trim();
  if (pinned) return [[pinned]];
  return platform === "win32"
    ? [["py", "-3"], ["python"], ["python3"]]
    : [["python3"], ["python"]];
}

/** `3.11` from `.python-version`; `[3, 0]` when it cannot be read (the installer's
 * own import then decides, and its failure is reported like any other). */
function pythonFloor(text) {
  const m = /^\s*(\d+)\.(\d+)/.exec(text ?? "");
  return m ? [Number(m[1]), Number(m[2])] : [3, 0];
}

/** A probe result counts only if it printed a version at or above the floor.
 * The Store stub exits 9009 with prose on stderr, so it never matches. */
function acceptsProbe(result, floor) {
  if (!result || result.error || result.status !== 0) return false;
  const m = /^(\d+)\.(\d+)$/m.exec(String(result.stdout ?? "").trim());
  if (!m) return false;
  const [maj, min] = [Number(m[1]), Number(m[2])];
  return maj > floor[0] || (maj === floor[0] && min >= floor[1]);
}

function run(argv, opts = {}) {
  return spawnSync(argv[0], argv.slice(1), {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true,
    timeout: 60_000,
    ...opts,
  });
}

function findPython() {
  let floorText = null;
  try {
    floorText = readFileSync(join(ROOT, ".python-version"), "utf8");
  } catch {
    // unreadable floor → [3, 0]; see pythonFloor
  }
  const floor = pythonFloor(floorText);
  const tried = [];
  for (const argv of pythonCandidates()) {
    const probe = run([...argv, "-c", "import sys; print('%d.%d' % sys.version_info[:2])"], {
      timeout: 20_000,
    });
    if (acceptsProbe(probe, floor)) return { argv, tried };
    const why = probe.error
      ? probe.error.code ?? probe.error.message
      : `exit ${probe.status}${probe.stdout?.trim() ? `, printed ${probe.stdout.trim()}` : ""}`;
    tried.push(`${argv.join(" ")} (${why})`);
  }
  return { argv: null, tried, floor };
}

const problems = [];

function banner(lines) {
  const bar = "!".repeat(78);
  process.stderr.write(`\n${bar}\n${lines.map((l) => `!! ${l}`).join("\n")}\n${bar}\n\n`);
}

// git hooks -------------------------------------------------------------------
const py = findPython();
if (!py.argv) {
  problems.push(
    `No usable Python ${py.floor.join(".")}+ found, so the git pre-push hook was NOT installed.`,
    `Tried: ${py.tried.join("; ")}.`,
    `On Windows, "python3" is often the Microsoft Store stub (WindowsApps\\python3.exe).`,
    `Install Python from python.org (it ships the "py" launcher), or set ALLY_PYTHON=<python.exe>, then rerun: pnpm install`,
    `Or set it by hand: git config ${"core.hooksPath"} ${HOOKS_PATH}`,
  );
} else {
  const inst = run([...py.argv, join("scripts", "install_git_hooks.py")], { stdio: "inherit" });
  if (inst.error || inst.status !== 0) {
    problems.push(
      `scripts/install_git_hooks.py failed under "${py.argv.join(" ")}" ` +
        `(${inst.error ? inst.error.message : `exit ${inst.status}`}); the pre-push hook may not be installed.`,
      `Set it by hand: git config core.hooksPath ${HOOKS_PATH}`,
    );
  } else {
    // Read back what git will actually use. "foreign" is the installer's
    // deliberate leave-alone and it already said so; only an unset value here
    // means the hook will not run.
    const got = run(["git", "config", "--get", "core.hooksPath"]);
    if (got.error) {
      problems.push(`Could not ask git for core.hooksPath (${got.error.message}); the pre-push hook is unverified.`);
    } else if (!String(got.stdout ?? "").trim()) {
      problems.push(
        `core.hooksPath is still unset after install_git_hooks.py exited 0 — the pre-push hook will NOT run.`,
        `Set it by hand: git config core.hooksPath ${HOOKS_PATH}`,
      );
    }
  }
}

if (problems.length) {
  banner(["postinstall [ported from ally-os BUG-301]: the local git hooks are NOT active.", ...problems]);
  process.exit(STRICT ? 1 : 0);
}
