/**
 * Targeted re-check definitions: for each issue type, which evidence must be collected again, which detector
 * decides whether the issue still exists, and how the affected items are measured (BEFORE vs AFTER).
 *
 * `measure()` runs twice with the same code: on the full investigation context (baseline) and on the scoped
 * re-check context — so before/after rows are always computed the same way.
 */
import { hasDirective, xRobotsNoindex } from '../analyze/html.js';
import { SECURITY_HEADERS } from '../analyze/security.js';
import { matchingRule, rulesFor } from '../crawl/robots.js';
import { isSameSite, normalizeUrl, stripWww } from '../crawl/url.js';
import type { InvestigationContext } from '../detect/context.js';
import { kb, okPages } from '../detect/helpers.js';
import type { DETECTORS } from '../detect/index.js';
import type { Candidate, Measurement, PageFacts } from '../types.js';

export type BrowserMode = 'measure-mobile' | 'measure-both' | 'render-home' | 'visit';

export interface IssueProbe {
  detector: keyof typeof DETECTORS;
  /** Shown to the user: what is re-tested. */
  checks: string[];
  needs: {
    variants?: boolean;
    robots?: boolean;
    sitemap?: boolean;
    soft404?: boolean;
    security?: boolean;
    wordpress?: boolean;
    /** Re-fetch the affected pages (otherwise only the homepage). */
    pages?: boolean;
    canonicalTargets?: boolean;
    linkTargets?: boolean;
    assetTargets?: boolean;
    browser?: { mode: BrowserMode; required: boolean };
  };
  measure: (ctx: InvestigationContext, c: Candidate) => Measurement[];
}

const m = (key: string, label: string, value: string, state: Measurement['state']): Measurement => ({ key, label, value, state });
const key = (u: string) => normalizeUrl(u) ?? u;
const findPage = (ctx: InvestigationContext, url: string): PageFacts | undefined => {
  const k = key(url);
  return ctx.crawl.pages.find((p) => key(p.finalUrl) === k || key(p.url) === k);
};
const isHomeUrl = (ctx: InvestigationContext, url: string) => key(url) === key(ctx.siteUrl);
const pageList = (c: Candidate, max = 10) => [...new Set(c.affectedUrls)].slice(0, max);
const httpStatus = (s: number, err?: string) => (s ? `HTTP ${s}` : `No response${err ? ` (${err})` : ''}`);
const hopCount = (chain: { status: number }[]) => chain.filter((h) => h.status >= 300 && h.status < 400).length;
const chainValue = (chain: { url: string; status: number }[]) => chain.map((h) => `${h.url} [${h.status}]`).join(' → ');

/** Items of a finding: explicit targets, or (for results stored before targets existed) evidence values. */
function targetsOf(c: Candidate, evidenceLabel?: string): string[] {
  if (c.targets?.length) return c.targets;
  if (!evidenceLabel) return [];
  return c.evidence.filter((e) => e.label === evidenceLabel).map((e) => e.value.split('\n')[0]!.trim());
}

/** Whole-page items (canonical, robots directive…): one row per affected page, `unknown` when not fetched. */
function perPage(ctx: InvestigationContext, c: Candidate, prefix: string, label: string, fn: (p: PageFacts) => { value: string; bad: boolean }): Measurement[] {
  return pageList(c).map((u) => {
    const p = findPage(ctx, u);
    if (!p) return m(`${prefix}:${key(u)}`, `${label} — ${u}`, 'Page could not be fetched', 'unknown');
    if (p.status < 200 || p.status >= 300) return m(`${prefix}:${key(u)}`, `${label} — ${u}`, `Page returned ${httpStatus(p.status)}`, 'unknown');
    const r = fn(p);
    return m(`${prefix}:${key(u)}`, `${label} — ${u}`, r.value, r.bad ? 'bad' : 'ok');
  });
}

const homeInfo = (ctx: InvestigationContext): Measurement[] => [
  m('home-final', 'Final URL', ctx.homepage.status ? ctx.homepage.finalUrl : 'No response', 'info'),
  m('home-chain', 'Redirect chain', `${hopCount(ctx.homepage.chain)} redirect(s)${ctx.homepage.chain.length > 1 ? `: ${chainValue(ctx.homepage.chain)}` : ''}`, 'info'),
];

// ---------------------------------------------------------------- families

const homepageProbe: IssueProbe = {
  detector: 'homepageStatus',
  checks: ['Homepage HTTP status (re-requested once on failure)', 'Redirect chain'],
  needs: {},
  measure: (ctx) => {
    const r = ctx.homepage;
    const ok = r.status >= 200 && r.status < 400;
    return [m('home-status', 'Homepage response', httpStatus(r.status, r.error), ok ? 'ok' : 'bad'), ...homeInfo(ctx)];
  },
};

function variantByLabel(ctx: InvestigationContext, label: string) {
  return ctx.variants.find((v) => v.label === label);
}

const redirectsProbe = (pick: (ctx: InvestigationContext, c: Candidate) => Measurement[]): IssueProbe => ({
  detector: 'redirects',
  checks: ['Homepage as entered', 'http:// homepage', 'Alternate www/non-www host', 'Every redirect hop'],
  needs: { variants: true },
  measure: pick,
});

const canonicalProbe = (fn: (ctx: InvestigationContext, p: PageFacts) => { value: string; bad: boolean }): IssueProbe => ({
  detector: 'canonical',
  checks: ['Homepage', 'Canonical tag on each affected page', 'Canonical target status', 'Final URL', 'Redirect chain'],
  needs: { pages: true, canonicalTargets: true },
  measure: (ctx, c) => [...perPage(ctx, c, 'canonical', 'Canonical', (p) => fn(ctx, p)), ...homeInfo(ctx)],
});

const canonicalValue = (p: PageFacts) => (p.canonical ? p.canonical : '(no canonical tag)');

function robotsCheck(ctx: InvestigationContext) {
  const parsed = ctx.robotsParsed;
  const rules = parsed ? rulesFor(parsed, 'Googlebot') : [];
  const lines = ctx.robots.body.split(/\r?\n/);
  return (url: string) => {
    if (!parsed) return null;
    const u = new URL(url);
    const rule = matchingRule(rules, u.pathname + u.search);
    return rule && rule.type === 'disallow' ? (lines[rule.line - 1]?.trim() ?? `Disallow: ${rule.path}`) : null;
  };
}

function robotsState(ctx: InvestigationContext): Measurement | null {
  const rb = ctx.robots;
  if (rb.status === null) return m('robots-status', 'robots.txt', 'Could not be requested', 'unknown');
  if (rb.status >= 500) return m('robots-status', 'robots.txt', `HTTP ${rb.status} (server error)`, 'bad');
  return null;
}

const linkProbe = (redirecting: boolean): IssueProbe => ({
  detector: 'brokenLinks',
  checks: ['Source pages that contained the links', `${redirecting ? 'Redirecting' : 'Broken'} link targets (status re-requested)`, 'Whether each link is still present'],
  needs: { pages: true, linkTargets: true },
  measure: (ctx, c) =>
    targetsOf(c, 'Broken URL').slice(0, 25).map((t) => {
      const k = key(t);
      const linked = ctx.crawl.linkSources.get(k);
      const st = ctx.statuses.get(k);
      const label = `Link target — ${t}`;
      if (!st && !linked) return m(`link:${k}`, label, 'No longer linked from the re-checked source pages', 'ok');
      if (!st) return m(`link:${k}`, label, 'Status could not be checked', 'unknown');
      const firstHop = st.chain[0]?.status ?? st.status;
      const bad = redirecting
        ? firstHop >= 300 && firstHop < 400 && key(st.finalUrl) !== k
        : st.status === 404 || st.status === 410 || st.status >= 500 || st.status === 0;
      const statusText = redirecting && firstHop >= 300 && firstHop < 400 ? `HTTP ${firstHop} → ${st.finalUrl}` : httpStatus(st.status, st.error);
      if (!linked) return m(`link:${k}`, label, `${statusText} — no longer linked from the re-checked source pages`, 'ok');
      return m(`link:${k}`, label, `${statusText} — linked from ${linked.length} page(s)`, bad ? 'bad' : 'ok');
    }),
});

function sitemapItems(ctx: InvestigationContext, c: Candidate, criterion: 'error' | 'redirect' | 'noindex'): Measurement[] {
  const sm = ctx.sitemap;
  const anyValid = sm.fetched.some((f) => f.kind === 'urlset' || f.kind === 'index');
  const listed = new Set(sm.urls.map(key));
  return targetsOf(c).slice(0, 20).map((t) => {
    const k = key(t);
    const label = `Sitemap URL — ${t}`;
    if (!anyValid) return m(`sm:${k}`, label, 'Sitemap could not be read', 'unknown');
    if (!listed.has(k)) return m(`sm:${k}`, label, 'No longer listed in the sitemap', 'ok');
    const chk = sm.sampleChecks.find((x) => key(x.url) === k);
    if (!chk) return m(`sm:${k}`, label, 'Listed; status not re-checked', 'unknown');
    if (criterion === 'error') return m(`sm:${k}`, label, httpStatus(chk.status), chk.status >= 400 || chk.status === 0 ? 'bad' : 'ok');
    if (criterion === 'redirect') {
      const redir = key(chk.finalUrl) !== k;
      return m(`sm:${k}`, label, redir ? `Redirects → ${chk.finalUrl}` : `${httpStatus(chk.status)} (no redirect)`, redir ? 'bad' : 'ok');
    }
    return m(`sm:${k}`, label, chk.noindex ? 'noindex' : 'indexable (no noindex)', chk.noindex ? 'bad' : 'ok');
  });
}

const sitemapProbe = (fn: IssueProbe['measure']): IssueProbe => ({
  detector: 'sitemap',
  checks: ['robots.txt Sitemap declarations', 'Sitemap XML', 'Previously failing sitemap URLs'],
  needs: { robots: true, sitemap: true },
  measure: fn,
});

const PROBES: Record<string, IssueProbe> = {
  'homepage-error': homepageProbe,
  'homepage-blocked': homepageProbe,

  'redirect-loop': redirectsProbe((ctx, c) => {
    const v = ctx.variants.find((x) => key(x.url) === key(c.affectedUrls[0] ?? '')) ?? ctx.variants.find((x) => x.result?.loop);
    if (!v?.result) return [m('loop', 'Redirect loop', 'URL could not be requested', 'unknown')];
    return [m('loop', `Redirect loop — ${v.url}`, v.result.loop ? `Loop (${v.result.chain.length} hops)` : `No loop — ends at ${v.result.finalUrl} [${v.result.status}]`, v.result.loop ? 'bad' : 'ok')];
  }),
  'http-no-redirect': redirectsProbe((ctx) => {
    const v = variantByLabel(ctx, 'http:// homepage');
    if (!v?.result || v.result.status === 0) return [m('http', 'http:// homepage', v?.result ? httpStatus(0, v.result.error) : 'Not requested', 'unknown')];
    const r = v.result;
    const bad = r.status >= 200 && r.status < 300 && r.finalUrl.startsWith('http://');
    return [
      m('http', 'http:// homepage', bad ? `Served over HTTP (${httpStatus(r.status)}, no redirect)` : `Redirects → ${r.finalUrl}`, bad ? 'bad' : 'ok'),
      m('http-hops', 'Redirects from http://', String(hopCount(r.chain)), 'info'),
    ];
  }),
  'duplicate-host': redirectsProbe((ctx) => {
    const v = variantByLabel(ctx, 'alternate host');
    if (!v?.result || v.result.status === 0) return [m('alt', 'Alternate host', v?.result ? httpStatus(0, v.result.error) : 'Not requested', 'unknown')];
    const r = v.result;
    const primaryHost = new URL(ctx.siteUrl).hostname;
    const finalHost = new URL(r.finalUrl).hostname;
    const bad = r.status >= 200 && r.status < 300 && finalHost !== primaryHost && stripWww(finalHost) === stripWww(primaryHost);
    return [m('alt', `Alternate host — ${v.url}`, bad ? `Serves its own copy (${httpStatus(r.status)})` : `Redirects → ${r.finalUrl}`, bad ? 'bad' : 'ok')];
  }),
  'alt-host-tls': redirectsProbe((ctx) => {
    const v = variantByLabel(ctx, 'alternate host');
    if (!v?.result) return [m('tls', 'TLS certificate (alternate host)', 'Not requested', 'unknown')];
    const tls = v.result.status === 0 && /TLS|certificate|CERT/i.test(v.result.error ?? '');
    if (v.result.status === 0 && !tls) return [m('tls', `TLS certificate — ${v.url}`, v.result.error ?? 'No response', 'unknown')];
    return [m('tls', `TLS certificate — ${v.url}`, tls ? `Invalid: ${v.result.error}` : `Valid (${httpStatus(v.result.status)})`, tls ? 'bad' : 'ok')];
  }),

  'canonical-offsite': canonicalProbe((ctx, p) => ({ value: canonicalValue(p), bad: !!p.canonical && !isSameSite(p.canonical, ctx.siteUrl) })),
  'canonical-http': canonicalProbe((ctx, p) => ({ value: canonicalValue(p), bad: ctx.siteUrl.startsWith('https:') && !!p.canonical?.startsWith('http:') })),
  'canonical-to-home': canonicalProbe((ctx, p) => ({ value: canonicalValue(p), bad: !!p.canonical && !isHomeUrl(ctx, p.finalUrl) && isHomeUrl(ctx, p.canonical) })),
  'canonical-multiple': canonicalProbe((_ctx, p) => ({ value: `${p.canonicalCount} canonical tag(s)`, bad: p.canonicalCount > 1 })),
  'canonical-broken': canonicalProbe((ctx, p) => {
    if (!p.canonical) return { value: '(no canonical tag)', bad: false };
    const t = ctx.canonicalTargets.get(key(p.canonical)) ?? ctx.statuses.get(key(p.canonical));
    if (!t) return { value: `${p.canonical} (target is the page itself)`, bad: false };
    return { value: `${p.canonical} → ${httpStatus(t.status, t.error)}`, bad: t.status >= 400 || t.status === 0 };
  }),

  'noindex-important': {
    detector: 'noindex',
    checks: ['Homepage', 'Robots meta tag and X-Robots-Tag header on each affected page'],
    needs: { pages: true },
    measure: (ctx, c) =>
      perPage(ctx, c, 'noindex', 'Robots directive', (p) => {
        const meta = hasDirective(p.metaRobots, 'noindex');
        const header = xRobotsNoindex(p.xRobotsTag);
        return {
          value: meta ? `<meta name="robots" content="${p.metaRobots}">` : header ? `X-Robots-Tag: ${p.xRobotsTag}` : 'No noindex directive',
          bad: meta || header,
        };
      }),
  },

  'robots-5xx': {
    detector: 'robotsBlocking',
    checks: ['robots.txt status'],
    needs: { robots: true },
    measure: (ctx) => {
      const s = ctx.robots.status;
      return [m('robots-status', 'robots.txt', s === null ? 'Could not be requested' : `HTTP ${s}`, s === null ? 'unknown' : s >= 500 ? 'bad' : 'ok')];
    },
  },
  'robots-blocks-important': {
    detector: 'robotsBlocking',
    checks: ['robots.txt', 'Googlebot rules for the homepage and each blocked navigation URL'],
    needs: { robots: true },
    measure: (ctx, c) => {
      const st = robotsState(ctx);
      if (st) return [st];
      const check = robotsCheck(ctx);
      return pageList(c).map((u) => {
        const rule = check(u);
        return m(`robots:${key(u)}`, `Googlebot access — ${u}`, rule ? `Blocked by "${rule}"` : ctx.robots.fetched ? 'Allowed' : `Allowed (no robots.txt rules, HTTP ${ctx.robots.status})`, rule ? 'bad' : 'ok');
      });
    },
  },
  'robots-blocks-assets': {
    detector: 'robotsBlocking',
    checks: ['robots.txt', 'Googlebot rules for the CSS/JS files used by the homepage'],
    needs: { robots: true },
    measure: (ctx, c) => {
      const st = robotsState(ctx);
      if (st) return [st];
      const check = robotsCheck(ctx);
      return targetsOf(c).slice(0, 15).map((u) => {
        const rule = check(u);
        return m(`robots-asset:${key(u)}`, `Googlebot access — ${u}`, rule ? `Blocked by "${rule}"` : 'Allowed', rule ? 'bad' : 'ok');
      });
    },
  },

  'soft-404': {
    detector: 'soft404',
    checks: ['A new random, non-existent URL'],
    needs: { soft404: true },
    measure: (ctx) => {
      const s = ctx.soft404;
      if (!s) return [m('soft404', 'Non-existent URL', 'Could not be requested', 'unknown')];
      const bad = s.status >= 200 && s.status < 300 && !s.redirectedToHome;
      return [m('soft404', 'Non-existent URL returns', `HTTP ${s.status}${key(s.finalUrl) !== key(s.url) ? ` (after redirect to ${s.finalUrl})` : ''}`, bad ? 'bad' : 'ok')];
    },
  },
  'soft-404-redirect': {
    detector: 'soft404',
    checks: ['A new random, non-existent URL'],
    needs: { soft404: true },
    measure: (ctx) => {
      const s = ctx.soft404;
      if (!s) return [m('soft404', 'Non-existent URL', 'Could not be requested', 'unknown')];
      return [m('soft404', 'Non-existent URL returns', s.redirectedToHome ? `Redirects to the homepage (${s.finalUrl})` : `HTTP ${s.status}`, s.redirectedToHome ? 'bad' : 'ok')];
    },
  },

  'broken-internal-links': linkProbe(false),
  'redirecting-internal-links': linkProbe(true),

  'sitemap-declared-broken': sitemapProbe((ctx, c) => {
    const t = targetsOf(c)[0] ?? c.affectedUrls[0] ?? '';
    const declared = ctx.robots.sitemaps.some((d) => key(d) === key(t));
    const f = ctx.sitemap.fetched.find((x) => key(x.url) === key(t));
    if (!declared) {
      const valid = ctx.sitemap.fetched.find((x) => x.kind === 'urlset' || x.kind === 'index');
      return [m('sm-declared', `Declared sitemap — ${t}`, valid ? `No longer declared; robots.txt now points to a valid sitemap (${valid.url})` : 'No longer declared in robots.txt', valid ? 'ok' : 'unknown')];
    }
    if (!f) return [m('sm-declared', `Declared sitemap — ${t}`, 'Not requested', 'unknown')];
    const bad = f.status >= 400 || f.status === 0 || f.kind === 'invalid';
    return [m('sm-declared', `Declared sitemap — ${t}`, `${httpStatus(f.status, f.error)} — ${f.kind === 'urlset' || f.kind === 'index' ? `valid ${f.kind} (${f.urlCount} entries)` : f.kind}`, bad ? 'bad' : 'ok')];
  }),
  'sitemap-broken-urls': sitemapProbe((ctx, c) => sitemapItems(ctx, c, 'error')),
  'sitemap-redirects': sitemapProbe((ctx, c) => sitemapItems(ctx, c, 'redirect')),
  'sitemap-noindex': sitemapProbe((ctx, c) => sitemapItems(ctx, c, 'noindex')),
  'sitemap-http-urls': sitemapProbe((ctx, c) => {
    const sm = ctx.sitemap;
    if (!sm.fetched.some((f) => f.kind === 'urlset' || f.kind === 'index')) return [m('sm-http', 'http:// URLs in sitemap', 'Sitemap could not be read', 'unknown')];
    const listed = new Set(sm.urls.map((u) => u));
    const still = targetsOf(c).filter((t) => listed.has(t));
    return [
      m('sm-http', 'Previously listed http:// URLs still in sitemap', String(still.length), still.length ? 'bad' : 'ok'),
      m('sm-http-total', 'http:// URLs in sitemap (all)', String(sm.httpUrlsOnHttpsSite.length), 'info'),
    ];
  }),
  'sitemap-missing': sitemapProbe((ctx) => {
    const valid = ctx.sitemap.fetched.find((f) => f.kind === 'urlset' || f.kind === 'index');
    if (!ctx.sitemap.fetched.length) return [m('sm-found', 'XML sitemap', 'Not requested', 'unknown')];
    return [m('sm-found', 'XML sitemap', valid ? `Found: ${valid.url} (${valid.urlCount} entries)` : `Not found (${ctx.sitemap.fetched.map((f) => `${f.url} → ${httpStatus(f.status)}`).join('; ')})`, valid ? 'ok' : 'bad')];
  }),

  'mixed-content': {
    detector: 'assetsAndJs',
    checks: ['HTML of the affected pages for http:// resources', 'Browser network requests (when a browser is available)'],
    needs: { pages: true, browser: { mode: 'visit', required: false } },
    measure: (ctx, c) => {
      const pages = new Set(pageList(c).map(key));
      const html = ctx.crawl.pages.filter((p) => pages.has(key(p.finalUrl)) || pages.has(key(p.url))).flatMap((p) => p.mixedContent.map((x) => x.url));
      const all = [...new Set([...html, ...ctx.browser.mixedContent])];
      if (!ctx.crawl.pages.some((p) => pages.has(key(p.finalUrl)) || pages.has(key(p.url)))) return [m('mixed', 'Insecure http:// resources', 'Affected pages could not be fetched', 'unknown')];
      return [m('mixed', 'Insecure http:// resources on affected pages', all.length ? `${all.length} (e.g. ${all[0]})` : '0', all.length ? 'bad' : 'ok')];
    },
  },
  'broken-assets': {
    detector: 'assetsAndJs',
    checks: ['Each failing script/stylesheet URL (status re-requested)', 'Affected pages loaded in a browser (or their HTML, without a browser)'],
    needs: { pages: true, assetTargets: true, browser: { mode: 'visit', required: false } },
    measure: (ctx, c) =>
      targetsOf(c)
        .slice(0, 10)
        .map((t) => {
          const k = key(t);
          const label = `Asset — ${t}`;
          const failed = ctx.browser.failedRequests.find((f) => f.url === t && f.status !== null && f.status >= 400);
          const direct = ctx.statuses.get(k);
          if (ctx.browser.available) {
            if (failed) return m(`asset:${k}`, label, `HTTP ${failed.status}`, 'bad');
            if (direct && direct.status >= 400) return m(`asset:${k}`, label, `HTTP ${direct.status} (no longer requested by the page)`, 'ok');
            return m(`asset:${k}`, label, direct ? `HTTP ${direct.status}` : 'Loaded without error', 'ok');
          }
          const checked = ctx.assetChecks.find((a) => a.url === t);
          const st = direct?.status ?? checked?.status;
          if (st === undefined) return m(`asset:${k}`, label, 'Status could not be checked', 'unknown');
          if (st > 0 && st < 400) return m(`asset:${k}`, label, `HTTP ${st}`, 'ok');
          const referenced = ctx.crawl.pages.some((p) => p.scripts.some((s) => s.src === t) || p.stylesheets.some((s) => s.href === t));
          // Without a browser, an asset that is not in the HTML may still be injected by JavaScript.
          return m(`asset:${k}`, label, `${httpStatus(st)}${referenced ? '' : ' — not in the page HTML (may be loaded by JavaScript)'}`, referenced ? 'bad' : 'unknown');
        }),
  },
  'js-errors': {
    detector: 'assetsAndJs',
    checks: ['Affected pages loaded in a real browser', 'Uncaught JavaScript exceptions'],
    needs: { pages: true, browser: { mode: 'visit', required: true } },
    measure: (ctx, c) => {
      if (!ctx.browser.available) return [m('js', 'Uncaught JavaScript errors', 'Browser unavailable', 'unknown')];
      const pages = new Set(pageList(c, 3).map(key));
      const errs = ctx.browser.pageErrors.filter((e) => pages.has(key(e.page)));
      return [m('js', 'Uncaught JavaScript errors on affected pages', errs.length ? `${errs.length} (e.g. ${errs[0]!.message})` : '0', errs.length ? 'bad' : 'ok')];
    },
  },

  'no-viewport': {
    detector: 'mobile',
    checks: ['Homepage <meta name="viewport">'],
    needs: {},
    measure: (ctx) => (ctx.home ? [m('viewport', 'Viewport meta tag', ctx.home.viewport ? `<meta name="viewport" content="${ctx.home.viewport}">` : '(not present)', ctx.home.viewport ? 'ok' : 'bad')] : []),
  },
  'fixed-viewport': {
    detector: 'mobile',
    checks: ['Homepage <meta name="viewport">'],
    needs: {},
    measure: (ctx) => {
      if (!ctx.home) return [];
      const v = ctx.home.viewport;
      const bad = !!v && /width\s*=\s*\d{3,}/i.test(v);
      return [m('viewport', 'Viewport meta tag', v ? `<meta name="viewport" content="${v}">` : '(not present)', !v ? 'unknown' : bad ? 'bad' : 'ok')];
    },
  },
  'mobile-overflow': {
    detector: 'mobile',
    checks: ['Homepage rendered at 390px (2 runs)', 'Document width vs viewport width', 'Elements extending past the screen'],
    needs: { browser: { mode: 'measure-mobile', required: true } },
    measure: (ctx) => {
      const mm = ctx.browser.mobile;
      if (!mm) return [m('overflow', 'Mobile content width', 'Not measured (browser unavailable)', 'unknown')];
      return [
        m('overflow', 'Mobile content width', `${mm.contentWidth}px in a ${mm.viewport.width}px viewport`, mm.horizontalOverflow ? 'bad' : 'ok'),
        m('overflow-els', 'Elements extending past the viewport', mm.overflowingElements.map((e) => e.selector).slice(0, 3).join(', ') || 'none', 'info'),
      ];
    },
  },

  'slow-lcp': {
    detector: 'performance',
    checks: ['Homepage loaded in a browser: mobile (2 runs) and desktop', 'Largest Contentful Paint'],
    needs: { browser: { mode: 'measure-both', required: true } },
    measure: (ctx) => {
      const mm = ctx.browser.mobile;
      if (mm?.lcpMs == null) return [m('lcp', 'Mobile LCP (median)', 'Not measured', 'unknown')];
      return [m('lcp', 'Mobile LCP (median)', `${(mm.lcpMs / 1000).toFixed(1)} s`, mm.lcpMs > 2500 ? 'bad' : 'ok'), m('ttfb-browser', 'Mobile TTFB (browser)', mm.ttfbMs != null ? `${mm.ttfbMs} ms` : 'n/a', 'info')];
    },
  },
  'high-cls': {
    detector: 'performance',
    checks: ['Homepage loaded in a browser: mobile (2 runs) and desktop', 'Cumulative Layout Shift'],
    needs: { browser: { mode: 'measure-both', required: true } },
    measure: (ctx) => {
      const cls = ctx.browser.mobile?.cls;
      if (cls == null) return [m('cls', 'Mobile CLS', 'Not measured', 'unknown')];
      return [m('cls', 'Mobile CLS', String(cls), cls > 0.1 ? 'bad' : 'ok')];
    },
  },
  'slow-server': {
    detector: 'performance',
    checks: ['Server response time (TTFB) of the affected pages'],
    needs: { pages: true },
    measure: (ctx) => {
      const ok = okPages(ctx);
      if (ok.length < 3) return [m('ttfb', 'Median TTFB', `Only ${ok.length} page(s) could be measured`, 'unknown')];
      const med = ctx.medianTtfbMs ?? 0;
      return [m('ttfb', `Median TTFB (${ok.length} pages)`, `${(med / 1000).toFixed(1)} s`, med > 1500 ? 'bad' : 'ok')];
    },
  },
  'no-compression': {
    detector: 'performance',
    checks: ['Homepage response headers (Content-Encoding)'],
    needs: {},
    measure: (ctx) => {
      const enc = ctx.homepage.headers['content-encoding'];
      const bad = !enc && ctx.homepage.bodyBytes > 20 * 1024;
      return [m('encoding', 'Content-Encoding', enc ?? '(none)', bad ? 'bad' : 'ok'), m('html-size', 'HTML size (decoded)', kb(ctx.homepage.bodyBytes), 'info')];
    },
  },
  'huge-html': {
    detector: 'performance',
    checks: ['Homepage HTML size'],
    needs: {},
    measure: (ctx) => [m('html-size', 'Homepage HTML size', kb(ctx.homepage.bodyBytes), ctx.homepage.bodyBytes > 1.5 * 1024 * 1024 ? 'bad' : 'ok')],
  },
  'heavy-images': {
    detector: 'performance',
    checks: ['Homepage loaded in a browser (mobile and desktop)', 'Byte size and dimensions of the flagged images'],
    needs: { browser: { mode: 'measure-both', required: true } },
    measure: (ctx, c) => {
      if (!ctx.browser.available) return [m('img', 'Oversized images', 'Browser unavailable', 'unknown')];
      return targetsOf(c).slice(0, 8).map((t) => {
        const i = ctx.browser.largeImages.find((x) => x.url === t);
        if (!i) return m(`img:${key(t)}`, `Image — ${t}`, 'Under 300 KB or no longer loaded', 'ok');
        const heavy = i.bytes > 1024 * 1024 || (i.bytes > 400 * 1024 && !!i.naturalWidth && !!i.renderedWidth && i.naturalWidth > i.renderedWidth * 2.5);
        return m(`img:${key(t)}`, `Image — ${t}`, `${kb(i.bytes)}, natural ${i.naturalWidth ?? '?'}px, displayed ${i.renderedWidth ?? '?'}px`, heavy ? 'bad' : 'ok');
      });
    },
  },
  'render-blocking': {
    detector: 'performance',
    checks: ['Homepage <head>: synchronous scripts and stylesheets'],
    needs: {},
    measure: (ctx) => {
      if (!ctx.home) return [];
      const blocking = ctx.home.scripts.filter((s) => s.inHead && !s.async && !s.defer && !s.module).length;
      const css = ctx.home.stylesheets.filter((s) => !s.media || s.media === 'all' || s.media === 'screen').length;
      return [m('blocking', 'Render-blocking scripts / stylesheets', `${blocking} / ${css}`, blocking >= 10 || blocking + css >= 25 ? 'bad' : 'ok')];
    },
  },

  'sensitive-file': {
    detector: 'security',
    checks: ['Each exposed file path (first bytes only, never stored)'],
    needs: { security: true },
    measure: (ctx, c) =>
      targetsOf(c).map((p) => {
        const f = ctx.security.sensitiveFiles.find((x) => x.path === p);
        if (!f) return m(`file:${p}`, `File — ${p}`, 'Not requested', 'unknown');
        return m(`file:${p}`, `File — ${p}`, f.exposed ? `HTTP ${f.status} — publicly accessible` : `HTTP ${f.status} — not accessible`, f.exposed ? 'bad' : 'ok');
      }),
  },
  'directory-listing': {
    detector: 'security',
    checks: ['Each listed directory URL'],
    needs: { security: true },
    measure: (ctx, c) =>
      targetsOf(c).map((u) => {
        const d = ctx.security.directoryListing.find((x) => x.url === u);
        if (!d) return m(`dir:${key(u)}`, `Directory — ${u}`, 'Not requested', 'unknown');
        return m(`dir:${key(u)}`, `Directory — ${u}`, d.listed ? '"Index of" page returned' : 'No listing', d.listed ? 'bad' : 'ok');
      }),
  },
  'php-eol': {
    detector: 'security',
    checks: ['Homepage X-Powered-By header'],
    needs: { security: true },
    measure: (ctx) => {
      const v = ctx.security.serverHeaders['x-powered-by'] ?? '';
      const php = /PHP\/(\d+)\.(\d+)/i.exec(v);
      const eol = !!php && (Number(php[1]) < 8 || (Number(php[1]) === 8 && Number(php[2]) < 2));
      return [m('php', 'X-Powered-By', v || '(not sent)', eol ? 'bad' : 'ok')];
    },
  },
  'security-headers': {
    detector: 'security',
    checks: ['Homepage response headers'],
    needs: { security: true },
    measure: (ctx) =>
      SECURITY_HEADERS.map((h) => {
        const present = ctx.homepage.headers[h] != null;
        // HSTS decides on its own; the other headers count together (see the security detector).
        const state: Measurement['state'] = h === 'strict-transport-security' ? (present ? 'ok' : 'bad') : 'info';
        return m(`hdr:${h}`, h, present ? 'present' : 'missing', state);
      }),
  },
  'wp-user-enum': {
    detector: 'security',
    checks: ['/wp-json/wp/v2/users (record count only)'],
    needs: { wordpress: true },
    measure: (ctx) => {
      const r = ctx.wordpress.restApi;
      if (r.status === null) return [m('users', 'Public user list', 'REST API could not be requested', 'unknown')];
      return [m('users', 'Public user list', r.userEnumeration.exposed ? `${r.userEnumeration.count}+ user records` : 'Not exposed', r.userEnumeration.exposed ? 'bad' : 'ok')];
    },
  },

  'home-no-title': {
    detector: 'onPage',
    checks: ['Homepage <title>'],
    needs: {},
    measure: (ctx) => (ctx.home ? [m('title', 'Homepage <title>', ctx.home.title ?? '(missing)', ctx.home.title ? 'ok' : 'bad')] : []),
  },
  'duplicate-titles': {
    detector: 'onPage',
    checks: ['<title> of each affected page'],
    needs: { pages: true },
    measure: (ctx, c) => {
      const titles = pageList(c).map((u) => findPage(ctx, u)?.title?.toLowerCase() ?? null);
      return perPage(ctx, c, 'title', 'Title', (p) => ({
        value: p.title ?? '(none)',
        bad: !!p.title && titles.filter((t) => t === p.title!.toLowerCase()).length >= 2,
      }));
    },
  },
  'invalid-jsonld': {
    detector: 'onPage',
    checks: ['JSON-LD blocks on each affected page (strict parse)'],
    needs: { pages: true },
    measure: (ctx, c) =>
      perPage(ctx, c, 'jsonld', 'Invalid JSON-LD blocks', (p) => {
        const bad = p.jsonLd.filter((j) => !j.valid);
        return { value: bad.length ? `${bad.length} (${bad[0]!.error ?? 'parse error'})` : `0 of ${p.jsonLd.length}`, bad: bad.length > 0 };
      }),
  },
  'duplicate-schema': {
    detector: 'onPage',
    checks: ['Homepage JSON-LD @type values'],
    needs: {},
    measure: (ctx) => {
      if (!ctx.home) return [];
      const types = ctx.home.jsonLd.flatMap((j) => j.types);
      const org = types.filter((t) => t === 'Organization' || t === 'LocalBusiness').length;
      const site = types.filter((t) => t === 'WebSite').length;
      return [m('schema', 'Organization / WebSite entities', `${org} / ${site}`, org > 1 || site > 1 ? 'bad' : 'ok')];
    },
  },
  'missing-alt': {
    detector: 'onPage',
    checks: ['Homepage <img> alt attributes'],
    needs: {},
    measure: (ctx) => {
      if (!ctx.home) return [];
      const imgs = ctx.home.images;
      const noAlt = imgs.filter((i) => i.alt === null).length;
      return [m('alt', 'Homepage images without alt', `${noAlt} of ${imgs.length}`, imgs.length >= 5 && noAlt / imgs.length >= 0.5 ? 'bad' : 'ok')];
    },
  },
  'no-lang': {
    detector: 'onPage',
    checks: ['Homepage <html lang>'],
    needs: {},
    measure: (ctx) => (ctx.home ? [m('lang', '<html lang>', ctx.home.lang ?? '(missing)', ctx.home.lang ? 'ok' : 'bad')] : []),
  },
  'no-og-image': {
    detector: 'onPage',
    checks: ['Homepage Open Graph / Twitter image tags'],
    needs: {},
    measure: (ctx) => {
      if (!ctx.home) return [];
      const img = ctx.home.og['og:image'] ?? ctx.home.twitter['twitter:image'];
      return [m('og', 'og:image', img ?? '(missing)', img ? 'ok' : 'bad')];
    },
  },
  'missing-h1': {
    detector: 'onPage',
    checks: ['<h1> in the served HTML of the affected pages', 'Homepage rendered in a browser (H1 after JavaScript)'],
    needs: { pages: true, browser: { mode: 'render-home', required: false } },
    measure: (ctx, c) => {
      const rendered = Math.max(ctx.browser.desktop?.renderedH1Count ?? 0, ctx.browser.mobile?.renderedH1Count ?? 0);
      return perPage(ctx, c, 'h1', 'H1 count', (p) => {
        const isHome = isHomeUrl(ctx, p.finalUrl);
        const count = isHome ? Math.max(p.h1.length, rendered) : p.h1.length;
        return { value: String(count), bad: count === 0 };
      });
    },
  },
};

export function probeFor(issueId: string): IssueProbe | null {
  if (issueId.startsWith('redirect-chain-')) {
    const label = (ctx: InvestigationContext) => ctx.variants.find((v) => `redirect-chain-${v.label.replace(/\W+/g, '-')}` === issueId);
    return redirectsProbe((ctx) => {
      const v = label(ctx);
      if (!v?.result || v.result.status === 0) return [m('chain', 'Redirect chain', v?.result ? httpStatus(0, v.result.error) : 'Not requested', 'unknown')];
      const r = v.result;
      const hops = hopCount(r.chain);
      const downgrade = r.chain.some((h, i) => i > 0 && h.url.startsWith('http://') && r.chain[i - 1]!.url.startsWith('https://'));
      return [
        m('chain-hops', `Redirects — ${v.url}`, `${hops}${downgrade ? ' (includes an HTTPS → HTTP hop)' : ''}`, hops >= 3 || downgrade ? 'bad' : 'ok'),
        m('chain', 'Redirect chain', chainValue(r.chain), 'info'),
      ];
    });
  }
  return PROBES[issueId] ?? null;
}

/** Baseline/current measurements for an issue. Never throws: a measurement bug must not break an investigation. */
export function measureIssue(ctx: InvestigationContext, c: Candidate): Measurement[] {
  try {
    return probeFor(c.id)?.measure(ctx, c) ?? [];
  } catch {
    return [];
  }
}
