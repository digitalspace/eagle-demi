#!/usr/bin/env node
// Smoke test for a built DEMI frontend: every screen and every legacy redirect, Keycloak off.
// Serve the build first (`yarn build && yarn preview --host 127.0.0.1`); this script starts nothing.
//
// Usage:
//   node scripts/e2e-smoke.mjs [--base <url>] [--timeout <ms>] [--help]
//
// Sign-in, runtime config and every API answer come from the parity harness: env.js is patched in
// flight and /api/** is served from parity/fixtures/. Nothing on disk is edited.

import {
  isLocalBase,
  loadChromium,
  READY_SELECTOR,
  routeApi,
  routeDataBc,
  routeEnv,
  routeTiles
} from '../parity/capture.mjs';

// One entry per screen in src/routes.tsx. /projects/901 is the fixture project.
export const SCREENS = [
  { path: '/workspace', h1: 'My account' },
  { path: '/sessions', h1: 'Active sessions' },
  { path: '/map', h1: 'Map Explorer' },
  { path: '/search', h1: 'Search' },
  { path: '/summary', h1: 'AI Search Summary' },
  { path: '/projects', h1: 'AI Project Summary' },
  { path: '/projects/901', h1: 'Sample Alpha Transmission Line' },
  { path: '/notify', h1: 'eagle-notify' },
  { path: '/links', h1: 'Short URLs' },
  { path: '/rbac', h1: 'Access model' },
  { path: '/developers', h1: 'API documentation' },
  { path: '/keys', h1: 'API keys' }
];

// Old URLs and where they must land. `h1` is omitted where the target is not a screen.
export const REDIRECTS = [
  { path: '/', to: '/map', h1: 'Map Explorer' },
  { path: '/index', to: '/search', h1: 'Search' },
  { path: '/index?q=wind%20farm', to: '/search?keywords=wind%20farm', h1: 'Search' },
  { path: '/content', to: '/search?record=documents&scope=inside', h1: 'Search' },
  { path: '/content?q=permit', to: '/search?record=documents&scope=inside&keywords=permit', h1: 'Search' },
  { path: '/profile', to: '/workspace', h1: 'My account' },
  { path: '/api-docs', to: '/api/api-docs' },
  { path: '/no-such-screen', to: '/map', h1: 'Map Explorer' }
];

function parseArgs(argv) {
  const args = { base: 'http://127.0.0.1:4173', timeout: 15000, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base') args.base = argv[++i];
    else if (a === '--timeout') args.timeout = Number(argv[++i]);
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

function usage() {
  console.log(`Usage: node scripts/e2e-smoke.mjs [options]

  --base <url>     Served build (default http://127.0.0.1:4173, the vite preview port)
  --timeout <ms>   Wait per page for its h1 (default 15000)
  --help           Show this help

Needs Playwright where Node can resolve it, or PLAYWRIGHT_MODULE set to its index.mjs.
Exits non-zero if any screen or redirect fails.`);
}

async function h1Texts(page) {
  return (await page.locator('h1').allTextContents()).map((t) => t.trim());
}

async function check(context, base, entry, timeout) {
  const reasons = [];
  const errors = [];
  const page = await context.newPage();
  page.on('console', (msg) => msg.type() === 'error' && errors.push(msg.text()));
  page.on('pageerror', (err) => errors.push(String(err.message ?? err)));

  try {
    const resp = await page.goto(new URL(entry.path, base).toString(), { waitUntil: 'domcontentloaded' });
    if (resp?.status() !== 200) reasons.push(`status ${resp?.status()}`);

    if (entry.to) {
      const want = new URL(entry.to, base);
      await page
        .waitForURL((url) => url.pathname === want.pathname && url.search === want.search, { timeout })
        .catch(() => {});
      const got = new URL(page.url());
      if (got.pathname + got.search !== entry.to) reasons.push(`landed on ${got.pathname}${got.search}`);
    }

    if (entry.h1) {
      await page.waitForSelector(READY_SELECTOR, { timeout }).catch(() => reasons.push('shell never rendered'));
      await page
        .waitForFunction((want) => [...document.querySelectorAll('h1')].some((h) => h.textContent.trim() === want), entry.h1, { timeout })
        .catch(async () => reasons.push(`h1 ${JSON.stringify(await h1Texts(page))} lacks "${entry.h1}"`));
    }

    // Late errors (a failed lazy chunk, a query that throws on render) land after the h1.
    await page.waitForLoadState('networkidle', { timeout }).catch(() => {});
  } catch (e) {
    reasons.push(String(e.message ?? e));
  } finally {
    await page.close();
  }
  if (errors.length) reasons.push(`console errors: ${errors.slice(0, 3).join(' | ')}`);
  return reasons;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return usage();
  // The script rewrites env.js in flight; that is only safe against a build on this machine.
  if (!isLocalBase(args.base)) {
    console.error(`--base must be localhost, 127.0.0.1 or [::1], got ${args.base}`);
    process.exit(1);
  }
  if (!Number.isFinite(args.timeout) || args.timeout <= 0) {
    console.error(`--timeout must be a positive number of milliseconds, got ${args.timeout}`);
    process.exit(1);
  }

  const chromium = await loadChromium();
  if (!chromium) process.exit(1);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });

  const setupFailures = [];
  const misses = new Set();
  await routeEnv(context, setupFailures, 'app');
  await routeApi(context, misses);
  await routeTiles(context);
  await routeDataBc(context, misses);

  let ok = 0;
  let fail = 0;
  for (const entry of [...SCREENS, ...REDIRECTS]) {
    const reasons = [...(await check(context, args.base, entry, args.timeout)), ...setupFailures.splice(0)];
    const label = entry.to ? `${entry.path} -> ${entry.to}` : entry.path;
    if (reasons.length === 0) {
      ok++;
      console.log(`OK   ${label}`);
    } else {
      fail++;
      console.log(`FAIL ${label}: ${reasons.join('; ')}`);
    }
  }

  await browser.close();
  if (misses.size) console.log(`no fixture (answered {}): ${[...misses].sort().join(', ')}`);
  console.log(`smoke: screens=${SCREENS.length} redirects=${REDIRECTS.length} ok=${ok} fail=${fail}`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('unhandled:', e);
  process.exit(1);
});
