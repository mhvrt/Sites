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

const EXCLUDED_EXTERNAL_HOST_SUFFIXES = [
  "facebook.com",
  "instagram.com",
  "youtube.com",
  "youtu.be",
  "twitter.com",
  "x.com",
  "reddit.com",
  "t.me",
  "telegram.me",
  "discord.com",
  "discord.gg",
  "shopify.com",
];

const ANALYTICS_HOST_SUFFIXES = [
  "google-analytics.com",
  "googletagmanager.com",
  "doubleclick.net",
  "clarity.ms",
  "hotjar.com",
  "hotjar.io",
  "facebook.net",
];

function randomBetween(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

function pick(values) {
  return values[randomBetween(0, values.length - 1)];
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function parseProbability(value, fallback = 0.4) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? clamp(parsed, 0, 1) : fallback;
}

function requireHttpUrl(name, value) {
  if (!value) throw new Error(`missing_${name.toLowerCase()}`);
  const parsed = new URL(value);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`invalid_${name.toLowerCase()}`);
  }
  return parsed;
}

function optionalHttpUrl(name, value) {
  if (!value) return null;
  return requireHttpUrl(name, value);
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

function hostMatchesSuffix(hostname, suffix) {
  return hostname === suffix || hostname.endsWith(`.${suffix}`);
}

function hasBlockedPath(url) {
  const pathname = url.pathname.toLowerCase();
  return BLOCKED_PATH_PARTS.some((part) => pathname.includes(part));
}

function addSyntheticMarker(urlValue) {
  const url = new URL(urlValue);
  url.searchParams.set(process.env.SYNTHETIC_QUERY_PARAM || "synthetic_monitor", "1");
  return url.href;
}

function normalizeVisitedUrl(urlValue) {
  const url = new URL(urlValue);
  url.hash = "";
  url.searchParams.delete(process.env.SYNTHETIC_QUERY_PARAM || "synthetic_monitor");
  return url.href;
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

async function installAnalyticsBlock(context) {
  if (String(process.env.BLOCK_ANALYTICS || "true").toLowerCase() !== "true") return false;

  await context.route("**/*", async (route) => {
    try {
      const hostname = new URL(route.request().url()).hostname.toLowerCase();
      if (ANALYTICS_HOST_SUFFIXES.some((suffix) => hostMatchesSuffix(hostname, suffix))) {
        await route.abort("blockedbyclient");
        return;
      }
    } catch {}
    await route.continue();
  });
  return true;
}

async function linkMetadata(link, index, pageUrl) {
  const href = await link.getAttribute("href");
  if (!href) return null;

  let resolved;
  try {
    resolved = new URL(href, pageUrl);
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(resolved.protocol)) return null;

  const metadata = await link
    .evaluate((element) => {
      const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const imageAlt = element.querySelector("img")?.getAttribute("alt");
      const text = clean(
        element.innerText ||
          element.textContent ||
          element.getAttribute("aria-label") ||
          element.getAttribute("title") ||
          imageAlt,
      );
      const structural = element.closest("article,main,p,section,li,aside,nav,header,footer");
      const contextElement = element.closest("p,li,article,section,div");
      return {
        text,
        structuralTag: structural?.tagName?.toLowerCase() || "unknown",
        context: clean(contextElement?.innerText || "").slice(0, 500),
      };
    })
    .catch(() => ({ text: "", structuralTag: "unknown", context: "" }));

  let score = 0;
  if (metadata.structuralTag === "article") score += 50;
  if (metadata.structuralTag === "main") score += 45;
  if (metadata.structuralTag === "p") score += 35;
  if (metadata.structuralTag === "section") score += 20;
  if (metadata.structuralTag === "li") score += 5;
  if (["footer", "nav", "header", "aside"].includes(metadata.structuralTag)) score -= 100;

  const wordCount = metadata.text.split(/\s+/).filter(Boolean).length;
  if (wordCount >= 2) score += 15;
  if (wordCount >= 3) score += 10;
  if (metadata.text.length >= 8 && metadata.text.length <= 140) score += 10;
  if (metadata.context && metadata.context !== metadata.text) score += 5;

  return {
    index,
    href: resolved.href,
    text: metadata.text,
    context: metadata.context,
    structuralTag: metadata.structuralTag,
    score,
  };
}

async function collectVisibleLinks(page) {
  const links = page.locator("a[href]");
  const count = Math.min(await links.count(), 400);
  const candidates = [];

  for (let index = 0; index < count; index += 1) {
    const link = links.nth(index);
    if (!(await link.isVisible().catch(() => false))) continue;
    const metadata = await linkMetadata(link, index, page.url());
    if (metadata) candidates.push(metadata);
  }
  return candidates;
}

function chooseBest(candidates) {
  if (!candidates.length) return null;
  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  const topScore = sorted[0].score;
  const topCandidates = sorted.filter((candidate) => candidate.score >= topScore - 8);
  return pick(topCandidates);
}

async function findLinkToOrigin(page, targetOrigin) {
  const links = await collectVisibleLinks(page);
  return chooseBest(
    links.filter((candidate) => {
      try {
        return new URL(candidate.href).origin === targetOrigin;
      } catch {
        return false;
      }
    }),
  );
}

async function findHomeLink(page, targetOrigin) {
  const links = await collectVisibleLinks(page);
  return chooseBest(
    links.filter((candidate) => {
      try {
        const url = new URL(candidate.href);
        return url.origin === targetOrigin && url.pathname.replace(/\/+$/, "") === "";
      } catch {
        return false;
      }
    }),
  );
}

async function findSecondaryLink(page, primaryOrigin, configuredSecondaryOrigin) {
  const links = await collectVisibleLinks(page);

  if (configuredSecondaryOrigin) {
    return chooseBest(
      links.filter((candidate) => {
        try {
          return new URL(candidate.href).origin === configuredSecondaryOrigin;
        } catch {
          return false;
        }
      }),
    );
  }

  return chooseBest(
    links.filter((candidate) => {
      try {
        const url = new URL(candidate.href);
        if (url.origin === primaryOrigin) return false;
        if (EXCLUDED_EXTERNAL_HOST_SUFFIXES.some((suffix) => hostMatchesSuffix(url.hostname, suffix))) {
          return false;
        }
        if (["footer", "nav", "header", "aside"].includes(candidate.structuralTag)) return false;
        const wordCount = candidate.text.split(/\s+/).filter(Boolean).length;
        return wordCount >= 2 && candidate.score >= 20;
      } catch {
        return false;
      }
    }),
  );
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

  await page.mouse
    .move(
      randomBetween(70, Math.max(71, viewport.width - 70)),
      randomBetween(80, Math.max(81, viewport.height - 80)),
      { steps: randomBetween(8, 20) },
    )
    .catch(() => undefined);
  await page.waitForTimeout(randomBetween(1_200, 3_200));

  for (let index = 1; index <= checkpoints; index += 1) {
    const depth = Math.min(finalDepth, (index / checkpoints) * finalDepth);
    const targetY = Math.round(maxScroll * depth);
    await page.evaluate((scrollY) => window.scrollTo({ top: scrollY, behavior: "smooth" }), targetY);
    previousY = targetY;
    maxDepth = Math.max(maxDepth, depth);
    await page.waitForTimeout(randomBetween(1_200, 3_800));

    if (Math.random() < 0.18 && previousY > 250) {
      const reverseY = Math.max(0, previousY - randomBetween(100, 320));
      await page.evaluate((scrollY) => window.scrollTo({ top: scrollY, behavior: "smooth" }), reverseY);
      await page.waitForTimeout(randomBetween(700, 1_800));
    }
  }

  return {
    dwellMs: Date.now() - startedAt,
    maxScrollPercent: Math.round(maxDepth * 100),
  };
}

async function collectInternalLinks(page, targetOrigin, visited) {
  const links = await collectVisibleLinks(page);
  return links.filter((candidate) => {
    try {
      const resolved = new URL(candidate.href);
      resolved.hash = "";
      if (resolved.origin !== targetOrigin || visited.has(normalizeVisitedUrl(resolved.href))) return false;
      if (hasBlockedPath(resolved)) return false;
      return true;
    } catch {
      return false;
    }
  });
}

async function clickLink(context, sourcePage, linkMetadataValue, expectedOrigin) {
  const link = sourcePage.locator("a[href]").nth(linkMetadataValue.index);
  const originalHref = linkMetadataValue.href;
  const markedHref = addSyntheticMarker(originalHref);

  await link.scrollIntoViewIfNeeded().catch(() => undefined);
  await link.evaluate((element, href) => {
    element.removeAttribute("target");
    element.setAttribute("href", href);
  }, markedHref);

  const sameTabNavigation = sourcePage
    .waitForURL(
      (nextUrl) => {
        try {
          return new URL(nextUrl.toString()).origin === expectedOrigin;
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
      if (new URL(popup.url()).origin !== expectedOrigin) return null;
      return { page: popup, mode: "popup" };
    })
    .catch(() => null);

  await link.click({ timeout: 12_000 });
  const destination = await Promise.race([sameTabNavigation, popupNavigation]);
  if (!destination) throw new Error("link_navigation_timeout");

  await destination.page
    .waitForLoadState("domcontentloaded", { timeout: 15_000 })
    .catch(() => undefined);

  return {
    ...destination,
    click: {
      text: linkMetadataValue.text,
      context: linkMetadataValue.context,
      structuralTag: linkMetadataValue.structuralTag,
      originalUrl: originalHref,
      navigatedUrl: markedHref,
    },
  };
}

async function exploreSite(context, page, targetOrigin, entryAction) {
  const desiredPages = randomBetween(2, 4);
  const visited = new Set();
  const routeHistory = [];
  let arrival = { action: entryAction, clickedText: null, clickedUrl: null };

  for (let pageNumber = 0; pageNumber < desiredPages; pageNumber += 1) {
    visited.add(normalizeVisitedUrl(page.url()));

    const reading = await readPage(page);
    routeHistory.push({
      sequence: routeHistory.length + 1,
      action: arrival.action,
      clickedText: arrival.clickedText,
      clickedUrl: arrival.clickedUrl,
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
    const previousUrl = page.url();
    try {
      const destination = await clickLink(context, page, selected, targetOrigin);
      page = destination.page;
      if (page.url() === previousUrl) break;
      arrival = {
        action: "internal-click",
        clickedText: destination.click.text,
        clickedUrl: destination.click.originalUrl,
      };
      await page.waitForTimeout(randomBetween(1_300, 3_200));
    } catch {
      break;
    }
  }

  return {
    page,
    routeHistory,
    pagesVisited: routeHistory.length,
    totalDwellMs: routeHistory.reduce((sum, item) => sum + item.dwellMs, 0),
  };
}

async function returnToHome(context, page, primaryOrigin) {
  const homeLink = await findHomeLink(page, primaryOrigin);
  if (homeLink) {
    const destination = await clickLink(context, page, homeLink, primaryOrigin);
    return { page: destination.page, mode: "clicked-home-link", click: destination.click };
  }

  const homeUrl = addSyntheticMarker(new URL("/", primaryOrigin).href);
  await page.goto(homeUrl, { waitUntil: "domcontentloaded", timeout: 40_000 });
  return { page, mode: "direct-navigation", click: null };
}

const testId = crypto.randomUUID();
const startedAt = Date.now();
const profile = weightedPick(profiles);
const sourceValues = [
  process.env.SOURCE_URL_1,
  process.env.SOURCE_URL_2,
  process.env.SOURCE_URL_3,
].filter(Boolean);
const secondaryProbability = parseProbability(process.env.SECONDARY_CONTINUE_PROBABILITY, 0.4);
const secondaryMode = ["random", "force", "skip"].includes(process.env.SECONDARY_MODE)
  ? process.env.SECONDARY_MODE
  : "random";

let browser;
let privateReport = {
  ok: false,
  synthetic: true,
  testId,
  workflowRunId: process.env.GITHUB_RUN_ID || null,
  recordedAt: new Date().toISOString(),
  profileId: profile.id,
  browser: profile.browser,
  deviceCategory: profile.deviceCategory,
  secondaryProbability,
  secondaryMode,
};
let publicSummary = {
  status: "failed",
  profile: profile.id,
  browser: profile.browser,
  deviceCategory: profile.deviceCategory,
  pagesVisited: 0,
  primaryPagesVisited: 0,
  secondarySelected: false,
  secondaryReached: false,
  secondaryPagesVisited: 0,
  durationMs: 0,
  errorCategory: "unknown",
};

try {
  const targetUrl = requireHttpUrl("TARGET_URL", process.env.TARGET_URL);
  const configuredSecondaryUrl = optionalHttpUrl("SECONDARY_ORIGIN", process.env.SECONDARY_ORIGIN);
  if (!sourceValues.length) throw new Error("missing_source_urls");
  const sourceUrl = requireHttpUrl("SOURCE_URL", pick(sourceValues));

  privateReport = {
    ...privateReport,
    sourceUrl: sourceUrl.href,
    targetUrl: targetUrl.href,
    configuredSecondaryOrigin: configuredSecondaryUrl?.origin || null,
  };

  const visitorIp = await capturePublicIp();
  browser = await browserTypeFor(profile.browser).launch({ headless: false });
  const context = await browser.newContext(profile.context);
  const analyticsBlocked = await installAnalyticsBlock(context);
  await context.setExtraHTTPHeaders({ "X-Synthetic-Monitor": "1" });
  let page = await context.newPage();

  await page.goto(sourceUrl.href, { waitUntil: "domcontentloaded", timeout: 40_000 });
  await page.waitForTimeout(randomBetween(1_500, 3_500));

  const targetLink = await findLinkToOrigin(page, targetUrl.origin);
  if (!targetLink) throw new Error("target_link_not_found");

  const sourcePageTitle = await page.title();
  const primaryDestination = await clickLink(context, page, targetLink, targetUrl.origin);
  page = primaryDestination.page;

  const primaryEntryReferrer = await page.evaluate(() => document.referrer);
  const primaryExploration = await exploreSite(context, page, targetUrl.origin, "external-entry");
  page = primaryExploration.page;

  const homeReturn = await returnToHome(context, page, targetUrl.origin);
  page = homeReturn.page;
  await page.waitForTimeout(randomBetween(1_000, 2_500));
  const homeReading = await readPage(page);
  const primaryHomeUrl = page.url();

  const secondarySelected =
    secondaryMode === "force"
      ? true
      : secondaryMode === "skip"
        ? false
        : Math.random() < secondaryProbability;

  let secondary = {
    selected: secondarySelected,
    reached: false,
    origin: null,
    link: null,
    entryReferrer: null,
    pagesVisited: 0,
    totalDwellMs: 0,
    routeHistory: [],
    finalUrl: null,
    finalTitle: null,
  };

  if (secondarySelected) {
    const secondaryLink = await findSecondaryLink(
      page,
      targetUrl.origin,
      configuredSecondaryUrl?.origin || null,
    );
    if (!secondaryLink) throw new Error("secondary_link_not_found");

    const secondaryOrigin = new URL(secondaryLink.href).origin;
    const secondaryDestination = await clickLink(context, page, secondaryLink, secondaryOrigin);
    page = secondaryDestination.page;
    const secondaryEntryReferrer = await page.evaluate(() => document.referrer);
    const secondaryExploration = await exploreSite(context, page, secondaryOrigin, "secondary-entry");
    page = secondaryExploration.page;

    secondary = {
      selected: true,
      reached: true,
      origin: secondaryOrigin,
      link: secondaryDestination.click,
      entryReferrer: secondaryEntryReferrer,
      pagesVisited: secondaryExploration.pagesVisited,
      totalDwellMs: secondaryExploration.totalDwellMs,
      routeHistory: secondaryExploration.routeHistory,
      finalUrl: page.url(),
      finalTitle: await page.title(),
    };
  }

  const durationMs = Date.now() - startedAt;
  const totalPages = primaryExploration.pagesVisited + secondary.pagesVisited;

  privateReport = {
    ...privateReport,
    ok: true,
    analyticsBlocked,
    visitorIp,
    userAgent: await page.evaluate(() => navigator.userAgent),
    sourcePageTitle,
    primary: {
      navigationMode: primaryDestination.mode,
      clickedLink: primaryDestination.click,
      entryReferrer: primaryEntryReferrer,
      pagesVisited: primaryExploration.pagesVisited,
      totalDwellMs: primaryExploration.totalDwellMs,
      routeHistory: primaryExploration.routeHistory,
      returnHomeMode: homeReturn.mode,
      returnHomeClick: homeReturn.click,
      homeUrl: primaryHomeUrl,
      homeReadDwellMs: homeReading.dwellMs,
      homeReadScrollPercent: homeReading.maxScrollPercent,
    },
    secondary,
    pagesVisited: totalPages,
    finalUrl: page.url(),
    finalTitle: await page.title(),
    durationMs,
  };

  publicSummary = {
    status: "success",
    profile: profile.id,
    browser: profile.browser,
    deviceCategory: profile.deviceCategory,
    pagesVisited: totalPages,
    primaryPagesVisited: primaryExploration.pagesVisited,
    secondarySelected,
    secondaryReached: secondary.reached,
    secondaryPagesVisited: secondary.pagesVisited,
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
          : errorMessage === "secondary_link_not_found"
            ? "secondary-link-not-found"
            : "navigation",
  };
} finally {
  await browser?.close().catch(() => undefined);
  await fs.writeFile(PRIVATE_REPORT_PATH, `${JSON.stringify(privateReport, null, 2)}\n`, {
    mode: 0o600,
  });
  await fs.writeFile(PUBLIC_SUMMARY_PATH, `${JSON.stringify(publicSummary, null, 2)}\n`);
}
