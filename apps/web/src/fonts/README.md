# Self-hosted fonts — provenance and how to reproduce

`[FEAT-059] phase 3` (issue #574). These three files are the funnel's typeface
system, per `docs/design-system/design.md` §3.1 (**[HARD]**).

## Why they live here and not in `public/`

`apps/funnel/vercel.json` rewrites everything that is not under `assets/` to
`index.html`:

```json
{ "source": "/((?!assets/).*)", "destination": "/index.html" }
```

Vite copies `public/*` to the root of `dist/` verbatim — no hash, not under
`assets/` — so `public/fonts/x.woff2` would be rewritten to `index.html` on
Vercel and the browser would try to parse a HTML document as a font. **That
failure is invisible locally**: neither `vite dev` nor `vite build` goes through
`vercel.json`.

Living under `src/` and being referenced by a relative `url()` from `index.css`
makes Vite treat them as stylesheet assets: they land in `dist/assets/` with a
content hash, and the rewrite rule needs no change at all.

`apps/funnel/src/font-contract.test.ts` pins both halves of this.

## Why this is not a Google Fonts `<link>`

The funnel demo's own description is "no backend, no network calls, no secrets",
and an offline demo must not lose its typefaces. The files are fetched **once, at
authoring time**, and committed. Nothing reaches a CDN at runtime — asserted, not
just intended (`font-contract.test.ts` scans the whole app for
`fonts.googleapis.com` / `fonts.gstatic.com`).

This is the single, recorded exception to the "no web font" convention that
FEAT-056 restated from p20 onward. Approved by the business owner on 2026-08-19;
the reasoning is in `ops/specs/FEAT-059-funnel-design-conformance/phases/phase-3-prd.md`.

## What these files are

| File | Family | Licence | Size |
|---|---|---|---|
| `roboto-slab-latin.woff2` | Roboto Slab | Apache-2.0 | 33.4 KB |
| `roboto-latin.woff2` | Roboto | OFL-1.1 | 36.6 KB |
| `jetbrains-mono-latin.woff2` | JetBrains Mono | OFL-1.1 | 30.6 KB |

All three are **variable-weight** fonts carrying a `wght` axis spanning
`400..700`, subset to **latin** only. Total 100.6 KB.

- **Variable, not static:** the same three families as 4 static weights each
  (400/500/600/700 — the four the funnel actually uses) measured **402.4 KB
  across 12 files**. One axis per family is 4× smaller and covers every weight in
  between.
- **`400..700`, not the full axis:** every `font-weight` in `index.css` goes
  through a `--fw-*` token, and only 400/500/600/700 are referenced.
  `--fw-light:300` is declared but never used, so 300 is deliberately outside the
  shipped range.
- **latin only:** the funnel's UI copy is entirely English (no CJK anywhere under
  `apps/funnel/src`). The `@font-face` rules still declare `unicode-range`, so a
  character outside the subset falls through to the fallback chain rather than
  rendering as tofu.

Roboto is **OFL-1.1, not Apache-2.0** — it changed licence, and lives under
`ofl/` in the `google/fonts` repository. Assuming Apache here would be a real
compliance error, so it is called out rather than left to memory.

Self-hosting is redistribution, so each licence text ships alongside the fonts:
`LICENSE-Roboto-Slab-Apache-2.0.txt`, `LICENSE-Roboto-OFL-1.1.txt`,
`LICENSE-JetBrains-Mono-OFL-1.1.txt`. The files themselves are unmodified
upstream subsets, so OFL's Reserved Font Name clause is not triggered.

## How to reproduce or refresh

The subsets are upstream's, not hand-rolled — this repo has no `fontTools`, and a
locally-generated subset would not be reproducible.

```bash
UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 \
(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

# 1. Ask for the variable-axis stylesheet. The UA is what selects woff2.
curl -A "$UA" 'https://fonts.googleapis.com/css2?family=Roboto+Slab:wght@400..700\
&family=Roboto:wght@400..700&family=JetBrains+Mono:wght@400..700&display=swap'

# 2. From the response take the url() inside the block commented /* latin */
#    for each family — NOT latin-ext, cyrillic, greek or vietnamese.
# 3. curl each url into this directory under the names in the table above.
```

Licence texts come from the `google/fonts` repository:

```
https://raw.githubusercontent.com/google/fonts/main/apache/robotoslab/LICENSE.txt
https://raw.githubusercontent.com/google/fonts/main/ofl/roboto/OFL.txt
https://raw.githubusercontent.com/google/fonts/main/ofl/jetbrainsmono/OFL.txt
```

Captured 2026-08-20 — Roboto Slab `v36`, Roboto `v51`, JetBrains Mono `v24`
(the version segment of each `fonts.gstatic.com` path).

After refreshing, re-run `pnpm test -- --run` from the repo root: the contract
test re-checks existence, the woff2 magic number, and the weight axis.
