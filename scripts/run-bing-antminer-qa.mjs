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

function isTargetUrl(value) {
  try {
    const u = new URL(value);
    return (
      u.hostname.replace(/^www\./, '') === TARGET_HOST &&
      u.pathname.replace(/\/+$/, '/') === TARGET_PATH
    );
  } catch {
    return false;
  }
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
  report.finalUrl = page.url();
  report.referrer = await page.evaluate(() => document.referrer);
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
} finally {
  await browser?.close().catch(() => undefined);
  await fs.writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
}

if (!report.clicked) process.exitCode = 1;
