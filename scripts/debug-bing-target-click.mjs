import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { firefox, chromium } from 'playwright';

const REPORT_PATH = process.env.REPORT_PATH || path.join(os.tmpdir(), 'bing-target-click.json');
const QUERY = 'antminer s9';
const TARGET_PATH = '/articles/mining/mining-with-antminer-s9-asic-is-it-still-profitable/';
const TARGET_TITLE = 'Mining with Antminer S9 ASIC: Is It Still Profitable?';
const report = { query: QUERY, clicked: false, attempts: [], finalUrl: null, referrer: null, rawHref: null, decodedHref: null, matchedTitle: null, error: null };
const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim();
const normHost = (v) => String(v || '').toLowerCase().replace(/^www\./, '');

function decode(href) {
  try {
    const u = new URL(href, 'https://www.bing.com');
    const encoded = u.searchParams.get('u') || '';
    if (!encoded.startsWith('a1')) return u.toString();
    let raw = encoded.slice(2);
    raw += '='.repeat((4 - raw.length % 4) % 4);
    return Buffer.from(raw, 'base64').toString('utf8');
  } catch { return href; }
}

function isTarget(value) {
  try {
    const u = new URL(value);
    return normHost(u.hostname) === 'emcd.io' && u.pathname.replace(/\/+$/, '/') === TARGET_PATH;
  } catch { return false; }
}

function titleMatch(value) {
  const n = (s) => clean(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return n(value) === n(TARGET_TITLE) || (n(value).includes('mining with antminer s9 asic') && n(value).includes('still profitable'));
}

async function run(browserName, launcher) {
  const out = { browser: browserName, searched: false, resultCount: 0, anchorCount: 0, emcdCandidates: [], error: null };
  let browser;
  try {
    browser = await launcher.launch({ headless: true });
    const page = await browser.newPage({ locale: 'en-US', viewport: { width: 1440, height: 900 } });
    await page.goto('https://www.bing.com/?cc=US&setlang=en-US', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(1200);
    const input = page.locator('#sb_form_q').first();
    if (!(await input.isVisible().catch(() => false))) throw new Error('input_missing');
    await input.fill(QUERY);
    await input.press('Escape').catch(() => {});
    await page.waitForTimeout(350);

    const icon = page.locator('#search_icon').first();
    const box = await icon.boundingBox().catch(() => null);
    if (box) {
      const before = page.url();
      const nav = page.waitForURL((u) => u.toString() !== before && u.pathname === '/search', { timeout: 8000, waitUntil: 'domcontentloaded' }).catch(() => null);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 }).catch(() => {});
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2).catch(() => {});
      await nav;
    }

    if (new URL(page.url()).pathname !== '/search') {
      const before = page.url();
      const nav = page.waitForURL((u) => u.toString() !== before && u.pathname === '/search', { timeout: 9000, waitUntil: 'domcontentloaded' }).catch(() => null);
      await input.evaluate((el) => {
        const form = el.form || el.closest('form');
        if (form) HTMLFormElement.prototype.submit.call(form);
      }).catch(() => {});
      await nav;
    }

    if (new URL(page.url()).pathname !== '/search') throw new Error('search_submit_failed');
    out.searched = true;
    await page.waitForTimeout(1600);
    out.resultCount = await page.locator('li.b_algo h2 a[href]').count();

    const anchors = page.locator('a[href]');
    const count = Math.min(await anchors.count(), 600);
    out.anchorCount = count;
    let found = null;
    for (let i = 0; i < count; i += 1) {
      const link = anchors.nth(i);
      const rawHref = (await link.getAttribute('href')) || '';
      const decodedHref = decode(rawHref);
      const text = clean(await link.innerText().catch(() => ''));
      if (decodedHref.toLowerCase().includes('emcd.io')) out.emcdCandidates.push({ text, rawHref, decodedHref });
      if (isTarget(decodedHref) && titleMatch(text)) { found = { link, text, rawHref, decodedHref }; break; }
    }

    if (!found) throw new Error('exact_target_anchor_not_found');
    report.rawHref = found.rawHref;
    report.decodedHref = found.decodedHref;
    report.matchedTitle = found.text;
    await found.link.scrollIntoViewIfNeeded();
    await found.link.hover({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(2500);
    await found.link.evaluate((el) => el.removeAttribute('target')).catch(() => {});
    const nav = page.waitForURL((u) => isTarget(u.toString()), { timeout: 45000, waitUntil: 'domcontentloaded' }).catch(() => null);
    await found.link.click({ timeout: 12000 });
    if (!(await nav) || !isTarget(page.url())) throw new Error('target_click_navigation_failed');
    report.clicked = true;
    report.finalUrl = page.url();
    report.referrer = await page.evaluate(() => document.referrer).catch(() => null);
  } catch (error) {
    out.error = error instanceof Error ? error.message : String(error);
  } finally {
    await browser?.close().catch(() => {});
  }
  return out;
}

for (const [name, launcher] of [['firefox', firefox], ['chromium', chromium], ['firefox', firefox]]) {
  if (report.clicked) break;
  report.attempts.push(await run(name, launcher));
}
if (!report.clicked) report.error = 'target_click_not_confirmed';
await fs.writeFile(REPORT_PATH, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
if (!report.clicked) process.exitCode = 1;
