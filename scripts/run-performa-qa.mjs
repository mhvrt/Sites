import { chromium, devices, firefox, webkit } from "playwright";

const PERFORMA_ORIGIN = new URL(process.env.PERFORMA_ORIGIN || "https://performa.com").origin;
const BLOCKED_PATH_PARTS = ["/api/", "/admin", "/login", "/logout", "/checkout", "/cart", "/account", "/privacy", "/terms", "/cookie", "/wp-admin"];
const ANALYTICS_HOST_SUFFIXES = ["google-analytics.com", "googletagmanager.com", "doubleclick.net", "clarity.ms", "hotjar.com", "hotjar.io", "facebook.net"];
const SYNTHETIC_HEADER = {
  "X-Synthetic-Monitor": "1",
};

const randomBetween = (min, max) => Math.floor(min + Math.random() * (max - min + 1));
const pick = (values) => values[randomBetween(0, values.length - 1)];
const chance = (probability) => Math.random() < probability;
const hostMatchesSuffix = (hostname, suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`);

function requireHttpUrl(name, value) {
  if (!value) throw new Error(`missing_${name.toLowerCase()}`);
  const parsed = new URL(value);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error(`invalid_${name.toLowerCase()}`);
  return parsed;
}

function normalizeVisitedUrl(value) {
  const url = new URL(value);
  url.hash = "";
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

async function installRequestRouting(context, allowedOrigins) {
  const allowed = new Set(allowedOrigins.filter(Boolean));
  const analyticsBlocked = String(process.env.BLOCK_ANALYTICS || "false").toLowerCase() === "true";

  await context.route("**/*", async (route) => {
    const request = route.request();
    try {
      const url = new URL(request.url());
      const host = url.hostname.toLowerCase();

      if (analyticsBlocked && ANALYTICS_HOST_SUFFIXES.some((suffix) => hostMatchesSuffix(host, suffix))) {
        return route.abort("blockedbyclient");
      }

      if (allowed.has(url.origin)) {
        return route.continue({
          headers: {
            ...request.headers(),
            ...SYNTHETIC_HEADER,
          },
        });
      }
    } catch {}

    await route.continue();
  });

  return analyticsBlocked;
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
      const hasImage = await link.locator("img").count().then((value) => value > 0).catch(() => false);
      out.push({ index, href: url.href, hasImage });
    } catch {}
  }

  return out;
}

async function findLinkToOrigin(page, origin, preferImage = false) {
  const matches = (await collectLinks(page)).filter((link) => {
    try { return new URL(link.href).origin === origin; } catch { return false; }
  });
  if (!matches.length) return null;
  if (preferImage) {
    const imageLinks = matches.filter((link) => link.hasImage);
    if (imageLinks.length) return pick(imageLinks);
  }
  return pick(matches);
}

async function clickLink(context, sourcePage, metadata, expectedOrigin) {
  const link = sourcePage.locator("a[href]").nth(metadata.index);
  const destinationHref = metadata.href;
  await link.scrollIntoViewIfNeeded().catch(() => undefined);
  await link.evaluate((element, href) => {
    element.removeAttribute("target");
    element.setAttribute("href", href);
  }, destinationHref);

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
  await destination.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => undefined);
  return destination;
}

async function readPage(page, deviceCategory, minDwellMs = 7000, maxDwellMs = 18000) {
  const viewport = page.viewportSize() || { width: 1440, height: 900 };
  const documentHeight = await page.evaluate(() => Math.max(document.body.scrollHeight, document.documentElement.scrollHeight));
  const maxScroll = Math.max(0, documentHeight - viewport.height);
  const target = Math.round(maxScroll * (randomBetween(45, 96) / 100));

  if (deviceCategory === "desktop") {
    await page.mouse.move(
      randomBetween(80, Math.max(81, viewport.width - 80)),
      randomBetween(80, Math.max(81, viewport.height - 80)),
      { steps: randomBetween(8, 18) },
    ).catch(() => undefined);
  }

  let current = await page.evaluate(() => window.scrollY);
  while (current < target - 25) {
    const step = Math.min(target - current, randomBetween(160, Math.max(240, Math.round(viewport.height * 0.65))));
    if (deviceCategory === "desktop") await page.mouse.wheel(0, step);
    else await page.evaluate((dy) => window.scrollBy({ top: dy, behavior: "smooth" }), step);
    await page.waitForTimeout(randomBetween(550, 1800));
    current = await page.evaluate(() => window.scrollY);
  }

  if (maxScroll > 0 && chance(0.3)) {
    const reverseBy = randomBetween(100, Math.max(140, Math.round(viewport.height * 0.45)));
    if (deviceCategory === "desktop") await page.mouse.wheel(0, -reverseBy).catch(() => undefined);
    else await page.evaluate((dy) => window.scrollBy({ top: -dy, behavior: "smooth" }), reverseBy).catch(() => undefined);
    await page.waitForTimeout(randomBetween(700, 2200));
  }

  await page.waitForTimeout(randomBetween(minDwellMs, maxDwellMs));
}

async function browseSite(context, page, origin, profile, options = {}) {
  const {
    minPages = 6,
    maxPages = 10,
    minDwellMs = 7000,
    maxDwellMs = 18000,
    homeReturnChance = 0.15,
  } = options;

  const desiredPages = randomBetween(minPages, maxPages);
  const visited = new Set();
  let pagesVisited = 0;

  for (let i = 0; i < desiredPages; i += 1) {
    visited.add(normalizeVisitedUrl(page.url()));

    const candidates = (await collectLinks(page)).filter((link) => {
      try {
        const url = new URL(link.href);
        url.hash = "";
        return url.origin === origin && !visited.has(normalizeVisitedUrl(url.href)) && !hasBlockedPath(url);
      } catch { return false; }
    });

    await readPage(page, profile.deviceCategory, minDwellMs, maxDwellMs);
    pagesVisited += 1;

    if (i === desiredPages - 1) break;

    if (i > 1 && chance(homeReturnChance)) {
      const homeUrl = new URL("/", origin).href;
      if (normalizeVisitedUrl(page.url()) !== normalizeVisitedUrl(homeUrl)) {
        await page.goto(homeUrl, { waitUntil: "domcontentloaded", timeout: 40000 }).catch(() => undefined);
        await page.waitForTimeout(randomBetween(1000, 3200));
        continue;
      }
    }

    if (candidates.length === 0) break;

    page = await clickLink(context, page, pick(candidates), origin);
    await page.waitForTimeout(randomBetween(900, 3400));
  }

  return { page, pagesVisited, desiredPages };
}

const feederValues = [
  process.env.FEEDER_URL_1,
  process.env.FEEDER_URL_2,
  process.env.FEEDER_URL_3,
  process.env.FEEDER_URL_4,
].filter(Boolean);

if (feederValues.length === 0) throw new Error("missing_feeder_urls");

const targetUrl = requireHttpUrl("FEEDER_URL", pick(feederValues));
const profile = pick(profiles);
const startedAt = Date.now();
let browser;

try {
  browser = await browserTypeFor(profile.browser).launch({ headless: false });
  const context = await browser.newContext(profile.context);
  const analyticsBlocked = await installRequestRouting(context, [targetUrl.origin, PERFORMA_ORIGIN]);
  let page = await context.newPage();

  const feederPlan = {
    minPages: 6,
    maxPages: 10,
    minDwellMs: 7000,
    maxDwellMs: 19000,
    homeReturnChance: 0.18,
  };

  const performaPlan = {
    minPages: 6,
    maxPages: 11,
    minDwellMs: 8000,
    maxDwellMs: 22000,
    homeReturnChance: 0.12,
  };

  await page.goto(targetUrl.href, { waitUntil: "domcontentloaded", timeout: 40000 });
  const targetResult = await browseSite(context, page, targetUrl.origin, profile, feederPlan);
  page = targetResult.page;

  await page.goto(new URL("/", targetUrl.origin).href, { waitUntil: "domcontentloaded", timeout: 40000 });
  await page.waitForTimeout(randomBetween(1200, 4200));

  const performaLink = await findLinkToOrigin(page, PERFORMA_ORIGIN, true);
  if (!performaLink) throw new Error("performa_link_not_found");

  await readPage(page, profile.deviceCategory, 5000, 12000);
  page = await clickLink(context, page, performaLink, PERFORMA_ORIGIN);
  await page.waitForTimeout(randomBetween(1200, 4000));

  const performaResult = await browseSite(context, page, PERFORMA_ORIGIN, profile, performaPlan);
  page = performaResult.page;

  console.log(JSON.stringify({
    status: "success",
    synthetic: true,
    analyticsBlocked,
    profile: profile.id,
    feederSite: targetUrl.origin,
    feederPagesVisited: targetResult.pagesVisited,
    feederPagesPlanned: targetResult.desiredPages,
    performaPagesVisited: performaResult.pagesVisited,
    performaPagesPlanned: performaResult.desiredPages,
    finalUrl: page.url(),
    durationMs: Date.now() - startedAt,
  }));
} finally {
  await browser?.close().catch(() => undefined);
}
