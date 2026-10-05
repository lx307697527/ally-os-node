/// <reference types="vite/client" />

// Compiled into the bundle by src/build/version-plugin.ts's `define` (the
// git short SHA, or a timestamp for builds without a repository). Declared
// possibly-undefined because test/node runs have no define — version-watch.ts
// guards with typeof before reading it.
declare const __ALLY_BUILD_ID__: string | undefined;
