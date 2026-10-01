import { ROBOTS_AGENT } from '../config.js';
import { analyzeHtml } from '../analyze/html.js';
import { RequestBudgetExceeded, type SafeFetcher } from '../net/fetcher.js';
import type { FetchResult, PageFacts } from '../types.js';
import { isAllowed, type ParsedRobots } from './robots.js';
import { crawlFilter, isSameSite, normalizeUrl, urlPriority } from './url.js';

export interface UrlStatus {
  url: string;
  status: number;
  finalUrl: string;
  chain: { url: string; status: number }[];
  error?: string;
  contentType?: string;
}

export interface CrawlOutput {
  pages: PageFacts[];
  /** Status of every URL requested during the crawl, keyed by normalized URL. */
  statuses: Map<string, UrlStatus>;
  /** normalized target URL → source pages linking to it (and anchor text). */
  linkSources: Map<string, { source: string; text: string; href: string }[]>;
  skipped: { url: string; reason: string }[];
  robotsBlocked: string[];
}

export interface CrawlOptions {
  fetcher: SafeFetcher;
  homepage: FetchResult;
  robots: ParsedRobots | null;
  sitemapUrls: string[];
  maxPages: number;
  maxDepth: number;
  /** Stop crawling pages when fewer than this many requests remain (reserved for other checks). */
  reserveRequests: number;
  onPage?: (page: PageFacts) => void;
}

interface QueueItem {
  url: string;
  depth: number;
  priority: number;
}

export function isHtmlResponse(res: FetchResult): boolean {
  const ct = (res.headers['content-type'] ?? '').toLowerCase();
  return ct.includes('text/html') || ct.includes('application/xhtml') || (!ct && /^\s*<(!doctype|html)/i.test(res.body));
}

export function statusOf(res: FetchResult): UrlStatus {
  return {
    url: res.requestedUrl,
    status: res.status,
    finalUrl: res.finalUrl,
    chain: res.chain.map((h) => ({ url: h.url, status: h.status })),
    ...(res.error ? { error: res.error } : {}),
    ...(res.headers['content-type'] ? { contentType: res.headers['content-type'] } : {}),
  };
}

export async function crawlSite(opts: CrawlOptions): Promise<CrawlOutput> {
  const { fetcher, homepage, robots } = opts;
  const siteUrl = homepage.finalUrl;
  const out: CrawlOutput = { pages: [], statuses: new Map(), linkSources: new Map(), skipped: [], robotsBlocked: [] };
  const queued = new Set<string>();
  const queue: QueueItem[] = [];
  const sitemapSet = new Set(opts.sitemapUrls.map((u) => normalizeUrl(u)).filter((u): u is string => !!u));

  const record = (key: string, res: FetchResult) => {
    out.statuses.set(key, statusOf(res));
    const finalKey = normalizeUrl(res.finalUrl);
    if (finalKey && finalKey !== key && !out.statuses.has(finalKey)) out.statuses.set(finalKey, { ...statusOf(res), url: res.finalUrl, chain: res.chain.slice(-1) });
  };

  const addLinks = (page: PageFacts) => {
    const fromHome = page.depth === 0;
    for (const link of page.internalLinks) {
      const key = normalizeUrl(link.url);
      if (!key) continue;
      const list = out.linkSources.get(key) ?? [];
      if (list.length < 10) list.push({ source: page.finalUrl, text: link.text, href: link.url });
      out.linkSources.set(key, list);
      enqueue(link.url, page.depth + 1, !!link.inNav, fromHome);
    }
  };

  const enqueue = (url: string, depth: number, fromNav: boolean, fromHome: boolean) => {
    const key = normalizeUrl(url);
    if (!key || queued.has(key)) return;
    if (!isSameSite(key, siteUrl)) return;
    if (depth > opts.maxDepth) return;
    const f = crawlFilter(key);
    if (!f.allowed) {
      queued.add(key);
      out.skipped.push({ url: key, reason: f.reason ?? 'filtered' });
      return;
    }
    if (robots && !isAllowed(robots, ROBOTS_AGENT, key)) {
      queued.add(key);
      out.robotsBlocked.push(key);
      return;
    }
    queued.add(key);
    queue.push({ url: key, depth, priority: urlPriority(key, fromNav, fromHome, sitemapSet.has(key)) });
  };

  // Homepage (already fetched by the caller).
  const homeKey = normalizeUrl(homepage.requestedUrl)!;
  queued.add(homeKey);
  const finalHomeKey = normalizeUrl(homepage.finalUrl);
  if (finalHomeKey) queued.add(finalHomeKey);
  record(homeKey, homepage);
  if (homepage.status > 0 && isHtmlResponse(homepage)) {
    const facts = analyzeHtml(homepage, 0);
    out.pages.push(facts);
    opts.onPage?.(facts);
    addLinks(facts);
  }
  for (const u of opts.sitemapUrls.slice(0, 200)) enqueue(u, 1, false, false);

  while (queue.length && out.pages.length < opts.maxPages) {
    if (fetcher.remaining() <= opts.reserveRequests) break;
    queue.sort((a, b) => b.priority - a.priority || a.depth - b.depth);
    const item = queue.shift()!;
    let res: FetchResult;
    try {
      res = await fetcher.fetch(item.url, { maxBytes: 3 * 1024 * 1024 });
    } catch (e) {
      if (e instanceof RequestBudgetExceeded) break;
      out.skipped.push({ url: item.url, reason: (e as Error).message });
      continue;
    }
    record(item.url, res);
    const finalKey = normalizeUrl(res.finalUrl);
    if (finalKey) {
      // A redirect onto an already-crawled page should not produce a duplicate page entry.
      if (finalKey !== item.url && out.pages.some((p) => normalizeUrl(p.finalUrl) === finalKey)) continue;
      queued.add(finalKey);
    }
    if (res.status === 0 || !isSameSite(res.finalUrl, siteUrl) || !isHtmlResponse(res)) continue;
    const facts = analyzeHtml(res, item.depth);
    out.pages.push(facts);
    opts.onPage?.(facts);
    if (res.status >= 200 && res.status < 300) addLinks(facts);
  }
  return out;
}
