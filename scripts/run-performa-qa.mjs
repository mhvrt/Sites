import { chromium, devices, firefox, webkit } from "playwright";

const PERFORMA_ORIGIN = new URL(process.env.PERFORMA_ORIGIN || "https://performa.com").origin;
const BLOCKED_PATH_PARTS = ["/api/", "/admin", "/login", "/logout", "/checkout", "/cart", "/account", "/privacy", "/terms", "/cookie", "/wp-admin"];
const ANALYTICS_HOST_SUFFIXES = ["google-analytics.com", "googletagmanager.com", "doubleclick.net", "clarity.ms", "hotjar.com", "hotjar.io", "facebook.net"];
const SYNTHETIC_HEADER = {
  "X-Synthetic-Monitor": "1",
};

const CLOUDFLARE_ACCOUNT_ID = String(process.env.CLOUDFLARE_ACCOUNT_ID || "").trim();
const CLOUDFLARE_AI_TOKEN = String(process.env.CLOUDFLARE_AI_TOKEN || "").trim();
const CLOUDFLARE_AI_MODEL = String(process.env.CLOUDFLARE_AI_MODEL || "@cf/ibm-granite/granite-4.0-h-micro").trim();
const AI_ENABLED = Boolean(CLOUDFLARE_ACCOUNT_ID && CLOUDFLARE_AI_TOKEN);
const AI_MAX_DECISIONS = Math.max(0, Number.parseInt(process.env.AI_MAX_DECISIONS || "10", 10) || 0);
const AI_DECISION_PROBABILITY = Math.min(1, Math.max(0, Number.parseFloat(process.env.AI_DECISION_PROBABILITY || "0.85") || 0));
const AI_REQUEST_TIMEOUT_MS = 9000;

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
      const text = cleanText(
        await link.innerText().catch(() => "") ||
        await link.getAttribute("aria-label").catch(() => "") ||
        await link.getAttribute("title").catch(() => "") ||
        url.pathname,
      );
      out.push({ index, href: url.href, hasImage, text });
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
    "Avoid repetitive paths and avoid login, account, checkout, cart, admin, legal/privacy/terms, or actions that submit forms or change data.",
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

    const nextCandidate = await chooseCandidateWithAi({
      page,
      candidates,
      visited,
      siteRole,
      step: i,
      desiredPages,
      aiState,
    });
    if (!nextCandidate) break;

    page = await clickLink(context, page, nextCandidate, origin);
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
const aiState = {
  calls: 0,
  aiDecisions: 0,
  randomDecisions: 0,
  fallbacks: 0,
};
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
  const targetResult = await browseSite(context, page, targetUrl.origin, profile, feederPlan, aiState, "feeder");
  page = targetResult.page;

  await page.goto(new URL("/", targetUrl.origin).href, { waitUntil: "domcontentloaded", timeout: 40000 });
  await page.waitForTimeout(randomBetween(1200, 4200));

  const performaLink = await findLinkToOrigin(page, PERFORMA_ORIGIN, true);
  if (!performaLink) throw new Error("performa_link_not_found");

  await readPage(page, profile.deviceCategory, 5000, 12000);
  page = await clickLink(context, page, performaLink, PERFORMA_ORIGIN);
  await page.waitForTimeout(randomBetween(1200, 4000));

  const performaResult = await browseSite(context, page, PERFORMA_ORIGIN, profile, performaPlan, aiState, "performa");
  page = performaResult.page;

  console.log(JSON.stringify({
    status: "success",
    synthetic: true,
    analyticsBlocked,
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
    performaPagesVisited: performaResult.pagesVisited,
    performaPagesPlanned: performaResult.desiredPages,
    finalUrl: page.url(),
    durationMs: Date.now() - startedAt,
  }));
} finally {
  await browser?.close().catch(() => undefined);
}
