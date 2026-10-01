import { RequestBudgetExceeded, type SafeFetcher } from '../net/fetcher.js';
import type { FetchResult, SecurityInfo } from '../types.js';

export const SECURITY_HEADERS = [
  'strict-transport-security',
  'content-security-policy',
  'x-content-type-options',
  'x-frame-options',
  'referrer-policy',
  'permissions-policy',
] as const;

const DISCLOSURE_HEADERS = ['server', 'x-powered-by', 'x-aspnet-version', 'x-aspnetmvc-version', 'x-generator', 'x-drupal-cache', 'x-litespeed-cache', 'x-varnish'];

interface SensitiveProbe {
  path: string;
  /** Returns true when the (never stored) body proves the file is really exposed. */
  exposed: (res: FetchResult) => boolean;
  note: string;
  wordpressOnly?: boolean;
  /** Bytes to read. Kept tiny for secret-bearing files: just enough to recognise the format. */
  bytes: number;
}

const looksLikeHtml = (res: FetchResult) => /text\/html/i.test(res.headers['content-type'] ?? '') || /^\s*<(!doctype|html)/i.test(res.body);

const PROBES: SensitiveProbe[] = [
  {
    path: '/.env',
    bytes: 2048,
    note: 'Potentially sensitive file publicly accessible (environment configuration).',
    exposed: (r) => r.status === 200 && !looksLikeHtml(r) && /^\s*[A-Z][A-Z0-9_]{2,}\s*=/m.test(r.body),
  },
  {
    path: '/.git/HEAD',
    bytes: 256,
    note: 'Potentially sensitive file publicly accessible (Git repository metadata; source code may be recoverable).',
    exposed: (r) => r.status === 200 && /^(ref:\s*refs\/|[0-9a-f]{40}\s*$)/.test(r.body.trim()),
  },
  {
    path: '/wp-config.php',
    bytes: 2048,
    wordpressOnly: true,
    note: 'Potentially sensitive file publicly accessible (WordPress configuration source).',
    // A normal server executes PHP and returns an empty 200 — that is NOT exposure.
    exposed: (r) => r.status === 200 && /(<\?php|DB_NAME|DB_PASSWORD|AUTH_KEY)/.test(r.body),
  },
  {
    path: '/wp-content/debug.log',
    bytes: 2048,
    wordpressOnly: true,
    note: 'Potentially sensitive file publicly accessible (PHP debug log with server paths/errors).',
    exposed: (r) => r.status === 200 && !looksLikeHtml(r) && /PHP (Warning|Notice|Fatal error|Deprecated|Parse error)/i.test(r.body),
  },
  {
    path: '/readme.html',
    bytes: 16 * 1024,
    wordpressOnly: true,
    note: 'Default WordPress readme publicly accessible (discloses platform; low risk).',
    exposed: (r) => r.status === 200 && /WordPress/i.test(r.body),
  },
  {
    path: '/license.txt',
    bytes: 4096,
    wordpressOnly: true,
    note: 'Default WordPress license.txt publicly accessible (discloses platform; informational).',
    exposed: (r) => r.status === 200 && /WordPress/i.test(r.body),
  },
];

const LISTING_PATHS = ['/wp-content/uploads/', '/wp-content/plugins/'];

export async function investigateSecurity(fetcher: SafeFetcher, origin: string, homepage: FetchResult, isWordPress: boolean): Promise<SecurityInfo> {
  const headers: SecurityInfo['headers'] = {};
  for (const h of SECURITY_HEADERS) headers[h] = homepage.headers[h] ?? null;
  const serverHeaders: Record<string, string> = {};
  for (const h of DISCLOSURE_HEADERS) if (homepage.headers[h]) serverHeaders[h] = homepage.headers[h]!;

  const info: SecurityInfo = { headers, serverHeaders, sensitiveFiles: [], directoryListing: [] };

  for (const probe of PROBES) {
    if (probe.wordpressOnly && !isWordPress) continue;
    let res: FetchResult;
    try {
      // No redirect following: a redirect to the homepage is not exposure.
      res = await fetcher.fetch(`${origin}${probe.path}`, { maxBytes: probe.bytes, followRedirects: false });
    } catch (e) {
      if (e instanceof RequestBudgetExceeded) break;
      continue;
    }
    const exposed = probe.exposed(res);
    info.sensitiveFiles.push({ path: probe.path, status: res.status, exposed, note: exposed ? probe.note : 'Not exposed' });
    // Drop the body immediately — secrets must never be persisted.
    res.body = '';
  }

  if (isWordPress) {
    for (const path of LISTING_PATHS) {
      try {
        const res = await fetcher.fetch(`${origin}${path}`, { maxBytes: 16 * 1024, followRedirects: false });
        info.directoryListing.push({ url: `${origin}${path}`, listed: res.status === 200 && /<title>\s*Index of \//i.test(res.body) });
      } catch (e) {
        if (e instanceof RequestBudgetExceeded) break;
      }
    }
  }
  return info;
}
