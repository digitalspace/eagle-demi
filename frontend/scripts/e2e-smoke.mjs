#!/usr/bin/env node
// Smoke test for a served build: every screen and redirect, FITS, the lookahead week bar jump, and two-line timeline Days cells.
// Serve it first with `yarn build && yarn preview --host 127.0.0.1`; /api/** comes from parity/fixtures/, no disk writes.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  FIXTURE_DIR,
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
  { path: '/project-details', h1: 'Project details', text: '1996 Act (1)' },
  // `text` comes only from a panel's own fixture, so a panel reading the wrong id fails here.
  { path: '/project-details/901', h1: 'Sample Alpha Transmission Line', text: '1996 Act (1)' },
  { path: '/workplans', h1: 'Workplans', text: 'Sample Beta Quarry - Amendment' },
  { path: '/workplans?view=pipeline', h1: 'Workplans', text: 'Proponent time' },
  { path: '/workplans?view=lookahead', h1: 'Workplans', text: '90 days' },
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

// Screens that must not scroll sideways at these widths. `api` swaps the screen's read for an edited
// fixture (a long unbreakable code on the project page); `panel` must not scroll from `panelFrom` px up.
export const FIT_WIDTHS = [390, 768, 1280, 1440];
const LONG_CODE = 'sample_project_code_with_no_hyphen_to_break_at_all_sixty_four_ch';
export const FITS = [
  {
    path: '/projects/901',
    h1: 'Sample Alpha Transmission Line',
    api: {
      file: 'projects-901.json',
      edit: (facts) => ({
        ...facts,
        shortCode: LONG_CODE,
        shortUrl: `https://example.invalid/s/${LONG_CODE}`,
        legacyShortCodes: ['sample_old_code_that_is_also_long_with_no_hyphen_in_it'],
        shortLinkUrl: 'https://example.invalid/projects/sample-alpha/a_long_path_segment_with_no_hyphen_at_all',
        shortLinkCustom: true
      })
    }
  },
  {
    path: '/links',
    h1: 'Short URLs',
    // Project-held rows carry the pill and the "Edit on the project page" link, the widest cells.
    api: {
      file: 'links.json',
      edit: (rows) => [
        ...rows,
        { ...rows[0], id: LONG_CODE, shortUrl: `https://example.invalid/s/${LONG_CODE}`, projectId: '901', projectRole: 'current' },
        { ...rows[0], id: 'sample-old', shortUrl: 'https://example.invalid/s/sample-old', projectId: '901', projectRole: 'legacy' }
      ]
    },
    panel: '.panel--scroll',
    panelFrom: 1280
  },
  // The timeline and the pipeline columns scroll inside their own views, so only the page and <main> are measured.
  { path: '/workplans', h1: 'Workplans' },
  { path: '/workplans?view=pipeline', h1: 'Workplans' },
  { path: '/workplans?view=lookahead', h1: 'Workplans' }
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

Needs Playwright 1.45 or newer where Node can resolve it, or PLAYWRIGHT_MODULE set to its index.mjs.
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
    if (entry.text) {
      await page
        .getByText(entry.text, { exact: true })
        .first()
        .waitFor({ timeout })
        .catch(() => reasons.push(`"${entry.text}" never rendered`));
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

/** Reasons the page scrolls sideways at `width`: the document, or the app's own scrolling <main>. */
async function checkFit(context, base, entry, width, timeout) {
  const reasons = [];
  const page = await context.newPage();
  try {
    await page.setViewportSize({ width, height: 900 });
    if (entry.api) {
      const body = entry.api.edit(JSON.parse(readFileSync(path.join(FIXTURE_DIR, entry.api.file), 'utf-8')));
      await page.route((url) => new URL(url).pathname === `/api${entry.path}`, (route) => route.fulfill({ json: body }));
    }
    await page.goto(new URL(entry.path, base).toString(), { waitUntil: 'domcontentloaded' });
    await page
      .waitForFunction((want) => [...document.querySelectorAll('h1')].some((h) => h.textContent.trim() === want), entry.h1, { timeout })
      .catch(() => reasons.push(`h1 "${entry.h1}" never rendered`));
    await page.waitForLoadState('networkidle', { timeout }).catch(() => {});
    const panel = entry.panel && width >= entry.panelFrom ? entry.panel : null;
    if (panel && !(await page.$(`${panel} tbody tr`))) reasons.push(`${panel} has no rows to measure`);
    const wide = await page.evaluate((panel) =>
      [document.documentElement, document.querySelector('main'), ...(panel ? document.querySelectorAll(panel) : [])]
        .filter((el) => el && el.scrollWidth > el.clientWidth)
        .map((el) => `${el.tagName.toLowerCase()}${el.className ? `.${el.className.split(' ').join('.')}` : ''} ${el.scrollWidth}px in ${el.clientWidth}px`),
      panel
    );
    reasons.push(...wide);
  } catch (e) {
    reasons.push(String(e.message ?? e));
  } finally {
    await page.close();
  }
  return reasons;
}

const FIXTURE_TODAY = new Date('2026-11-17T12:00:00Z');

/**
 * Reasons a click on a lookahead week bar fails to start that week's section at the top of the agenda (wide),
 * or fails to bring its heading on screen (narrow, where the page scrolls too).
 */
async function checkJump(context, base, timeout) {
  const reasons = [];
  const page = await context.newPage();
  try {
    // The fixture's milestones sit in the 90 days after this date; twelve copies of each work make the agenda scroll.
    await page.clock.setFixedTime(FIXTURE_TODAY);
    const { works } = JSON.parse(readFileSync(path.join(FIXTURE_DIR, 'workplans.json'), 'utf-8'));
    const copies = works.flatMap((work) => Array.from({ length: 12 }, (_, i) => ({ ...work, workId: `${work.workId}-${i}` })));
    await page.route((url) => new URL(url).pathname === '/api/workplans', (route) => route.fulfill({ json: { works: copies } }));
    const url = new URL('/workplans?view=lookahead', base).toString();
    const bar = page.getByRole('button', { name: /^Week of Dec 14:/ });
    const head = page.getByRole('heading', { name: /^Week of Dec 14/ });
    const load = async () => {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.locator('.la-week').first().waitFor({ timeout });
      if ((await bar.count()) === 0) {
        throw new Error('no "Week of Dec 14" bar: frontend/parity/fixtures/workplans.json must keep a milestone in the week of 2026-12-14');
      }
    };

    await load();
    await bar.click({ timeout });
    // The heading is sticky, so measure its section: an overshoot inside the week still moves the section.
    const gap = await head.evaluate(
      (h) => h.parentElement.getBoundingClientRect().top - h.closest('.la-agenda').getBoundingClientRect().top
    );
    if (Math.abs(gap) > 1) {
      reasons.push(`wide: week section starts ${Math.round(Math.abs(gap))}px ${gap > 0 ? 'below' : 'above'} the agenda top`);
    }

    // At 390x500 the agenda starts at the fold and main.app__main scrolls, so only focus can bring the heading into view.
    await page.setViewportSize({ width: 390, height: 500 });
    await load();
    const onScreen = () =>
      head.evaluate((h) => {
        const { top, bottom } = h.getBoundingClientRect();
        return { top: Math.round(top), bottom: Math.round(bottom), fits: top >= 0 && bottom <= innerHeight };
      });
    if ((await onScreen()).fits) {
      reasons.push('narrow: heading is already on screen before the click, so the check proves nothing; shorten the viewport');
    } else {
      // click() would scroll the bar into view, which lifts the agenda on screen and hides a focus bug.
      await bar.dispatchEvent('click');
      const after = await onScreen();
      if (!after.fits) reasons.push(`narrow: heading spans y ${after.top} to ${after.bottom}, outside the 500px window`);
    }
  } catch (e) {
    reasons.push(String(e.message ?? e));
  } finally {
    await page.close();
  }
  return reasons;
}

/** Reasons a timeline Days cell that wraps to two lines ("311 d, suspended") spills out of its row. */
async function checkDays(context, base, timeout) {
  const reasons = [];
  const page = await context.newPage();
  try {
    await page.clock.setFixedTime(FIXTURE_TODAY);
    await page.goto(new URL('/workplans?view=timeline', base).toString(), { waitUntil: 'domcontentloaded' });
    await page.locator('li.timeline__row .timeline__days').first().waitFor({ timeout });
    // The spill comes from BC Sans metrics, so measure only once the real font is in.
    const cells = await page.evaluate(async () => {
      await document.fonts.ready;
      const font = [...document.fonts].some((face) => face.family.replace(/"/g, '') === 'BC Sans' && face.status === 'loaded');
      return [...document.querySelectorAll('li.timeline__row .timeline__days')].map((cell) => {
        const range = document.createRange();
        range.selectNodeContents(cell);
        const row = cell.closest('li.timeline__row');
        const pad = getComputedStyle(row);
        return {
          font,
          text: cell.textContent.trim(),
          lines: new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size,
          scroll: cell.scrollHeight,
          client: cell.clientHeight,
          height: cell.getBoundingClientRect().height,
          row: row.clientHeight - parseFloat(pad.paddingTop) - parseFloat(pad.paddingBottom)
        };
      });
    });
    if (cells.length && !cells[0].font) reasons.push('BC Sans never loaded, so the cells were measured in a fallback font');
    const wrapped = cells.filter((cell) => cell.lines === 2);
    if (!wrapped.length) {
      reasons.push(
        `no Days cell wraps to two lines (${cells.map((cell) => `"${cell.text}"`).join(', ')}): frontend/parity/fixtures/workplans.json must keep an open suspended work`
      );
    }
    for (const cell of wrapped) {
      if (cell.scroll > cell.client) reasons.push(`"${cell.text}" content is ${cell.scroll}px in a ${cell.client}px cell`);
      if (cell.height > cell.row) reasons.push(`"${cell.text}" cell is ${cell.height}px in a ${cell.row}px row`);
    }
  } catch (e) {
    reasons.push(String(e.message ?? e));
  } finally {
    await page.close();
  }
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
  // NrptiPanel reads NRPTI's prod API straight from the browser; the smoke must not depend on it.
  await context.route((url) => url.hostname.startsWith('nrpti-api-'), (route) => route.fulfill({ json: [{ searchResults: [] }] }));

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

  for (const entry of FITS) {
    for (const width of FIT_WIDTHS) {
      const reasons = await checkFit(context, args.base, entry, width, args.timeout);
      const label = `${entry.path} fits ${width}px`;
      if (reasons.length === 0) {
        ok++;
        console.log(`OK   ${label}`);
      } else {
        fail++;
        console.log(`FAIL ${label}: ${reasons.join('; ')}`);
      }
    }
  }

  const jumpReasons = await checkJump(context, args.base, args.timeout);
  if (jumpReasons.length === 0) {
    ok++;
    console.log('OK   /workplans?view=lookahead week bar jumps to its week');
  } else {
    fail++;
    console.log(`FAIL /workplans?view=lookahead week bar jumps to its week: ${jumpReasons.join('; ')}`);
  }

  const daysReasons = await checkDays(context, args.base, args.timeout);
  if (daysReasons.length === 0) {
    ok++;
    console.log('OK   /workplans?view=timeline two-line Days cells fit their row');
  } else {
    fail++;
    console.log(`FAIL /workplans?view=timeline two-line Days cells fit their row: ${daysReasons.join('; ')}`);
  }

  await browser.close();
  if (misses.size) console.log(`no fixture (answered {}): ${[...misses].sort().join(', ')}`);
  console.log(
    `smoke: screens=${SCREENS.length} redirects=${REDIRECTS.length} fits=${FITS.length * FIT_WIDTHS.length} jump=1 days=1 ok=${ok} fail=${fail}`
  );
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('unhandled:', e);
  process.exit(1);
});
