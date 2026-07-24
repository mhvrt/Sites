import { chromium } from "playwright";

const feeder = process.env.FEEDER_URL;
if (!feeder) throw new Error("missing_FEEDER_URL");

const normalizeHost = (host) => String(host || "").toLowerCase().replace(/^www\./, "");
const isPerformaHost = (host) => normalizeHost(host) === "performa.com";
const result = {
  feeder,
  homeLoaded: false,
  visiblePerformaLinks: [],
  exactPerformaOriginLinks: 0,
  reachedPerforma: false,
  finalUrl: null,
  documentReferrer: null,
  gaRequests: [],
  error: null,
};

let browser;
try {
  browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: "en-US",
  });

  // Match the production QA routing behavior: mark only first-party feeder/Performa requests.
  const feederOrigin = new URL(feeder).origin;
  await context.route("**/*", async (route) => {
    const req = route.request();
    try {
      const u = new URL(req.url());
      if (u.origin === feederOrigin || isPerformaHost(u.hostname)) {
        return route.continue({
          headers: {
            ...req.headers(),
            "X-Synthetic-Monitor": "1",
          },
        });
      }
    } catch {}
    await route.continue();
  });

  const page = await context.newPage();
  page.on("request", (request) => {
    try {
      const u = new URL(request.url());
      if (u.hostname.includes("google-analytics.com") || u.hostname.includes("googletagmanager.com")) {
        if (result.gaRequests.length < 20) {
          result.gaRequests.push({ method: request.method(), url: request.url().slice(0, 260) });
        }
      }
    } catch {}
  });

  await page.goto(feeder, { waitUntil: "domcontentloaded", timeout: 45000 });
  result.homeLoaded = true;
  await page.waitForTimeout(3500);

  const links = page.locator("a[href]");
  const count = Math.min(await links.count(), 500);
  for (let i = 0; i < count; i += 1) {
    const link = links.nth(i);
    if (!(await link.isVisible().catch(() => false))) continue;
    const href = await link.getAttribute("href");
    if (!href) continue;
    try {
      const u = new URL(href, page.url());
      if (!isPerformaHost(u.hostname)) continue;
      const text = String(await link.innerText().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 120);
      result.visiblePerformaLinks.push({ index: i, href: u.href, origin: u.origin, text });
      if (u.origin === "https://performa.com") result.exactPerformaOriginLinks += 1;
    } catch {}
  }

  if (!result.visiblePerformaLinks.length) {
    throw new Error("no_visible_performa_link_on_homepage");
  }

  const chosen = result.visiblePerformaLinks[0];
  const link = links.nth(chosen.index);
  await link.scrollIntoViewIfNeeded().catch(() => undefined);
  await link.evaluate((element) => element.removeAttribute("target"));

  const navigation = page.waitForURL((url) => {
    try { return isPerformaHost(new URL(url.toString()).hostname); } catch { return false; }
  }, { timeout: 45000, waitUntil: "domcontentloaded" });

  await link.click({ timeout: 15000 });
  await navigation;
  result.reachedPerforma = true;
  result.finalUrl = page.url();
  await page.waitForTimeout(8000);
  result.documentReferrer = await page.evaluate(() => document.referrer).catch(() => null);
} catch (error) {
  result.error = error?.message || String(error);
} finally {
  await browser?.close().catch(() => undefined);
}

console.log(JSON.stringify(result, null, 2));
