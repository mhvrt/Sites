import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, firefox } from 'playwright';

const QUERY = 'antminer s9';
const TARGET_HOST = 'emcd.io';
const TARGET_PATH = '/articles/mining/mining-with-antminer-s9-asic-is-it-still-profitable/';
const TARGET_URL = `https://${TARGET_HOST}${TARGET_PATH}`;
const EXPECTED_TITLE = 'Mining with Antminer S9 ASIC: Is It Still Profitable?';
const REPORT_PATH = process.env.REPORT_PATH || path.join(os.tmpdir(), 'bing-antminer-qa.json');
const MAX_ATTEMPTS = Math.max(1, Math.min(4, Number(process.env.BING_MAX_ATTEMPTS || 3)));
const MAX_SERP_PAGES = Math.max(1, Math.min(7, Number(process.env.BING_MAX_SERP_PAGES || 5)));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const rnd = (min, max) => Math.floor(min + Math.random() * (max - min + 1));
const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
const host = (value) => String(value || '').toLowerCase().replace(/^www\./, '');

function normalizedTitle(value) {
  return clean(value).toLowerCase().replace(/[“”]/g, '"').replace(/[’]/g, "'").replace(/[^a-z0-9]+/g, ' ').trim();
}

function titleMatches(value) {
  const seen = normalizedTitle(value);
  const expected = normalizedTitle(EXPECTED_TITLE);
  return seen === expected || (seen.includes('mining with antminer s9 asic') && seen.includes('still profitable'));
}

function decodeBingHref(href) {
  try {
    const url = new URL(href, 'https://www.bing.com');
    const encoded = url.searchParams.get('u') || '';
    if (!encoded.startsWith('a1')) return url.toString();
    let raw = encoded.slice(2);
    raw += '='.repeat((4 - (raw.length % 4)) % 4);
    return Buffer.from(raw, 'base64').toString('utf8');
  } catch {
    return href;
  }
}

function isTarget(value) {
  try {
    const url = new URL(value);
    return host(url.hostname) === TARGET_HOST && url.pathname.replace(/\/+$/, '/') === TARGET_PATH;
  } catch {
    return false;
  }
}

function isEmcd(value) {
  try {
    const url = new URL(value);
    return host(url.hostname) === TARGET_HOST && /^https?:$/.test(url.protocol);
  } catch {
    return false;
  }
}

function isChallenge(text) {
  return /one last step|solve the challenge|verify you are human|unusual traffic/i.test(text || '');
}

async function blockAnalytics(context) {
  await context.route('**/*', async (route) => {
    try {
      const requestHost = new URL(route.request().url()).hostname.toLowerCase();
      if (
        requestHost.endsWith('google-analytics.com') ||
        requestHost.endsWith('googletagmanager.com') ||
        requestHost.endsWith('doubleclick.net') ||
        requestHost.endsWith('clarity.ms') ||
        requestHost.endsWith('hotjar.com') ||
        requestHost.endsWith('hotjar.io')
      ) return route.abort('blockedbyclient');
    } catch {}
    return route.continue();
  });
}

async function mouseAndScroll(page, minWait = 900, maxWait = 2200) {
  await page.waitForTimeout(rnd(minWait, maxWait));
  const viewport = page.viewportSize() || { width: 1440, height: 900 };
  await page.mouse.move(rnd(120, viewport.width - 120), rnd(100, viewport.height - 100), { steps: rnd(8, 20) }).catch(() => undefined);
  const height = await page.evaluate(() => Math.max(document.body?.scrollHeight || 0, document.documentElement?.scrollHeight || 0)).catch(() => 0);
  if (height > viewport.height + 250) {
    await page.mouse.wheel(0, rnd(180, 520)).catch(() => undefined);
    await page.waitForTimeout(rnd(500, 1300));
    if (Math.random() < 0.25) await page.mouse.wheel(0, -rnd(80, 180)).catch(() => undefined);
  }
}

async function acceptCookies(page) {
  for (const selector of ['#bnp_btn_accept', 'button:has-text("Accept all")', 'button:has-text("Accept")', 'button:has-text("I agree")']) {
    const button = page.locator(selector).first();
    if (await button.isVisible().catch(() => false)) {
      await button.click({ timeout: 3500 }).catch(() => undefined);
      await page.waitForTimeout(rnd(400, 900));
      break;
    }
  }
}

async function waitForSearch(page, before, timeout = 10000) {
  return page.waitForURL((url) => url.toString() !== before && url.pathname === '/search', {
    timeout,
    waitUntil: 'domcontentloaded',
  }).catch(() => null);
}

async function startSearch(page, attempt) {
  await page.goto('https://www.bing.com/?cc=US&setlang=en-US', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(rnd(1400, 2800));
  await acceptCookies(page);

  const body = await page.locator('body').innerText().catch(() => '');
  if (isChallenge(body)) {
    attempt.status = 'challenge_on_homepage';
    return false;
  }

  const input = page.locator('#sb_form_q').first();
  if (!(await input.isVisible().catch(() => false))) {
    attempt.status = 'search_input_missing';
    return false;
  }

  await mouseAndScroll(page, 800, 1600);
  await input.click({ timeout: 5000 });
  await input.fill('');
  await input.pressSequentially(QUERY, { delay: rnd(65, 125) });
  attempt.typedQuery = await input.inputValue().catch(() => null);
  await page.waitForTimeout(rnd(700, 1300));
  await input.press('Escape').catch(() => undefined);
  await page.waitForTimeout(rnd(250, 600));

  // First choice: a real pointer click on Bing's current visible search-icon label.
  const icon = page.locator('#search_icon').first();
  if (await icon.isVisible().catch(() => false)) {
    const box = await icon.boundingBox().catch(() => null);
    if (box) {
      const before = page.url();
      const nav = waitForSearch(page, before, 9000);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: rnd(5, 12) }).catch(() => undefined);
      await page.waitForTimeout(rnd(250, 650));
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2).catch(() => undefined);
      if (await nav) {
        attempt.searchMode = 'physical_search_icon_click';
        return true;
      }
    }
  }

  // Second choice: Enter after closing Bing's autosuggest popup.
  {
    const before = page.url();
    const nav = waitForSearch(page, before, 7000);
    await input.press('Enter').catch(() => undefined);
    if (await nav) {
      attempt.searchMode = 'input_enter';
      return true;
    }
  }

  // Last fallback: submit Bing's own live form, preserving its q and hidden form fields.
  {
    const before = page.url();
    const nav = waitForSearch(page, before, 10000);
    const submitted = await input.evaluate((el) => {
      const form = el.form || el.closest('form');
      if (!form) return false;
      HTMLFormElement.prototype.submit.call(form);
      return true;
    }).catch(() => false);
    if (submitted && await nav) {
      attempt.searchMode = 'native_bing_form_submit';
      return true;
    }
  }

  attempt.status = 'search_submit_failed';
  return false;
}

async function inspectResults(page, attempt, pageNo) {
  await page.waitForTimeout(rnd(1200, 2200));
  const body = await page.locator('body').innerText().catch(() => '');
  const challenge = isChallenge(body);
  const links = page.locator('li.b_algo h2 a[href]');
  const count = Math.min(await links.count(), 20);
  attempt.pages.push({ page: pageNo, url: page.url(), resultCount: count, challenge });
  if (challenge) return { challenge: true, found: null, count };

  for (let index = 0; index < count; index += 1) {
    const link = links.nth(index);
    const title = clean(await link.innerText().catch(() => ''));
    const rawHref = (await link.getAttribute('href')) || '';
    const decoded = decodeBingHref(rawHref);
    if (isTarget(decoded) && titleMatches(title)) {
      return {
        challenge: false,
        count,
        found: { link, title, rawHref, decoded, pageNo, rankOnPage: index + 1, rank: (pageNo - 1) * 10 + index + 1 },
      };
    }
  }
  return { challenge: false, found: null, count };
}

async function clickNext(page, pageNo) {
  await mouseAndScroll(page, 700, 1500);
  const current = new URL(page.url());
  const currentFirst = Number(current.searchParams.get('first') || ((pageNo - 1) * 10 + 1));
  const anchors = page.locator('a[href]');
  const count = Math.min(await anchors.count(), 350);
  const candidates = [];

  for (let index = 0; index < count; index += 1) {
    const link = anchors.nth(index);
    if (!(await link.isVisible().catch(() => false))) continue;
    const href = (await link.getAttribute('href')) || '';
    try {
      const url = new URL(href, page.url());
      if (host(url.hostname) !== 'bing.com' || url.pathname !== '/search') continue;
      const first = Number(url.searchParams.get('first') || 0);
      if (Number.isFinite(first) && first > currentFirst) candidates.push({ index, first });
    } catch {}
  }

  if (!candidates.length) return false;
  candidates.sort((a, b) => a.first - b.first);
  const next = anchors.nth(candidates[0].index);
  await next.scrollIntoViewIfNeeded().catch(() => undefined);
  await next.hover({ timeout: 3500 }).catch(() => undefined);
  await page.waitForTimeout(rnd(500, 1100));

  const before = page.url();
  const nav = page.waitForURL((url) => url.toString() !== before, { timeout: 30000, waitUntil: 'domcontentloaded' }).catch(() => null);
  await next.click({ timeout: 10000 }).catch(() => undefined);
  return Boolean(await nav);
}

async function clickTarget(page, found, report, attempt) {
  await mouseAndScroll(page, 2200, 4200);
  await found.link.scrollIntoViewIfNeeded();
  await found.link.hover({ timeout: 5000 }).catch(() => undefined);
  await page.waitForTimeout(rnd(1800, 4200));
  await found.link.evaluate((el) => el.removeAttribute('target')).catch(() => undefined);

  const nav = page.waitForURL((url) => isTarget(url.toString()), { timeout: 45000, waitUntil: 'domcontentloaded' }).catch(() => null);
  await found.link.click({ timeout: 15000 });
  if (!(await nav) || !isTarget(page.url())) {
    attempt.status = 'target_click_failed';
    return false;
  }

  report.clicked = true;
  report.successfulAttempt = attempt.number;
  report.matchedTitle = found.title;
  report.matchedUrl = found.decoded;
  report.rawBingHref = found.rawHref;
  report.serpPage = found.pageNo;
  report.rankOnPage = found.rankOnPage;
  report.rank = found.rank;
  report.referrer = await page.evaluate(() => document.referrer).catch(() => null);
  attempt.status = 'clicked_target';
  return true;
}

async function browseEmcd(page, report) {
  const extra = rnd(3, 5);
  const visited = new Set([page.url()]);
  report.emcdRoute = [page.url()];

  for (let step = 0; step < extra; step += 1) {
    await mouseAndScroll(page, 1800, 3600);
    const anchors = page.locator('a[href]');
    const count = Math.min(await anchors.count(), 500);
    const options = [];

    for (let index = 0; index < count; index += 1) {
      const link = anchors.nth(index);
      if (!(await link.isVisible().catch(() => false))) continue;
      const href = (await link.getAttribute('href')) || '';
      if (!href || /^(?:#|mailto:|tel:|javascript:)/i.test(href)) continue;
      let absolute;
      try { absolute = new URL(href, page.url()).toString(); } catch { continue; }
      if (!isEmcd(absolute) || visited.has(absolute) || /\.(?:pdf|zip|docx?|xlsx?|pptx?)(?:$|[?#])/i.test(absolute)) continue;
      if (!clean(await link.innerText().catch(() => ''))) continue;
      options.push({ index, url: absolute });
    }

    if (!options.length) break;
    const choice = options[rnd(0, options.length - 1)];
    const link = anchors.nth(choice.index);
    const before = page.url();
    await link.scrollIntoViewIfNeeded().catch(() => undefined);
    await link.hover({ timeout: 3000 }).catch(() => undefined);
    await page.waitForTimeout(rnd(500, 1200));
    await link.evaluate((el) => el.removeAttribute('target')).catch(() => undefined);

    const nav = page.waitForURL((url) => isEmcd(url.toString()) && url.toString() !== before, { timeout: 25000, waitUntil: 'domcontentloaded' }).catch(() => null);
    await link.click({ timeout: 12000 }).catch(() => undefined);
    if (!(await nav)) continue;
    const current = page.url();
    if (current !== before && isEmcd(current)) {
      visited.add(current);
      report.emcdRoute.push(current);
    }
  }

  await mouseAndScroll(page, 1800, 3200);
  report.emcdPagesVisited = report.emcdRoute.length;
  report.finalUrl = page.url();
}

const report = {
  synthetic: true,
  query: QUERY,
  expectedTitle: EXPECTED_TITLE,
  targetUrl: TARGET_URL,
  clicked: false,
  attempts: [],
  successfulAttempt: null,
  matchedTitle: null,
  matchedUrl: null,
  rawBingHref: null,
  serpPage: null,
  rankOnPage: null,
  rank: null,
  referrer: null,
  finalUrl: null,
  emcdPagesVisited: 0,
  emcdRoute: [],
  error: null,
};

const plan = [
  { browser: 'chromium', launcher: chromium },
  { browser: 'firefox', launcher: firefox },
  { browser: 'chromium', launcher: chromium },
  { browser: 'firefox', launcher: firefox },
].slice(0, MAX_ATTEMPTS);

for (let i = 0; i < plan.length && !report.clicked; i += 1) {
  const attempt = { number: i + 1, browser: plan[i].browser, typedQuery: null, searchMode: null, pages: [], status: 'started', error: null };
  report.attempts.push(attempt);
  let browser;

  try {
    browser = await plan[i].launcher.launch({ headless: true });
    const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 900 } });
    await blockAnalytics(context);
    const page = await context.newPage();

    if (!(await startSearch(page, attempt))) continue;

    let found = null;
    for (let pageNo = 1; pageNo <= MAX_SERP_PAGES && !found; pageNo += 1) {
      const inspected = await inspectResults(page, attempt, pageNo);
      if (inspected.challenge) {
        attempt.status = `challenge_on_page_${pageNo}`;
        break;
      }
      if (inspected.found) {
        found = inspected.found;
        break;
      }
      if (!inspected.count) {
        attempt.status = `no_results_on_page_${pageNo}`;
        break;
      }
      if (pageNo < MAX_SERP_PAGES && !(await clickNext(page, pageNo))) {
        attempt.status = `next_failed_on_page_${pageNo}`;
        break;
      }
    }

    if (!found) {
      if (attempt.status === 'started') attempt.status = 'target_not_found';
      continue;
    }

    if (await clickTarget(page, found, report, attempt)) await browseEmcd(page, report);
  } catch (error) {
    attempt.status = 'error';
    attempt.error = error instanceof Error ? error.message : String(error);
  } finally {
    await browser?.close().catch(() => undefined);
  }

  if (!report.clicked && i < plan.length - 1) await sleep(rnd(2500, 5500));
}

if (!report.clicked) report.error = 'all_clean_bing_attempts_failed';
await fs.writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
if (!report.clicked) process.exitCode = 1;
