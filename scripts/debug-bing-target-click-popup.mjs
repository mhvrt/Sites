import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { firefox, chromium } from 'playwright';

const REPORT_PATH = process.env.REPORT_PATH || path.join(os.tmpdir(), 'bing-target-click-popup.json');
const QUERY = 'antminer s9';
const TARGET_PATH = '/articles/mining/mining-with-antminer-s9-asic-is-it-still-profitable/';
const TITLE = 'Mining with Antminer S9 ASIC: Is It Still Profitable?';
const report = { query: QUERY, clicked: false, attempts: [], finalUrl: null, referrer: null, rawHref: null, decodedHref: null, matchedTitle: null, error: null };
const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim();
const host = (v) => String(v || '').toLowerCase().replace(/^www\./, '');
function decode(href) { try { const u = new URL(href, 'https://www.bing.com'); const e = u.searchParams.get('u') || ''; if (!e.startsWith('a1')) return u.toString(); let raw = e.slice(2); raw += '='.repeat((4 - raw.length % 4) % 4); return Buffer.from(raw, 'base64').toString('utf8'); } catch { return href; } }
function target(v) { try { const u = new URL(v); return host(u.hostname) === 'emcd.io' && u.pathname.replace(/\/+$/, '/') === TARGET_PATH; } catch { return false; } }
function titleMatch(v) { const n = (s) => clean(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); return n(v) === n(TITLE); }

async function submitSearch(page) {
  const input = page.locator('#sb_form_q').first();
  if (!(await input.isVisible().catch(() => false))) return false;
  await input.fill(QUERY);
  await input.press('Escape').catch(() => {});
  await page.waitForTimeout(300);
  const icon = page.locator('#search_icon').first();
  const box = await icon.boundingBox().catch(() => null);
  if (box) {
    const before = page.url();
    const nav = page.waitForURL((u) => u.toString() !== before && u.pathname === '/search', { timeout: 7000, waitUntil: 'domcontentloaded' }).catch(() => null);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2).catch(() => {});
    await nav;
  }
  if (new URL(page.url()).pathname === '/search') return true;
  const before = page.url();
  const nav = page.waitForURL((u) => u.toString() !== before && u.pathname === '/search', { timeout: 8000, waitUntil: 'domcontentloaded' }).catch(() => null);
  await input.evaluate((el) => { const f = el.form || el.closest('form'); if (f) HTMLFormElement.prototype.submit.call(f); }).catch(() => {});
  await nav;
  return new URL(page.url()).pathname === '/search';
}

async function run(browserName, launcher) {
  const out = { browser: browserName, searched: false, resultCount: 0, anchorCount: 0, emcdCandidates: [], clickedCurrentTab: false, popupOpened: false, currentTabUrlAfterClick: null, popupUrlAfterClick: null, error: null };
  let browser;
  try {
    browser = await launcher.launch({ headless: true });
    const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await page.goto('https://www.bing.com/?cc=US&setlang=en-US', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(1000);
    if (!(await submitSearch(page))) throw new Error('search_submit_failed');
    out.searched = true;
    await page.waitForTimeout(1500);
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
      if (decodedHref.toLowerCase().includes('emcd.io')) out.emcdCandidates.push({ text, rawHref, decodedHref, target: await link.getAttribute('target') });
      if (target(decodedHref) && titleMatch(text)) { found = { link, text, rawHref, decodedHref, targetAttr: await link.getAttribute('target'), outerHTML: await link.evaluate((el) => el.outerHTML.slice(0, 3000)).catch(() => null) }; break; }
    }
    if (!found) throw new Error('exact_target_anchor_not_found');

    report.rawHref = found.rawHref;
    report.decodedHref = found.decodedHref;
    report.matchedTitle = found.text;
    out.targetAttr = found.targetAttr;
    out.targetOuterHTML = found.outerHTML;
    await found.link.scrollIntoViewIfNeeded();
    await found.link.hover({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(1800);

    const popupPromise = page.waitForEvent('popup', { timeout: 12000 }).catch(() => null);
    const targetNavPromise = page.waitForURL((u) => target(u.toString()), { timeout: 15000, waitUntil: 'domcontentloaded' }).catch(() => null);
    await found.link.click({ timeout: 12000 });
    const [popup, currentNav] = await Promise.all([popupPromise, targetNavPromise]);
    if (popup) {
      out.popupOpened = true;
      await popup.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
      await popup.waitForTimeout(1000).catch(() => {});
      out.popupUrlAfterClick = popup.url();
      if (target(popup.url())) {
        report.clicked = true;
        report.finalUrl = popup.url();
        report.referrer = await popup.evaluate(() => document.referrer).catch(() => null);
      }
    }
    out.currentTabUrlAfterClick = page.url();
    if (!report.clicked && (currentNav || target(page.url()))) {
      out.clickedCurrentTab = true;
      report.clicked = true;
      report.finalUrl = page.url();
      report.referrer = await page.evaluate(() => document.referrer).catch(() => null);
    }
    if (!report.clicked) throw new Error('target_click_navigation_failed');
  } catch (error) {
    out.error = error instanceof Error ? error.message : String(error);
  } finally { await browser?.close().catch(() => {}); }
  return out;
}

for (const [name, launcher] of [['firefox', firefox], ['firefox', firefox], ['chromium', chromium]]) {
  if (report.clicked) break;
  report.attempts.push(await run(name, launcher));
}
if (!report.clicked) report.error = 'target_click_not_confirmed';
await fs.writeFile(REPORT_PATH, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
if (!report.clicked) process.exitCode = 1;
