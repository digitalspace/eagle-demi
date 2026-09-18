#!/usr/bin/env node
// Screenshots the Angular app and the React app side by side so the pairs can be compared.
// Both apps must already be running; this script starts nothing and writes nothing but PNGs.
//
// Usage:
//   node parity/capture.mjs [--angular <url>] [--react <url>] [--routes <list>] [--widths <list>]
//                           [--out <dir>] [--timeout <ms>] [--dry-run] [--help]

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(HERE, 'fixtures');

/**
 * Playwright is not a dependency of this app and must not become one. Resolve it the normal way
 * first, so a machine that has it anywhere on its module path just works; PLAYWRIGHT_MODULE is the
 * escape hatch for a machine that keeps it somewhere else. No path from any one machine is hard
 * coded here: this repo is public.
 */
async function loadChromium() {
  const tried = [];
  for (const spec of ['playwright', process.env.PLAYWRIGHT_MODULE]) {
    if (!spec) continue;
    tried.push(spec);
    try {
      return (await import(spec)).chromium;
    } catch {
      // Try the next candidate.
    }
  }
  console.error(
    `Could not load Playwright (tried: ${tried.join(', ')}).\n` +
      'It is deliberately not a dependency of this app. Point at an existing install:\n' +
      '  PLAYWRIGHT_MODULE=/abs/path/to/node_modules/playwright/index.mjs node parity/capture.mjs\n' +
      'or install it where Node can resolve it by name.'
  );
  return null;
}

// Both apps are served from this machine for a capture run. A remote base would send an
// intercepted env.js and a session's worth of screenshots somewhere this script cannot vouch for.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function isLocalBase(base) {
  try {
    return LOCAL_HOSTS.has(new URL(base).hostname);
  } catch {
    return false;
  }
}

const DEFAULTS = {
  angular: 'http://localhost:4200',
  react: 'http://localhost:4300',
  routes: '/workspace,/keys',
  widths: '1440,1024,400',
  out: path.join(HERE, 'out'),
  timeout: 15000,
  // The screen the shell states are photographed on: it has a rail link to mark and no map canvas.
  stateRoute: '/keys'
};

// One height for every width. Shots are full-page, so this only decides how much of a screen
// sits above the fold, which is what sticky headers and the rail react to.
const VIEWPORT_HEIGHT = 900;

// The real header. The loading skeleton carries the same class with aria-hidden, so matching on
// `.eao-header` alone would photograph a still-booting page as if it had loaded.
const READY_SELECTOR = 'header.eao-header:not([aria-hidden="true"])';

// The skeleton's header, which is what the loading state is a picture of.
const SKELETON_SELECTOR = 'header.eao-header[aria-hidden="true"]';

// Both apps mark the current screen the same way and neither adds a class for it: Angular through
// `routerLinkActive` writing `aria-current`, React through NavLink's own default. Waiting on it is
// what stops a shot landing before the rail has caught up with the route — the last run
// photographed Angular's /workspace at 1440 with no link marked.
const ACTIVE_NAV_SELECTOR = '.app-sidebar__link[aria-current="page"]';

// Below this the rail goes off-canvas in both apps (frontend-react/src/shell/useNarrow.ts), so
// there is no rail link on the page at all until the drawer is opened.
const NARROW_BREAKPOINT = 900;

// The sign-in screen is not the shell: neither app renders the header there, only its own heading.
const SIGN_IN_SELECTOR = 'h1';

// Same aria-labels in both apps, so one set of selectors drives each shell state on both sides.
const SKIP_LINK = '.skip-link';
const ACCOUNT_BUTTON = 'button[aria-label="Account menu"]';
const HOW_BUILT_BUTTON = 'button[aria-label="How this screen is built"]';
const DRAWER_BUTTON = 'button[aria-label="Main navigation"]';

// The how-built panel's own content, so a shot cannot land between the click and the panel
// finishing its render: an earlier run photographed Angular with the title and chips still
// missing. Both apps render the chips as bare `<span>`s with no class, so that tag is specific
// enough scoped inside the dialog.
const HOW_BUILT_TITLE = '[role="dialog"] h2';
const HOW_BUILT_CHIP = '[role="dialog"] span';

/** Most a Tab walk from the skip link should need before it reaches the first rail link. */
const TAB_LIMIT = 12;

// Forced into both apps at load time. Together they mean: no sign-in, no runtime config fetch,
// relative API paths, no browser telemetry.
const ENV_OVERRIDES = {
  configEndpoint: false,
  KEYCLOAK_ENABLED: false,
  API_LOCATION: '',
  API_PATH: '/api',
  ENVIRONMENT: 'test',
  NOTIFY_API_LOCATION: '/notify-api',
  APPINSIGHTS_CONNECTION_STRING: ''
};

function help() {
  console.log(`Capture Angular and React screens side by side.

  node parity/capture.mjs [options]

  --angular <url>    Angular base URL            (default ${DEFAULTS.angular})
  --react <url>      React base URL              (default ${DEFAULTS.react})
  --routes <list>    Comma-separated routes      (default ${DEFAULTS.routes})
  --widths <list>    Comma-separated CSS widths  (default ${DEFAULTS.widths})
  --out <dir>        Output directory            (default parity/out)
  --timeout <ms>     Per-screen wait budget      (default ${DEFAULTS.timeout})
  --state-route <r>  Screen the shell states sit on (default ${DEFAULTS.stateRoute})
  --only <routes|states|screens>  Capture just the route screens, the shell states or the
                     per-screen states (empty, error, dialogs, a typed filter)
  --states <list>    Capture only the named states, e.g. projects-empty,projects-error
  --dry-run          Launch the browser and print the plan; visit no app
  --help             This text

Output: <out>/<screen>/<width>/{angular,react}.png, <out>/_shell/<state>/<width>/ and
        <out>/_screens/<state>/<width>/, full page.
API calls are answered from parity/fixtures; env.js is rewritten in flight so both apps
boot with Keycloak off. Both base URLs must be on this machine. Playwright is resolved by
name, or from PLAYWRIGHT_MODULE. Exit code is non-zero if any capture fails.`);
}

function parseArgs(argv) {
  const args = { ...DEFAULTS, dryRun: false, help: false, only: 'all' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--only') args.only = argv[++i];
    else if (a === '--state-route') args.stateRoute = argv[++i];
    else if (a === '--states') args.states = argv[++i];
    else if (a === '--angular') args.angular = argv[++i];
    else if (a === '--react') args.react = argv[++i];
    else if (a === '--routes') args.routes = argv[++i];
    else if (a === '--widths') args.widths = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--timeout') args.timeout = Number(argv[++i]);
    else {
      console.error(`unknown option: ${a}`);
      process.exit(2);
    }
  }
  if (!['all', 'routes', 'states', 'screens'].includes(args.only)) {
    console.error(`--only must be "routes", "states" or "screens", got "${args.only}"`);
    process.exit(2);
  }
  return args;
}

function splitList(value) {
  return String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** `/workspace` -> `workspace`, `/projects/123` -> `projects-123`, `/` -> `root`. */
export function screenName(route) {
  const slug = route.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\//g, '-');
  return slug || 'root';
}

/**
 * Fixture file for an intercepted API path: strip the `/api` or `/notify-api` prefix and the
 * query string, then turn the rest into a file name. `/api/config/public` -> `config-public.json`,
 * `/api/config` -> `config.json`, `/api/me` -> `me.json`, `/api/me/data` -> `me-data.json`.
 * A new screen only needs a new file here, never a change to this script.
 */
export function fixtureNameFor(urlString) {
  const { pathname, searchParams } = new URL(urlString);
  const match = /^\/(?:notify-)?api(\/.*)?$/.exec(pathname);
  if (!match) return null;
  // `dataset` is the only query parameter that changes what a path answers with: /api/search is
  // the project list, the List name table and more, depending on it.
  const dataset = searchParams.get('dataset');
  return `${screenName(match[1] || '')}${dataset ? `-${dataset.toLowerCase()}` : ''}.json`;
}

/**
 * Serve fixtures for `/api/**` and `/notify-api/**`. Anything without a fixture gets `{}` so the
 * page still renders; a screen that wants a list will show its own empty or error state, which is
 * the signal to add the fixture. Every miss is printed at the end.
 */
export async function routeApi(page, misses, state = {}) {
  // Matched on the path prefix, not a `**/api/**` glob: the dev server serves the app's own
  // modules from /src/api/, and a glob answers those with JSON too, breaking the page.
  const isApiCall = (url) => /^\/(?:notify-)?api(\/|$)/.test(new URL(url).pathname);

  await page.route(isApiCall, async (route) => {
    const request = route.request();
    const target = new URL(request.url());
    // A state's own answers win, so one screen can be photographed loaded, empty and failing from
    // the same fixture directory. `match` is tested against the path and query together.
    const override = (state.responses || []).find(
      (rule) => rule.match.test(target.pathname + target.search) && (!rule.method || rule.method === request.method())
    );
    if (override) {
      await route.fulfill({
        status: override.status ?? 200,
        contentType: 'application/json',
        body: override.file ? readFileSync(path.join(FIXTURE_DIR, override.file), 'utf-8') : '{}'
      });
      return;
    }

    const name = fixtureNameFor(request.url());

    if (name === 'me.json' && state.meDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, state.meDelayMs));
    }

    const file = name ? path.join(FIXTURE_DIR, name) : null;
    if (file && existsSync(file)) {
      await route.fulfill({ contentType: 'application/json', body: readFileSync(file, 'utf-8') });
      return;
    }
    if (name) misses.add(name);
    await route.fulfill({ contentType: 'application/json', body: '{}' });
  });
}

/** Appended to whatever env.js the app serves, so the forced keys win and the rest survive. */
export function envOverrideBlock(extra = {}) {
  const lines = Object.entries({ ...ENV_OVERRIDES, ...extra })
    .map(([key, value]) => `  w.__env.${key} = ${JSON.stringify(value)};`)
    .join('\n');
  return `\n;(function (w) {\n  w.__env = w.__env || {};\n${lines}\n})(this);\n`;
}

/**
 * Keep each app's own env.js and append the override block, so a key either app adds later still
 * arrives. The file on disk is never touched.
 */
async function routeEnv(page, failures, label, extra) {
  await page.route('**/env.js', async (route) => {
    const response = await route.fetch();
    const body = await response.text();
    if (!body.includes('window.__env')) {
      failures.push(`${label}: env.js did not set window.__env; the app's config shape has moved`);
      await route.abort();
      return;
    }
    await route.fulfill({ response, body: body + envOverrideBlock(extra) });
  });
}

/**
 * Wait until the shell has stopped moving: the real header up, the rail agreeing with the route,
 * no request still in flight, and the web fonts swapped in. Without the last two a shot can land
 * on fallback metrics or a half-painted screen, which reads as a difference that is not there.
 */
async function settle(page, { ready = READY_SELECTOR, activeNav = true, awaitNetworkIdle = true }, timeout) {
  await page.waitForSelector(ready, { timeout });
  if (activeNav) await page.waitForSelector(ACTIVE_NAV_SELECTOR, { timeout });
  // The loading state holds `/me` open on purpose, so waiting for the network to go idle here
  // would just wait past the shot it is trying to catch.
  if (awaitNetworkIdle) await page.waitForLoadState('networkidle', { timeout });
  await page.evaluate(() => document.fonts.ready);
}

/** Wait for the rail to agree with the route once it is on the page. */
const waitForActiveNav = (page, timeout) => page.waitForSelector(ACTIVE_NAV_SELECTOR, { timeout });

/** Tab from the skip link until the first rail link has focus, so the ring is what is photographed. */
async function focusFirstNavLink(page) {
  await page.focus(SKIP_LINK);
  for (let i = 0; i < TAB_LIMIT; i++) {
    await page.keyboard.press('Tab');
    const onLink = await page.evaluate(
      (selector) => !!document.activeElement?.matches(selector),
      '.app-sidebar__link'
    );
    if (onLink) return;
  }
  throw new Error(`no rail link reached within ${TAB_LIMIT} tabs from the skip link`);
}

/**
 * The shell's own states, which no route capture reaches. Each is photographed in both apps at the
 * widths listed. `env` and `me` change what the page is booted with, so they need their own context.
 */
export const SHELL_STATES = [
  {
    name: 'account-menu',
    widths: [1440, 400],
    prepare: (page) => page.click(ACCOUNT_BUTTON)
  },
  {
    name: 'how-built',
    widths: [1440, 400],
    prepare: async (page, width, timeout) => {
      await page.click(HOW_BUILT_BUTTON);
      await page.waitForSelector(HOW_BUILT_TITLE, { state: 'visible', timeout });
      await page.waitForSelector(HOW_BUILT_CHIP, { state: 'visible', timeout });
    }
  },
  {
    name: 'drawer',
    widths: [400],
    prepare: async (page, width, timeout) => {
      await page.click(DRAWER_BUTTON);
      await waitForActiveNav(page, timeout);
    }
  },
  {
    name: 'nav-focus',
    widths: [1440, 400],
    // Below the breakpoint the rail is off-canvas, so there is no link to reach until it is open.
    prepare: async (page, width, timeout) => {
      if (width < NARROW_BREAKPOINT) {
        await page.click(DRAWER_BUTTON);
        await waitForActiveNav(page, timeout);
      }
      await focusFirstNavLink(page);
    }
  },
  {
    name: 'sign-in',
    widths: [1440, 400],
    // Keycloak on, nothing remembered: what a visitor with no session sees. Neither app calls
    // `/me` here — there is no token to send it — so nothing needs to be forced onto that
    // request to land on this screen. Neither app renders the shell here either, so the heading
    // is what says the screen has arrived.
    env: { KEYCLOAK_ENABLED: true },
    ready: SIGN_IN_SELECTOR,
    activeNav: false
  },
  {
    name: 'loading',
    widths: [1440, 400],
    // Auth stays off (the default env below), the one state where both gates await `/me` before
    // dropping the skeleton regardless of whether anyone is signed in: Angular's authSettled()
    // and React's SessionProvider both call it unconditionally when Keycloak is disabled. With
    // Keycloak on and no session, React's fix for the sign-in state above skips the call
    // entirely, which would drop the skeleton immediately and defeat this capture.
    // `/config` is not delayed: both apps await it before their root component even mounts, so
    // a slow answer produces a blank page, not a skeleton.
    meDelayMs: 4000,
    ready: SKELETON_SELECTOR,
    activeNav: false,
    awaitNetworkIdle: false,
    // The shot is taken mid-flight; hold the context open until the real header lands so the
    // delayed response finishes inside a page that is still there to receive it.
    thenReady: READY_SELECTOR
  }
];

/**
 * States a screen reaches only through its own data or a click: the route captures above show each
 * screen loaded, and these show the rest. `responses` replaces what the API answers with; `prepare`
 * drives the page once it has settled. Same selectors work on both apps, because the React port
 * keeps the Angular markup.
 */
export const SCREEN_STATES = [
  {
    name: 'keys-empty',
    route: '/keys',
    responses: [{ match: /^\/api\/admin\/api-keys$/, file: 'admin-api-keys-empty.json' }]
  },
  {
    name: 'keys-error',
    route: '/keys',
    responses: [{ match: /^\/api\/admin\/api-keys$/, status: 500, file: 'api-error.json' }]
  },
  {
    name: 'keys-mint-open',
    route: '/keys',
    prepare: async (page, width, timeout) => {
      await page.click('button:text-is("Mint a key")');
      await page.waitForSelector('input[placeholder="epic-map-frontend"]', { timeout });
    }
  },
  {
    name: 'keys-minted',
    route: '/keys',
    responses: [
      { match: /^\/api\/admin\/api-keys$/, method: 'POST', status: 201, file: 'admin-api-keys-minted.json' }
    ],
    prepare: async (page, width, timeout) => {
      await page.click('button:text-is("Mint a key")');
      await page.fill('input[placeholder="epic-map-frontend"]', 'sample-new-consumer');
      await page.click('label:has(code:text-is("demi-service-read")) input[type="checkbox"]');
      await page.click('button:text-is("Mint key")');
      await page.waitForSelector('button:text-is("Copy secret")', { timeout });
    }
  },
  {
    // A native confirm() is browser chrome and never lands in a screenshot, so the question itself
    // is written out beside the shot and the page is photographed with nothing sent.
    name: 'keys-revoke-confirm',
    route: '/keys',
    prepare: async (page, width, timeout, out) => {
      const asked = [];
      page.on('dialog', async (dialog) => {
        asked.push(dialog.message());
        await dialog.dismiss();
      });
      // The click resolves only once the dialog has been answered, so `asked` is filled by here.
      await page.click('.row-actions button:text-is("Revoke")');
      mkdirSync(out, { recursive: true });
      writeFileSync(path.join(out, 'confirm.txt'), asked.join('\n') + '\n');
    }
  },
  {
    name: 'projects-empty',
    route: '/projects',
    responses: [{ match: /dataset=Project/, file: 'search-project-empty.json' }]
  },
  {
    // React retries a 5xx twice a second apart, and the network is idle inside each gap, so the
    // shot landed on its skeleton. Wait for the picker's own alert; `.alert-row` is the shell's.
    name: 'projects-error',
    route: '/projects',
    responses: [{ match: /dataset=Project/, status: 500, file: 'api-error.json' }],
    ready: '.callout--warning[role="alert"]:not(.alert-row)'
  },
  {
    // The shell's own callout, which sits above whatever screen is on: both apps read the project
    // corpus on /map, so a refused read there is the one request that fails them both. A 400, not a
    // 500: a 500 is retried twice with a real delay before either app settles on the message.
    name: 'shell-load-error',
    route: '/map',
    widths: [1440, 400],
    responses: [{ match: /dataset=Project/, status: 400, file: 'api-error.json' }],
    ready: '.alert-row'
  },
  {
    name: 'projects-filtered',
    route: '/projects',
    prepare: async (page, width, timeout) => {
      await page.waitForSelector('.pp-result', { timeout });
      await page.fill('#pp-search', 'sample b');
      await page.waitForFunction(() => document.querySelectorAll('.pp-result').length === 1, null, { timeout });
    }
  }
];

async function captureScreenStates({ browser, label, base, widths, out, timeout, misses, failures, only }) {
  for (const state of SCREEN_STATES.filter((s) => !only || only.includes(s.name))) {
    for (const width of state.widths || widths) {
      const dir = path.join(out, '_screens', state.name, String(width));
      const { context, page, pageErrors } = await newPage({
        browser, width, label, misses, failures, state
      });
      try {
        await page.goto(new URL(state.route, base).href, { waitUntil: 'domcontentloaded', timeout });
        await settle(page, { ...state, activeNav: width >= NARROW_BREAKPOINT }, timeout);
        if (state.prepare) await state.prepare(page, width, timeout, dir);
        mkdirSync(dir, { recursive: true });
        await page.screenshot({ path: path.join(dir, `${label}.png`), fullPage: true });
        console.log(`ok   ${label.padEnd(8)}${String(width).padEnd(6)}_screens/${state.name}`);
      } catch (err) {
        const detail = pageErrors.length ? ` (page error: ${pageErrors[0]})` : '';
        failures.push(`${label} ${width} _screens/${state.name}: ${err.message}${detail}`);
        console.error(`FAIL ${label.padEnd(8)}${String(width).padEnd(6)}_screens/${state.name}`);
      }
      await context.close();
    }
  }
}

async function newPage({ browser, width, label, misses, failures, state = {} }) {
  const context = await browser.newContext({ viewport: { width, height: VIEWPORT_HEIGHT } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err.message || err)));
  await routeEnv(page, failures, label, state.env);
  await routeApi(page, misses, state);
  return { context, page, pageErrors };
}

async function captureApp({ browser, label, base, routes, widths, out, timeout, misses, failures }) {
  for (const width of widths) {
    const { context, page, pageErrors } = await newPage({ browser, width, label, misses, failures });

    for (const route of routes) {
      const dir = path.join(out, screenName(route), String(width));
      pageErrors.length = 0;
      try {
        await page.goto(new URL(route, base).href, { waitUntil: 'domcontentloaded', timeout });
        // Off-canvas there is no rail link on the page to mark, so there is nothing to wait for.
        await settle(page, { activeNav: width >= NARROW_BREAKPOINT }, timeout);
        mkdirSync(dir, { recursive: true });
        await page.screenshot({ path: path.join(dir, `${label}.png`), fullPage: true });
        console.log(`ok   ${label.padEnd(8)}${String(width).padEnd(6)}${route}`);
      } catch (err) {
        const detail = pageErrors.length ? ` (page error: ${pageErrors[0]})` : '';
        failures.push(`${label} ${width} ${route}: ${err.message}${detail}`);
        console.error(`FAIL ${label.padEnd(8)}${String(width).padEnd(6)}${route}`);
      }
    }
    await context.close();
  }
}

/** Shell states get a context each: several of them change what the app is booted with. */
async function captureStates({ browser, label, base, route, out, timeout, misses, failures }) {
  for (const state of SHELL_STATES) {
    for (const width of state.widths) {
      const dir = path.join(out, '_shell', state.name, String(width));
      const { context, page, pageErrors } = await newPage({
        browser, width, label, misses, failures, state
      });
      try {
        await page.goto(new URL(route, base).href, { waitUntil: 'domcontentloaded', timeout });
        const activeNav = (state.activeNav ?? true) && width >= NARROW_BREAKPOINT;
        const awaitNetworkIdle = state.awaitNetworkIdle ?? true;
        await settle(page, { ready: state.ready, activeNav, awaitNetworkIdle }, timeout);
        if (state.prepare) await state.prepare(page, width, timeout);
        mkdirSync(dir, { recursive: true });
        await page.screenshot({ path: path.join(dir, `${label}.png`), fullPage: true });
        // Let the delayed response land inside a page that is still open to receive it, rather
        // than closing the context out from under an in-flight route handler.
        if (state.thenReady) await page.waitForSelector(state.thenReady, { timeout });
        console.log(`ok   ${label.padEnd(8)}${String(width).padEnd(6)}_shell/${state.name}`);
      } catch (err) {
        const detail = pageErrors.length ? ` (page error: ${pageErrors[0]})` : '';
        failures.push(`${label} ${width} _shell/${state.name}: ${err.message}${detail}`);
        console.error(`FAIL ${label.padEnd(8)}${String(width).padEnd(6)}_shell/${state.name}`);
      }
      await context.close();
    }
  }
}

async function dryRun(chromium, args, routes, widths) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('about:blank');
  await browser.close();
  console.log('dry-run: chromium launched and closed\n');
  console.log(`angular  ${args.angular}`);
  console.log(`react    ${args.react}`);
  console.log(`widths   ${widths.join(', ')} (height ${VIEWPORT_HEIGHT})`);
  console.log(`out      ${args.out}\n`);
  console.log('route'.padEnd(24) + 'screen');
  for (const route of routes) console.log(route.padEnd(24) + screenName(route));
  console.log('\nfixtures');
  for (const name of [
    'config-public.json',
    'config.json',
    'me.json',
    'me-data.json',
    'search-project.json',
    'search-list.json'
  ]) {
    console.log(`  ${name.padEnd(22)}${existsSync(path.join(FIXTURE_DIR, name)) ? 'present' : 'MISSING'}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    help();
    return 0;
  }
  const routes = splitList(args.routes);
  const widths = splitList(args.widths).map(Number);
  if (!routes.length || widths.some((w) => !Number.isFinite(w) || w <= 0)) {
    console.error('--routes needs at least one route and --widths needs positive numbers');
    return 2;
  }
  for (const [name, base] of [['--angular', args.angular], ['--react', args.react]]) {
    if (!isLocalBase(base)) {
      console.error(
        `${name} must point at this machine (localhost, 127.0.0.1 or [::1]); got ${base}.\n` +
          'This script rewrites env.js in flight and photographs whatever answers, so it only\n' +
          'ever talks to apps running here.'
      );
      return 2;
    }
  }

  const chromium = await loadChromium();
  if (!chromium) return 2;

  if (args.dryRun) {
    await dryRun(chromium, args, routes, widths);
    return 0;
  }

  const misses = new Set();
  const failures = [];
  const browser = await chromium.launch({ headless: true });
  try {
    for (const [label, base] of [['angular', args.angular], ['react', args.react]]) {
      if (args.only === 'all' || args.only === 'routes') {
        await captureApp({
          browser, label, base, routes, widths, out: args.out, timeout: args.timeout, misses, failures
        });
      }
      if (args.only === 'all' || args.only === 'states') {
        await captureStates({
          browser, label, base, route: args.stateRoute, out: args.out,
          timeout: args.timeout, misses, failures
        });
      }
      if (args.only === 'all' || args.only === 'screens') {
        await captureScreenStates({
          browser, label, base, widths, out: args.out, timeout: args.timeout, misses, failures,
          only: args.states ? args.states.split(',').map((name) => name.trim()) : null
        });
      }
    }
  } finally {
    await browser.close();
  }

  if (misses.size) {
    console.log('\nno fixture, answered {}:');
    for (const name of [...misses].sort()) console.log(`  ${name}`);
  }
  if (failures.length) {
    console.error('\nfailed:');
    for (const f of failures) console.error(`  ${f}`);
    return 1;
  }
  console.log(`\nwrote screenshots under ${args.out}`);
  return 0;
}

// Guarded so a check can import the helpers above without running a capture.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
