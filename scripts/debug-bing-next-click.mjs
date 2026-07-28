import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, firefox } from 'playwright';

const REPORT_PATH = process.env.REPORT_PATH || path.join(os.tmpdir(), 'bing-next-click.json');
const QUERY = 'antminer s9';
const BROWSER_NAME = process.env.BROWSER || 'chromium';
const TARGET_PAGES = Math.max(2, Math.min(5, Number(process.env.TARGET_PAGES || 2)));
const launcher = BROWSER_NAME === 'firefox' ? firefox : chromium;
const report = { query: QUERY, browser: BROWSER_NAME, targetPages: TARGET_PAGES, pages: [], passed: false, error: null };

function decodeBingUrl(href) {
  try {
    const u = new URL(href, 'https://www.bing.com');
    const encoded = u.searchParams.get('u') || '';
    if (!encoded.startsWith('a1')) return href;
    let raw = encoded.slice(2);
    raw += '='.repeat((4 - (raw.length % 4)) % 4);
    return Buffer.from(raw, 'base64').toString('utf8');
  } catch {
    return href;
  }
}

let browser;
try {
  browser = await launcher.launch({ headless: true });
  const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const search = new URL('https://www.bing.com/search');
  search.searchParams.set('q', QUERY);
  search.searchParams.set('cc', 'US');
  search.searchParams.set('setlang', 'en-US');
  search.searchParams.set('count', '10');

  await page.goto(search.toString(), { waitUntil: 'domcontentloaded', timeout: 45000 });

  for (let pageNo = 1; pageNo <= TARGET_PAGES; pageNo += 1) {
    await page.waitForTimeout(1800);
    const title = await page.title().catch(() => '');
    const body = await page.locator('body').innerText().catch(() => '');
    const links = page.locator('li.b_algo h2 a');
    const count = Math.min(await links.count(), 20);
    const items = [];

    for (let i = 0; i < count; i += 1) {
      const link = links.nth(i);
      const text = String(await link.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
      const rawHref = (await link.getAttribute('href')) || '';
      items.push({ rankOnPage: i + 1, title: text, rawHref, decodedHref: decodeBingUrl(rawHref) });
    }

    const challenge = /one last step|solve the challenge/i.test(body);
    report.pages.push({ pageNo, url: page.url(), title, resultCount: count, challenge, results: items });

    if (challenge) {
      report.error = `bing_challenge_on_page_${pageNo}`;
      break;
    }
    if (count === 0) {
      report.error = `no_organic_results_on_page_${pageNo}`;
      break;
    }
    if (pageNo === TARGET_PAGES) {
      report.passed = true;
      break;
    }

    const next = page.locator('a.sb_pagN, a[title="Next page"], a[aria-label="Next page"]').first();
    if (!(await next.isVisible().catch(() => false))) {
      report.error = `next_link_not_found_on_page_${pageNo}`;
      break;
    }

    await next.scrollIntoViewIfNeeded().catch(() => undefined);
    await page.waitForTimeout(1200);
    const before = page.url();
    const nav = page.waitForURL((u) => u.toString() !== before, { timeout: 30000, waitUntil: 'domcontentloaded' }).catch(() => null);
    await next.click({ timeout: 10000 });
    const navigated = await nav;
    if (!navigated) {
      report.error = `next_click_no_navigation_on_page_${pageNo}`;
      break;
    }
  }
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
} finally {
  await browser?.close().catch(() => undefined);
  await fs.writeFile(REPORT_PATH, JSON.stringify(report, null, 2) + '\n');
}

console.log(JSON.stringify({
  browser: report.browser,
  targetPages: report.targetPages,
  passed: report.passed,
  pages: report.pages.map((p) => ({ pageNo: p.pageNo, resultCount: p.resultCount, challenge: p.challenge, url: p.url })),
  error: report.error,
}));

if (!report.passed) process.exitCode = 1;
