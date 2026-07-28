import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { firefox } from 'playwright';

const REPORT_PATH = process.env.REPORT_PATH || path.join(os.tmpdir(), 'bing-hrefs.json');
const QUERY = 'antminer s9';
const TARGET = 'https://emcd.io/articles/mining/mining-with-antminer-s9-asic-is-it-still-profitable/';

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

const report = { query: QUERY, target: TARGET, pages: [], targetMentions: [] };
let browser;
try {
  browser = await firefox.launch({ headless: true });
  const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  for (let serpPage = 1; serpPage <= 5; serpPage += 1) {
    const url = new URL('https://www.bing.com/search');
    url.searchParams.set('q', QUERY);
    url.searchParams.set('cc', 'US');
    url.searchParams.set('setlang', 'en-US');
    url.searchParams.set('count', '10');
    if (serpPage > 1) url.searchParams.set('first', String((serpPage - 1) * 10 + 1));

    await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2500);

    const globals = await page.evaluate(() => ({ region: globalThis?._G?.Region || null, market: globalThis?._G?.Mkt || null })).catch(() => ({ region: null, market: null }));
    const pageTitle = await page.title().catch(() => '');
    const bodyText = await page.locator('body').innerText().catch(() => '');

    const resultLinks = page.locator('li.b_algo h2 a');
    const resultCount = Math.min(await resultLinks.count(), 20);
    const results = [];

    for (let i = 0; i < resultCount; i += 1) {
      const link = resultLinks.nth(i);
      const title = String(await link.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
      const rawHref = (await link.getAttribute('href')) || '';
      const decodedHref = decodeBingUrl(rawHref);
      const item = { rankOnPage: i + 1, title, rawHref, decodedHref };
      results.push(item);
      const haystack = `${title}\n${rawHref}\n${decodedHref}`.toLowerCase();
      if (haystack.includes('emcd.io') || haystack.includes('mining with antminer s9') || haystack.includes('still profitable')) {
        report.targetMentions.push({ serpPage, ...item });
      }
    }

    const allAnchors = page.locator('a[href]');
    const anchorCount = Math.min(await allAnchors.count(), 120);
    const anchorSamples = [];
    for (let i = 0; i < anchorCount; i += 1) {
      const a = allAnchors.nth(i);
      const text = String(await a.innerText().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 180);
      const rawHref = (await a.getAttribute('href')) || '';
      if (!rawHref) continue;
      anchorSamples.push({ text, rawHref, decodedHref: decodeBingUrl(rawHref) });
    }

    report.pages.push({
      serpPage,
      url: page.url(),
      region: globals.region,
      market: globals.market,
      pageTitle,
      bodyTextSample: bodyText.replace(/\s+/g, ' ').trim().slice(0, 2000),
      resultCount,
      totalAnchorCount: await allAnchors.count(),
      results,
      anchorSamples,
    });
  }
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
} finally {
  await browser?.close().catch(() => undefined);
  await fs.writeFile(REPORT_PATH, JSON.stringify(report, null, 2) + '\n');
}

console.log(JSON.stringify({ pages: report.pages.length, targetMentions: report.targetMentions, error: report.error || null }));
