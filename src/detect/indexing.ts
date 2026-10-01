import { hasDirective, xRobotsNoindex } from '../analyze/html.js';
import { matchingRule, rulesFor } from '../crawl/robots.js';
import { isSameSite, normalizeUrl } from '../crawl/url.js';
import type { Candidate, EvidenceItem } from '../types.js';
import { candidate, chainText, EFFORT, headerDump, INTENTIONAL_NOINDEX, isHome, isStagingHost, navUrls, okPages, plural, type Detector } from './helpers.js';

const LOW_VALUE_PATH = /(contact|privacy|terms|legal|cookie|imprint|impressum|disclaimer|login|log-in|signin|register|account|cart|basket|checkout|thank|search|feed|dropbox|private|tmp|wp-admin)/i;

/** Homepage unreachable / 5xx / 4xx. */
export const homepageStatus: Detector = (ctx) => {
  const r = ctx.homepage;
  if (r.status >= 200 && r.status < 400) return [];
  if (r.status === 403 || r.status === 429) {
    return [
      candidate({
        id: 'homepage-blocked',
        title: `Homepage returns HTTP ${r.status} to automated requests`,
        category: 'Crawlability',
        severity: 'Medium',
        confidence: 'Low',
        evidenceStrength: 0.5,
        scope: 1,
        summary: `The homepage answered HTTP ${r.status} to a standard crawler-style request. This is often a bot-protection rule; it may or may not affect search engine crawlers.`,
        howIdentified: 'The homepage was requested with a descriptive crawler user agent and the HTTP status was recorded.',
        evidence: [
          { label: 'URL', value: r.requestedUrl },
          { label: 'HTTP status', value: String(r.status) },
          { label: 'Response headers', value: headerDump(r.headers, ['server', 'cf-ray', 'x-sucuri-id', 'retry-after']), code: true },
        ],
        affectedUrls: [r.requestedUrl],
        whyItMatters: 'If the same rule applies to search engine crawlers, pages cannot be crawled or refreshed in the index.',
        solution: ['Review WAF/CDN bot rules and confirm that verified search engine crawlers are allowed.'],
        effort: EFFORT.small,
        verification: ['Confidence is low: bot protection frequently targets unknown user agents only, so impact on Googlebot is not proven.'],
      }),
    ];
  }
  const down = r.status === 0 || r.status >= 500;
  return [
    candidate({
      id: 'homepage-error',
      title: r.status === 0 ? `Homepage cannot be loaded (${r.error ?? 'network error'})` : `Homepage returns HTTP ${r.status}`,
      category: down ? 'Server configuration' : 'Indexing',
      severity: 'High',
      confidence: 'High',
      scope: 1,
      summary: `The homepage did not return a successful response. Visitors and search engines requesting ${r.requestedUrl} receive ${r.status === 0 ? `an error (${r.error})` : `HTTP ${r.status}`}.`,
      howIdentified: 'The homepage was requested directly and all redirects were followed. The final response status was recorded and the request was repeated to rule out a transient failure.',
      evidence: [
        { label: 'Requested URL', value: r.requestedUrl },
        { label: 'Redirect chain', value: chainText(r.chain) || r.requestedUrl, code: true },
        { label: 'Final status', value: r.status === 0 ? `No HTTP response — ${r.error}` : String(r.status) },
      ],
      affectedUrls: [r.requestedUrl],
      whyItMatters: 'A failing homepage blocks every visitor path that starts there and, if persistent, causes search engines to drop or demote the page.',
      solution: [
        'Check the web server / PHP error log at the time of the request.',
        down ? 'Verify PHP-FPM / application workers are running and not exhausted; check memory limits and fatal errors.' : 'Restore the homepage document or fix the rewrite rule producing this status.',
        'Re-test with curl -I and confirm a 200 response.',
      ],
      effort: EFFORT.small,
      verification: ['The homepage status was observed directly on the live server (and re-requested once).'],
    }),
  ];
};

/** noindex on homepage or important pages. */
export const noindex: Detector = (ctx) => {
  const nav = navUrls(ctx);
  const affected = okPages(ctx).filter((p) => hasDirective(p.metaRobots, 'noindex') || xRobotsNoindex(p.xRobotsTag));
  const important = affected.filter(
    (p) => !INTENTIONAL_NOINDEX.test(new URL(p.finalUrl).pathname) && (isHome(ctx, p.finalUrl) || nav.has(normalizeUrl(p.finalUrl)!) || p.depth <= 1),
  );
  if (!important.length) return [];
  const home = important.find((p) => isHome(ctx, p.finalUrl));
  const staging = isStagingHost(ctx.siteUrl);
  const evidence: EvidenceItem[] = important.slice(0, 5).flatMap((p) => [
    { label: 'Page', value: p.finalUrl },
    p.metaRobots && hasDirective(p.metaRobots, 'noindex')
      ? { label: 'HTML', value: `<meta name="robots" content="${p.metaRobots}">`, code: true }
      : { label: 'HTTP header', value: `X-Robots-Tag: ${p.xRobotsTag}`, code: true },
  ]);
  if (ctx.wordpress.detected && home) {
    evidence.push({ label: 'Platform', value: 'WordPress detected — a sitewide noindex is typically the "Discourage search engines from indexing this site" setting.' });
  }
  const sitewide = important.length >= Math.max(3, okPages(ctx).length * 0.6);
  return [
    candidate({
      id: 'noindex-important',
      title: home ? (sitewide ? 'The whole website is set to noindex' : 'Homepage is set to noindex') : `${plural(important.length, 'important page')} set to noindex`,
      category: 'Indexing',
      severity: 'High',
      confidence: staging ? 'Medium' : 'High',
      scope: home ? (sitewide ? 1 : 0.8) : Math.min(1, important.length / Math.max(1, okPages(ctx).length)),
      summary: `${home ? 'The homepage' : 'Important pages'} explicitly tell search engines not to index them. As long as this directive is present, these pages will not appear in search results.`,
      howIdentified:
        'Each crawled page was checked for a robots meta tag and an X-Robots-Tag response header. Pages whose paths look intentionally excluded (thank-you, privacy, cart, login, tag archives, etc.) were ignored; only the homepage, navigation pages and first-level pages were considered.',
      evidence,
      affectedUrls: important.map((p) => p.finalUrl),
      whyItMatters: 'noindex is an explicit instruction. Search engines honour it and remove the page from results, which eliminates organic traffic to that page.',
      solution: ctx.wordpress.detected
        ? [
            'WordPress: Settings → Reading → untick "Discourage search engines from indexing this site" (sets blog_public = 1).',
            'If an SEO plugin is active (Yoast / Rank Math / AIOSEO), check the page-level robots setting and the global content-type setting.',
            'Search the theme and mu-plugins for wp_robots filters or header("X-Robots-Tag") calls if the directive persists.',
            'Purge page cache/CDN, confirm the tag is gone with view-source, then request indexing in Search Console.',
          ]
        : ['Remove the noindex robots meta tag / X-Robots-Tag header from these templates.', 'Purge caches and confirm with view-source and curl -I.', 'Request re-indexing of the homepage.'],
      effort: EFFORT.quick,
      verification: [
        'Pages whose URL suggests intentional exclusion were filtered out.',
        staging ? 'Hostname looks like a staging/dev host — noindex may be intentional, confidence reduced.' : 'Hostname does not look like a staging/dev environment.',
        'Directive read from the live HTML/headers served to a normal request.',
      ],
    }),
  ];
};

/** robots.txt blocking the site, important pages, CSS/JS, or 5xx on robots.txt. */
export const robotsBlocking: Detector = (ctx) => {
  const out: Candidate[] = [];
  const rb = ctx.robots;
  if (rb.status !== null && rb.status >= 500) {
    out.push(
      candidate({
        id: 'robots-5xx',
        title: `robots.txt returns HTTP ${rb.status} (server error)`,
        category: 'Crawlability',
        severity: 'High',
        confidence: 'High',
        scope: 1,
        summary: 'robots.txt responds with a server error. Google treats a 5xx robots.txt as "do not crawl this site" until it can fetch the file again.',
        howIdentified: `${rb.url} was requested directly and returned a 5xx status.`,
        evidence: [
          { label: 'URL', value: rb.url },
          { label: 'HTTP status', value: String(rb.status) },
        ],
        affectedUrls: [rb.url],
        whyItMatters: 'Google documents that server errors on robots.txt pause crawling of the entire site, so new and changed pages are not picked up.',
        solution: ['Serve a valid robots.txt with HTTP 200 (or a 404 if you want no rules).', 'Check rewrite rules, security plugins or CDN rules that intercept /robots.txt.'],
        effort: EFFORT.quick,
        verification: ['Status observed directly on the live robots.txt URL.'],
      }),
    );
  }
  const parsed = ctx.robotsParsed;
  if (!parsed || !rb.fetched || rb.status !== 200) return out;
  const googleRules = rulesFor(parsed, 'Googlebot');
  const check = (url: string) => {
    const u = new URL(url);
    const rule = matchingRule(googleRules, u.pathname + u.search);
    return rule && rule.type === 'disallow' ? rule : null;
  };
  const homeRule = check(ctx.siteUrl);
  const nav = [...navUrls(ctx)].filter((u) => isSameSite(u, ctx.siteUrl));
  // Blocking low-value pages (contact forms, legal, account areas) is a common deliberate choice, not a defect.
  const blockedNav = nav
    .map((u) => ({ u, rule: check(u) }))
    .filter((x) => x.rule && !LOW_VALUE_PATH.test(new URL(x.u).pathname));
  const blockedPages = [...new Set([...(homeRule ? [ctx.siteUrl] : []), ...blockedNav.map((x) => x.u)])];
  const lines = rb.body.split(/\r?\n/);
  if (blockedPages.length) {
    const rule = homeRule ?? blockedNav[0]!.rule!;
    const sitewide = homeRule?.path === '/';
    // A single page blocked by a rule that names that exact path was most likely written on purpose.
    const looksDeliberate = !homeRule && blockedNav.length === 1 && rule.path.replace(/[$*]/g, '').replace(/\/$/, '').length > 1 && new URL(blockedNav[0]!.u).pathname.replace(/\/$/, '') === rule.path.replace(/[$*]/g, '').replace(/\/$/, '');
    out.push(
      candidate({
        id: 'robots-blocks-important',
        title: sitewide ? 'robots.txt blocks search engines from the entire website' : homeRule ? 'robots.txt blocks the homepage' : `robots.txt blocks ${plural(blockedNav.length, 'main navigation page')}`,
        category: 'Crawlability',
        severity: homeRule || blockedNav.length >= 2 ? 'High' : 'Medium',
        confidence: isStagingHost(ctx.siteUrl) || looksDeliberate ? 'Medium' : 'High',
        scope: sitewide ? 1 : homeRule ? 0.8 : Math.min(0.8, blockedNav.length / Math.max(nav.length, 1)),
        summary: `A Disallow rule in robots.txt prevents Googlebot from crawling ${sitewide ? 'every URL on the site' : 'important pages that are linked in the main navigation'}.`,
        howIdentified:
          'robots.txt was fetched and parsed using RFC 9309 group matching (Googlebot group, falling back to *). The homepage and every main-navigation URL were then tested against the rules with longest-match precedence.',
        evidence: [
          { label: 'robots.txt URL', value: rb.url },
          { label: 'Blocking rule', value: `Line ${rule.line}: ${lines[rule.line - 1]?.trim() ?? `Disallow: ${rule.path}`}`, code: true },
          { label: 'robots.txt (excerpt)', value: lines.slice(0, 25).join('\n'), code: true },
          { label: 'Blocked important URLs', value: blockedPages.slice(0, 10).join('\n'), code: true },
        ],
        affectedUrls: blockedPages,
        whyItMatters: 'Blocked URLs cannot be crawled, so their content is not read by search engines; they typically disappear from results or show without a description.',
        solution: [
          `Remove or narrow the rule "Disallow: ${rule.path}" so it no longer matches public pages.`,
          ctx.wordpress.detected
            ? 'WordPress: if no physical robots.txt exists, the virtual one is affected by Settings → Reading → "Discourage search engines" and SEO plugin robots editors (Yoast: Tools → File editor; Rank Math: General Settings → Edit robots.txt).'
            : 'Edit the physical robots.txt at the web root.',
          'Validate with Search Console’s robots.txt report after deploying.',
        ],
        effort: EFFORT.quick,
        verification: [
          'Only concrete URLs actually linked from the homepage navigation were tested — generic Disallow rules (e.g. /wp-admin/) are not flagged.',
          'Low-value pages that are commonly blocked on purpose (contact, legal, login, account, cart) were excluded.',
          'Rules evaluated for Googlebot specifically.',
          ...(looksDeliberate ? ['The rule names this exact path, so it may be intentional — confidence reduced to Medium.'] : []),
        ],
      }),
    );
  }
  const assets = (ctx.home?.scripts.map((s) => s.src) ?? []).concat(ctx.home?.stylesheets.map((s) => s.href) ?? []).filter((u) => isSameSite(u, ctx.siteUrl));
  const blockedAssets = assets.filter((u) => check(u));
  if (blockedAssets.length >= 2) {
    const r = check(blockedAssets[0]!)!;
    out.push(
      candidate({
        id: 'robots-blocks-assets',
        title: `robots.txt blocks ${plural(blockedAssets.length, 'CSS/JS file')} needed to render the homepage`,
        category: 'Crawlability',
        severity: 'Medium',
        confidence: 'High',
        scope: 0.7,
        summary: 'Stylesheets or scripts used by the homepage are disallowed in robots.txt, so Google renders the page without them.',
        howIdentified: 'Every same-site script and stylesheet referenced by the homepage HTML was tested against the Googlebot robots.txt rules.',
        evidence: [
          { label: 'Rule', value: `Line ${r.line}: ${lines[r.line - 1]?.trim() ?? `Disallow: ${r.path}`}`, code: true },
          { label: 'Blocked resources', value: blockedAssets.slice(0, 10).join('\n'), code: true },
        ],
        affectedUrls: [ctx.siteUrl],
        targets: blockedAssets,
        whyItMatters: 'Google renders pages like a browser. Missing CSS/JS can hide content or break the mobile layout for the renderer.',
        solution: [`Remove "Disallow: ${r.path}" or add explicit Allow rules for the CSS/JS paths (e.g. "Allow: /*.css$" and "Allow: /*.js$").`],
        effort: EFFORT.quick,
        verification: ['Only resources actually referenced by the homepage were tested.'],
      }),
    );
  }
  return out;
};

/** Soft 404 / blanket redirect of unknown URLs. */
export const soft404: Detector = (ctx) => {
  const s = ctx.soft404;
  if (!s) return [];
  if (s.status >= 200 && s.status < 300 && !s.redirectedToHome) {
    return [
      candidate({
        id: 'soft-404',
        title: 'Non-existent URLs return HTTP 200 (soft 404)',
        category: 'Indexing',
        severity: 'Medium',
        confidence: 'High',
        scope: 1,
        summary: 'A URL that cannot exist on this site returned a normal 200 page instead of a 404 status.',
        howIdentified: 'A random, guaranteed-nonexistent path was requested on the site and the status and final URL were recorded.',
        evidence: [
          { label: 'Requested (random path)', value: s.url },
          { label: 'Status', value: String(s.status) },
          { label: 'Final URL', value: s.finalUrl },
        ],
        affectedUrls: [s.url],
        whyItMatters:
          'Every mistyped, deleted or spam-linked URL becomes an indexable 200 page. Search engines waste crawl budget and can index thin duplicates; real broken links become invisible in reports.',
        solution: [
          'Make the 404 template send an actual 404 status (WordPress: check the theme 404.php and any plugin that serves a custom page with status 200; SPA: return 404 from the server for unknown routes).',
        ],
        effort: EFFORT.small,
        verification: ['The random path contains a unique token that cannot match real content.'],
      }),
    ];
  }
  if (s.redirectedToHome) {
    return [
      candidate({
        id: 'soft-404-redirect',
        title: 'Missing pages redirect to the homepage instead of returning 404',
        category: 'Indexing',
        severity: 'Low',
        confidence: 'High',
        scope: 1,
        summary: 'Unknown URLs are redirected to the homepage.',
        howIdentified: 'A random nonexistent path was requested; it redirected to the homepage.',
        evidence: [
          { label: 'Requested', value: s.url },
          { label: 'Result', value: `${s.status} → ${s.finalUrl}` },
        ],
        affectedUrls: [s.url],
        whyItMatters: 'Google treats blanket redirects to the homepage as soft 404s; users lose context about what was missing.',
        solution: ['Return a real 404 for unknown URLs and use targeted 301s only for moved content (disable "redirect all 404s to homepage" plugins).'],
        effort: EFFORT.quick,
        verification: ['Observed directly.'],
      }),
    ];
  }
  return [];
};
