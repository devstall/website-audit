import { RequestBudgetExceeded, type SafeFetcher } from '../net/fetcher.js';
import type { FetchResult, PageFacts, WordPressInfo } from '../types.js';

const THEME_RE = /\/wp-content\/themes\/([a-z0-9._-]+)\//gi;
const PLUGIN_RE = /\/wp-content\/plugins\/([a-z0-9._-]+)\/[^"'\s)]*/gi;
const VER_RE = /[?&]ver=([0-9][0-9a-z.\-_]*)/i;

/** Plugins that announce themselves in HTML comments or generator tags. */
const COMMENT_SIGNATURES: { re: RegExp; slug: string }[] = [
  { re: /Yoast SEO(?: Premium)? plugin v?([\d.]+)/i, slug: 'wordpress-seo' },
  { re: /Rank Math(?: PRO)?(?: WordPress SEO plugin)?[^\n]*?v?([\d.]+)?/i, slug: 'seo-by-rank-math' },
  { re: /All in One SEO(?: Pack)?(?: Pro)? ([\d.]+)/i, slug: 'all-in-one-seo-pack' },
  { re: /Elementor ([\d.]+)/i, slug: 'elementor' },
  { re: /WP Rocket/i, slug: 'wp-rocket' },
  { re: /Performance optimized by W3 Total Cache/i, slug: 'w3-total-cache' },
  { re: /WP Super Cache/i, slug: 'wp-super-cache' },
  { re: /LiteSpeed Cache/i, slug: 'litespeed-cache' },
  { re: /WooCommerce ([\d.]+)/i, slug: 'woocommerce' },
  { re: /Site Kit by Google ([\d.]+)/i, slug: 'google-site-kit' },
];

function assetUrls(pages: PageFacts[]): string[] {
  const urls: string[] = [];
  for (const p of pages) {
    urls.push(...p.scripts.map((s) => s.src), ...p.stylesheets.map((s) => s.href), ...p.images.map((i) => i.src));
  }
  return urls;
}

export interface WordPressProbeOptions {
  fetcher: SafeFetcher;
  origin: string;
  pages: PageFacts[];
  homepage: FetchResult;
}

async function tryFetch(fetcher: SafeFetcher, url: string, maxBytes: number): Promise<FetchResult | null> {
  try {
    return await fetcher.fetch(url, { maxBytes });
  } catch (e) {
    if (e instanceof RequestBudgetExceeded) return null;
    throw e;
  }
}

export async function investigateWordPress({ fetcher, origin, pages, homepage }: WordPressProbeOptions): Promise<WordPressInfo> {
  const html = homepage.body;
  const assets = assetUrls(pages);
  const signals: string[] = [];
  const info: WordPressInfo = {
    detected: false,
    signals,
    version: null,
    versionSource: null,
    theme: null,
    plugins: [],
    restApi: { available: false, status: null, userEnumeration: { exposed: false, count: 0 } },
    xmlrpc: { status: null, enabled: false },
  };

  const wpContent = assets.filter((u) => /\/wp-content\//i.test(u));
  const wpIncludes = assets.filter((u) => /\/wp-includes\//i.test(u));
  if (wpContent.length || /\/wp-content\//i.test(html)) signals.push(`${wpContent.length || 'Inline'} asset reference(s) under /wp-content/`);
  if (wpIncludes.length || /\/wp-includes\//i.test(html)) signals.push(`${wpIncludes.length || 'Inline'} asset reference(s) under /wp-includes/`);
  const generator = pages[0]?.generator ?? null;
  const genMatch = generator ? /WordPress\s*([\d.]+)?/i.exec(generator) : null;
  if (genMatch) {
    signals.push(`<meta name="generator" content="${generator}">`);
    if (genMatch[1]) {
      info.version = genMatch[1];
      info.versionSource = 'generator meta tag';
    }
  }
  const linkHeader = homepage.headers['link'] ?? '';
  if (/rel="?https:\/\/api\.w\.org\/"?/i.test(linkHeader) || /rel=["']https:\/\/api\.w\.org\/["']/i.test(html)) {
    signals.push('REST API discovery link (rel="https://api.w.org/")');
  }

  const likelyWp = signals.length > 0;
  if (!likelyWp) return info;

  // REST API root: a JSON document listing namespaces confirms WordPress.
  const rest = await tryFetch(fetcher, `${origin}/wp-json/`, 256 * 1024);
  if (rest) {
    info.restApi.status = rest.status;
    if (rest.ok && /"namespaces"\s*:/.test(rest.body)) {
      info.restApi.available = true;
      signals.push(`REST API responds at ${origin}/wp-json/ (HTTP ${rest.status})`);
    }
  }
  if (info.restApi.available) {
    // Only the COUNT of exposed users is kept; usernames are never stored or displayed.
    const users = await tryFetch(fetcher, `${origin}/wp-json/wp/v2/users?per_page=5`, 64 * 1024);
    if (users?.ok) {
      try {
        const arr = JSON.parse(users.body);
        if (Array.isArray(arr) && arr.length && arr.every((u) => typeof u === 'object' && u && 'slug' in u)) {
          info.restApi.userEnumeration = { exposed: true, count: arr.length };
        }
      } catch {
        /* not JSON */
      }
    }
  }
  const xmlrpc = await tryFetch(fetcher, `${origin}/xmlrpc.php`, 4096);
  if (xmlrpc) {
    info.xmlrpc.status = xmlrpc.status;
    info.xmlrpc.enabled = /XML-RPC server accepts POST requests only/i.test(xmlrpc.body);
  }

  info.detected = signals.length >= 2 || info.restApi.available || !!genMatch;

  // Version from ?ver= on core assets (weaker than generator).
  if (!info.version) {
    const coreVer = wpIncludes.map((u) => VER_RE.exec(u)?.[1]).find((v) => v && /^\d+\.\d+(\.\d+)?$/.test(v));
    if (coreVer) {
      info.version = coreVer;
      info.versionSource = '?ver= parameter on /wp-includes/ assets (indicative only)';
    }
  }

  // Theme(s)
  const themeSlugs = new Map<string, string[]>();
  for (const u of [...assets, ...[...html.matchAll(THEME_RE)].map((m) => m[0])]) {
    for (const m of u.matchAll(THEME_RE)) {
      const slug = m[1]!.toLowerCase();
      const list = themeSlugs.get(slug) ?? [];
      list.push(u);
      themeSlugs.set(slug, list);
    }
  }
  if (themeSlugs.size) {
    // The active (child) theme usually owns the stylesheet enqueued last; fetch style.css headers to be sure.
    const slugs = [...themeSlugs.keys()];
    for (const slug of slugs.slice(0, 2)) {
      const css = await tryFetch(fetcher, `${origin}/wp-content/themes/${slug}/style.css`, 8 * 1024);
      if (!css?.ok || !/Theme Name\s*:/i.test(css.body)) continue;
      const header = (k: string) => new RegExp(`^[\\s*]*${k}\\s*:\\s*(.+)$`, 'im').exec(css.body)?.[1]?.trim() ?? null;
      const parent = header('Template');
      if (!info.theme || parent) {
        info.theme = { slug, name: header('Theme Name'), version: header('Version'), isChild: !!parent, parent };
      }
      if (parent) break;
    }
    if (!info.theme) {
      const slug = slugs[0]!;
      const ver = themeSlugs.get(slug)!.map((u) => VER_RE.exec(u)?.[1]).find(Boolean) ?? null;
      info.theme = { slug, name: null, version: ver, isChild: slugs.length > 1, parent: slugs.length > 1 ? slugs[1]! : null };
    }
  }

  // Plugins from asset paths.
  const plugins = new Map<string, { versions: Set<string>; evidence: string }>();
  const pluginSources = [...assets, ...[...html.matchAll(PLUGIN_RE)].map((m) => m[0])];
  for (const u of pluginSources) {
    for (const m of u.matchAll(PLUGIN_RE)) {
      const slug = m[1]!.toLowerCase();
      const entry = plugins.get(slug) ?? { versions: new Set<string>(), evidence: m[0].slice(0, 140) };
      const v = VER_RE.exec(m[0])?.[1];
      if (v) entry.versions.add(v);
      plugins.set(slug, entry);
    }
  }
  const allHtml = html;
  for (const sig of COMMENT_SIGNATURES) {
    const m = sig.re.exec(allHtml);
    if (!m) continue;
    const entry = plugins.get(sig.slug) ?? { versions: new Set<string>(), evidence: `HTML signature: "${m[0].slice(0, 80)}"` };
    if (m[1]) entry.versions.add(m[1]);
    plugins.set(sig.slug, entry);
  }
  info.plugins = [...plugins.entries()]
    .map(([slug, e]) => ({ slug, versions: [...e.versions].slice(0, 3), evidence: e.evidence }))
    .sort((a, b) => a.slug.localeCompare(b.slug));
  return info;
}
