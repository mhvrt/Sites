import { firefox } from 'playwright';

function decodeBing(href) {
  try {
    const u = new URL(href).searchParams.get('u');
    if (u?.startsWith('a1')) return Buffer.from(u.slice(2), 'base64').toString('utf8');
  } catch {}
  return href;
}
const norm = h => (h || '').toLowerCase().replace(/^www\./, '');

const domain = process.env.DOMAIN;
const query = process.env.QUERY;
const pageNo = Number(process.env.PAGE_NO);
const first = Number(process.env.FIRST);
const browser = await firefox.launch({ headless: true });
const context = await browser.newContext({ locale: 'en-US', timezoneId: 'America/New_York' });
const page = await context.newPage();
const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&first=${first}&FORM=PERE&cc=US&setlang=en-US`;
try {
  const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1200);
  const body = (await page.locator('body').innerText()).slice(0, 1200);
  const challenge = /one last step|solve the challenge|captcha|unusual traffic/i.test(body);
  const market = await page.evaluate(() => ({ region: globalThis._G?.Region || null, mkt: globalThis._G?.Mkt || null })).catch(() => ({}));
  const raw = await page.locator('li.b_algo').evaluateAll(lis => lis.map(li => {
    const a = li.querySelector('h2 a[href]');
    return a ? { title: (a.textContent || '').trim(), href: a.href } : null;
  }).filter(Boolean).slice(0, 10));
  const results = raw.map((r, i) => {
    const target = decodeBing(r.href);
    let host = '';
    try { host = new URL(target).hostname; } catch {}
    return { rank: (pageNo - 1) * 10 + i + 1, title: r.title, url: target, host };
  });
  const hit = results.find(r => {
    const h = norm(r.host), d = norm(domain);
    return h === d || h.endsWith('.' + d);
  }) || null;
  console.log(JSON.stringify({ domain, query, page: pageNo, status: resp?.status() ?? null, challenge, market, count: results.length, hit, hosts: results.map(r => r.host) }, null, 2));
  if (hit) {
    console.error(`HIT ${domain} rank ${hit.rank} ${hit.url}`);
    process.exitCode = 42;
  }
} finally {
  await browser.close();
}
