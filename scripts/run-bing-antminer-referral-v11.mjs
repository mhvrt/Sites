import fs from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(here, 'run-bing-antminer-referral-v5.mjs');
const generatedPath = path.join(here, '.run-bing-antminer-referral-v11.generated.mjs');
let source = await fs.readFile(sourcePath, 'utf8');

// A Bing result may open a new tab that sits on Bing briefly before the ck/a redirect finishes.
source = source.replace(
`  const popup = await popupPromise;\n  if (popup) {\n    await popup.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});\n    await popup.waitForTimeout(700).catch(() => {});\n    attempt.popupOpened = true;\n    attempt.popupUrl = popup.url();\n    if (isTarget(popup.url())) destination = popup;\n  }`,
`  const popup = await popupPromise;\n  if (popup) {\n    await popup.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});\n    await popup.waitForURL((u) => isTarget(u.toString()), { timeout: 18000, waitUntil: 'domcontentloaded' }).catch(() => {});\n    await popup.waitForTimeout(500).catch(() => {});\n    attempt.popupOpened = true;\n    attempt.popupUrl = popup.url();\n    if (isTarget(popup.url())) destination = popup;\n  }`,
);

const verifiedWalk = `async function walkEmcd(page, report) {
  const canonical = (value) => {
    try { const u = new URL(value); u.hash = ''; return u.toString(); } catch { return value; }
  };
  const leafArticle = (value) => {
    try {
      const u = new URL(value);
      const parts = u.pathname.split('/').filter(Boolean);
      return host(u.hostname) === TARGET_HOST && parts[0] === 'articles' && parts.length >= 3 && !/(?:auth|login|dashboard|pool)/i.test(u.pathname);
    } catch { return false; }
  };
  const collect = async (currentPage, visited) => {
    const anchors = currentPage.locator('a[href]');
    const count = Math.min(await anchors.count(), 800);
    const out = [];
    const unique = new Set();
    for (let i = 0; i < count; i += 1) {
      const link = anchors.nth(i);
      if (!(await link.isVisible().catch(() => false))) continue;
      const href = (await link.getAttribute('href')) || '';
      if (!href || /^(?:#|mailto:|tel:|javascript:)/i.test(href)) continue;
      let absolute;
      try { absolute = canonical(new URL(href, currentPage.url()).toString()); } catch { continue; }
      if (!leafArticle(absolute) || visited.has(absolute) || unique.has(absolute)) continue;
      const text = clean(await link.innerText().catch(() => ''));
      if (text.length < 5) continue;
      unique.add(absolute);
      out.push({ absolute, text });
    }
    return out;
  };
  const refind = async (currentPage, descriptor) => {
    const anchors = currentPage.locator('a[href]');
    const count = Math.min(await anchors.count(), 800);
    for (let i = 0; i < count; i += 1) {
      const link = anchors.nth(i);
      if (!(await link.isVisible().catch(() => false))) continue;
      let absolute;
      try { absolute = canonical(new URL((await link.getAttribute('href')) || '', currentPage.url()).toString()); } catch { continue; }
      if (absolute === descriptor.absolute) return link;
    }
    return null;
  };
  const activate = async (currentPage, descriptor) => {
    const link = await refind(currentPage, descriptor);
    if (!link) return null;
    const before = canonical(currentPage.url());
    await link.scrollIntoViewIfNeeded().catch(() => {});
    await link.hover({ timeout: 2500 }).catch(() => {});
    await currentPage.waitForTimeout(rnd(450, 900));
    const popupPromise = currentPage.waitForEvent('popup', { timeout: 5000 }).catch(() => null);
    const navPromise = currentPage.waitForURL((u) => {
      const next = canonical(u.toString());
      return leafArticle(next) && next !== before;
    }, { timeout: 15000, waitUntil: 'domcontentloaded' }).catch(() => null);
    await link.click({ timeout: 10000 }).catch(() => {});
    const popup = await popupPromise;
    if (popup) {
      await popup.waitForLoadState('domcontentloaded', { timeout: 12000 }).catch(() => {});
      await popup.waitForURL((u) => {
        const next = canonical(u.toString());
        return leafArticle(next) && next !== before;
      }, { timeout: 16000, waitUntil: 'domcontentloaded' }).catch(() => {});
      await popup.waitForTimeout(400).catch(() => {});
      if (leafArticle(canonical(popup.url())) && canonical(popup.url()) !== before) return popup;
      await popup.close().catch(() => {});
    }
    await navPromise;
    if (leafArticle(canonical(currentPage.url())) && canonical(currentPage.url()) !== before) return currentPage;
    return null;
  };

  let currentPage = page;
  report.emcdRoute = [canonical(currentPage.url())];
  report.internalClicks = [];
  const visited = new Set(report.emcdRoute);
  const targetTotal = 1 + rnd(3, 5);

  while (report.emcdRoute.length < targetTotal) {
    await moveAround(currentPage, 1500, 2800);
    const options = await collect(currentPage, visited);
    if (!options.length) break;
    let moved = false;
    for (const descriptor of options.slice(0, 12)) {
      const from = canonical(currentPage.url());
      const nextPage = await activate(currentPage, descriptor);
      if (!nextPage) {
        report.internalClicks.push({ from, intended: descriptor.absolute, text: descriptor.text, success: false });
        visited.add(descriptor.absolute);
        continue;
      }
      const landed = canonical(nextPage.url());
      report.internalClicks.push({ from, intended: descriptor.absolute, text: descriptor.text, success: true, landed });
      if (!visited.has(landed)) {
        visited.add(landed);
        report.emcdRoute.push(landed);
      }
      if (nextPage !== currentPage) await currentPage.close().catch(() => {});
      currentPage = nextPage;
      moved = true;
      break;
    }
    if (!moved) break;
  }

  await moveAround(currentPage, 1000, 1800);
  report.emcdPagesVisited = report.emcdRoute.length;
  report.finalUrl = canonical(currentPage.url());
  report.internalWalkConfirmed = report.emcdPagesVisited >= 4 && new Set(report.emcdRoute.map((url) => new URL(url).pathname)).size >= 4;
  return report.internalWalkConfirmed;
}`;

source = source.replace(/async function walkEmcd\(page, report\) \{[\s\S]*?\n\}\n\nconst report = \{/, `${verifiedWalk}\n\nconst report = {`);
source = source.replace(
`    await walkEmcd(destination, report);`,
`    if (!(await walkEmcd(destination, report))) {\n      report.clicked = false;\n      attempt.status = 'clicked_but_internal_walk_short';\n    }`,
);

await fs.writeFile(generatedPath, source);
await import(pathToFileURL(generatedPath).href + `?v=${Date.now()}`);
