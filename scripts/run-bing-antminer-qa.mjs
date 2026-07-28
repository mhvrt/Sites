import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { firefox } from 'playwright';

const REPORT_PATH = process.env.REPORT_PATH || path.join(os.tmpdir(), 'bing-antminer-qa.json');
const QUERY = 'antminer s9';
const TARGET_HOST = 'emcd.io';
const TARGET_PATH = '/articles/mining/mining-with-antminer-s9-asic-is-it-still-profitable/';
const TARGET_URL = `https://${TARGET_HOST}${TARGET_PATH}`;
const EXPECTED_TITLE = 'Mining with Antminer S9 ASIC: Is It Still Profitable?';

const randomBetween = (min, max) => Math.floor(min + Math.random() * (max - min + 1));
const cleanText = (value) => String(value || '').replace(/\s+/g, ' ').trim();

function decodeBingUrl(href) {
  try {
    const u = new URL(href);
    const encoded = u.searchParams.get('u') || '';
    if (!encoded.startsWith('a1')) return href;
    let raw = encoded.slice(2);
    raw += '='.repeat((4 - (raw.length % 4)) % 4);
    return Buffer.from(raw, 'base64').toString('utf8');
  } catch {
    return href;
  }
}

function normalizeHost(value) {
  return String(value || '').toLowerCase().replace(/^www\./, '');
}

function isEmcdUrl(value) {
  try {
    const u = new URL(value);
    return normalizeHost(u.hostname) === TARGET_HOST && /^https?:$/.test(u.protocol);
  } catch {
    return false;
  }
}

function isTargetUrl(value) {
  try {
    const u = new URL(value);
    return (
      normalizeHost(u.hostname) === TARGET_HOST &&
      u.pathname.replace(/\/+$/, '/') === TARGET_PATH
    );
  } catch {
    return false;
  }
}

async function naturalRead(page) {
  await page.waitForTimeout(randomBetween(2200, 5200));

  const viewportHeight = await page.evaluate(() => window.innerHeight || 800).catch(() => 800);
  const scrollHeight = await page.evaluate(() => document.documentElement.scrollHeight || document.body.scrollHeight || 0).catch(() => 0);
  const maxScroll = Math.max(0, scrollHeight - viewportHeight);

  if (maxScroll > 250) {
    const first = randomBetween(Math.min(200, maxScroll), Math.max(Math.min(900, maxScroll), Math.min(200, maxScroll)));
    await page.evaluate((y) => window.scrollTo({ top: y, behavior: 'smooth' }), first).catch(() => undefined);
    await page.waitForTimeout(randomBetween(900, 2200));

    const secondMin = Math.min(maxScroll, first + 200);
    const secondMax = Math.min(maxScroll, first + randomBetween(450, 1300));
    if (secondMax > secondMin) {
      const second = randomBetween(secondMin, secondMax);
      await page.evaluate((y) => window.scrollTo({ top: y, behavior: 'smooth' }), second).catch(() => undefined);
      await page.waitForTimeout(randomBetween(1000, 2600));
    }
  }
}

async function browseEmcd(page, report) {
  const additionalPages = randomBetween(3, 5);
  const visited = new Set([page.url()]);
  report.emcdRoute = [page.url()];

  for (let step = 0; step < additionalPages; step += 1) {
    await naturalRead(page);

    const anchors = page.locator('a[href]');
    const count = Math.min(await anchors.count(), 500);
    const candidates = [];

    for (let i = 0; i < count; i += 1) {
      const link = anchors.nth(i);
      if (!(await link.isVisible().catch(() => false))) continue;

      const href = (await link.getAttribute('href')) || '';
      if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) continue;

      let absolute;
      try {
        absolute = new URL(href, page.url()).toString();
      } catch {
        continue;
      }

      if (!isEmcdUrl(absolute)) continue;
      if (visited.has(absolute)) continue;
      if (absolute === page.url()) continue;

      const text = cleanText(await link.innerText().catch(() => ''));
      if (!text) continue;

      candidates.push({ index: i, url: absolute, text });
    }

    if (!candidates.length) break;

    const chosen = candidates[randomBetween(0, candidates.length - 1)];
    const link = anchors.nth(chosen.index);
    const before = page.url();

    await link.scrollIntoViewIfNeeded().catch(() => undefined);
    await page.waitForTimeout(randomBetween(500, 1500));
    await link.evaluate((el) => el.removeAttribute('target')).catch(() => undefined);

    const nav = page.waitForURL(
      (u) => isEmcdUrl(u.toString()) && u.toString() !== before,
      { timeout: 30000, waitUntil: 'domcontentloaded' },
    ).catch(() => undefined);

    await link.click({ timeout: 15000 }).catch(() => undefined);
    await nav;
    await page.waitForTimeout(randomBetween(1200, 3200));

    const current = page.url();
    if (!isEmcdUrl(current) || current === before) continue;

    visited.add(current);
    report.emcdRoute.push(current);
  }

  await naturalRead(page);
  report.emcdPagesVisited = report.emcdRoute.length;
  report.finalUrl = page.url();
}

let browser;
const report = {
  synthetic: true,
  query: QUERY,
  expectedTitle: EXPECTED_TITLE,
  targetUrl: TARGET_URL,
  clicked: false,
  matchedTitle: null,
  matchedUrl: null,
  bingRegion: null,
  bingMarket: null,
  rank: null,
  finalUrl: null,
  referrer: null,
  emcdPagesVisited: 0,
  emcdRoute: [],
  error: null,
};

try {
  browser = await firefox.launch({ headless: true });
  const context = await browser.newContext({
    locale: 'en-US',
    viewport: { width: 1440, height: 900 },
  });

  // Keep the destination analytics clean: the run is synthetic QA, not a real user session.
  await context.route('**/*', async (route) => {
    try {
      const host = new URL(route.request().url()).hostname.toLowerCase();
      if (
        host.endsWith('google-analytics.com') ||
        host.endsWith('googletagmanager.com') ||
        host.endsWith('doubleclick.net') ||
        host.endsWith('clarity.ms') ||
        host.endsWith('hotjar.com') ||
        host.endsWith('hotjar.io')
      ) {
        return route.abort('blockedbyclient');
      }
    } catch {}
    return route.continue();
  });

  const page = await context.newPage();
  const searchUrl = `https://www.bing.com/search?q=${encodeURIComponent(QUERY)}&cc=US&setlang=en-US`;
  await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(randomBetween(1800, 4200));

  const globals = await page.evaluate(() => ({
    region: globalThis?._G?.Region || null,
    market: globalThis?._G?.Mkt || null,
  })).catch(() => ({ region: null, market: null }));
  report.bingRegion = globals.region;
  report.bingMarket = globals.market;

  const results = page.locator('li.b_algo h2 a');
  const count = Math.min(await results.count(), 50);
  let found = null;

  for (let i = 0; i < count; i += 1) {
    const link = results.nth(i);
    const title = cleanText(await link.innerText().catch(() => ''));
    const href = (await link.getAttribute('href')) || '';
    const decoded = decodeBingUrl(href);

    // Require both the exact SERP title supplied by the user and the expected EMCD article URL.
    if (title === EXPECTED_TITLE && isTargetUrl(decoded)) {
      found = { link, rank: i + 1, href, decoded, title };
      break;
    }
  }

  if (!found) throw new Error('exact_target_not_found_on_bing_results');

  report.rank = found.rank;
  report.matchedTitle = found.title;
  report.matchedUrl = found.decoded;

  await found.link.scrollIntoViewIfNeeded();
  await page.waitForTimeout(randomBetween(700, 1800));

  const nav = page.waitForURL(
    (u) => isTargetUrl(u.toString()),
    { timeout: 45000, waitUntil: 'domcontentloaded' },
  );

  await found.link.click({ timeout: 15000 });
  await nav;
  await page.waitForTimeout(randomBetween(1800, 4200));

  report.clicked = true;
  report.referrer = await page.evaluate(() => document.referrer);

  await browseEmcd(page, report);
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
} finally {
  await browser?.close().catch(() => undefined);
  await fs.writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
}

if (!report.clicked) process.exitCode = 1;
