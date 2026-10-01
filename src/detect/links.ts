import { normalizeUrl } from '../crawl/url.js';
import type { Candidate, EvidenceItem } from '../types.js';
import { candidate, EFFORT, linkSourcesEvidence, navUrls, okPages, plural, type Detector } from './helpers.js';

/** Broken internal links (4xx/5xx) and redirecting internal links. */
export const brokenLinks: Detector = (ctx) => {
  const out: Candidate[] = [];
  const nav = navUrls(ctx);
  const homeLinks = new Set((ctx.home?.internalLinks ?? []).map((l) => normalizeUrl(l.url)));
  const broken: { key: string; status: number }[] = [];
  const redirecting: { key: string; to: string; status: number }[] = [];
  for (const [key, st] of ctx.statuses) {
    if (!ctx.crawl.linkSources.has(key)) continue;
    const firstHop = st.chain[0]?.status ?? st.status;
    if (st.status === 404 || st.status === 410 || st.status >= 500) broken.push({ key, status: st.status });
    else if (firstHop >= 300 && firstHop < 400 && st.status >= 200 && st.status < 300 && normalizeUrl(st.finalUrl) !== key) {
      redirecting.push({ key, to: st.finalUrl, status: firstHop });
    }
  }
  if (broken.length) {
    const prominent = broken.filter((b) => nav.has(b.key) || homeLinks.has(b.key));
    const ordered = [...prominent, ...broken.filter((b) => !prominent.includes(b))];
    const sources = [...new Set(broken.flatMap((b) => (ctx.crawl.linkSources.get(b.key) ?? []).map((s) => s.source)))];
    const statuses = (list: { status: number }[]) => [...new Set(list.map((b) => b.status))].join('/');
    const evidence: EvidenceItem[] = [];
    for (const b of ordered.slice(0, 5)) {
      const srcs = ctx.crawl.linkSources.get(b.key) ?? [];
      evidence.push({ label: 'Broken URL', value: srcs[0]?.href ?? b.key });
      evidence.push({ label: 'Status', value: String(b.status) });
      evidence.push({ label: `Source page${srcs.length === 1 ? '' : 's'} (${srcs.length}${srcs.length >= 10 ? '+' : ''})`, value: linkSourcesEvidence(ctx, b.key), code: true });
    }
    out.push(
      candidate({
        id: 'broken-internal-links',
        title: prominent.length
          ? `Broken link${prominent.length > 1 ? 's' : ''} on the homepage/navigation return${prominent.length > 1 ? '' : 's'} HTTP ${statuses(prominent)}`
          : `${plural(broken.length, 'internal link target')} return${broken.length === 1 ? 's' : ''} HTTP ${statuses(broken)}`,
        category: 'Internal links',
        severity: prominent.length || broken.length >= 5 ? 'High' : 'Medium',
        confidence: 'High',
        scope: Math.min(1, sources.length / Math.max(1, okPages(ctx).length)),
        actionability: 1,
        summary: `${plural(broken.length, 'internal URL')} linked from the site ${broken.length === 1 ? 'returns' : 'return'} an error.${prominent.length ? ' At least one is linked from the homepage or main navigation, so most visitors can reach it.' : ''}`,
        howIdentified:
          'Internal links were extracted from every crawled page, normalized and de-duplicated. Each target was requested (redirects followed) and the final HTTP status recorded. Server errors and timeouts were re-requested once to rule out transient failures.',
        evidence,
        affectedUrls: sources,
        targets: broken.map((b) => b.key),
        whyItMatters: 'Visitors following these links hit an error page and usually leave; search engines waste crawl requests and the link equity flowing through these links is lost.',
        solution: [
          'Update each link to the correct live URL (or remove it).',
          'If the page was moved or deleted, add a 301 redirect from the old URL to the closest relevant page.',
          ctx.wordpress.detected
            ? 'WordPress: navigation links live in Appearance → Menus / Site Editor → Navigation; in-content links can be found with a database search or a 404 log (e.g. the Redirection plugin).'
            : 'Search templates and content for the old URL.',
        ],
        effort: broken.length > 10 ? EFFORT.medium : EFFORT.small,
        verification: [
          'Status observed directly on the live URL.',
          'Only links actually present in crawled HTML are counted.',
          'Excluded URLs (login/cart/search) and robots-disallowed URLs were never requested and are not included.',
        ],
      }),
    );
  }
  if (redirecting.length >= 10 || redirecting.filter((r) => nav.has(r.key)).length >= 3) {
    out.push(
      candidate({
        id: 'redirecting-internal-links',
        title: `${plural(redirecting.length, 'internal link')} point to redirecting URLs`,
        category: 'Internal links',
        severity: 'Low',
        confidence: 'High',
        scope: 0.5,
        summary: 'Internal links go through redirects instead of pointing at the final URL.',
        howIdentified: 'Status of internal link targets was checked; these returned 3xx before reaching a 200.',
        evidence: redirecting.slice(0, 6).map((r) => ({ label: `HTTP ${r.status}`, value: `${r.key}\n→ ${r.to}`, code: true })),
        affectedUrls: [...new Set(redirecting.flatMap((r) => (ctx.crawl.linkSources.get(r.key) ?? []).map((s) => s.source)))],
        targets: redirecting.map((r) => r.key),
        whyItMatters: 'Each redirect adds latency for users and an extra fetch for crawlers.',
        solution: ['Update links to their final URLs (common causes: missing trailing slash, http:// links, old slugs).'],
        effort: EFFORT.small,
        verification: ['Observed directly.'],
      }),
    );
  }
  return out;
};

/** Sitemap problems. */
export const sitemap: Detector = (ctx) => {
  const out: Candidate[] = [];
  const sm = ctx.sitemap;
  const declared = ctx.robots.sitemaps;
  const declaredBroken = sm.fetched.filter(
    (f) => declared.some((d) => normalizeUrl(d) === normalizeUrl(f.url)) && (f.status >= 400 || f.status === 0 || f.kind === 'invalid'),
  );
  if (declaredBroken.length) {
    const f = declaredBroken[0]!;
    out.push(
      candidate({
        id: 'sitemap-declared-broken',
        title: f.kind === 'invalid' && f.status === 200 ? 'Sitemap declared in robots.txt is not a valid XML sitemap' : `Sitemap declared in robots.txt returns ${f.status ? `HTTP ${f.status}` : 'an error'}`,
        category: 'Sitemap',
        severity: 'Medium',
        confidence: 'High',
        scope: 0.7,
        summary: 'robots.txt tells search engines where the sitemap is, but that URL does not deliver a usable sitemap.',
        howIdentified: 'Sitemap URLs listed in robots.txt were requested and parsed as XML.',
        evidence: [
          { label: 'Declared in robots.txt', value: declared.join('\n'), code: true },
          { label: 'Result', value: `${f.url} → HTTP ${f.status}${f.error ? ` — ${f.error}` : ''}`, code: true },
        ],
        affectedUrls: [f.url],
        targets: [f.url],
        whyItMatters: 'Search engines rely on the sitemap to discover and prioritise URLs; a broken declared sitemap slows discovery of new or deep pages.',
        solution: ['Point the Sitemap: line to the sitemap your SEO plugin/CMS generates (e.g. /sitemap_index.xml for Yoast, /wp-sitemap.xml for core WordPress), or fix the generator.'],
        effort: EFFORT.quick,
        verification: ['Status/format observed directly.'],
      }),
    );
  }
  const checks = sm.sampleChecks;
  if (checks.length >= 3) {
    const bad = checks.filter((c) => c.status >= 400 || c.status === 0);
    const redir = checks.filter((c) => c.status >= 200 && c.status < 300 && normalizeUrl(c.finalUrl) !== normalizeUrl(c.url));
    const noidx = checks.filter((c) => c.noindex);
    if (bad.length >= 2 && bad.length / checks.length >= 0.15) {
      out.push(
        candidate({
          id: 'sitemap-broken-urls',
          title: `${bad.length} of ${checks.length} sampled sitemap URLs return errors`,
          category: 'Sitemap',
          severity: bad.length / checks.length >= 0.3 ? 'High' : 'Medium',
          confidence: 'High',
          scope: bad.length / checks.length,
          summary: 'The XML sitemap lists URLs that do not exist or fail, so it advertises dead pages to search engines.',
          howIdentified: `${checks.length} URLs were sampled from the sitemap and requested; statuses recorded.`,
          evidence: bad.slice(0, 6).map((c) => ({ label: `HTTP ${c.status || 'error'}`, value: c.url, code: true })),
          affectedUrls: bad.map((c) => c.url),
          targets: bad.map((c) => c.url),
          whyItMatters: 'Search engines lose trust in sitemaps full of errors and waste crawl budget on them; real pages get discovered later.',
          solution: ['Regenerate the sitemap / clear the sitemap cache; remove deleted content; 301 moved URLs and list the new ones.'],
          effort: EFFORT.small,
          verification: ['Sample-based: statuses observed directly; the share is extrapolated only as an indication.'],
        }),
      );
    }
    if (redir.length >= 3 && redir.length / checks.length >= 0.25) {
      out.push(
        candidate({
          id: 'sitemap-redirects',
          title: `${redir.length} of ${checks.length} sampled sitemap URLs redirect`,
          category: 'Sitemap',
          severity: 'Low',
          confidence: 'High',
          scope: redir.length / checks.length,
          summary: 'The sitemap lists URLs that redirect elsewhere rather than final canonical URLs.',
          howIdentified: 'Sampled sitemap URLs were requested and their final URL compared with the listed URL.',
          evidence: redir.slice(0, 6).map((c) => ({ label: 'Redirects', value: `${c.url}\n→ ${c.finalUrl}`, code: true })),
          affectedUrls: redir.map((c) => c.url),
          targets: redir.map((c) => c.url),
          whyItMatters: 'Sitemaps should list only indexable canonical URLs; redirects weaken the sitemap as a signal.',
          solution: ['List final URLs only (check http/https and trailing-slash consistency in the generator).'],
          effort: EFFORT.quick,
          verification: ['Observed directly.'],
        }),
      );
    }
    if (noidx.length >= 2) {
      out.push(
        candidate({
          id: 'sitemap-noindex',
          title: `${noidx.length} sampled sitemap URLs are marked noindex`,
          category: 'Sitemap',
          severity: 'Medium',
          confidence: 'High',
          scope: noidx.length / checks.length,
          summary: 'The sitemap asks search engines to index pages whose own HTML says not to index them.',
          howIdentified: 'Sampled sitemap URLs were fetched and their robots meta/X-Robots-Tag inspected.',
          evidence: noidx.slice(0, 6).map((c) => ({ label: 'noindex', value: c.url, code: true })),
          affectedUrls: noidx.map((c) => c.url),
          targets: noidx.map((c) => c.url),
          whyItMatters: 'Contradictory signals: either the pages should be indexed (remove noindex) or they should not be in the sitemap.',
          solution: ['Decide per content type and align the SEO plugin’s sitemap inclusion with its robots settings.'],
          effort: EFFORT.quick,
          verification: ['Directive observed in live HTML.'],
        }),
      );
    }
  }
  if (ctx.siteUrl.startsWith('https:') && sm.httpUrlsOnHttpsSite.length >= 3) {
    out.push(
      candidate({
        id: 'sitemap-http-urls',
        title: `Sitemap lists ${sm.httpUrlsOnHttpsSite.length} http:// URLs on an HTTPS site`,
        category: 'Sitemap',
        severity: 'Medium',
        confidence: 'High',
        scope: Math.min(1, sm.httpUrlsOnHttpsSite.length / Math.max(1, sm.urls.length)),
        summary: 'The sitemap references the insecure version of pages.',
        howIdentified: 'Sitemap <loc> values were parsed and their scheme compared with the site’s HTTPS homepage.',
        evidence: [{ label: 'Examples', value: sm.httpUrlsOnHttpsSite.slice(0, 6).join('\n'), code: true }],
        affectedUrls: sm.httpUrlsOnHttpsSite.slice(0, 50),
        targets: sm.httpUrlsOnHttpsSite.slice(0, 50),
        whyItMatters: 'Each listed URL redirects; the sitemap no longer lists canonical URLs.',
        solution: ['Update the site URL setting to https:// and regenerate the sitemap.'],
        effort: EFFORT.quick,
        verification: ['Observed in sitemap XML.'],
      }),
    );
  }
  const anyValid = sm.fetched.some((f) => f.kind === 'urlset' || f.kind === 'index');
  if (!anyValid && !declaredBroken.length && ctx.robots.fetched) {
    out.push(
      candidate({
        id: 'sitemap-missing',
        title: 'No XML sitemap could be found',
        category: 'Sitemap',
        severity: 'Low',
        confidence: 'Medium',
        scope: 0.5,
        summary: 'No sitemap is declared in robots.txt and none exists at the standard locations.',
        howIdentified: `Checked robots.txt Sitemap directives and ${sm.fetched.map((f) => f.url).join(', ') || '/sitemap.xml'}.`,
        evidence: sm.fetched.map((f) => ({ label: f.url, value: `HTTP ${f.status}${f.error ? ` — ${f.error}` : ''}` })),
        affectedUrls: [ctx.siteUrl],
        whyItMatters: 'Sitemaps help search engines discover deep or new pages; small, well-linked sites are less affected.',
        solution: ['Enable the CMS/SEO plugin sitemap and add "Sitemap: https://…/sitemap.xml" to robots.txt.'],
        effort: EFFORT.quick,
        verification: ['A sitemap may exist at a non-standard URL submitted directly to Search Console, which cannot be checked publicly.'],
      }),
    );
  }
  return out;
};
