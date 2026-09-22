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
export async function loadChromium() {
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
      `  PLAYWRIGHT_MODULE=/abs/path/to/node_modules/playwright/index.mjs node ${process.argv[1] ?? ''}\n` +
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
  // Every other screen is photographed loaded by a state below, beside its own empty, error and
  // dialog shots, so one `--only` covers a whole screen rather than half of it.
  routes: '/keys',
  widths: '1440,1024,400',
  out: path.join(HERE, 'out'),
  timeout: 15000,
  // The screen the shell states are photographed on: it has a rail link to mark and no map canvas.
  stateRoute: '/keys'
};

// The height a page is booted and settled at, so the same amount sits above the fold in both apps,
// which is what the sticky header and the rail react to.
const VIEWPORT_HEIGHT = 900;

/**
 * `fullPage: true` photographs the DOCUMENT, and in both apps the document is exactly one viewport
 * tall: `.app { height: 100vh }` with the column below it scrolling inside `.app__main`
 * (React `frontend/src/styles.css:15,29`; Angular `frontend/src/styles.css:18,32` at 0038d3e).
 * Every shot was therefore 900px and nothing below the fold was ever compared. The fix belongs here and not in the app CSS:
 * the inner scroll container is the layout both apps ship. So each shot measures its own content
 * and grows the viewport to fit before firing.
 */
const MAX_VIEWPORT_HEIGHT = 12000;

// The real header. The loading skeleton carries the same class with aria-hidden, so matching on
// `.eao-header` alone would photograph a still-booting page as if it had loaded.
export const READY_SELECTOR = 'header.eao-header:not([aria-hidden="true"])';

// The skeleton's header, which is what the loading state is a picture of.
const SKELETON_SELECTOR = 'header.eao-header[aria-hidden="true"]';

// Both apps mark the current screen the same way and neither adds a class for it: Angular through
// `routerLinkActive` writing `aria-current`, React through NavLink's own default. Waiting on it is
// what stops a shot landing before the rail has caught up with the route — the last run
// photographed Angular's /workspace at 1440 with no link marked.
const ACTIVE_NAV_SELECTOR = '.app-sidebar__link[aria-current="page"]';

// Below this the rail goes off-canvas in both apps (frontend/src/shell/useNarrow.ts), so
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
  --apps <list>      Which apps to photograph      (default angular,react)
  --dry-run          Launch the browser and print the plan; visit no app
  --help             This text

Output: <out>/<screen>/<width>/{angular,react}.png, <out>/_shell/<state>/<width>/ and
        <out>/_screens/<state>/<width>/. Each page settles at ${VIEWPORT_HEIGHT}px, then the
        viewport grows to the content's own height (cap ${MAX_VIEWPORT_HEIGHT}px) so the shot
        reaches below the fold; a shot with a modal open keeps the settled height. A PNG shorter
        than the content it was measured at fails.
API calls are answered from parity/fixtures; env.js is rewritten in flight so both apps
boot with Keycloak off. Both base URLs must be on this machine. Playwright is resolved by
name, or from PLAYWRIGHT_MODULE. Exit code is non-zero if any capture fails.`);
}

function parseArgs(argv) {
  const args = { ...DEFAULTS, dryRun: false, help: false, only: 'all', apps: 'angular,react' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--only') args.only = argv[++i];
    else if (a === '--state-route') args.stateRoute = argv[++i];
    else if (a === '--states') args.states = argv[++i];
    else if (a === '--apps') args.apps = argv[++i];
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

// Basemap tile hosts: Esri for the React map, OpenStreetMap for the Angular one. A capture run
// must not depend on the internet, and nobody's imagery belongs in a parity shot, so both are
// answered here with a blank pixel and the map settles on an empty ground.
const TILE_HOSTS = new Set(['server.arcgisonline.com', 'tile.openstreetmap.org']);

const BLANK_TILE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

export const isTileRequest = (url) => TILE_HOSTS.has(new URL(url).hostname);

export async function routeTiles(page) {
  await page.route(isTileRequest, (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: BLANK_TILE })
  );
}

// DataBC serves the wildfire points, the invasive-species tiles and the GetFeatureInfo answers
// behind the overlays. A capture run must not reach it: the fixtures below are the whole of what
// those overlays are photographed against.
export const DATA_HOSTS = new Set(['openmaps.gov.bc.ca']);

export const isDataBcRequest = (url) => DATA_HOSTS.has(new URL(url).hostname);

/** Which fixture answers a DataBC request, by what the query string asks for. */
export function dataBcFixture(url) {
  const query = new URL(url).search;
  if (/request=GetFeatureInfo/i.test(query)) return 'databc-featureinfo.json';
  if (/request=GetMap/i.test(query)) return 'tile';
  if (/resultType=hits/i.test(query)) return 'hits';
  if (/request=GetFeature/i.test(query)) return 'databc-wildfires.json';
  return null;
}

/** The `hits` envelope a WFS answers a count with, which is all the species counter reads. */
const HITS_XML =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0" ' +
  'numberMatched="128" numberReturned="0"/>';

export async function routeDataBc(page, misses) {
  await page.route(isDataBcRequest, async (route) => {
    const name = dataBcFixture(route.request().url());
    if (name === 'tile') {
      await route.fulfill({ status: 200, contentType: 'image/png', body: BLANK_TILE });
      return;
    }
    if (name === 'hits') {
      await route.fulfill({ status: 200, contentType: 'text/xml', body: HITS_XML });
      return;
    }
    const file = name ? path.join(FIXTURE_DIR, name) : null;
    if (file && existsSync(file)) {
      await route.fulfill({ contentType: 'application/json', body: readFileSync(file, 'utf-8') });
      return;
    }
    if (name) misses.add(name);
    await route.fulfill({ contentType: 'application/json', body: '{"features":[]}' });
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
export async function routeEnv(page, failures, label, extra) {
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

/**
 * How tall this page's content really is, and whether a modal is holding it.
 *
 * The document alone under-reports (see MAX_VIEWPORT_HEIGHT), so every scrolling ancestor of
 * `<main>` is measured too: its distance down the page plus its own scrollHeight is how far its
 * content reaches. A dialog is reported rather than measured — see `shoot`.
 */
function measurePage(page) {
  return page.evaluate(() => {
    let content = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
    for (let el = document.querySelector('main'); el && el !== document.body; el = el.parentElement) {
      if (!/(auto|scroll)/.test(getComputedStyle(el).overflowY)) continue;
      content = Math.max(content, el.getBoundingClientRect().top + window.scrollY + el.scrollHeight);
    }
    return {
      content: Math.ceil(content),
      modal: !!document.querySelector('dialog[open], [role="dialog"]')
    };
  });
}

/** A PNG's pixel height, straight out of the IHDR chunk, so the assertion reads the real file. */
export function pngHeight(file) {
  const head = readFileSync(file).subarray(0, 24);
  if (head.readUInt32BE(0) !== 0x89504e47) throw new Error(`${file} is not a PNG`);
  return head.readUInt32BE(20);
}

/**
 * Take the shot, growing the viewport to whatever the page's content needs first and putting it
 * back after. A shot with a modal open keeps the booted height: the dialogs are capped at 85vh
 * (styles.css `.ps-dialog__sheet`, `.how-built__sheet`), so resizing would photograph a different
 * dialog than the one the state is about.
 */
async function shoot(page, dir, label, width) {
  const { content, modal } = await measurePage(page);
  const target = modal ? VIEWPORT_HEIGHT : Math.max(VIEWPORT_HEIGHT, Math.min(content, MAX_VIEWPORT_HEIGHT));
  if (!modal && content > MAX_VIEWPORT_HEIGHT) {
    throw new Error(`content is ${content}px, past the ${MAX_VIEWPORT_HEIGHT}px cap; the page is not a screenshot`);
  }

  if (target !== VIEWPORT_HEIGHT) {
    await page.setViewportSize({ width, height: target });
    // Two frames: one for the resize to land, one for the layout it triggers to paint.
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  }
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${label}.png`);
  try {
    await page.screenshot({ path: file, fullPage: true });
  } finally {
    if (target !== VIEWPORT_HEIGHT) await page.setViewportSize({ width, height: VIEWPORT_HEIGHT });
  }

  const shot = pngHeight(file);
  const want = modal ? VIEWPORT_HEIGHT : content;
  if (shot < want) throw new Error(`shot is ${shot}px but the content needs ${want}px`);
  return `${shot}px${modal ? ' (modal, not resized)' : ''}`;
}

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
 * A native confirm() is browser chrome and never lands in a screenshot, so the question itself is
 * written out beside the shot and the page is photographed with nothing sent.
 */
function confirmRecorder(selector) {
  return async (page, width, timeout, out) => {
    const asked = [];
    page.on('dialog', async (dialog) => {
      asked.push(dialog.message());
      await dialog.dismiss();
    });
    // The click resolves only once the dialog has been answered, so `asked` is filled by here.
    await page.click(selector);
    mkdirSync(out, { recursive: true });
    writeFileSync(path.join(out, 'confirm.txt'), asked.join('\n') + '\n');
  };
}

// --- Map Explorer -----------------------------------------------------------------------------
// The shared project fixture carries no coordinates, so every row would land on one BC-centre
// fallback pin. This one spreads them over the province and puts two side by side, so a capture
// shows single pins and a bubble.
const MAP_CORPUS = [{ match: /dataset=Project/, file: 'search-project-map.json' }];

/** Both apps draw a project pin with this class, and the selected card with this region. */
const MAP_MARKER = '.demi-marker';
/** The rail's "N of M projects" line, which both apps put beside the sort control. */
const RAIL_COUNT = 'div:has(> label:has(select[aria-label="Sort results"])) > .cell__title';

/** One line, whatever the element wraps onto: a chip carries its own remove button's ✕. */
const lineOf = async (page, selector) =>
  (await page.locator(selector).first().innerText()).replace(/\s+/g, ' ').trim();
const MAP_CARD = '[role="region"][aria-labelledby="demi-selected-title"]';
const MAP_SECTOR = 'Energy Transmission';

/** Long enough for a fly-to to land; neither app reports the camera coming to rest. */
const MAP_CAMERA_MS = 1500;

const waitForMap = (page, width, timeout) => page.waitForSelector(MAP_MARKER, { timeout });

// Neither app puts a class on the Layers panel, so it is found by the heading it opens with; the
// same holds for one filter section. Both apps use these words.
const LAYERS_PANEL = 'div:has(> .micro-label:text-is("Boundary overlays"))';
const WILDFIRE_MARKER = '.wildfire-marker-pill';
const DISTRICT_SECTION = 'div:has(> button:has-text("Regional district"))';

async function openLayers(page, timeout) {
  await page.locator('button:has-text("Layers")').first().click();
  await page.waitForSelector(LAYERS_PANEL, { timeout });
}

const checkbox = (page, panel, label) =>
  page.locator(`${panel} label:has-text("${label}") input[type="checkbox"]`).first();

/** Every URL a page asked for, so a state can prove an overlay reached the network. */
const requestLog = new WeakMap();

const requestsMatching = (page, pattern) =>
  (requestLog.get(page) || []).filter((url) => pattern.test(url));

const boundaryReads = (page) =>
  requestsMatching(page, /geojson|\/boundaries/).map((url) => new URL(url).pathname);

const wmsTiles = (page) => requestsMatching(page, /request=GetMap/i);

async function selectMapProject(page, timeout) {
  await page.click('.demi-row:has-text("Sample Delta Pipeline")');
  await page.waitForSelector(MAP_CARD, { timeout });
  await page.waitForTimeout(MAP_CAMERA_MS);
}

// Both apps arm the lasso from a pressed-state button with this word on it, and both draw with
// pointer events on the map container: React's own handlers, Angular's through Leaflet. So one
// gesture drives both — a real mouse drag, which Chromium turns into the pointer stream each
// listens for. Fewer than this many points is discarded as a stray click by both (LASSO_MIN_POINTS).
const LASSO_BUTTON = 'button[aria-pressed]:has-text("Lasso")';
const LASSO_CHIP = 'button[aria-label="Remove filter"]:has-text("Lasso area")';
const LASSO_STEPS = 12;

async function armLasso(page, timeout) {
  await page.locator(LASSO_BUTTON).first().click();
  await page.waitForSelector(`${LASSO_BUTTON}[aria-pressed="true"]`, { timeout });
}

/** Drag a rough circle inside the map pane, big enough to enclose pins and to commit. */
async function drawLasso(page) {
  const box = await page.locator('#demi-map').boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const radius = Math.min(box.width, box.height) * 0.3;
  const at = (i) => {
    const angle = (i / LASSO_STEPS) * 2 * Math.PI;
    return [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)];
  };

  await page.mouse.move(...at(0));
  await page.mouse.down();
  for (let i = 1; i <= LASSO_STEPS; i++) await page.mouse.move(...at(i));
  await page.mouse.up();
}

/**
 * Each screen loaded, and every state it reaches only through its own data or a click. `responses`
 * replaces what the API answers with; `prepare` drives the page once it has settled. Same selectors
 * work on both apps, because the React port keeps the Angular markup.
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
    name: 'keys-revoke-confirm',
    route: '/keys',
    prepare: confirmRecorder('.row-actions button:text-is("Revoke")')
  },
  {
    name: 'notify-loaded',
    route: '/notify'
  },
  {
    name: 'notify-empty',
    route: '/notify',
    responses: [
      { match: /^\/notify-api\/api\/staff\/stats$/, file: 'api-staff-stats-empty.json' },
      { match: /^\/notify-api\/api\/staff\/campaigns$/, file: 'api-staff-campaigns-empty.json' }
    ]
  },
  {
    name: 'notify-error',
    route: '/notify',
    responses: [
      { match: /^\/notify-api\/api\/staff\/stats$/, status: 500, file: 'api-error.json' },
      { match: /^\/notify-api\/api\/staff\/campaigns$/, status: 500, file: 'api-error.json' }
    ]
  },
  {
    // More than one template, so the first click opens the picker rather than sending anything.
    name: 'notify-template-picker',
    route: '/notify',
    prepare: async (page, width, timeout) => {
      await page.click('button:text-is("Send test email")');
      await page.waitForSelector('select[aria-label="Template to test"]', { timeout });
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
    // The province-wide opening view. A pin on the page is the proof the map got past its worker
    // and its style: neither app draws one until the source has been loaded and tiled.
    name: 'map-loaded',
    route: '/map',
    widths: [1440, 1024, 400],
    responses: MAP_CORPUS,
    prepare: waitForMap
  },
  {
    name: 'map-selected',
    route: '/map',
    widths: [1440],
    responses: MAP_CORPUS,
    prepare: async (page, width, timeout) => {
      await waitForMap(page, width, timeout);
      await selectMapProject(page, timeout);
    }
  },
  {
    name: 'map-all-fields',
    route: '/map',
    widths: [1440],
    responses: MAP_CORPUS,
    prepare: async (page, width, timeout) => {
      await waitForMap(page, width, timeout);
      await selectMapProject(page, timeout);
      await page.click(`${MAP_CARD} button:has-text("All fields")`);
      await page.waitForSelector(`${MAP_CARD} .kv-row`, { timeout });
    }
  },
  {
    name: 'map-filtered',
    route: '/map',
    widths: [1440],
    responses: MAP_CORPUS,
    prepare: async (page, width, timeout) => {
      await waitForMap(page, width, timeout);
      await page.click('button:has-text("Filters")');
      // Both apps open the Sector section first, so its options are on the page already.
      await page.click(`label:has-text("${MAP_SECTOR} (2)") input[type="checkbox"]`);
      await page.waitForSelector('button[aria-label="Remove filter"]', { timeout });
    }
  },
  {
    // Words nothing in the corpus answers. The corpus is served, not emptied: both apps re-filter
    // the API's answer themselves, and only a loaded corpus has sectors to suggest instead.
    name: 'map-empty',
    route: '/map',
    widths: [1440],
    responses: MAP_CORPUS,
    prepare: async (page, width, timeout) => {
      await waitForMap(page, width, timeout);
      await page.fill('#demi-search-map', 'zzz nothing here matches');
      await page.waitForSelector('text=No projects match', { timeout });
      // The rail settles on the debounced query, which arrives after the message itself.
      await page.waitForTimeout(MAP_CAMERA_MS);
    }
  },
  {
    name: 'map-layers-open',
    route: '/map',
    widths: [1440, 1024, 400],
    responses: MAP_CORPUS,
    prepare: async (page, width, timeout) => {
      await waitForMap(page, width, timeout);
      await openLayers(page, timeout);
    },
    fact: async (page) => `layer rows: ${await page.locator(`${LAYERS_PANEL} label`).count()}`
  },
  {
    name: 'map-boundary-overlay',
    route: '/map',
    widths: [1440, 1024, 400],
    responses: MAP_CORPUS,
    prepare: async (page, width, timeout) => {
      await waitForMap(page, width, timeout);
      await openLayers(page, timeout);
      await checkbox(page, LAYERS_PANEL, 'Regional districts').click();
      await page.waitForTimeout(MAP_CAMERA_MS);
    },
    // The boundary read is what the overlay is drawn from; both apps fetch the same asset.
    fact: async (page) => `boundary reads: ${boundaryReads(page).join(', ') || 'none'}`
  },
  {
    name: 'map-wildfires',
    route: '/map',
    widths: [1440, 1024, 400],
    responses: MAP_CORPUS,
    prepare: async (page, width, timeout) => {
      await waitForMap(page, width, timeout);
      await openLayers(page, timeout);
      await checkbox(page, LAYERS_PANEL, 'Active wildfires').click();
      await page.waitForSelector(WILDFIRE_MARKER, { timeout });
    },
    fact: async (page) => `wildfire markers: ${await page.locator(WILDFIRE_MARKER).count()}`
  },
  {
    name: 'map-invasives',
    route: '/map',
    widths: [1440, 1024, 400],
    responses: MAP_CORPUS,
    prepare: async (page, width, timeout) => {
      await waitForMap(page, width, timeout);
      await openLayers(page, timeout);
      await checkbox(page, LAYERS_PANEL, 'Invasive species observations').click();
      await page.fill('#demi-invasives-species', 'Baby');
      await page.waitForTimeout(MAP_CAMERA_MS);
    },
    // A WMS tile request only happens once the raster layer is on the map and being drawn.
    fact: async (page) => {
      const tile = wmsTiles(page).at(-1);
      return tile ? `WMS tile: ${decodeURIComponent(tile).slice(0, 160)}` : 'WMS tile: none';
    }
  },
  {
    name: 'map-boundary-filter',
    route: '/map',
    widths: [1440, 1024, 400],
    responses: MAP_CORPUS,
    prepare: async (page, width, timeout) => {
      await waitForMap(page, width, timeout);
      await page.locator('button:has-text("Filters")').first().click();
      await page.locator(`${DISTRICT_SECTION} > button`).first().click();
      await page.locator(`${DISTRICT_SECTION} label input[type="checkbox"]`).first().click();
      await page.waitForSelector('button[aria-label="Remove filter"]', { timeout });
    },
    fact: async (page) =>
      `chip: ${await lineOf(page, 'button[aria-label="Remove filter"]')}`
  },
  {
    // Armed but nothing drawn yet: the button's pressed state and whatever hint each app shows.
    name: 'map-lasso-armed',
    route: '/map',
    widths: [1440, 1024, 400],
    responses: MAP_CORPUS,
    prepare: async (page, width, timeout) => {
      await waitForMap(page, width, timeout);
      await armLasso(page, timeout);
    },
    fact: async (page) =>
      `lasso armed: ${await page.locator(LASSO_BUTTON).first().getAttribute('aria-pressed')}`
  },
  {
    // A lasso committed by a real drag, which is the only way either app makes one. Both run
    // signed out here, so neither offers to save it: the chip is the whole of the committed state.
    name: 'map-lasso-committed',
    route: '/map',
    widths: [1440, 1024, 400],
    responses: MAP_CORPUS,
    prepare: async (page, width, timeout) => {
      await waitForMap(page, width, timeout);
      // The opening camera is still easing when the first pin lands; a ring drawn then encloses
      // different ground in each app. Neither reports the camera coming to rest, so this waits.
      await page.waitForTimeout(MAP_CAMERA_MS);
      await armLasso(page, timeout);
      await drawLasso(page);
      await page.waitForSelector(LASSO_CHIP, { timeout });
      await page.waitForTimeout(MAP_CAMERA_MS);
    },
    // The chip says an area is on; the rail count says how much of the corpus it kept.
    fact: async (page) =>
      `chip: ${await lineOf(page, LASSO_CHIP)}; rail count: ${await lineOf(page, RAIL_COUNT)}`
  },
  {
    name: 'projects-filtered',
    route: '/projects',
    prepare: async (page, width, timeout) => {
      await page.waitForSelector('.pp-result', { timeout });
      await page.fill('#pp-search', 'sample b');
      await page.waitForFunction(() => document.querySelectorAll('.pp-result').length === 1, null, { timeout });
    }
  },
  {
    name: 'project-loaded',
    route: '/projects/901'
  },
  {
    // No stored summary row. The facts above it are the page, and they stay complete.
    name: 'project-empty',
    route: '/projects/901',
    responses: [{ match: /^\/api\/projects\/901\/summary$/, status: 404, file: 'api-error.json' }],
    ready: '.ps-note'
  },
  {
    // The project record itself refused. A 400, not a 500: React never retries this read
    // (App.tsx's client sets `retry: false`), but Angular retries a 5xx twice a second apart
    // (registry-state.service.ts:1412 through fetchWithRetry), so a 500 would photograph the two
    // apps in different places. On a 400 they both land on the message at once.
    name: 'project-error',
    route: '/projects/901',
    responses: [{ match: /^\/api\/projects\/901$/, status: 400, file: 'api-error.json' }],
    ready: '.callout--warning[role="alert"]:not(.alert-row)'
  },
  {
    name: 'project-condition-dialog',
    route: '/projects/901',
    prepare: async (page, width, timeout) => {
      await page.click('.ps-card--action');
      await page.waitForSelector('.ps-dialog__sheet', { timeout });
    }
  },
  {
    // The answer only exists once someone asks, so every summariser state goes through the box.
    name: 'summary-loaded',
    route: '/summary',
    prepare: async (page, width, timeout) => {
      await page.fill('#demi-search-summary', 'watercourse crossing');
      await page.click('button:text-is("Ask")');
      await page.waitForSelector('.pill--info', { timeout });
    }
  },
  {
    name: 'summary-empty',
    route: '/summary',
    responses: [{ match: /^\/api\/search\/summary/, file: 'search-summary-empty.json' }],
    prepare: async (page, width, timeout) => {
      await page.fill('#demi-search-summary', 'nothing matches this');
      await page.click('button:text-is("Ask")');
      await page.waitForSelector('.callout', { timeout });
    }
  },
  {
    name: 'summary-error',
    route: '/summary',
    responses: [{ match: /^\/api\/search\/summary/, status: 500, file: 'api-error.json' }],
    prepare: async (page, width, timeout) => {
      await page.fill('#demi-search-summary', 'watercourse crossing');
      await page.click('button:text-is("Ask")');
      // Both apps retry a 5xx twice a second apart before the message lands, so this waits it out.
      await page.waitForSelector('.callout', { timeout: Math.max(timeout, 10000) });
    }
  },
  {
    // Keycloak is off for a capture run, so this is the screen with no session: the token claims
    // are empty and the row offers the pill rather than Sign out. There is no other state to reach.
    name: 'sessions-loaded',
    route: '/sessions'
  },
  {
    name: 'links-loaded',
    route: '/links'
  },
  {
    name: 'links-empty',
    route: '/links',
    responses: [{ match: /^\/api\/links$/, file: 'links-empty.json' }]
  },
  {
    name: 'links-error',
    route: '/links',
    responses: [{ match: /^\/api\/links$/, status: 500, file: 'api-error.json' }]
  },
  {
    name: 'links-form-open',
    route: '/links',
    prepare: async (page, width, timeout) => {
      await page.click('button:text-is("New short link")');
      await page.waitForSelector('button:text-is("Create link")', { timeout });
    }
  },
  {
    name: 'links-repoint',
    route: '/links',
    prepare: async (page, width, timeout) => {
      await page.click('.row-actions button:text-is("Repoint")');
      await page.waitForSelector('input[aria-label="New destination"]', { timeout });
    }
  },
  {
    name: 'links-delete-confirm',
    route: '/links',
    prepare: confirmRecorder('.row-actions button:text-is("Delete")')
  },
  {
    name: 'workspace-loaded',
    route: '/workspace'
  },
  {
    // The simulator sits behind a session, and a capture run has none, so both apps show the rules
    // and the sign-in note. The engine's answer cannot be photographed without a real token.
    name: 'rbac-signed-out',
    route: '/rbac'
  }
];

async function captureScreenStates({ browser, label, base, widths, out, timeout, misses, failures, only }) {
  for (const state of SCREEN_STATES.filter((s) => !only || only.includes(s.name))) {
    for (const width of state.widths || widths) {
      const dir = path.join(out, '_screens', state.name, String(width));
      const { context, page, pageErrors, consoleErrors, failedRequests } = await newPage({
        browser, width, label, misses, failures, state
      });
      try {
        await page.goto(new URL(state.route, base).href, { waitUntil: 'domcontentloaded', timeout });
        await settle(page, { ...state, activeNav: width >= NARROW_BREAKPOINT }, timeout);
        if (state.prepare) await state.prepare(page, width, timeout, dir);
        const size = await shoot(page, dir, label, width);
        console.log(`ok   ${label.padEnd(8)}${String(width).padEnd(6)}_screens/${state.name.padEnd(26)}${size}`);
        // What the state claims it drew, read back off the page, so a green run is more than a
        // screenshot nobody looked at.
        if (state.fact) {
          const fact = await state.fact(page);
          writeFileSync(path.join(dir, `${label}-fact.txt`), `${fact}\n`);
          console.log(`fact ${label.padEnd(8)}${String(width).padEnd(6)}${state.name}: ${fact}`);
        }
        const noise = [
          ...pageErrors.map((line) => `page error: ${line}`),
          ...consoleErrors.map((line) => `console error: ${line}`),
          ...failedRequests.map((line) => `request failed: ${line}`)
        ];
        if (noise.length) {
          writeFileSync(path.join(dir, `${label}-issues.txt`), noise.join('\n') + '\n');
          console.log(`note ${label.padEnd(8)}${String(width).padEnd(6)}${state.name}: ${noise.length} issue(s)`);
        }
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
  const consoleErrors = [];
  const failedRequests = [];
  page.on('pageerror', (err) => pageErrors.push(String(err.message || err)));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  const requests = [];
  requestLog.set(page, requests);
  page.on('request', (request) => requests.push(request.url()));
  page.on('requestfailed', (request) =>
    failedRequests.push(`${request.url()} ${request.failure()?.errorText ?? ''}`.trim())
  );
  await routeEnv(page, failures, label, state.env);
  await routeTiles(page);
  await routeDataBc(page, misses);
  await routeApi(page, misses, state);
  return { context, page, pageErrors, consoleErrors, failedRequests };
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
        const size = await shoot(page, dir, label, width);
        console.log(`ok   ${label.padEnd(8)}${String(width).padEnd(6)}${route.padEnd(34)}${size}`);
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
        const size = await shoot(page, dir, label, width);
        // Let the delayed response land inside a page that is still open to receive it, rather
        // than closing the context out from under an in-flight route handler.
        if (state.thenReady) await page.waitForSelector(state.thenReady, { timeout });
        console.log(`ok   ${label.padEnd(8)}${String(width).padEnd(6)}_shell/${state.name.padEnd(27)}${size}`);
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
  console.log(`widths   ${widths.join(', ')} (settled at ${VIEWPORT_HEIGHT}, grown to fit up to ${MAX_VIEWPORT_HEIGHT})`);
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
    const apps = splitList(args.apps);
    for (const [label, base] of [['angular', args.angular], ['react', args.react]]) {
      if (!apps.includes(label)) continue;
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
