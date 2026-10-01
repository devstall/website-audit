import { normalizeUrl } from '../crawl/url.js';
import type { Candidate, PageFacts } from '../types.js';
import { candidate, EFFORT, okPages, plural, type Detector } from './helpers.js';

/** On-page SEO: title, duplicate titles, JSON-LD validity/duplicates, alt text, lang, og:image, H1. */
export const onPage: Detector = (ctx) => {
  const out: Candidate[] = [];
  const pages = okPages(ctx);
  const home = ctx.home;

  if (home && home.status === 200 && !home.title) {
    out.push(
      candidate({
        id: 'home-no-title',
        title: 'Homepage has no <title>',
        category: 'On-page SEO',
        severity: 'High',
        confidence: 'High',
        scope: 0.6,
        summary: 'The homepage HTML has no title element (or it is empty).',
        howIdentified: 'Parsed the homepage <head>.',
        evidence: [{ label: 'Title', value: home.titleCount ? '<title></title> (empty)' : '(no <title> element)', code: true }],
        affectedUrls: [home.finalUrl],
        whyItMatters: 'The title is the main headline in search results and a primary relevance signal.',
        solution: ['Output a descriptive <title> (theme support "title-tag" in WordPress, or the SEO plugin template).'],
        effort: EFFORT.quick,
        verification: ['Observed in HTML.'],
      }),
    );
  }

  const byTitle = new Map<string, PageFacts[]>();
  for (const p of pages) {
    if (!p.title) continue;
    // Pages canonicalized elsewhere are expected to share titles.
    if (p.canonical && normalizeUrl(p.canonical) !== normalizeUrl(p.finalUrl)) continue;
    const key = p.title.toLowerCase();
    byTitle.set(key, [...(byTitle.get(key) ?? []), p]);
  }
  const dupes = [...byTitle.values()].filter((l) => l.length >= 3).sort((a, b) => b.length - a.length);
  if (dupes.length) {
    const d = dupes[0]!;
    out.push(
      candidate({
        id: 'duplicate-titles',
        title: `${d.length} different pages share the same title`,
        category: 'On-page SEO',
        severity: d.length >= pages.length * 0.5 ? 'Medium' : 'Low',
        confidence: 'High',
        scope: d.length / Math.max(1, pages.length),
        summary: `"${d[0]!.title}" is used as the title of ${d.length} distinct, self-canonical pages.`,
        howIdentified: 'Titles of all crawled 200 pages were compared; pages canonicalized to other URLs were excluded.',
        evidence: d.slice(0, 8).map((p) => ({ label: p.finalUrl, value: `<title>${p.title}</title>`, code: true })),
        affectedUrls: d.map((p) => p.finalUrl),
        whyItMatters: 'Identical titles make pages indistinguishable in search results and compete with each other.',
        solution: ['Give each page a unique title; in WordPress check the SEO plugin title template for that content type (e.g. a missing %%title%% variable).'],
        effort: EFFORT.small,
        verification: ['Only self-canonical pages compared.'],
      }),
    );
  }

  const invalidLd = pages.flatMap((p) => p.jsonLd.filter((j) => !j.valid).map((j) => ({ page: p.finalUrl, j })));
  if (invalidLd.length) {
    const affected = [...new Set(invalidLd.map((x) => x.page))];
    out.push(
      candidate({
        id: 'invalid-jsonld',
        title: `Invalid JSON-LD structured data on ${plural(affected.length, 'page')}`,
        category: 'Structured data',
        severity: 'Medium',
        confidence: 'High',
        scope: Math.min(1, affected.length / Math.max(1, pages.length)),
        summary: 'A JSON-LD block cannot be parsed, so search engines discard the whole block.',
        howIdentified: 'Every <script type="application/ld+json"> was parsed with a strict JSON parser.',
        evidence: invalidLd.slice(0, 3).flatMap((x) => [
          { label: 'Page', value: x.page },
          { label: 'Parse error', value: x.j.error ?? '' },
          { label: 'Snippet', value: x.j.raw.slice(0, 400), code: true },
        ]),
        affectedUrls: affected,
        whyItMatters: 'Structured data in an unparseable block is ignored entirely (no rich results; entity signals lost).',
        solution: ['Fix the generator (usually a plugin setting with an unescaped quote or trailing comma, or hand-written schema in a header script) and validate with the Schema Markup Validator.'],
        effort: EFFORT.quick,
        verification: ['Strict JSON parse failure observed.'],
      }),
    );
  }

  if (!home || home.status >= 400) return out;

  const types = home.jsonLd.flatMap((j) => j.types);
  const orgCount = types.filter((t) => t === 'Organization' || t === 'LocalBusiness').length;
  const siteCount = types.filter((t) => t === 'WebSite').length;
  if (orgCount > 1 || siteCount > 1) {
    out.push(
      candidate({
        id: 'duplicate-schema',
        title: 'Duplicate Organization/WebSite structured data on the homepage',
        category: 'Structured data',
        severity: 'Low',
        confidence: 'Medium',
        evidenceStrength: 0.7,
        scope: 0.4,
        summary: 'Multiple sources output the same top-level entities.',
        howIdentified: 'Collected @type values from all JSON-LD blocks and @graph arrays on the homepage.',
        evidence: [{ label: 'Types found', value: types.join(', '), code: true }],
        affectedUrls: [home.finalUrl],
        whyItMatters: 'Conflicting entity data may confuse search engines about the organisation’s identity.',
        solution: ['Disable schema output in one of the plugins/theme so a single graph describes the site.'],
        effort: EFFORT.quick,
        verification: ['May be intentional if the entities have distinct @id values — confidence Medium.'],
      }),
    );
  }

  const noAlt = home.images.filter((i) => i.alt === null);
  if (home.images.length >= 5 && noAlt.length / home.images.length >= 0.5) {
    out.push(
      candidate({
        id: 'missing-alt',
        title: `${noAlt.length} of ${home.images.length} homepage images have no alt attribute`,
        category: 'Accessibility',
        severity: 'Low',
        confidence: 'High',
        scope: 0.4,
        summary: 'Screen reader users get no description for most homepage images.',
        howIdentified: 'Counted <img> elements without an alt attribute (an empty alt="" is treated as correctly decorative).',
        evidence: [{ label: 'Examples', value: noAlt.slice(0, 6).map((i) => i.src).join('\n'), code: true }],
        affectedUrls: [home.finalUrl],
        whyItMatters: 'Accessibility (WCAG 1.1.1) and image search relevance.',
        solution: ['Add meaningful alt text to informative images and alt="" to decorative ones.'],
        effort: EFFORT.small,
        verification: ['Decorative images with alt="" are not counted.'],
      }),
    );
  }

  if (!home.lang) {
    out.push(
      candidate({
        id: 'no-lang',
        title: 'Homepage <html> element has no lang attribute',
        category: 'Accessibility',
        severity: 'Low',
        confidence: 'High',
        scope: 0.5,
        summary: 'The document language is not declared.',
        howIdentified: 'Checked the <html> element.',
        evidence: [{ label: 'HTML', value: '<html> without lang=""', code: true }],
        affectedUrls: [home.finalUrl],
        whyItMatters: 'Screen readers pick the wrong pronunciation (WCAG 3.1.1).',
        solution: ['Output language_attributes() in the theme header (WordPress) or add lang="en" etc.'],
        effort: EFFORT.quick,
        verification: ['Observed directly.'],
      }),
    );
  }

  if (!home.og['og:image'] && !home.twitter['twitter:image']) {
    out.push(
      candidate({
        id: 'no-og-image',
        title: 'Homepage has no social sharing image (og:image)',
        category: 'On-page SEO',
        severity: 'Low',
        confidence: 'High',
        scope: 0.3,
        summary: 'Links to the homepage shared on social platforms show no preview image.',
        howIdentified: 'Checked Open Graph and Twitter card meta tags.',
        evidence: [{ label: 'Open Graph tags found', value: Object.keys(home.og).join(', ') || '(none)', code: true }],
        affectedUrls: [home.finalUrl],
        whyItMatters: 'Shares without images get noticeably less engagement.',
        solution: ['Set a default social image in the SEO plugin or add <meta property="og:image" content="…">.'],
        effort: EFFORT.quick,
        verification: ['Observed directly.'],
      }),
    );
  }

  const noH1 = pages.filter((p) => p.h1.length === 0);
  // False-positive guard: an H1 injected by JavaScript is seen by search engines after rendering.
  const renderedH1 = Math.max(ctx.browser.desktop?.renderedH1Count ?? 0, ctx.browser.mobile?.renderedH1Count ?? 0);
  if (home.h1.length === 0 && renderedH1 === 0 && noH1.length >= Math.max(2, pages.length * 0.5)) {
    out.push(
      candidate({
        id: 'missing-h1',
        title: `${noH1.length} of ${pages.length} pages (including the homepage) have no H1`,
        category: 'On-page SEO',
        severity: 'Low',
        scope: noH1.length / Math.max(1, pages.length),
        summary: 'Pages lack a main heading.',
        howIdentified: 'Counted <h1> elements in the served HTML of every crawled page.',
        evidence: noH1.slice(0, 6).map((p) => ({ label: p.finalUrl, value: p.headingOutline.slice(0, 3).join(' | ') || '(no headings)' })),
        affectedUrls: noH1.map((p) => p.finalUrl),
        whyItMatters: 'The H1 communicates the page topic to users of assistive technology and to search engines.',
        solution: ['Make the page title/hero heading an <h1> in the template.'],
        effort: EFFORT.small,
        verification: [
          ctx.browser.available
            ? 'The homepage was also rendered in a browser: no H1 appears after JavaScript runs either.'
            : 'Browser unavailable: an H1 injected by JavaScript could not be ruled out.',
        ],
        confidence: ctx.browser.available ? 'High' : 'Medium',
      }),
    );
  }
  return out;
};
