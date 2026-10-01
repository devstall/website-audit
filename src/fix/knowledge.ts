/**
 * Fix Assistant knowledge map: turns the primary issue + the publicly detected environment into a guided fix.
 *
 * Rules:
 * - Plugin/CDN-specific menu paths are only included when that plugin/CDN was detected publicly.
 * - Code goes in a child theme or a (must-use) custom plugin — never the parent theme.
 * - Instructions are guidance only. Nothing here claims the issue is fixed; only a re-check can verify that.
 */
import { probeFor } from '../recheck/probes.js';
import type { Candidate, InvestigationResult, Level } from '../types.js';
import { detectEnvironment, type FixEnvironment } from './environment.js';

export type RootCauseLevel = 'Confirmed' | 'Likely' | 'Possible' | 'Unknown';

export const FIX_METHODS = {
  A: 'WordPress Admin',
  B: 'SEO plugin setting',
  C: 'Theme configuration',
  D: 'Child theme code',
  E: 'Custom plugin code',
  F: 'Server configuration',
  G: 'CDN/Cloudflare configuration',
  H: 'Content/page editor change',
  I: 'Image optimization',
  J: 'JavaScript/CSS issue',
  K: 'Redirect configuration',
  L: 'Hosting configuration',
} as const;
export type FixMethodCode = keyof typeof FIX_METHODS;

export interface InstructionSet {
  title: string;
  /** Where this is done, e.g. "WordPress Admin", "Yoast SEO", "Cloudflare dashboard". */
  platform: string;
  steps: string[];
  /** Why this set is shown (e.g. "Yoast SEO detected from HTML signature"). */
  shownBecause?: string;
}

export interface CodeFix {
  title: string;
  file: string;
  location: string;
  language: 'php' | 'apache' | 'nginx' | 'css' | 'html' | 'text' | 'bash';
  code: string;
  whatItDoes: string;
  whyItFixes: string;
  sideEffects: string;
  revert: string;
}

export interface BeforeAfter {
  label: string;
  before: string;
  after: string;
}

export interface FixGuide {
  issueId: string;
  title: string;
  understand: { found: string; why: string; confidence: string };
  method: { code: FixMethodCode; label: string; reason: string; alternatives: { code: FixMethodCode; label: string }[] };
  confidence: { issue: Level; fix: Level; reason: string };
  rootCause: { issue: RootCauseLevel; rootCause: RootCauseLevel; fixLocation: RootCauseLevel; explanation: string };
  instructions: InstructionSet[];
  code: CodeFix[];
  beforeAfter: BeforeAfter[];
  difficulty: 'Easy' | 'Moderate' | 'Advanced';
  access: string[];
  time: string;
  risk: 'Low' | 'Medium' | 'High';
  backup: boolean;
  staging: boolean;
  verification: string[];
  environment: FixEnvironment;
  /** Detected-environment summary lines ("WordPress 6.6", "Yoast SEO", "Cloudflare"…). */
  detected: string[];
}

type Spec = Omit<FixGuide, 'issueId' | 'title' | 'understand' | 'verification' | 'environment' | 'detected' | 'method' | 'confidence'> & {
  method: FixMethodCode;
  methodReason: string;
  alternatives?: FixMethodCode[];
  fixConfidence: Level;
  fixConfidenceReason: string;
  why: string;
};

// ------------------------------------------------------------------ helpers

const MENU_NOTE = 'Menu labels can differ slightly between plugin versions.';
const host = (url: string) => new URL(url).hostname;
const origin = (url: string) => new URL(url).origin;
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ev = (c: Candidate, label: string) => c.evidence.find((e) => e.label === label)?.value;
const evAll = (c: Candidate, label: string) => c.evidence.filter((e) => e.label === label).map((e) => e.value);

function cachePurge(env: FixEnvironment): InstructionSet[] {
  const out: InstructionSet[] = [];
  const paths: Record<string, string[]> = {
    'litespeed-cache': ['WordPress Admin', 'LiteSpeed Cache', 'Toolbox', 'Purge', 'Purge All'],
    'wp-rocket': ['WordPress Admin', 'Settings', 'WP Rocket', 'Dashboard', 'Clear and preload cache'],
    'w3-total-cache': ['WordPress Admin', 'Performance', 'Dashboard', 'Empty all caches'],
    'wp-super-cache': ['WordPress Admin', 'Settings', 'WP Super Cache', 'Delete Cache'],
    'wp-fastest-cache': ['WordPress Admin', 'WP Fastest Cache', 'Delete Cache'],
  };
  for (const cache of env.caches) {
    const p = paths[cache.slug];
    if (p) out.push({ title: `Clear the ${cache.name} cache`, platform: cache.name, steps: p, shownBecause: `${cache.name} detected (${cache.evidence.slice(0, 80)})` });
  }
  if (env.elementor) {
    out.push({
      title: 'Regenerate Elementor CSS',
      platform: 'Elementor',
      steps: ['WordPress Admin', 'Elementor', 'Tools', 'General', 'Regenerate CSS & Data (labelled "Regenerate Files & Data" in newer versions)'],
      shownBecause: 'Elementor detected',
    });
  }
  if (env.cdn) {
    out.push({ title: 'Purge the Cloudflare cache', platform: 'Cloudflare dashboard', steps: ['Cloudflare dashboard', 'Select the domain', 'Caching', 'Configuration', 'Purge Everything'], shownBecause: `Cloudflare detected (${env.cdn.evidence})` });
  }
  if (!out.length) {
    out.push({ title: 'Clear caches', platform: 'Hosting / caching layer', steps: ['Purge any page cache (hosting cache, caching plugin or CDN). No caching plugin or CDN was publicly detected, so check your hosting panel.'] });
  }
  return out;
}

/** Where theme-level code should go, given the detected theme. Never the parent theme. */
function childThemeLocation(env: FixEnvironment): string {
  if (env.theme?.isChild) return `Active child theme "${env.theme.name ?? env.theme.slug}" (child of ${env.theme.parent}) — safe to edit, survives parent updates.`;
  if (env.theme) return `Create a child theme of "${env.theme.name ?? env.theme.slug}" first (or use a small custom plugin). Do NOT edit the "${env.theme.slug}" theme directly — theme updates overwrite changes.`;
  return 'Child theme or a small custom plugin. Never edit a parent theme directly.';
}
const childFile = (env: FixEnvironment, file: string) => (env.theme?.isChild ? `wp-content/themes/${env.theme.slug}/${file}` : `wp-content/themes/<your-child-theme>/${file}`);
const MU_LOCATION = 'Custom plugin: wp-content/mu-plugins/ (must-use plugins load automatically and are not affected by theme changes). Create the folder if it does not exist.';

function serverCode(env: FixEnvironment, title: string, apache: string, nginx: string, meta: Omit<CodeFix, 'title' | 'file' | 'location' | 'language' | 'code'>): CodeFix[] {
  const a: CodeFix = { title: `${title} (Apache / LiteSpeed)`, file: '.htaccess', location: 'Web root, ABOVE the "# BEGIN WordPress" block (WordPress rewrites that block).', language: 'apache', code: apache, ...meta };
  const n: CodeFix = { title: `${title} (Nginx)`, file: 'Nginx server block (e.g. /etc/nginx/sites-available/your-site)', location: 'Inside the server { } block for this site; reload Nginx afterwards (nginx -t && systemctl reload nginx).', language: 'nginx', code: nginx, ...meta };
  if (env.server === 'nginx') return [n];
  if (env.server === 'apache' || env.server === 'litespeed') return [a];
  return [a, n]; // Server not publicly identifiable: offer both.
}

function seoPath(env: FixEnvironment, topic: 'noindex' | 'canonical' | 'sitemap' | 'robots' | 'title' | 'ogimage' | 'schema'): InstructionSet | null {
  const s = env.seo;
  if (!s) return null;
  const P: Record<string, Partial<Record<typeof topic, string[]>>> = {
    'wordpress-seo': {
      noindex: ['WordPress Admin', 'Yoast SEO', 'Settings', 'Content types', 'Pages (and Posts)', '"Show pages in search results" = On', 'Save changes', 'Then per page: edit the page → Yoast SEO box → Advanced → "Allow search engines to show this page in search results?" = Yes'],
      canonical: ['WordPress Admin', 'Pages', 'Edit the affected page', 'Yoast SEO box', 'Advanced', 'Canonical URL — clear it (Yoast then outputs the page’s own URL) or enter the correct https:// URL', 'Update'],
      sitemap: ['WordPress Admin', 'Yoast SEO', 'Settings', 'Site features', 'XML sitemaps = On', 'Save changes', 'The sitemap is served at /sitemap_index.xml'],
      robots: ['WordPress Admin', 'Yoast SEO', 'Tools', 'File editor', 'Edit robots.txt', 'Save changes to robots.txt'],
      title: ['WordPress Admin', 'Yoast SEO', 'Settings', 'Content types', 'Pages', 'SEO title — make sure it contains the %%title%% variable', 'Save changes'],
      ogimage: ['WordPress Admin', 'Yoast SEO', 'Settings', 'General', 'Site basics', 'Site image — select a 1200×630 image', 'Save changes'],
      schema: ['WordPress Admin', 'Yoast SEO', 'Settings', 'General', 'Site representation', 'Confirm the Organization/Person details', 'Then disable schema output in the theme or other plugins'],
    },
    'seo-by-rank-math': {
      noindex: ['WordPress Admin', 'Rank Math SEO', 'Titles & Meta', 'Pages (and Posts)', 'Robots Meta — untick "No Index"', 'Save Changes', 'Also check Titles & Meta → Global Meta → Robots Meta', 'Per page: edit the page → Rank Math → Advanced → Robots Meta'],
      canonical: ['WordPress Admin', 'Pages', 'Edit the affected page', 'Rank Math panel', 'Advanced tab', 'Canonical URL — clear it or enter the correct https:// URL', 'Update'],
      sitemap: ['WordPress Admin', 'Rank Math SEO', 'Sitemap Settings', 'Check that the needed post types are included', 'Save Changes', 'The sitemap is served at /sitemap_index.xml'],
      robots: ['WordPress Admin', 'Rank Math SEO', 'General Settings', 'Edit robots.txt', 'Save Changes'],
      title: ['WordPress Admin', 'Rank Math SEO', 'Titles & Meta', 'Pages', 'Single Page Title — make sure it contains %title%', 'Save Changes'],
      ogimage: ['WordPress Admin', 'Rank Math SEO', 'Titles & Meta', 'Global Meta', 'OpenGraph Thumbnail — select a 1200×630 image', 'Save Changes'],
      schema: ['WordPress Admin', 'Rank Math SEO', 'Titles & Meta', 'Local SEO', 'Confirm the Organization details', 'Then disable schema output in the theme or other plugins'],
    },
    'all-in-one-seo-pack': {
      noindex: ['WordPress Admin', 'All in One SEO', 'Search Appearance', 'Content Types', 'Pages', 'Advanced', 'Robots Meta — use default settings / untick "No Index"', 'Save Changes'],
      canonical: ['WordPress Admin', 'Pages', 'Edit the affected page', 'AIOSEO Settings box', 'Advanced tab', 'Canonical URL — clear it or enter the correct https:// URL', 'Update'],
      sitemap: ['WordPress Admin', 'All in One SEO', 'Sitemaps', 'General Sitemap = Enabled', 'Save Changes'],
      robots: ['WordPress Admin', 'All in One SEO', 'Tools', 'Robots.txt Editor', 'Edit the rules', 'Save Changes'],
      title: ['WordPress Admin', 'All in One SEO', 'Search Appearance', 'Content Types', 'Pages', 'Post Title — make sure it contains the Post Title tag', 'Save Changes'],
      ogimage: ['WordPress Admin', 'All in One SEO', 'Social Networks', 'Facebook', 'Default Post Image — select a 1200×630 image', 'Save Changes'],
      schema: ['WordPress Admin', 'All in One SEO', 'Search Appearance', 'Global Settings', 'Knowledge Graph', 'Then disable schema output in the theme or other plugins'],
    },
  };
  const steps = P[s.slug]?.[topic];
  return steps ? { title: `${s.name} setting`, platform: s.name, steps: [...steps, MENU_NOTE], shownBecause: `${s.name} detected (${s.evidence.slice(0, 80)})` } : null;
}

const wpAdmin = (title: string, steps: string[]): InstructionSet => ({ title, platform: 'WordPress Admin', steps: ['WordPress Admin', ...steps] });
const cloudflare = (env: FixEnvironment, title: string, steps: string[]): InstructionSet[] =>
  env.cdn ? [{ title, platform: 'Cloudflare dashboard', steps: ['Cloudflare dashboard', 'Select the domain', ...steps], shownBecause: `Cloudflare detected (${env.cdn.evidence})` }] : [];
const nonEmpty = <T>(x: (T | null | false | undefined)[]): T[] => x.filter((v): v is T => !!v);

const EXPLAIN_BACKEND = 'The public website confirms the problem, but the exact configuration responsible cannot be confirmed without backend access.';

// ------------------------------------------------------------------ specs per issue

type Builder = (c: Candidate, env: FixEnvironment, r: InvestigationResult) => Spec;

const redirectRules = (r: InvestigationResult, env: FixEnvironment): CodeFix[] => {
  const final = new URL(r.siteUrl);
  const h = final.hostname;
  return serverCode(
    env,
    'Single-hop HTTPS + host redirect',
    `# Send every http:// and wrong-host request straight to ${final.origin} in ONE 301.
RewriteEngine On
RewriteCond %{HTTPS} off [OR]
RewriteCond %{HTTP_HOST} !^${escRe(h)}$ [NC]
RewriteRule ^ https://${h}%{REQUEST_URI} [L,R=301]`,
    `# Separate server blocks for the variants, each a single 301 to the preferred origin.
server {
    listen 80;
    server_name ${h} ${h.startsWith('www.') ? h.slice(4) : `www.${h}`};
    return 301 https://${h}$request_uri;
}
server {
    listen 443 ssl;
    server_name ${h.startsWith('www.') ? h.slice(4) : `www.${h}`};
    # ssl_certificate … (must cover this hostname too)
    return 301 https://${h}$request_uri;
}`,
    {
      whatItDoes: `Redirects http:// and the alternate hostname directly to https://${h} with one permanent redirect, keeping the path.`,
      whyItFixes: 'All variants reach the final URL in a single hop, so there is no chain, no HTTP hop and no duplicate host.',
      sideEffects: env.cdn
        ? 'Behind Cloudflare the origin often sees plain HTTP even for HTTPS visitors, so "%{HTTPS} off" can cause a redirect LOOP. Prefer the Cloudflare settings shown above, or test for X-Forwarded-Proto instead.'
        : 'If a proxy/load balancer terminates TLS, the origin may see HTTP for every request (redirect loop). In that case test X-Forwarded-Proto instead of %{HTTPS}.',
      revert: 'Remove the added lines (or the added server blocks) and reload the server.',
    },
  );
};

const SPECS: Record<string, Builder> = {
  'homepage-error': (c) => ({
    why: 'The server or application fails while building the homepage (PHP fatal error, exhausted workers or memory, database outage) or a rewrite rule sends it to an error.',
    method: 'L',
    methodReason: 'Server errors are diagnosed from the hosting error logs, which only the host/server can see.',
    alternatives: ['F', 'E'],
    fixConfidence: 'Low',
    fixConfidenceReason: 'The public response proves the failure, but the cause is only visible in the server/PHP error log.',
    rootCause: { issue: 'Confirmed', rootCause: 'Unknown', fixLocation: 'Possible', explanation: 'URL-only analysis can see the status code, not the server-side error behind it.' },
    instructions: [
      { title: 'Read the error log', platform: 'Hosting panel', steps: ['Open your hosting control panel', 'Logs / Error log (Apache/Nginx and PHP)', `Find entries at the time of the request to ${c.affectedUrls[0]}`, 'Fix or roll back the plugin/theme/update named in the fatal error'] },
      wpAdmin('If WordPress Admin still loads', ['Tools', 'Site Health', 'Info / Status — check PHP errors and failed checks', 'Plugins — deactivate the most recently updated plugin if the log points to it']),
    ],
    code: [
      {
        title: 'Log PHP errors privately (temporary)',
        file: 'wp-config.php',
        location: 'Above the line "/* That\'s all, stop editing! */". wp-config.php is site configuration, not theme code.',
        language: 'php',
        code: `define( 'WP_DEBUG', true );
define( 'WP_DEBUG_DISPLAY', false );
// Log OUTSIDE the public web root so the log cannot be downloaded.
define( 'WP_DEBUG_LOG', '/home/USER/logs/wp-errors.log' );`,
        whatItDoes: 'Writes PHP errors to a private log file without showing them to visitors.',
        whyItFixes: 'It does not fix the error; it reveals which plugin/theme/file causes it so it can be fixed.',
        sideEffects: 'Log files grow over time. Never log to wp-content/debug.log on a public site (it is downloadable).',
        revert: 'Remove the three lines (or set WP_DEBUG to false) once the error is fixed.',
      },
    ],
    beforeAfter: [{ label: 'Homepage response', before: `GET ${c.affectedUrls[0]}\n→ ${ev(c, 'Final status') ?? 'error'}`, after: `GET ${c.affectedUrls[0]}\n→ 200 OK` }],
    difficulty: 'Advanced',
    access: ['Hosting', 'Server'],
    time: '30 minutes – 3 hours',
    risk: 'Medium',
    backup: true,
    staging: false,
  }),

  'homepage-blocked': (_c, env) => ({
    why: 'A firewall / bot-protection rule answers automated requests with 403/429. It may or may not apply to search engine crawlers.',
    method: env.cdn ? 'G' : 'L',
    methodReason: env.cdn ? 'Cloudflare was detected; its WAF/bot rules are the most likely source.' : 'Web application firewalls are configured at the host or security-plugin level.',
    alternatives: ['E', 'F'],
    fixConfidence: 'Low',
    fixConfidenceReason: 'Which rule blocks the request (and whether it also blocks Googlebot) is not visible publicly.',
    rootCause: { issue: 'Likely', rootCause: 'Possible', fixLocation: 'Possible', explanation: 'Bot protection usually targets unknown user agents only; verified crawlers are often allowed.' },
    instructions: [
      ...cloudflare(env, 'Review Cloudflare security events', ['Security', 'Events', 'Filter by the blocked request time', 'Check which rule (WAF, Bot Fight Mode, rate limit) acted', 'Make sure verified bots are allowed']),
      { title: 'Check host / security plugin firewall', platform: 'Hosting / security plugin', steps: ['Open the firewall or security plugin log', 'Find the blocked request', 'Confirm that verified search engine crawlers are allowed'] },
      { title: 'Confirm Googlebot access', platform: 'Google Search Console', steps: ['URL Inspection', 'Enter the homepage URL', 'Test live URL — it must return "URL is available to Google"'] },
    ],
    code: [],
    beforeAfter: [],
    difficulty: 'Moderate',
    access: env.cdn ? ['CDN', 'Hosting'] : ['Hosting'],
    time: '15–45 minutes',
    risk: 'Medium',
    backup: false,
    staging: false,
  }),

  'redirect-loop': (c, env) => ({
    why: env.cdn
      ? 'Two layers redirect in opposite directions. Behind Cloudflare the classic cause is SSL mode "Flexible": Cloudflare fetches the origin over HTTP, the origin redirects to HTTPS, and the cycle repeats.'
      : 'Two layers (server rules, CMS site URL, CDN) redirect in opposite directions.',
    method: env.cdn ? 'G' : 'K',
    methodReason: env.cdn ? 'Cloudflare was detected, and its SSL mode is the most common loop cause.' : 'The loop is created by redirect rules.',
    alternatives: ['A', 'F'],
    fixConfidence: env.cdn ? 'Medium' : 'Low',
    fixConfidenceReason: EXPLAIN_BACKEND,
    rootCause: { issue: 'Confirmed', rootCause: env.cdn ? 'Likely' : 'Possible', fixLocation: 'Possible', explanation: 'The loop itself is observed hop by hop; which layer creates each hop is inferred.' },
    instructions: [
      ...cloudflare(env, 'Set Cloudflare SSL to Full (strict)', ['SSL/TLS', 'Overview', 'Encryption mode: Full (strict) (requires a valid certificate on the origin)', 'Then SSL/TLS → Edge Certificates → Always Use HTTPS = On']),
      ...(env.wordpress ? [wpAdmin('Check the WordPress site URLs', ['Settings', 'General', 'WordPress Address (URL) and Site Address (URL) must both be the final https:// URL', 'Save Changes'])] : []),
      { title: 'Check server redirect rules', platform: 'Server', steps: ['Review .htaccess / Nginx redirects', 'Keep exactly one rule that sends visitors to the final https:// host'] },
    ],
    code: [],
    beforeAfter: [{ label: 'Redirects', before: ev(c, 'Redirect chain') ?? '', after: `${c.affectedUrls[0]}\n→ 301 → ${new URL(c.affectedUrls[0]!).origin.replace('http:', 'https:')}/ [200]` }],
    difficulty: 'Moderate',
    access: nonEmpty([env.cdn && 'CDN', env.wordpress && 'WordPress Admin', 'Server']),
    time: '15–60 minutes',
    risk: 'Medium',
    backup: true,
    staging: false,
  }),

  'http-no-redirect': (c, env, r) => ({
    why: 'No rule redirects plain-HTTP requests to HTTPS, so the server serves the site on both protocols.',
    method: env.cdn ? 'G' : 'F',
    methodReason: env.cdn ? 'Cloudflare was detected: "Always Use HTTPS" fixes this at the edge without touching the server.' : 'HTTP→HTTPS redirects belong in the web server configuration.',
    alternatives: env.cdn ? ['F', 'K'] : ['K', 'L'],
    fixConfidence: 'High',
    fixConfidenceReason: 'A single sitewide redirect rule reliably fixes this; the exact file depends on the server.',
    rootCause: { issue: 'Confirmed', rootCause: 'Confirmed', fixLocation: env.cdn || env.server ? 'Likely' : 'Possible', explanation: 'The HTTP response was observed directly: no redirect exists.' },
    instructions: [
      ...cloudflare(env, 'Enable Always Use HTTPS', ['SSL/TLS', 'Edge Certificates', 'Always Use HTTPS = On']),
      ...(env.wordpress ? [wpAdmin('Confirm HTTPS site URLs', ['Settings', 'General', 'WordPress Address and Site Address start with https://', 'Save Changes'])] : []),
      ...cachePurge(env),
    ],
    code: env.cdn ? [] : redirectRules(r, env),
    beforeAfter: [
      { label: 'Redirects', before: `http://${host(r.siteUrl)}/\n↓\n200 OK (served over plain HTTP)`, after: `http://${host(r.siteUrl)}/\n↓ 301\nhttps://${host(r.siteUrl)}/` },
    ],
    difficulty: 'Easy',
    access: env.cdn ? ['CDN'] : ['Server'],
    time: '15–30 minutes',
    risk: env.cdn ? 'Low' : 'Medium',
    backup: !env.cdn,
    staging: false,
  }),

  'duplicate-host': (c, env, r) => ({
    why: 'The alternate hostname (www / non-www) is configured as a working site instead of redirecting.',
    method: env.cdn ? 'G' : 'K',
    methodReason: env.cdn ? 'Cloudflare was detected; a Redirect Rule handles this at the edge.' : 'A host redirect rule consolidates the two hostnames.',
    alternatives: ['F', 'L'],
    fixConfidence: 'High',
    fixConfidenceReason: 'A sitewide 301 from one hostname to the other reliably fixes this.',
    rootCause: { issue: 'Confirmed', rootCause: 'Confirmed', fixLocation: 'Likely', explanation: 'Both hostnames returned 200 responses.' },
    instructions: [
      ...cloudflare(env, 'Add a Redirect Rule', ['Rules', 'Redirect Rules', 'Create rule', `When hostname equals ${host(c.affectedUrls[0]!)}`, `Dynamic redirect to concat("https://${host(r.siteUrl)}", http.request.uri.path) — status 301, preserve query string`, 'Deploy']),
      ...cachePurge(env).filter((i) => i.platform !== 'Cloudflare dashboard'),
    ],
    code: env.cdn ? [] : redirectRules(r, env),
    beforeAfter: [{ label: 'Alternate host', before: `${c.affectedUrls[0]}\n↓\n200 OK (duplicate copy)`, after: `${c.affectedUrls[0]}\n↓ 301\n${origin(r.siteUrl)}/` }],
    difficulty: 'Easy',
    access: env.cdn ? ['CDN'] : ['Server'],
    time: '15–30 minutes',
    risk: env.cdn ? 'Low' : 'Medium',
    backup: !env.cdn,
    staging: false,
  }),

  'alt-host-tls': (c, env) => ({
    why: 'The TLS certificate does not list this hostname, so browsers refuse the connection before any redirect can run.',
    method: env.cdn ? 'G' : 'L',
    methodReason: env.cdn ? 'Cloudflare issues edge certificates; the hostname needs a proxied DNS record.' : 'Certificates are issued in the hosting panel (e.g. AutoSSL / Let’s Encrypt).',
    alternatives: ['F'],
    fixConfidence: 'High',
    fixConfidenceReason: 'Adding the hostname to the certificate reliably fixes the warning.',
    rootCause: { issue: 'Confirmed', rootCause: 'Confirmed', fixLocation: 'Likely', explanation: 'The TLS handshake failed certificate validation for this hostname.' },
    instructions: [
      ...cloudflare(env, 'Cover the hostname at Cloudflare', ['DNS', 'Records', `Make sure ${host(c.affectedUrls[0]!)} exists and is Proxied (orange cloud)`, 'SSL/TLS → Edge Certificates — the Universal certificate covers the apex and www']),
      { title: 'Re-issue the certificate', platform: 'Hosting panel', steps: ['SSL/TLS or Let’s Encrypt section', `Issue a certificate that includes ${host(c.affectedUrls[0]!)} and the primary hostname`, 'Install it'] },
    ],
    code: [
      { title: 'Let’s Encrypt (servers with shell access)', file: 'Shell', location: 'Server command line', language: 'bash', code: `sudo certbot --expand -d ${host(c.affectedUrls[0]!).replace(/^www\./, '')} -d www.${host(c.affectedUrls[0]!).replace(/^www\./, '')}`, whatItDoes: 'Re-issues the certificate for both hostnames.', whyItFixes: 'The certificate becomes valid for the hostname that showed the warning.', sideEffects: 'Requires DNS for both names pointing at this server.', revert: 'Not needed; the previous certificate is replaced.' },
    ],
    beforeAfter: [{ label: 'HTTPS', before: `${c.affectedUrls[0]}\n→ ${ev(c, 'Error') ?? 'certificate error'}`, after: `${c.affectedUrls[0]}\n→ 301 → primary host` }],
    difficulty: 'Easy',
    access: env.cdn ? ['CDN'] : ['Hosting'],
    time: '15–30 minutes',
    risk: 'Low',
    backup: false,
    staging: false,
  }),

  'canonical-http': (c, env, r) => ({
    why: env.wordpress ? 'WordPress builds canonical URLs from the site URL; an http:// site URL or old http:// values in the database produce http:// canonicals.' : 'The template outputs canonical URLs with an http:// base.',
    method: env.wordpress ? 'A' : 'D',
    methodReason: env.wordpress ? 'In WordPress the canonical scheme comes from Settings → General (and the SEO plugin uses the same base).' : 'The canonical tag is produced by the site template.',
    alternatives: ['B', 'E'],
    fixConfidence: env.wordpress ? 'Medium' : 'Low',
    fixConfidenceReason: EXPLAIN_BACKEND,
    rootCause: { issue: 'Confirmed', rootCause: 'Likely', fixLocation: env.seo ? 'Likely' : 'Possible', explanation: 'The http:// canonical is visible in the HTML; which setting produces it cannot be seen from outside.' },
    instructions: nonEmpty([
      env.wordpress && wpAdmin('Check the site URLs', ['Settings', 'General', 'WordPress Address (URL) → https://…', 'Site Address (URL) → https://…', 'Save Changes']),
      seoPath(env, 'canonical'),
      ...cachePurge(env),
    ]),
    code: env.wordpress
      ? [
          {
            title: 'Replace stored http:// URLs (WP-CLI)',
            file: 'Shell (WP-CLI)',
            location: 'Site root on the server, via SSH',
            language: 'bash',
            code: `wp search-replace 'http://${host(r.siteUrl)}' 'https://${host(r.siteUrl)}' --all-tables --precise --dry-run
# Review the counts, then run again without --dry-run:
wp search-replace 'http://${host(r.siteUrl)}' 'https://${host(r.siteUrl)}' --all-tables --precise`,
            whatItDoes: 'Replaces http:// references to this domain everywhere in the database (serialized data safe).',
            whyItFixes: 'Removes stored http:// values that the SEO plugin or theme uses to build canonical URLs.',
            sideEffects: 'Touches every table. Run --dry-run first and take a database backup.',
            revert: 'Restore the database backup (or run the reverse replacement).',
          },
        ]
      : [],
    beforeAfter: evAll(c, 'Canonical')
      .slice(0, 1)
      .map((href) => ({ label: 'Canonical tag', before: `<link rel="canonical"\n      href="${href}">`, after: `<link rel="canonical"\n      href="${href.replace(/^http:/, 'https:')}">` })),
    difficulty: 'Easy',
    access: env.wordpress ? ['WordPress Admin'] : ['Developer'],
    time: '15–45 minutes',
    risk: 'Low',
    backup: env.wordpress,
    staging: false,
  }),

  'canonical-offsite': (c, env, r) => ({
    why: 'A canonical base URL from another domain (old domain, staging site) is hard-coded in settings, the SEO plugin or the database.',
    method: env.seo ? 'B' : env.wordpress ? 'A' : 'D',
    methodReason: env.seo ? `${env.seo.name} outputs the canonical tag.` : 'The canonical tag is built from the site URL / template.',
    alternatives: ['A', 'E'],
    fixConfidence: 'Medium',
    fixConfidenceReason: EXPLAIN_BACKEND,
    rootCause: { issue: 'Confirmed', rootCause: 'Likely', fixLocation: 'Possible', explanation: 'The foreign canonical is observed in the HTML; where it is stored is not publicly visible.' },
    instructions: nonEmpty([env.wordpress && wpAdmin('Check the site URLs', ['Settings', 'General', `Both URLs must be ${origin(r.siteUrl)}`, 'Save Changes']), seoPath(env, 'canonical'), ...cachePurge(env)]),
    code: [],
    beforeAfter: evAll(c, 'Canonical')
      .slice(0, 1)
      .map((tag) => {
        const href = /href="([^"]+)"/.exec(tag)?.[1] ?? tag;
        let after = href;
        try {
          const u = new URL(href);
          after = `${origin(r.siteUrl)}${u.pathname}`;
        } catch {
          /* keep */
        }
        return { label: 'Canonical tag', before: `<link rel="canonical"\n      href="${href}">`, after: `<link rel="canonical"\n      href="${after}">` };
      }),
    difficulty: 'Moderate',
    access: nonEmpty([env.wordpress ? 'WordPress Admin' : 'Developer']),
    time: '30–60 minutes',
    risk: 'Low',
    backup: true,
    staging: false,
  }),

  'canonical-to-home': (c, env) => ({
    why: 'A template or plugin setting hard-codes the home URL as the canonical for every page.',
    method: env.seo ? 'B' : 'D',
    methodReason: env.seo ? `${env.seo.name} outputs the canonical tag.` : 'The canonical tag comes from the theme template.',
    alternatives: ['D', 'E'],
    fixConfidence: 'Medium',
    fixConfidenceReason: EXPLAIN_BACKEND,
    rootCause: { issue: 'Confirmed', rootCause: 'Likely', fixLocation: 'Possible', explanation: 'The same homepage canonical appears on several distinct pages, which indicates a template-level cause.' },
    instructions: nonEmpty([seoPath(env, 'canonical'), { title: 'Find the source of the tag', platform: 'Developer', steps: ['View source of an affected page', 'Find every <link rel="canonical">', 'Search the child theme / plugins for "rel=\\"canonical\\"" or a hard-coded home_url() canonical'] }, ...cachePurge(env)]),
    code: [],
    beforeAfter: c.evidence
      .filter((e) => e.label === 'Page')
      .slice(0, 1)
      .map((p) => ({ label: 'Canonical tag', before: `<!-- on ${p.value} -->\n<link rel="canonical" href="${ev(c, 'Canonical')}">`, after: `<!-- on ${p.value} -->\n<link rel="canonical" href="${p.value}">` })),
    difficulty: 'Moderate',
    access: ['WordPress Admin', 'Developer'],
    time: '30–90 minutes',
    risk: 'Low',
    backup: true,
    staging: false,
  }),

  'canonical-broken': (c, env) => ({
    why: 'Canonical URLs point at a URL that was deleted, moved or mistyped.',
    method: env.seo ? 'B' : 'H',
    methodReason: env.seo ? 'The canonical is usually overridden in the page’s SEO settings.' : 'Custom canonicals are usually set per page.',
    alternatives: ['K'],
    fixConfidence: 'Medium',
    fixConfidenceReason: EXPLAIN_BACKEND,
    rootCause: { issue: 'Confirmed', rootCause: 'Likely', fixLocation: 'Possible', explanation: 'The target status was requested directly.' },
    instructions: nonEmpty([seoPath(env, 'canonical'), ...cachePurge(env)]),
    code: [],
    beforeAfter: c.evidence
      .filter((e) => e.label === 'Page')
      .slice(0, 1)
      .map((p) => ({ label: 'Canonical tag', before: `<link rel="canonical" href="${(ev(c, 'Canonical') ?? '').split(' → ')[0]}">  (target returns an error)`, after: `<link rel="canonical" href="${p.value}">` })),
    difficulty: 'Easy',
    access: ['WordPress Admin'],
    time: '15–30 minutes',
    risk: 'Low',
    backup: false,
    staging: false,
  }),

  'canonical-multiple': (_c, env) => ({
    why: 'Two sources output a canonical tag — usually two SEO plugins, or the theme plus an SEO plugin.',
    method: env.seo ? 'B' : 'D',
    methodReason: 'One of the two canonical sources must be disabled.',
    alternatives: ['D', 'E'],
    fixConfidence: 'Medium',
    fixConfidenceReason: 'Which plugin/theme emits the second tag must be confirmed in view-source.',
    rootCause: { issue: 'Confirmed', rootCause: 'Likely', fixLocation: 'Possible', explanation: 'The duplicate tags were counted directly in the HTML.' },
    instructions: [
      wpAdmin('Find and disable the second source', ['Plugins', 'Check whether more than one SEO plugin is active — keep only one', 'If only one is active: the theme may output its own canonical (theme options → SEO), switch that off']),
      ...cachePurge(env),
    ],
    code: [],
    beforeAfter: [{ label: 'Homepage <head>', before: '<link rel="canonical" href="…">\n<link rel="canonical" href="…">', after: '<link rel="canonical" href="…">' }],
    difficulty: 'Easy',
    access: ['WordPress Admin'],
    time: '15–30 minutes',
    risk: 'Low',
    backup: false,
    staging: false,
  }),

  'noindex-important': (c, env) => {
    const meta = c.evidence.find((e) => e.label === 'HTML')?.value;
    return {
      why: env.wordpress
        ? 'A sitewide noindex in WordPress usually comes from Settings → Reading → "Discourage search engines" (left on after launch). Page-level noindex comes from SEO plugin settings.'
        : 'The page templates output a robots noindex directive.',
      method: env.wordpress ? 'A' : 'D',
      methodReason: env.wordpress ? 'The most common source is a WordPress core setting.' : 'The directive is produced by the templates or headers.',
      alternatives: ['B', 'F'],
      fixConfidence: env.wordpress ? 'High' : 'Medium',
      fixConfidenceReason: env.wordpress ? 'The WordPress setting and SEO plugin robots settings cover nearly all cases.' : EXPLAIN_BACKEND,
      rootCause: { issue: 'Confirmed', rootCause: env.wordpress ? 'Likely' : 'Possible', fixLocation: env.wordpress ? 'Likely' : 'Possible', explanation: 'The noindex directive was read from the live HTML/headers.' },
      instructions: nonEmpty([
        env.wordpress && wpAdmin('Allow search engines', ['Settings', 'Reading', 'Search engine visibility', 'Untick "Discourage search engines from indexing this site"', 'Save Changes']),
        seoPath(env, 'noindex'),
        ...cachePurge(env),
        { title: 'Request re-indexing', platform: 'Google Search Console', steps: ['URL Inspection', 'Enter the homepage URL', 'Request indexing'] },
      ]),
      code: env.wordpress
        ? [
            {
              title: 'Check / set the setting from the command line (WP-CLI)',
              file: 'Shell (WP-CLI)',
              location: 'Site root on the server, via SSH',
              language: 'bash',
              code: 'wp option get blog_public    # 0 = search engines discouraged\nwp option update blog_public 1',
              whatItDoes: 'Reads and sets the "Search engine visibility" option.',
              whyItFixes: 'blog_public = 1 stops WordPress core from adding noindex.',
              sideEffects: 'None beyond allowing indexing. If this is a staging site, keep it at 0.',
              revert: 'wp option update blog_public 0',
            },
          ]
        : [],
      beforeAfter: meta ? [{ label: 'Robots directive', before: meta, after: '<meta name="robots" content="index, follow">\n(or no robots meta tag at all)' }] : [],
      difficulty: 'Easy',
      access: env.wordpress ? ['WordPress Admin'] : ['Developer'],
      time: '15–30 minutes',
      risk: 'Low',
      backup: false,
      staging: false,
    };
  },

  'robots-5xx': (_c, env) => ({
    why: 'A rewrite rule, security plugin or CDN rule makes /robots.txt fail with a server error.',
    method: 'F',
    methodReason: 'The failure happens on the server when /robots.txt is requested.',
    alternatives: ['L', 'G'],
    fixConfidence: 'Medium',
    fixConfidenceReason: EXPLAIN_BACKEND,
    rootCause: { issue: 'Confirmed', rootCause: 'Possible', fixLocation: 'Possible', explanation: 'The 5xx status was observed directly.' },
    instructions: nonEmpty([
      { title: 'Serve a valid robots.txt', platform: 'Server', steps: ['Upload a plain-text robots.txt to the web root (it overrides WordPress’s virtual file)', 'Check the error log for the /robots.txt request'] },
      seoPath(env, 'robots'),
    ]),
    code: [{ title: 'Minimal robots.txt', file: 'robots.txt', location: 'Web root (same folder as wp-config.php / index.php)', language: 'text', code: `User-agent: *\nDisallow:\n\nSitemap: ${'https://your-domain/sitemap.xml'}`, whatItDoes: 'Serves an allow-all robots.txt as a static file.', whyItFixes: 'A static file bypasses the failing dynamic handler, so Google gets HTTP 200.', sideEffects: 'Replaces rules from the virtual/plugin robots.txt — copy any custom rules into it.', revert: 'Delete the file.' }],
    beforeAfter: [{ label: 'robots.txt', before: 'GET /robots.txt → 5xx', after: 'GET /robots.txt → 200 (text/plain)' }],
    difficulty: 'Moderate',
    access: ['Server'],
    time: '15–45 minutes',
    risk: 'Low',
    backup: false,
    staging: false,
  }),

  'robots-blocks-important': (c, env) => {
    const rule = (ev(c, 'Blocking rule') ?? '').replace(/^Line \d+:\s*/, '');
    return {
      why: 'A Disallow rule in robots.txt matches public pages — often left over from development or written too broadly.',
      method: env.seo ? 'B' : 'F',
      methodReason: env.seo ? `${env.seo.name} includes a robots.txt editor.` : 'robots.txt is a file at the web root.',
      alternatives: ['A', 'F'],
      fixConfidence: 'High',
      fixConfidenceReason: 'The exact rule and line are known.',
      rootCause: { issue: 'Confirmed', rootCause: 'Confirmed', fixLocation: env.seo ? 'Likely' : 'Possible', explanation: 'The rule was matched against the URLs with Googlebot precedence rules.' },
      instructions: nonEmpty([
        seoPath(env, 'robots'),
        env.wordpress && wpAdmin('If robots.txt is generated by WordPress', ['Settings', 'Reading', 'Untick "Discourage search engines from indexing this site"', 'Save Changes']),
        { title: 'Physical robots.txt', platform: 'Server / FTP', steps: ['Open robots.txt in the web root', `Remove or narrow: ${rule}`, 'Save'] },
        { title: 'Validate', platform: 'Google Search Console', steps: ['Settings', 'robots.txt report', 'Request a recrawl'] },
      ]),
      code: [],
      beforeAfter: [{ label: 'robots.txt', before: `User-agent: *\n${rule}`, after: rule.trim() === 'Disallow: /' ? 'User-agent: *\nDisallow:' : `User-agent: *\n# (rule removed or narrowed so it no longer matches public pages)` }],
      difficulty: 'Easy',
      access: env.seo ? ['WordPress Admin'] : ['Server'],
      time: '15 minutes',
      risk: 'Low',
      backup: false,
      staging: false,
    };
  },

  'robots-blocks-assets': (c, env) => {
    const rule = (ev(c, 'Rule') ?? '').replace(/^Line \d+:\s*/, '');
    return {
      why: 'A Disallow rule covers the folders that hold CSS/JS (e.g. /wp-content/ or /wp-includes/).',
      method: env.seo ? 'B' : 'F',
      methodReason: 'The fix is a robots.txt edit.',
      alternatives: ['F'],
      fixConfidence: 'High',
      fixConfidenceReason: 'The blocking rule is known.',
      rootCause: { issue: 'Confirmed', rootCause: 'Confirmed', fixLocation: 'Likely', explanation: 'Each asset URL was tested against the Googlebot rules.' },
      instructions: nonEmpty([seoPath(env, 'robots'), { title: 'Physical robots.txt', platform: 'Server / FTP', steps: ['Open robots.txt in the web root', `Remove "${rule}" or add Allow rules for CSS/JS`, 'Save'] }]),
      code: [],
      beforeAfter: [{ label: 'robots.txt', before: `User-agent: *\n${rule}`, after: `User-agent: *\n${rule}\nAllow: /*.css$\nAllow: /*.js$` }],
      difficulty: 'Easy',
      access: env.seo ? ['WordPress Admin'] : ['Server'],
      time: '15 minutes',
      risk: 'Low',
      backup: false,
      staging: false,
    };
  },

  'soft-404': (c, env) => ({
    why: env.wordpress ? 'A theme, page builder or plugin serves a normal page for unknown URLs (for example a custom 404 page served with status 200).' : 'The application renders a page for any path without setting a 404 status (common with single-page apps).',
    method: env.wordpress ? 'C' : 'F',
    methodReason: env.wordpress ? 'The 404 template/handler belongs to the theme or a plugin.' : 'The server must return 404 for unknown routes.',
    alternatives: ['E', 'K'],
    fixConfidence: 'Low',
    fixConfidenceReason: EXPLAIN_BACKEND,
    rootCause: { issue: 'Confirmed', rootCause: 'Possible', fixLocation: 'Possible', explanation: 'A random nonexistent URL returned 200; which component handles it is not visible.' },
    instructions: nonEmpty([
      env.wordpress && wpAdmin('Find the plugin or setting', ['Plugins', 'Look for "custom 404 page" or "redirect 404" plugins and their settings', 'Appearance → Theme options: check for a custom 404 page setting', 'Elementor/page builder: a 404 template should not replace the status code']),
      { title: 'Verify', platform: 'Terminal', steps: [`curl -I ${c.evidence[0]?.value ?? 'https://your-site/some-random-path/'}  → must show HTTP 404`] },
    ]),
    code: [],
    beforeAfter: [{ label: 'Nonexistent URL', before: `GET /random-nonexistent-path/\n→ 200 OK`, after: 'GET /random-nonexistent-path/\n→ 404 Not Found' }],
    difficulty: 'Moderate',
    access: ['WordPress Admin', 'Developer'],
    time: '30–90 minutes',
    risk: 'Low',
    backup: false,
    staging: true,
  }),

  'soft-404-redirect': (_c, env) => ({
    why: 'A "redirect all 404s to the homepage" rule or plugin is active.',
    method: env.wordpress ? 'A' : 'K',
    methodReason: 'Blanket 404 redirects are usually a plugin option or one server rule.',
    alternatives: ['K', 'F'],
    fixConfidence: 'Medium',
    fixConfidenceReason: EXPLAIN_BACKEND,
    rootCause: { issue: 'Confirmed', rootCause: 'Likely', fixLocation: 'Possible', explanation: 'A random URL redirected to the homepage.' },
    instructions: nonEmpty([env.wordpress && wpAdmin('Disable the blanket redirect', ['Plugins', 'Find the 404 redirect plugin / setting', 'Turn off "redirect all 404s to homepage"', 'Keep targeted 301s for moved pages only'])]),
    code: [],
    beforeAfter: [{ label: 'Nonexistent URL', before: 'GET /random-path/\n→ 301 → /  (homepage)', after: 'GET /random-path/\n→ 404 Not Found' }],
    difficulty: 'Easy',
    access: ['WordPress Admin'],
    time: '15–30 minutes',
    risk: 'Low',
    backup: false,
    staging: false,
  }),

  'broken-internal-links': (c, env, r) => {
    const broken = c.targets?.[0] ?? ev(c, 'Broken URL') ?? '/old-url/';
    const path = (() => {
      try {
        return new URL(broken).pathname;
      } catch {
        return broken;
      }
    })();
    const inNav = /homepage\/navigation/.test(c.title);
    return {
      why: 'The linked page was deleted, moved or renamed (slug change) and the link was not updated, or the URL was mistyped.',
      method: inNav && env.wordpress ? 'A' : 'H',
      methodReason: inNav ? 'The link is in the site navigation, which is edited in the menu settings.' : 'In-content links are edited in the page editor.',
      alternatives: ['K', 'H'],
      fixConfidence: 'High',
      fixConfidenceReason: 'The broken URL and the pages containing it are known exactly.',
      rootCause: { issue: 'Confirmed', rootCause: 'Likely', fixLocation: 'Likely', explanation: 'Status observed directly; the source pages and anchor text are recorded.' },
      instructions: nonEmpty([
        env.wordpress && inNav && wpAdmin('Fix the menu link', ['Appearance', 'Menus (classic themes) — or Appearance → Editor → Navigation (block themes)', `Find the item linking to ${path}`, 'Change the URL to the correct live page (or remove the item)', 'Save Menu']),
        env.elementor && inNav && { title: 'If the header is built with Elementor', platform: 'Elementor', steps: ['Templates', 'Theme Builder', 'Header', 'Edit with Elementor', 'Update the link', 'Update'], shownBecause: 'Elementor detected' },
        { title: 'Fix in-content links', platform: 'Page editor', steps: ['Open each source page listed in the evidence', `Update links to ${path}`, 'Update'] },
        { title: 'Or redirect the old URL', platform: 'Redirects', steps: [`Add a 301 from ${path} to the closest relevant live page (keeps external links and bookmarks working)`] },
        ...cachePurge(env),
      ]),
      code: [
        ...(env.wordpress
          ? [
              {
                title: 'Find every stored occurrence (WP-CLI)',
                file: 'Shell (WP-CLI)',
                location: 'Site root on the server, via SSH',
                language: 'bash' as const,
                code: `wp db search '${path.replace(/'/g, '')}' --all-tables`,
                whatItDoes: 'Lists every database row containing the broken URL (posts, menus, widgets, builder data).',
                whyItFixes: 'Finds links the page editor does not show (widgets, page-builder data).',
                sideEffects: 'Read-only.',
                revert: 'Nothing to revert.',
              },
            ]
          : []),
        ...serverCode(env, 'Permanent redirect for the old URL', `Redirect 301 ${path} ${origin(r.siteUrl)}/CORRECT-PAGE/`, `location = ${path} { return 301 /CORRECT-PAGE/; }`, {
          whatItDoes: `Sends visitors of ${path} to the replacement page.`,
          whyItFixes: 'The old URL stops returning an error for visitors and crawlers.',
          sideEffects: 'Replace CORRECT-PAGE with the real target. Redirecting unrelated pages to the homepage counts as a soft 404.',
          revert: 'Remove the line.',
        }),
      ],
      beforeAfter: [{ label: 'Link', before: `<a href="${broken}">…</a>\n→ ${ev(c, 'Status') ?? '404'}`, after: '<a href="https://…/correct-page/">…</a>\n→ 200' }],
      difficulty: 'Easy',
      access: env.wordpress ? ['WordPress Admin'] : ['Developer'],
      time: '15–60 minutes',
      risk: 'Low',
      backup: false,
      staging: false,
    };
  },

  'redirecting-internal-links': (_c, env) => ({
    why: 'Links use an old slug, http:// or a missing trailing slash, so each click passes through a redirect.',
    method: 'H',
    methodReason: 'The links themselves need updating in menus and content.',
    alternatives: ['A'],
    fixConfidence: 'High',
    fixConfidenceReason: 'Each redirecting link and its final URL are known.',
    rootCause: { issue: 'Confirmed', rootCause: 'Likely', fixLocation: 'Likely', explanation: 'First-hop 3xx statuses observed directly.' },
    instructions: nonEmpty([env.wordpress && wpAdmin('Update menu links', ['Appearance', 'Menus / Editor → Navigation', 'Replace each URL with its final URL', 'Save']), { title: 'Update content links', platform: 'Page editor', steps: ['Replace links with their final URLs as listed in the evidence'] }]),
    code: [],
    beforeAfter: [{ label: 'Link', before: '<a href="http://…/old-slug">', after: '<a href="https://…/new-slug/">' }],
    difficulty: 'Easy',
    access: ['WordPress Admin'],
    time: '30–60 minutes',
    risk: 'Low',
    backup: false,
    staging: false,
  }),

  'sitemap-declared-broken': (_c, env) => ({
    why: 'robots.txt points to a sitemap URL that the current sitemap generator does not serve (common after switching SEO plugins).',
    method: env.seo ? 'B' : 'F',
    methodReason: 'The Sitemap line must match the generator’s real URL.',
    alternatives: ['A'],
    fixConfidence: 'High',
    fixConfidenceReason: 'The declared URL and its failure are known.',
    rootCause: { issue: 'Confirmed', rootCause: 'Likely', fixLocation: 'Likely', explanation: 'Declared sitemap requested and parsed directly.' },
    instructions: nonEmpty([seoPath(env, 'sitemap'), seoPath(env, 'robots'), { title: 'Update robots.txt', platform: 'Server / SEO plugin', steps: ['Change the Sitemap: line to the working sitemap URL', env.seo ? `${env.seo.name}: /sitemap_index.xml` : 'WordPress core: /wp-sitemap.xml'] }]),
    code: [],
    beforeAfter: [{ label: 'robots.txt', before: 'Sitemap: https://…/old-sitemap.xml   (error)', after: `Sitemap: https://…/${env.seo ? 'sitemap_index.xml' : 'wp-sitemap.xml'}` }],
    difficulty: 'Easy',
    access: ['WordPress Admin'],
    time: '15 minutes',
    risk: 'Low',
    backup: false,
    staging: false,
  }),
  'sitemap-broken-urls': (_c, env) => sitemapSpec(env, 'The sitemap cache is stale or lists deleted content.'),
  'sitemap-redirects': (_c, env) => sitemapSpec(env, 'The sitemap lists old URLs (http://, old slugs or inconsistent trailing slashes).'),
  'sitemap-noindex': (_c, env) => sitemapSpec(env, 'Content types are set to noindex but still included in the sitemap.'),
  'sitemap-http-urls': (_c, env, r) => ({
    ...sitemapSpec(env, 'The site URL setting still uses http://, so the sitemap generator builds http:// URLs.'),
    instructions: nonEmpty([env.wordpress && wpAdmin('Use https:// site URLs', ['Settings', 'General', 'WordPress Address and Site Address → https://', 'Save Changes']), seoPath(env, 'sitemap'), ...cachePurge(env)]),
    beforeAfter: [{ label: 'Sitemap entry', before: `<loc>http://${host(r.siteUrl)}/…</loc>`, after: `<loc>https://${host(r.siteUrl)}/…</loc>` }],
  }),
  'sitemap-missing': (_c, env) => ({
    ...sitemapSpec(env, 'No sitemap generator is enabled (or it lives at a non-standard URL not declared in robots.txt).'),
    beforeAfter: [{ label: 'robots.txt', before: '(no Sitemap: line)', after: `Sitemap: https://…/${env.seo ? 'sitemap_index.xml' : 'wp-sitemap.xml'}` }],
  }),

  'mixed-content': (c, env, r) => ({
    why: env.wordpress ? 'Resource URLs stored with http:// (media, theme options, builder data) from before the switch to HTTPS.' : 'Templates or content hard-code http:// resource URLs.',
    method: env.wordpress ? 'A' : 'D',
    methodReason: 'The http:// references are stored in the database/content.',
    alternatives: ['H', 'G'],
    fixConfidence: 'Medium',
    fixConfidenceReason: EXPLAIN_BACKEND,
    rootCause: { issue: 'Confirmed', rootCause: 'Likely', fixLocation: 'Possible', explanation: 'The insecure URLs were seen in the live HTML/browser.' },
    instructions: nonEmpty([env.wordpress && wpAdmin('Confirm HTTPS site URLs', ['Settings', 'General', 'Both URLs → https://', 'Save Changes']), env.elementor && { title: 'Replace URLs inside Elementor data', platform: 'Elementor', steps: ['Elementor', 'Tools', 'Replace URL', `Old: http://${host(r.siteUrl)} → New: https://${host(r.siteUrl)}`, 'Replace URL'], shownBecause: 'Elementor detected' }, ...cachePurge(env)]),
    code: env.wordpress
      ? [
          {
            title: 'Replace stored http:// URLs (WP-CLI)',
            file: 'Shell (WP-CLI)',
            location: 'Site root on the server, via SSH',
            language: 'bash',
            code: `wp search-replace 'http://${host(r.siteUrl)}' 'https://${host(r.siteUrl)}' --all-tables --precise --dry-run\nwp search-replace 'http://${host(r.siteUrl)}' 'https://${host(r.siteUrl)}' --all-tables --precise`,
            whatItDoes: 'Rewrites stored http:// references to this domain as https://.',
            whyItFixes: 'Resources are then requested over HTTPS.',
            sideEffects: 'Touches every table — back up the database and review the dry run first. Third-party http:// URLs are not changed.',
            revert: 'Restore the database backup.',
          },
        ]
      : [],
    beforeAfter: (c.targets ?? []).slice(0, 1).map((u) => ({ label: 'Resource URL', before: `src="${u}"`, after: `src="${u.replace(/^http:/, 'https:')}"` })),
    difficulty: 'Moderate',
    access: env.wordpress ? ['WordPress Admin', 'Hosting'] : ['Developer'],
    time: '30–60 minutes',
    risk: 'Medium',
    backup: true,
    staging: true,
  }),

  'broken-assets': (c, env) => {
    const t = c.targets?.[0] ?? '';
    const pluginSlug = /\/wp-content\/plugins\/([^/]+)/.exec(t)?.[1];
    const fromCache = /\/(cache|min|optimized|autoptimize|litespeed|wp-rocket|et-cache|elementor\/css)\//i.test(t);
    return {
      why: fromCache
        ? 'The file is a generated/combined asset: the page HTML is cached with a reference to a file the optimisation plugin already deleted or regenerated.'
        : pluginSlug
          ? `A file of the plugin "${pluginSlug}" is missing — typically an incomplete update or a deleted build file.`
          : 'The file was deleted or moved, or the asset path is wrong after a migration.',
      method: fromCache ? 'J' : pluginSlug ? 'A' : 'J',
      methodReason: fromCache ? 'Stale optimised CSS/JS is fixed by purging and regenerating caches.' : 'The asset belongs to a plugin/theme and must be restored.',
      alternatives: ['E', 'F'],
      fixConfidence: fromCache ? 'Medium' : 'Low',
      fixConfidenceReason: EXPLAIN_BACKEND,
      rootCause: { issue: 'Confirmed', rootCause: fromCache || pluginSlug ? 'Likely' : 'Possible', fixLocation: 'Possible', explanation: 'The 4xx/5xx response was observed by the browser; why the file is missing is not publicly visible.' },
      instructions: nonEmpty([
        ...cachePurge(env),
        !!pluginSlug && env.wordpress && wpAdmin(`Reinstall the "${pluginSlug}" plugin files`, ['Plugins', `Find the plugin that owns "${pluginSlug}"`, 'Update it (or deactivate → delete → reinstall the same version; settings are normally kept)']),
        { title: 'Verify', platform: 'Browser DevTools', steps: ['Open the page', 'DevTools → Network', 'Reload with cache disabled', 'Confirm no 4xx/5xx for scripts/stylesheets'] },
      ]),
      code: [],
      beforeAfter: t ? [{ label: 'Asset request', before: `GET ${t}\n→ ${/Status: (\S+)/.exec(c.evidence.find((e) => /request$/.test(e.label))?.value ?? '')?.[1] ?? '404'}`, after: `GET ${t}\n→ 200 (or no longer requested)` }] : [],
      difficulty: 'Moderate',
      access: env.wordpress ? ['WordPress Admin'] : ['Developer'],
      time: '15–60 minutes',
      risk: 'Low',
      backup: !!pluginSlug,
      staging: false,
    };
  },

  'js-errors': (_c, env) => ({
    why: 'A script throws during load — often a plugin conflict, a script that expects a library that is not loaded yet (e.g. after "delay/defer JS" optimisation), or outdated code.',
    method: 'J',
    methodReason: 'Uncaught exceptions are debugged in the browser console and fixed in the responsible script.',
    alternatives: env.caches.length ? ['A', 'E'] : ['E'],
    fixConfidence: 'Low',
    fixConfidenceReason: 'The error is observed, but which feature breaks and which component owns the code needs developer debugging.',
    rootCause: { issue: 'Confirmed', rootCause: 'Unknown', fixLocation: 'Possible', explanation: 'Exceptions were recorded by the browser; the responsible code must be traced.' },
    instructions: nonEmpty([
      { title: 'Trace the error', platform: 'Browser DevTools', steps: ['Open the affected page', 'DevTools → Console', 'Click the error’s source link to find the script', 'Identify the plugin/theme from its path (/wp-content/plugins/<name>/)'] },
      env.caches.some((x) => x.slug === 'wp-rocket') && { title: 'Rule out JS optimisation', platform: 'WP Rocket', steps: ['Settings', 'WP Rocket', 'File Optimization', 'Temporarily disable "Delay JavaScript execution" and "Combine JavaScript"', 'Clear cache and re-test', MENU_NOTE], shownBecause: 'WP Rocket detected' },
      env.caches.some((x) => x.slug === 'litespeed-cache') && { title: 'Rule out JS optimisation', platform: 'LiteSpeed Cache', steps: ['LiteSpeed Cache', 'Page Optimization', 'JS Settings', 'Temporarily turn off JS Combine / Load JS Deferred', 'Purge All and re-test', MENU_NOTE], shownBecause: 'LiteSpeed Cache detected' },
    ]),
    code: [],
    beforeAfter: [],
    difficulty: 'Advanced',
    access: ['Developer'],
    time: '1–4 hours',
    risk: 'Medium',
    backup: true,
    staging: true,
  }),

  'no-viewport': (_c, env) => ({
    why: 'The theme header does not output a viewport meta tag (common with old or custom themes).',
    method: env.wordpress ? 'D' : 'D',
    methodReason: 'The tag is added in the theme header, via child theme code.',
    alternatives: ['C', 'E'],
    fixConfidence: 'High',
    fixConfidenceReason: 'Adding the tag is deterministic; follow-up layout fixes may be needed.',
    rootCause: { issue: 'Confirmed', rootCause: 'Confirmed', fixLocation: 'Likely', explanation: 'The tag is absent from the served HTML.' },
    instructions: [...cachePurge(env)],
    code: env.wordpress
      ? [
          {
            title: 'Add the viewport tag',
            file: childFile(env, 'functions.php'),
            location: childThemeLocation(env),
            language: 'php',
            code: `add_action( 'wp_head', function () {
	echo '<meta name="viewport" content="width=device-width, initial-scale=1">' . "\\n";
}, 1 );`,
            whatItDoes: 'Prints the standard responsive viewport tag at the top of <head>.',
            whyItFixes: 'Phones render the page at device width instead of a zoomed-out ~980px canvas.',
            sideEffects: 'A non-responsive theme may now show layout problems that were hidden by zooming. If the theme later adds its own tag there will be two.',
            revert: 'Delete the snippet.',
          },
        ]
      : [{ title: 'Add the viewport tag', file: 'Base layout template', location: 'Inside <head>', language: 'html', code: '<meta name="viewport" content="width=device-width, initial-scale=1">', whatItDoes: 'Declares a responsive viewport.', whyItFixes: 'Phones render at device width.', sideEffects: 'May reveal fixed-width layout problems.', revert: 'Remove the tag.' }],
    beforeAfter: [{ label: '<head>', before: '<!-- no viewport tag -->', after: '<meta name="viewport" content="width=device-width, initial-scale=1">' }],
    difficulty: 'Moderate',
    access: env.wordpress ? ['WordPress Admin', 'Theme access'] : ['Developer'],
    time: '30–90 minutes',
    risk: 'Medium',
    backup: true,
    staging: true,
  }),

  'fixed-viewport': (c, env) => ({
    why: 'The theme header hard-codes a desktop width in the viewport tag.',
    method: 'D',
    methodReason: 'The tag lives in the theme’s header template; override it from a child theme.',
    alternatives: ['C'],
    fixConfidence: 'High',
    fixConfidenceReason: 'The tag content is known exactly.',
    rootCause: { issue: 'Confirmed', rootCause: 'Confirmed', fixLocation: 'Likely', explanation: 'Read from the live HTML.' },
    instructions: [{ title: 'Override the header template', platform: 'Child theme', steps: [childThemeLocation(env), 'Copy header.php from the parent theme into the child theme', 'Change the viewport tag as shown in Before/After', 'Upload and clear caches'] }, ...cachePurge(env)],
    code: [],
    beforeAfter: [{ label: 'Viewport tag', before: ev(c, 'HTML') ?? '', after: '<meta name="viewport" content="width=device-width, initial-scale=1">' }],
    difficulty: 'Moderate',
    access: ['Theme access'],
    time: '30–90 minutes',
    risk: 'Medium',
    backup: true,
    staging: true,
  }),

  'mobile-overflow': (c, env) => {
    const els = (ev(c, 'Elements extending past the viewport') ?? '').split('\n').filter((l) => l && !l.startsWith('('));
    const selectors = els.map((l) => l.split(/\s{2,}/)[0]!.trim()).filter(Boolean).slice(0, 3);
    const widths = els.map((l) => /width (\d+)px/.exec(l)?.[1]).filter(Boolean);
    const sel = selectors.join(',\n  ') || '.the-element';
    return {
      why: 'An element uses a fixed width (or 100vw / negative margins / non-wrapping flex children) wider than a phone screen.',
      method: 'J',
      methodReason: 'A CSS change on the flagged element fixes the overflow.',
      alternatives: env.elementor ? ['H', 'D'] : ['D', 'C'],
      fixConfidence: selectors.length ? 'Medium' : 'Low',
      fixConfidenceReason: selectors.length ? 'The overflowing elements were identified; the exact CSS rule causing their width must be confirmed in DevTools.' : 'The culprit element could not be isolated automatically.',
      rootCause: { issue: 'Confirmed', rootCause: selectors.length ? 'Likely' : 'Possible', fixLocation: 'Likely', explanation: 'The overflow was measured in a real browser at 390px in every run.' },
      instructions: nonEmpty([
        { title: 'Confirm the culprit', platform: 'Browser DevTools', steps: ['Open the homepage', 'DevTools → device mode, 390px wide', `Inspect ${selectors[0] ?? 'the widest element'}`, 'Find the rule setting its width / min-width / margin'] },
        env.elementor && { title: 'If the element is an Elementor section', platform: 'Elementor', steps: ['Edit the page with Elementor', 'Switch to Mobile view (responsive mode)', 'Select the section/widget', 'Advanced → set width/margins for Mobile (remove fixed width, negative margins)', 'Update'], shownBecause: 'Elementor detected' },
        env.wordpress && { title: 'Add the CSS safely', platform: 'WordPress Admin', steps: ['Appearance', 'Customize', 'Additional CSS (classic themes) — or Appearance → Editor → Styles → Additional CSS (block themes)', 'Paste the CSS below', 'Publish'] },
        ...cachePurge(env),
      ]),
      code: [
        {
          title: 'Constrain the overflowing elements on mobile',
          file: env.wordpress ? `Additional CSS, or ${childFile(env, 'style.css')}` : 'Site stylesheet',
          location: env.wordpress ? `Customizer Additional CSS or the child theme. ${childThemeLocation(env)}` : 'Main stylesheet, after existing rules',
          language: 'css',
          code: `@media (max-width: 767px) {
  ${sel} {
    max-width: 100%;
    width: 100%;
    box-sizing: border-box;
  }
  img, iframe, video {
    max-width: 100%;
    height: auto;
  }
}`,
          whatItDoes: 'Limits the flagged elements (and media) to the screen width on phones.',
          whyItFixes: 'Nothing can extend past the viewport, so there is no sideways scrolling.',
          sideEffects: 'Selectors are generated from the live page and may be long or theme-specific; shorten them to the element’s own class. Check that carousels/tables still work.',
          revert: 'Delete the CSS block.',
        },
      ],
      beforeAfter: [{ label: 'CSS', before: `${selectors[0] ?? '.element'} {\n  width: ${widths[0] ?? '1200'}px;\n}`, after: `${selectors[0] ?? '.element'} {\n  max-width: 100%;\n  width: 100%;\n}` }],
      difficulty: 'Moderate',
      access: env.wordpress ? ['WordPress Admin', 'Theme access'] : ['Developer'],
      time: '30–60 minutes',
      risk: 'Low',
      backup: false,
      staging: true,
    };
  },

  'slow-lcp': (c, env) => {
    const ttfb = Number(/(\d+)/.exec(ev(c, 'TTFB (browser)') ?? '')?.[1] ?? 0);
    return {
      why: ttfb > 800 ? `The server itself is slow (TTFB ${ttfb} ms), so the page starts late.` : 'The main hero element (usually an image) is discovered late, lazy-loaded, too large, or blocked by render-blocking CSS/JS.',
      method: ttfb > 800 ? (env.caches.length ? 'A' : 'L') : 'I',
      methodReason: ttfb > 800 ? 'Server response dominates LCP: page caching is the main lever.' : 'The LCP element’s delivery must be prioritised and optimised.',
      alternatives: ['J', 'G', 'L'],
      fixConfidence: 'Medium',
      fixConfidenceReason: 'LCP has several contributing causes; the largest one is inferred from the timing breakdown.',
      rootCause: { issue: 'Confirmed', rootCause: 'Likely', fixLocation: 'Possible', explanation: 'LCP was measured in a real browser (lab data).' },
      instructions: nonEmpty([
        env.caches.some((x) => x.slug === 'wp-rocket') && { title: 'WP Rocket', platform: 'WP Rocket', steps: ['Settings', 'WP Rocket', 'Media — exclude the hero image from LazyLoad', 'File Optimization — Optimize CSS delivery / Load JavaScript deferred', 'Clear and preload cache', MENU_NOTE], shownBecause: 'WP Rocket detected' },
        env.caches.some((x) => x.slug === 'litespeed-cache') && { title: 'LiteSpeed Cache', platform: 'LiteSpeed Cache', steps: ['LiteSpeed Cache', 'Cache — Enable Cache = On', 'Page Optimization → Media Settings — exclude the hero image from Lazy Load', 'Image Optimization — send optimization requests', 'Purge All', MENU_NOTE], shownBecause: 'LiteSpeed Cache detected' },
        !env.caches.length && env.wordpress && { title: 'Enable page caching', platform: 'Hosting / WordPress', steps: ['Enable the host’s page cache, or install one caching plugin', 'Re-test'] },
        { title: 'Prioritise the hero image', platform: 'Page editor / theme', steps: ['Find the LCP element: DevTools → Performance → "LCP" marker', 'Make sure it is not lazy-loaded', 'Serve it in WebP/AVIF at the displayed size'] },
      ]),
      code: [],
      beforeAfter: [{ label: 'Hero image (if it is the LCP element)', before: '<img src="hero.jpg" loading="lazy">', after: '<img src="hero.webp" fetchpriority="high"\n     width="1200" height="600">' }],
      difficulty: 'Advanced',
      access: nonEmpty([env.wordpress && 'WordPress Admin', 'Hosting', 'Developer']),
      time: '2–5 hours',
      risk: 'Medium',
      backup: true,
      staging: true,
    };
  },

  'high-cls': (_c, env) => ({
    why: 'Images, embeds, banners or web fonts load without reserved space, pushing content down.',
    method: 'J',
    methodReason: 'CLS is fixed by reserving space in HTML/CSS.',
    alternatives: ['H', 'D'],
    fixConfidence: 'Medium',
    fixConfidenceReason: 'The shifting elements must be confirmed in DevTools (Performance → Layout shifts).',
    rootCause: { issue: 'Confirmed', rootCause: 'Possible', fixLocation: 'Possible', explanation: 'CLS was measured; the individual shifting elements were not attributed.' },
    instructions: nonEmpty([{ title: 'Find the shifting elements', platform: 'Browser DevTools', steps: ['DevTools → Performance', 'Record a reload', 'Open "Layout shifts"', 'Note which elements move'] }, ...cachePurge(env)]),
    code: [{ title: 'Reserve space for media', file: env.wordpress ? 'Additional CSS / child theme style.css' : 'Site stylesheet', location: env.wordpress ? childThemeLocation(env) : 'Main stylesheet', language: 'css', code: `img, video, iframe { height: auto; }\n.hero img { aspect-ratio: 16 / 9; width: 100%; }\n.cookie-banner { position: fixed; bottom: 0; }`, whatItDoes: 'Keeps media proportional and moves the banner out of the document flow.', whyItFixes: 'The browser reserves space before assets load.', sideEffects: 'Adjust selectors and aspect ratio to the real elements.', revert: 'Delete the CSS.' }],
    beforeAfter: [{ label: 'Image', before: '<img src="photo.jpg">', after: '<img src="photo.jpg" width="800" height="450">' }],
    difficulty: 'Moderate',
    access: ['Developer'],
    time: '1–3 hours',
    risk: 'Low',
    backup: false,
    staging: true,
  }),

  'slow-server': (_c, env) => ({
    why: 'Pages are generated on every request (no page cache), or the hosting plan / database / slow plugins take long to respond.',
    method: env.caches.length ? 'A' : 'L',
    methodReason: 'Full-page caching and hosting resources are the main levers for TTFB.',
    alternatives: ['G', 'E'],
    fixConfidence: 'Medium',
    fixConfidenceReason: 'Cache configuration and backend timing are not publicly visible.',
    rootCause: { issue: 'Confirmed', rootCause: 'Possible', fixLocation: 'Possible', explanation: 'TTFB was measured across pages from one location.' },
    instructions: nonEmpty([
      ...env.caches.map((x) => ({ title: `Check ${x.name} page caching is on`, platform: x.name, steps: [`${x.name} settings`, 'Enable page caching for visitors', 'Purge and re-test', MENU_NOTE], shownBecause: `${x.name} detected` })),
      !env.caches.length && { title: 'Enable page caching', platform: 'Hosting', steps: ['Hosting panel → enable server/page cache (or install one caching plugin)', 'Re-test'] },
      ...cloudflare(env, 'Consider edge caching of HTML', ['Caching', 'Cache Rules', 'Cache eligible HTML for anonymous visitors (bypass for logged-in/cart cookies)']),
    ]),
    code: [],
    beforeAfter: [],
    difficulty: 'Moderate',
    access: ['Hosting', 'WordPress Admin'],
    time: '1–4 hours',
    risk: 'Medium',
    backup: true,
    staging: true,
  }),

  'no-compression': (_c, env) => ({
    why: 'Compression (gzip/brotli) is not enabled for HTML on the server.',
    method: env.cdn ? 'G' : 'F',
    methodReason: 'Compression is a server/CDN setting.',
    alternatives: ['L'],
    fixConfidence: 'High',
    fixConfidenceReason: 'Standard server configuration.',
    rootCause: { issue: 'Confirmed', rootCause: 'Confirmed', fixLocation: 'Likely', explanation: 'No Content-Encoding header despite Accept-Encoding.' },
    instructions: [...cloudflare(env, 'Cloudflare compression', ['Speed', 'Optimization', 'Content Optimization', 'Brotli / compression = On'])],
    code: env.cdn
      ? []
      : serverCode(
          env,
          'Enable compression',
          `<IfModule mod_deflate.c>
  AddOutputFilterByType DEFLATE text/html text/css text/plain application/javascript application/json image/svg+xml
</IfModule>`,
          `gzip on;
gzip_types text/css text/plain application/javascript application/json image/svg+xml;
gzip_min_length 1024;`,
          { whatItDoes: 'Compresses text responses.', whyItFixes: 'HTML is sent compressed (typically 70–85 % smaller).', sideEffects: 'None for normal sites; minor CPU cost.', revert: 'Remove the lines and reload.' },
        ),
    beforeAfter: [{ label: 'Response header', before: 'content-encoding: (none)', after: 'content-encoding: gzip   (or br)' }],
    difficulty: 'Easy',
    access: env.cdn ? ['CDN'] : ['Server'],
    time: '15–30 minutes',
    risk: env.cdn ? 'Low' : 'Medium',
    backup: !env.cdn,
    staging: false,
  }),

  'huge-html': (_c, env) => ({
    why: 'Inline CSS/JS/SVG or deeply nested page-builder markup bloats the document.',
    method: env.elementor ? 'H' : 'J',
    methodReason: 'The size comes from what the page/template outputs.',
    alternatives: ['A', 'D'],
    fixConfidence: 'Low',
    fixConfidenceReason: 'Which blocks contribute most must be profiled.',
    rootCause: { issue: 'Confirmed', rootCause: 'Possible', fixLocation: 'Possible', explanation: 'HTML size was measured directly.' },
    instructions: nonEmpty([env.elementor && { title: 'Elementor output', platform: 'Elementor', steps: ['Elementor', 'Settings', 'Performance / Features', 'Use external CSS files (CSS Print Method: External File)', 'Enable "Optimized DOM Output" if offered', MENU_NOTE], shownBecause: 'Elementor detected' }]),
    code: [],
    beforeAfter: [],
    difficulty: 'Advanced',
    access: ['Developer'],
    time: '2–8 hours',
    risk: 'Medium',
    backup: true,
    staging: true,
  }),

  'heavy-images': (_c, env) => ({
    why: 'Images are uploaded at camera/original size and inserted without responsive sizes.',
    method: 'I',
    methodReason: 'Resizing/compressing the files fixes it.',
    alternatives: ['H', 'A'],
    fixConfidence: 'High',
    fixConfidenceReason: 'The exact image URLs and sizes are known.',
    rootCause: { issue: 'Confirmed', rootCause: 'Likely', fixLocation: 'Likely', explanation: 'Byte sizes from actual responses; displayed widths measured in the browser.' },
    instructions: nonEmpty([
      env.caches.some((x) => x.slug === 'litespeed-cache') && { title: 'LiteSpeed Image Optimization', platform: 'LiteSpeed Cache', steps: ['LiteSpeed Cache', 'Image Optimization', 'Send Optimization Request', 'Image Optimization Settings — enable WebP replacement', MENU_NOTE], shownBecause: 'LiteSpeed Cache detected' },
      env.wordpress && wpAdmin('Replace the image', ['Media', 'Library', 'Upload a resized copy (about 2× the displayed width), WebP if possible', 'Swap it in the page editor using a registered size (Large/Medium) so WordPress adds srcset']),
    ]),
    code: [],
    beforeAfter: [{ label: 'Image', before: 'photo.jpg — 3.2 MB, 4000px wide, shown at 600px', after: 'photo.webp — ~120 KB, 1200px wide, srcset/sizes' }],
    difficulty: 'Easy',
    access: ['WordPress Admin'],
    time: '30–60 minutes',
    risk: 'Low',
    backup: false,
    staging: false,
  }),

  'render-blocking': (_c, env) => ({
    why: 'Plugins/themes enqueue scripts in <head> without defer/async and many stylesheets load on every page.',
    method: env.caches.length ? 'A' : 'D',
    methodReason: env.caches.length ? 'The detected optimisation plugin can defer JS without code.' : 'Scripts can be deferred from child theme code.',
    alternatives: ['J', 'E'],
    fixConfidence: 'Medium',
    fixConfidenceReason: 'Deferring some scripts can break inline code that depends on them; test first.',
    rootCause: { issue: 'Confirmed', rootCause: 'Confirmed', fixLocation: 'Likely', explanation: 'Blocking tags were counted in the HTML.' },
    instructions: nonEmpty([
      env.caches.some((x) => x.slug === 'wp-rocket') && { title: 'WP Rocket', platform: 'WP Rocket', steps: ['Settings', 'WP Rocket', 'File Optimization', 'Load JavaScript deferred = On', 'Save and clear cache', MENU_NOTE], shownBecause: 'WP Rocket detected' },
      env.caches.some((x) => x.slug === 'litespeed-cache') && { title: 'LiteSpeed Cache', platform: 'LiteSpeed Cache', steps: ['LiteSpeed Cache', 'Page Optimization', 'JS Settings', 'Load JS Deferred = Deferred', 'Save and Purge All', MENU_NOTE], shownBecause: 'LiteSpeed Cache detected' },
    ]),
    code: env.wordpress
      ? [
          {
            title: 'Defer a script by handle (WordPress 6.3+)',
            file: childFile(env, 'functions.php'),
            location: childThemeLocation(env),
            language: 'php',
            code: `add_action( 'wp_enqueue_scripts', function () {
	// Replace with the handles of non-critical scripts (see the id="HANDLE-js" attribute in view-source).
	foreach ( array( 'HANDLE-1', 'HANDLE-2' ) as $handle ) {
		wp_script_add_data( $handle, 'strategy', 'defer' );
	}
}, 100 );`,
            whatItDoes: 'Asks WordPress to print the listed scripts with the defer attribute.',
            whyItFixes: 'Deferred scripts no longer block rendering.',
            sideEffects: 'Inline scripts that call these libraries immediately may break (WordPress handles dependency chains, but not arbitrary inline code). Test on staging.',
            revert: 'Delete the snippet.',
          },
        ]
      : [],
    beforeAfter: [{ label: 'Script tag', before: '<script src="…/plugin.js"></script>', after: '<script src="…/plugin.js" defer></script>' }],
    difficulty: 'Moderate',
    access: ['WordPress Admin', 'Theme access'],
    time: '1–3 hours',
    risk: 'Medium',
    backup: true,
    staging: true,
  }),

  'sensitive-file': (c, env) => ({
    why: 'The file sits in the public web root and the server has no rule denying access to it.',
    method: 'F',
    methodReason: 'Access must be denied by the web server (or the file removed).',
    alternatives: ['L'],
    fixConfidence: 'High',
    fixConfidenceReason: 'Deny rules for these paths are standard and reliable.',
    rootCause: { issue: 'Confirmed', rootCause: 'Confirmed', fixLocation: 'Likely', explanation: 'The file format was confirmed from its first bytes.' },
    instructions: [
      { title: 'Contain the exposure now', platform: 'Server', steps: ['Delete the file from the web root if it is not needed there', 'Add the deny rule below', 'ROTATE every credential the file may contain (database password, API keys, salts)', 'Review access logs for earlier downloads'] },
    ],
    code: serverCode(
      env,
      'Deny access to sensitive files',
      `<FilesMatch "^(\\.env|wp-config\\.php|debug\\.log)$">
  Require all denied
</FilesMatch>
RedirectMatch 404 /\\.git`,
      `location ~ /\\.(?!well-known) { deny all; }
location ~* /(wp-config\\.php|debug\\.log)$ { deny all; }`,
      { whatItDoes: 'Blocks HTTP access to dotfiles, the Git folder, wp-config.php source and debug logs.', whyItFixes: 'The files can no longer be downloaded.', sideEffects: 'None for normal sites (these files are never meant to be public).', revert: 'Remove the rules (not recommended).' },
    ),
    beforeAfter: (c.targets ?? []).slice(0, 1).map((p) => ({ label: 'Request', before: `GET ${p}\n→ 200 (file contents served)`, after: `GET ${p}\n→ 403 Forbidden (or 404)` })),
    difficulty: 'Moderate',
    access: ['Server', 'Hosting'],
    time: '30–60 minutes (+ credential rotation)',
    risk: 'Medium',
    backup: true,
    staging: false,
  }),

  'directory-listing': (c, env) => ({
    why: 'Autoindex is enabled on the web server for folders without an index file.',
    method: 'F',
    methodReason: 'Directory listing is a server option.',
    alternatives: ['L'],
    fixConfidence: 'High',
    fixConfidenceReason: 'One standard directive.',
    rootCause: { issue: 'Confirmed', rootCause: 'Confirmed', fixLocation: 'Likely', explanation: 'An "Index of" page was returned.' },
    instructions: [],
    code: serverCode(env, 'Disable directory listing', 'Options -Indexes', 'autoindex off;', { whatItDoes: 'Stops the server from generating file lists.', whyItFixes: 'Folders return 403 instead of a file index.', sideEffects: 'Pages that deliberately rely on listings stop working (rare).', revert: 'Remove the directive.' }),
    beforeAfter: (c.targets ?? []).slice(0, 1).map((u) => ({ label: 'Request', before: `GET ${u}\n→ 200 "Index of /…"`, after: `GET ${u}\n→ 403 Forbidden` })),
    difficulty: 'Easy',
    access: ['Server'],
    time: '15 minutes',
    risk: 'Medium',
    backup: true,
    staging: false,
  }),

  'php-eol': () => ({
    why: 'The hosting account runs an old PHP branch.',
    method: 'L',
    methodReason: 'PHP version is selected in the hosting panel.',
    alternatives: ['F'],
    fixConfidence: 'Medium',
    fixConfidenceReason: 'The header may be stale behind a proxy; plugin/theme compatibility must be tested.',
    rootCause: { issue: 'Likely', rootCause: 'Likely', fixLocation: 'Likely', explanation: 'Taken from the X-Powered-By header.' },
    instructions: [{ title: 'Upgrade PHP', platform: 'Hosting panel', steps: ['Clone the site to staging', 'Hosting panel → PHP version selector (e.g. cPanel → MultiPHP Manager / Select PHP Version)', 'Choose a supported branch (8.2+)', 'Test key pages, forms and checkout', 'Apply to production', 'Set expose_php = Off in php.ini'] }],
    code: [],
    beforeAfter: [],
    difficulty: 'Moderate',
    access: ['Hosting'],
    time: '1–4 hours',
    risk: 'High',
    backup: true,
    staging: true,
  }),

  'security-headers': (c, env) => ({
    why: 'The server/CDN does not add these headers; WordPress does not send them by default.',
    method: env.cdn ? 'G' : 'F',
    methodReason: 'Headers are best set at the server/CDN so they also cover static files.',
    alternatives: ['E'],
    fixConfidence: 'High',
    fixConfidenceReason: 'Standard configuration.',
    rootCause: { issue: 'Confirmed', rootCause: 'Confirmed', fixLocation: 'Likely', explanation: 'Headers absent from the homepage response.' },
    instructions: [...cloudflare(env, 'Add headers at Cloudflare', ['SSL/TLS', 'Edge Certificates', 'HTTP Strict Transport Security (HSTS) — enable', 'Rules → Transform Rules → Modify Response Header — add the other headers'])],
    code: [
      ...serverCode(
        env,
        'Security headers',
        `<IfModule mod_headers.c>
  Header always set Strict-Transport-Security "max-age=31536000; includeSubDomains"
  Header always set X-Content-Type-Options "nosniff"
  Header always set X-Frame-Options "SAMEORIGIN"
  Header always set Referrer-Policy "strict-origin-when-cross-origin"
</IfModule>`,
        `add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
add_header X-Content-Type-Options "nosniff" always;
add_header X-Frame-Options "SAMEORIGIN" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;`,
        {
          whatItDoes: 'Sends the missing browser security headers on every response.',
          whyItFixes: 'The headers are present, as the re-check verifies.',
          sideEffects: 'HSTS makes browsers refuse plain HTTP for a year — only enable it once HTTPS works on every subdomain (drop includeSubDomains otherwise). X-Frame-Options blocks embedding the site in other domains’ iframes.',
          revert: 'Remove the lines. HSTS stays cached in browsers until max-age expires — set max-age=0 first to roll back.',
        },
      ),
      ...(env.wordpress && !env.cdn
        ? [
            {
              title: 'Alternative: send headers from WordPress (pages only)',
              file: 'wp-content/mu-plugins/security-headers.php',
              location: MU_LOCATION,
              language: 'php' as const,
              code: `<?php
/**
 * Plugin Name: Security headers
 */
add_action( 'send_headers', function () {
	header( 'X-Content-Type-Options: nosniff' );
	header( 'X-Frame-Options: SAMEORIGIN' );
	header( 'Referrer-Policy: strict-origin-when-cross-origin' );
	if ( is_ssl() ) {
		header( 'Strict-Transport-Security: max-age=31536000' );
	}
} );`,
              whatItDoes: 'Adds the headers to pages generated by WordPress.',
              whyItFixes: 'The homepage response carries the headers.',
              sideEffects: 'Does not cover static files (images, CSS) or cached pages served before PHP runs.',
              revert: 'Delete the file.',
            },
          ]
        : []),
    ],
    beforeAfter: [{ label: 'Response headers', before: (c.targets ?? []).map((h) => `${h}: (missing)`).join('\n') || 'strict-transport-security: (missing)', after: 'strict-transport-security: max-age=31536000; includeSubDomains\nx-content-type-options: nosniff\nx-frame-options: SAMEORIGIN\nreferrer-policy: strict-origin-when-cross-origin' }],
    difficulty: 'Easy',
    access: env.cdn ? ['CDN'] : ['Server'],
    time: '15–45 minutes',
    risk: 'Medium',
    backup: true,
    staging: true,
  }),

  'wp-user-enum': () => ({
    why: 'WordPress core exposes authors of published posts via the public REST users endpoint.',
    method: 'E',
    methodReason: 'A small must-use plugin restricts the endpoint without touching the theme.',
    alternatives: ['A'],
    fixConfidence: 'High',
    fixConfidenceReason: 'A standard, well-understood filter.',
    rootCause: { issue: 'Confirmed', rootCause: 'Confirmed', fixLocation: 'Confirmed', explanation: 'The endpoint returned user records without authentication.' },
    instructions: [],
    code: [
      {
        title: 'Hide the users endpoint from anonymous visitors',
        file: 'wp-content/mu-plugins/restrict-rest-users.php',
        location: MU_LOCATION,
        language: 'php',
        code: `<?php
/**
 * Plugin Name: Restrict REST user listing
 */
add_filter( 'rest_endpoints', function ( $endpoints ) {
	if ( ! is_user_logged_in() ) {
		unset( $endpoints['/wp/v2/users'], $endpoints['/wp/v2/users/(?P<id>[\\d]+)'] );
	}
	return $endpoints;
} );`,
        whatItDoes: 'Removes the users routes for visitors who are not logged in.',
        whyItFixes: '/wp-json/wp/v2/users returns 404 (rest_no_route) instead of user records.',
        sideEffects: 'External apps that read users anonymously stop working. The block editor is unaffected (it is authenticated).',
        revert: 'Delete the file.',
      },
    ],
    beforeAfter: [{ label: 'Request', before: 'GET /wp-json/wp/v2/users\n→ 200 [ {…"slug": "…"} ]', after: 'GET /wp-json/wp/v2/users\n→ 404 rest_no_route' }],
    difficulty: 'Easy',
    access: ['Developer', 'Hosting'],
    time: '15 minutes',
    risk: 'Low',
    backup: false,
    staging: false,
  }),

  'home-no-title': (_c, env) => ({
    why: env.wordpress ? 'The theme neither declares title-tag support nor prints a <title>, and no SEO plugin outputs one.' : 'The layout template has no <title>.',
    method: env.seo ? 'B' : 'D',
    methodReason: env.seo ? `${env.seo.name} controls the title template.` : 'Title support is declared in theme code.',
    alternatives: ['D'],
    fixConfidence: 'Medium',
    fixConfidenceReason: EXPLAIN_BACKEND,
    rootCause: { issue: 'Confirmed', rootCause: 'Likely', fixLocation: 'Possible', explanation: 'Absent from the served HTML.' },
    instructions: nonEmpty([seoPath(env, 'title'), env.wordpress && wpAdmin('Set the site title', ['Settings', 'General', 'Site Title', 'Save Changes'])]),
    code: env.wordpress
      ? [{ title: 'Enable WordPress title output', file: childFile(env, 'functions.php'), location: childThemeLocation(env), language: 'php', code: `add_action( 'after_setup_theme', function () {\n\tadd_theme_support( 'title-tag' );\n} );`, whatItDoes: 'Lets WordPress print the <title> tag.', whyItFixes: 'Every page gets a title.', sideEffects: 'If header.php also prints <title>, pages will have two titles — remove the manual one.', revert: 'Delete the snippet.' }]
      : [],
    beforeAfter: [{ label: '<head>', before: '<title></title>', after: '<title>Page name — Site name</title>' }],
    difficulty: 'Easy',
    access: ['WordPress Admin', 'Theme access'],
    time: '15–30 minutes',
    risk: 'Low',
    backup: false,
    staging: false,
  }),

  'duplicate-titles': (_c, env) => ({
    why: 'The SEO title template for the content type is missing the page-title variable, or the titles were entered identically.',
    method: env.seo ? 'B' : 'H',
    methodReason: 'Titles come from the SEO plugin template or per-page fields.',
    alternatives: ['H'],
    fixConfidence: 'Medium',
    fixConfidenceReason: EXPLAIN_BACKEND,
    rootCause: { issue: 'Confirmed', rootCause: 'Likely', fixLocation: 'Possible', explanation: 'Identical titles on distinct, self-canonical pages.' },
    instructions: nonEmpty([seoPath(env, 'title'), { title: 'Per page', platform: 'Page editor', steps: ['Edit each affected page', 'Give it a unique SEO title', 'Update'] }, ...cachePurge(env)]),
    code: [],
    beforeAfter: [{ label: 'Title template', before: 'Site name', after: '%%title%% %%sep%% %%sitename%%   (Yoast syntax; each plugin has its own variable)' }],
    difficulty: 'Easy',
    access: ['WordPress Admin'],
    time: '15–60 minutes',
    risk: 'Low',
    backup: false,
    staging: false,
  }),

  'invalid-jsonld': (c, env) => ({
    why: 'Hand-written schema in a header script (or a plugin field) contains a syntax error such as an unescaped quote or trailing comma.',
    method: 'H',
    methodReason: 'Custom JSON-LD is usually pasted into a header-scripts field or a page.',
    alternatives: ['B', 'D'],
    fixConfidence: 'Medium',
    fixConfidenceReason: 'Where the snippet was pasted is not publicly visible.',
    rootCause: { issue: 'Confirmed', rootCause: 'Confirmed', fixLocation: 'Possible', explanation: `Strict JSON parse error: ${ev(c, 'Parse error') ?? ''}` },
    instructions: [{ title: 'Correct the snippet', platform: 'Developer', steps: ['Find the snippet (header/footer scripts plugin, theme options, page builder HTML widget)', `Fix the error: ${ev(c, 'Parse error') ?? 'see evidence'}`, 'Validate at validator.schema.org', ...(env.caches.length ? ['Clear the cache'] : [])] }],
    code: [],
    beforeAfter: [{ label: 'JSON-LD', before: (ev(c, 'Snippet') ?? '').slice(0, 300), after: '(same data, valid JSON — no trailing commas, quotes escaped)' }],
    difficulty: 'Easy',
    access: ['WordPress Admin'],
    time: '15–30 minutes',
    risk: 'Low',
    backup: false,
    staging: false,
  }),

  'duplicate-schema': (_c, env) => ({
    why: 'Both the SEO plugin and the theme (or a second plugin) output Organization/WebSite schema.',
    method: env.seo ? 'B' : 'C',
    methodReason: 'One schema source must be disabled.',
    alternatives: ['C', 'D'],
    fixConfidence: 'Medium',
    fixConfidenceReason: 'Which components output schema must be confirmed in view-source.',
    rootCause: { issue: 'Likely', rootCause: 'Likely', fixLocation: 'Possible', explanation: 'Entity types were counted across JSON-LD blocks.' },
    instructions: nonEmpty([seoPath(env, 'schema'), { title: 'Disable the other source', platform: 'Theme / plugin settings', steps: ['Theme options → turn off built-in schema', 'Or deactivate the second schema plugin'] }]),
    code: [],
    beforeAfter: [],
    difficulty: 'Easy',
    access: ['WordPress Admin'],
    time: '15–30 minutes',
    risk: 'Low',
    backup: false,
    staging: false,
  }),

  'missing-alt': (_c, env) => ({
    why: 'Images were inserted without alt text.',
    method: 'H',
    methodReason: 'Alt text is content, edited per image.',
    alternatives: ['A'],
    fixConfidence: 'High',
    fixConfidenceReason: 'The images are listed.',
    rootCause: { issue: 'Confirmed', rootCause: 'Confirmed', fixLocation: 'Likely', explanation: 'Counted in the homepage HTML.' },
    instructions: nonEmpty([env.wordpress && wpAdmin('Add alt text', ['Media', 'Library', 'Select each listed image', 'Alternative Text — describe the image (leave decorative images empty)', 'Then re-insert/update the image in the page (alt is copied at insert time)']), env.elementor && { title: 'Elementor images', platform: 'Elementor', steps: ['Edit the page', 'Select the Image widget', 'Set alt text via the media library or the widget', 'Update'], shownBecause: 'Elementor detected' }]),
    code: [],
    beforeAfter: [{ label: 'Image', before: '<img src="team.jpg">', after: '<img src="team.jpg" alt="Our team at the Leeds office">' }],
    difficulty: 'Easy',
    access: ['WordPress Admin'],
    time: '30–60 minutes',
    risk: 'Low',
    backup: false,
    staging: false,
  }),

  'no-lang': (_c, env) => ({
    why: 'The theme’s header template prints <html> without language_attributes().',
    method: 'D',
    methodReason: 'Fixed in the header template via a child theme.',
    alternatives: ['C'],
    fixConfidence: 'High',
    fixConfidenceReason: 'Deterministic template change.',
    rootCause: { issue: 'Confirmed', rootCause: 'Likely', fixLocation: 'Likely', explanation: 'Checked on the served <html> element.' },
    instructions: [{ title: 'Override header.php', platform: 'Child theme', steps: [childThemeLocation(env), 'Copy header.php from the parent theme to the child theme', 'Replace the <html> tag as shown', ...(env.wordpress ? ['Settings → General → Site Language must be set correctly'] : [])] }],
    code: env.wordpress ? [{ title: 'Language attribute', file: childFile(env, 'header.php'), location: childThemeLocation(env), language: 'php', code: '<html <?php language_attributes(); ?>>', whatItDoes: 'Prints lang="…" (and dir) from the site language setting.', whyItFixes: 'Screen readers and browsers know the page language.', sideEffects: 'The child header.php no longer receives parent-theme updates to that file.', revert: 'Delete header.php from the child theme.' }] : [],
    beforeAfter: [{ label: '<html> tag', before: '<html>', after: '<html lang="en-US">' }],
    difficulty: 'Moderate',
    access: ['Theme access'],
    time: '15–30 minutes',
    risk: 'Low',
    backup: true,
    staging: false,
  }),

  'no-og-image': (_c, env) => ({
    why: env.seo ? `No default social image is set in ${env.seo.name}.` : 'No plugin or theme outputs Open Graph image tags.',
    method: env.seo ? 'B' : 'D',
    methodReason: env.seo ? 'The SEO plugin outputs Open Graph tags.' : 'Without an SEO plugin, the tag is added from child theme code.',
    alternatives: ['D'],
    fixConfidence: env.seo ? 'High' : 'Medium',
    fixConfidenceReason: env.seo ? 'A single setting.' : 'Code must be adapted with the real image URL.',
    rootCause: { issue: 'Confirmed', rootCause: 'Likely', fixLocation: env.seo ? 'Likely' : 'Possible', explanation: 'No og:image or twitter:image tag in the HTML.' },
    instructions: nonEmpty([seoPath(env, 'ogimage')]),
    code:
      env.wordpress && !env.seo
        ? [{ title: 'Default og:image', file: childFile(env, 'functions.php'), location: childThemeLocation(env), language: 'php', code: `add_action( 'wp_head', function () {\n\t// 1200×630 image from the Media Library.\n\techo '<meta property="og:image" content="' . esc_url( 'https://your-site/wp-content/uploads/social.jpg' ) . '">' . "\\n";\n} );`, whatItDoes: 'Adds a sitewide default sharing image.', whyItFixes: 'Social platforms show a preview image.', sideEffects: 'If an SEO plugin is installed later, remove this to avoid duplicate tags.', revert: 'Delete the snippet.' }]
        : [],
    beforeAfter: [{ label: '<head>', before: '<!-- no og:image -->', after: '<meta property="og:image" content="https://…/social-1200x630.jpg">' }],
    difficulty: 'Easy',
    access: env.seo ? ['WordPress Admin'] : ['Theme access'],
    time: '15 minutes',
    risk: 'Low',
    backup: false,
    staging: false,
  }),

  'missing-h1': (_c, env) => ({
    why: 'The theme renders the page title as a styled <div>/<p> or hides it, and the content starts with H2s.',
    method: env.elementor ? 'H' : 'C',
    methodReason: 'The main heading is set in the page content/template.',
    alternatives: ['D', 'H'],
    fixConfidence: 'Medium',
    fixConfidenceReason: 'Whether the title is hidden by a theme option or template is not publicly visible.',
    rootCause: { issue: 'Confirmed', rootCause: 'Possible', fixLocation: 'Possible', explanation: 'No H1 in served or rendered HTML.' },
    instructions: nonEmpty([env.elementor && { title: 'Elementor', platform: 'Elementor', steps: ['Edit the page', 'Select the main Heading widget', 'HTML Tag = H1', 'Update'], shownBecause: 'Elementor detected' }, { title: 'Page editor / theme', platform: 'Page editor', steps: ['Make the main heading of each page a Heading block with level H1', 'Or re-enable "show page title" in the theme options'] }]),
    code: [],
    beforeAfter: [{ label: 'Heading', before: '<div class="page-title">Services</div>', after: '<h1 class="page-title">Services</h1>' }],
    difficulty: 'Easy',
    access: ['WordPress Admin'],
    time: '15–60 minutes',
    risk: 'Low',
    backup: false,
    staging: false,
  }),
};

function sitemapSpec(env: FixEnvironment, why: string): Spec {
  return {
    why,
    method: env.seo ? 'B' : env.wordpress ? 'A' : 'F',
    methodReason: env.seo ? `${env.seo.name} generates the sitemap.` : 'The sitemap generator’s settings decide what is listed.',
    alternatives: ['A'],
    fixConfidence: 'Medium',
    fixConfidenceReason: EXPLAIN_BACKEND,
    rootCause: { issue: 'Confirmed', rootCause: 'Likely', fixLocation: env.seo ? 'Likely' : 'Possible', explanation: 'Sitemap URLs were sampled and requested.' },
    instructions: nonEmpty([seoPath(env, 'sitemap'), ...cachePurge(env), { title: 'Resubmit', platform: 'Google Search Console', steps: ['Indexing', 'Sitemaps', 'Submit the sitemap URL again'] }]),
    code: [],
    beforeAfter: [],
    difficulty: 'Easy',
    access: ['WordPress Admin'],
    time: '15–45 minutes',
    risk: 'Low',
    backup: false,
    staging: false,
  };
}

function genericSpec(c: Candidate): Spec {
  return {
    why: 'See the recommended solution.',
    method: 'F',
    methodReason: 'General guidance.',
    fixConfidence: 'Low',
    fixConfidenceReason: EXPLAIN_BACKEND,
    rootCause: { issue: c.confidence === 'High' ? 'Confirmed' : 'Likely', rootCause: 'Unknown', fixLocation: 'Unknown', explanation: 'No specific fix mapping exists for this issue type.' },
    instructions: [{ title: 'Recommended steps', platform: 'General', steps: c.solution }],
    code: [],
    beforeAfter: [],
    difficulty: 'Moderate',
    access: ['Developer'],
    time: c.effort.total,
    risk: 'Medium',
    backup: true,
    staging: true,
  };
}

export function detectedSummary(env: FixEnvironment): string[] {
  return nonEmpty([
    env.wordpress && `WordPress${env.wpVersion ? ` ${env.wpVersion}` : ''}`,
    env.seo?.name,
    ...env.caches.map((x) => x.name),
    env.elementor?.name,
    env.woocommerce?.name,
    env.theme && `Theme: ${env.theme.name ?? env.theme.slug}${env.theme.isChild ? ` (child of ${env.theme.parent})` : ''}`,
    env.server && `Server: ${env.server}`,
    env.cdn?.name,
  ]);
}

export function buildFixGuide(r: InvestigationResult): FixGuide | null {
  const c = r.primary;
  if (!c) return null;
  const env = detectEnvironment(r);
  const builder = SPECS[c.id] ?? (c.id.startsWith('redirect-chain-') ? chainSpec : null);
  const spec = builder ? builder(c, env, r) : genericSpec(c);
  const confidenceText: Record<Level, string> = {
    High: 'High — observed directly on the live site and re-verified where applicable.',
    Medium: 'Medium — observed on the live site, but an intentional configuration or measurement variance cannot be fully ruled out.',
    Low: 'Low — indicative only.',
  };
  return {
    issueId: c.id,
    title: c.title,
    understand: { found: c.summary, why: spec.why, confidence: confidenceText[c.confidence] },
    method: { code: spec.method, label: FIX_METHODS[spec.method], reason: spec.methodReason, alternatives: (spec.alternatives ?? []).filter((a) => a !== spec.method).map((a) => ({ code: a, label: FIX_METHODS[a] })) },
    confidence: { issue: c.confidence, fix: spec.fixConfidence, reason: spec.fixConfidenceReason },
    rootCause: spec.rootCause,
    instructions: spec.instructions,
    code: spec.code,
    beforeAfter: spec.beforeAfter.filter((b) => b.before.trim() || b.after.trim()),
    difficulty: spec.difficulty,
    access: spec.access,
    time: spec.time,
    risk: spec.risk,
    backup: spec.backup,
    staging: spec.staging,
    verification: probeFor(c.id)?.checks ?? [],
    environment: env,
    detected: detectedSummary(env),
  };
}

const chainSpec: Builder = (c, env, r) => {
  const chain = ev(c, 'Redirect chain') ?? '';
  const hops = chain.split('\n→ ').map((l) => l.replace(/\s+\[\d+\]$/, '').trim());
  return {
    why: 'Several layers each add their own redirect (e.g. server adds HTTPS, then the CMS adds www, then a trailing slash) instead of one rule going straight to the final URL.',
    method: env.cdn ? 'G' : 'K',
    methodReason: env.cdn ? 'Cloudflare was detected; a single Redirect Rule at the edge can replace the chain.' : 'Redirect rules must be merged into one.',
    alternatives: ['F', 'A'],
    fixConfidence: 'Medium',
    fixConfidenceReason: EXPLAIN_BACKEND,
    rootCause: { issue: 'Confirmed', rootCause: 'Likely', fixLocation: 'Possible', explanation: 'Every hop was observed; which layer adds each hop is inferred.' },
    instructions: nonEmpty([
      ...cloudflare(env, 'Single redirect at Cloudflare', ['SSL/TLS → Edge Certificates → Always Use HTTPS = On', 'Rules → Redirect Rules → one rule sending the non-preferred host to the preferred host']),
      env.wordpress && wpAdmin('Match the WordPress URLs to the final URL', ['Settings', 'General', `WordPress Address and Site Address = ${origin(r.siteUrl)}`, 'Save Changes']),
    ]),
    code: env.cdn ? [] : redirectRules(r, env),
    beforeAfter: hops.length > 1 ? [{ label: 'Redirects', before: hops.join('\n↓\n'), after: `${hops[0]}\n↓\n${hops[hops.length - 1]}` }] : [],
    difficulty: 'Moderate',
    access: nonEmpty([env.cdn ? 'CDN' : 'Server', env.wordpress && 'WordPress Admin']),
    time: '30–60 minutes',
    risk: 'Medium',
    backup: true,
    staging: false,
  };
};

/** Plain-text version of the whole fix (for "Copy Fix"). */
export function fixAsText(g: FixGuide): string {
  const lines: string[] = [`FIX: ${g.title}`, `Recommended fix method: ${g.method.label}`, `Difficulty: ${g.difficulty} · Risk: ${g.risk} · Time: ${g.time}`, `Required access: ${g.access.join(' + ')}`, ''];
  if (g.backup) lines.push('Create a backup/staging copy before applying this change.', '');
  for (const s of g.instructions) {
    lines.push(`${s.title} (${s.platform}):`);
    s.steps.forEach((st, i) => lines.push(`  ${i + 1}. ${st}`));
    lines.push('');
  }
  for (const k of g.code) lines.push(`${k.title} — ${k.file}`, `Location: ${k.location}`, k.code, '');
  lines.push(`Verify: re-check ${g.verification.join(', ')}.`);
  return lines.join('\n');
}

