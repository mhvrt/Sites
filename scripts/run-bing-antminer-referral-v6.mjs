import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, firefox } from 'playwright';

const QUERY = 'antminer s9';
const TARGET_HOST = 'emcd.io';
const TARGET_PATH = '/articles/mining/mining-with-antminer-s9-asic-is-it-still-profitable/';
const TARGET_URL = `https://${TARGET_HOST}${TARGET_PATH}`;
const TARGET_TITLE = 'Mining with Antminer S9 ASIC: Is It Still Profitable?';
const REPORT_PATH = process.env.REPORT_PATH || path.join(os.tmpdir(), 'bing-v6.json');
const MAX_ATTEMPTS = Math.max(1, Math.min(5, Number(process.env.BING_MAX_ATTEMPTS || 3)));
const REQUIRED_EMCD_PAGES = Math.max(4, Number(process.env.REQUIRED_EMCD_PAGES || 4));

const rnd = (a, b) => Math.floor(a + Math.random() * (b - a + 1));
const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim();
const normHost = (v) => String(v || '').toLowerCase().replace(/^www\./, '');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function decodeBing(href) {
  try {
    const u = new URL(href, 'https://www.bing.com');
    const encoded = u.searchParams.get('u') || '';
    if (!encoded.startsWith('a1')) return u.toString();
    let raw = encoded.slice(2);
    raw += '='.repeat((4 - (raw.length % 4)) % 4);
    return Buffer.from(raw, 'base64').toString('utf8');
  } catch {
    return href;
  }
}

function isTarget(value) {
  try {
    const u = new URL(value);
    return normHost(u.hostname) === TARGET_HOST && u.pathname.replace(/\/+$/, '/') === TARGET_PATH;
  } catch {
    return false;
  }
}

function isContentArticle(value) {
  try {
    const u = new URL(value);
    return normHost(u.hostname) === TARGET_HOST && /^\/articles\//.test(u.pathname) && !/\/(?:auth|login|dashboard|pool)(?:\/|$)/i.test(u.pathname);
  } catch {
    return false;
  }
}

function titleMatches(value) {
  const n = clean(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return n.includes('mining with antminer s9 asic') && n.includes('still profitable');
}

function challenged(text) {
  return /one last step|solve the challenge|verify you are human|unusual traffic/i.test(text || '');
}

async function blockAnalytics(context) {
  await context.route('**/*', async (route) => {
    try {
      const h = new URL(route.request().url()).hostname.toLowerCase();
      if (['google-analytics.com','googletagmanager.com','doubleclick.net','clarity.ms','hotjar.com','hotjar.io'].some((d) => h.endsWith(d))) {
        return route.abort('blockedbyclient');
      }
    } catch {}
    return route.continue();
  });
}

async function humanPause(page, min = 800, max = 1800) {
  await page.waitForTimeout(rnd(min, max));
  const vp = page.viewportSize() || { width: 1440, height: 900 };
  await page.mouse.move(rnd(120, vp.width - 120), rnd(100, vp.height - 100), { steps: rnd(7, 16) }).catch(() => {});
  const h = await page.evaluate(() => Math.max(document.body?.scrollHeight || 0, document.documentElement?.scrollHeight || 0)).catch(() => 0);
  if (h > vp.height + 200) {
    await page.mouse.wheel(0, rnd(180, 520)).catch(() => {});
    await page.waitForTimeout(rnd(350, 800));
  }
}

async function searchFromHomepage(page, attempt) {
  await page.goto('https://www.bing.com/?cc=US&setlang=en-US', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(rnd(1200, 2200));
  const accept = page.locator('#bnp_btn_accept, button:has-text("Accept all"), button:has-text("Accept")').first();
  if (await accept.isVisible().catch(() => false)) await accept.click({ timeout: 3000 }).catch(() => {});
  if (challenged(await page.locator('body').innerText().catch(() => ''))) {
    attempt.status = 'challenge_on_homepage';
    return false;
  }

  const input = page.locator('#sb_form_q').first();
  if (!(await input.isVisible().catch(() => false))) {
    attempt.status = 'search_input_missing';
    return false;
  }

  await humanPause(page, 600, 1200);
  await input.click();
  await input.fill('');
  await input.pressSequentially(QUERY, { delay: rnd(65, 115) });
  attempt.typedQuery = await input.inputValue().catch(() => null);
  await input.press('Escape').catch(() => {});
  await page.waitForTimeout(rnd(350, 700));

  const icon = page.locator('#search_icon').first();
  if (await icon.isVisible().catch(() => false)) {
    const box = await icon.boundingBox().catch(() => null);
    if (box) {
      const before = page.url();
      const nav = page.waitForURL((u) => u.toString() !== before && u.pathname === '/search', { timeout: 8000, waitUntil: 'domcontentloaded' }).catch(() => null);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 }).catch(() => {});
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2).catch(() => {});
      await nav;
      if (new URL(page.url()).pathname === '/search') {
        attempt.searchMode = 'physical_search_icon_click';
        return true;
      }
    }
  }

  const before = page.url();
  const nav = page.waitForURL((u) => u.toString() !== before && u.pathname === '/search', { timeout: 9000, waitUntil: 'domcontentloaded' }).catch(() => null);
  await input.evaluate((el) => {
    const form = el.form || el.closest('form');
    if (form) HTMLFormElement.prototype.submit.call(form);
  }).catch(() => {});
  await nav;
  if (new URL(page.url()).pathname === '/search') {
    attempt.searchMode = 'native_bing_form_submit';
    return true;
  }

  attempt.status = 'search_submit_failed';
  return false;
}

async function findExactTarget(page) {
  const anchors = page.locator('a[href]');
  const count = Math.min(await anchors.count(), 800);
  for (let i = 0; i < count; i += 1) {
    const link = anchors.nth(i);
    const raw = (await link.getAttribute('href')) || '';
    const decoded = decodeBing(raw);
    if (!isTarget(decoded)) continue;
    const title = clean(await link.innerText().catch(() => ''));
    if (!titleMatches(title)) continue;
    return { link, raw, decoded, title };
  }
  return null;
}

async function clickTarget(bing, found, report, attempt) {
  await humanPause(bing, 1800, 3200);
  await found.link.scrollIntoViewIfNeeded();
  await found.link.hover({ timeout: 3500 }).catch(() => {});
  await bing.waitForTimeout(rnd(1000, 2200));

  const popupPromise = bing.waitForEvent('popup', { timeout: 12000 }).catch(() => null);
  const sameTabPromise = bing.waitForURL((u) => isTarget(u.toString()), { timeout: 12000, waitUntil: 'domcontentloaded' }).catch(() => null);
  await found.link.click({ timeout: 12000 });

  let destination = null;
  const popup = await popupPromise;
  if (popup) {
    await popup.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    await popup.waitForTimeout(700).catch(() => {});
    attempt.popupOpened = true;
    attempt.popupUrl = popup.url();
    if (isTarget(popup.url())) destination = popup;
  }
  if (!destination) {
    const sameTab = await sameTabPromise;
    if (sameTab || isTarget(bing.url())) destination = bing;
  }
  if (!destination) return null;

  report.clicked = true;
  report.successfulAttempt = attempt.number;
  report.matchedTitle = found.title;
  report.matchedUrl = found.decoded;
  report.rawBingHref = found.raw;
  report.referrer = await destination.evaluate(() => document.referrer).catch(() => null);
  attempt.status = 'clicked_target';
  return destination;
}

async function collectContentLinks(page, visited) {
  const anchors = page.locator('a[href]');
  const count = Math.min(await anchors.count(), 700);
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const link = anchors.nth(i);
    if (!(await link.isVisible().catch(() => false))) continue;
    const href = (await link.getAttribute('href')) || '';
    if (!href || /^(?:#|mailto:|tel:|javascript:)/i.test(href)) continue;
    let absolute;
    try { absolute = new URL(href, page.url()).toString(); } catch { continue; }
    if (!isContentArticle(absolute) || visited.has(absolute)) continue;
    const text = clean(await link.innerText().catch(() => ''));
    if (!text || text.length < 4) continue;
    out.push({ link, absolute, text });
  }
  return out;
}

async function activateInternalLink(page, choice) {
  const before = page.url();
  await choice.link.scrollIntoViewIfNeeded().catch(() => {});
  await choice.link.hover({ timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(rnd(500, 1100));

  const popupPromise = page.waitForEvent('popup', { timeout: 5000 }).catch(() => null);
  const navPromise = page.waitForURL((u) => isContentArticle(u.toString()) && u.toString() !== before, { timeout: 15000, waitUntil: 'domcontentloaded' }).catch(() => null);
  await choice.link.click({ timeout: 12000 }).catch(() => {});

  const popup = await popupPromise;
  if (popup) {
    await popup.waitForLoadState('domcontentloaded', { timeout: 12000 }).catch(() => {});
    await popup.waitForTimeout(500).catch(() => {});
    if (isContentArticle(popup.url()) && popup.url() !== before) return popup;
    await popup.close().catch(() => {});
  }

  const nav = await navPromise;
  if (nav && isContentArticle(page.url()) && page.url() !== before) return page;
  return null;
}

async function walkEmcdContent(startPage, report) {
  let page = startPage;
  report.emcdRoute = [page.url()];
  const visited = new Set(report.emcdRoute);
  report.internalClicks = [];

  while (report.emcdRoute.length < REQUIRED_EMCD_PAGES) {
    await humanPause(page, 1400, 2600);
    const choices = await collectContentLinks(page, visited);
    if (!choices.length) break;

    // Prefer links with meaningful article titles, but keep a little variation.
    const pool = choices.slice(0, Math.min(12, choices.length));
    const choice = pool[rnd(0, pool.length - 1)];
    const next = await activateInternalLink(page, choice);
    if (!next) {
      visited.add(choice.absolute);
      report.internalClicks.push({ from: page.url(), intended: choice.absolute, text: choice.text, success: false });
      continue;
    }

    const url = next.url();
    report.internalClicks.push({ from: page.url(), intended: choice.absolute, text: choice.text, success: true, landed: url });
    if (!visited.has(url)) {
      visited.add(url);
      report.emcdRoute.push(url);
    }
    if (next !== page) await page.close().catch(() => {});
    page = next;
  }

  await humanPause(page, 1000, 1800);
  report.emcdPagesVisited = report.emcdRoute.length;
  report.finalUrl = page.url();
  report.internalWalkConfirmed = report.emcdPagesVisited >= REQUIRED_EMCD_PAGES;
  return report.internalWalkConfirmed;
}

const report = {
  synthetic: true,
  query: QUERY,
  expectedTitle: TARGET_TITLE,
  targetUrl: TARGET_URL,
  clicked: false,
  attempts: [],
  successfulAttempt: null,
  matchedTitle: null,
  matchedUrl: null,
  rawBingHref: null,
  referrer: null,
  finalUrl: null,
  emcdPagesVisited: 0,
  emcdRoute: [],
  internalClicks: [],
  internalWalkConfirmed: false,
  error: null,
};

const plan = [
  { browser: 'firefox', launcher: firefox },
  { browser: 'chromium', launcher: chromium },
  { browser: 'firefox', launcher: firefox },
  { browser: 'chromium', launcher: chromium },
  { browser: 'firefox', launcher: firefox },
].slice(0, MAX_ATTEMPTS);

for (let i = 0; i < plan.length && !report.internalWalkConfirmed; i += 1) {
  const attempt = { number: i + 1, browser: plan[i].browser, typedQuery: null, searchMode: null, popupOpened: false, popupUrl: null, status: 'started', error: null };
  report.attempts.push(attempt);
  let browser;
  try {
    browser = await plan[i].launcher.launch({ headless: true });
    const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 900 } });
    await blockAnalytics(context);
    const bing = await context.newPage();
    if (!(await searchFromHomepage(bing, attempt))) continue;
    await bing.waitForTimeout(rnd(900, 1500));
    if (challenged(await bing.locator('body').innerText().catch(() => ''))) {
      attempt.status = 'challenge_on_results';
      continue;
    }
    const found = await findExactTarget(bing);
    if (!found) {
      attempt.status = 'target_not_on_first_page';
      continue;
    }
    const destination = await clickTarget(bing, found, report, attempt);
    if (!destination) {
      attempt.status = 'target_click_failed';
      continue;
    }
    const walked = await walkEmcdContent(destination, report);
    if (!walked) attempt.status = 'clicked_but_internal_walk_short';
  } catch (error) {
    attempt.status = 'error';
    attempt.error = error instanceof Error ? error.message : String(error);
  } finally {
    await browser?.close().catch(() => {});
  }
  if (!report.internalWalkConfirmed && i < plan.length - 1) await sleep(rnd(1800, 3500));
}

if (!report.internalWalkConfirmed) report.error = report.clicked ? 'bing_click_confirmed_but_internal_walk_not_confirmed' : 'bing_click_not_confirmed';
await fs.writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
if (!report.internalWalkConfirmed) process.exitCode = 1;
