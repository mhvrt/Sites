import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium, devices, firefox, webkit } from "playwright";

const PRIVATE_REPORT_PATH =
  process.env.PRIVATE_REPORT_PATH || path.join(os.tmpdir(), "private-report.json");
const PUBLIC_SUMMARY_PATH =
  process.env.PUBLIC_SUMMARY_PATH || path.join(os.tmpdir(), "public-summary.json");

const BLOCKED_PATH_PARTS = [
  "/api/",
  "/admin",
  "/login",
  "/logout",
  "/checkout",
  "/cart",
  "/account",
  "/privacy",
  "/terms",
  "/cookie",
  "/wp-admin",
];

function randomBetween(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

function pick(values) {
  return values[randomBetween(0, values.length - 1)];
}

function requireHttpUrl(name, value) {
  if (!value) throw new Error(`missing_${name.toLowerCase()}`);
  const parsed = new URL(value);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`invalid_${name.toLowerCase()}`);
  }
  return parsed;
}

function weightedPick(items) {
  const total = items.reduce((sum, item) => sum + item.weight, 0);
  let cursor = Math.random() * total;
  for (const item of items) {
    cursor -= item.weight;
    if (cursor <= 0) return item;
  }
  return items[0];
}

const profiles = [
  {
    id: "chromium-desktop",
    browser: "chromium",
    deviceCategory: "desktop",
    weight: 40,
    context: {
      viewport: pick([
        { width: 1366, height: 768 },
        { width: 1440, height: 900 },
        { width: 1536, height: 864 },
        { width: 1920, height: 1080 },
      ]),
      locale: "en-US",
    },
  },
  {
    id: "chromium-android",
    browser: "chromium",
    deviceCategory: "mobile",
    weight: 25,
    context: { ...devices["Pixel 7"], locale: "en-US" },
  },
  {
    id: "firefox-desktop",
    browser: "firefox",
    deviceCategory: "desktop",
    weight: 20,
    context: {
      viewport: pick([
        { width: 1366, height: 768 },
        { width: 1440, height: 900 },
        { width: 1536, height: 864 },
      ]),
      locale: "en-US",
    },
  },
  {
    id: "webkit-iphone",
    browser: "webkit",
    deviceCategory: "mobile",
    weight: 15,
    context: { ...devices["iPhone 13"], locale: "en-US" },
  },
];

function browserTypeFor(name) {
  if (name === "firefox") return firefox;
  if (name === "webkit") return webkit;
  return chromium;
}

async function capturePublicIp() {
  try {
    const response = await fetch("https://www.cloudflare.com/cdn-cgi/trace", {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const text = await response.text();
    const line = text.split("\n").find((entry) => entry.startsWith("ip="));
    return line ? line.slice(3).trim() : null;
  } catch {
    return null;
  }
}

async function findTargetLink(page, targetOrigin) {
  const links = page.locator("a[href]");
  const count = Math.min(await links.count(), 300);
  const candidates = [];

  for (let index = 0; index < count; index += 1) {
    const link = links.nth(index);
    if (!(await link.isVisible().catch(() => false))) continue;
    const href = await link.getAttribute("href");
    if (!href) continue;

    try {
      const resolved = new URL(href, page.url());
      if (resolved.origin === targetOrigin) {
        candidates.push({ index, href: resolved.href });
      }
    } catch {}
  }

  return candidates.length ? pick(candidates) : null;
}

async function readPage(page) {
  const startedAt = Date.now();
  const viewport = page.viewportSize() || { width: 1440, height: 900 };
  const pageHeight = await page.evaluate(() =>
    Math.max(document.body.scrollHeight, document.documentElement.scrollHeight),
  );
  const maxScroll = Math.max(0, pageHeight - viewport.height);
  const checkpoints = randomBetween(3, 6);
  const finalDepth = randomBetween(55, 92) / 100;
  let previousY = 0;
  let maxDepth = 0;

  await page.mouse.move(
    randomBetween(70, Math.max(71, viewport.width - 70)),
    randomBetween(80, Math.max(81, viewport.height - 80)),
    { steps: randomBetween(8, 20) },
  );
  await page.waitForTimeout(randomBetween(1_200, 3_200));

  for (let index = 1; index <= checkpoints; index += 1) {
    const depth = Math.min(finalDepth, (index / checkpoints) * finalDepth);
    const targetY = Math.round(maxScroll * depth);
    await page.mouse.wheel(0, Math.max(100, targetY - previousY));
    previousY = targetY;
    maxDepth = Math.max(maxDepth, depth);
    await page.waitForTimeout(randomBetween(1_200, 3_800));

    if (Math.random() < 0.18 && previousY > 250) {
      await page.mouse.wheel(0, -randomBetween(100, 320));
      await page.waitForTimeout(randomBetween(700, 1_800));
    }
  }

  return {
    dwellMs: Date.now() - startedAt,
    maxScrollPercent: Math.round(maxDepth * 100),
  };
}

async function collectInternalLinks(page, targetOrigin, visited) {
  const links = page.locator("a[href]");
  const count = Math.min(await links.count(), 260);
  const candidates = [];

  for (let index = 0; index < count; index += 1) {
    const link = links.nth(index);
    if (!(await link.isVisible().catch(() => false))) continue;
    const href = await link.getAttribute("href");
    if (!href || href.startsWith("#")) continue;

    try {
      const resolved = new URL(href, page.url());
      resolved.hash = "";
      if (resolved.origin !== targetOrigin || visited.has(resolved.href)) continue;
      if (BLOCKED_PATH_PARTS.some((part) => resolved.pathname.toLowerCase().includes(part))) {
        continue;
      }
      candidates.push({ index, href: resolved.href });
    } catch {}
  }

  return candidates;
}

async function clickIntoTarget(context, sourcePage, targetLink, targetOrigin) {
  const link = sourcePage.locator("a[href]").nth(targetLink.index);
  await link.scrollIntoViewIfNeeded().catch(() => undefined);
  await link.evaluate((element) => element.removeAttribute("target")).catch(() => undefined);

  const sameTabNavigation = sourcePage
    .waitForURL(
      (nextUrl) => {
        try {
          return new URL(nextUrl.toString()).origin === targetOrigin;
        } catch {
          return false;
        }
      },
      { timeout: 45_000, waitUntil: "domcontentloaded" },
    )
    .then(() => ({ page: sourcePage, mode: "same-tab" }))
    .catch(() => null);

  const popupNavigation = context
    .waitForEvent("page", { timeout: 45_000 })
    .then(async (popup) => {
      await popup.waitForLoadState("domcontentloaded", { timeout: 20_000 }).catch(() => undefined);
      if (new URL(popup.url()).origin !== targetOrigin) return null;
      return { page: popup, mode: "popup" };
    })
    .catch(() => null);

  await link.click({ timeout: 12_000 });
  const destination = await Promise.race([sameTabNavigation, popupNavigation]);
  if (!destination) throw new Error("target_navigation_timeout");

  await destination.page
    .waitForLoadState("domcontentloaded", { timeout: 15_000 })
    .catch(() => undefined);
  return destination;
}

async function exploreTarget(page, targetOrigin) {
  const desiredPages = randomBetween(2, 4);
  const visited = new Set();
  const routeHistory = [];

  for (let pageNumber = 0; pageNumber < desiredPages; pageNumber += 1) {
    const currentUrl = new URL(page.url());
    currentUrl.hash = "";
    visited.add(currentUrl.href);

    const reading = await readPage(page);
    routeHistory.push({
      sequence: routeHistory.length + 1,
      action: pageNumber === 0 ? "external-entry" : "internal-click",
      url: page.url(),
      title: await page.title(),
      documentReferrer: await page.evaluate(() => document.referrer),
      dwellMs: reading.dwellMs,
      maxScrollPercent: reading.maxScrollPercent,
    });

    if (pageNumber >= desiredPages - 1) break;
    const candidates = await collectInternalLinks(page, targetOrigin, visited);
    if (!candidates.length) break;

    const selected = pick(candidates);
    const link = page.locator("a[href]").nth(selected.index);
    await link.scrollIntoViewIfNeeded().catch(() => undefined);
    await link.evaluate((element) => element.removeAttribute("target")).catch(() => undefined);

    const previousUrl = page.url();
    try {
      await Promise.all([
        page.waitForURL(
          (nextUrl) => {
            try {
              const parsed = new URL(nextUrl.toString());
              return parsed.origin === targetOrigin && parsed.href !== previousUrl;
            } catch {
              return false;
            }
          },
          { timeout: 25_000, waitUntil: "domcontentloaded" },
        ),
        link.click({ timeout: 10_000 }),
      ]);
      await page.waitForTimeout(randomBetween(1_300, 3_200));
    } catch {
      break;
    }
  }

  return {
    routeHistory,
    pagesVisited: routeHistory.length,
    totalDwellMs: routeHistory.reduce((sum, item) => sum + item.dwellMs, 0),
  };
}

const testId = crypto.randomUUID();
const startedAt = Date.now();
const profile = weightedPick(profiles);
const sourceValues = [
  process.env.SOURCE_URL_1,
  process.env.SOURCE_URL_2,
  process.env.SOURCE_URL_3,
].filter(Boolean);

let browser;
let privateReport = {
  ok: false,
  testId,
  workflowRunId: process.env.GITHUB_RUN_ID || null,
  recordedAt: new Date().toISOString(),
  profileId: profile.id,
  browser: profile.browser,
  deviceCategory: profile.deviceCategory,
};
let publicSummary = {
  status: "failed",
  profile: profile.id,
  browser: profile.browser,
  deviceCategory: profile.deviceCategory,
  pagesVisited: 0,
  durationMs: 0,
  errorCategory: "unknown",
};

try {
  const targetUrl = requireHttpUrl("TARGET_URL", process.env.TARGET_URL);
  if (!sourceValues.length) throw new Error("missing_source_urls");
  const sourceUrl = requireHttpUrl("SOURCE_URL", pick(sourceValues));

  privateReport = {
    ...privateReport,
    sourceUrl: sourceUrl.href,
    targetUrl: targetUrl.href,
  };

  const visitorIp = await capturePublicIp();
  browser = await browserTypeFor(profile.browser).launch({ headless: false });
  const context = await browser.newContext(profile.context);
  let page = await context.newPage();

  await page.goto(sourceUrl.href, { waitUntil: "domcontentloaded", timeout: 40_000 });
  await page.waitForTimeout(randomBetween(1_500, 3_500));

  const targetLink = await findTargetLink(page, targetUrl.origin);
  if (!targetLink) throw new Error("target_link_not_found");

  const sourcePageTitle = await page.title();
  privateReport = { ...privateReport, sourcePageTitle, clickedUrl: targetLink.href };

  const destination = await clickIntoTarget(context, page, targetLink, targetUrl.origin);
  page = destination.page;

  const entryReferrer = await page.evaluate(() => document.referrer);
  const exploration = await exploreTarget(page, targetUrl.origin);
  const durationMs = Date.now() - startedAt;

  privateReport = {
    ...privateReport,
    ok: true,
    navigationMode: destination.mode,
    entryReferrer,
    finalUrl: page.url(),
    finalTitle: await page.title(),
    visitorIp,
    userAgent: await page.evaluate(() => navigator.userAgent),
    pagesVisited: exploration.pagesVisited,
    targetDwellMs: exploration.totalDwellMs,
    durationMs,
    routeHistory: exploration.routeHistory,
  };

  publicSummary = {
    status: "success",
    profile: profile.id,
    browser: profile.browser,
    deviceCategory: profile.deviceCategory,
    pagesVisited: exploration.pagesVisited,
    durationMs,
    errorCategory: null,
  };
} catch (error) {
  const durationMs = Date.now() - startedAt;
  const errorMessage = error instanceof Error ? error.message : String(error);
  privateReport = {
    ...privateReport,
    ok: false,
    durationMs,
    errorMessage,
  };
  publicSummary = {
    ...publicSummary,
    durationMs,
    errorCategory:
      errorMessage.startsWith("missing_") || errorMessage.startsWith("invalid_")
        ? "configuration"
        : errorMessage === "target_link_not_found"
          ? "target-link-not-found"
          : "navigation",
  };
} finally {
  await browser?.close().catch(() => undefined);
  await fs.writeFile(PRIVATE_REPORT_PATH, `${JSON.stringify(privateReport, null, 2)}\n`, {
    mode: 0o600,
  });
  await fs.writeFile(PUBLIC_SUMMARY_PATH, `${JSON.stringify(publicSummary, null, 2)}\n`);
}
