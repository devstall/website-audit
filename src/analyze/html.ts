import * as cheerio from 'cheerio';
import { scanPageForMalware } from './malware.js';
import { extractCommerce } from '../ecommerce/extract.js';
import { isSameSite, normalizeUrl } from '../crawl/url.js';
import type { FetchResult, PageFacts } from '../types.js';

const RENDERED_RESOURCE_SELECTORS: [string, string][] = [
  ['img', 'src'],
  ['script', 'src'],
  ['link[rel~="stylesheet"]', 'href'],
  ['iframe', 'src'],
  ['video', 'src'],
  ['audio', 'src'],
  ['source', 'src'],
  ['embed', 'src'],
  ['object', 'data'],
];

function collectTypes(node: unknown, out: string[]): void {
  if (Array.isArray(node)) {
    node.forEach((n) => collectTypes(n, out));
    return;
  }
  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    const t = obj['@type'];
    if (typeof t === 'string') out.push(t);
    else if (Array.isArray(t)) t.forEach((x) => typeof x === 'string' && out.push(x));
    if (obj['@graph']) collectTypes(obj['@graph'], out);
  }
}

/** Short, human-readable selector-ish label for evidence. */
export function snippet(html: string, max = 300): string {
  const s = html.replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export function analyzeHtml(res: FetchResult, depth: number): PageFacts {
  const $ = cheerio.load(res.body);
  const base = (() => {
    const href = $('base[href]').attr('href');
    try {
      return href ? new URL(href, res.finalUrl).href : res.finalUrl;
    } catch {
      return res.finalUrl;
    }
  })();
  const abs = (u: string | undefined): string | null => {
    if (!u) return null;
    const t = u.trim();
    if (!t || /^(javascript|mailto|tel|data|blob|about|sms|whatsapp|#)/i.test(t)) return null;
    try {
      return new URL(t, base).href;
    } catch {
      return null;
    }
  };
  const isHttps = res.finalUrl.startsWith('https:');

  const titles = $('head title, title').first();
  const metaContent = (sel: string) => $(sel).first().attr('content')?.trim() ?? null;

  const internalLinks: PageFacts['internalLinks'] = [];
  const seenLinks = new Set<string>();
  let externalLinkCount = 0;
  $('a[href]').each((_, el) => {
    const a = $(el);
    const href = abs(a.attr('href'));
    if (!href) return;
    if (!isSameSite(href, res.finalUrl)) {
      externalLinkCount++;
      return;
    }
    const norm = normalizeUrl(href);
    if (!norm || seenLinks.has(norm)) return;
    seenLinks.add(norm);
    const inNav = a.closest('nav, header, [role="navigation"], .menu, .main-navigation, #site-navigation, .navbar').length > 0;
    internalLinks.push({
      url: href,
      text: a.text().replace(/\s+/g, ' ').trim().slice(0, 80),
      ...(a.attr('rel') ? { rel: a.attr('rel') } : {}),
      ...(inNav ? { inNav: true } : {}),
    });
  });

  const images: PageFacts['images'] = [];
  $('img').each((_, el) => {
    const img = $(el);
    const src = abs(img.attr('src') ?? img.attr('data-src') ?? img.attr('data-lazy-src'));
    if (!src) return;
    images.push({
      src,
      alt: img.attr('alt') ?? null,
      ...(img.attr('width') ? { width: img.attr('width') } : {}),
      ...(img.attr('height') ? { height: img.attr('height') } : {}),
      ...(img.attr('loading') ? { loading: img.attr('loading') } : {}),
      srcset: !!(img.attr('srcset') || img.attr('data-srcset') || img.parent('picture').length),
    });
  });

  const scripts: PageFacts['scripts'] = [];
  let inlineScriptCount = 0;
  $('script').each((_, el) => {
    const s = $(el);
    const src = abs(s.attr('src'));
    if (!src) {
      const type = (s.attr('type') ?? '').toLowerCase();
      if (!type || type.includes('javascript') || type === 'module') inlineScriptCount++;
      return;
    }
    scripts.push({
      src,
      async: s.attr('async') !== undefined,
      defer: s.attr('defer') !== undefined,
      module: s.attr('type') === 'module',
      inHead: s.closest('head').length > 0,
    });
  });

  const stylesheets = $('link[rel~="stylesheet"]')
    .map((_, el) => ({ href: abs($(el).attr('href')), media: $(el).attr('media') ?? null }))
    .get()
    .filter((s): s is { href: string; media: string | null } => !!s.href);

  const mixedContent: PageFacts['mixedContent'] = [];
  if (isHttps) {
    for (const [sel, attr] of RENDERED_RESOURCE_SELECTORS) {
      $(sel).each((_, el) => {
        const v = $(el).attr(attr)?.trim();
        if (v && /^http:\/\//i.test(v)) mixedContent.push({ tag: sel.split('[')[0]!, url: v });
      });
    }
  }

  const jsonLd: PageFacts['jsonLd'] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text().trim();
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      const types: string[] = [];
      collectTypes(parsed, types);
      jsonLd.push({ raw: raw.slice(0, 2000), valid: true, types });
    } catch (e) {
      jsonLd.push({ raw: raw.slice(0, 2000), valid: false, error: (e as Error).message, types: [] });
    }
  });

  const og: Record<string, string> = {};
  $('meta[property^="og:"]').each((_, el) => {
    const p = $(el).attr('property');
    const c = $(el).attr('content');
    if (p && c !== undefined && !(p in og)) og[p] = c.trim();
  });
  const twitter: Record<string, string> = {};
  $('meta[name^="twitter:"], meta[property^="twitter:"]').each((_, el) => {
    const p = $(el).attr('name') ?? $(el).attr('property');
    const c = $(el).attr('content');
    if (p && c !== undefined && !(p in twitter)) twitter[p] = c.trim();
  });

  const headingOutline: string[] = [];
  $('h1, h2, h3, h4, h5, h6').each((_, el) => {
    if (headingOutline.length < 60) headingOutline.push(`${(el as { tagName: string }).tagName.toLowerCase()}: ${$(el).text().replace(/\s+/g, ' ').trim().slice(0, 80)}`);
  });

  const $text = cheerio.load(res.body);
  $text('script, style, noscript, template, svg').remove();
  const bodyText = $text('body').text().replace(/\s+/g, ' ').trim();

  const canonicalEls = $('link[rel="canonical"], link[rel~="canonical"]');
  const canonicalHref = canonicalEls.first().attr('href');

  return {
    url: res.requestedUrl,
    finalUrl: res.finalUrl,
    depth,
    status: res.status,
    contentType: res.headers['content-type'] ?? '',
    ttfbMs: res.ttfbMs,
    totalMs: res.totalMs,
    htmlBytes: res.bodyBytes,
    chain: res.chain,
    headers: res.headers,
    title: titles.length ? titles.text().replace(/\s+/g, ' ').trim() : null,
    titleCount: $('title').length,
    metaDescription: metaContent('meta[name="description" i]'),
    canonical: canonicalHref !== undefined ? (abs(canonicalHref) ?? canonicalHref) : null,
    canonicalCount: canonicalEls.length,
    metaRobots: $('meta[name="robots" i], meta[name="googlebot" i]').map((_, el) => $(el).attr('content') ?? '').get().join(', ') || null,
    xRobotsTag: res.headers['x-robots-tag'] ?? null,
    viewport: metaContent('meta[name="viewport" i]'),
    h1: $('h1').map((_, el) => $(el).text().replace(/\s+/g, ' ').trim()).get(),
    headingOutline,
    lang: $('html').attr('lang') ?? null,
    internalLinks,
    externalLinkCount,
    images,
    scripts,
    inlineScriptCount,
    stylesheets,
    iframes: $('iframe').map((_, el) => abs($(el).attr('src')) ?? '').get().filter(Boolean),
    mixedContent,
    jsonLd,
    microdata: $('[itemscope]').length > 0,
    rdfa: $('[typeof][property], [vocab]').length > 0,
    og,
    twitter,
    generator: $('meta[name="generator" i]').map((_, el) => $(el).attr('content') ?? '').get().join(' | ') || null,
    malware: res.status >= 200 && res.status < 300 ? scanPageForMalware($, res.body, res.finalUrl, res.finalUrl) : [],
    commerce: res.status >= 200 && res.status < 300 ? extractCommerce($, res.body, res.finalUrl) : undefined,
    textSample: bodyText.slice(0, 500),
    wordCount: bodyText ? bodyText.split(' ').length : 0,
  };
}

/** True when a robots directive string contains the token (e.g. "noindex"). */
export function hasDirective(value: string | null | undefined, token: string): boolean {
  if (!value) return false;
  return value
    .toLowerCase()
    .split(/[,\s]+/)
    .some((t) => t === token || (t === 'none' && (token === 'noindex' || token === 'nofollow')));
}

/** X-Robots-Tag may be scoped to a user agent ("googlebot: noindex"); treat unscoped or googlebot-scoped as applying. */
export function xRobotsNoindex(value: string | null | undefined): boolean {
  if (!value) return false;
  return value.split(/,(?=\s*[a-z-]+\s*:)/i).some((part) => {
    const m = /^\s*([a-z-]+)\s*:\s*(.*)$/i.exec(part);
    if (m && !['noindex', 'nofollow', 'none', 'noarchive', 'nosnippet', 'unavailable_after', 'max-snippet', 'max-image-preview', 'max-video-preview', 'noimageindex', 'notranslate', 'indexifembedded'].includes(m[1]!.toLowerCase())) {
      return /googlebot|\*/i.test(m[1]!) && hasDirective(m[2], 'noindex');
    }
    return hasDirective(part, 'noindex');
  });
}
