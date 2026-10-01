/**
 * Re-check engine: re-tests ONE previously reported issue without re-running the whole investigation.
 * It collects only the evidence that issue's probe needs, runs the same detector on it, and measures the
 * same items as the baseline. It never declares an issue resolved without fresh, sufficient evidence.
 */
import { analyzeHtml } from '../analyze/html.js';
import { investigateSecurity } from '../analyze/security.js';
import { investigateWordPress } from '../analyze/wordpress.js';
import { BrowserSession } from '../browser/browser.js';
import { DEFAULT_LIMITS, type CrawlLimits } from '../config.js';
import { isHtmlResponse, statusOf, type CrawlOutput, type UrlStatus } from '../crawl/crawler.js';
import { isSameSite, normalizeUrl } from '../crawl/url.js';
import type { InvestigationContext } from '../detect/context.js';
import { DETECTORS } from '../detect/index.js';
import { SafeFetcher } from '../net/fetcher.js';
import { emptyBrowser, fetchHomepage, fetchRobots, fetchSitemaps, isReachable, median, probeSoft404, probeVariants, safe, sampleSitemap } from '../phases.js';
import { assertPublicUrl, DEFAULT_POLICY, type NetworkPolicy } from '../security/ssrf.js';
import type { BrowserReport, FetchResult, InvestigationResult, Measurement, PageFacts, RecheckResult, RecheckStatus, SecurityInfo, SitemapInfo } from '../types.js';
import { probeFor } from './probes.js';

export interface RecheckOptions {
  policy?: NetworkPolicy;
  /** Allow the browser phase (default true). Browser-only issues become "unable to verify" without it. */
  browser?: boolean;
  screenshotDir: string;
  limits?: Partial<CrawlLimits>;
}

/** Final status from fresh evidence. Exported for tests. */
export function decideStatus(reproduced: boolean, measurements: Measurement[], blocking: string[]): RecheckStatus {
  if (reproduced || measurements.some((x) => x.state === 'bad')) return 'still-detected';
  if (blocking.length || measurements.some((x) => x.state === 'unknown') || !measurements.some((x) => x.state === 'ok')) return 'unable-to-verify';
  return 'resolved';
}

export async function recheckIssue(inv: InvestigationResult, opts: RecheckOptions): Promise<RecheckResult> {
  const started = Date.now();
  const c = inv.primary;
  if (!c) throw new Error('This investigation has no primary issue to re-check.');
  const base = { issueId: c.id, checks: [] as string[], measurements: [] as Measurement[], currentEvidence: [], requestsMade: 0, browserUsed: false };
  const unable = (reasons: string[], extra: Partial<RecheckResult> = {}): RecheckResult => ({ ...base, status: 'unable-to-verify', reasons, durationMs: Date.now() - started, ...extra });

  const probe = probeFor(c.id);
  if (!probe) return unable([`No targeted re-check exists for the issue type "${c.id}".`]);
  base.checks = probe.checks;
  const policy = opts.policy ?? DEFAULT_POLICY;
  try {
    await assertPublicUrl(inv.inputUrl, policy);
  } catch (e) {
    return unable([`The website address can no longer be checked safely: ${(e as Error).message}`]);
  }

  const needs = probe.needs;
  const fetcher = new SafeFetcher({ ...DEFAULT_LIMITS, maxRequests: 60, ...opts.limits }, policy);
  let session: BrowserSession | null = null;
  const blocking: string[] = [];
  const notes: string[] = [];
  try {
    const homepage = await fetchHomepage(fetcher, inv.inputUrl);
    const reachable = isReachable(homepage);
    if (probe.detector !== 'homepageStatus' && !reachable) {
      return unable([
        `The homepage could not be loaded for the re-check (${homepage.status ? `HTTP ${homepage.status}` : homepage.error ?? 'no response'}). ${homepage.status === 403 || homepage.status === 429 ? 'The site is likely rate-limiting or blocking automated requests; try again later.' : 'The site may be down or temporarily unavailable.'}`,
      ], { requestsMade: fetcher.requestsMade });
    }
    const siteUrl = homepage.status > 0 ? homepage.finalUrl : inv.siteUrl;
    const origin = new URL(siteUrl).origin;
    const home = reachable ? analyzeHtml(homepage, 0) : null;

    const variants = needs.variants ? await probeVariants(fetcher, inv.inputUrl, homepage, home) : [{ label: 'homepage (as entered)', url: inv.inputUrl, result: homepage, canonical: home?.canonical ?? null }];
    const { robots, robotsParsed } =
      needs.robots && homepage.status > 0
        ? await fetchRobots(fetcher, origin, notes)
        : { robots: { url: `${origin}/robots.txt`, status: null, fetched: false, body: '', sitemaps: [], starRules: [], syntaxWarnings: [] }, robotsParsed: null };

    // Affected pages (plus the homepage), fetched fresh.
    const pages: PageFacts[] = home ? [home] : [];
    const statuses = new Map<string, UrlStatus>();
    statuses.set(normalizeUrl(homepage.requestedUrl)!, statusOf(homepage));
    const linkSources: CrawlOutput['linkSources'] = new Map();
    let expected = 0;
    let fetchedOk = 0;
    if (needs.pages && reachable) {
      const urls = [...new Set(c.affectedUrls.map((u) => normalizeUrl(u)).filter((u): u is string => !!u && isSameSite(u, siteUrl)))]
        .filter((u) => u !== normalizeUrl(siteUrl) && u !== normalizeUrl(homepage.requestedUrl))
        .slice(0, 10);
      expected = urls.length;
      for (const u of urls) {
        const res = await safe(() => fetcher.fetch(u, { maxBytes: 3 * 1024 * 1024 }), null as FetchResult | null);
        if (!res) break;
        statuses.set(u, statusOf(res));
        if (res.status > 0 && isHtmlResponse(res) && isSameSite(res.finalUrl, siteUrl)) {
          pages.push(analyzeHtml(res, 1));
          if (res.status >= 200 && res.status < 300) fetchedOk++;
        }
      }
      const affectsHome = c.affectedUrls.some((u) => normalizeUrl(u) === normalizeUrl(siteUrl));
      if (expected > 0 && fetchedOk === 0 && !affectsHome) blocking.push('None of the affected pages could be fetched, so they could not be re-checked.');
      else if (fetchedOk < expected) notes.push(`${expected - fetchedOk} of ${expected} affected page(s) could not be fetched.`);
    }
    for (const p of pages) {
      if (p.status < 200 || p.status >= 300) continue;
      for (const link of p.internalLinks) {
        const k = normalizeUrl(link.url);
        if (!k) continue;
        const list = linkSources.get(k) ?? [];
        if (list.length < 10) list.push({ source: p.finalUrl, text: link.text, href: link.url });
        linkSources.set(k, list);
      }
    }

    // Previously broken/redirecting link targets and failing assets: status re-requested (5xx/timeouts twice).
    const requestTargets = async (urls: string[]) => {
      for (const t of urls.slice(0, 25)) {
        const k = normalizeUrl(t);
        if (!k || statuses.has(k) || fetcher.remaining() <= 4) continue;
        let r = await safe(() => fetcher.fetch(k, { skipBody: true }), null as FetchResult | null);
        if (!r) break;
        if (r.status === 0 || r.status >= 500) r = (await safe(() => fetcher.fetch(k, { skipBody: true }), null as FetchResult | null)) ?? r;
        statuses.set(k, statusOf(r));
      }
    };
    const targets = c.targets ?? c.evidence.filter((e) => e.label === 'Broken URL').map((e) => e.value);
    if (needs.linkTargets) await requestTargets(targets);
    if (needs.assetTargets) await requestTargets(targets);

    const canonicalTargets = new Map<string, UrlStatus>();
    if (needs.canonicalTargets) {
      for (const p of pages) {
        const k = p.canonical ? normalizeUrl(p.canonical) : null;
        if (!k || canonicalTargets.size >= 8 || !isSameSite(k, siteUrl) || k === normalizeUrl(p.finalUrl)) continue;
        const known = statuses.get(k);
        if (known) {
          canonicalTargets.set(k, known);
          continue;
        }
        const r = await safe(() => fetcher.fetch(k, { skipBody: true }), null as FetchResult | null);
        if (!r) break;
        canonicalTargets.set(k, statusOf(r));
        statuses.set(k, statusOf(r));
      }
    }

    let sitemap: SitemapInfo = { discoveredFrom: [], fetched: [], urls: [], duplicates: [], httpUrlsOnHttpsSite: [], sampleChecks: [] };
    if (needs.sitemap && reachable) {
      sitemap = await fetchSitemaps(fetcher, origin, siteUrl, robots, 20);
      await sampleSitemap(fetcher, sitemap, siteUrl, pages, Math.max(DEFAULT_LIMITS.sitemapSampleSize, Math.min(targets.length, 20)), targets);
    }
    const soft404 = needs.soft404 && reachable ? await probeSoft404(fetcher, origin, siteUrl) : null;
    const wordpress = needs.wordpress && reachable ? await investigateWordPress({ fetcher, origin, pages, homepage }) : inv.wordpress;
    const security: SecurityInfo = needs.security && homepage.status > 0 ? await investigateSecurity(fetcher, origin, homepage, wordpress.detected) : { headers: {}, serverHeaders: {}, sensitiveFiles: [], directoryListing: [] };

    // Browser, only for issues that need it.
    let browser: BrowserReport = emptyBrowser();
    const assetChecks: InvestigationContext['assetChecks'] = [];
    if (needs.browser && reachable) {
      if (opts.browser === false) {
        browser.reason = 'Browser phase disabled';
      } else {
        try {
          session = await BrowserSession.start(opts.screenshotDir, policy);
          const mode = needs.browser.mode;
          if (mode === 'measure-mobile') await session.measure(siteUrl, 'mobile', 2);
          else if (mode === 'measure-both') {
            await session.measure(siteUrl, 'mobile', 2);
            await session.measure(siteUrl, 'desktop', 1);
          } else if (mode === 'render-home') await session.measure(siteUrl, 'desktop', 1);
          else {
            const visitList = [...new Set(c.affectedUrls.filter((u) => isSameSite(u, siteUrl)))].slice(0, 3);
            let loaded = 0;
            for (const u of visitList.length ? visitList : [siteUrl]) if (await session.visit(u)) loaded++;
            if (!loaded) throw new Error('None of the affected pages loaded in the browser');
          }
          browser = { ...session.report, available: true };
          base.browserUsed = true;
        } catch (e) {
          browser = { ...emptyBrowser(), reason: (e as Error).message.split('\n')[0] };
        }
      }
      if (!browser.available) {
        const msg = `A real browser was needed for this re-check but was unavailable (${browser.reason}).`;
        if (needs.browser.required) blocking.push(msg);
        else notes.push(`${msg} Checked from the HTML instead.`);
      }
    }
    if (needs.assetTargets && !browser.available) {
      // HTTP fallback: only assets still referenced by the pages' HTML count as current failures.
      const referenced = new Set(pages.flatMap((p) => [...p.scripts.map((s) => s.src), ...p.stylesheets.map((s) => s.href)]));
      for (const t of targets) {
        const st = statuses.get(normalizeUrl(t) ?? t);
        if (st && referenced.has(t)) assetChecks.push({ url: t, status: st.status, type: /\.css(\?|$)/i.test(t) ? 'stylesheet' : 'script', cacheControl: null, contentType: st.contentType ?? null, page: pages[0]?.finalUrl ?? siteUrl });
      }
    }

    const okTtfb = pages.filter((p) => p.status >= 200 && p.status < 300).map((p) => p.ttfbMs);
    const ctx: InvestigationContext = {
      inputUrl: inv.inputUrl,
      siteUrl,
      origin,
      homepage,
      home,
      variants,
      robots,
      robotsParsed,
      sitemap,
      crawl: { pages, statuses, linkSources, skipped: [], robotsBlocked: [] },
      statuses,
      canonicalTargets,
      soft404,
      assetChecks,
      wordpress,
      security,
      browser,
      medianTtfbMs: median(okTtfb),
    };

    let found = null;
    try {
      found = DETECTORS[probe.detector]!(ctx).find((x) => x.id === c.id) ?? null;
    } catch (e) {
      blocking.push(`Internal detector error: ${(e as Error).message}`);
    }
    const measurements = probe.measure(ctx, c);
    if (!measurements.length && !found) blocking.push('No fresh evidence could be collected for this issue.');
    const status = decideStatus(!!found, measurements, blocking);
    if (fetcher.remaining() <= 0 && status === 'unable-to-verify') blocking.push('The re-check request budget was exhausted before all items were checked.');
    return {
      ...base,
      status,
      measurements,
      currentEvidence: found?.evidence ?? [],
      reasons: [...blocking, ...notes],
      requestsMade: fetcher.requestsMade,
      durationMs: Date.now() - started,
    };
  } finally {
    await session?.close();
    await fetcher.close();
  }
}
