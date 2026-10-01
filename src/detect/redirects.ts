import { isSameSite, normalizeUrl, stripWww } from '../crawl/url.js';
import type { Candidate, PageFacts } from '../types.js';
import { candidate, chainText, EFFORT, isHome, okPages, plural, type Detector } from './helpers.js';

/** HTTP → HTTPS, redirect chains, loops, duplicate hosts, TLS failures on host variants. */
export const redirects: Detector = (ctx) => {
  const out: Candidate[] = [];
  const siteHttps = ctx.siteUrl.startsWith('https:');
  const primaryHost = new URL(ctx.siteUrl).hostname;
  for (const v of ctx.variants) {
    const r = v.result;
    if (!r) continue;
    if (r.loop) {
      out.push(
        candidate({
          id: 'redirect-loop',
          title: `Redirect loop on ${v.url}`,
          category: 'Redirects',
          severity: 'High',
          confidence: 'High',
          scope: 0.8,
          summary: `Requesting ${v.url} never reaches a page: the redirects loop back to a URL already visited.`,
          howIdentified: 'The URL was requested and every Location header was followed manually, recording each hop until a URL repeated.',
          evidence: [{ label: 'Redirect chain', value: chainText(r.chain), code: true }],
          affectedUrls: [v.url],
          whyItMatters: 'Browsers show "too many redirects" and search engines abandon the URL; any links or bookmarks to it are dead.',
          solution: ['Compare the HTTPS/host redirect rules in the server config, CDN and CMS site URL settings; two layers are redirecting in opposite directions.'],
          effort: EFFORT.small,
          verification: ['Loop observed directly by following Location headers.'],
        }),
      );
      continue;
    }
    if (siteHttps && v.url.startsWith('http://') && r.status >= 200 && r.status < 300 && r.finalUrl.startsWith('http://')) {
      const httpsCanonical = !!v.canonical?.startsWith('https:');
      out.push(
        candidate({
          id: 'http-no-redirect',
          title: 'HTTP version of the site loads without redirecting to HTTPS',
          category: 'HTTPS',
          severity: 'High',
          confidence: 'High',
          scope: 1,
          summary: `The site uses HTTPS, but ${v.url} returns HTTP ${r.status} over plain HTTP instead of redirecting to the secure version.`,
          howIdentified: 'The homepage was requested explicitly over http:// and redirects were followed; the final URL stayed on http://.',
          evidence: [
            { label: 'Requested', value: v.url },
            { label: 'Result', value: chainText(r.chain), code: true },
            { label: 'Preferred version (homepage final URL)', value: ctx.siteUrl },
            { label: 'Canonical on HTTP page', value: v.canonical ?? '(none)' },
          ],
          affectedUrls: [v.url],
          whyItMatters:
            'Visitors can use the site unencrypted (no integrity or confidentiality), HSTS cannot protect first visits, and the HTTP and HTTPS versions compete as duplicates.',
          solution: [
            'Add a permanent 301 from http:// to https:// for all paths at the server/CDN (Apache: RewriteCond %{HTTPS} off + RewriteRule ^ https://%{HTTP_HOST}%{REQUEST_URI} [L,R=301]; Nginx: return 301 https://$host$request_uri;).',
            'Then add Strict-Transport-Security once HTTPS is confirmed everywhere.',
          ],
          effort: EFFORT.quick,
          verification: [
            httpsCanonical
              ? 'The HTTP page carries an HTTPS canonical, which mitigates duplicate indexing but not the security issue.'
              : 'No HTTPS canonical on the HTTP page consolidates the two versions.',
          ],
        }),
      );
    }
    const hops = r.chain.filter((h) => h.status >= 300 && h.status < 400).length;
    const downgrade = r.chain.some((h, i) => i > 0 && h.url.startsWith('http://') && r.chain[i - 1]!.url.startsWith('https://'));
    if (r.status >= 200 && r.status < 400 && (hops >= 3 || downgrade)) {
      out.push(
        candidate({
          id: `redirect-chain-${v.label.replace(/\W+/g, '-')}`,
          title: downgrade ? `Redirect chain downgrades HTTPS to HTTP (${v.label})` : `${hops}-hop redirect chain (${v.label})`,
          category: 'Redirects',
          severity: 'Medium',
          confidence: 'High',
          scope: 0.7,
          summary: `${v.url} takes ${hops} redirects to reach its final URL${downgrade ? ', and one hop sends the visitor from HTTPS back to plain HTTP' : ''}.`,
          howIdentified: 'The URL was requested and every redirect hop was followed and recorded with its status code.',
          evidence: [{ label: 'Redirect chain', value: chainText(r.chain), code: true }],
          affectedUrls: [v.url],
          whyItMatters: `Each hop adds a full round trip before the page can start loading${downgrade ? ', and the HTTP hop exposes the request unencrypted' : ''}. Chains also dilute crawl efficiency.`,
          solution: [
            'Collapse the chain into one 301 from every variant (http/https × www/non-www) directly to the final canonical URL.',
            'Check for competing redirects in .htaccess/nginx, the CDN, and the CMS site URL settings.',
          ],
          effort: EFFORT.small,
          verification: ['Every hop observed directly.'],
        }),
      );
    }
    if (v.label === 'alternate host' && r.status >= 200 && r.status < 300) {
      const finalHost = new URL(r.finalUrl).hostname;
      if (finalHost !== primaryHost && stripWww(finalHost) === stripWww(primaryHost)) {
        const canonicalOk = !!v.canonical && !!normalizeUrl(v.canonical)?.startsWith(new URL(ctx.siteUrl).origin);
        out.push(
          candidate({
            id: 'duplicate-host',
            title: 'Both www and non-www versions of the site serve content',
            category: 'Canonicalization',
            severity: canonicalOk ? 'Low' : 'Medium',
            confidence: 'High',
            scope: 1,
            summary: `${new URL(r.finalUrl).origin} and ${new URL(ctx.siteUrl).origin} both return pages instead of one redirecting to the other.`,
            howIdentified: 'The homepage was requested on the alternate host (www ↔ non-www) and the final URL and status were compared with the primary homepage.',
            evidence: [
              { label: 'Primary', value: ctx.siteUrl },
              { label: 'Alternate', value: chainText(r.chain), code: true },
              { label: 'Canonical on alternate', value: v.canonical ?? '(none)' },
            ],
            affectedUrls: [v.url],
            whyItMatters: 'Two hostnames with identical content split links and signals; without a canonical, search engines may index either version.',
            solution: ['Add a sitewide 301 from the alternate host to the primary host, preserving the path.'],
            effort: EFFORT.quick,
            verification: [canonicalOk ? 'Alternate host has a canonical to the primary host, which mitigates indexing impact — severity reduced.' : 'No canonical consolidates the alternate host.'],
          }),
        );
      }
    }
  }
  const alt = ctx.variants.find((v) => v.label === 'alternate host');
  if (alt?.result && alt.result.status === 0 && /TLS|certificate|CERT/i.test(alt.result.error ?? '') && alt.url.startsWith('https:')) {
    out.push(
      candidate({
        id: 'alt-host-tls',
        title: `HTTPS certificate error on ${new URL(alt.url).hostname}`,
        category: 'HTTPS',
        severity: 'Medium',
        confidence: 'High',
        scope: 0.6,
        summary: `Visitors who type ${alt.url} get a browser security warning because the TLS certificate is not valid for that hostname.`,
        howIdentified: 'The alternate hostname (www ↔ non-www) was requested over HTTPS; the TLS handshake failed certificate validation.',
        evidence: [
          { label: 'URL', value: alt.url },
          { label: 'Error', value: alt.result.error ?? '' },
        ],
        affectedUrls: [alt.url],
        whyItMatters: 'Users and links using that hostname hit a full-page browser warning; the redirect to the primary host never runs.',
        solution: ['Issue a certificate covering both hostnames (SAN for example.com and www.example.com), then keep the 301 to the primary host.'],
        effort: EFFORT.quick,
        verification: ['Handshake failure observed directly; the hostname resolves in DNS.'],
      }),
    );
  }
  return out;
};

/** Canonical problems. */
export const canonical: Detector = (ctx) => {
  const out: Candidate[] = [];
  const pages = okPages(ctx);
  const siteHttps = ctx.siteUrl.startsWith('https:');
  const offsite: PageFacts[] = [];
  const httpCanon: PageFacts[] = [];
  const toHome: PageFacts[] = [];
  const broken: { page: PageFacts; status: number }[] = [];
  const multi: PageFacts[] = [];
  for (const p of pages) {
    if (!p.canonical) continue;
    if (p.canonicalCount > 1) multi.push(p);
    let cu: URL;
    try {
      cu = new URL(p.canonical);
    } catch {
      continue;
    }
    if (!isSameSite(cu.href, ctx.siteUrl)) offsite.push(p);
    else if (siteHttps && cu.protocol === 'http:') httpCanon.push(p);
    if (!isHome(ctx, p.finalUrl) && isHome(ctx, cu.href)) toHome.push(p);
    const t = ctx.canonicalTargets.get(normalizeUrl(cu.href)!);
    if (t && (t.status >= 400 || t.status === 0)) broken.push({ page: p, status: t.status });
  }
  const pageShare = (n: number) => Math.min(1, n / Math.max(1, pages.length));

  if (offsite.length) {
    const homeOffsite = offsite.some((p) => isHome(ctx, p.finalUrl));
    out.push(
      candidate({
        id: 'canonical-offsite',
        title: homeOffsite ? 'Homepage canonical tag points to a different domain' : `${plural(offsite.length, 'page')} declare a canonical URL on another domain`,
        category: 'Canonicalization',
        severity: 'High',
        confidence: 'High',
        scope: homeOffsite ? Math.max(0.9, pageShare(offsite.length)) : pageShare(offsite.length),
        summary: 'The canonical tag tells search engines that the preferred version of these pages lives on another domain, so this site’s pages may be dropped in favour of it.',
        howIdentified: 'The <link rel="canonical"> of every crawled page was extracted, resolved to an absolute URL and its host compared with the site host.',
        evidence: offsite.slice(0, 4).flatMap((p) => [
          { label: 'Page', value: p.finalUrl },
          { label: 'Canonical', value: `<link rel="canonical" href="${p.canonical}">`, code: true },
        ]),
        affectedUrls: offsite.map((p) => p.finalUrl),
        whyItMatters: 'Search engines treat a cross-domain canonical as a strong hint to index the other URL instead. This typically happens after a migration or when a staging/old domain is hard-coded.',
        solution: [
          ctx.wordpress.detected
            ? 'WordPress: check Settings → General (WordPress Address / Site Address), then the SEO plugin’s canonical fields; search the database for the old domain (wp search-replace old.com new.com --dry-run).'
            : 'Update the template that outputs rel=canonical to use the current domain.',
          'Purge caches and verify the tag in view-source.',
        ],
        effort: EFFORT.small,
        verification: ['www vs non-www is treated as the same site; only genuinely different domains are flagged.'],
      }),
    );
  }
  if (broken.length) {
    out.push(
      candidate({
        id: 'canonical-broken',
        title: `${plural(broken.length, 'page')} have a canonical URL that returns ${broken[0]!.status || 'an error'}`,
        category: 'Canonicalization',
        severity: 'High',
        confidence: 'High',
        scope: pageShare(broken.length),
        summary: 'These pages point search engines to a canonical URL that does not work.',
        howIdentified: 'Each page’s canonical URL was requested and its HTTP status recorded.',
        evidence: broken.slice(0, 4).flatMap((b) => [
          { label: 'Page', value: b.page.finalUrl },
          { label: 'Canonical', value: `${b.page.canonical} → HTTP ${b.status || 'error'}`, code: true },
        ]),
        affectedUrls: broken.map((b) => b.page.finalUrl),
        whyItMatters: 'A canonical pointing to an error page sends contradictory signals; search engines may ignore the page or the canonical entirely.',
        solution: ['Make canonical tags self-referencing (the page’s own final URL) or point them to a live 200 URL.'],
        effort: EFFORT.small,
        verification: ['Canonical target status observed directly.'],
      }),
    );
  }
  if (toHome.length >= 3 && toHome.length >= pages.length * 0.4) {
    out.push(
      candidate({
        id: 'canonical-to-home',
        title: `${plural(toHome.length, 'inner page')} canonicalize to the homepage`,
        category: 'Canonicalization',
        severity: 'High',
        confidence: 'High',
        scope: pageShare(toHome.length),
        summary: 'Inner pages declare the homepage as their canonical URL, asking search engines to index only the homepage.',
        howIdentified: 'Canonical tags of all crawled pages were compared with each page URL and with the homepage URL.',
        evidence: toHome.slice(0, 5).flatMap((p) => [
          { label: 'Page', value: p.finalUrl },
          { label: 'Canonical', value: p.canonical!, code: true },
        ]),
        affectedUrls: toHome.map((p) => p.finalUrl),
        whyItMatters: 'Pages that canonicalize elsewhere are usually excluded from the index; service/product pages then cannot rank.',
        solution: ['Fix the template/plugin hard-coding the home URL as canonical; each page should reference its own URL.'],
        effort: EFFORT.small,
        verification: ['Pattern appears across multiple distinct pages, so it is a template issue rather than a deliberate consolidation.'],
      }),
    );
  }
  if (httpCanon.length) {
    out.push(
      candidate({
        id: 'canonical-http',
        title: `${plural(httpCanon.length, 'HTTPS page')} declare an HTTP canonical URL`,
        category: 'Canonicalization',
        severity: 'Medium',
        confidence: 'High',
        scope: pageShare(httpCanon.length),
        summary: 'Pages served over HTTPS name the insecure http:// version as canonical.',
        howIdentified: 'Canonical URLs were extracted from each crawled HTTPS page and their scheme compared.',
        evidence: httpCanon.slice(0, 4).flatMap((p) => [
          { label: 'Page', value: p.finalUrl },
          { label: 'Canonical', value: p.canonical!, code: true },
        ]),
        affectedUrls: httpCanon.map((p) => p.finalUrl),
        whyItMatters: 'The canonical signal conflicts with the HTTPS redirect; search engines must guess which version to index.',
        solution: [
          ctx.wordpress.detected
            ? 'Set WordPress Address and Site Address to https:// and run a search-replace of http://domain → https://domain.'
            : 'Output https:// canonical URLs from the template.',
        ],
        effort: EFFORT.quick,
        verification: ['Scheme mismatch observed in live HTML.'],
      }),
    );
  }
  const homeMulti = multi.find((p) => isHome(ctx, p.finalUrl));
  if (homeMulti) {
    out.push(
      candidate({
        id: 'canonical-multiple',
        title: 'Homepage outputs more than one canonical tag',
        category: 'Canonicalization',
        severity: 'Low',
        confidence: 'High',
        scope: 0.4,
        summary: 'Multiple rel=canonical tags are present; search engines may ignore all of them.',
        howIdentified: 'Counted <link rel="canonical"> elements in the homepage HTML.',
        evidence: [{ label: 'Pages', value: multi.map((p) => `${p.finalUrl} (${p.canonicalCount} tags)`).join('\n'), code: true }],
        affectedUrls: multi.map((p) => p.finalUrl),
        whyItMatters: 'Google ignores canonical hints when several conflicting ones are declared.',
        solution: ['Usually two SEO plugins (or theme + plugin) both output canonicals — disable one source.'],
        effort: EFFORT.quick,
        verification: ['Observed directly in HTML.'],
      }),
    );
  }
  return out;
};
