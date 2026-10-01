/**
 * Investigation phases shared by the full investigation (investigate.ts) and the targeted re-check engine
 * (recheck/engine.ts). A re-check must gather evidence exactly the way the original investigation did.
 */
import crypto from 'node:crypto';
import { analyzeHtml, hasDirective, xRobotsNoindex } from './analyze/html.js';
import { isHtmlResponse } from './crawl/crawler.js';
import { parseRobots, type ParsedRobots } from './crawl/robots.js';
import { parseSitemap } from './crawl/sitemap.js';
import { isSameSite, normalizeUrl } from './crawl/url.js';
import type { HostVariant, InvestigationContext } from './detect/context.js';
import { RequestBudgetExceeded, type SafeFetcher } from './net/fetcher.js';
import type { BrowserReport, FetchResult, PageFacts, RobotsInfo, SitemapInfo, WordPressInfo } from './types.js';

export async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof RequestBudgetExceeded) return fallback;
    throw e;
  }
}

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return Math.round(v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2);
}

export const emptyWordPress = (): WordPressInfo => ({
  detected: false,
  signals: [],
  version: null,
  versionSource: null,
  theme: null,
  plugins: [],
  restApi: { available: false, status: null, userEnumeration: { exposed: false, count: 0 } },
  xmlrpc: { status: null, enabled: false },
});

export const emptyBrowser = (): BrowserReport => ({ available: false, consoleErrors: [], pageErrors: [], failedRequests: [], largeImages: [], mixedContent: [], thirdPartyDomains: [], blockedBySsrf: [] });

/** Homepage fetch; a 5xx or network error is re-requested once before it is believed. */
export async function fetchHomepage(fetcher: SafeFetcher, url: string, retryDelayMs = 1500): Promise<FetchResult> {
  let homepage = await fetcher.fetch(url);
  if (homepage.status === 0 || homepage.status >= 500) {
    await new Promise((r) => setTimeout(r, retryDelayMs));
    homepage = await fetcher.fetch(url);
  }
  return homepage;
}

export const isReachable = (homepage: FetchResult) => homepage.status >= 200 && homepage.status < 400 && isHtmlResponse(homepage);

/** The input URL plus the http:// root and the alternate www/non-www root. */
export async function probeVariants(fetcher: SafeFetcher, inputUrl: string, homepage: FetchResult, home: PageFacts | null): Promise<HostVariant[]> {
  const variants: HostVariant[] = [{ label: 'homepage (as entered)', url: inputUrl, result: homepage, canonical: home?.canonical ?? null }];
  if (homepage.status <= 0) return variants;
  const final = new URL(homepage.finalUrl);
  const probes: { label: string; url: string }[] = [];
  if (final.protocol === 'https:') probes.push({ label: 'http:// homepage', url: `http://${final.host}/` });
  const altHost = final.hostname.startsWith('www.') ? final.hostname.slice(4) : `www.${final.hostname}`;
  probes.push({ label: 'alternate host', url: `${final.protocol}//${altHost}${final.port ? `:${final.port}` : ''}/` });
  for (const p of probes) {
    if (normalizeUrl(p.url) === normalizeUrl(inputUrl)) continue;
    const res = await safe(() => fetcher.fetch(p.url, { maxBytes: 512 * 1024 }), null as FetchResult | null).catch(() => null);
    let canonicalUrl: string | null = null;
    if (res && res.status >= 200 && res.status < 300 && isHtmlResponse(res)) canonicalUrl = analyzeHtml(res, 0).canonical;
    if (res) res.body = '';
    variants.push({ label: p.label, url: p.url, result: res, canonical: canonicalUrl });
  }
  return variants;
}

export async function fetchRobots(fetcher: SafeFetcher, origin: string, notes: string[]): Promise<{ robots: RobotsInfo; robotsParsed: ParsedRobots | null }> {
  const robots: RobotsInfo = { url: `${origin}/robots.txt`, status: null, fetched: false, body: '', sitemaps: [], starRules: [], syntaxWarnings: [] };
  let robotsParsed: ParsedRobots | null = null;
  const r = await safe(() => fetcher.fetch(robots.url, { maxBytes: 512 * 1024 }), null as FetchResult | null);
  if (r) {
    robots.status = r.status;
    const isText = !/text\/html/i.test(r.headers['content-type'] ?? '') && !/^\s*<(!doctype|html)/i.test(r.body);
    if (r.status === 200 && isText) {
      robots.fetched = true;
      robots.body = r.body.slice(0, 20_000);
      robotsParsed = parseRobots(r.body);
      robots.sitemaps = robotsParsed.sitemaps;
      robots.syntaxWarnings = robotsParsed.warnings.slice(0, 20);
      robots.starRules = robotsParsed.groups.filter((g) => g.agents.includes('*')).flatMap((g) => g.rules);
    } else if (r.status === 200) {
      notes.push('robots.txt returned an HTML page instead of a text file; treated as absent.');
    }
  }
  return { robots, robotsParsed };
}

/** Sitemap discovery: robots `Sitemap:` lines, then the common default locations. Indexes follow up to 2 children. */
export async function fetchSitemaps(fetcher: SafeFetcher, origin: string, siteUrl: string, robots: RobotsInfo, minRemaining = 60): Promise<SitemapInfo> {
  const sitemap: SitemapInfo = { discoveredFrom: [], fetched: [], urls: [], duplicates: [], httpUrlsOnHttpsSite: [], sampleChecks: [] };
  const queue: string[] = [];
  for (const s of robots.sitemaps) {
    if (isSameSite(s, siteUrl) && queue.length < 3) {
      queue.push(s);
      sitemap.discoveredFrom.push(`robots.txt: ${s}`);
    }
  }
  if (!queue.length) {
    queue.push(`${origin}/sitemap.xml`);
    sitemap.discoveredFrom.push('default location /sitemap.xml');
  }
  const seenLoc = new Set<string>();
  const fallbacks = [`${origin}/sitemap_index.xml`, `${origin}/wp-sitemap.xml`];
  let childBudget = 2;
  while (queue.length && fetcher.remaining() > minRemaining) {
    const url = queue.shift()!;
    const res = await safe(() => fetcher.fetch(url, { maxBytes: 5 * 1024 * 1024 }), null as FetchResult | null);
    if (!res) break;
    const parsed = res.ok ? parseSitemap(res.body, res.headers['content-type']) : { kind: 'error' as const, locs: [], error: res.error };
    sitemap.fetched.push({ url, status: res.status, kind: parsed.kind, urlCount: parsed.locs.length, ...(parsed.error ? { error: parsed.error } : {}) });
    if (parsed.kind === 'index') {
      const children = [...parsed.locs].sort((a, b) => Number(/page/i.test(b)) - Number(/page/i.test(a)));
      for (const c of children) if (childBudget-- > 0 && isSameSite(c, siteUrl)) queue.push(c);
    } else if (parsed.kind === 'urlset') {
      for (const loc of parsed.locs) {
        const key = normalizeUrl(loc);
        if (!key) continue;
        if (seenLoc.has(key)) sitemap.duplicates.push(loc);
        else if (sitemap.urls.length < 5000) {
          seenLoc.add(key);
          sitemap.urls.push(loc);
        }
      }
    }
    // Nothing usable yet and nothing declared: try the common CMS locations once.
    if (!queue.length && !robots.sitemaps.length && !sitemap.fetched.some((f) => f.kind === 'urlset' || f.kind === 'index') && fallbacks.length) {
      queue.push(fallbacks.shift()!);
    }
  }
  if (siteUrl.startsWith('https:')) sitemap.httpUrlsOnHttpsSite = sitemap.urls.filter((u) => u.startsWith('http://'));
  return sitemap;
}

/**
 * Status-checks a sample of sitemap URLs: crawled pages are reused, `priority` URLs (e.g. the ones that failed
 * before) are checked first, then the sample is spread across the rest of the sitemap.
 */
export async function sampleSitemap(
  fetcher: SafeFetcher,
  sitemap: SitemapInfo,
  siteUrl: string,
  crawledPages: PageFacts[],
  sampleSize: number,
  priority: string[] = [],
): Promise<void> {
  const crawledByKey = new Map(crawledPages.map((p) => [normalizeUrl(p.url)!, p]));
  const listed = sitemap.urls.filter((u) => isSameSite(u, siteUrl));
  const done = new Set<string>();
  for (const loc of listed.slice(0, 200)) {
    if (sitemap.sampleChecks.length >= sampleSize) break;
    const key = normalizeUrl(loc)!;
    const page = crawledByKey.get(key);
    if (page) {
      done.add(key);
      sitemap.sampleChecks.push({ url: loc, status: page.status, finalUrl: page.finalUrl, noindex: hasDirective(page.metaRobots, 'noindex') || xRobotsNoindex(page.xRobotsTag), canonical: page.canonical });
    }
  }
  const check = async (loc: string) => {
    const r = await safe(() => fetcher.fetch(loc, { maxBytes: 1024 * 1024 }), null as FetchResult | null);
    if (!r) return false;
    const facts = r.ok && isHtmlResponse(r) ? analyzeHtml(r, 1) : null;
    done.add(normalizeUrl(loc)!);
    sitemap.sampleChecks.push({ url: loc, status: r.status, finalUrl: r.finalUrl, noindex: !!facts && (hasDirective(facts.metaRobots, 'noindex') || xRobotsNoindex(facts.xRobotsTag)), canonical: facts?.canonical ?? null });
    return true;
  };
  const listedKeys = new Set(listed.map((u) => normalizeUrl(u)));
  for (const loc of priority) {
    const key = normalizeUrl(loc);
    if (!key || done.has(key) || !listedKeys.has(key) || sitemap.sampleChecks.length >= sampleSize || fetcher.remaining() <= 6) continue;
    if (!(await check(loc))) return;
  }
  const unsampled = listed.filter((u) => !done.has(normalizeUrl(u)!) && !crawledByKey.has(normalizeUrl(u)!));
  // Spread the sample across the sitemap rather than taking the first N.
  const step = Math.max(1, Math.floor(unsampled.length / Math.max(1, sampleSize)));
  for (let i = 0; i < unsampled.length && sitemap.sampleChecks.length < sampleSize && fetcher.remaining() > 6; i += step) {
    if (!(await check(unsampled[i]!))) return;
  }
}

/** Requests a random, guaranteed-nonexistent path. */
export async function probeSoft404(fetcher: SafeFetcher, origin: string, siteUrl: string): Promise<InvestigationContext['soft404']> {
  const probeUrl = `${origin}/wii-${crypto.randomBytes(6).toString('hex')}-page-that-does-not-exist/`;
  const r = await safe(() => fetcher.fetch(probeUrl, { maxBytes: 256 * 1024 }), null as FetchResult | null);
  if (!r || r.status <= 0) return null;
  return { url: probeUrl, status: r.status, finalUrl: r.finalUrl, redirectedToHome: r.chain.length > 1 && normalizeUrl(r.finalUrl) === normalizeUrl(siteUrl) };
}
