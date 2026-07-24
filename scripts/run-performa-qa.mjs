import { chromium, devices, firefox, webkit } from "playwright";

const PERFORMA_ORIGIN = new URL(process.env.PERFORMA_ORIGIN || "https://performa.com").origin;
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
const BLOCKED_FILE_EXTENSIONS = /\.(?:pdf|zip|rar|7z|docx?|xlsx?|pptx?|csv|xml|json|txt)(?:$|[?#])/i;
const ANALYTICS_HOST_SUFFIXES = [
  "google-analytics.com",
  "googletagmanager.com",
  "doubleclick.net",
  "clarity.ms",
  "hotjar.com",
  "hotjar.io",
  "facebook.net",
];
const SYNTHETIC_HEADER = {
  "X-Synthetic-Monitor": "1",
};

const CLOUDFLARE_ACCOUNT_ID = String(process.env.CLOUDFLARE_ACCOUNT_ID || "").trim();
const CLOUDFLARE_AI_TOKEN = String(process.env.CLOUDFLARE_AI_TOKEN || "").trim();
const CLOUDFLARE_AI_MODEL = String(
  process.env.CLOUDFLARE_AI_MODEL || "@cf/ibm-granite/granite-4.0-h-micro",
).trim();
const AI_ENABLED = Boolean(CLOUDFLARE_ACCOUNT_ID && CLOUDFLARE_AI_TOKEN);
const AI_MAX_DECISIONS = Math.max(0, Number.parseInt(process.env.AI_MAX_DECISIONS || "10", 10) || 0);
const AI_DECISION_PROBABILITY = Math.min(
  1,
  Math.max(0, Number.parseFloat(process.env.AI_DECISION_PROBABILITY || "0.85") || 0),
);
const AI_REQUEST_TIMEOUT_MS = 9000;

const randomBetween = (min, max) => Math.floor(min + Math.random() * (max - min + 1));
const pick = (values) => values[randomBetween(0, values.length - 1)];
const chance = (probability) => Math.random() < probability;
const hostMatchesSuffix = (hostname, suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`);
const normalizeHost = (hostname) => String(hostname || "").toLowerCase().replace(/^www\./, "");

function requireHttpUrl(name, value) {
  if (!value) throw new Error(`missing_${name.toLowerCase()}`);
  const parsed = new URL(value);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error(`invalid_${name.toLowerCase()}`);
  return parsed;
}

function siteKey(value) {
  const url = value instanceof URL ? value : new URL(value);
  return `${url.protocol}//${normalizeHost(url.hostname)}`;
}

function isSameSite(value, expectedOrigin) {
  try {
    return siteKey(value) === siteKey(expectedOrigin);
  } catch {
    return false;
  }
}

function isPerformaUrl(value) {
  try {
    return normalizeHost(new URL(value).hostname) === "performa.com";
  } catch {
    return false;
  }
}

function normalizeVisitedUrl(value) {
  const url = new URL(value);
  url.hash = "";
  return url.href;
}

function hasBlockedPath(url) {
  const pathname = url.pathname.toLowerCase();
  return BLOCKED_PATH_PARTS.some((part) => pathname.includes(part));
}

function isNavigablePageUrl(url) {
  return !hasBlockedPath(url) && !BLOCKED_FILE_EXTENSIONS.test(`${url.pathname}${url.search}`);
}

function cleanText(value, maxLength = 120) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function shuffled(values) {
  const copy = [...values];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = randomBetween(0, i);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function compactVisited(values, limit = 10) {
  return [...values].slice(-limit).map((value) => {
    try {
      const url = new URL(value);
      return `${url.pathname}${url.search}`.slice(0, 140);
    } catch {
      return String(value).slice(0, 140);
    }
  });
}

function parseAiDecision(raw) {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw;
  const text = String(raw || "").trim();
  try {
    return JSON.parse(text);
  } catch {}

  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    try {
      return JSON.parse(text.slice(firstBrace, lastBrace + 1));
    } catch {}
  }
  return null;
}

const profiles = [
  {
    id: "chromium-desktop",
    browser: "chromium",
    deviceCategory: "desktop",
    context: { viewport: { width: 1440, height: 900 }, locale: "en-US" },
  },
  {
    id: "chromium-android",
    browser: "chromium",
    deviceCategory: "mobile",
    context: { ...devices["Pixel 7"], locale: "en-US" },
  },
  {
    id: "firefox-desktop",
    browser: "firefox",
    deviceCategory: "desktop",
    context: { viewport: { width: 1366, height: 768 }, locale: "en-US" },
  },
  {
    id: "webkit-iphone",
    browser: "webkit",
    deviceCategory: "mobile",
    context: { ...devices["iPhone 13"], locale: "en-US" },
  },
];

const browserTypeFor = (name) => (name === "firefox" ? firefox : name === "webkit" ? webkit : chromium);

async function installRequestRouting(context, allowedOrigins) {
  const allowedSites = new Set(allowedOrigins.filter(Boolean).map((value) => siteKey(value)));
  const analyticsBlocked = String(process.env.BLOCK_ANALYTICS || "false").toLowerCase() === "true";

  await context.route("**/*", async (route) => {
    const request = route.request();
    try {
      const url = new URL(request.url());
      const host = url.hostname.toLowerCase();

      if (analyticsBlocked && ANALYTICS_HOST_SUFFIXES.some((suffix) => hostMatchesSuffix(host, suffix))) {
        return route.abort("blockedbyclient");
      }

      if (allowedSites.has(siteKey(url))) {
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

async function acceptCookieConsent(page) {
  if (!isPerformaUrl(page.url())) return false;

  const overlay = page.locator('[class*="cookie-consent"], [class*="cookie_banner"], [class*="cookie-banner"]').first();
  const overlayVisible = await overlay.isVisible().catch(() => false);
  if (!overlayVisible) return false;

  const candidates = page.locator('button, [role="button"]');
  const count = Math.min(await candidates.count(), 40);
  const positivePatterns = [
    /^accept all$/i,
    /^accept$/i,
    /^allow all$/i,
    /^allow$/i,
    /^agree$/i,
    /^i agree$/i,
    /^got it$/i,
    /^ok$/i,
    /^okay$/i,
    /accept all cookies/i,
    /allow all cookies/i,
  ];

  for (let index = 0; index < count; index += 1) {
    const button = candidates.nth(index);
    if (!(await button.isVisible().catch(() => false))) continue;
    const text = cleanText(
      (await button.innerText().catch(() => "")) ||
      (await button.getAttribute("aria-label").catch(() => "")) ||
      (await button.getAttribute("title").catch(() => "")),
      80,
    );
    if (!positivePatterns.some((pattern) => pattern.test(text))) continue;

    try {
      await button.click({ timeout: 5000 });
      await page.waitForTimeout(1200);
      console.log(`Cookie consent accepted on Performa via: ${text || "button"}`);
      return true;
    } catch {}
  }

  console.warn("Performa cookie consent overlay is visible but no accept button was clicked");
  return false;
}

async function collectLinks(page, deviceCategory = null) {
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
      if (!isNavigablePageUrl(url)) continue;

      const elementState = await link.evaluate((element) => {
        let current = element;
        let classTrail = "";
        let ariaHidden = false;
        for (let depth = 0; current && depth < 5; depth += 1, current = current.parentElement) {
          classTrail += ` ${typeof current.className === "string" ? current.className : ""}`;
          if (current.getAttribute?.("aria-hidden") === "true") ariaHidden = true;
        }
        return {
          ariaHidden,
          mobileNav: /mobile[-_\s]?nav|header-mobile|mobile-menu/i.test(classTrail),
        };
      }).catch(() => ({ ariaHidden: false, mobileNav: false }));

      if (elementState.ariaHidden) continue;
      if (deviceCategory === "desktop" && elementState.mobileNav) continue;

      const hasImage = await link.locator("img").count().then((value) => value > 0).catch(() => false);
      const text = cleanText(
        (await link.innerText().catch(() => "")) ||
        (await link.getAttribute("aria-label").catch(() => "")) ||
        (await link.getAttribute("title").catch(() => "")) ||
        url.pathname,
      );
      out.push({ index, href: url.href, hasImage, text });
    } catch {}
  }

  return out;
}

async function findLinkToOrigin(page, origin, preferImage = false, deviceCategory = null) {
  const matches = (await collectLinks(page, deviceCategory)).filter((link) => isSameSite(link.href, origin));
  if (!matches.length) return null;
  if (preferImage) {
    const imageLinks = matches.filter((link) => link.hasImage);
    if (imageLinks.length) return pick(imageLinks);
  }
  return pick(matches);
}

async function callCloudflareAi(messages) {
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/run/${CLOUDFLARE_AI_MODEL}`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${CLOUDFLARE_AI_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messages,
      max_tokens: 60,
      temperature: 0.9,
      top_p: 0.9,
      seed: randomBetween(1, 9_000_000_000),
      presence_penalty: 0.35,
      repetition_penalty: 1.05,
    }),
    signal: AbortSignal.timeout(AI_REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) throw new Error(`cloudflare_ai_http_${response.status}`);
  const payload = await response.json();
  if (!payload?.success) throw new Error("cloudflare_ai_unsuccessful");
  return payload?.result?.response;
}

async function chooseCandidateWithAi({ page, candidates, visited, siteRole, step, desiredPages, aiState }) {
  if (!candidates.length) return null;

  const canAskAi = AI_ENABLED && aiState.calls < AI_MAX_DECISIONS && chance(AI_DECISION_PROBABILITY);
  if (!canAskAi) {
    aiState.randomDecisions += 1;
    return pick(candidates);
  }

  const shortlist = shuffled(candidates).slice(0, Math.min(24, candidates.length));
  const currentTitle = cleanText(await page.title().catch(() => ""), 100);
  const options = shortlist.map((candidate, candidateId) => {
    const url = new URL(candidate.href);
    return {
      candidateId,
      text: cleanText(candidate.text || url.pathname, 90),
      path: `${url.pathname}${url.search}`.slice(0, 120),
      imageLink: candidate.hasImage,
    };
  });

  const systemPrompt = [
    "You are an autonomous website QA exploration planner.",
    "Choose exactly one supplied visible internal link that gives useful, varied coverage of the current site.",
    "Prefer meaningful content, product, feature, documentation, blog, news, about, FAQ, and informational pages.",
    "Avoid repetitive paths and avoid login, account, checkout, cart, admin, legal/privacy/terms, downloads, or actions that submit forms or change data.",
    "Never invent a URL and never choose anything outside the supplied candidates.",
    "Return JSON only in this exact shape: {\"candidateId\": number}.",
  ].join(" ");

  const userPrompt = JSON.stringify({
    siteRole,
    currentUrl: page.url(),
    currentTitle,
    step: step + 1,
    plannedPages: desiredPages,
    recentlyVisited: compactVisited(visited),
    candidates: options,
  });

  aiState.calls += 1;
  try {
    const raw = await callCloudflareAi([
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ]);
    const decision = parseAiDecision(raw);
    const candidateId = Number(decision?.candidateId);
    if (!Number.isInteger(candidateId) || candidateId < 0 || candidateId >= shortlist.length) {
      throw new Error("cloudflare_ai_invalid_candidate");
    }
    aiState.aiDecisions += 1;
    return shortlist[candidateId];
  } catch (error) {
    aiState.fallbacks += 1;
    aiState.randomDecisions += 1;
    console.warn(`AI navigation fallback: ${error?.message || "unknown_error"}`);
    return pick(candidates);
  }
}

async function clickLink(context, sourcePage, metadata, expectedOrigin) {
  const link = sourcePage.locator("a[href]").nth(metadata.index);
  const destinationHref = metadata.href;

  if (isPerformaUrl(sourcePage.url())) await acceptCookieConsent(sourcePage);

  await link.scrollIntoViewIfNeeded().catch(() => undefined);
  await link.evaluate((element, href) => {
    element.removeAttribute("target");
    element.setAttribute("href", href);
  }, destinationHref);

  const waitForDestination = () => {
    const sameTab = sourcePage.waitForURL(
      (url) => isSameSite(url.toString(), expectedOrigin),
      { timeout: 30000, waitUntil: "domcontentloaded" },
    ).then(() => sourcePage).catch(() => null);

    const popup = context.waitForEvent("page", { timeout: 30000 }).then(async (page) => {
      await page.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => undefined);
      return isSameSite(page.url(), expectedOrigin) ? page : null;
    }).catch(() => null);

    return Promise.race([sameTab, popup]);
  };

  let destinationPromise = waitForDestination();
  try {
    await link.click({ timeout: 9000 });
  } catch (error) {
    console.warn(`Physical click failed for ${destinationHref}: ${error?.message || "unknown_error"}; trying DOM click`);
    await link.evaluate((element) => element.click()).catch(() => undefined);
  }

  let destination = await destinationPromise;
  if (!destination && isSameSite(destinationHref, expectedOrigin)) {
    console.warn(`Click navigation did not complete for ${destinationHref}; using same-site goto fallback`);
    await sourcePage.goto(destinationHref, { waitUntil: "domcontentloaded", timeout: 30000 });
    destination = sourcePage;
  }

  if (!destination) throw new Error("link_navigation_timeout");
  await destination.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => undefined);
  if (isPerformaUrl(destination.url())) await acceptCookieConsent(destination);
  return destination;
}

async function readPage(page, deviceCategory, minDwellMs = 7000, maxDwellMs = 18000) {
  if (isPerformaUrl(page.url())) await acceptCookieConsent(page);

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

async function browseSite(context, page, origin, profile, options = {}, aiState, siteRole = "site") {
  const {
    minPages = 6,
    maxPages = 10,
    minDwellMs = 7000,
    maxDwellMs = 18000,
    homeReturnChance = 0.15,
  } = options;

  const desiredPages = randomBetween(minPages, maxPages);
  const visited = new Set();
  const failedUrls = new Set();
  let pagesVisited = 0;
  let clickFallbacks = 0;

  for (let i = 0; i < desiredPages; i += 1) {
    visited.add(normalizeVisitedUrl(page.url()));
    if (siteRole === "performa") await acceptCookieConsent(page);

    const allCandidates = (await collectLinks(page, profile.deviceCategory)).filter((link) => {
      try {
        const url = new URL(link.href);
        url.hash = "";
        const normalized = normalizeVisitedUrl(url.href);
        return (
          isSameSite(url, origin) &&
          !visited.has(normalized) &&
          !failedUrls.has(normalized) &&
          isNavigablePageUrl(url)
        );
      } catch {
        return false;
      }
    });

    await readPage(page, profile.deviceCategory, minDwellMs, maxDwellMs);
    pagesVisited += 1;

    if (i === desiredPages - 1) break;

    if (i > 1 && chance(homeReturnChance)) {
      const homeUrl = new URL("/", origin).href;
      if (normalizeVisitedUrl(page.url()) !== normalizeVisitedUrl(homeUrl)) {
        await page.goto(homeUrl, { waitUntil: "domcontentloaded", timeout: 40000 }).catch(() => undefined);
        if (siteRole === "performa") await acceptCookieConsent(page);
        await page.waitForTimeout(randomBetween(1000, 3200));
        continue;
      }
    }

    if (allCandidates.length === 0) break;

    let remainingCandidates = [...allCandidates];
    let navigated = false;
    const maxAttempts = Math.min(3, remainingCandidates.length);

    for (let attempt = 0; attempt < maxAttempts && remainingCandidates.length > 0; attempt += 1) {
      const nextCandidate = await chooseCandidateWithAi({
        page,
        candidates: remainingCandidates,
        visited,
        siteRole,
        step: i,
        desiredPages,
        aiState,
      });
      if (!nextCandidate) break;

      try {
        page = await clickLink(context, page, nextCandidate, origin);
        navigated = true;
        await page.waitForTimeout(randomBetween(900, 3400));
        break;
      } catch (error) {
        clickFallbacks += 1;
        const normalizedFailed = normalizeVisitedUrl(nextCandidate.href);
        failedUrls.add(normalizedFailed);
        remainingCandidates = remainingCandidates.filter(
          (candidate) => normalizeVisitedUrl(candidate.href) !== normalizedFailed,
        );
        console.warn(`Skipping failed QA link ${nextCandidate.href}: ${error?.message || "unknown_error"}`);
      }
    }

    if (!navigated) {
      console.warn(`No usable internal link after retries on ${page.url()}; ending this site exploration cleanly`);
      break;
    }
  }

  return { page, pagesVisited, desiredPages, clickFallbacks };
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
const aiState = {
  calls: 0,
  aiDecisions: 0,
  randomDecisions: 0,
  fallbacks: 0,
};
const networkStats = {
  analyticsRequests: 0,
  gaCollectRequests: 0,
};
let browser;

try {
  browser = await browserTypeFor(profile.browser).launch({ headless: false });
  const context = await browser.newContext(profile.context);
  const analyticsBlocked = await installRequestRouting(context, [targetUrl.origin, PERFORMA_ORIGIN, "https://www.performa.com"]);

  context.on("request", (request) => {
    try {
      const url = new URL(request.url());
      const host = url.hostname.toLowerCase();
      if (ANALYTICS_HOST_SUFFIXES.some((suffix) => hostMatchesSuffix(host, suffix))) {
        networkStats.analyticsRequests += 1;
      }
      if (hostMatchesSuffix(host, "google-analytics.com") && /\/g\/collect(?:$|[?])/i.test(url.pathname + url.search)) {
        networkStats.gaCollectRequests += 1;
      }
    } catch {}
  });

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
  const targetResult = await browseSite(context, page, targetUrl.origin, profile, feederPlan, aiState, "feeder");
  page = targetResult.page;

  await page.goto(new URL("/", targetUrl.origin).href, { waitUntil: "domcontentloaded", timeout: 40000 });
  await page.waitForTimeout(randomBetween(1200, 4200));

  const performaLink = await findLinkToOrigin(page, PERFORMA_ORIGIN, true, profile.deviceCategory);
  if (!performaLink) throw new Error("performa_link_not_found");

  await readPage(page, profile.deviceCategory, 5000, 12000);
  page = await clickLink(context, page, performaLink, PERFORMA_ORIGIN);
  await acceptCookieConsent(page);
  await page.waitForTimeout(randomBetween(1800, 4500));

  const performaResult = await browseSite(context, page, PERFORMA_ORIGIN, profile, performaPlan, aiState, "performa");
  page = performaResult.page;

  console.log(JSON.stringify({
    status: "success",
    synthetic: true,
    analyticsBlocked,
    analyticsRequestsObserved: networkStats.analyticsRequests,
    gaCollectRequestsObserved: networkStats.gaCollectRequests,
    aiEnabled: AI_ENABLED,
    aiModel: AI_ENABLED ? CLOUDFLARE_AI_MODEL : null,
    aiCalls: aiState.calls,
    aiDecisions: aiState.aiDecisions,
    randomDecisions: aiState.randomDecisions,
    aiFallbacks: aiState.fallbacks,
    profile: profile.id,
    feederSite: targetUrl.origin,
    feederPagesVisited: targetResult.pagesVisited,
    feederPagesPlanned: targetResult.desiredPages,
    feederClickFallbacks: targetResult.clickFallbacks,
    performaPagesVisited: performaResult.pagesVisited,
    performaPagesPlanned: performaResult.desiredPages,
    performaClickFallbacks: performaResult.clickFallbacks,
    finalUrl: page.url(),
    durationMs: Date.now() - startedAt,
  }));
} finally {
  await browser?.close().catch(() => undefined);
}
