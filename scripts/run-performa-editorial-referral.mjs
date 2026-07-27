import { chromium, devices } from "playwright";

const SOURCE_URL = new URL(process.env.REFERRAL_SOURCE_URL || "");
const PERFORMA_ORIGIN = new URL(process.env.PERFORMA_ORIGIN || "https://performa.com").origin;
const SYNTHETIC_HEADER = { "X-Synthetic-Monitor": "1" };

const randomBetween = (min, max) => Math.floor(min + Math.random() * (max - min + 1));
const pick = (values) => values[randomBetween(0, values.length - 1)];
const normalizeHost = (hostname) => String(hostname || "").toLowerCase().replace(/^www\./, "");

function isPerforma(value) {
  try {
    return normalizeHost(new URL(value).hostname) === "performa.com";
  } catch {
    return false;
  }
}

function sameSite(value, origin) {
  try {
    const a = new URL(value);
    const b = new URL(origin);
    return a.protocol === b.protocol && normalizeHost(a.hostname) === normalizeHost(b.hostname);
  } catch {
    return false;
  }
}

function cleanText(value, max = 120) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

const profiles = [
  {
    id: "chromium-desktop",
    context: { viewport: { width: 1440, height: 900 }, locale: "en-US" },
  },
  {
    id: "chromium-android",
    context: { ...devices["Pixel 7"], locale: "en-US" },
  },
];

async function acceptConsent(page) {
  const directSelectors = [
    "#onetrust-accept-btn-handler",
    "button#onetrust-accept-btn-handler",
    "button[data-testid*=accept]",
    "button[id*=accept]",
  ];

  for (const selector of directSelectors) {
    const button = page.locator(selector).first();
    if (await button.isVisible().catch(() => false)) {
      await button.click({ timeout: 4000 }).catch(() => undefined);
      await page.waitForTimeout(700);
      return true;
    }
  }

  const buttons = page.locator('button, [role="button"]');
  const count = Math.min(await buttons.count(), 60);
  const patterns = [
    /^accept all$/i,
    /^accept$/i,
    /^allow all$/i,
    /^allow$/i,
    /^agree$/i,
    /^i agree$/i,
    /^got it$/i,
    /accept all cookies/i,
  ];

  for (let i = 0; i < count; i += 1) {
    const button = buttons.nth(i);
    if (!(await button.isVisible().catch(() => false))) continue;
    const label = cleanText(
      (await button.innerText().catch(() => "")) ||
        (await button.getAttribute("aria-label").catch(() => "")) ||
        (await button.getAttribute("title").catch(() => "")),
      80,
    );
    if (!patterns.some((pattern) => pattern.test(label))) continue;
    await button.click({ timeout: 4000 }).catch(() => undefined);
    await page.waitForTimeout(700);
    return true;
  }

  return false;
}

async function readPage(page, minMs = 6500, maxMs = 15000) {
  const viewport = page.viewportSize() || { width: 1440, height: 900 };
  const maxScroll = await page
    .evaluate(() => Math.max(0, Math.max(document.body.scrollHeight, document.documentElement.scrollHeight) - window.innerHeight))
    .catch(() => 0);

  const target = Math.round(maxScroll * (randomBetween(58, 94) / 100));
  const steps = randomBetween(4, 8);
  for (let i = 1; i <= steps; i += 1) {
    const y = Math.round((target * i) / steps);
    await page.evaluate((top) => window.scrollTo({ top, behavior: "smooth" }), y).catch(() => undefined);
    await page.waitForTimeout(randomBetween(550, 1500));
  }

  if (viewport.width > 900) {
    await page.mouse
      .move(randomBetween(100, viewport.width - 100), randomBetween(100, Math.max(101, viewport.height - 100)), {
        steps: randomBetween(6, 14),
      })
      .catch(() => undefined);
  }

  await page.waitForTimeout(randomBetween(minMs, maxMs));
}

async function collectPerformaLinks(page) {
  const links = page.locator("a[href]");
  const count = Math.min(await links.count(), 600);
  const matches = [];

  for (let i = 0; i < count; i += 1) {
    const link = links.nth(i);
    if (!(await link.isVisible().catch(() => false))) continue;
    const href = await link.getAttribute("href");
    if (!href) continue;

    let resolved;
    try {
      resolved = new URL(href, page.url());
    } catch {
      continue;
    }
    if (!isPerforma(resolved.href)) continue;

    const text = cleanText(
      (await link.innerText().catch(() => "")) ||
        (await link.getAttribute("aria-label").catch(() => "")) ||
        (await link.getAttribute("title").catch(() => "")) ||
        resolved.pathname,
    );
    const rel = cleanText(await link.getAttribute("rel").catch(() => ""), 120);
    matches.push({ index: i, href: resolved.href, text, rel });
  }

  return matches;
}

async function clickPerformaLink(context, page, candidate) {
  const link = page.locator("a[href]").nth(candidate.index);
  await link.scrollIntoViewIfNeeded().catch(() => undefined);

  // Keep the publisher's actual href and rel/referrer policy intact; only force same-tab navigation.
  await link.evaluate((element) => element.removeAttribute("target")).catch(() => undefined);

  const sameTab = page
    .waitForURL((url) => isPerforma(url.toString()), { timeout: 30000, waitUntil: "domcontentloaded" })
    .then(() => page)
    .catch(() => null);
  const popup = context
    .waitForEvent("page", { timeout: 30000 })
    .then(async (newPage) => {
      await newPage.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => undefined);
      return isPerforma(newPage.url()) ? newPage : null;
    })
    .catch(() => null);

  try {
    await link.click({ timeout: 10000 });
  } catch {
    await link.evaluate((element) => element.click()).catch(() => undefined);
  }

  const destination = await Promise.race([sameTab, popup]);
  if (!destination) throw new Error("performa_click_navigation_timeout");
  return destination;
}

async function browsePerforma(page) {
  await acceptConsent(page);
  await readPage(page, 8000, 18000);

  const internal = page.locator('a[href]');
  const count = Math.min(await internal.count(), 300);
  const candidates = [];
  for (let i = 0; i < count; i += 1) {
    const link = internal.nth(i);
    if (!(await link.isVisible().catch(() => false))) continue;
    const href = await link.getAttribute("href");
    if (!href) continue;
    try {
      const resolved = new URL(href, page.url());
      if (!sameSite(resolved.href, PERFORMA_ORIGIN)) continue;
      if (resolved.pathname === new URL(page.url()).pathname) continue;
      if (/\.(?:pdf|zip|docx?|xlsx?|pptx?)(?:$|[?#])/i.test(resolved.pathname + resolved.search)) continue;
      candidates.push({ index: i, href: resolved.href });
    } catch {}
  }

  if (!candidates.length) return page;
  const next = pick(candidates);
  const link = page.locator("a[href]").nth(next.index);
  await link.scrollIntoViewIfNeeded().catch(() => undefined);
  await link.evaluate((element) => element.removeAttribute("target")).catch(() => undefined);
  await Promise.all([
    page.waitForURL((url) => sameSite(url.toString(), PERFORMA_ORIGIN), { timeout: 20000, waitUntil: "domcontentloaded" }).catch(() => null),
    link.click({ timeout: 8000 }).catch(() => undefined),
  ]);
  await readPage(page, 5000, 12000);
  return page;
}

const profile = pick(profiles);
const browser = await chromium.launch({ headless: false });

try {
  const context = await browser.newContext(profile.context);

  // Mark only Performa requests as synthetic so the publisher page is loaded normally.
  await context.route("**/*", async (route) => {
    const request = route.request();
    if (isPerforma(request.url())) {
      await route.continue({
        headers: {
          ...request.headers(),
          ...SYNTHETIC_HEADER,
        },
      });
      return;
    }
    await route.continue();
  });

  let page = await context.newPage();
  await page.goto(SOURCE_URL.href, { waitUntil: "domcontentloaded", timeout: 45000 });
  await acceptConsent(page);
  await page.waitForTimeout(randomBetween(1200, 3200));
  await readPage(page);

  const candidates = await collectPerformaLinks(page);
  if (!candidates.length) throw new Error(`performa_link_not_found_on_source:${SOURCE_URL.href}`);

  const candidate = pick(candidates);
  page = await clickPerformaLink(context, page, candidate);
  await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => undefined);

  const observedReferrer = await page.evaluate(() => document.referrer).catch(() => "");
  await browsePerforma(page);

  console.log(
    JSON.stringify({
      status: "success",
      synthetic: true,
      profile: profile.id,
      sourceUrl: SOURCE_URL.href,
      sourceOrigin: SOURCE_URL.origin,
      sourceLinkText: candidate.text,
      sourceLinkRel: candidate.rel || null,
      clickedUrl: candidate.href,
      observedDocumentReferrer: observedReferrer || null,
      finalUrl: page.url(),
    }),
  );
} finally {
  await browser.close().catch(() => undefined);
}
