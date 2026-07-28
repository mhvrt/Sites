import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { firefox } from 'playwright';

const QUERY = 'antminer s9';
const TARGET_HOST = 'emcd.io';
const TARGET_PATH = '/articles/mining/mining-with-antminer-s9-asic-is-it-still-profitable/';
const TARGET_URL = `https://${TARGET_HOST}${TARGET_PATH}`;
const TARGET_TITLE = 'Mining with Antminer S9 ASIC: Is It Still Profitable?';
const REPORT_PATH = process.env.REPORT_PATH || path.join(os.tmpdir(), 'bing-v7.json');
const MAX_ATTEMPTS = Math.max(1, Math.min(7, Number(process.env.BING_MAX_ATTEMPTS || 5)));
const REQUIRED_EMCD_PAGES = Math.max(4, Number(process.env.REQUIRED_EMCD_PAGES || 4));

const rnd = (a, b) => Math.floor(a + Math.random() * (b - a + 1));
const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim();
const host = (v) => String(v || '').toLowerCase().replace(/^www\./, '');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function decodeBing(href) {
  try {
    const u = new URL(href, 'https://www.bing.com');
    const encoded = u.searchParams.get('u') || '';
    if (!encoded.startsWith('a1')) return u.toString();
    let raw = encoded.slice(2);
    raw += '='.repeat((4 - (raw.length % 4)) % 4);
    return Buffer.from(raw, 'base64').toString('utf8');
  } catch { return href; }
}

function isTarget(value) {
  try {
    const u = new URL(value);
    return host(u.hostname) === TARGET_HOST && u.pathname.replace(/\/+$/, '/') === TARGET_PATH;
  } catch { return false; }
}

function isArticle(value) {
  try {
    const u = new URL(value);
    return host(u.hostname) === TARGET_HOST && u.pathname.startsWith('/articles/') && !/\/(?:auth|login|dashboard|pool)(?:\/|$)/i.test(u.pathname);
  } catch { return false; }
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
      if (['google-analytics.com','googletagmanager.com','doubleclick.net','clarity.ms','hotjar.com','hotjar.io'].some((d) => h.endsWith(d))) return route.abort('blockedbyclient');
    } catch {}
    return route.continue();
  });
}

async function pause(page, min = 700, max = 1600) {
  await page.waitForTimeout(rnd(min, max));
  const vp = page.viewportSize() || { width: 1440, height: 900 };
  await page.mouse.move(rnd(120, vp.width - 120), rnd(100, vp.height - 100), { steps: rnd(7, 15) }).catch(() => {});
  if (Math.random() < 0.8) await page.mouse.wheel(0, rnd(120, 480)).catch(() => {});
}

async function searchBing(page, attempt) {
  await page.goto('https://www.bing.com/?cc=US&setlang=en-US', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(rnd(1200, 2200));
  const accept = page.locator('#bnp_btn_accept, button:has-text("Accept all"), button:has-text("Accept")').first();
  if (await accept.isVisible().catch(() => false)) await accept.click({ timeout: 3000 }).catch(() => {});
  if (challenged(await page.locator('body').innerText().catch(() => ''))) { attempt.status = 'challenge_on_homepage'; return false; }

  const input = page.locator('#sb_form_q').first();
  if (!(await input.isVisible().catch(() => false))) { attempt.status = 'search_input_missing'; return false; }
  await pause(page, 500, 1100);
  await input.click();
  await input.fill('');
  await input.pressSequentially(QUERY, { delay: rnd(65, 115) });
  attempt.typedQuery = await input.inputValue().catch(() => null);
  await input.press('Escape').catch(() => {});
  await page.waitForTimeout(rnd(350, 650));

  const icon = page.locator('#search_icon').first();
  if (await icon.isVisible().catch(() => false)) {
    const box = await icon.boundingBox().catch(() => null);
    if (box) {
      const before = page.url();
      const nav = page.waitForURL((u) => u.toString() !== before && u.pathname === '/search', { timeout: 8000, waitUntil: 'domcontentloaded' }).catch(() => null);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 }).catch(() => {});
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2).catch(() => {});
      await nav;
      if (new URL(page.url()).pathname === '/search') { attempt.searchMode = 'physical_search_icon_click'; return true; }
    }
  }

  const before = page.url();
  const nav = page.waitForURL((u) => u.toString() !== before && u.pathname === '/search', { timeout: 9000, waitUntil: 'domcontentloaded' }).catch(() => null);
  await input.evaluate((el) => {
    const form = el.form || el.closest('form');
    if (form) HTMLFormElement.prototype.submit.call(form);
  }).catch(() => {});
  await nav;
  if (new URL(page.url()).pathname === '/search') { attempt.searchMode = 'native_bing_form_submit'; return true; }
  attempt.status = 'search_submit_failed';
  return false;
}

async function findTargetDescriptor(page) {
  const anchors = page.locator('a[href]');
  const count = Math.min(await anchors.count(), 800);
  for (let i = 0; i < count; i += 1) {
    const link = anchors.nth(i);
    if (!(await link.isVisible().catch(() => false))) continue;
    const raw = (await link.getAttribute('href')) || '';
    const decoded = decodeBing(raw);
    if (!isTarget(decoded)) continue;
    const title = clean(await link.innerText().catch(() => ''));
    if (!titleMatches(title)) continue;
    return { raw, decoded, title };
  }
  return null;
}

async function refindTarget(page, descriptor) {
  const anchors = page.locator('a[href]');
  const count = Math.min(await anchors.count(), 800);
  for (let i = 0; i < count; i += 1) {
    const link = anchors.nth(i);
    if (!(await link.isVisible().catch(() => false))) continue;
    const raw = (await link.getAttribute('href')) || '';
    if (raw !== descriptor.raw) continue;
    const decoded = decodeBing(raw);
    const title = clean(await link.innerText().catch(() => ''));
    if (isTarget(decoded) && titleMatches(title)) return link;
  }
  return null;
}

async function clickTarget(bing, descriptor, report, attempt) {
  const link = await refindTarget(bing, descriptor);
  if (!link) return null;
  await link.scrollIntoViewIfNeeded();
  await link.hover({ timeout: 3000 }).catch(() => {});
  await bing.waitForTimeout(rnd(900, 1800));

  const popupPromise = bing.waitForEvent('popup', { timeout: 12000 }).catch(() => null);
  const samePromise = bing.waitForURL((u) => isTarget(u.toString()), { timeout: 12000, waitUntil: 'domcontentloaded' }).catch(() => null);
  await link.click({ timeout: 12000 });

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
    const same = await samePromise;
    if (same || isTarget(bing.url())) destination = bing;
  }
  if (!destination) return null;

  report.clicked = true;
  report.successfulAttempt = attempt.number;
  report.matchedTitle = descriptor.title;
  report.matchedUrl = descriptor.decoded;
  report.rawBingHref = descriptor.raw;
  report.referrer = await destination.evaluate(() => document.referrer).catch(() => null);
  attempt.status = 'clicked_target';
  return destination;
}

async function contentDescriptors(page, visited) {
  const anchors = page.locator('a[href]');
  const count = Math.min(await anchors.count(), 800);
  const seen = new Set();
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const link = anchors.nth(i);
    if (!(await link.isVisible().catch(() => false))) continue;
    const href = (await link.getAttribute('href')) || '';
    if (!href || /^(?:#|mailto:|tel:|javascript:)/i.test(href)) continue;
    let absolute;
    try { absolute = new URL(href, page.url()).toString(); } catch { continue; }
    if (!isArticle(absolute) || visited.has(absolute) || seen.has(absolute)) continue;
    const text = clean(await link.innerText().catch(() => ''));
    if (text.length < 4) continue;
    seen.add(absolute);
    out.push({ absolute, text });
  }
  return out;
}

async function refindArticleLink(page, descriptor) {
  const anchors = page.locator('a[href]');
  const count = Math.min(await anchors.count(), 800);
  for (let i = 0; i < count; i += 1) {
    const link = anchors.nth(i);
    if (!(await link.isVisible().catch(() => false))) continue;
    const href = (await link.getAttribute('href')) || '';
    let absolute;
    try { absolute = new URL(href, page.url()).toString(); } catch { continue; }
    if (absolute === descriptor.absolute) return link;
  }
  return null;
}

async function clickArticle(page, descriptor) {
  const link = await refindArticleLink(page, descriptor);
  if (!link) return null;
  const before = page.url();
  await link.scrollIntoViewIfNeeded().catch(() => {});
  await link.hover({ timeout: 2500 }).catch(() => {});
  await page.waitForTimeout(rnd(450, 900));

  const popupPromise = page.waitForEvent('popup', { timeout: 5000 }).catch(() => null);
  const navPromise = page.waitForURL((u) => isArticle(u.toString()) && u.toString() !== before, { timeout: 15000, waitUntil: 'domcontentloaded' }).catch(() => null);
  await link.click({ timeout: 10000 }).catch(() => {});

  const popup = await popupPromise;
  if (popup) {
    await popup.waitForLoadState('domcontentloaded', { timeout: 12000 }).catch(() => {});
    await popup.waitForTimeout(500).catch(() => {});
    if (isArticle(popup.url()) && popup.url() !== before) return popup;
    await popup.close().catch(() => {});
  }
  const nav = await navPromise;
  if (nav && isArticle(page.url()) && page.url() !== before) return page;
  return null;
}

async function walkArticles(startPage, report) {
  let page = startPage;
  report.emcdRoute = [page.url()];
  report.internalClicks = [];
  const visited = new Set(report.emcdRoute);

  while (report.emcdRoute.length < REQUIRED_EMCD_PAGES) {
    await pause(page, 1100, 2200);
    const options = await contentDescriptors(page, visited);
    if (!options.length) break;
    let moved = false;

    for (const descriptor of options.slice(0, Math.min(10, options.length))) {
      const from = page.url();
      const next = await clickArticle(page, descriptor);
      if (!next) {
        report.internalClicks.push({ from, intended: descriptor.absolute, text: descriptor.text, success: false });
        visited.add(descriptor.absolute);
        continue;
      }
      const landed = next.url();
      report.internalClicks.push({ from, intended: descriptor.absolute, text: descriptor.text, success: true, landed });
      if (!visited.has(landed)) {
        visited.add(landed);
        report.emcdRoute.push(landed);
      }
      if (next !== page) await page.close().catch(() => {});
      page = next;
      moved = true;
      break;
    }
    if (!moved) break;
  }

  await pause(page, 900, 1500);
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

for (let i = 0; i < MAX_ATTEMPTS && !report.internalWalkConfirmed; i += 1) {
  const attempt = { number: i + 1, browser: 'firefox', typedQuery: null, searchMode: null, popupOpened: false, popupUrl: null, status: 'started', error: null };
  report.attempts.push(attempt);
  let browser;
  try {
    browser = await firefox.launch({ headless: true });
    const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 900 } });
    await blockAnalytics(context);
    const bing = await context.newPage();
    if (!(await searchBing(bing, attempt))) continue;
    await bing.waitForTimeout(rnd(900, 1400));
    if (challenged(await bing.locator('body').innerText().catch(() => ''))) { attempt.status = 'challenge_on_results'; continue; }
    const descriptor = await findTargetDescriptor(bing);
    if (!descriptor) { attempt.status = 'target_not_on_first_page'; continue; }
    const destination = await clickTarget(bing, descriptor, report, attempt);
    if (!destination) { attempt.status = 'target_click_failed'; continue; }
    if (!(await walkArticles(destination, report))) attempt.status = 'clicked_but_internal_walk_short';
  } catch (error) {
    attempt.status = 'error';
    attempt.error = error instanceof Error ? error.message : String(error);
  } finally {
    await browser?.close().catch(() => {});
  }
  if (!report.internalWalkConfirmed && i < MAX_ATTEMPTS - 1) await sleep(rnd(1600, 3000));
}

if (!report.internalWalkConfirmed) report.error = report.clicked ? 'bing_click_confirmed_but_internal_walk_not_confirmed' : 'bing_click_not_confirmed';
await fs.writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
if (!report.internalWalkConfirmed) process.exitCode = 1;
