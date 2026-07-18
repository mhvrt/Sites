import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { chromium } from "playwright";

const SEARCH_QUERY = String(process.env.SEARCH_QUERY || "").trim();
const TARGET_URL = String(process.env.TARGET_URL || "").trim();
const SECONDARY_ORIGIN = String(process.env.SECONDARY_ORIGIN || "").trim();
const MAX_GOOGLE_PAGES = Math.min(5, Math.max(1, Number(process.env.MAX_GOOGLE_PAGES || 5)));
const SYNTHETIC_QUERY_PARAM = String(process.env.SYNTHETIC_QUERY_PARAM || "synthetic_monitor").trim();
const PRIVATE_REPORT_PATH =
  process.env.PRIVATE_REPORT_PATH || path.join(os.tmpdir(), "google-qa-private-report.json");
const PUBLIC_SUMMARY_PATH =
  process.env.PUBLIC_SUMMARY_PATH || path.join(os.tmpdir(), "google-qa-public-summary.json");

const startedAt = Date.now();
const testId = crypto.randomUUID();

function requireUrl(value, name) {
  try {
    return new URL(value);
  } catch {
    throw new Error(`${name}_invalid`);
  }
}

function sameHostname(left, right) {
  const normalize = (value) => value.replace(/^www\./i, "").toLowerCase();
  return normalize(left) === normalize(right);
}

function addSyntheticMarker(rawUrl) {
  const url = new URL(rawUrl);
  if (SYNTHETIC_QUERY_PARAM) url.searchParams.set(SYNTHETIC_QUERY_PARAM, "1");
  return url.href;
}

function normalizeUrlForVisit(rawUrl) {
  const url = new URL(rawUrl);
  url.hash = "";
  if (SYNTHETIC_QUERY_PARAM) url.searchParams.delete(SYNTHETIC_QUERY_PARAM);
  return url.href;
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function fetchVisitorIp() {
  try {
    const response = await fetch("https://api.ipify.org?format=json", {
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return null;
    return (await response.json())?.ip || null;
  } catch {
    return null;
  }
}

async function detectGoogleBlock(page) {
  const url = page.url();
  const bodyText = await page.locator("body").innerText().catch(() => "");
  const blocked =
    /\/sorry\//i.test(url) ||
    /unusual traffic|our systems have detected|not a robot|captcha/i.test(bodyText);
  if (blocked) throw new Error("google_challenge_detected");
}

async function handleGoogleConsent(page) {
  const candidates = [
    page.getByRole("button", { name: /reject all/i }),
    page.getByRole("button", { name: /accept all/i }),
    page.getByRole("button", { name: /i agree/i }),
  ];
  for (const candidate of candidates) {
    if (await candidate.first().isVisible().catch(() => false)) {
      await candidate.first().click().catch(() => {});
      await page.waitForTimeout(800);
      return;
    }
  }
}

async function readPage(page, targetLocator = null) {
  const dimensions = await page.evaluate(() => ({
    viewportHeight: window.innerHeight,
    documentHeight: Math.max(
      document.body?.scrollHeight || 0,
      document.documentElement?.scrollHeight || 0,
    ),
  }));
  const maxScroll = Math.max(0, dimensions.documentHeight - dimensions.viewportHeight);
  let targetY = maxScroll ? Math.round(maxScroll * (0.35 + Math.random() * 0.35)) : 0;
  let targetLinkY = null;

  if (targetLocator) {
    const box = await targetLocator.boundingBox().catch(() => null);
    const currentScrollY = await page.evaluate(() => window.scrollY).catch(() => 0);
    if (box) {
      targetLinkY = Math.max(0, Math.round(currentScrollY + box.y));
      targetY = Math.max(0, Math.min(maxScroll, Math.round(targetLinkY - dimensions.viewportHeight * 0.55)));
    }
  }

  const steps = Math.max(2, Math.min(7, Math.ceil(targetY / 550)));
  let lastY = 0;
  for (let index = 1; index <= steps; index += 1) {
    const nextY = Math.round((targetY * index) / steps);
    await page.mouse.wheel(0, Math.max(120, nextY - lastY));
    lastY = nextY;
    await page.waitForTimeout(350 + Math.floor(Math.random() * 450));
  }

  const currentY = await page.evaluate(() => window.scrollY);
  const maxScrollPercent = maxScroll ? Math.round((currentY / maxScroll) * 100) : 0;
  const dwellMs = 2_500 + Math.floor(Math.random() * 3_500);
  await page.waitForTimeout(dwellMs);

  return {
    dwellMs,
    scrollMethod: "mouse-wheel",
    maxScrollPercent,
    targetScrollY: targetY,
    targetLinkY,
  };
}

async function findGoogleResult(page, targetOrigin) {
  const links = page.locator("a:has(h3)");
  const count = await links.count();
  let organicPosition = 0;

  for (let index = 0; index < count; index += 1) {
    const link = links.nth(index);
    if (!(await link.isVisible().catch(() => false))) continue;
    const href = await link.getAttribute("href");
    if (!href) continue;

    let url;
    try {
      url = new URL(href, page.url());
      if (url.hostname.endsWith("google.com") && url.pathname === "/url") {
        const redirected = url.searchParams.get("q") || url.searchParams.get("url");
        if (redirected) url = new URL(redirected);
      }
    } catch {
      continue;
    }

    if (/google\./i.test(url.hostname)) continue;
    organicPosition += 1;

    if (sameHostname(url.hostname, targetOrigin.hostname)) {
      return {
        locator: link,
        position: organicPosition,
        text: (await link.innerText().catch(() => "")).trim(),
        originalUrl: url.href,
      };
    }
  }

  return null;
}

async function runGoogleSearch(page, targetOrigin) {
  await page.goto("https://www.google.com/ncr", {
    waitUntil: "domcontentloaded",
    timeout: 45_000,
  });
  await handleGoogleConsent(page);
  await detectGoogleBlock(page);

  const searchBox = page.locator('textarea[name="q"], input[name="q"]').first();
  await searchBox.waitFor({ state: "visible", timeout: 15_000 });
  await searchBox.fill(SEARCH_QUERY);
  await searchBox.press("Enter");
  await page.waitForLoadState("domcontentloaded", { timeout: 45_000 });

  for (let pageNumber = 1; pageNumber <= MAX_GOOGLE_PAGES; pageNumber += 1) {
    if (pageNumber > 1) {
      const searchUrl = new URL("https://www.google.com/search");
      searchUrl.searchParams.set("q", SEARCH_QUERY);
      searchUrl.searchParams.set("start", String((pageNumber - 1) * 10));
      searchUrl.searchParams.set("num", "10");
      searchUrl.searchParams.set("hl", "en");
      searchUrl.searchParams.set("pws", "0");
      await page.goto(searchUrl.href, {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
      });
    }

    await handleGoogleConsent(page);
    await detectGoogleBlock(page);
    await page.waitForTimeout(1_200);

    const result = await findGoogleResult(page, targetOrigin);
    if (!result) continue;

    await readPage(page, result.locator);
    await result.locator.evaluate((element) => {
      element.removeAttribute("target");
    });
    await result.locator.click({ timeout: 15_000 });
    await page.waitForLoadState("domcontentloaded", { timeout: 45_000 });

    if (!sameHostname(new URL(page.url()).hostname, targetOrigin.hostname)) {
      throw new Error("google_result_navigation_mismatch");
    }

    return {
      pageNumber,
      position: result.position,
      text: result.text,
      clickedUrl: result.originalUrl,
      landingUrl: page.url(),
      entryReferrer: await page.evaluate(() => document.referrer),
    };
  }

  throw new Error("google_result_not_found");
}

async function findContextualLink(page, destinationOrigin) {
  const candidates = page.locator("main a[href], article a[href], body a[href]");
  const count = await candidates.count();
  const matches = [];

  for (let index = 0; index < count; index += 1) {
    const link = candidates.nth(index);
    if (!(await link.isVisible().catch(() => false))) continue;
    const href = await link.getAttribute("href");
    if (!href) continue;

    let url;
    try {
      url = new URL(href, page.url());
    } catch {
      continue;
    }

    if (!sameHostname(url.hostname, destinationOrigin.hostname)) continue;
    const text = (await link.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
    if (text.length < 2) continue;

    const metadata = await link.evaluate((element) => {
      const excluded = Boolean(element.closest("nav, footer, header, aside"));
      const context = element.closest("p, li, section, div")?.innerText || "";
      return {
        excluded,
        context: context.replace(/\s+/g, " ").trim().slice(0, 500),
        structuralTag: element.closest("p, li, section, div")?.tagName?.toLowerCase() || "a",
      };
    });
    if (metadata.excluded) continue;

    matches.push({
      locator: link,
      text,
      context: metadata.context,
      structuralTag: metadata.structuralTag,
      originalUrl: url.href,
      score: text.length + Math.min(metadata.context.length, 300),
    });
  }

  matches.sort((left, right) => right.score - left.score);
  return matches[0] || null;
}

async function clickContextualLink(page, link) {
  await readPage(page, link.locator);
  const navigatedUrl = addSyntheticMarker(link.originalUrl);
  await link.locator.evaluate(
    (element, nextUrl) => {
      element.href = nextUrl;
      element.removeAttribute("target");
    },
    navigatedUrl,
  );

  await link.locator.click({ timeout: 15_000 });
  await page.waitForLoadState("domcontentloaded", { timeout: 45_000 });

  return {
    text: link.text,
    context: link.context,
    structuralTag: link.structuralTag,
    originalUrl: link.originalUrl,
    navigatedUrl,
  };
}

function isSafeInternalUrl(url, origin) {
  if (url.origin !== origin.origin) return false;
  const blocked = /\/(?:wp-admin|admin|login|logout|register|checkout|cart|account|privacy|terms|cookie)(?:\/|$)/i;
  return !blocked.test(url.pathname);
}

async function findInternalLink(page, origin, visited) {
  const links = page.locator("main a[href], article a[href], body a[href]");
  const count = await links.count();
  const candidates = [];

  for (let index = 0; index < count; index += 1) {
    const link = links.nth(index);
    if (!(await link.isVisible().catch(() => false))) continue;
    const href = await link.getAttribute("href");
    if (!href) continue;

    let url;
    try {
      url = new URL(href, page.url());
    } catch {
      continue;
    }

    url.hash = "";
    if (!isSafeInternalUrl(url, origin)) continue;
    if (visited.has(normalizeUrlForVisit(url.href))) continue;
    const text = (await link.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
    if (text.length < 2) continue;

    const excluded = await link.evaluate((element) => Boolean(element.closest("footer, aside")));
    if (excluded) continue;

    candidates.push({ locator: link, url, text });
  }

  if (!candidates.length) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

async function exploreDestination(page, origin, minPages = 2, maxPages = 4) {
  const targetPages = minPages + Math.floor(Math.random() * (maxPages - minPages + 1));
  const visited = new Set([normalizeUrlForVisit(page.url())]);
  const routeHistory = [];

  routeHistory.push({
    sequence: 1,
    action: "destination-entry",
    url: page.url(),
    title: await page.title(),
    documentReferrer: await page.evaluate(() => document.referrer),
    ...(await readPage(page)),
  });

  while (routeHistory.length < targetPages) {
    const next = await findInternalLink(page, origin, visited);
    if (!next) break;

    const markedUrl = addSyntheticMarker(next.url.href);
    await next.locator.evaluate(
      (element, nextUrl) => {
        element.href = nextUrl;
        element.removeAttribute("target");
      },
      markedUrl,
    );

    await next.locator.click({ timeout: 15_000 });
    await page.waitForLoadState("domcontentloaded", { timeout: 45_000 });

    visited.add(normalizeUrlForVisit(page.url()));
    routeHistory.push({
      sequence: routeHistory.length + 1,
      action: "internal-click",
      clickedText: next.text,
      clickedUrl: next.url.href,
      url: page.url(),
      title: await page.title(),
      documentReferrer: await page.evaluate(() => document.referrer),
      ...(await readPage(page)),
    });
  }

  return routeHistory;
}

async function main() {
  if (!SEARCH_QUERY) throw new Error("search_query_missing");
  const target = requireUrl(TARGET_URL, "target_url");
  const destination = requireUrl(SECONDARY_ORIGIN, "secondary_origin");

  const visitorIp = await fetchVisitorIp();
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    locale: "en-GB",
    timezoneId: "Europe/London",
    viewport: { width: 1365, height: 768 },
    screen: { width: 1365, height: 768 },
  });
  const page = await context.newPage();

  const report = {
    ok: false,
    synthetic: true,
    analyticsBlocked: false,
    testId,
    workflowRunId: process.env.GITHUB_RUN_ID || "local",
    recordedAt: new Date().toISOString(),
    profileId: "chromium-desktop-google-analytics-qa",
    browser: "chromium",
    deviceCategory: "desktop",
    visitorIp,
    searchQuery: SEARCH_QUERY,
    maxGooglePages: MAX_GOOGLE_PAGES,
    targetUrl: target.href,
    configuredSecondaryOrigin: destination.origin,
  };

  try {
    const google = await runGoogleSearch(page, target);
    report.google = google;

    const primaryReading = await readPage(page);
    report.primary = {
      reached: true,
      entryReferrer: google.entryReferrer,
      landingUrl: page.url(),
      title: await page.title(),
      reading: primaryReading,
    };

    const secondaryLink = await findContextualLink(page, destination);
    if (!secondaryLink) throw new Error("secondary_link_not_found");

    const clickedLink = await clickContextualLink(page, secondaryLink);
    if (!sameHostname(new URL(page.url()).hostname, destination.hostname)) {
      throw new Error("secondary_navigation_mismatch");
    }

    const routeHistory = await exploreDestination(page, destination, 2, 4);
    report.secondary = {
      selected: true,
      reached: true,
      origin: destination.origin,
      link: clickedLink,
      entryReferrer: routeHistory[0]?.documentReferrer || null,
      pagesVisited: routeHistory.length,
      routeHistory,
      finalUrl: page.url(),
      finalTitle: await page.title(),
    };

    report.ok = true;
    report.pagesVisited = 1 + routeHistory.length;
    report.finalUrl = page.url();
    report.finalTitle = await page.title();
  } catch (error) {
    report.errorMessage = error instanceof Error ? error.message : "unknown_error";
    report.finalUrl = page.url();
    report.finalTitle = await page.title().catch(() => "");
  } finally {
    report.durationMs = Date.now() - startedAt;
    await writeJson(PRIVATE_REPORT_PATH, report);
    await writeJson(PUBLIC_SUMMARY_PATH, {
      status: report.ok ? "success" : "failed",
      googleResultFound: Boolean(report.google),
      targetReached: Boolean(report.primary?.reached),
      destinationReached: Boolean(report.secondary?.reached),
      destinationPagesVisited: report.secondary?.pagesVisited || 0,
      durationMs: report.durationMs,
      errorCategory: report.errorMessage || null,
    });
    await browser.close();
  }

  if (!report.ok) process.exitCode = 1;
}

main().catch(async (error) => {
  const failure = {
    ok: false,
    synthetic: true,
    analyticsBlocked: false,
    testId,
    workflowRunId: process.env.GITHUB_RUN_ID || "local",
    recordedAt: new Date().toISOString(),
    profileId: "chromium-desktop-google-analytics-qa",
    browser: "chromium",
    deviceCategory: "desktop",
    durationMs: Date.now() - startedAt,
    errorMessage: error instanceof Error ? error.message : "startup_error",
  };
  await writeJson(PRIVATE_REPORT_PATH, failure).catch(() => {});
  await writeJson(PUBLIC_SUMMARY_PATH, {
    status: "failed",
    googleResultFound: false,
    targetReached: false,
    destinationReached: false,
    destinationPagesVisited: 0,
    durationMs: failure.durationMs,
    errorCategory: failure.errorMessage,
  }).catch(() => {});
  process.exitCode = 1;
});
