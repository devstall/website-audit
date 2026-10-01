import type { Candidate } from '../types.js';
import { candidate, EFFORT, headerDump, kb, okPages, plural, type Detector } from './helpers.js';

/** Core Web Vitals, server response time, compression, HTML weight, heavy images, render-blocking resources. */
export const performance: Detector = (ctx) => {
  const out: Candidate[] = [];
  const { mobile: m, desktop: d } = ctx.browser;
  const lab = `Lab measurement from the investigator's network, unthrottled, median of ${m?.runs ?? 0} mobile and ${d?.runs ?? 0} desktop load(s) in ${ctx.browser.engine ?? 'a Chromium browser'}. Field data (CrUX) may differ.`;

  if (m?.lcpMs != null && m.lcpMs > 2500) {
    const poor = m.lcpMs > 4000;
    out.push(
      candidate({
        id: 'slow-lcp',
        title: `Slow Largest Contentful Paint on mobile (${(m.lcpMs / 1000).toFixed(1)} s)`,
        category: 'Core Web Vitals',
        severity: poor ? 'High' : 'Medium',
        confidence: poor && m.runs >= 2 ? 'High' : 'Medium',
        evidenceStrength: 0.8,
        scope: 0.8,
        summary: `The main content of the homepage took ${(m.lcpMs / 1000).toFixed(1)} s to appear on a mobile viewport even without network throttling. Google's "good" threshold is 2.5 s.`,
        howIdentified: `The homepage was loaded in a real browser with a PerformanceObserver for largest-contentful-paint injected before page scripts. ${lab}`,
        evidence: [
          { label: 'Mobile LCP (median)', value: `${m.lcpMs} ms` },
          { label: 'Mobile FCP', value: m.fcpMs != null ? `${m.fcpMs} ms` : 'n/a' },
          { label: 'TTFB (browser)', value: m.ttfbMs != null ? `${m.ttfbMs} ms` : 'n/a' },
          ...(d ? [{ label: 'Desktop LCP (median)', value: d.lcpMs != null ? `${d.lcpMs} ms` : 'n/a' }] : []),
          { label: 'Requests / transfer', value: `${m.requestCount} requests, ${kb(m.transferBytes)} (same-origin + timing-allowed resources)` },
        ],
        affectedUrls: [ctx.siteUrl],
        whyItMatters: 'LCP is a Core Web Vital used in Google’s page experience signals; slow main content increases bounce rates, especially on real mobile networks, which are slower than this test.',
        solution: [
          m.ttfbMs && m.ttfbMs > 800
            ? `Server response is a large part of it (TTFB ${m.ttfbMs} ms): enable full-page caching${ctx.wordpress.detected ? ' (e.g. LiteSpeed Cache/WP Rocket or host-level cache)' : ''} and review slow queries.`
            : 'Identify the LCP element in DevTools → Performance and prioritise it: fetchpriority="high", no lazy-loading on the hero image, preload its image/font.',
          'Defer non-critical JS, inline critical CSS, compress/resize the hero image (WebP/AVIF, correct dimensions).',
        ],
        effort: EFFORT.medium,
        verification: ['Measured, not estimated; median of multiple runs where possible.', 'Real users on mobile networks will usually see slower values than this unthrottled test.'],
      }),
    );
  }

  const cls = m?.cls ?? null;
  if (cls != null && cls > 0.1) {
    out.push(
      candidate({
        id: 'high-cls',
        title: `Layout shifts during load (CLS ${cls.toFixed(2)} on mobile)`,
        category: 'Core Web Vitals',
        severity: cls > 0.25 ? 'High' : 'Medium',
        confidence: (m?.runs ?? 0) >= 2 ? 'High' : 'Medium',
        evidenceStrength: 0.8,
        scope: 0.7,
        summary: 'Content visibly jumps while the homepage loads.',
        howIdentified: `layout-shift entries were collected with a PerformanceObserver (session-window CLS). ${lab}`,
        evidence: [
          { label: 'Mobile CLS', value: String(cls) },
          { label: 'Desktop CLS', value: String(d?.cls ?? 'n/a') },
          { label: 'Homepage images without width/height', value: String(ctx.home?.images.filter((i) => !i.width || !i.height).length ?? 0) },
        ],
        affectedUrls: [ctx.siteUrl],
        whyItMatters: 'CLS is a Core Web Vital; shifting content causes mis-taps and a poor experience. Good is ≤ 0.1.',
        solution: ['Give images/iframes/ads explicit width & height or aspect-ratio; reserve space for banners/cookie bars; use font-display with size-adjusted fallbacks.'],
        effort: EFFORT.medium,
        verification: ['Measured in the browser; shifts after user input are excluded.'],
      }),
    );
  }

  if (ctx.medianTtfbMs != null && ctx.medianTtfbMs > 1500 && okPages(ctx).length >= 3) {
    out.push(
      candidate({
        id: 'slow-server',
        title: `Slow server response across pages (median TTFB ${ctx.medianTtfbMs} ms)`,
        category: 'Performance',
        severity: ctx.medianTtfbMs > 2500 ? 'High' : 'Medium',
        confidence: 'Medium',
        evidenceStrength: 0.8,
        scope: 1,
        summary: 'The server takes a long time to start sending HTML on most pages.',
        howIdentified: 'Time-to-first-byte of each crawled HTML page was measured on the final (non-redirect) response.',
        evidence: okPages(ctx)
          .slice(0, 8)
          .map((p) => ({ label: p.finalUrl, value: `${p.ttfbMs} ms` })),
        affectedUrls: okPages(ctx).map((p) => p.finalUrl),
        whyItMatters: 'Every page load waits for this first; it directly delays FCP and LCP.',
        solution: [
          ctx.wordpress.detected
            ? 'Enable full-page caching (server/plugin/CDN), add an object cache (Redis), and profile slow plugins (Query Monitor).'
            : 'Enable full-page/edge caching and profile backend time.',
        ],
        effort: EFFORT.medium,
        verification: ['Measured from a single location — network distance contributes, so confidence is Medium.'],
      }),
    );
  }

  const h = ctx.homepage.headers;
  if (ctx.home && ctx.homepage.status === 200 && ctx.homepage.bodyBytes > 20 * 1024 && !h['content-encoding']) {
    out.push(
      candidate({
        id: 'no-compression',
        title: 'HTML is served without compression',
        category: 'Performance',
        severity: ctx.homepage.bodyBytes > 100 * 1024 ? 'Medium' : 'Low',
        confidence: 'High',
        scope: 1,
        summary: `The homepage HTML (${kb(ctx.homepage.bodyBytes)}) is sent uncompressed although the request advertised gzip/brotli support.`,
        howIdentified: 'The homepage was requested with "Accept-Encoding: gzip, deflate, br" and the response Content-Encoding header was checked.',
        evidence: [
          { label: 'Request header', value: 'Accept-Encoding: gzip, deflate, br', code: true },
          { label: 'Response headers', value: headerDump(h, ['content-type', 'content-encoding', 'content-length', 'vary', 'server']), code: true },
        ],
        affectedUrls: [ctx.siteUrl],
        whyItMatters: 'Compression typically shrinks HTML by 70–85 %, directly reducing download time on mobile.',
        solution: ['Enable gzip/brotli for text/html, text/css, application/javascript, application/json and image/svg+xml (Apache mod_deflate/mod_brotli, Nginx gzip/brotli, or at the CDN).'],
        effort: EFFORT.quick,
        verification: ['Header observed directly.'],
      }),
    );
  }

  if (ctx.homepage.bodyBytes > 1.5 * 1024 * 1024) {
    out.push(
      candidate({
        id: 'huge-html',
        title: `Homepage HTML is ${kb(ctx.homepage.bodyBytes)}`,
        category: 'Performance',
        severity: 'Medium',
        confidence: 'High',
        scope: 0.6,
        summary: 'The HTML document itself is very large (inline CSS/JS/SVG or page-builder markup).',
        howIdentified: 'Decoded HTML size was measured.',
        evidence: [{ label: 'Size', value: kb(ctx.homepage.bodyBytes) }],
        affectedUrls: [ctx.siteUrl],
        whyItMatters: 'Large documents take longer to download and parse, delaying rendering.',
        solution: ['Move inline assets to cacheable files; reduce DOM size / page-builder nesting.'],
        effort: EFFORT.medium,
        verification: ['Measured directly.'],
      }),
    );
  }

  const heavy = [...ctx.browser.largeImages]
    .sort((a, b) => b.bytes - a.bytes)
    .filter((i) => i.bytes > 1024 * 1024 || (i.bytes > 400 * 1024 && i.naturalWidth && i.renderedWidth && i.naturalWidth > i.renderedWidth * 2.5));
  if (heavy.length) {
    out.push(
      candidate({
        id: 'heavy-images',
        title: `${plural(heavy.length, 'oversized image')} on key pages (largest ${kb(heavy[0]!.bytes)})`,
        category: 'Images',
        severity: heavy[0]!.bytes > 1.5 * 1024 * 1024 ? 'Medium' : 'Low',
        confidence: 'High',
        scope: 0.6,
        summary: 'Images are downloaded at far larger file sizes/dimensions than they are displayed.',
        howIdentified: 'Image responses were recorded in the browser (Content-Length) and compared with each image’s natural and rendered width.',
        evidence: heavy.slice(0, 5).map((i) => ({
          label: i.page,
          value: `${i.url}\n${kb(i.bytes)} — natural ${i.naturalWidth ?? '?'}px, displayed ${i.renderedWidth ?? '?'}px`,
          code: true,
        })),
        affectedUrls: [...new Set(heavy.map((i) => i.page))],
        targets: heavy.map((i) => i.url),
        whyItMatters: 'Image bytes dominate page weight on mobile and often delay LCP.',
        solution: [
          `Resize to the displayed size (×2 for retina), convert to WebP/AVIF, and serve srcset/sizes${ctx.wordpress.detected ? ' (WordPress generates srcset automatically for media-library images inserted at a registered size)' : ''}.`,
        ],
        effort: EFFORT.small,
        verification: ['Byte sizes come from actual responses.'],
      }),
    );
  }

  const blockingScripts = ctx.home ? ctx.home.scripts.filter((s) => s.inHead && !s.async && !s.defer && !s.module) : [];
  const css = ctx.home?.stylesheets.filter((s) => !s.media || s.media === 'all' || s.media === 'screen').length ?? 0;
  if (blockingScripts.length >= 10 || blockingScripts.length + css >= 25) {
    out.push(
      candidate({
        id: 'render-blocking',
        title: `${blockingScripts.length} render-blocking scripts and ${css} stylesheets in the homepage <head>`,
        category: 'Performance',
        severity: 'Low',
        confidence: 'Medium',
        evidenceStrength: 0.6,
        scope: 0.8,
        summary: 'The browser must download and execute many files before it can render anything.',
        howIdentified: 'Counted synchronous <script src> tags in <head> (no async/defer/module) and render-blocking stylesheets.',
        evidence: [{ label: 'Blocking scripts', value: blockingScripts.slice(0, 10).map((s) => s.src).join('\n') || '(none)', code: true }],
        affectedUrls: [ctx.siteUrl],
        whyItMatters: 'Render-blocking resources delay First Contentful Paint.',
        solution: ['Add defer to non-critical scripts, combine/trim plugin CSS, and load page-specific assets only where used.'],
        effort: EFFORT.medium,
        verification: ['Static count; actual impact depends on file sizes and caching.'],
      }),
    );
  }
  return out;
};
