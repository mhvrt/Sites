import fs from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(here, 'run-bing-antminer-referral-v8.mjs');
const generatedPath = path.join(here, '.run-bing-antminer-referral-v10.generated.mjs');
let source = await fs.readFile(sourcePath, 'utf8');

// Bing target popup can initially remain on Bing before the ck/a redirect finishes.
source = source.replace(
`  if (popup) {\n    await popup.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {}); await popup.waitForTimeout(600).catch(() => {});\n    attempt.popupOpened = true; attempt.popupUrl = popup.url(); if (isTarget(popup.url())) dest = popup;\n  }`,
`  if (popup) {\n    await popup.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});\n    await popup.waitForURL((u) => isTarget(u.toString()), { timeout: 18000, waitUntil: 'domcontentloaded' }).catch(() => {});\n    await popup.waitForTimeout(500).catch(() => {});\n    attempt.popupOpened = true; attempt.popupUrl = popup.url(); if (isTarget(popup.url())) dest = popup;\n  }`,
);

// Internal article popups get the same redirect grace period.
source = source.replace(
`  if (popup) {\n    await popup.waitForLoadState('domcontentloaded', { timeout: 12000 }).catch(() => {}); await popup.waitForTimeout(450).catch(() => {});\n    if (isLeafArticle(popup.url()) && popup.url() !== before) return popup;\n    await popup.close().catch(() => {});\n  }`,
`  if (popup) {\n    await popup.waitForLoadState('domcontentloaded', { timeout: 12000 }).catch(() => {});\n    await popup.waitForURL((u) => { const x = new URL(u.toString()); x.hash = ''; return isLeafArticle(x.toString()) && x.toString() !== before; }, { timeout: 16000, waitUntil: 'domcontentloaded' }).catch(() => {});\n    await popup.waitForTimeout(400).catch(() => {});\n    const px = new URL(popup.url()); px.hash = '';\n    if (isLeafArticle(px.toString()) && px.toString() !== before) return popup;\n    await popup.close().catch(() => {});\n  }`,
);

// Canonicalize candidate article URLs: fragments are not new pages.
source = source.replace(
`    try { absolute = new URL(href, page.url()).toString(); } catch { continue; }`,
`    try { const x = new URL(href, page.url()); x.hash = ''; absolute = x.toString(); } catch { continue; }`,
);
source = source.replace(
`    let absolute; try { absolute = new URL((await a.getAttribute('href')) || '', page.url()).toString(); } catch { continue; }`,
`    let absolute; try { const x = new URL((await a.getAttribute('href')) || '', page.url()); x.hash = ''; absolute = x.toString(); } catch { continue; }`,
);

// Compare internal navigation by canonical URL, not fragment changes.
source = source.replace(
`  const before = page.url(); await link.scrollIntoViewIfNeeded().catch(() => {});`,
`  const bx = new URL(page.url()); bx.hash = ''; const before = bx.toString(); await link.scrollIntoViewIfNeeded().catch(() => {});`,
);
source = source.replace(
`  const navP = page.waitForURL((u) => isLeafArticle(u.toString()) && u.toString() !== before, { timeout: 14000, waitUntil: 'domcontentloaded' }).catch(() => null);`,
`  const navP = page.waitForURL((u) => { const x = new URL(u.toString()); x.hash = ''; return isLeafArticle(x.toString()) && x.toString() !== before; }, { timeout: 14000, waitUntil: 'domcontentloaded' }).catch(() => null);`,
);
source = source.replace(
`  if (isLeafArticle(page.url()) && page.url() !== before) return page;`,
`  { const x = new URL(page.url()); x.hash = ''; if (isLeafArticle(x.toString()) && x.toString() !== before) return page; }`,
);

// Store canonical paths in the route so #1/#2 cannot inflate the count.
source = source.replace(
`  let page = startPage; report.emcdRoute = [page.url()]; report.internalClicks = []; const visited = new Set(report.emcdRoute);`,
`  let page = startPage; const sx = new URL(page.url()); sx.hash = ''; report.emcdRoute = [sx.toString()]; report.internalClicks = []; const visited = new Set(report.emcdRoute);`,
);
source = source.replace(
`      const landed = next.url(); report.internalClicks.push({ from, intended: d.absolute, text: d.text, success: true, landed });`,
`      const lx = new URL(next.url()); lx.hash = ''; const landed = lx.toString(); report.internalClicks.push({ from, intended: d.absolute, text: d.text, success: true, landed });`,
);
source = source.replace(
`  await human(page, 800, 1300); report.emcdPagesVisited = report.emcdRoute.length; report.finalUrl = page.url(); report.internalWalkConfirmed = report.emcdPagesVisited >= REQUIRED_PAGES;`,
`  await human(page, 800, 1300); report.emcdPagesVisited = report.emcdRoute.length; const fx = new URL(page.url()); fx.hash = ''; report.finalUrl = fx.toString(); report.internalWalkConfirmed = report.emcdPagesVisited >= REQUIRED_PAGES && new Set(report.emcdRoute.map((u) => new URL(u).pathname)).size >= REQUIRED_PAGES;`,
);

await fs.writeFile(generatedPath, source);
await import(pathToFileURL(generatedPath).href + `?v=${Date.now()}`);
