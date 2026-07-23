import { chromium, devices, firefox, webkit } from "playwright";

const SYNTHETIC_PARAM = process.env.SYNTHETIC_QUERY_PARAM || "synthetic_monitor";
const PERFORMA_ORIGIN = new URL(process.env.PERFORMA_ORIGIN || "https://performa.com").origin;
const BLOCKED_PATH_PARTS = ["/api/", "/admin", "/login", "/logout", "/checkout", "/cart", "/account", "/privacy", "/terms", "/cookie", "/wp-admin"];
const ANALYTICS_HOST_SUFFIXES = ["google-analytics.com", "googletagmanager.com", "doubleclick.net", "clarity.ms", "hotjar.com", "hotjar.io", "facebook.net"];

const randomBetween = (min, max) => Math.floor(min + Math.random() * (max - min + 1));
const pick = (values) => values[randomBetween(0, values.length - 1)];
const hostMatchesSuffix = (hostname, suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`);

function requireHttpUrl(name, value) {
  if (!value) throw new Error(`missing_${name.toLowerCase()}`);
  const parsed = new URL(value);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error(`invalid_${name.toLowerCase()}`);
  return parsed;
}

function addSyntheticMarker(value) {
  const url = new URL(value);
  url.searchParams.set(SYNTHETIC_PARAM, "1");
  return url.href;
}

function normalizeVisitedUrl(value) {
  const url = new URL(value);
  url.hash = "";
  url.searchParams.delete(SYNTHETIC_PARAM);
  return url.href;
}

function hasBlockedPath(url) {
  return BLOCKED_PATH_PARTS.some((part) => url.pathname.toLowerCase().includes(part));
}

const profiles = [
  { id: "chromium-desktop", browser: "chromium", deviceCategory: "desktop", context: { viewport: { width: 1440, height: 900 }, locale: "en-US" } },
  { id: "chromium-android", browser: "chromium", deviceCategory: "mobile", context: { ...devices["Pixel 7"], locale: "en-US" } },
  { id: "firefox-desktop", browser: "firefox", deviceCategory: "desktop", context: { viewport: { width: 1366, height: 768 }, locale: "en-US" } },
  { id: "webkit-iphone", browser: "webkit", deviceCategory: "mobile", context: { ...devices["iPhone 13"], locale: "en-US" } },
];

const browserTypeFor = (name) => name === "firefox" ? firefox : name === "webkit" ? webkit : chromium;

async function installAnalyticsBlock(context) {
  if (String(process.env.BLOCK_ANALYTICS || "false").toLowerCase() !== "true") return false;
  await context.route("**/*", async (route) => {
    try {
      const host = new URL(route.request().url()).hostname.toLowerCase();
      if (ANALYTICS_HOST_SUFFIXES.some((suffix) => hostMatchesSuffix(host, suffix))) return route.abort("blockedbyclient");
    } catch {}
    await route.continue();
  });
  return true;
}

async function collectLinks(page) {
  const links = page.locator("a[href]");
  const count = Math.min(await links.count(), 400);
  const out = [];
  for (let index = 0; index < count; index += 1) {
    const link = links.nth(index);
    if (!(await link.isVisible().catch(() => false))) continue;
    const href = await link.getAttribute("href");
    if (!href) continue;
    try {
      const url = new URL(href, page.url());
      if (!["http:", "https:"].includes(url.protocol)) continue;
      out.push({ index, href: url.href });
    } catch {}
  }
  return out;
}

async function findLinkToOrigin(page, origin) {
  const links = await collectLinks(page);
  return pick(links.filter((link) => {
    try { return new URL(link.href).origin === origin; } catch { return false; }
  })) || null;
}

async function clickLink(context, sourcePage, metadata, expectedOrigin) {
  const link = sourcePage.locator("a[href]").nth(metadata.index);
  const markedHref = addSyntheticMarker(metadata.href);
  await link.scrollIntoViewIfNeeded().catch(() => undefined);
  await link.evaluate((element, href) => {
    element.removeAttribute("target");
    element.setAttribute("href", href);
  }, markedHref);

  const sameTab = sourcePage.waitForURL((url) => {
    try { return new URL(url.toString()).origin === expectedOrigin; } catch { return false; }
  }, { timeout: 45000, waitUntil: "domcontentloaded" }).then(() => sourcePage).catch(() => null);

  const popup = context.waitForEvent("page", { timeout: 45000 }).then(async (page) => {
    await page.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => undefined);
    try { return new URL(page.url()).origin === expectedOrigin ? page : null; } catch { return null; }
  }).catch(() => null);

  await link.click({ timeout: 12000 });
  const destination = await Promise.race([sameTab, popup]);
  if (!destination) throw new Error("link_navigation_timeout");
  return destination;
}

async function readPage(page, deviceCategory, minDwellMs, maxDwellMs) {
  const viewport = page.viewportSize() || { width: 1440, height: 900 };
  const documentHeight = await page.evaluate(() => Math.max(document.body.scrollHeight, document.documentElement.scrollHeight));
  const maxScroll = Math.max(0, documentHeight - viewport.height);
  const target = Math.round(maxScroll * (randomBetween(55, 92) / 100));

  if (deviceCategory === "desktop") {
    await page.mouse.move(randomBetween(80, Math.max(81, viewport.width - 80)), randomBetween(80, Math.max(81, viewport.height - 80)), { steps: randomBetween(8, 18) }).catch(() => undefined);
  }

  let current = await page.evaluate(() => window.scrollY);
  while (current < target - 25) {
    const step = Math.min(target - current, randomBetween(180, Math.max(240, Math.round(viewport.height * 0.55))));
    if (deviceCategory === "desktop") await page.mouse.wheel(0, step);
    else await page.evaluate((dy) => window.scrollBy({ top: dy, behavior: "smooth" }), step);
    await page.waitForTimeout(randomBetween(650, 1600));
    current = await page.evaluate(() => window.scrollY);
  }

  await page.waitForTimeout(randomBetween(minDwellMs, maxDwellMs));
}

async function browsePerforma(context, page, profile) {
  const desiredPages = randomBetween(4, 7);
  const visited = new Set();
  let pagesVisited = 0;

  for (let i = 0; i < desiredPages; i += 1) {
    visited.add(normalizeVisitedUrl(page.url()));
    const candidates = (await collectLinks(page)).filter((link) => {
      try {
        const url = new URL(link.href);
        url.hash = "";
        return url.origin === PERFORMA_ORIGIN && !visited.has(normalizeVisitedUrl(url.href)) && !hasBlockedPath(url);
      } catch { return false; }
    });

    await readPage(page, profile.deviceCategory, 6000, 15000);
    pagesVisited += 1;
    if (i === desiredPages - 1 || candidates.length === 0) break;

    page = await clickLink(context, page, pick(candidates), PERFORMA_ORIGIN);
    await page.waitForTimeout(randomBetween(1200, 2600));
  }

  return { page, pagesVisited };
}

const sourceValues = [process.env.SOURCE_URL_1, process.env.SOURCE_URL_2, process.env.SOURCE_URL_3].filter(Boolean);
if (sourceValues.length === 0) throw new Error("missing_source_urls");

const sourceUrl = requireHttpUrl("SOURCE_URL", pick(sourceValues));
const targetUrl = requireHttpUrl("TARGET_URL", process.env.TARGET_URL);
const profile = pick(profiles);
const startedAt = Date.now();
let browser;

try {
  browser = await browserTypeFor(profile.browser).launch({ headless: false });
  const context = await browser.newContext(profile.context);
  const analyticsBlocked = await installAnalyticsBlock(context);
  let page = await context.newPage();

  await page.goto(sourceUrl.href, { waitUntil: "domcontentloaded", timeout: 40000 });
  await readPage(page, profile.deviceCategory, 1500, 3500);

  const targetLink = await findLinkToOrigin(page, targetUrl.origin);
  if (!targetLink) throw new Error("target_link_not_found");
  page = await clickLink(context, page, targetLink, targetUrl.origin);
  await readPage(page, profile.deviceCategory, 1800, 4500);

  const targetHome = addSyntheticMarker(new URL("/", targetUrl.origin).href);
  await page.goto(targetHome, { waitUntil: "domcontentloaded", timeout: 40000 });
  await readPage(page, profile.deviceCategory, 1800, 4500);

  const performaLink = await findLinkToOrigin(page, PERFORMA_ORIGIN);
  if (!performaLink) throw new Error("performa_link_not_found");
  page = await clickLink(context, page, performaLink, PERFORMA_ORIGIN);

  const result = await browsePerforma(context, page, profile);
  console.log(JSON.stringify({
    status: "success",
    synthetic: true,
    analyticsBlocked,
    profile: profile.id,
    performaPagesVisited: result.pagesVisited,
    durationMs: Date.now() - startedAt,
  }));
} finally {
  await browser?.close().catch(() => undefined);
}
