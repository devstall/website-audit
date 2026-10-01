import { isSameSite } from '../crawl/url.js';
import type { Candidate } from '../types.js';
import { candidate, EFFORT, isHome, okPages, plural, type Detector } from './helpers.js';

/** Mixed content, broken JS/CSS assets, uncaught JavaScript errors. */
export const assetsAndJs: Detector = (ctx) => {
  const out: Candidate[] = [];
  const b = ctx.browser;
  const htmlMixed = ctx.crawl.pages.flatMap((p) => p.mixedContent.map((m) => ({ ...m, page: p.finalUrl })));
  if (ctx.siteUrl.startsWith('https:') && (htmlMixed.length || b.mixedContent.length)) {
    const active = htmlMixed.filter((m) => ['script', 'link', 'iframe', 'object', 'embed'].includes(m.tag));
    const pages = [...new Set(htmlMixed.map((m) => m.page))];
    out.push(
      candidate({
        id: 'mixed-content',
        title: active.length ? 'HTTPS pages load scripts/styles over insecure HTTP (active mixed content)' : 'HTTPS pages load images/media over insecure HTTP (mixed content)',
        category: 'HTTPS',
        severity: active.length ? 'High' : 'Medium',
        confidence: 'High',
        scope: Math.min(1, Math.max(1, pages.length) / Math.max(1, okPages(ctx).length)),
        summary: active.length
          ? 'Browsers block insecure scripts, stylesheets and frames on HTTPS pages, so these resources do not load at all.'
          : 'Insecure http:// media on HTTPS pages is auto-upgraded or blocked by browsers, and can remove the padlock.',
        howIdentified: 'The HTML of crawled HTTPS pages was scanned for http:// resource URLs; the browser test recorded insecure requests.',
        evidence: [
          ...htmlMixed.slice(0, 6).map((m) => ({ label: `<${m.tag}> on ${m.page}`, value: m.url, code: true })),
          ...(b.mixedContent.length ? [{ label: 'Insecure requests seen by the browser', value: b.mixedContent.slice(0, 6).join('\n'), code: true }] : []),
        ],
        affectedUrls: pages.length ? pages : [ctx.siteUrl],
        targets: [...new Set([...htmlMixed.map((m) => m.url), ...b.mixedContent])].slice(0, 50),
        whyItMatters: active.length ? 'Blocked scripts/styles break functionality or layout for every visitor.' : 'Images may fail to load; browsers may show a "not fully secure" warning.',
        solution: [
          ctx.wordpress.detected
            ? 'Run a search-replace of http://your-domain → https://your-domain in the database (WP-CLI: wp search-replace), and fix hard-coded URLs in theme/plugin settings.'
            : 'Change resource URLs to https://.',
          'Optionally add Content-Security-Policy: upgrade-insecure-requests as a safety net.',
        ],
        effort: EFFORT.small,
        verification: ['Observed in live HTML and/or the browser network log.'],
      }),
    );
  }

  const browserFailures = b.failedRequests
    .filter((f) => (f.resourceType === 'script' || f.resourceType === 'stylesheet') && f.status !== null && f.status >= 400)
    .map((f) => ({ url: f.url, status: f.status!, type: f.resourceType, page: f.fromPage }));
  const httpFailures = ctx.assetChecks
    .filter((a) => (a.type === 'script' || a.type === 'stylesheet') && (a.status >= 400 || a.status === 0))
    .filter((a) => !browserFailures.some((f) => f.url === a.url))
    .map((a) => ({ url: a.url, status: a.status, type: a.type as string, page: a.page }));
  const all = [...browserFailures, ...httpFailures];
  if (all.length) {
    const first = all[0]!;
    const own = all.filter((a) => isSameSite(a.url, ctx.siteUrl));
    const typeLabel = all.some((a) => a.type === 'script') ? 'JavaScript' : 'CSS';
    const where = first.url.includes('/wp-content/plugins/')
      ? `plugin "${/plugins\/([^/]+)/.exec(first.url)?.[1]}"`
      : first.url.includes('/wp-content/themes/')
        ? `theme "${/themes\/([^/]+)/.exec(first.url)?.[1]}"`
        : 'template / tag manager';
    out.push(
      candidate({
        id: 'broken-assets',
        title: `${own.length ? '' : 'Third-party '}${typeLabel} file${all.length > 1 ? 's' : ''} required by the page return${all.length > 1 ? '' : 's'} ${[...new Set(all.map((a) => (a.status ? `HTTP ${a.status}` : 'errors')))].join('/')}`,
        category: 'Broken functionality',
        severity: own.length ? 'High' : 'Medium',
        confidence: 'High',
        scope: all.some((a) => isHome(ctx, a.page)) ? 0.9 : 0.5,
        actionability: 1,
        summary: `The page references ${plural(all.length, 'script/stylesheet', 'scripts/stylesheets')} that the server does not deliver. Whatever depends on ${all.length > 1 ? 'them' : 'it'} (menus, sliders, forms, styling) cannot work.`,
        howIdentified: b.available
          ? 'The page was loaded in a real browser and every network response was recorded; script and stylesheet responses with a 4xx/5xx status were collected. Each URL comes from the page’s own HTML or runtime requests.'
          : 'Scripts and stylesheets referenced in the page HTML were requested directly and their HTTP status recorded.',
        evidence: all.slice(0, 6).flatMap((a) => [
          { label: 'Page', value: a.page },
          { label: `${a.type} request`, value: `${a.url}\nStatus: ${a.status || 'failed'}`, code: true },
        ]),
        affectedUrls: [...new Set(all.map((a) => a.page))],
        targets: [...new Set(all.map((a) => a.url))],
        whyItMatters: `${typeLabel === 'JavaScript' ? 'Missing JavaScript causes runtime errors and silently disables interactive features' : 'Missing CSS breaks layout and styling'}. Search engines render the page with the same failure.`,
        solution: [
          `Find where the file is enqueued (${where}).`,
          'Common causes: a cache/minify plugin serving stale combined-file URLs (purge and regenerate), a deleted build file, or a wrong asset path after migration.',
          'Reload with DevTools open and confirm no 4xx/5xx in the Network panel.',
        ],
        effort: EFFORT.small,
        verification: [b.available ? 'Status observed by the browser on the live page (not inferred).' : 'Browser unavailable: detected by requesting referenced assets directly.'],
      }),
    );
  }

  if (b.pageErrors.length) {
    out.push(
      candidate({
        id: 'js-errors',
        title: `${plural(b.pageErrors.length, 'uncaught JavaScript error')} during page load`,
        category: 'Broken functionality',
        severity: 'Medium',
        confidence: b.pageErrors.length >= 2 ? 'Medium' : 'Low',
        evidenceStrength: 0.6,
        scope: 0.6,
        summary: 'The browser reported uncaught exceptions while loading the page. Code after the failing statement in that script does not run.',
        howIdentified: 'Pages were loaded in a real browser; uncaught exceptions (pageerror events) and console errors were recorded.',
        evidence: b.pageErrors.slice(0, 5).map((e) => ({ label: e.page, value: e.message, code: true })),
        affectedUrls: [...new Set(b.pageErrors.map((e) => e.page))],
        whyItMatters: 'Uncaught errors often disable interactive features (menus, forms, tracking). The exact user impact depends on which script fails.',
        solution: ['Reproduce with DevTools → Console, follow the stack trace to the script, and fix or update the responsible plugin/theme code.'],
        effort: EFFORT.medium,
        verification: ['Impact on specific features is not proven automatically — confidence limited.'],
      }),
    );
  }
  return out;
};

/** Mobile viewport and horizontal overflow. */
export const mobile: Detector = (ctx) => {
  const out: Candidate[] = [];
  const home = ctx.home;
  if (!home || home.status >= 400) return out;
  const m = ctx.browser.mobile;
  const shot = m?.screenshotFile ? { screenshots: [{ caption: `Homepage at ${m.viewport.width}px (mobile)`, file: m.screenshotFile }] } : {};
  if (!home.viewport) {
    out.push(
      candidate({
        id: 'no-viewport',
        title: 'Homepage has no mobile viewport meta tag',
        category: 'Mobile usability',
        severity: 'High',
        confidence: 'High',
        scope: 1,
        summary: 'Without <meta name="viewport">, phones render the page at desktop width (~980px) and shrink it, making text tiny and tap targets small.',
        howIdentified: `The homepage HTML <head> was inspected for a viewport meta tag.${m ? ` The page was also rendered at a ${m.viewport.width}px mobile viewport.` : ''}`,
        evidence: [
          { label: 'Page', value: home.finalUrl },
          { label: 'Viewport tag', value: '(not present)' },
          ...(m ? [{ label: 'Mobile render', value: `Viewport ${m.viewport.width}px, document width ${m.contentWidth}px` }] : []),
        ],
        affectedUrls: [home.finalUrl],
        whyItMatters: 'Google uses mobile-first indexing; pages that are not mobile-friendly give a poor experience to the majority of visitors.',
        solution: ['Add <meta name="viewport" content="width=device-width, initial-scale=1"> to the theme header, then fix any fixed-width containers it reveals.'],
        effort: EFFORT.small,
        verification: ['Observed in live HTML.'],
        ...shot,
      }),
    );
  } else if (/width\s*=\s*\d{3,}/i.test(home.viewport)) {
    out.push(
      candidate({
        id: 'fixed-viewport',
        title: 'Viewport is fixed to a desktop width',
        category: 'Mobile usability',
        severity: 'High',
        confidence: 'High',
        scope: 1,
        summary: `The viewport tag sets a fixed width ("${home.viewport}") instead of device-width.`,
        howIdentified: 'Parsed the homepage viewport meta tag.',
        evidence: [{ label: 'HTML', value: `<meta name="viewport" content="${home.viewport}">`, code: true }],
        affectedUrls: [home.finalUrl],
        whyItMatters: 'Phones render a zoomed-out desktop layout.',
        solution: ['Use content="width=device-width, initial-scale=1" and make the layout responsive.'],
        effort: EFFORT.small,
        verification: ['Observed in live HTML.'],
        ...shot,
      }),
    );
  }
  if (m && m.horizontalOverflow && home.viewport) {
    const ratio = m.contentWidth / m.viewport.width;
    out.push(
      candidate({
        id: 'mobile-overflow',
        title: `Homepage overflows horizontally on mobile (${m.contentWidth}px content in a ${m.viewport.width}px screen)`,
        category: 'Mobile usability',
        severity: ratio > 1.3 ? 'High' : 'Medium',
        confidence: m.runs >= 2 ? 'High' : 'Medium',
        evidenceStrength: 0.9,
        scope: 0.8,
        summary: 'On a phone-sized screen the page is wider than the display, so visitors can scroll sideways and parts of the layout are cut off.',
        howIdentified: `The homepage was rendered in ${ctx.browser.engine ?? 'Chromium'} at a ${m.viewport.width}×${m.viewport.height} mobile viewport (${plural(m.runs, 'run')}). document.scrollWidth was compared with the viewport width, the html/body overflow-x style was checked, and the outermost elements extending past the right edge were identified.`,
        evidence: [
          { label: 'Mobile viewport', value: `${m.viewport.width}px` },
          { label: 'Detected content width', value: `${m.contentWidth}px` },
          { label: 'Potential horizontal overflow', value: 'YES (not clipped by html/body overflow-x)' },
          {
            label: 'Elements extending past the viewport',
            value: m.overflowingElements.map((e) => `${e.selector}  right edge ${e.right}px, width ${e.width}px`).join('\n') || '(not isolated)',
            code: true,
          },
        ],
        affectedUrls: [home.finalUrl],
        whyItMatters: 'Sideways scrolling is a core mobile usability failure: content is cut off, the page feels broken, and it counts against mobile-friendliness.',
        solution: [
          `Inspect ${m.overflowingElements[0]?.selector ?? 'the flagged elements'} at ${m.viewport.width}px in DevTools device mode.`,
          'Typical fixes: replace fixed widths with max-width:100%; add flex-wrap / min-width:0 on flex children; set img, iframe, video {max-width:100%; height:auto}; fix negative margins or 100vw widths inside padded containers.',
          'Avoid masking it with body{overflow-x:hidden} — fix the element causing it.',
        ],
        effort: EFFORT.small,
        verification: [
          `Overflow reproduced in ${plural(m.runs, 'independent page load')}.`,
          'Pages that clip overflow on html/body are not flagged.',
          'Fixed-position elements (e.g. off-canvas menus) are ignored.',
        ],
        ...shot,
      }),
    );
  }
  return out;
};
