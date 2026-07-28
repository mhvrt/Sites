import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { firefox } from 'playwright';

const QUERY = 'antminer s9';
const TARGET_HOST = 'emcd.io';
const TARGET_PATH = '/articles/mining/mining-with-antminer-s9-asic-is-it-still-profitable/';
const TARGET_URL = `https://${TARGET_HOST}${TARGET_PATH}`;
const REPORT_PATH = process.env.REPORT_PATH || path.join(os.tmpdir(), 'bing-v8.json');
const MAX_ATTEMPTS = Math.max(1, Math.min(7, Number(process.env.BING_MAX_ATTEMPTS || 5)));
const REQUIRED_PAGES = Math.max(4, Number(process.env.REQUIRED_EMCD_PAGES || 4));
const rnd = (a, b) => Math.floor(a + Math.random() * (b - a + 1));
const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim();
const normHost = (v) => String(v || '').toLowerCase().replace(/^www\./, '');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
function isTarget(value) {
  try { const u = new URL(value); return normHost(u.hostname) === TARGET_HOST && u.pathname.replace(/\/+$/, '/') === TARGET_PATH; }
  catch { return false; }
}
function isLeafArticle(value) {
  try {
    const u = new URL(value);
    if (normHost(u.hostname) !== TARGET_HOST) return false;
    const parts = u.pathname.split('/').filter(Boolean);
    return parts[0] === 'articles' && parts.length >= 3 && !/(?:auth|login|dashboard|pool)/i.test(u.pathname);
  } catch { return false; }
}
function titleMatches(value) {
  const n = clean(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return n.includes('mining with antminer s9 asic') && n.includes('still profitable');
}
function challenged(text) { return /one last step|solve the challenge|verify you are human|unusual traffic/i.test(text || ''); }

async function blockAnalytics(context) {
  await context.route('**/*', async (route) => {
    try {
      const h = new URL(route.request().url()).hostname.toLowerCase();
      if (['google-analytics.com','googletagmanager.com','doubleclick.net','clarity.ms','hotjar.com','hotjar.io'].some((d) => h.endsWith(d))) return route.abort('blockedbyclient');
    } catch {}
    return route.continue();
  });
}
async function human(page, min = 700, max = 1500) {
  await page.waitForTimeout(rnd(min, max));
  const vp = page.viewportSize() || { width: 1440, height: 900 };
  await page.mouse.move(rnd(120, vp.width - 120), rnd(100, vp.height - 100), { steps: rnd(6, 14) }).catch(() => {});
  if (Math.random() < 0.8) await page.mouse.wheel(0, rnd(140, 450)).catch(() => {});
}

async function search(page, attempt) {
  await page.goto('https://www.bing.com/?cc=US&setlang=en-US', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(rnd(1200, 2100));
  const accept = page.locator('#bnp_btn_accept, button:has-text("Accept all"), button:has-text("Accept")').first();
  if (await accept.isVisible().catch(() => false)) await accept.click({ timeout: 3000 }).catch(() => {});
  if (challenged(await page.locator('body').innerText().catch(() => ''))) { attempt.status = 'challenge_home'; return false; }
  const input = page.locator('#sb_form_q').first();
  if (!(await input.isVisible().catch(() => false))) { attempt.status = 'input_missing'; return false; }
  await input.click(); await input.fill(''); await input.pressSequentially(QUERY, { delay: rnd(65, 115) });
  attempt.typedQuery = await input.inputValue().catch(() => null);
  await input.press('Escape').catch(() => {}); await page.waitForTimeout(rnd(350, 650));
  const icon = page.locator('#search_icon').first();
  const box = await icon.boundingBox().catch(() => null);
  if (box) {
    const before = page.url();
    const nav = page.waitForURL((u) => u.toString() !== before && u.pathname === '/search', { timeout: 8000, waitUntil: 'domcontentloaded' }).catch(() => null);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 }).catch(() => {});
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2).catch(() => {});
    await nav;
    if (new URL(page.url()).pathname === '/search') { attempt.searchMode = 'physical_search_icon_click'; return true; }
  }
  attempt.status = 'search_submit_failed';
  return false;
}

async function targetDescriptor(page) {
  const links = page.locator('a[href]');
  const count = Math.min(await links.count(), 800);
  for (let i = 0; i < count; i += 1) {
    const a = links.nth(i);
    if (!(await a.isVisible().catch(() => false))) continue;
    const raw = (await a.getAttribute('href')) || '';
    const decoded = decodeBing(raw);
    if (!isTarget(decoded)) continue;
    const title = clean(await a.innerText().catch(() => ''));
    if (titleMatches(title)) return { raw, decoded, title };
  }
  return null;
}
async function refindTarget(page, d) {
  const links = page.locator('a[href]');
  const count = Math.min(await links.count(), 800);
  for (let i = 0; i < count; i += 1) {
    const a = links.nth(i);
    if (!(await a.isVisible().catch(() => false))) continue;
    const raw = (await a.getAttribute('href')) || '';
    if (raw !== d.raw) continue;
    if (isTarget(decodeBing(raw)) && titleMatches(await a.innerText().catch(() => ''))) return a;
  }
  return null;
}
async function clickTarget(bing, d, report, attempt) {
  const link = await refindTarget(bing, d); if (!link) return null;
  await link.scrollIntoViewIfNeeded(); await link.hover({ timeout: 3000 }).catch(() => {}); await bing.waitForTimeout(rnd(900, 1700));
  const popupP = bing.waitForEvent('popup', { timeout: 12000 }).catch(() => null);
  const sameP = bing.waitForURL((u) => isTarget(u.toString()), { timeout: 12000, waitUntil: 'domcontentloaded' }).catch(() => null);
  await link.click({ timeout: 12000 });
  let dest = null;
  const popup = await popupP;
  if (popup) {
    await popup.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {}); await popup.waitForTimeout(600).catch(() => {});
    attempt.popupOpened = true; attempt.popupUrl = popup.url(); if (isTarget(popup.url())) dest = popup;
  }
  if (!dest) { await sameP; if (isTarget(bing.url())) dest = bing; }
  if (!dest) return null;
  report.clicked = true; report.successfulAttempt = attempt.number; report.matchedTitle = d.title; report.matchedUrl = d.decoded; report.rawBingHref = d.raw;
  report.referrer = await dest.evaluate(() => document.referrer).catch(() => null); attempt.status = 'clicked_target'; return dest;
}

async function descriptors(page, visited) {
  const links = page.locator('a[href]'); const count = Math.min(await links.count(), 900); const out = []; const unique = new Set();
  for (let i = 0; i < count; i += 1) {
    const a = links.nth(i); if (!(await a.isVisible().catch(() => false))) continue;
    const href = (await a.getAttribute('href')) || ''; let absolute;
    try { absolute = new URL(href, page.url()).toString(); } catch { continue; }
    if (!isLeafArticle(absolute) || visited.has(absolute) || unique.has(absolute)) continue;
    const text = clean(await a.innerText().catch(() => '')); if (text.length < 5) continue;
    unique.add(absolute); out.push({ absolute, text });
  }
  return out;
}
async function refindArticle(page, d) {
  const links = page.locator('a[href]'); const count = Math.min(await links.count(), 900);
  for (let i = 0; i < count; i += 1) {
    const a = links.nth(i); if (!(await a.isVisible().catch(() => false))) continue;
    let absolute; try { absolute = new URL((await a.getAttribute('href')) || '', page.url()).toString(); } catch { continue; }
    if (absolute === d.absolute) return a;
  }
  return null;
}
async function clickArticle(page, d) {
  const link = await refindArticle(page, d); if (!link) return null;
  const before = page.url(); await link.scrollIntoViewIfNeeded().catch(() => {}); await link.hover({ timeout: 2500 }).catch(() => {}); await page.waitForTimeout(rnd(400, 850));
  const popupP = page.waitForEvent('popup', { timeout: 4500 }).catch(() => null);
  const navP = page.waitForURL((u) => isLeafArticle(u.toString()) && u.toString() !== before, { timeout: 14000, waitUntil: 'domcontentloaded' }).catch(() => null);
  await link.click({ timeout: 10000 }).catch(() => {});
  const popup = await popupP;
  if (popup) {
    await popup.waitForLoadState('domcontentloaded', { timeout: 12000 }).catch(() => {}); await popup.waitForTimeout(450).catch(() => {});
    if (isLeafArticle(popup.url()) && popup.url() !== before) return popup;
    await popup.close().catch(() => {});
  }
  await navP;
  if (isLeafArticle(page.url()) && page.url() !== before) return page;
  return null;
}
async function walk(startPage, report) {
  let page = startPage; report.emcdRoute = [page.url()]; report.internalClicks = []; const visited = new Set(report.emcdRoute);
  while (report.emcdRoute.length < REQUIRED_PAGES) {
    await human(page, 1000, 2000); const opts = await descriptors(page, visited); if (!opts.length) break; let moved = false;
    for (const d of opts.slice(0, 12)) {
      const from = page.url(); const next = await clickArticle(page, d);
      if (!next) { report.internalClicks.push({ from, intended: d.absolute, text: d.text, success: false }); visited.add(d.absolute); continue; }
      const landed = next.url(); report.internalClicks.push({ from, intended: d.absolute, text: d.text, success: true, landed });
      if (!visited.has(landed)) { visited.add(landed); report.emcdRoute.push(landed); }
      if (next !== page) await page.close().catch(() => {}); page = next; moved = true; break;
    }
    if (!moved) break;
  }
  await human(page, 800, 1300); report.emcdPagesVisited = report.emcdRoute.length; report.finalUrl = page.url(); report.internalWalkConfirmed = report.emcdPagesVisited >= REQUIRED_PAGES;
  return report.internalWalkConfirmed;
}

const report = { synthetic: true, query: QUERY, targetUrl: TARGET_URL, clicked: false, attempts: [], successfulAttempt: null, matchedTitle: null, matchedUrl: null, rawBingHref: null, referrer: null, finalUrl: null, emcdPagesVisited: 0, emcdRoute: [], internalClicks: [], internalWalkConfirmed: false, error: null };
for (let i = 0; i < MAX_ATTEMPTS && !report.internalWalkConfirmed; i += 1) {
  const attempt = { number: i + 1, browser: 'firefox', typedQuery: null, searchMode: null, popupOpened: false, popupUrl: null, status: 'started', error: null }; report.attempts.push(attempt); let browser;
  try {
    browser = await firefox.launch({ headless: true }); const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 900 } }); await blockAnalytics(context); const bing = await context.newPage();
    if (!(await search(bing, attempt))) continue; await bing.waitForTimeout(rnd(850, 1300));
    if (challenged(await bing.locator('body').innerText().catch(() => ''))) { attempt.status = 'challenge_results'; continue; }
    const d = await targetDescriptor(bing); if (!d) { attempt.status = 'target_not_on_first_page'; continue; }
    const dest = await clickTarget(bing, d, report, attempt); if (!dest) { attempt.status = 'target_click_failed'; continue; }
    if (!(await walk(dest, report))) attempt.status = 'clicked_but_internal_walk_short';
  } catch (e) { attempt.status = 'error'; attempt.error = e instanceof Error ? e.message : String(e); }
  finally { await browser?.close().catch(() => {}); }
  if (!report.internalWalkConfirmed && i < MAX_ATTEMPTS - 1) await sleep(rnd(1500, 2800));
}
if (!report.internalWalkConfirmed) report.error = report.clicked ? 'bing_click_confirmed_but_internal_walk_not_confirmed' : 'bing_click_not_confirmed';
await fs.writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`); console.log(JSON.stringify(report)); if (!report.internalWalkConfirmed) process.exitCode = 1;
