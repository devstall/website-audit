import type { InvestigationResult } from '../types.js';

export interface DetectedTool {
  slug: string;
  name: string;
  /** How it was detected (public evidence). */
  evidence: string;
}

/** What the public website reveals about where a fix can be applied. Nothing here is assumed. */
export interface FixEnvironment {
  wordpress: boolean;
  wpVersion: string | null;
  seo: DetectedTool | null;
  caches: DetectedTool[];
  elementor: DetectedTool | null;
  woocommerce: DetectedTool | null;
  theme: { slug: string; name: string | null; isChild: boolean; parent: string | null } | null;
  /** Origin web server from the Server header (null when hidden or behind a CDN). */
  server: 'apache' | 'nginx' | 'litespeed' | 'iis' | null;
  cdn: DetectedTool | null;
}

const SEO: Record<string, string> = {
  'wordpress-seo': 'Yoast SEO',
  'wordpress-seo-premium': 'Yoast SEO',
  'seo-by-rank-math': 'Rank Math',
  'seo-by-rank-math-pro': 'Rank Math',
  'all-in-one-seo-pack': 'All in One SEO',
  'all-in-one-seo-pack-pro': 'All in One SEO',
};
const CACHE: Record<string, string> = {
  'litespeed-cache': 'LiteSpeed Cache',
  'wp-rocket': 'WP Rocket',
  'w3-total-cache': 'W3 Total Cache',
  'wp-super-cache': 'WP Super Cache',
  'wp-fastest-cache': 'WP Fastest Cache',
};

export function detectEnvironment(r: InvestigationResult): FixEnvironment {
  const wp = r.wordpress;
  const h = r.homepageHeaders;
  const plugin = (slugs: Record<string, string>) =>
    wp.plugins
      .filter((p) => slugs[p.slug])
      .map((p) => ({ slug: p.slug.replace(/-(pro|premium)$/, ''), name: slugs[p.slug]!, evidence: p.evidence }));
  const seo = wp.detected ? (plugin(SEO)[0] ?? null) : null;
  const caches = wp.detected ? plugin(CACHE) : [];
  const find = (slug: string, name: string) => {
    const p = wp.plugins.find((x) => x.slug === slug);
    return wp.detected && p ? { slug, name, evidence: p.evidence } : null;
  };
  const serverHeader = (h['server'] ?? '').toLowerCase();
  const cdn = serverHeader === 'cloudflare' || h['cf-ray'] ? { slug: 'cloudflare', name: 'Cloudflare', evidence: h['cf-ray'] ? `cf-ray: ${h['cf-ray']}` : 'Server: cloudflare' } : null;
  const server = cdn
    ? null
    : /litespeed/.test(serverHeader)
      ? 'litespeed'
      : /apache/.test(serverHeader)
        ? 'apache'
        : /nginx|openresty/.test(serverHeader)
          ? 'nginx'
          : /microsoft-iis/.test(serverHeader)
            ? 'iis'
            : null;
  return {
    wordpress: wp.detected,
    wpVersion: wp.version,
    seo,
    caches,
    elementor: find('elementor', 'Elementor'),
    woocommerce: find('woocommerce', 'WooCommerce'),
    theme: wp.detected && wp.theme ? { slug: wp.theme.slug, name: wp.theme.name, isChild: wp.theme.isChild, parent: wp.theme.parent } : null,
    server,
    cdn,
  };
}
