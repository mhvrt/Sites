import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const REPORT_PATH = process.env.REPORT_PATH || path.join(os.tmpdir(), 'bing-home-controls.json');
const report = { url: null, title: null, input: null, form: null, controls: [], error: null };
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ locale: 'en-US', viewport: { width: 1440, height: 900 } });
  await page.goto('https://www.bing.com/?cc=US&setlang=en-US', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(2000);
  report.url = page.url();
  report.title = await page.title();

  const input = page.locator('#sb_form_q, textarea[name="q"], input[name="q"], input[type="search"]').first();
  if (!(await input.isVisible().catch(() => false))) throw new Error('search_input_not_visible');
  await input.click();
  await input.fill('antminer s9');
  await page.waitForTimeout(1000);

  report.input = await input.evaluate((el) => ({
    tag: el.tagName,
    id: el.id,
    name: el.getAttribute('name'),
    type: el.getAttribute('type'),
    value: el.value,
    outerHTML: el.outerHTML.slice(0, 2000),
  }));

  report.form = await input.evaluate((el) => {
    const form = el.form || el.closest('form');
    if (!form) return null;
    return {
      id: form.id,
      action: form.getAttribute('action'),
      method: form.getAttribute('method'),
      outerHTML: form.outerHTML.slice(0, 12000),
    };
  });

  const selectors = 'button, input[type="submit"], input[type="button"], [role="button"], label, svg, a';
  const nodes = page.locator(selectors);
  const count = Math.min(await nodes.count(), 400);
  for (let i = 0; i < count; i += 1) {
    const node = nodes.nth(i);
    if (!(await node.isVisible().catch(() => false))) continue;
    const data = await node.evaluate((el) => ({
      tag: el.tagName,
      id: el.id || null,
      type: el.getAttribute('type'),
      role: el.getAttribute('role'),
      ariaLabel: el.getAttribute('aria-label'),
      title: el.getAttribute('title'),
      text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160),
      className: typeof el.className === 'string' ? el.className.slice(0, 240) : null,
      outerHTML: el.outerHTML.slice(0, 1200),
    })).catch(() => null);
    if (!data) continue;
    const haystack = JSON.stringify(data).toLowerCase();
    if (haystack.includes('search') || haystack.includes('sb_form') || haystack.includes('submit')) {
      report.controls.push(data);
    }
  }
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
} finally {
  await browser?.close().catch(() => undefined);
  await fs.writeFile(REPORT_PATH, JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify({ url: report.url, title: report.title, input: report.input, form: report.form && { id: report.form.id, action: report.form.action, method: report.form.method }, controls: report.controls.map((c) => ({ tag: c.tag, id: c.id, type: c.type, role: c.role, ariaLabel: c.ariaLabel, title: c.title, text: c.text })), error: report.error }));
