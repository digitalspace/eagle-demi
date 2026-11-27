import { readFileSync } from 'node:fs';
import path from 'node:path';
import { FIXTURE_DIR } from '../parity/capture.mjs';

const FIXTURE_TODAY = new Date('2026-11-17T12:00:00Z');

/**
 * Reasons a click on a lookahead week bar fails to start that week's section at the top of the agenda (wide),
 * or fails to bring its heading on screen (narrow, where the page scrolls too).
 */
export async function checkJump(context, base, timeout) {
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

const ACT_IDS = ['act-2018', 'act-2002', 'act-1996'];

/** Reasons the Overview fails to draw one open section per Act, newest first, with its jump link, or to fade in a start with no date. */
export async function checkActs(context, base, timeout) {
  const reasons = [];
  const page = await context.newPage();
  try {
    await page.clock.setFixedTime(FIXTURE_TODAY);
    await page.goto(new URL('/workplans', base).toString(), { waitUntil: 'domcontentloaded' });
    await page.locator('section.wp-ov-act').first().waitFor({ timeout });
    const ids = await page.locator('section.wp-ov-act').evaluateAll((els) => els.map((el) => el.id));
    if (ids.join() !== ACT_IDS.join()) reasons.push(`Act sections are ${ids.join(', ')}, want ${ACT_IDS.join(', ')}`);
    const nav = page.getByRole('navigation', { name: 'Navigate the timeline' });
    const jumps = await nav.getByRole('link', { name: /^\d{4} Act$/ }).allTextContents();
    if (jumps.join() !== '2018 Act,2002 Act,1996 Act') reasons.push(`Jump to links are ${jumps.join(', ') || 'missing'}, want 2018, 2002, 1996`);
    for (const year of [2018, 2002, 1996]) {
      if (!(await page.getByRole('region', { name: new RegExp(`^${year} Act timeline, `) }).isVisible())) reasons.push(`${year} Act timeline is not open`);
    }
    // The fixture's 1996 sheet works have phases with an end but no recorded start.
    const leads = await page.locator('#act-1996 .wp-ov-mk.lead').evaluateAll((els) =>
      els.map((el) => `${getComputedStyle(el).backgroundImage.startsWith('linear-gradient') ? 'fade' : 'flat'} ${getComputedStyle(el).borderLeftWidth}`)
    );
    const kinds = [...new Set(leads)].join(', ');
    if (kinds !== 'fade 0px') reasons.push(`no-start lead-ins are ${kinds || 'missing'}, want a fade with no left border`);
  } catch (e) {
    reasons.push(String(e.message ?? e));
  } finally {
    await page.close();
  }
  return reasons;
}

/**
 * Each Act's axis labels by section id, once every Act named in `equal` shows those labels and every one in `differ`
 * shows others. Which labels fit follows the track width the Overview last measured.
 */
const axisLabels = (page, timeout, { equal = {}, differ = {} } = {}) =>
  page
    .waitForFunction(
      ({ ids, equal, differ }) => {
        const got = Object.fromEntries(ids.map((id) => [id, [...document.querySelectorAll(`#${id} .wp-ov-tkl`)].map((el) => el.textContent).join(' | ')]));
        return Object.keys(equal).every((id) => got[id] === equal[id]) && Object.keys(differ).every((id) => got[id] !== differ[id]) && got;
      },
      { ids: ACT_IDS, equal, differ },
      { timeout }
    )
    .then((handle) => handle.jsonValue());

/**
 * Reasons a window resize with the 2018 Act minimized fails to lay out the other Acts' axes as a fresh load at the
 * new width does, or the 2018 axis once it reopens. A hidden Act measures 0 px wide, so measuring it would keep the old width.
 */
export async function checkResize(context, base, timeout) {
  const [from, to] = [1440, 1100];
  const reasons = [];
  const page = await context.newPage();
  try {
    await page.clock.setFixedTime(FIXTURE_TODAY);
    const load = async (width) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(new URL('/workplans', base).toString(), { waitUntil: 'domcontentloaded' });
      await page.locator('#act-1996 .wp-ov-tkl').first().waitFor({ timeout });
    };
    const trackPx = () => page.locator('#act-2002 .wp-ov-tlx').evaluate((box) => box.clientWidth - 368);

    await load(from);
    const wide = await axisLabels(page, timeout);
    // A fresh load at the narrow width measures a drawn 2018 box, so it gives the labels the resize must reach.
    await load(to);
    const want = await axisLabels(page, timeout, { differ: { 'act-2002': wide['act-2002'] } }).catch(() => {
      throw new Error(`2002 Act axis labels match at ${from}px and ${to}px, so the check proves nothing; widen the gap`);
    });

    await load(from);
    await page.locator('#act-2018').getByRole('button', { name: '2018 Act' }).click({ timeout });
    await page.getByRole('region', { name: /^2018 Act timeline, / }).waitFor({ state: 'hidden', timeout });
    await page.setViewportSize({ width: to, height: 900 });
    const others = { 'act-2002': want['act-2002'], 'act-1996': want['act-1996'] };
    await axisLabels(page, timeout, { equal: others }).catch(async () =>
      reasons.push(`2018 Act minimized: after a resize from ${from}px to ${to}px (2002 track ${await trackPx()}px) the 2002 and 1996 axis labels differ from a fresh load at ${to}px`)
    );

    await page.locator('#act-2018').getByRole('button', { name: '2018 Act' }).click({ timeout });
    await axisLabels(page, timeout, { equal: want }).catch(() => reasons.push(`2018 Act reopened at ${to}px: its axis labels differ from a fresh load at ${to}px`));
  } catch (e) {
    reasons.push(String(e.message ?? e));
  } finally {
    await page.close();
  }
  return reasons;
}
