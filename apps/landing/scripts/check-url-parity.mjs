// URL-parity batch check for the landing app (#45 acceptance: "所有旧 URL 返回
// 相同的内容或正确的重定向（脚本批量校验）").
//
// Usage: node scripts/check-url-parity.mjs <base-url>
//   e.g. base-url = http://localhost:8090 with the landing image running
//   `docker run -p 8090:8080 ally-landing`.
//
// What it asserts, over the wire:
//   * every vercel.json redirect source answers 308 with the exact Location
//     (wildcard shapes are probed with one representative path each);
//   * every routed page + `/` + the static /quote/ and /schedule/ flows answer
//     200 HTML (an SPA serves the same shell for every route — per-route
//     content is a client render, which is exactly the SEO gap the old site
//     had; parity is parity, upgrade is a separate decision);
//   * sitemap.xml serves and lists every URL it must;
//   * the five security headers are present on a page response, and the
//     crawl-control X-Robots-Tag appears ONLY with the staging Host header;
//   * the prototype mock prefixes answer 404, not the homepage.
//
// Exit 0 = all green; anything else prints the failures and exits 1.
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const LANDING = join(HERE, '..');
const base = process.argv[2];
if (!base) {
  console.error('usage: node scripts/check-url-parity.mjs <base-url>');
  process.exit(2);
}
const { hostname, port } = new URL(base);

const config = JSON.parse(readFileSync(join(LANDING, 'vercel.json'), 'utf-8'));
const sitemap = readFileSync(join(LANDING, 'public', 'sitemap.xml'), 'utf-8');
const sitemapUrls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) =>
  m[1].replace('https://www.allynutra.com', ''),
);

function request(path, { hostHeader } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname, port, path, headers: hostHeader ? { host: hostHeader } : {} },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf-8'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** One representative concrete path per vercel source shape. */
function probePaths(source) {
  if (source === '/lp/manufacturing') return ['/lp/manufacturing'];
  if (source.endsWith('(/)?')) return [source.replace(/\(\/\)\?$/, ''), source.replace(/\(\/\)\?$/, '/')];
  if (source.endsWith('(/.*)?')) return [source.replace(/\(\/\.\*\)\?$/, ''), source.replace(/\(\/\.\*\)\?$/, '/deep/nested')];
  if (source.endsWith('/(.+)')) return [source.replace(/\/\(\.\+\)$/, '/deep')];
  if (/^\/[a-z0-9-]+$/.test(source)) return [source];
  throw new Error(`unhandled source shape: ${source}`);
}

const failures = [];
let checks = 0;
function expect(label, condition, detail) {
  checks += 1;
  if (!condition) failures.push(`${label}: ${detail}`);
}

// 1. the whole redirect table
for (const rule of config.redirects) {
  for (const path of probePaths(rule.source)) {
    const res = await request(path);
    expect(
      `redirect ${path}`,
      res.status === 308 && res.headers.location === rule.destination,
      `got ${res.status} → ${res.headers.location ?? '(none)'}, want 308 → ${rule.destination}`,
    );
  }
}

// 2. routed pages + root serve the SPA shell
const { TITLES } = await import(pathToFileURL(join(LANDING, 'src', 'lib', 'pages.js')).href);
for (const key of ['home', ...Object.keys(TITLES).filter((k) => k !== 'home')]) {
  const path = key === 'home' ? '/' : `/${key}`;
  const res = await request(path);
  expect(
    `page ${path}`,
    res.status === 200 && res.headers['content-type']?.includes('text/html') && res.body.includes('<div id="root">'),
    `got ${res.status} ${res.headers['content-type'] ?? ''}`,
  );
}

// 3. static flows + crawler files
for (const [path, marker] of [
  ['/quote/', 'quote'],
  ['/schedule/', 'schedule'],
  ['/sitemap.xml', '<urlset'],
  ['/googleee15de725976dc70.html', 'google'],
]) {
  const res = await request(path);
  expect(
    `static ${path}`,
    res.status === 200 && res.body.toLowerCase().includes(marker),
    `got ${res.status}; marker "${marker}" ${res.body.toLowerCase().includes(marker) ? 'found' : 'missing'}`,
  );
}
for (const url of sitemapUrls) {
  const res = await request(url);
  expect(`sitemap url ${url}`, res.status === 200, `got ${res.status}`);
}

// 4. security headers on a page response; crawl control only under staging host
const page = await request('/about');
for (const header of [
  'x-content-type-options',
  'x-frame-options',
  'referrer-policy',
  'permissions-policy',
  'strict-transport-security',
]) {
  expect(`security header ${header}`, page.headers[header] !== undefined, 'missing');
}
expect('crawl control default', page.headers['x-robots-tag'] === undefined, `leaked: ${page.headers['x-robots-tag']}`);
const staging = await request('/about', { hostHeader: 'dev.allynutra.com' });
expect(
  'crawl control on staging host',
  staging.headers['x-robots-tag'] === 'noindex, nofollow',
  `got: ${staging.headers['x-robots-tag'] ?? '(none)'}`,
);

// 5. unported prototype prefixes 404 instead of serving the homepage
for (const path of ['/visitor/x', '/super-admin', '/employee/']) {
  const res = await request(path);
  expect(`prototype ${path}`, res.status === 404, `got ${res.status}`);
}

if (failures.length > 0) {
  console.error(`FAIL — ${failures.length}/${checks} checks failed:`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}
console.log(`OK — ${checks} checks passed against ${base}`);
