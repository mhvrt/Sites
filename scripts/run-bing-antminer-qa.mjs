import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, firefox } from 'playwright';

const REPORT_PATH = process.env.REPORT_PATH || path.join(os.tmpdir(), 'bing-antminer-qa.json');
const QUERY = 'antminer s9';
const TARGET_HOST = 'emcd.io';
const TARGET_PATH = '/articles/mining/mining-with-antminer-s9-asic-is-it-still-profitable/';
const TARGET_URL = `https://${TARGET_HOST}${TARGET_PATH}`;
const EXPECTED_TITLE = 'Mining with Antminer S9 ASIC: Is It Still Profitable?';
const MAX_SERP_PAGES = 5;
const MAX_ATTEMPTS = Math.max(1, Math.min(4, Number(process.env.BING_MAX_ATTEMPTS || 3)));

const randomBetween = (min, max) => Math.floor(min + Math.random() * (max - min + 1));
const cleanText = (value) => String(value || '').replace(/\s+/g, ' ').trim();
const normalizeHost = (value) => String(value || '').toLowerCase().replace(/^www\./, '');

function normalizeTitle(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/[“”]/g, '"')
    .replace(/[’]/g, "'")
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function titleMatches(value) {
  const observed = normalizeTitle(value);
  const expected = normalizeTitle(EXPECTED_TITLE);
  return observed === expected || (
    observed.includes('mining with antminer s9 asic') &&
    observed.includes('still profitable')
  );
}

function decodeBingUrl(href) {
  try {
    const u = new URL(href, 'https://www.bing.com');
    const encoded = u.searchParams.get('u') || '';
    if (!encoded.startsWith('a1')) return href;
    let raw = encoded.slice(2);
    raw += '='.repeat((4 - (raw.length % 4)) % 4);
    return Buffer.from(raw, 'base64').toString('utf8');
  } catch {
    return href;
  }
}

function isEmcdUrl(value) {
  try {
    const u = new URL(value);
    return normalizeHost(u.hostname) === TARGET_HOST && /^https?:$/.test(u.protocol);
  } catch {
    return false;
  }
}

function isTargetUrl(value) {
  try {
    const u = new URL(value);
    return normalizeHost(u.hostname) === TARGET_HOST && u.pathname.replace(/\/+$/, '/') === TARGET_PATH;
  } catch {
    return false;
  }
}

function hasBingChallenge(bodyText) {
  return /one last step|solve the challenge|verify you are human|unusual traffic/i.test(bodyText || '');
}

async function installAnalyticsBlock(context) {
  await context.route('**/*', async (route) => {
    try {
      const host = new URL(route.request().url()).hostname.toLowerCase();
      if (
        host.endsWith('google-analytics.com') ||
        host.endsWith('googletagmanager.com') ||
        host.endsWith('doubleclick.net') ||
        host.endsWith('clarity.ms') ||
        host.endsWith('hotjar.com') ||
        host.endsWith('hotjar.io')
      ) {
        return route.abort('blockedbyclient');
      }
    } catch {}
    return route.continue();
  });
}

async function acceptBingCookies(page) {
  const selectors = [
    '#bnp_btn_accept',
    'button:has-text("Accept")',
    'button:has-text("Accept all")',
    'button:has-text("I agree")',
  ];

  for (const selector of selectors) {
    const button = page.locator(selector).first();
    if (await button.isVisible().catch(() => false)) {
      await button.click({ timeout: 4000 }).catch(() => undefined);
      await page.waitForTimeout(randomBetween(500, 1200));
      break;
    }
  }
}

async function naturalBingMovement(page) {
  await page.waitForTimeout(randomBetween(1800, 3600));
  const viewport = page.viewportSize() || { width: 1440, height: 900 };
  await page.mouse.move(
    randomBetween(120, Math.max(121, viewport.width - 120)),
    randomBetween(120, Math.max(121, viewport.height - 120)),
    { steps: randomBetween(8, 18) },
  ).catch(() => undefined);

  const scrollHeight = await page.evaluate(() => Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)).catch(() => 0);
  if (scrollHeight > viewport.height + 250) {
    await page.mouse.wheel(0, randomBetween(180, 520)).catch(() => undefined);
    await page.waitForTimeout(randomBetween(700, 1700));
    if (Math.random() < 0.3) {
      await page.mouse.wheel(0, -randomBetween(80, 220)).catch(() => undefined);
      await page.waitForTimeout(randomBetween(500, 1200));
    }
  }
}

async function waitForBingSearchNavigation(page, before, timeout = 12000) {
  return page.waitForURL(
    (u) => u.toString() !== before && u.pathname === '/search',
    { timeout, waitUntil: 'domcontentloaded' },
  ).catch(() => null);
}

async function openBingSearchFromHomepage(page, attempt) {
  await page.goto('https://www.bing.com/?cc=US&setlang=en-US', {
    waitUntil: 'domcontentloaded',
    timeout: 45000,
  });
  await page.waitForTimeout(randomBetween(1800, 3400));
  await acceptBingCookies(page);

  const homeBody = await page.locator('body').innerText().catch(() => '');
  if (hasBingChallenge(homeBody)) {
    attempt.status = 'challenge_on_homepage';
    return false;
  }

  const input = page.locator('#sb_form_q, textarea[name="q"], input[name="q"], input[type="search"]').first();
  if (!(await input.isVisible().catch(() => false))) {
    attempt.status = 'bing_search_input_missing';
    return false;
  }

  await naturalBingMovement(page);
  await input.click({ timeout: 5000 });
  await page.waitForTimeout(randomBetween(400, 1000));
  await input.fill('');
  await input.pressSequentially(QUERY, { delay: randomBetween(70, 140) });
  attempt.typedQuery = await input.inputValue().catch(() => null);
  await page.waitForTimeout(randomBetween(700, 1500));

  const submitSelectors = [
    '#search_icon',
    '#sb_form_go',
    'form#sb_form button[type="submit"]',
    'form#sb_form input[type="submit"]',
    'button[aria-label*="Search"]',
  ];

  for (const selector of submitSelectors) {
    const submit = page.locator(selector).first();
    if (!(await submit.isVisible().catch(() => false))) continue;

    const before = page.url();
    const navPromise = waitForBingSearchNavigation(page, before, 7000);
    await submit.click({ timeout: 5000 }).catch(() => undefined);
    const navigated = await navPromise;
    if (navigated) {
      attempt.searchMode = `homepage_click:${selector}`;
      await page.waitForTimeout(randomBetween(1200, 2400));
      return true;
    }
  }

  {
    const before = page.url();
    const navPromise = waitForBingSearchNavigation(page, before, 7000);
    await input.press('Enter').catch(() => undefined);
    const navigated = await navPromise;
    if (navigated) {
      attempt.searchMode = 'homepage_input_enter';
      await page.waitForTimeout(randomBetween(1200, 2400));
      return true;
    }
  }

  {
    const before = page.url();
    const navPromise = waitForBingSearchNavigation(page, before, 10000);
    const submitted = await input.evaluate((el) => {
      const form = el.form || el.closest('form');
      if (!form || typeof form.requestSubmit !== 'function') return false;
      form.requestSubmit();
      return true;
    }).catch(() => false);
    if (submitted) {
      const navigated = await navPromise;
      if (navigated) {
        attempt.searchMode = 'homepage_native_requestSubmit';
        await page.waitForTimeout(randomBetween(1200, 2400));
        return true;
      }
    }
  }

  attempt.status = 'bing_search_submit_failed';
  return false;
}

async function naturalBingPause(page, targetLink) {
  const started = Date.now();
  await naturalBingMovement(page);
  await targetLink.scrollIntoViewIfNeeded();
  await targetLink.hover({ timeout: 5000 }).catch(() => undefined);
  await page.waitForTimeout(randomBetween(2200, 5200));
  return Date.now() - started;
}

async function naturalRead(page) {
  await page.waitForTimeout(randomBetween(2200, 5200));

  const viewportHeight = await page.evaluate(() => window.innerHeight || 800).catch(() => 800);
  const scrollHeight = await page.evaluate(() => document.documentElement.scrollHeight || document.body.scrollHeight || 0).catch(() => 0);
  const maxScroll = Math.max(0, scrollHeight - viewportHeight);

  if (maxScroll > 250) {
    const firstMax = Math.min(maxScroll, 900);
    const firstMin = Math.min(maxScroll, 180);
    const first = randomBetween(firstMin, Math.max(firstMin, firstMax));
    await page.evaluate((y) => window.scrollTo({ top: y, behavior: 'smooth' }), first).catch(() => undefined);
    await page.waitForTimeout(randomBetween(900, 2200));

    const secondMin = Math.min(maxScroll, first + 180);
    const secondMax = Math.min(maxScroll, first + randomBetween(450, 1300));
    if (secondMax > secondMin) {
      const second = randomBetween(secondMin, secondMax);
      await page.evaluate((y) => window.scrollTo({ top: y, behavior: 'smooth' }), second).catch(() => undefined);
      await page.waitForTimeout(randomBetween(1000, 2600));
    }
  }
}

async function browseEmcd(page, report) {
  const additionalPages = randomBetween(3, 5);
  const visited = new Set([page.url()]);
  report.emcdRoute = [page.url()];

  for (let step = 0; step < additionalPages; step += 1) {
    await naturalRead(page);

    const anchors = page.locator('a[href]');
    const count = Math.min(await anchors.count(), 500);
    const candidates = [];

    for (let i = 0; i < count; i += 1) {
      const link = anchors.nth(i);
      if (!(await link.isVisible().catch(() => false))) continue;

      const href = (await link.getAttribute('href')) || '';
      if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) continue;

      let absolute;
      try {
        absolute = new URL(href, page.url()).toString();
      } catch {
        continue;
      }

      if (!isEmcdUrl(absolute) || visited.has(absolute) || absolute === page.url()) continue;
      if (/\.(?:pdf|zip|docx?|xlsx?|pptx?)(?:$|[?#])/i.test(absolute)) continue;

      const text = cleanText(await link.innerText().catch(() => ''));
      if (!text) continue;
      candidates.push({ index: i, url: absolute });
    }

    if (!candidates.length) break;

    const chosen = candidates[randomBetween(0, candidates.length - 1)];
    const link = anchors.nth(chosen.index);
    const before = page.url();

    await link.scrollIntoViewIfNeeded().catch(() => undefined);
    await link.hover({ timeout: 3000 }).catch(() => undefined);
    await page.waitForTimeout(randomBetween(500, 1500));
    await link.evaluate((el) => el.removeAttribute('target')).catch(() => undefined);

    const nav = page.waitForURL(
      (u) => isEmcdUrl(u.toString()) && u.toString() !== before,
      { timeout: 30000, waitUntil: 'domcontentloaded' },
    ).catch(() => null);

    try {
      await link.click({ timeout: 15000 });
    } catch {
      continue;
    }

    const navigated = await nav;
    if (!navigated) continue;

    await page.waitForTimeout(randomBetween(1200, 3200));
    const current = page.url();
    if (!isEmcdUrl(current) || current === before) continue;

    visited.add(current);
    report.emcdRoute.push(current);
  }

  await naturalRead(page);
  report.emcdPagesVisited = report.emcdRoute.length;
  report.finalUrl = page.url();
}

async function inspectSerpPage(page, attempt, serpPage) {
  await page.waitForTimeout(randomBetween(1400, 2800));
  const bodyText = await page.locator('body').innerText().catch(() => '');
  const challenge = hasBingChallenge(bodyText);
  const results = page.locator('li.b_algo h2 a');
  const count = Math.min(await results.count(), 20);

  attempt.pages.push({
    page: serpPage,
    url: page.url(),
    resultCount: count,
    challenge,
  });

  if (challenge) return { challenge: true, found: null, resultCount: count };

  for (let i = 0; i < count; i += 1) {
    const link = results.nth(i);
    const title = cleanText(await link.innerText().catch(() => ''));
    const href = (await link.getAttribute('href')) || '';
    const decoded = decodeBingUrl(href);

    if (isTargetUrl(decoded) && titleMatches(title)) {
      return {
        challenge: false,
        resultCount: count,
        found: {
          link,
          title,
          decoded,
          rawHref: href,
          serpPage,
          rankOnPage: i + 1,
          absoluteRank: (serpPage - 1) * 10 + i + 1,
        },
      };
    }
  }

  return { challenge: false, found: null, resultCount: count };
}

async function clickNextBingPage(page) {
  await naturalBingMovement(page);

  const currentUrl = new URL(page.url());
  const currentFirst = Number(currentUrl.searchParams.get('first') || 1);
  const anchors = page.locator('a[href]');
  const count = Math.min(await anchors.count(), 300);
  const candidates = [];

  for (let i = 0; i < count; i += 1) {
    const link = anchors.nth(i);
    if (!(await link.isVisible().catch(() => false))) continue;
    const href = (await link.getAttribute('href')) || '';
    if (!href) continue;

    try {
      const u = new URL(href, page.url());
      if (normalizeHost(u.hostname) !== 'bing.com') continue;
      if (u.pathname !== '/search') continue;
      const first = Number(u.searchParams.get('first') || 0);
      if (!Number.isFinite(first) || first <= currentFirst) continue;
      candidates.push({ index: i, first });
    } catch {}
  }

  if (!candidates.length) return false;
  candidates.sort((a, b) => a.first - b.first);
  const next = anchors.nth(candidates[0].index);

  await next.scrollIntoViewIfNeeded().catch(() => undefined);
  await next.hover({ timeout: 3000 }).catch(() => undefined);
  await page.waitForTimeout(randomBetween(700, 1600));

  const before = page.url();
  const nav = page.waitForURL(
    (u) => u.toString() !== before,
    { timeout: 30000, waitUntil: 'domcontentloaded' },
  ).catch(() => null);

  try {
    await next.click({ timeout: 10000 });
  } catch {
    return false;
  }

  return Boolean(await nav);
}

const report = {
  synthetic: true,
  query: QUERY,
  expectedTitle: EXPECTED_TITLE,
  targetUrl: TARGET_URL,
  clicked: false,
  attempts: [],
  successfulAttempt: null,
  matchedTitle: null,
  matchedUrl: null,
  rawBingHref: null,
  bingRegion: null,
  bingMarket: null,
  bingPreClickMs: null,
  serpPage: null,
  serpPagesChecked: 0,
  rankOnPage: null,
  rank: null,
  finalUrl: null,
  referrer: null,
  emcdPagesVisited: 0,
  emcdRoute: [],
  error: null,
};

const attemptPlan = [
  { name: 'chromium', launcher: chromium },
  { name: 'firefox', launcher: firefox },
  { name: 'chromium', launcher: chromium },
  { name: 'firefox', launcher: firefox },
].slice(0, MAX_ATTEMPTS);

for (let attemptIndex = 0; attemptIndex < attemptPlan.length && !report.clicked; attemptIndex += 1) {
  const { name, launcher } = attemptPlan[attemptIndex];
  const attempt = {
    number: attemptIndex + 1,
    browser: name,
    searchMode: null,
    typedQuery: null,
    pages: [],
    status: 'started',
    error: null,
  };
  report.attempts.push(attempt);

  let browser;
  try {
    browser = await launcher.launch({ headless: true });
    const context = await browser.newContext({
      locale: 'en-US',
      viewport: { width: 1440, height: 900 },
    });
    await installAnalyticsBlock(context);

    const page = await context.newPage();
    const searchStarted = await openBingSearchFromHomepage(page, attempt);
    if (!searchStarted) continue;

    if (attemptIndex === 0) {
      const globals = await page.evaluate(() => ({
        region: globalThis?._G?.Region || null,
        market: globalThis?._G?.Mkt || null,
      })).catch(() => ({ region: null, market: null }));
      report.bingRegion = globals.region;
      report.bingMarket = globals.market;
    }

    let found = null;

    for (let serpPage = 1; serpPage <= MAX_SERP_PAGES && !found; serpPage += 1) {
      const inspected = await inspectSerpPage(page, attempt, serpPage);
      report.serpPagesChecked += 1;

      if (inspected.challenge) {
        attempt.status = `challenge_on_page_${serpPage}`;
        break;
      }

      if (inspected.found) {
        found = inspected.found;
        break;
      }

      if (inspected.resultCount === 0) {
        attempt.status = `no_results_on_page_${serpPage}`;
        break;
      }

      if (serpPage < MAX_SERP_PAGES) {
        const moved = await clickNextBingPage(page);
        if (!moved) {
          attempt.status = `next_failed_on_page_${serpPage}`;
          break;
        }
      }
    }

    if (!found) {
      if (attempt.status === 'started') attempt.status = 'target_not_found';
      continue;
    }

    report.successfulAttempt = attempt.number;
    report.serpPage = found.serpPage;
    report.rankOnPage = found.rankOnPage;
    report.rank = found.absoluteRank;
    report.matchedTitle = found.title;
    report.matchedUrl = found.decoded;
    report.rawBingHref = found.rawHref;
    report.bingPreClickMs = await naturalBingPause(page, found.link);

    const nav = page.waitForURL(
      (u) => isTargetUrl(u.toString()),
      { timeout: 45000, waitUntil: 'domcontentloaded' },
    ).catch(() => null);

    await found.link.click({ timeout: 15000 });
    const navigated = await nav;
    if (!navigated || !isTargetUrl(page.url())) {
      attempt.status = 'target_click_no_navigation';
      continue;
    }

    await page.waitForTimeout(randomBetween(1800, 4200));
    report.clicked = true;
    report.referrer = await page.evaluate(() => document.referrer);
    attempt.status = 'clicked_target';

    await browseEmcd(page, report);
  } catch (error) {
    attempt.error = error instanceof Error ? error.message : String(error);
    attempt.status = 'error';
  } finally {
    await browser?.close().catch(() => undefined);
  }

  if (!report.clicked && attemptIndex < attemptPlan.length - 1) {
    await new Promise((resolve) => setTimeout(resolve, randomBetween(3000, 7000)));
  }
}

if (!report.clicked) {
  report.error = 'all_clean_bing_attempts_failed';
}

await fs.writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
if (!report.clicked) process.exitCode = 1;
