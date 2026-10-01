import type { Candidate } from '../types.js';
import { candidate, EFFORT, headerDump, type Detector } from './helpers.js';

const SECRET_FILES = ['/.env', '/.git/HEAD', '/wp-config.php', '/wp-content/debug.log'];

/** Exposed files, directory listing, security headers, EOL PHP, WordPress user enumeration. */
export const security: Detector = (ctx) => {
  const out: Candidate[] = [];
  const s = ctx.security;

  const critical = s.sensitiveFiles.filter((f) => f.exposed && SECRET_FILES.includes(f.path));
  if (critical.length) {
    out.push(
      candidate({
        id: 'sensitive-file',
        title: 'Potentially sensitive file publicly accessible',
        category: 'Security',
        severity: 'High',
        confidence: 'High',
        scope: 1,
        actionability: 1,
        summary: `${critical.map((f) => f.path).join(', ')} can be downloaded by anyone. Contents were NOT retrieved beyond identifying the file type and are not shown in this report.`,
        howIdentified:
          'The path was requested once without following redirects; only the first few bytes were read to confirm the file format (e.g. KEY=VALUE lines, a Git ref, PHP source), then the body was discarded.',
        evidence: critical.map((f) => ({ label: `${ctx.origin}${f.path}`, value: `HTTP ${f.status} — ${f.note}` })),
        affectedUrls: critical.map((f) => `${ctx.origin}${f.path}`),
        targets: critical.map((f) => f.path),
        whyItMatters: 'Such files commonly contain database credentials, API keys or full source history. Treat any secrets in them as compromised.',
        solution: [
          'Block access immediately at the web server (Apache: <FilesMatch "^\\.(env|git)"> Require all denied; Nginx: location ~ /\\.(?!well-known) { deny all; }) or remove the file from the web root.',
          'Rotate every credential the file may contain (DB passwords, API keys, salts).',
          'Review access logs for earlier downloads.',
        ],
        effort: EFFORT.small,
        verification: [
          'File format confirmed from its first bytes; a 200 that returns an HTML page (e.g. a soft 404) is not counted.',
          'No secret values were read into or stored by this report.',
        ],
      }),
    );
  }

  const listed = s.directoryListing.filter((d) => d.listed);
  if (listed.length) {
    out.push(
      candidate({
        id: 'directory-listing',
        title: 'Directory listing is enabled',
        category: 'Security',
        severity: 'Medium',
        confidence: 'High',
        scope: 0.6,
        summary: 'The server shows a browsable file index for content directories.',
        howIdentified: 'The directory URL was requested; the response is an auto-generated "Index of /" page.',
        evidence: listed.map((d) => ({ label: d.url, value: 'Auto-generated "Index of" page returned' })),
        affectedUrls: listed.map((d) => d.url),
        targets: listed.map((d) => d.url),
        whyItMatters: 'Anyone can enumerate uploaded files (including private documents or backups) and installed plugins.',
        solution: ['Disable autoindex: Apache "Options -Indexes" in .htaccess; Nginx "autoindex off;". Alternatively place an empty index.php in the directory.'],
        effort: EFFORT.quick,
        verification: ['Observed directly.'],
      }),
    );
  }

  const poweredBy = s.serverHeaders['x-powered-by'] ?? '';
  const php = /PHP\/(\d+)\.(\d+)/i.exec(poweredBy);
  if (php && (Number(php[1]) < 8 || (Number(php[1]) === 8 && Number(php[2]) < 2))) {
    out.push(
      candidate({
        id: 'php-eol',
        title: `Server advertises an end-of-life PHP version (${php[0]})`,
        category: 'Server configuration',
        severity: 'Medium',
        confidence: 'Medium',
        evidenceStrength: 0.7,
        scope: 1,
        summary: `The X-Powered-By header reports ${php[0]}, a PHP branch that no longer receives security fixes.`,
        howIdentified: 'Read from the homepage response headers.',
        evidence: [{ label: 'Header', value: `X-Powered-By: ${poweredBy}`, code: true }],
        affectedUrls: [ctx.siteUrl],
        whyItMatters: 'Unsupported PHP gets no security patches and is slower than current releases. No specific vulnerability is claimed.',
        solution: ['Upgrade to a supported PHP branch after testing plugins/theme on staging; set expose_php = Off.'],
        effort: EFFORT.medium,
        verification: ['The header may be stale behind a proxy — confidence Medium.'],
      }),
    );
  }

  if (ctx.siteUrl.startsWith('https:')) {
    const missing = Object.entries(s.headers)
      .filter(([, v]) => v === null)
      .map(([k]) => k);
    if (missing.includes('strict-transport-security') || missing.length >= 4) {
      out.push(
        candidate({
          id: 'security-headers',
          title: `Missing security headers: ${missing.join(', ')}`,
          category: 'Security',
          severity: 'Low',
          confidence: 'High',
          scope: 1,
          summary: 'Common browser security headers are not sent by the homepage.',
          howIdentified: 'Homepage response headers were inspected.',
          evidence: [{ label: 'Response headers', value: headerDump(ctx.homepage.headers, Object.keys(s.headers)), code: true }],
          affectedUrls: [ctx.siteUrl],
          targets: missing,
          whyItMatters: 'HSTS prevents protocol downgrade; nosniff, frame options and CSP reduce XSS and clickjacking risk. Defence-in-depth, not a direct vulnerability.',
          solution: [
            'Add at server/CDN level: Strict-Transport-Security: max-age=31536000; includeSubDomains, X-Content-Type-Options: nosniff, Referrer-Policy: strict-origin-when-cross-origin, X-Frame-Options: SAMEORIGIN (or CSP frame-ancestors).',
          ],
          effort: EFFORT.quick,
          verification: ['Header absence observed directly.'],
        }),
      );
    }
  }

  if (ctx.wordpress.restApi.userEnumeration.exposed) {
    out.push(
      candidate({
        id: 'wp-user-enum',
        title: 'WordPress REST API publicly lists user accounts',
        category: 'WordPress',
        severity: 'Low',
        confidence: 'High',
        scope: 0.5,
        summary: `/wp-json/wp/v2/users returns ${ctx.wordpress.restApi.userEnumeration.count}+ user records (login slugs). Usernames are not reproduced in this report.`,
        howIdentified: 'The public users endpoint was requested without authentication; only the number of records was kept.',
        evidence: [{ label: 'Endpoint', value: `${ctx.origin}/wp-json/wp/v2/users → HTTP 200, ${ctx.wordpress.restApi.userEnumeration.count}+ records` }],
        affectedUrls: [`${ctx.origin}/wp-json/wp/v2/users`],
        whyItMatters: 'Exposed usernames make password-guessing attacks easier. This is WordPress default behaviour for users with published posts.',
        solution: ['Restrict the users endpoint to authenticated requests (rest_endpoints filter or a security plugin) and use display names that differ from login names.'],
        effort: EFFORT.quick,
        verification: ['Default WordPress behaviour — severity kept Low.'],
      }),
    );
  }
  return out;
};
