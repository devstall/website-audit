import { normalizeUrl } from '../crawl/url.js';
import type { Candidate } from '../types.js';
import type { InvestigationContext } from './context.js';

export type Detector = (ctx: InvestigationContext) => Candidate[];

export const EFFORT = {
  quick: { investigation: '15 minutes', implementation: '15–30 minutes', testing: '15 minutes', total: '45 minutes – 1 hour' },
  small: { investigation: '15–30 minutes', implementation: '30–60 minutes', testing: '15–30 minutes', total: '1–2 hours' },
  medium: { investigation: '30–60 minutes', implementation: '1–3 hours', testing: '30–60 minutes', total: '2–5 hours' },
  large: { investigation: '1–2 hours', implementation: '4–8 hours', testing: '1–2 hours', total: '1–1.5 days' },
} as const;

export function chainText(chain: { url: string; status: number }[]): string {
  return chain.map((h) => `${h.url}  [${h.status}]`).join('\n→ ');
}

export function headerDump(headers: Record<string, string>, keys: string[]): string {
  return keys.map((k) => `${k}: ${headers[k] ?? '(not present)'}`).join('\n');
}

export const kb = (b: number) => (b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(2)} MB` : `${Math.round(b / 1024)} KB`);
export const plural = (n: number, s: string, p = `${s}s`) => `${n} ${n === 1 ? s : p}`;
export const okPages = (ctx: InvestigationContext) => ctx.crawl.pages.filter((p) => p.status >= 200 && p.status < 300);
export const isHome = (ctx: InvestigationContext, url: string) => normalizeUrl(url) === normalizeUrl(ctx.siteUrl);
export const navUrls = (ctx: InvestigationContext) =>
  new Set((ctx.home?.internalLinks ?? []).filter((l) => l.inNav).map((l) => normalizeUrl(l.url)!));
export const INTENTIONAL_NOINDEX =
  /(thank|thanks|confirm|privacy|terms|legal|cookie|login|account|cart|checkout|search|tag|author|attachment|feed|404|sample-page|landing|lp\/|draft|test|staging)/i;
export const isStagingHost = (url: string) => /^(staging|stage|dev|test|qa|uat|preview|beta)[.-]/i.test(new URL(url).hostname);

/** Candidate factory with neutral defaults for the ranking inputs. */
export function candidate(partial: Omit<Candidate, 'verification' | 'evidenceStrength' | 'scope' | 'actionability'> & Partial<Candidate>): Candidate {
  return { evidenceStrength: 1, scope: 0.5, actionability: 0.9, verification: [], ...partial };
}

export function linkSourcesEvidence(ctx: InvestigationContext, targetKey: string, max = 3): string {
  return (ctx.crawl.linkSources.get(targetKey) ?? [])
    .slice(0, max)
    .map((s) => `${s.source}  (anchor text: "${s.text || '—'}")`)
    .join('\n');
}
