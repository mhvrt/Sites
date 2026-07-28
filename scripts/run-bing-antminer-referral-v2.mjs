import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, firefox } from 'playwright';

const QUERY = 'antminer s9';
const TARGET_PATH = '/articles/mining/mining-with-antminer-s9-asic-is-it-still-profitable/';
const TARGET_URL = `https://emcd.io${TARGET_PATH}`;
const TARGET_TITLE = 'Mining with Antminer S9 ASIC: Is It Still Profitable?';
const REPORT_PATH = process.env.REPORT_PATH || path.join(os.tmpdir(), 'bing-antminer-qa.json');
const MAX_ATTEMPTS = Math.max(1, Math.min(4, Number(process.env.BING_MAX_ATTEMPTS || 3)));
const MAX_PAGES = Math.max(1, Math.min(7, Number(process.env.BING_MAX_SERP_PAGES || 5)));
const rnd = (a, b) => Math.floor(a + Math.random() * (b - a + 1));
const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim();
const normHost = (v) => String(v || '').toLowerCase().replace(/^www\./, '');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function decodeBing(href) {
  try {
    const u = new URL(href, 'https://www.bing.com');
    const encoded = u.searchParams.get('u') || '';
    if (!encoded.startsWith('a1')) return u.toString();
    let raw = encoded.slice(2);
    raw += '='.repeat((4 - raw.length % 4) % 4);
    return Buffer.from(raw, 'base64').toString('utf8');
  } catch { return href; }
}

function targetUrl(value) {
  try {
    const u = new URL(value);
    return normHost(u.hostname) === 'emcd.io' && u.pathname.replace(/\/+$/, '/') === TARGET_PATH;
  } catch { return false; }
}

function emcdUrl(value) {
  try { return normHost(new URL(value).hostname) === 'emcd.io'; } catch { return false; }
}

function titleMatches(value) {
  const norm = (s) => clean(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const seen = norm(value);
  return seen === norm(TARGET_TITLE) || (seen.includes('mining with antminer s9 asic') && seen.includes('still profitable'));
}

function challenge(text) {
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

async function humanPause(page, min = 900, max = 2200) {
  await page.waitForTimeout(rnd(min, max));
  const vp = page.viewportSize() || { width: 1440, height: 900 };
  await page.mouse.move(rnd(120, vp.width - 120), rnd(100, vp.height - 100), { steps: rnd(8, 18) }).catch(() => {});
  const height = await page.evaluate(() => Math.max(document.body?.scrollHeight || 0, document.documentElement?.scrollHeight || 0)).catch(() => 0);
  if (height > vp.height + 250) {
    await page.mouse.wheel(0, rnd(160, 480)).catch(() => {});
    await page.waitForTimeout(rnd(500, 1200));
  }
}

async function searchFromHome(page, attempt) {
  await page.goto('https://www.bing.com/?cc=US&setlang=en-US', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(rnd(1400, 2600));
  const accept = page.locator('#bnp_btn_accept, button:has-text("Accept all"), button:has-text("Accept")').first();
  if (await accept.isVisible().catch(() => false)) await accept.click({ timeout: 3000 }).catch(() => {});

  const body = await page.locator('body').innerText().catch(() => '');
  if (challenge(body)) { attempt.status = 'challenge_on_homepage'; return false; }

  const input = page.locator('#sb_form_q').first();
  if (!(await input.isVisible().catch(() => false))) { attempt.status = 'search_input_missing'; return false; }

  await humanPause(page, 700, 1500);
  await input.click();
  await input.fill('');
  await input.pressSequentially(QUERY, { delay: rnd(65, 120) });
  attempt.typedQuery = await input.inputValue().catch(() => null);
  await input.press('Escape').catch(() => {});
  await page.waitForTimeout(rnd(500, 900));

  const isSearchUrl = () => {
    try { return new URL(page.url()).pathname === '/search'; } catch { return false; }
  };

  // Real pointer click on Bing's current search icon.
  const icon = page.locator('#search_icon').first();
  if (await icon.isVisible().catch(() => false)) {
    const box = await icon.boundingBox().catch(() => null);
    if (box) {
      const before = page.url();
      const nav = page.waitForURL((u) => u.toString() !== before && u.pathname === '/search', { timeout: 8000, waitUntil: 'domcontentloaded' }).catch(() => null);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 }).catch(() => {});
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2).catch(() => {});
      await nav;
      if (isSearchUrl()) { attempt.searchMode = 'physical_search_icon_click'; return true; }
    }
  }

  // Keyboard fallback after autosuggest is closed.
  {
    const before = page.url();
    const nav = page.waitForURL((u) => u.toString() !== before && u.pathname === '/search', { timeout: 6500, waitUntil: 'domcontentloaded' }).catch(() => null);
    await input.press('Enter').catch(() => {});
    await nav;
    if (isSearchUrl()) { attempt.searchMode = 'input_enter'; return true; }
  }

  // Final fallback: submit Bing's own live #sb_form. Ignore evaluate errors caused by navigation; trust the resulting URL.
  {
    const before = page.url();
    const nav = page.waitForURL((u) => u.toString() !== before && u.pathname === '/search', { timeout: 10000, waitUntil: 'domcontentloaded' }).catch(() => null);
    await input.evaluate((el) => {
      const form = el.form || el.closest('form');
      if (!form) throw new Error('bing_form_missing');
      HTMLFormElement.prototype.submit.call(form);
    }).catch(() => {});
    await nav;
    await page.waitForTimeout(300);
    if (isSearchUrl()) { attempt.searchMode = 'native_bing_form_submit'; return true; }
  }

  attempt.status = 'search_submit_failed';
  return false;
}

async function inspect(page, attempt, pageNo) {
  await page.waitForTimeout(rnd(1100, 2000));
  const body = await page.locator('body').innerText().catch(() => '');
  const blocked = challenge(body);
  const results = page.locator('li.b_algo h2 a[href]');
  const count = Math.min(await results.count(), 20);
  attempt.pages.push({ page: pageNo, url: page.url(), resultCount: count, challenge: blocked });
  if (blocked) return { blocked: true, count, found: null };

  for (let i = 0; i < count; i += 1) {
    const link = results.nth(i);
    const title = clean(await link.innerText().catch(() => ''));
    const raw = (await link.getAttribute('href')) || '';
    const decoded = decodeBing(raw);
    if (targetUrl(decoded) && titleMatches(title)) {
      return { blocked: false, count, found: { link, title, raw, decoded, pageNo, rankOnPage: i + 1, rank: (pageNo - 1) * 10 + i + 1 } };
    }
  }
  return { blocked: false, count, found: null };
}

async function nextPage(page, pageNo) {
  await humanPause(page, 700, 1500);
  const current = new URL(page.url());
  const currentFirst = Number(current.searchParams.get('first') || ((pageNo - 1) * 10 + 1));
  const anchors = page.locator('a[href]');
  const count = Math.min(await anchors.count(), 350);
  const choices = [];

  for (let i = 0; i < count; i += 1) {
    const a = anchors.nth(i);
    if (!(await a.isVisible().catch(() => false))) continue;
    try {
      const u = new URL((await a.getAttribute('href')) || '', page.url());
      const first = Number(u.searchParams.get('first') || 0);
      if (normHost(u.hostname) === 'bing.com' && u.pathname === '/search' && first > currentFirst) choices.push({ i, first });
    } catch {}
  }
  if (!choices.length) return false;
  choices.sort((a, b) => a.first - b.first);
  const link = anchors.nth(choices[0].i);
  await link.scrollIntoViewIfNeeded().catch(() => {});
  await link.hover({ timeout: 3000 }).catch(() => {});
  const before = page.url();
  const nav = page.waitForURL((u) => u.toString() !== before, { timeout: 30000, waitUntil: 'domcontentloaded' }).catch(() => null);
  await link.click({ timeout: 10000 }).catch(() => {});
  return Boolean(await nav);
}

async function clickResult(page, found, report, attempt) {
  await humanPause(page, 2500, 4500);
  await found.link.scrollIntoViewIfNeeded();
  await found.link.hover({ timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(rnd(1700, 3800));
  await found.link.evaluate((el) => el.removeAttribute('target')).catch(() => {});
  const nav = page.waitForURL((u) => targetUrl(u.toString()), { timeout: 45000, waitUntil: 'domcontentloaded' }).catch(() => null);
  await found.link.click({ timeout: 15000 });
  if (!(await nav) || !targetUrl(page.url())) return false;

  report.clicked = true;
  report.successfulAttempt = attempt.number;
  report.matchedTitle = found.title;
  report.matchedUrl = found.decoded;
  report.rawBingHref = found.raw;
  report.serpPage = found.pageNo;
  report.rankOnPage = found.rankOnPage;
  report.rank = found.rank;
  report.referrer = await page.evaluate(() => document.referrer).catch(() => null);
  attempt.status = 'clicked_target';
  return true;
}

async function walkEmcd(page, report) {
  report.emcdRoute = [page.url()];
  const visited = new Set(report.emcdRoute);
  const extra = rnd(3, 5);
  for (let step = 0; step < extra; step += 1) {
    await humanPause(page, 1700, 3300);
    const anchors = page.locator('a[href]');
    const count = Math.min(await anchors.count(), 500);
    const choices = [];
    for (let i = 0; i < count; i += 1) {
      const a = anchors.nth(i);
      if (!(await a.isVisible().catch(() => false))) continue;
      const href = (await a.getAttribute('href')) || '';
      if (!href || /^(#|mailto:|tel:|javascript:)/i.test(href)) continue;
      let url;
      try { url = new URL(href, page.url()).toString(); } catch { continue; }
      if (!emcdUrl(url) || visited.has(url) || /\.(pdf|zip|docx?|xlsx?|pptx?)([?#]|$)/i.test(url)) continue;
      if (!clean(await a.innerText().catch(() => ''))) continue;
      choices.push({ i, url });
    }
    if (!choices.length) break;
    const choice = choices[rnd(0, choices.length - 1)];
    const link = anchors.nth(choice.i);
    const before = page.url();
    await link.scrollIntoViewIfNeeded().catch(() => {});
    await link.evaluate((el) => el.removeAttribute('target')).catch(() => {});
    const nav = page.waitForURL((u) => emcdUrl(u.toString()) && u.toString() !== before, { timeout: 25000, waitUntil: 'domcontentloaded' }).catch(() => null);
    await link.click({ timeout: 12000 }).catch(() => {});
    if (!(await nav)) continue;
    if (page.url() !== before && emcdUrl(page.url())) {
      visited.add(page.url());
      report.emcdRoute.push(page.url());
    }
  }
  await humanPause(page, 1600, 3000);
  report.emcdPagesVisited = report.emcdRoute.length;
  report.finalUrl = page.url();
}

const report = { synthetic: true, query: QUERY, expectedTitle: TARGET_TITLE, targetUrl: TARGET_URL, clicked: false, attempts: [], successfulAttempt: null, matchedTitle: null, matchedUrl: null, rawBingHref: null, serpPage: null, rankOnPage: null, rank: null, referrer: null, finalUrl: null, emcdPagesVisited: 0, emcdRoute: [], error: null };
const plan = [{ browser: 'chromium', launcher: chromium }, { browser: 'firefox', launcher: firefox }, { browser: 'chromium', launcher: chromium }, { browser: 'firefox', launcher: firefox }].slice(0, MAX_ATTEMPTS);

for (let n = 0; n < plan.length && !report.clicked; n += 1) {
  const attempt = { number: n + 1, browser: plan[n].browser, typedQuery: null, searchMode: null, pages: [], status: 'started', error: null };
  report.attempts.push(attempt);
  let browser;
  try {
    browser = await plan[n].launcher.launch({ headless: true });
    const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 900 } });
    await blockAnalytics(context);
    const page = await context.newPage();
    if (!(await searchFromHome(page, attempt))) continue;

    let found = null;
    for (let pageNo = 1; pageNo <= MAX_PAGES && !found; pageNo += 1) {
      const state = await inspect(page, attempt, pageNo);
      if (state.blocked) { attempt.status = `challenge_on_page_${pageNo}`; break; }
      if (state.found) { found = state.found; break; }
      if (!state.count) { attempt.status = `no_results_on_page_${pageNo}`; break; }
      if (pageNo < MAX_PAGES && !(await nextPage(page, pageNo))) { attempt.status = `next_failed_on_page_${pageNo}`; break; }
    }

    if (!found) { if (attempt.status === 'started') attempt.status = 'target_not_found'; continue; }
    if (await clickResult(page, found, report, attempt)) await walkEmcd(page, report);
    else attempt.status = 'target_click_failed';
  } catch (error) {
    attempt.status = 'error';
    attempt.error = error instanceof Error ? error.message : String(error);
  } finally {
    await browser?.close().catch(() => {});
  }
  if (!report.clicked && n < plan.length - 1) await delay(rnd(2500, 5000));
}

if (!report.clicked) report.error = 'all_clean_bing_attempts_failed';
await fs.writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
if (!report.clicked) process.exitCode = 1;
