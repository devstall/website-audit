import { analyzeHtml } from './analyze/html.js';
import { investigateSecurity } from './analyze/security.js';
import { runSecurityScan } from './analyze/securityscan.js';
import { buildCommerceReport, discoverStore, type StoreDiscovery } from './ecommerce/index.js';
import * as cheerio from 'cheerio';
import { extractCommerce, mergeFacts } from './ecommerce/extract.js';
import { DEVICES, productProbe, renderedHtml, responsiveCheck } from './ecommerce/probe.js';
import { investigateWordPress } from './analyze/wordpress.js';
import { BrowserSession } from './browser/browser.js';
import { DEFAULT_LIMITS, ROBOTS_AGENT, type CrawlLimits } from './config.js';
import { crawlSite, statusOf, type UrlStatus } from './crawl/crawler.js';
import { isAllowed } from './crawl/robots.js';
import { crawlFilter, isSameSite, normalizeInputUrl, normalizeUrl } from './crawl/url.js';
import type { InvestigationContext } from './detect/context.js';
import { runDetectors } from './detect/index.js';
import { rankCandidates, selectPrimary } from './detect/rank.js';
import { SafeFetcher } from './net/fetcher.js';
import { emptyBrowser, emptyWordPress, fetchHomepage, fetchRobots, fetchSitemaps, isReachable, median, probeSoft404, probeVariants, safe, sampleSitemap } from './phases.js';
import { measureIssue } from './recheck/probes.js';
import { assertPublicUrl, DEFAULT_POLICY, type NetworkPolicy } from './security/ssrf.js';
import type { BrowserReport, CommerceFacts, FetchResult, InvestigationResult, ProductProbe, ResponsiveResult, ScanFocus, SitemapInfo, StepKey, StepState } from './types.js';

export interface InvestigateOptions {
  limits?: Partial<CrawlLimits>;
  /** Tests only. The HTTP API always uses DEFAULT_POLICY. */
  policy?: NetworkPolicy;
  /** Run the Playwright browser phase (default true). */
  browser?: boolean;
  screenshotDir: string;
  onProgress?: (step: StepKey, state: StepState, detail?: string) => void;
  /** 'security' runs the security & malware scan without the browser/performance phase. */
  focus?: ScanFocus;
  /** Enables the Google Safe Browsing blacklist lookup. */
  safeBrowsingKey?: string;
}

/** User-facing error (bad input, blocked target, unresolvable domain). */
export class InvestigationInputError extends Error {}

const noop = () => undefined;

export async function investigate(rawInput: string, opts: InvestigateOptions): Promise<InvestigationResult> {
  const started = Date.now();
  const progress = opts.onProgress ?? noop;
  const policy = opts.policy ?? DEFAULT_POLICY;
  const focus = opts.focus ?? 'full';
  const limits: CrawlLimits = { ...DEFAULT_LIMITS, ...opts.limits };
  const notes: string[] = [];

  // ---- 1. Discover: validate input, SSRF gate ----
  progress('discover', 'running');
  let inputUrl: string;
  try {
    inputUrl = normalizeInputUrl(rawInput);
    await assertPublicUrl(inputUrl, policy);
  } catch (e) {
    progress('discover', 'failed', (e as Error).message);
    throw new InvestigationInputError((e as Error).message);
  }
  progress('discover', 'done', inputUrl);

  const fetcher = new SafeFetcher(limits, policy);
  let browserSession: BrowserSession | null = null;
  try {
    // ---- 2. Homepage ----
    progress('homepage', 'running');
    const homepage = await fetchHomepage(fetcher, inputUrl);
    const reachable = isReachable(homepage);
    const siteUrl = homepage.status > 0 ? homepage.finalUrl : inputUrl;
    const origin = new URL(siteUrl).origin;
    const home = reachable ? analyzeHtml(homepage, 0) : null;
    progress('homepage', reachable ? 'done' : 'failed', `HTTP ${homepage.status || homepage.error}`);
    const variants = await probeVariants(fetcher, inputUrl, homepage, home);

    // ---- 3. robots.txt ----
    progress('robots', 'running');
    const { robots, robotsParsed } = homepage.status > 0
      ? await fetchRobots(fetcher, origin, notes)
      : { robots: { url: `${origin}/robots.txt`, status: null, fetched: false, body: '', sitemaps: [], starRules: [], syntaxWarnings: [] }, robotsParsed: null };
    progress('robots', homepage.status > 0 ? 'done' : 'skipped', robots.status ? `HTTP ${robots.status}` : undefined);

    // ---- 4. Sitemap ----
    progress('sitemap', 'running');
    const sitemap: SitemapInfo = reachable
      ? await fetchSitemaps(fetcher, origin, siteUrl, robots)
      : { discoveredFrom: [], fetched: [], urls: [], duplicates: [], httpUrlsOnHttpsSite: [], sampleChecks: [] };
    progress('sitemap', reachable ? 'done' : 'skipped', `${sitemap.urls.length} URLs`);

    // ---- 5. Crawl ----
    progress('links', 'running');
    const crawl = reachable
      ? await crawlSite({
          fetcher,
          homepage,
          robots: robotsParsed,
          sitemapUrls: sitemap.urls.filter((u) => isSameSite(u, siteUrl)),
          maxPages: limits.maxPages,
          maxDepth: limits.maxDepth,
          reserveRequests: Math.round(limits.maxRequests * 0.5),
          onPage: (p) => progress('links', 'running', `Crawled ${p.finalUrl}`),
        })
      : { pages: home ? [home] : [], statuses: new Map<string, UrlStatus>(), linkSources: new Map(), skipped: [], robotsBlocked: [] };
    if (crawl.robotsBlocked.length) notes.push(`${crawl.robotsBlocked.length} URL(s) were not crawled because robots.txt disallows them.`);
    const statuses = new Map(crawl.statuses);

    // Soft-404 probe.
    const soft404 = reachable ? await probeSoft404(fetcher, origin, siteUrl) : null;

    // ---- 6. Security + WordPress (fixed, small request cost) ----
    progress('wordpress', 'running');
    const wordpress = reachable
      ? await investigateWordPress({ fetcher, origin, pages: crawl.pages, homepage })
      : emptyWordPress();
    progress('wordpress', 'done', wordpress.detected ? 'WordPress detected' : 'WordPress not detected');
    progress('security', 'running');
    const security = homepage.status > 0
      ? await investigateSecurity(fetcher, origin, homepage, wordpress.detected)
      : { headers: {}, serverHeaders: {}, sensitiveFiles: [], directoryListing: [] };
    progress('security', 'running', 'Malware signatures, blacklist, SSL, email spoofing, software versions');
    const securityScan = reachable
      ? await runSecurityScan({ fetcher, homepage, siteUrl, pages: crawl.pages, wordpress, policy, ...(opts.safeBrowsingKey ? { safeBrowsingKey: opts.safeBrowsingKey } : {}) })
      : undefined;
    progress('security', 'done', securityScan ? `${securityScan.malware.filter((m) => m.confidence !== 'Low').length} malware signal(s) on ${securityScan.pagesScanned} pages` : undefined);

    // E-commerce: locate product/category pages and the platform (read-only).
    let store: StoreDiscovery | null = null;
    if (focus === 'ecommerce' && reachable) {
      progress('seo', 'running', 'Finding product and category pages');
      store = await discoverStore(fetcher, crawl.pages, sitemap.urls, siteUrl);
      progress('seo', 'running', store.isStore ? `${store.platform ?? 'Online store'} · ${store.products.length} product page(s)` : 'No online store detected');
    }

    // Canonical targets that were not crawled.
    const canonicalTargets = new Map<string, UrlStatus>();
    for (const p of crawl.pages) {
      if (!p.canonical || canonicalTargets.size >= 5) continue;
      const key = normalizeUrl(p.canonical);
      if (!key || !isSameSite(key, siteUrl)) continue;
      const known = statuses.get(key);
      if (known) {
        canonicalTargets.set(key, known);
        continue;
      }
      if (normalizeUrl(p.finalUrl) === key) continue;
      const r = await safe(() => fetcher.fetch(key, { skipBody: true }), null as FetchResult | null);
      if (!r) break;
      canonicalTargets.set(key, statusOf(r));
      statuses.set(key, statusOf(r));
    }

    // Internal link targets that were not crawled (nav/homepage first, then most-linked).
    const navKeys = new Set((home?.internalLinks ?? []).map((l) => normalizeUrl(l.url)));
    const toCheck = [...crawl.linkSources.entries()]
      .filter(([key]) => !statuses.has(key) && isSameSite(key, siteUrl))
      .filter(([key]) => {
        // Documents (PDF etc.) are worth a status check; login/cart/search/infinite spaces are not.
        const f = crawlFilter(key);
        return f.allowed || f.reason === 'non-HTML resource';
      })
      .filter(([key]) => !robotsParsed || isAllowed(robotsParsed, ROBOTS_AGENT, key))
      .sort(([a, sa], [b, sb]) => Number(navKeys.has(b)) - Number(navKeys.has(a)) || sb.length - sa.length)
      .slice(0, limits.linkCheckBudget);
    for (const [key] of toCheck) {
      if (fetcher.remaining() <= 8) break;
      let r = await safe(() => fetcher.fetch(key, { skipBody: true }), null as FetchResult | null);
      if (!r) break;
      if (r.status === 0 || r.status >= 500) {
        const again = await safe(() => fetcher.fetch(key, { skipBody: true }), null as FetchResult | null);
        if (again) r = again;
      }
      statuses.set(key, statusOf(r));
    }
    // Re-verify crawled pages that failed with 5xx/network errors (transient check).
    for (const [key, st] of statuses) {
      if (!(st.status === 0 || st.status >= 500) || !crawl.linkSources.has(key) || fetcher.remaining() <= 4) continue;
      const again = await safe(() => fetcher.fetch(key, { skipBody: true }), null as FetchResult | null);
      if (again) statuses.set(key, statusOf(again));
    }
    progress('links', 'done', `${crawl.pages.length} pages, ${statuses.size} URLs checked`);

    // Sitemap sample: reuse crawled pages, request a few others.
    progress('seo', 'running');
    await sampleSitemap(fetcher, sitemap, siteUrl, crawl.pages, limits.sitemapSampleSize);
    progress('seo', 'done');

    // ---- 7. Browser: performance, mobile, JavaScript ----
    const browser: BrowserReport = emptyBrowser();
    const responsive: ResponsiveResult[] = [];
    let probe: ProductProbe | null = null;
    const assetChecks: InvestigationContext['assetChecks'] = [];
    let homepageShots: { caption: string; file: string }[] = [];
    if (reachable && opts.browser !== false && focus !== 'security') {
      progress('performance', 'running', 'Launching browser');
      try {
        browserSession = await BrowserSession.start(opts.screenshotDir, policy);
        const mobile = await browserSession.measure(siteUrl, 'mobile', 2);
        progress('mobile', 'done', `content width ${mobile.contentWidth}px`);
        await browserSession.measure(siteUrl, 'desktop', 2);
        progress('performance', 'done', `mobile LCP ${mobile.lcpMs ?? 'n/a'} ms, CLS ${mobile.cls ?? 'n/a'}`);
        progress('javascript', 'running');
        const extra = (home?.internalLinks ?? []).filter((l) => l.inNav).map((l) => l.url);
        const visitList = [...new Set(extra.map((u) => normalizeUrl(u)!))]
          .filter((u) => u !== normalizeUrl(siteUrl) && (statuses.get(u)?.status ?? 200) < 400 && crawlFilter(u).allowed)
          .slice(0, 2);
        for (const u of visitList) await browserSession.visit(u);
        if (focus === 'ecommerce') {
          // Re-read store signals from the JavaScript-rendered DOM (client-rendered footers, reviews, payment icons).
          progress('mobile', 'running', 'Reading the rendered store pages');
          const rendered = [
            ...(home?.commerce ? [{ url: siteUrl, facts: home.commerce, set: (f: CommerceFacts) => (home.commerce = f) }] : []),
            ...(store?.products.slice(0, 2).map((p) => ({ url: p.url, facts: p.facts, set: (f: CommerceFacts) => (p.facts = f) })) ?? []),
          ];
          for (const target of rendered) {
            const html = await renderedHtml(browserSession, target.url);
            if (html) target.set(mergeFacts(target.facts, extractCommerce(cheerio.load(html), html, target.url)));
          }
          progress('mobile', 'running', 'Responsive check on 5 screen sizes');
          responsive.push({ url: siteUrl, label: 'Homepage', checks: await responsiveCheck(browserSession, siteUrl, 'resp-home') });
          const productUrl = store?.products[0]?.url;
          if (productUrl) {
            responsive.push({ url: productUrl, label: 'Product page', checks: await responsiveCheck(browserSession, productUrl, 'resp-product', DEVICES.slice(0, 3)) });
            progress('mobile', 'running', 'Checking the mobile product page (buy button, price, popups)');
            probe = await productProbe(browserSession, productUrl, 'product-annotated');
          }
          progress('mobile', 'done', `${responsive.reduce((a, r) => a + r.checks.length, 0)} screen/page combinations checked`);
        }
        Object.assign(browser, browserSession.report);
        progress('javascript', 'done', `${browser.pageErrors.length} uncaught errors, ${browser.failedRequests.length} failed requests`);
        homepageShots = [
          ...(browser.desktop?.screenshotFile ? [{ caption: 'Homepage — desktop (1366px)', file: browser.desktop.screenshotFile }] : []),
          ...(browser.mobile?.screenshotFile ? [{ caption: 'Homepage — mobile (390px)', file: browser.mobile.screenshotFile }] : []),
        ];
      } catch (e) {
        browser.available = false;
        browser.reason = (e as Error).message.split('\n')[0];
        notes.push(`Browser test unavailable: ${browser.reason}. Core Web Vitals could not be directly measured.`);
        for (const k of ['performance', 'mobile', 'javascript'] as StepKey[]) progress(k, 'skipped', 'Browser unavailable');
      }
    } else {
      browser.reason = !reachable ? 'Homepage not reachable' : focus === 'security' ? 'Security & malware scan only' : 'Browser phase disabled';
      for (const k of ['performance', 'mobile', 'javascript'] as StepKey[]) progress(k, 'skipped', browser.reason);
    }
    if (!browser.available && home) {
      // Fallback: check the homepage's own scripts/styles over HTTP.
      const assets = [
        ...home.scripts.map((s) => ({ url: s.src, type: 'script' as const })),
        ...home.stylesheets.map((s) => ({ url: s.href, type: 'stylesheet' as const })),
      ].filter((a) => isSameSite(a.url, siteUrl));
      for (const a of assets.slice(0, 6)) {
        const r = await safe(() => fetcher.fetch(a.url, { skipBody: true }), null as FetchResult | null);
        if (!r) break;
        assetChecks.push({ url: a.url, status: r.status, type: a.type, cacheControl: r.headers['cache-control'] ?? null, contentType: r.headers['content-type'] ?? null, page: siteUrl });
      }
    }
    if (!browser.available) browser.reason ??= 'Browser unavailable';

    // ---- 8. Analysis ----
    progress('analysis', 'running');
    const commerce = store ? buildCommerceReport(store, home, probe, responsive, browser) : undefined;
    if (commerce) notes.push(...commerce.notes);
    const okTtfb = crawl.pages.filter((p) => p.status >= 200 && p.status < 300).map((p) => p.ttfbMs);
    const ctx: InvestigationContext = {
      inputUrl,
      siteUrl,
      origin,
      homepage,
      home,
      variants,
      robots,
      robotsParsed,
      sitemap,
      crawl,
      statuses,
      canonicalTargets,
      soft404,
      assetChecks,
      wordpress,
      security,
      ...(securityScan ? { securityScan } : {}),
      ...(commerce ? { commerce } : {}),
      browser,
      medianTtfbMs: median(okTtfb),
    };
    const { candidates, errors } = runDetectors(ctx);
    for (const e of errors) notes.push(`Internal detector error (ignored): ${e}`);
    const ranked = rankCandidates(candidates);
    const primary = selectPrimary(ranked);

    // Evidence screenshots of the affected area for the selected issue.
    if (primary && browserSession) {
      const shots = primary.screenshots ? [...primary.screenshots] : [];
      if (primary.id === 'broken-internal-links') {
        const brokenHrefs = primary.evidence.filter((e) => e.label === 'Broken URL').map((e) => e.value);
        const source = primary.affectedUrls[0];
        if (source) {
          const file = await browserSession.captureAffected(source, 'affected-broken-link', { hrefs: brokenHrefs });
          if (file) shots.unshift({ caption: `Source page with the broken link outlined in red — ${source}`, file });
        }
      } else if (primary.id === 'mobile-overflow') {
        const file = await browserSession.captureAffected(siteUrl, 'affected-mobile-overflow', { mobile: true, overflow: true });
        if (file) shots.unshift({ caption: 'Mobile (390px) — elements extending past the screen outlined in red', file });
      } else {
        const affected = primary.affectedUrls[0];
        const visual = ['Broken functionality', 'Mobile usability', 'Images', 'Core Web Vitals'].includes(primary.category);
        if (visual && affected && isSameSite(affected, siteUrl) && normalizeUrl(affected) !== normalizeUrl(siteUrl)) {
          const file = await browserSession.captureAffected(affected, 'affected-page', {});
          if (file) shots.push({ caption: `Affected page — ${affected}`, file });
        }
      }
      for (const s of homepageShots) if (!shots.some((x) => x.file === s.file)) shots.push(s);
      primary.screenshots = shots;
    } else if (primary && homepageShots.length) {
      primary.screenshots = [...(primary.screenshots ?? []), ...homepageShots.filter((s) => !primary.screenshots?.some((x) => x.file === s.file))];
    }
    if (!primary) notes.push('No issue passed the evidence and confidence threshold for a primary finding.');
    progress('analysis', 'done', primary ? primary.title : 'No verified primary issue');

    const result: InvestigationResult = {
      inputUrl,
      siteUrl,
      date: new Date().toISOString().slice(0, 10),
      stats: {
        pagesAnalyzed: crawl.pages.length,
        requestsMade: fetcher.requestsMade,
        browserRequests: browserSession?.requestCount ?? 0,
        desktopTested: !!browser.desktop,
        mobileTested: !!browser.mobile,
        robotsTested: robots.status !== null,
        sitemapTested: sitemap.fetched.length > 0,
        browserTest: browser.available,
        durationMs: Date.now() - started,
      },
      wordpress,
      primary,
      ...(primary ? { baseline: measureIssue(ctx, primary) } : {}),
      candidates: ranked,
      pages: crawl.pages.map((p) => ({ url: p.url, finalUrl: p.finalUrl, status: p.status, title: p.title, ttfbMs: p.ttfbMs, htmlBytes: p.htmlBytes })),
      browser,
      homepageHeaders: homepage.headers,
      homepageChain: homepage.chain.map((h) => ({ url: h.url, status: h.status })),
      notes,
      ...(securityScan ? { securityScan } : {}),
      ...(commerce ? { commerce } : {}),
      focus,
    };
    return result;
  } finally {
    await browserSession?.close();
    await fetcher.close();
  }
}
