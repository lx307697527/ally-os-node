// Generate the landing app's nginx server block from vercel.json.
//
// vercel.json is THE redirect/header table — copied verbatim from the old
// repo, where it drove the live Vercel deployment. This generator compiles the
// same table to nginx so the two deployments cannot drift: the committed
// `nginx.conf` is the generator's output, and `nginx-conf.test.ts` regenerates
// and diffs it, so editing either side by hand fails the suite.
//
// Translation contract (what "same behavior" means here):
//   * redirects — 308 permanent, destinations verbatim (including the
//     cross-app absolute URLs, which keep pointing at the old production hosts
//     until each destination app migrates and the table is repointed);
//   * vercel source shapes used by this table: literal, `(/)?`, `(/.*)?`,
//     `/(.+)` — exact `location =` for literals, anchored regex locations for
//     the others, in table order (nginx picks the first matching regex);
//   * headers — the five unconditional security headers apply to every
//     response they cover, INCLUDING redirect responses, so the generator
//     injects them into every location it emits; the CSP frame-ancestors rule
//     covers /quote(/.*)? — on nginx this must reach BOTH the /quote redirect
//     AND the static files, which live under a `^~` prefix location (see the
//     quote note below for why the redirect must NOT be a regex);
//   * the crawl-control X-Robots-Tag stays conditional on the staging host,
//     via a $host map whose default is the empty string (nginx omits an
//     add_header whose value is empty), so it can never follow the app to a
//     production host — the property crawl-control.test.ts pins;
//   * rewrites — the SPA catch-all becomes `try_files $uri $uri/ /index.html`
//     (filesystem wins first, like Vercel; `$uri/` keeps the /quote/ and
//     /schedule/ directory pages servable). The three prototype rewrites
//     (/visitor, /super-admin, /employee) pointed at demo mockups that are
//     deliberately NOT ported (#45 slice 1), so those prefixes get an honest
//     404 instead of silently falling through to the marketing homepage.
//
// ⚠️ nginx location-ordering trap this generator exists to avoid: nginx picks
// exactly ONE location per request — regex locations beat plain prefixes. The
// redirects table's `/quote → /quote/` compiled as the regex `^/quote(/.*)?$`
// would therefore swallow `/quote/index.html` too and bounce it to `/quote/`
// forever (Vercel never had this problem because it checks redirects BEFORE
// the filesystem and this table's /quote source is exact). So /quote is
// emitted as an exact-match redirect plus a `^~` prefix location for the
// static files, and the generic compiler must never see a /quote prefix.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG = join(HERE, '..', 'vercel.json');

/** Compile a vercel.json `source` pattern to an anchored nginx location.
 *  Handles exactly the token shapes this table uses — anything else throws,
 *  so a future table edit that outgrows the translator fails the build instead
 *  of silently redirecting wrong. (Exported for the test suite, which walks the
 *  whole table and asserts every compiled location actually lands in the conf.) */
export function sourceToLocation(source) {
  if (!source.startsWith('/')) throw new Error(`unsupported source: ${source}`);
  if (!/[(?*)]/.test(source)) return { kind: 'exact', path: source };
  const shapes = [
    { pattern: /^((?:\/[a-z0-9-]+)+)\(\/\)\?$/, nginx: (base) => `^${base}/?$` },
    { pattern: /^((?:\/[a-z0-9-]+)+)\(\/\.\*\)\?$/, nginx: (base) => `^${base}(/.*)?$` },
    { pattern: /^((?:\/[a-z0-9-]+)+)\/\(\.\+\)$/, nginx: (base) => `^${base}/(.+)$` },
  ];
  for (const shape of shapes) {
    const m = shape.pattern.exec(source);
    if (m) return { kind: 'regex', pattern: shape.nginx(m[1]) };
  }
  throw new Error(`unsupported source pattern: ${source}`);
}

const SECURITY_HEADERS = [
  ['X-Content-Type-Options', 'nosniff'],
  ['X-Frame-Options', 'DENY'],
  ['Referrer-Policy', 'strict-origin-when-cross-origin'],
  ['Permissions-Policy', 'accelerometer=(), autoplay=(), browsing-topics=(), camera=(), display-capture=(), encrypted-media=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), midi=(), payment=(), screen-wake-lock=(), usb=(), xr-spatial-tracking=()'],
  ['Strict-Transport-Security', 'max-age=31536000; includeSubDomains'],
];

/** Every location body starts with these: the unconditional security headers
 *  plus the host-conditional crawl-control header (empty off the staging
 *  host, and nginx drops empty add_header values). */
function headerLines(indent) {
  const pad = ' '.repeat(indent);
  const lines = SECURITY_HEADERS.map(([k, v]) => `${pad}add_header ${k} "${v}" always;`);
  lines.push(`${pad}add_header X-Robots-Tag $crawl_control always;`);
  return lines.join('\n');
}

export function generateNginxConf(config) {
  const out = [];
  out.push('# GENERATED by scripts/gen-nginx-conf.mjs from vercel.json — do not edit.');
  out.push('# Edit vercel.json (or the generator) and re-run the script; nginx-conf.test.ts');
  out.push('# diffs this file against a fresh generation.');
  out.push('map $host $crawl_control {');
  out.push('    default "";');
  for (const rule of config.headers ?? []) {
    for (const cond of rule.has ?? []) {
      if (cond.type !== 'host') continue;
      // vercel host values are anchored regexes; nginx map regexes are
      // unanchored by default, so anchor explicitly.
      out.push(`    ~^${cond.value}$ "noindex, nofollow";`);
    }
  }
  out.push('}');
  out.push('server {');
  out.push('    listen 8080;');
  out.push('    root /usr/share/nginx/html;');
  out.push('    # 308s stay path-only. nginx would otherwise build an absolute URL');
  out.push('    # from its own host:port — correct on the workstation, wrong behind a');
  out.push('    # load balancer that terminates TLS on another host.');
  out.push('    absolute_redirect off;');
  out.push('');
  out.push('    location = /nginx-health {');
  out.push(`       ${headerLines(8)}`);
  out.push('        access_log off;');
  out.push('        return 200 "ok";');
  out.push('    }');
  out.push('');
  out.push('    # vite emits content-hashed filenames under /assets/ — cache forever.');
  out.push('    location /assets/ {');
  out.push(`       ${headerLines(8)}`);
  out.push('        add_header Cache-Control "public, max-age=31536000, immutable";');
  out.push('        try_files $uri =404;');
  out.push('    }');
  out.push('');
  // /quote gets its hand-built pair (see the module comment); everything else
  // goes through the generic compiler, in table order.
  for (const rule of config.redirects ?? []) {
    if (rule.source === '/quote') {
      out.push('    location = /quote {');
      out.push(`       ${headerLines(8)}`);
      out.push('        add_header Content-Security-Policy "frame-ancestors \'self\'" always;');
      out.push('        return 308 /quote/;');
      out.push('    }');
      continue;
    }
    const loc = sourceToLocation(rule.source);
    if (loc.kind === 'exact') {
      out.push(`    location = ${loc.path} {`);
    } else {
      out.push(`    location ~ ${loc.pattern} {`);
    }
    out.push(`       ${headerLines(8)}`);
    out.push(`        return 308 ${rule.destination};`);
    out.push('    }');
  }
  out.push('');
  out.push('    # The static quote flow: its own CSP (vercel.json headers rule 2), and');
  out.push('    # no cache so a re-deploy is picked up immediately. `^~` keeps the');
  out.push('    # redirect regexes above from ever matching inside this directory.');
  out.push('    location ^~ /quote/ {');
  out.push(`       ${headerLines(8)}`);
  out.push('        add_header Content-Security-Policy "frame-ancestors \'self\'" always;');
  out.push('        add_header Cache-Control "no-cache";');
  out.push('        try_files $uri $uri/ =404;');
  out.push('    }');
  out.push('');
  out.push('    # Prototype mock prefixes: served by the old deployment\'s demo pages,');
  out.push('    # which are not ported (#45 slice 1). 404 beats silently showing the');
  out.push('    # marketing homepage at a URL that never meant that.');
  out.push('    location ~ ^/(visitor|super-admin|employee)(/|$) {');
  out.push(`       ${headerLines(8)}`);
  out.push('        return 404;');
  out.push('    }');
  out.push('');
  out.push('    # Single-page app: any other path falls back to index.html (filesystem');
  out.push('    # wins first, and `$uri/` serves directory indexes like /schedule/),');
  out.push('    # exactly like the Vercel catch-all rewrite.');
  out.push('    location / {');
  out.push(`       ${headerLines(8)}`);
  out.push('        add_header Cache-Control "no-cache";');
  out.push('        try_files $uri $uri/ /index.html;');
  out.push('    }');
  out.push('}');
  return `${out.join('\n')}\n`;
}

export function generateFromRepo() {
  return generateNginxConf(JSON.parse(readFileSync(CONFIG, 'utf-8')));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.stdout.write(generateFromRepo());
}
