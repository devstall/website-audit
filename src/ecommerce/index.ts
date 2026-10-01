import { analyzeHtml } from '../analyze/html.js';
import { isHtmlResponse } from '../crawl/crawler.js';
import { crawlFilter, isSameSite, normalizeUrl } from '../crawl/url.js';
import { RequestBudgetExceeded, type SafeFetcher } from '../net/fetcher.js';
import type { BrowserReport, CommerceFacts, CommerceReport, PageFacts, ProductProbe, ResponsiveResult } from '../types.js';
import { conversionScore, evaluateChecks } from './checks.js';
import { PRODUCT_URL_RE } from './extract.js';

export interface StoreDiscovery {
  isStore: boolean;
  platform: string | null;
  platformEvidence: string[];
  products: { url: string; facts: CommerceFacts }[];
  categories: string[];
  conceptImage: string | null;
  notes: string[];
}

const IMAGE_TYPES = /^image\/(jpeg|png|webp|gif|avif)\b/i;

/** Finds product/category pages (crawled first, then a few extra product URLs) and the store platform. */
export async function discoverStore(fetcher: SafeFetcher, pages: PageFacts[], sitemapUrls: string[], siteUrl: string): Promise<StoreDiscovery> {
  const notes: string[] = [];
  const products = pages.filter((p) => p.status === 200 && p.commerce?.isProduct).map((p) => ({ url: p.finalUrl, facts: p.commerce! }));
  const categories = pages.filter((p) => p.status === 200 && p.commerce?.isCategory).map((p) => p.finalUrl);

  if (products.length < 3) {
    const known = new Set(pages.map((p) => normalizeUrl(p.finalUrl)));
    const candidates = [...new Set([...pages.flatMap((p) => p.commerce?.productLinks ?? []), ...sitemapUrls.filter((u) => PRODUCT_URL_RE.test(u))])]
      .filter((u) => isSameSite(u, siteUrl) && !known.has(normalizeUrl(u)) && crawlFilter(u).allowed)
      .slice(0, 8);
    for (const u of candidates) {
      if (products.length >= 3 || fetcher.remaining() < 6) break;
      try {
        const r = await fetcher.fetch(u, { maxBytes: 3 * 1024 * 1024 });
        if (!r.ok || !isHtmlResponse(r)) continue;
        const facts = analyzeHtml(r, 2).commerce;
        if (facts?.isProduct) products.push({ url: r.finalUrl, facts });
      } catch (e) {
        if (e instanceof RequestBudgetExceeded) break;
      }
    }
  }

  const votes = new Map<string, number>();
  for (const p of pages) for (const h of p.commerce?.platformHints ?? []) votes.set(h, (votes.get(h) ?? 0) + 1);
  const platform = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const platformEvidence = platform ? [`${platform} markers found on ${votes.get(platform)} page(s)`] : [];
  const isStore = products.length > 0 || pages.some((p) => p.commerce?.addToCart.present) || !!platform;
  if (!isStore) notes.push('No online-store signals (products, add-to-cart, store platform) were found; store-specific checks were skipped.');
  else if (!products.length) notes.push('The site looks like a store, but no product page could be identified from public links.');

  // Product image for the design concept, embedded so the report stays self-contained.
  let conceptImage: string | null = null;
  const img = products.find((p) => p.facts.product?.image)?.facts.product?.image;
  if (img && fetcher.remaining() > 2) {
    try {
      const r = await fetcher.fetch(img, { maxBytes: 450 * 1024, binary: true });
      const type = r.headers['content-type'] ?? '';
      if (r.ok && IMAGE_TYPES.test(type) && r.bodyBase64 && !r.truncated) conceptImage = `data:${type.split(';')[0]!.trim().toLowerCase()};base64,${r.bodyBase64}`;
    } catch {
      /* concept falls back to a placeholder */
    }
  }
  return { isStore, platform, platformEvidence, products: products.slice(0, 3), categories: categories.slice(0, 5), conceptImage, notes };
}

export function buildCommerceReport(d: StoreDiscovery, home: PageFacts | null, probe: ProductProbe | null, responsive: ResponsiveResult[], browser: BrowserReport): CommerceReport {
  const checks = d.isStore
    ? evaluateChecks({ platform: d.platform, home: home?.commerce ?? null, products: d.products, probe, responsive, browser })
    : evaluateChecks({ platform: null, home: null, products: [], probe: null, responsive, browser }).filter((c) => c.area === 'Mobile & responsive' || c.area === 'Speed');
  const sample = d.products[0]?.facts.product;
  return {
    isStore: d.isStore,
    platform: d.platform,
    platformEvidence: d.platformEvidence,
    productPages: d.products.map((p) => p.url),
    categoryPages: d.categories,
    sample: { name: sample?.name ?? null, price: sample?.price ?? null, currency: sample?.currency ?? null, rating: sample?.rating ?? null, reviewCount: sample?.reviewCount ?? null, url: d.products[0]?.url ?? null },
    conceptImage: d.conceptImage,
    responsive,
    productProbe: probe,
    checks,
    score: conversionScore(checks),
    notes: d.notes,
  };
}
