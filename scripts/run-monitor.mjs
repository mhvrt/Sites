import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium, devices, firefox, webkit } from "playwright";

const PRIVATE_REPORT_PATH = process.env.PRIVATE_REPORT_PATH || path.join(os.tmpdir(), "private-report.json");
const PUBLIC_SUMMARY_PATH = process.env.PUBLIC_SUMMARY_PATH || path.join(os.tmpdir(), "public-summary.json");

const BLOCKED_PATH_PARTS = ["/api/", "/admin", "/login", "/logout", "/checkout", "/cart", "/account", "/privacy", "/terms", "/cookie", "/wp-admin"];
const EXCLUDED_EXTERNAL_HOST_SUFFIXES = ["facebook.com", "instagram.com", "youtube.com", "youtu.be", "twitter.com", "x.com", "reddit.com", "t.me", "telegram.me", "discord.com", "discord.gg", "shopify.com"];
const ANALYTICS_HOST_SUFFIXES = ["google-analytics.com", "googletagmanager.com", "doubleclick.net", "clarity.ms", "hotjar.com", "hotjar.io", "facebook.net"];

const randomBetween = (min, max) => Math.floor(min + Math.random() * (max - min + 1));
const pick = (values) => values[randomBetween(0, values.length - 1)];
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const parseProbability = (value, fallback = 0.4) => Number.isFinite(Number(value)) ? clamp(Number(value), 0, 1) : fallback;
const hostMatchesSuffix = (hostname, suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`);
const hasBlockedPath = (url) => BLOCKED_PATH_PARTS.some((part) => url.pathname.toLowerCase().includes(part));

function requireHttpUrl(name, value) {
  if (!value) throw new Error(`missing_${name.toLowerCase()}`);
  const parsed = new URL(value);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error(`invalid_${name.toLowerCase()}`);
  return parsed;
}
const optionalHttpUrl = (name, value) => value ? requireHttpUrl(name, value) : null;

function weightedPick(items) {
  const total = items.reduce((sum, item) => sum + item.weight, 0);
  let cursor = Math.random() * total;
  for (const item of items) { cursor -= item.weight; if (cursor <= 0) return item; }
  return items[0];
}

function normalizeVisitedUrl(value) { const url = new URL(value); url.hash = ""; return url.href; }

const profiles = [
  { id: "chromium-desktop", browser: "chromium", deviceCategory: "desktop", weight: 40, context: { viewport: pick([{width:1366,height:768},{width:1440,height:900},{width:1536,height:864},{width:1920,height:1080}]), locale: "en-US" } },
  { id: "chromium-android", browser: "chromium", deviceCategory: "mobile", weight: 25, context: { ...devices["Pixel 7"], locale: "en-US" } },
  { id: "firefox-desktop", browser: "firefox", deviceCategory: "desktop", weight: 20, context: { viewport: pick([{width:1366,height:768},{width:1440,height:900},{width:1536,height:864}]), locale: "en-US" } },
  { id: "webkit-iphone", browser: "webkit", deviceCategory: "mobile", weight: 15, context: { ...devices["iPhone 13"], locale: "en-US" } },
];
const browserTypeFor = (name) => name === "firefox" ? firefox : name === "webkit" ? webkit : chromium;

async function capturePublicIp() {
  try { const r = await fetch("https://www.cloudflare.com/cdn-cgi/trace", { signal: AbortSignal.timeout(10000) }); if (!r.ok) return null; const line = (await r.text()).split("\n").find((x) => x.startsWith("ip=")); return line?.slice(3).trim() || null; } catch { return null; }
}

async function installRequestRouting(context, allowedOrigins) {
  const allowed = new Set(allowedOrigins.filter(Boolean));
  const analyticsBlocked = String(process.env.BLOCK_ANALYTICS || "true").toLowerCase() === "true";

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
            "X-Synthetic-Monitor": "1",
          },
        });
      }
    } catch {}

    await route.continue();
  });

  return analyticsBlocked;
}

async function linkMetadata(link, index, pageUrl) {
  const href = await link.getAttribute("href"); if (!href) return null;
  let resolved; try { resolved = new URL(href, pageUrl); } catch { return null; }
  if (!["http:", "https:"].includes(resolved.protocol)) return null;
  const metadata = await link.evaluate((element) => {
    const clean = (v) => String(v || "").replace(/\s+/g, " ").trim();
    const structural = element.closest("article,main,p,section,li,aside,nav,header,footer");
    const contextElement = element.closest("p,li,article,section,div");
    return { text: clean(element.innerText || element.textContent || element.getAttribute("aria-label") || element.getAttribute("title") || element.querySelector("img")?.getAttribute("alt")), structuralTag: structural?.tagName?.toLowerCase() || "unknown", context: clean(contextElement?.innerText || "").slice(0, 500) };
  }).catch(() => ({ text: "", structuralTag: "unknown", context: "" }));
  let score = ({article:50,main:45,p:35,section:20,li:5}[metadata.structuralTag] || 0);
  if (["footer","nav","header","aside"].includes(metadata.structuralTag)) score -= 100;
  const wc = metadata.text.split(/\s+/).filter(Boolean).length;
  if (wc >= 2) score += 15; if (wc >= 3) score += 10; if (metadata.text.length >= 8 && metadata.text.length <= 140) score += 10; if (metadata.context && metadata.context !== metadata.text) score += 5;
  return { index, href: resolved.href, ...metadata, score };
}

async function collectLinks(page) {
  const links = page.locator("a[href]"); const count = Math.min(await links.count(), 400); const out = [];
  for (let i=0;i<count;i++) { const link = links.nth(i); if (!(await link.isVisible().catch(() => false))) continue; const m = await linkMetadata(link, i, page.url()); if (m) out.push(m); }
  return out;
}
function chooseBest(candidates) { if (!candidates.length) return null; const sorted=[...candidates].sort((a,b)=>b.score-a.score); const top=sorted[0].score; return pick(sorted.filter((x)=>x.score>=top-8)); }
async function findLinkToOrigin(page, origin) { return chooseBest((await collectLinks(page)).filter((c)=>{try{return new URL(c.href).origin===origin;}catch{return false;}})); }
async function findHomeLink(page, origin) { return chooseBest((await collectLinks(page)).filter((c)=>{try{const u=new URL(c.href);return u.origin===origin && u.pathname.replace(/\/+$/,")")===")";}catch{return false;}})); }
async function findSecondaryLink(page, primaryOrigin, configuredOrigin) {
  const links = await collectLinks(page);
  if (configuredOrigin) return chooseBest(links.filter((c)=>{try{return new URL(c.href).origin===configuredOrigin;}catch{return false;}}));
  return chooseBest(links.filter((c)=>{try{const u=new URL(c.href); if(u.origin===primaryOrigin) return false; if(EXCLUDED_EXTERNAL_HOST_SUFFIXES.some((s)=>hostMatchesSuffix(u.hostname,s))) return false; if(["footer","nav","header","aside"].includes(c.structuralTag)) return false; return c.text.split(/\s+/).filter(Boolean).length>=2 && c.score>=20;}catch{return false;}}));
}

async function targetDocumentY(page, linkMetadataValue) {
  if (!linkMetadataValue) return null;
  return page.locator("a[href]").nth(linkMetadataValue.index).evaluate((el) => Math.max(0, Math.round(el.getBoundingClientRect().top + window.scrollY))).catch(() => null);
}

async function readPage(page, deviceCategory, nextLink = null) {
  const startedAt = Date.now();
  const viewport = page.viewportSize() || { width: 1440, height: 900 };
  const metrics = await page.evaluate(() => ({ y: window.scrollY, height: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight) }));
  const maxScroll = Math.max(0, metrics.height - viewport.height);
  const linkY = await targetDocumentY(page, nextLink);
  const randomDepth = randomBetween(55, 92) / 100;
  const desiredY = linkY == null ? Math.round(maxScroll * randomDepth) : clamp(Math.round(linkY - viewport.height * 0.45), 0, maxScroll);
  const method = deviceCategory === "desktop" ? "mouse-wheel" : "mobile-scroll";
  let maxObservedY = Math.max(0, metrics.y);

  if (deviceCategory === "desktop") await page.mouse.move(randomBetween(70, Math.max(71, viewport.width-70)), randomBetween(80, Math.max(81, viewport.height-80)), {steps:randomBetween(8,20)}).catch(()=>undefined);
  await page.waitForTimeout(randomBetween(700, 1800));

  let currentY = await page.evaluate(() => window.scrollY);
  while (currentY < desiredY - 25) {
    const remaining = desiredY - currentY;
    const step = Math.min(remaining, randomBetween(Math.max(120, Math.round(viewport.height*0.22)), Math.max(220, Math.round(viewport.height*0.62))));
    if (deviceCategory === "desktop") await page.mouse.wheel(0, step);
    else await page.evaluate((dy) => window.scrollBy({ top: dy, behavior: "smooth" }), step);
    await page.waitForTimeout(randomBetween(450, 1500));
    currentY = await page.evaluate(() => window.scrollY);
    maxObservedY = Math.max(maxObservedY, currentY);
    if (Math.random() < 0.12 && currentY > 350) {
      const back = randomBetween(80, Math.min(260, currentY));
      if (deviceCategory === "desktop") await page.mouse.wheel(0, -back);
      else await page.evaluate((dy) => window.scrollBy({ top: -dy, behavior: "smooth" }), back);
      await page.waitForTimeout(randomBetween(350, 900));
      currentY = await page.evaluate(() => window.scrollY);
    }
  }
  return { dwellMs: Date.now()-startedAt, scrollMethod: method, maxScrollPercent: maxScroll ? Math.round((maxObservedY/maxScroll)*100) : 100, targetScrollY: desiredY, targetLinkY: linkY };
}

async function collectInternalLinks(page, origin, visited) { return (await collectLinks(page)).filter((c)=>{try{const u=new URL(c.href);u.hash="";return u.origin===origin && !visited.has(normalizeVisitedUrl(u.href)) && !hasBlockedPath(u);}catch{return false;}}); }

async function clickLink(context, sourcePage, meta, expectedOrigin) {
  const link = sourcePage.locator("a[href]").nth(meta.index); const originalHref=meta.href; const destinationHref=originalHref;
  await link.scrollIntoViewIfNeeded().catch(()=>undefined);
  await link.evaluate((el, href)=>{el.removeAttribute("target");el.setAttribute("href",href);}, destinationHref);
  const same = sourcePage.waitForURL((u)=>{try{return new URL(u.toString()).origin===expectedOrigin;}catch{return false;}},{timeout:45000,waitUntil:"domcontentloaded"}).then(()=>({page:sourcePage,mode:"same-tab"})).catch(()=>null);
  const popup = context.waitForEvent("page",{timeout:45000}).then(async(p)=>{await p.waitForLoadState("domcontentloaded",{timeout:20000}).catch(()=>undefined);return new URL(p.url()).origin===expectedOrigin?{page:p,mode:"popup"}:null;}).catch(()=>null);
  await link.click({timeout:12000}); const destination=await Promise.race([same,popup]); if(!destination) throw new Error("link_navigation_timeout");
  await destination.page.waitForLoadState("domcontentloaded",{timeout:15000}).catch(()=>undefined);
  return {...destination,click:{text:meta.text,context:meta.context,structuralTag:meta.structuralTag,originalUrl:originalHref,navigatedUrl:destinationHref}};
}

async function exploreSite(context, page, origin, entryAction, deviceCategory) {
  const desiredPages=randomBetween(2,4); const visited=new Set(); const routeHistory=[]; let arrival={action:entryAction,clickedText:null,clickedUrl:null};
  for(let n=0;n<desiredPages;n++) {
    visited.add(normalizeVisitedUrl(page.url()));
    const candidates = n < desiredPages-1 ? await collectInternalLinks(page, origin, visited) : [];
    const selected = candidates.length ? pick(candidates) : null;
    const reading=await readPage(page, deviceCategory, selected);
    routeHistory.push({sequence:routeHistory.length+1,action:arrival.action,clickedText:arrival.clickedText,clickedUrl:arrival.clickedUrl,url:page.url(),title:await page.title(),documentReferrer:await page.evaluate(()=>document.referrer),...reading});
    if(!selected) break;
    const previous=page.url(); try { const d=await clickLink(context,page,selected,origin); page=d.page; if(page.url()===previous) break; arrival={action:"internal-click",clickedText:d.click.text,clickedUrl:d.click.originalUrl}; await page.waitForTimeout(randomBetween(900,2200)); } catch { break; }
  }
  return {page,routeHistory,pagesVisited:routeHistory.length,totalDwellMs:routeHistory.reduce((s,x)=>s+x.dwellMs,0)};
}

async function returnToHome(context,page,origin,deviceCategory) {
  const home=await findHomeLink(page,origin);
  if(home){await readPage(page,deviceCategory,home);const d=await clickLink(context,page,home,origin);return{page:d.page,mode:"clicked-home-link",click:d.click};}
  await page.goto(new URL("/",origin).href,{waitUntil:"domcontentloaded",timeout:40000}); return{page,mode:"direct-navigation",click:null};
}

const testId=crypto.randomUUID(); const startedAt=Date.now(); const profile=weightedPick(profiles);
const sourceValues=[process.env.SOURCE_URL_1,process.env.SOURCE_URL_2,process.env.SOURCE_URL_3].filter(Boolean);
const secondaryProbability=parseProbability(process.env.SECONDARY_CONTINUE_PROBABILITY,0.4);
const secondaryMode=["random","force","skip"].includes(process.env.SECONDARY_MODE)?process.env.SECONDARY_MODE:"random";
let browser;
let privateReport={ok:false,synthetic:true,testId,workflowRunId:process.env.GITHUB_RUN_ID||null,recordedAt:new Date().toISOString(),profileId:profile.id,browser:profile.browser,deviceCategory:profile.deviceCategory,secondaryProbability,secondaryMode};
let publicSummary={status:"failed",profile:profile.id,browser:profile.browser,deviceCategory:profile.deviceCategory,pagesVisited:0,primaryPagesVisited:0,secondarySelected:false,secondaryReached:false,secondaryPagesVisited:0,durationMs:0,errorCategory:"unknown"};

try {
  const targetUrl=requireHttpUrl("TARGET_URL",process.env.TARGET_URL); const configuredSecondaryUrl=optionalHttpUrl("SECONDARY_ORIGIN",process.env.SECONDARY_ORIGIN); if(!sourceValues.length) throw new Error("missing_source_urls"); const sourceUrl=requireHttpUrl("SOURCE_URL",pick(sourceValues));
  privateReport={...privateReport,sourceUrl:sourceUrl.href,targetUrl:targetUrl.href,configuredSecondaryOrigin:configuredSecondaryUrl?.origin||null};
  const visitorIp=await capturePublicIp(); browser=await browserTypeFor(profile.browser).launch({headless:false}); const context=await browser.newContext(profile.context); const analyticsBlocked=await installRequestRouting(context,[sourceUrl.origin,targetUrl.origin,configuredSecondaryUrl?.origin]); let page=await context.newPage();
  await page.goto(sourceUrl.href,{waitUntil:"domcontentloaded",timeout:40000}); await page.waitForTimeout(randomBetween(900,2200));
  const targetLink=await findLinkToOrigin(page,targetUrl.origin); if(!targetLink) throw new Error("target_link_not_found");
  const sourcePageTitle=await page.title(); const sourceReading=await readPage(page,profile.deviceCategory,targetLink); const primaryDestination=await clickLink(context,page,targetLink,targetUrl.origin); page=primaryDestination.page;
  const primaryEntryReferrer=await page.evaluate(()=>document.referrer); const primaryExploration=await exploreSite(context,page,targetUrl.origin,"external-entry",profile.deviceCategory); page=primaryExploration.page;
  const homeReturn=await returnToHome(context,page,targetUrl.origin,profile.deviceCategory); page=homeReturn.page; await page.waitForTimeout(randomBetween(700,1800));
  const secondarySelected=secondaryMode==="force"?true:secondaryMode==="skip"?false:Math.random()<secondaryProbability;
  let secondary={selected:secondarySelected,reached:false,origin:null,link:null,entryReferrer:null,pagesVisited:0,totalDwellMs:0,routeHistory:[],finalUrl:null,finalTitle:null};
  const secondaryLink=secondarySelected?await findSecondaryLink(page,targetUrl.origin,configuredSecondaryUrl?.origin||null):null;
  const homeReading=await readPage(page,profile.deviceCategory,secondaryLink); const primaryHomeUrl=page.url();
  if(secondarySelected){if(!secondaryLink) throw new Error("secondary_link_not_found"); const secondaryOrigin=new URL(secondaryLink.href).origin; const d=await clickLink(context,page,secondaryLink,secondaryOrigin); page=d.page; const ref=await page.evaluate(()=>document.referrer); const exp=await exploreSite(context,page,secondaryOrigin,"secondary-entry",profile.deviceCategory); page=exp.page; secondary={selected:true,reached:true,origin:secondaryOrigin,link:d.click,entryReferrer:ref,pagesVisited:exp.pagesVisited,totalDwellMs:exp.totalDwellMs,routeHistory:exp.routeHistory,finalUrl:page.url(),finalTitle:await page.title()};}
  const durationMs=Date.now()-startedAt; const totalPages=primaryExploration.pagesVisited+secondary.pagesVisited;
  privateReport={...privateReport,ok:true,analyticsBlocked,visitorIp,userAgent:await page.evaluate(()=>navigator.userAgent),sourcePageTitle,sourceReading,primary:{navigationMode:primaryDestination.mode,clickedLink:primaryDestination.click,entryReferrer:primaryEntryReferrer,pagesVisited:primaryExploration.pagesVisited,totalDwellMs:primaryExploration.totalDwellMs,routeHistory:primaryExploration.routeHistory,returnHomeMode:homeReturn.mode,returnHomeClick:homeReturn.click,homeUrl:primaryHomeUrl,homeReading},secondary,pagesVisited:totalPages,finalUrl:page.url(),finalTitle:await page.title(),durationMs};
  publicSummary={status:"success",profile:profile.id,browser:profile.browser,deviceCategory:profile.deviceCategory,pagesVisited:totalPages,primaryPagesVisited:primaryExploration.pagesVisited,secondarySelected,secondaryReached:secondary.reached,secondaryPagesVisited:secondary.pagesVisited,durationMs,errorCategory:null};
} catch(error) {
  const durationMs=Date.now()-startedAt; const errorMessage=error instanceof Error?error.message:String(error); privateReport={...privateReport,ok:false,durationMs,errorMessage};
  publicSummary={...publicSummary,durationMs,errorCategory:errorMessage.startsWith("missing_")||errorMessage.startsWith("invalid_")?"configuration":errorMessage==="target_link_not_found"?"target-link-not-found":errorMessage==="secondary_link_not_found"?"secondary-link-not-found":"navigation"};
} finally {
  await browser?.close().catch(()=>undefined); await fs.writeFile(PRIVATE_REPORT_PATH,`${JSON.stringify(privateReport,null,2)}\n`,{mode:0o600}); await fs.writeFile(PUBLIC_SUMMARY_PATH,`${JSON.stringify(publicSummary,null,2)}\n`);
}
