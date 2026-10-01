const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
  'fbclid', 'gclid', 'dclid', 'gbraid', 'wbraid', 'msclkid', 'mc_cid', 'mc_eid', '_ga', '_gl', 'yclid', 'igshid',
]);

/**
 * Normalize user input into an absolute http(s) URL string.
 * "example.com" → "https://example.com/", "https://Example.com" → "https://example.com/".
 */
export function normalizeInputUrl(raw: string): string {
  let s = raw.trim();
  if (!s) throw new Error('Please enter a website URL.');
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = `https://${s}`;
  // "example.com:8080" is parsed by WHATWG URL as scheme "example.com:" — handled by the prefix above only
  // when there is no scheme-like prefix; guard against "localhost:3000"-style input explicitly.
  if (/^[a-z0-9.-]+:\d+/i.test(raw.trim())) s = `https://${raw.trim()}`;
  const url = new URL(s);
  url.hash = '';
  if (!url.pathname) url.pathname = '/';
  return url.href;
}

/**
 * Canonical form used for de-duplicating crawl targets:
 * lowercase host, no default port, no fragment, tracking params removed, remaining params sorted.
 * Trailing slashes are preserved (they are distinct URLs on many servers).
 */
export function normalizeUrl(input: string, base?: string): string | null {
  let url: URL;
  try {
    url = base ? new URL(input, base) : new URL(input);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  url.hash = '';
  url.hostname = url.hostname.toLowerCase();
  if ((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443')) url.port = '';
  const params = [...url.searchParams.entries()].filter(([k]) => !TRACKING_PARAMS.has(k.toLowerCase()));
  params.sort(([a], [b]) => a.localeCompare(b));
  url.search = '';
  for (const [k, v] of params) url.searchParams.append(k, v);
  return url.href;
}

export function stripWww(host: string): string {
  return host.toLowerCase().replace(/^www\./, '');
}

/** Same site = same registrable host ignoring a leading "www." (scheme may differ). */
export function isSameSite(a: string, b: string): boolean {
  try {
    return stripWww(new URL(a).hostname) === stripWww(new URL(b).hostname);
  } catch {
    return false;
  }
}

const EXCLUDED_PATH_PATTERNS: RegExp[] = [
  /\/wp-admin(\/|$)/i,
  /\/wp-login\.php/i,
  /\/xmlrpc\.php/i,
  /\/(login|log-in|signin|sign-in|logout|log-out|signout|sign-out|register|signup|sign-up)(\/|$|\.)/i,
  /\/(cart|basket|checkout|my-account|account|wishlist|compare)(\/|$)/i,
  /\/(admin|administrator|user|dashboard)(\/|$)/i,
  /\/(feed|rss|atom)(\/|$)/i,
  /\/wp-json(\/|$)/i,
  /\/(search)(\/|$)/i,
  /\/(19|20)\d{2}\/(0[1-9]|1[0-2])(\/\d{1,2})?\/?$/, // date archives (calendar-style)
  /\/(calendar|events)\/.*\d{4}-\d{2}/i,
  /\/page\/\d{2,}\/?$/i, // deep pagination
];

const EXCLUDED_QUERY_KEYS = new Set([
  's', 'q', 'query', 'search', 'add-to-cart', 'add_to_cart', 'replytocom', 'action', 'redirect_to', 'orderby',
  'filter', 'min_price', 'max_price', 'date', 'month', 'year', 'ical', 'outlook-ical', 'tribe-bar-date', 'share', 'print',
]);

const NON_HTML_EXT = /\.(jpe?g|png|gif|webp|avif|svg|ico|bmp|tiff?|pdf|zip|rar|7z|gz|tar|mp[34]|m4a|wav|ogg|webm|mov|avi|docx?|xlsx?|pptx?|csv|txt|xml|json|js|mjs|css|woff2?|ttf|otf|eot|exe|dmg|apk)$/i;

export interface CrawlFilterResult {
  allowed: boolean;
  reason?: string;
}

/** Whether a same-site URL is a sensible crawl target (not login/cart/search/infinite spaces/binary files). */
export function crawlFilter(url: string): CrawlFilterResult {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { allowed: false, reason: 'invalid URL' };
  }
  if (NON_HTML_EXT.test(u.pathname)) return { allowed: false, reason: 'non-HTML resource' };
  for (const re of EXCLUDED_PATH_PATTERNS) if (re.test(u.pathname)) return { allowed: false, reason: `excluded path (${re.source})` };
  const keys = [...u.searchParams.keys()];
  if (keys.some((k) => EXCLUDED_QUERY_KEYS.has(k.toLowerCase()))) return { allowed: false, reason: 'excluded query parameter' };
  if (keys.length > 2) return { allowed: false, reason: 'query-string explosion guard' };
  if (u.href.length > 300) return { allowed: false, reason: 'URL too long' };
  return { allowed: true };
}

export function isLikelyHtmlUrl(url: string): boolean {
  try {
    return !NON_HTML_EXT.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/** Heuristic priority for internal pages: shallow, nav-like, commercial pages first. */
export function urlPriority(url: string, fromNav: boolean, fromHomepage: boolean, inSitemap: boolean): number {
  let score = 0;
  if (fromNav) score += 50;
  if (fromHomepage) score += 25;
  if (inSitemap) score += 10;
  let path = '/';
  try {
    path = new URL(url).pathname;
  } catch {
    /* keep default */
  }
  const segments = path.split('/').filter(Boolean).length;
  score -= segments * 5;
  if (/(service|product|shop|categor|solution|pricing|about|contact|feature|collection)/i.test(path)) score += 15;
  if (/(tag|author|attachment|page\/\d)/i.test(path)) score -= 20;
  if (new URL(url).search) score -= 10;
  return score;
}
