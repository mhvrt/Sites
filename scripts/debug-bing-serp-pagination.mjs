import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { firefox, chromium } from 'playwright';

const REPORT_PATH = process.env.REPORT_PATH || path.join(os.tmpdir(), 'bing-serp-pagination.json');
const report = { attempts: [], error: null };

async function attempt(name, launcher) {
  const out = { browser: name, searchMode: null, url: null, resultCount: 0, bodyTail: null, candidates: [], error: null };
  let browser;
  try {
    browser = await launcher.launch({ headless: true });
    const page = await browser.newPage({ locale: 'en-US', viewport: { width: 1440, height: 900 } });
    await page.goto('https://www.bing.com/?cc=US&setlang=en-US', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(1200);
    const input = page.locator('#sb_form_q').first();
    if (!(await input.isVisible().catch(() => false))) throw new Error('input_missing');
    await input.fill('antminer s9');
    await input.press('Escape').catch(() => {});
    await page.waitForTimeout(350);

    const icon = page.locator('#search_icon').first();
    const box = await icon.boundingBox().catch(() => null);
    if (box) {
      const before = page.url();
      const nav = page.waitForURL((u) => u.toString() !== before && u.pathname === '/search', { timeout: 7000, waitUntil: 'domcontentloaded' }).catch(() => null);
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2).catch(() => {});
      await nav;
      if (new URL(page.url()).pathname === '/search') out.searchMode = 'physical_icon';
    }

    if (!out.searchMode) {
      const before = page.url();
      const nav = page.waitForURL((u) => u.toString() !== before && u.pathname === '/search', { timeout: 8000, waitUntil: 'domcontentloaded' }).catch(() => null);
      await input.evaluate((el) => {
        const form = el.form || el.closest('form');
        if (form) HTMLFormElement.prototype.submit.call(form);
      }).catch(() => {});
      await nav;
      if (new URL(page.url()).pathname === '/search') out.searchMode = 'native_form';
    }

    if (!out.searchMode) throw new Error('search_submit_failed');
    await page.waitForTimeout(1500);
    out.url = page.url();
    out.resultCount = await page.locator('li.b_algo h2 a[href]').count();

    for (let i = 0; i < 4; i += 1) {
      await page.evaluate(() => window.scrollTo(0, Math.max(document.body.scrollHeight, document.documentElement.scrollHeight))).catch(() => {});
      await page.waitForTimeout(700);
    }

    const body = await page.locator('body').innerText().catch(() => '');
    out.bodyTail = body.replace(/\s+/g, ' ').slice(-3000);

    const nodes = page.locator('a[href], button, [role="button"]');
    const count = Math.min(await nodes.count(), 800);
    for (let i = 0; i < count; i += 1) {
      const node = nodes.nth(i);
      const data = await node.evaluate((el) => ({
        tag: el.tagName,
        id: el.id || null,
        className: typeof el.className === 'string' ? el.className.slice(0, 300) : null,
        href: el.getAttribute('href'),
        title: el.getAttribute('title'),
        ariaLabel: el.getAttribute('aria-label'),
        text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200),
        outerHTML: el.outerHTML.slice(0, 2000),
      })).catch(() => null);
      if (!data) continue;
      const h = JSON.stringify(data).toLowerCase();
      if (h.includes('next') || h.includes('sb_pag') || h.includes('first=') || h.includes('pagination') || h.includes('b_pag')) out.candidates.push(data);
    }
  } catch (error) {
    out.error = error instanceof Error ? error.message : String(error);
  } finally {
    await browser?.close().catch(() => {});
  }
  return out;
}

report.attempts.push(await attempt('firefox', firefox));
if (!report.attempts[0].searchMode) report.attempts.push(await attempt('chromium', chromium));
await fs.writeFile(REPORT_PATH, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
