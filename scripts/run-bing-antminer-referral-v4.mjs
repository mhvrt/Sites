import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, firefox } from 'playwright';

const QUERY = 'antminer s9';
const TARGET_HOST = 'emcd.io';
const TARGET_PATH = '/articles/mining/mining-with-antminer-s9-asic-is-it-still-profitable/';
const TARGET_URL = `https://${TARGET_HOST}${TARGET_PATH}`;
const TARGET_TITLE = 'Mining with Antminer S9 ASIC: Is It Still Profitable?';
const REPORT_PATH = process.env.REPORT_PATH || path.join(os.tmpdir(), 'bing-antminer-qa.json');
const MAX_ATTEMPTS = Math.max(1, Math.min(4, Number(process.env.BING_MAX_ATTEMPTS || 3)));
const MAX_PAGES = Math.max(1, Math.min(7, Number(process.env.BING_MAX_SERP_PAGES || 5)));

const rnd = (min, max) => Math.floor(min + Math.random() * (max - min + 1));
const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
const normHost = (value) => String(value || '').toLowerCase().replace(/^www\./, '');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

function isTargetUrl(value) {
  try {
    const url = new URL(value);
    return normHost(url.hostname) === TARGET_HOST && url.pathname.replace(/\/+$/, '/') === TARGET_PATH;
  } catch {
    return false;
  }
}

function isEmcdUrl(value) {
  try {
    const url = new URL(value);
    return normHost(url.hostname) === TARGET_HOST && /^https?:$/.test(url.protocol);
  } catch {
    return false;
  }
}

function titleMatches(value) {
  const normalize = (text) => clean(text).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const observed = normalize(value);
  const expected = normalize(TARGET_TITLE);
  return observed === expected || (
    observed.includes('mining with antminer s9 asic') &&
    observed.includes('still profitable')
  );
}

function hasChallenge(text) {
  return /one last step|solve the challenge|verify you are human|unusual traffic/i.test(text || '');
}

async function blockAnalytics(context) {
  await context.route('**/*', async (route) => {
    try {
      const requestHost = new URL(route.request().url()).hostname.toLowerCase();
      const blocked = [
        'google-analytics.com',
        'googletagmanager.com',
        'doubleclick.net',
        'clarity.ms',
        'hotjar.com',
        'hotjar.io',
      ].some((domain) => requestHost.endsWith(domain));
      if (blocked) return route.abort('blockedbyclient');
    } catch {}
    return route.continue();
  });
}

async function humanPause(page, min = 900, max = 2200) {
  await page.waitForTimeout(rnd(min, max));
  const viewport = page.viewportSize() || { width: 1440, height: 900 };
  await page.mouse.move(
    rnd(120, Math.max(121, viewport.width - 120)),
    rnd(100, Math.max(101, viewport.height - 100)),
    { steps: rnd(8, 18) },
  ).catch(() => undefined);

  const height = await page.evaluate(() => Math.max(
    document.body?.scrollHeight || 0,
    document.documentElement?.scrollHeight || 0,
  )).catch(() => 0);

  if (height > viewport.height + 250) {
    await page.mouse.wheel(0, rnd(160, 480)).catch(() => undefined);
    await page.waitForTimeout(rnd(450, 1100));
    if (Math.random() < 0.25) {
      await page.mouse.wheel(0, -rnd(80, 180)).catch(() => undefined);
      await page.waitForTimeout(rnd(300, 750));
    }
  }
}

async function acceptCookies(page) {
  const button = page.locator(
    '#bnp_btn_accept, button:has-text("Accept all"), button:has-text("Accept"), button:has-text("I agree")',
  ).first();
  if (await button.isVisible().catch(() => false)) {
    await button.click({ timeout: 3000 }).catch(() => undefined);
    await page.waitForTimeout(rnd(350, 800));
  }
}

async function searchFromHomepage(page, attempt) {
  await page.goto('https://www.bing.com/?cc=US&setlang=en-US', {
    waitUntil: 'domcontentloaded',
    timeout: 45000,
  });
  await page.waitForTimeout(rnd(1400, 2600));
  await acceptCookies(page);

  const homepageText = await page.locator('body').innerText().catch(() => '');
  if (hasChallenge(homepageText)) {
    attempt.status = 'challenge_on_homepage';
    return false;
  }

  const input = page.locator('#sb_form_q').first();
  if (!(await input.isVisible().catch(() => false))) {
    attempt.status = 'search_input_missing';
    return false;
  }

  await humanPause(page, 700, 1500);
  await input.click({ timeout: 5000 });
  await input.fill('');
  await input.pressSequentially(QUERY, { delay: rnd(65, 120) });
  attempt.typedQuery = await input.inputValue().catch(() => null);
  await input.press('Escape').catch(() => undefined);
  await page.waitForTimeout(rnd(450, 850));

  const onSearchPage = () => {
    try {
      return new URL(page.url()).pathname === '/search';
    } catch {
      return false;
    }
  };

  // Prefer a real pointer click on Bing's visible search icon.
  const icon = page.locator('#search_icon').first();
  if (await icon.isVisible().catch(() => false)) {
    const box = await icon.boundingBox().catch(() => null);
    if (box) {
      const before = page.url();
      const nav = page.waitForURL(
        (url) => url.toString() !== before && url.pathname === '/search',
        { timeout: 8000, waitUntil: 'domcontentloaded' },
      ).catch(() => null);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 }).catch(() => undefined);
      await page.waitForTimeout(rnd(250, 600));
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2).catch(() => undefined);
      await nav;
      if (onSearchPage()) {
        attempt.searchMode = 'physical_search_icon_click';
        return true;
      }
    }
  }

  // Keyboard fallback after closing autosuggest.
  {
    const before = page.url();
    const nav = page.waitForURL(
      (url) => url.toString() !== before && url.pathname === '/search',
      { timeout: 6500, waitUntil: 'domcontentloaded' },
    ).catch(() => null);
    await input.press('Enter').catch(() => undefined);
    await nav;
    if (onSearchPage()) {
      attempt.searchMode = 'input_enter';
      return true;
    }
  }

  // Final fallback submits Bing's own live form with its existing hidden fields.
  {
    const before = page.url();
    const nav = page.waitForURL(
      (url) => url.toString() !== before && url.pathname === '/search',
      { timeout: 9000, waitUntil: 'domcontentloaded' },
    ).catch(() => null);
    await input.evaluate((element) => {
      const form = element.form || element.closest('form');
      if (!form) throw new Error('bing_form_missing');
      HTMLFormElement.prototype.submit.call(form);
    }).catch(() => undefined);
    await nav;
    await page.waitForTimeout(250);
    if (onSearchPage()) {
      attempt.searchMode = 'native_bing_form_submit';
      return true;
    }
  }

  attempt.status = 'search_submit_failed';
  return false;
}

async function findTarget(page, pageNo) {
  const anchors = page.locator('a[href]');
  const count = Math.min(await anchors.count(), 650);

  for (let index = 0; index < count; index += 1) {
    const link = anchors.nth(index);
    const rawHref = (await link.getAttribute('href')) || '';
    const decodedHref = decodeBingHref(rawHref);
    if (!isTargetUrl(decodedHref)) continue;

    const title = clean(await link.innerText().catch(() => ''));
    if (!titleMatches(title)) continue;

    return {
      link,
      title,
      rawHref,
      decodedHref,
      pageNo,
      source: 'all_anchors',
    };
  }

  return null;
}

async function inspectSerp(page, attempt, pageNo) {
  await page.waitForTimeout(rnd(1100, 2000));
  const bodyText = await page.locator('body').innerText().catch(() => '');
  const challenged = hasChallenge(bodyText);
  const organicCount = Math.min(await page.locator('li.b_algo h2 a[href]').count(), 30);
  const anchorCount = Math.min(await page.locator('a[href]').count(), 650);

  attempt.pages.push({
    page: pageNo,
    url: page.url(),
    organicCount,
    anchorCount,
    challenge: challenged,
  });

  if (challenged) return { challenged: true, found: null };
  return { challenged: false, found: await findTarget(page, pageNo) };
}

async function scrollToPagination(page) {
  for (let index = 0; index < 3; index += 1) {
    await page.evaluate(() => window.scrollTo({
      top: Math.max(document.body?.scrollHeight || 0, document.documentElement?.scrollHeight || 0),
      behavior: 'smooth',
    })).catch(() => undefined);
    await page.waitForTimeout(rnd(650, 1050));
  }
}

async function clickNextPage(page, attempt) {
  await humanPause(page, 600, 1200);
  await scrollToPagination(page);

  const next = page.locator('a.sb_pagN, a[title="Next page"], a[aria-label="Next page"]').first();
  if (!(await next.isVisible().catch(() => false))) return false;

  attempt.pages.at(-1).nextHref = await next.getAttribute('href').catch(() => null);
  await next.scrollIntoViewIfNeeded().catch(() => undefined);
  await next.hover({ timeout: 3000 }).catch(() => undefined);
  await page.waitForTimeout(rnd(400, 900));

  const before = page.url();
  const navigation = page.waitForURL(
    (url) => url.toString() !== before,
    { timeout: 10000, waitUntil: 'domcontentloaded' },
  ).catch(() => null);

  await next.click({ timeout: 8000 }).catch(() => undefined);
  return Boolean(await navigation);
}

async function clickBingResult(page, found, report, attempt) {
  await humanPause(page, 2400, 4300);
  await found.link.scrollIntoViewIfNeeded();
  await found.link.hover({ timeout: 4000 }).catch(() => undefined);
  await page.waitForTimeout(rnd(1700, 3800));

  // Preserve Bing's target="_blank" and click the raw bing.com/ck/a link exactly as served.
  const popupPromise = page.waitForEvent('popup', { timeout: 12000 }).catch(() => null);
  const sameTabPromise = page.waitForURL(
    (url) => isTargetUrl(url.toString()),
    { timeout: 12000, waitUntil: 'domcontentloaded' },
  ).catch(() => null);

  await found.link.click({ timeout: 12000 });

  let destination = null;
  const popup = await popupPromise;
  if (popup) {
    await popup.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => undefined);
    await popup.waitForTimeout(800).catch(() => undefined);
    attempt.popupOpened = true;
    attempt.popupUrl = popup.url();
    if (isTargetUrl(popup.url())) destination = popup;
  }

  if (!destination) {
    const sameTab = await sameTabPromise;
    if (sameTab || isTargetUrl(page.url())) destination = page;
  }

  if (!destination) return null;

  report.clicked = true;
  report.successfulAttempt = attempt.number;
  report.matchedTitle = found.title;
  report.matchedUrl = found.decodedHref;
  report.rawBingHref = found.rawHref;
  report.serpPage = found.pageNo;
  report.resultSource = found.source;
  report.finalUrl = destination.url();
  report.referrer = await destination.evaluate(() => document.referrer).catch(() => null);
  attempt.status = 'clicked_target';
  return destination;
}

async function walkEmcd(page, report) {
  report.emcdRoute = [page.url()];
  const visited = new Set(report.emcdRoute);
  const extraPages = rnd(3, 5);

  for (let step = 0; step < extraPages; step += 1) {
    await humanPause(page, 1700, 3300);
    const anchors = page.locator('a[href]');
    const count = Math.min(await anchors.count(), 500);
    const choices = [];

    for (let index = 0; index < count; index += 1) {
      const link = anchors.nth(index);
      if (!(await link.isVisible().catch(() => false))) continue;

      const href = (await link.getAttribute('href')) || '';
      if (!href || /^(?:#|mailto:|tel:|javascript:)/i.test(href)) continue;

      let absolute;
      try {
        absolute = new URL(href, page.url()).toString();
      } catch {
        continue;
      }

      if (!isEmcdUrl(absolute) || visited.has(absolute)) continue;
      if (/\.(?:pdf|zip|docx?|xlsx?|pptx?)(?:[?#]|$)/i.test(absolute)) continue;
      if (!clean(await link.innerText().catch(() => ''))) continue;
      choices.push({ index, url: absolute });
    }

    if (!choices.length) break;
    const choice = choices[rnd(0, choices.length - 1)];
    const link = anchors.nth(choice.index);
    const before = page.url();

    await link.scrollIntoViewIfNeeded().catch(() => undefined);
    await link.hover({ timeout: 3000 }).catch(() => undefined);
    await page.waitForTimeout(rnd(450, 1100));
    await link.evaluate((element) => element.removeAttribute('target')).catch(() => undefined);

    const navigation = page.waitForURL(
      (url) => isEmcdUrl(url.toString()) && url.toString() !== before,
      { timeout: 22000, waitUntil: 'domcontentloaded' },
    ).catch(() => null);

    await link.click({ timeout: 12000 }).catch(() => undefined);
    if (!(await navigation)) continue;

    const current = page.url();
    if (current !== before && isEmcdUrl(current)) {
      visited.add(current);
      report.emcdRoute.push(current);
    }
  }

  await humanPause(page, 1600, 3000);
  report.emcdPagesVisited = report.emcdRoute.length;
  report.finalUrl = page.url();
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
  resultSource: null,
  serpPage: null,
  referrer: null,
  finalUrl: null,
  emcdPagesVisited: 0,
  emcdRoute: [],
  error: null,
};

const attemptPlan = [
  { browser: 'firefox', launcher: firefox },
  { browser: 'chromium', launcher: chromium },
  { browser: 'firefox', launcher: firefox },
  { browser: 'chromium', launcher: chromium },
].slice(0, MAX_ATTEMPTS);

for (let index = 0; index < attemptPlan.length && !report.clicked; index += 1) {
  const attempt = {
    number: index + 1,
    browser: attemptPlan[index].browser,
    typedQuery: null,
    searchMode: null,
    pages: [],
    popupOpened: false,
    popupUrl: null,
    status: 'started',
    error: null,
  };
  report.attempts.push(attempt);

  let browser;
  try {
    browser = await attemptPlan[index].launcher.launch({ headless: true });
    const context = await browser.newContext({
      locale: 'en-US',
      viewport: { width: 1440, height: 900 },
    });
    await blockAnalytics(context);
    const bingPage = await context.newPage();

    if (!(await searchFromHomepage(bingPage, attempt))) continue;

    let found = null;
    for (let pageNo = 1; pageNo <= MAX_PAGES && !found; pageNo += 1) {
      const state = await inspectSerp(bingPage, attempt, pageNo);
      if (state.challenged) {
        attempt.status = `challenge_on_page_${pageNo}`;
        break;
      }
      if (state.found) {
        found = state.found;
        break;
      }
      if (pageNo < MAX_PAGES && !(await clickNextPage(bingPage, attempt))) {
        attempt.status = `next_failed_on_page_${pageNo}`;
        break;
      }
    }

    if (!found) {
      if (attempt.status === 'started') attempt.status = 'target_not_found';
      continue;
    }

    const destination = await clickBingResult(bingPage, found, report, attempt);
    if (!destination) {
      attempt.status = 'target_click_failed';
      continue;
    }

    await walkEmcd(destination, report);
  } catch (error) {
    attempt.status = 'error';
    attempt.error = error instanceof Error ? error.message : String(error);
  } finally {
    await browser?.close().catch(() => undefined);
  }

  if (!report.clicked && index < attemptPlan.length - 1) {
    await sleep(rnd(2500, 5000));
  }
}

if (!report.clicked) report.error = 'all_clean_bing_attempts_failed';
await fs.writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
if (!report.clicked) process.exitCode = 1;
