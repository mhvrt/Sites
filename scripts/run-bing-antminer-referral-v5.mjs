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
  } catch {
    return href;
  }
}

function isTarget(value) {
  try {
    const u = new URL(value);
    return host(u.hostname) === TARGET_HOST && u.pathname.replace(/\/+$/, '/') === TARGET_PATH;
  } catch {
    return false;
  }
}

function isEmcd(value) {
  try {
    const u = new URL(value);
    return host(u.hostname) === TARGET_HOST && /^https?:$/.test(u.protocol);
  } catch {
    return false;
  }
}

function titleMatches(value) {
  const norm = (text) => clean(text).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const seen = norm(value);
  return seen === norm(TARGET_TITLE) || (
    seen.includes('mining with antminer s9 asic') &&
    seen.includes('still profitable')
  );
}

function challenged(text) {
  return /one last step|solve the challenge|verify you are human|unusual traffic/i.test(text || '');
}

async function blockAnalytics(context) {
  await context.route('**/*', async (route) => {
    try {
      const h = new URL(route.request().url()).hostname.toLowerCase();
      const blocked = ['google-analytics.com','googletagmanager.com','doubleclick.net','clarity.ms','hotjar.com','hotjar.io']
        .some((domain) => h.endsWith(domain));
      if (blocked) return route.abort('blockedbyclient');
    } catch {}
    return route.continue();
  });
}

async function moveAround(page, min = 800, max = 1800) {
  await page.waitForTimeout(rnd(min, max));
  const vp = page.viewportSize() || { width: 1440, height: 900 };
  await page.mouse.move(rnd(100, vp.width - 100), rnd(90, vp.height - 90), { steps: rnd(8, 18) }).catch(() => {});
  const h = await page.evaluate(() => Math.max(document.body?.scrollHeight || 0, document.documentElement?.scrollHeight || 0)).catch(() => 0);
  if (h > vp.height + 200) {
    await page.mouse.wheel(0, rnd(140, 420)).catch(() => {});
    await page.waitForTimeout(rnd(400, 900));
  }
}

async function searchBing(page, attempt) {
  await page.goto('https://www.bing.com/?cc=US&setlang=en-US', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(rnd(1300, 2400));
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

  await moveAround(page, 700, 1400);
  await input.click();
  await input.fill('');
  await input.pressSequentially(QUERY, { delay: rnd(65, 120) });
  attempt.typedQuery = await input.inputValue().catch(() => null);
  await input.press('Escape').catch(() => {});
  await page.waitForTimeout(rnd(400, 750));

  const onResults = () => {
    try { return new URL(page.url()).pathname === '/search'; } catch { return false; }
  };

  const icon = page.locator('#search_icon').first();
  if (await icon.isVisible().catch(() => false)) {
    const box = await icon.boundingBox().catch(() => null);
    if (box) {
      const before = page.url();
      const nav = page.waitForURL((u) => u.toString() !== before && u.pathname === '/search', { timeout: 8000, waitUntil: 'domcontentloaded' }).catch(() => null);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 }).catch(() => {});
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2).catch(() => {});
      await nav;
      if (onResults()) {
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
  if (onResults()) {
    attempt.searchMode = 'native_bing_form_submit';
    return true;
  }

  attempt.status = 'search_submit_failed';
  return false;
}

async function findTarget(page, pageNo) {
  const anchors = page.locator('a[href]');
  const count = Math.min(await anchors.count(), 700);
  for (let i = 0; i < count; i += 1) {
    const link = anchors.nth(i);
    const raw = (await link.getAttribute('href')) || '';
    const decoded = decodeBing(raw);
    if (!isTarget(decoded)) continue;
    const title = clean(await link.innerText().catch(() => ''));
    if (!titleMatches(title)) continue;
    return { link, raw, decoded, title, pageNo };
  }
  return null;
}

async function inspect(page, attempt, pageNo) {
  await page.waitForTimeout(rnd(1000, 1800));
  const body = await page.locator('body').innerText().catch(() => '');
  const isBlocked = challenged(body);
  const organicCount = Math.min(await page.locator('li.b_algo h2 a[href]').count(), 40);
  const anchorCount = Math.min(await page.locator('a[href]').count(), 700);
  attempt.pages.push({ page: pageNo, url: page.url(), organicCount, anchorCount, challenge: isBlocked });
  if (isBlocked) return { isBlocked: true, found: null };
  return { isBlocked: false, found: await findTarget(page, pageNo) };
}

async function fingerprint(page) {
  const links = page.locator('li.b_algo h2 a[href]');
  const count = Math.min(await links.count(), 5);
  const parts = [];
  for (let i = 0; i < count; i += 1) {
    const link = links.nth(i);
    parts.push(`${clean(await link.innerText().catch(() => ''))}|${(await link.getAttribute('href')) || ''}`);
  }
  return parts.join('\n');
}

async function scrollBottom(page) {
  for (let i = 0; i < 3; i += 1) {
    await page.evaluate(() => window.scrollTo(0, Math.max(document.body?.scrollHeight || 0, document.documentElement?.scrollHeight || 0))).catch(() => {});
    await page.waitForTimeout(rnd(550, 900));
  }
}

async function physicallyClickAndDetect(page, link) {
  const beforeUrl = page.url();
  const beforeFingerprint = await fingerprint(page);
  await link.scrollIntoViewIfNeeded().catch(() => {});
  await link.hover({ timeout: 2500 }).catch(() => {});
  await page.waitForTimeout(rnd(350, 750));
  const box = await link.boundingBox().catch(() => null);
  if (!box) return false;

  const urlChanged = page.waitForURL((u) => u.toString() !== beforeUrl, { timeout: 8000, waitUntil: 'domcontentloaded' }).catch(() => null);
  const resultsChanged = page.waitForFunction(
    ({ oldFingerprint }) => {
      const links = [...document.querySelectorAll('li.b_algo h2 a[href]')].slice(0, 5);
      const nextFingerprint = links.map((a) => `${(a.innerText || '').replace(/\s+/g, ' ').trim()}|${a.getAttribute('href') || ''}`).join('\n');
      return nextFingerprint && nextFingerprint !== oldFingerprint;
    },
    { oldFingerprint: beforeFingerprint },
    { timeout: 8000 },
  ).catch(() => null);

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 }).catch(() => {});
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2).catch(() => {});
  const changed = await Promise.race([urlChanged, resultsChanged]);
  if (changed) return true;

  // A focused Enter is still a physical activation of the exact Bing pagination link.
  await link.focus().catch(() => {});
  const urlChangedAgain = page.waitForURL((u) => u.toString() !== beforeUrl, { timeout: 6000, waitUntil: 'domcontentloaded' }).catch(() => null);
  await page.keyboard.press('Enter').catch(() => {});
  return Boolean(await urlChangedAgain);
}

async function nextPage(page, attempt) {
  await moveAround(page, 500, 1100);
  await scrollBottom(page);

  const candidates = [];
  const direct = page.locator('a[aria-label="Next page"], a[title="Next page"], a.sb_pagN');
  const directCount = Math.min(await direct.count(), 5);
  for (let i = 0; i < directCount; i += 1) {
    const link = direct.nth(i);
    if (await link.isVisible().catch(() => false)) candidates.push(link);
  }

  if (!candidates.length) {
    const anchors = page.locator('a[href]');
    const count = Math.min(await anchors.count(), 700);
    const currentFirst = Number(new URL(page.url()).searchParams.get('first') || 0);
    const indexed = [];
    for (let i = 0; i < count; i += 1) {
      const link = anchors.nth(i);
      if (!(await link.isVisible().catch(() => false))) continue;
      try {
        const u = new URL((await link.getAttribute('href')) || '', page.url());
        const first = Number(u.searchParams.get('first') || 0);
        if (host(u.hostname) === 'bing.com' && u.pathname === '/search' && first > currentFirst) indexed.push({ link, first });
      } catch {}
    }
    indexed.sort((a, b) => a.first - b.first);
    if (indexed.length) candidates.push(indexed[0].link);
  }

  if (!candidates.length) return false;
  attempt.pages.at(-1).nextHref = await candidates[0].getAttribute('href').catch(() => null);
  return physicallyClickAndDetect(page, candidates[0]);
}

async function clickTarget(page, found, report, attempt) {
  await moveAround(page, 2200, 4000);
  await found.link.scrollIntoViewIfNeeded();
  await found.link.hover({ timeout: 3500 }).catch(() => {});
  await page.waitForTimeout(rnd(1600, 3200));

  const popupPromise = page.waitForEvent('popup', { timeout: 12000 }).catch(() => null);
  const sameTabPromise = page.waitForURL((u) => isTarget(u.toString()), { timeout: 12000, waitUntil: 'domcontentloaded' }).catch(() => null);
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
    if (sameTab || isTarget(page.url())) destination = page;
  }
  if (!destination) return null;

  report.clicked = true;
  report.successfulAttempt = attempt.number;
  report.matchedTitle = found.title;
  report.matchedUrl = found.decoded;
  report.rawBingHref = found.raw;
  report.serpPage = found.pageNo;
  report.referrer = await destination.evaluate(() => document.referrer).catch(() => null);
  report.finalUrl = destination.url();
  attempt.status = 'clicked_target';
  return destination;
}

async function walkEmcd(page, report) {
  report.emcdRoute = [page.url()];
  const visited = new Set(report.emcdRoute);
  const extra = rnd(3, 5);

  for (let step = 0; step < extra; step += 1) {
    await moveAround(page, 1600, 3000);
    const anchors = page.locator('a[href]');
    const count = Math.min(await anchors.count(), 550);
    const choices = [];
    for (let i = 0; i < count; i += 1) {
      const link = anchors.nth(i);
      if (!(await link.isVisible().catch(() => false))) continue;
      const href = (await link.getAttribute('href')) || '';
      if (!href || /^(?:#|mailto:|tel:|javascript:)/i.test(href)) continue;
      let absolute;
      try { absolute = new URL(href, page.url()).toString(); } catch { continue; }
      if (!isEmcd(absolute) || visited.has(absolute) || /\.(?:pdf|zip|docx?|xlsx?|pptx?)(?:[?#]|$)/i.test(absolute)) continue;
      if (!clean(await link.innerText().catch(() => ''))) continue;
      choices.push({ link, absolute });
    }
    if (!choices.length) break;

    const choice = choices[rnd(0, choices.length - 1)];
    const before = page.url();
    await choice.link.scrollIntoViewIfNeeded().catch(() => {});
    await choice.link.evaluate((el) => el.removeAttribute('target')).catch(() => {});
    const nav = page.waitForURL((u) => isEmcd(u.toString()) && u.toString() !== before, { timeout: 22000, waitUntil: 'domcontentloaded' }).catch(() => null);
    await choice.link.click({ timeout: 12000 }).catch(() => {});
    if (!(await nav)) continue;
    if (page.url() !== before && isEmcd(page.url())) {
      visited.add(page.url());
      report.emcdRoute.push(page.url());
    }
  }

  await moveAround(page, 1500, 2800);
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
  serpPage: null,
  referrer: null,
  finalUrl: null,
  emcdPagesVisited: 0,
  emcdRoute: [],
  error: null,
};

const plan = [
  { browser: 'firefox', launcher: firefox },
  { browser: 'chromium', launcher: chromium },
  { browser: 'firefox', launcher: firefox },
  { browser: 'chromium', launcher: chromium },
].slice(0, MAX_ATTEMPTS);

for (let attemptIndex = 0; attemptIndex < plan.length && !report.clicked; attemptIndex += 1) {
  const attempt = {
    number: attemptIndex + 1,
    browser: plan[attemptIndex].browser,
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
    browser = await plan[attemptIndex].launcher.launch({ headless: true });
    const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 900 } });
    await blockAnalytics(context);
    const bing = await context.newPage();
    if (!(await searchBing(bing, attempt))) continue;

    let found = null;
    for (let pageNo = 1; pageNo <= MAX_PAGES && !found; pageNo += 1) {
      const state = await inspect(bing, attempt, pageNo);
      if (state.isBlocked) {
        attempt.status = `challenge_on_page_${pageNo}`;
        break;
      }
      if (state.found) {
        found = state.found;
        break;
      }
      if (pageNo < MAX_PAGES && !(await nextPage(bing, attempt))) {
        attempt.status = `next_failed_on_page_${pageNo}`;
        break;
      }
    }

    if (!found) {
      if (attempt.status === 'started') attempt.status = 'target_not_found';
      continue;
    }

    const destination = await clickTarget(bing, found, report, attempt);
    if (!destination) {
      attempt.status = 'target_click_failed';
      continue;
    }
    await walkEmcd(destination, report);
  } catch (error) {
    attempt.status = 'error';
    attempt.error = error instanceof Error ? error.message : String(error);
  } finally {
    await browser?.close().catch(() => {});
  }

  if (!report.clicked && attemptIndex < plan.length - 1) await sleep(rnd(2200, 4500));
}

if (!report.clicked) report.error = 'all_clean_bing_attempts_failed';
await fs.writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
if (!report.clicked) process.exitCode = 1;
