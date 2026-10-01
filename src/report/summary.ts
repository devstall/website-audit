import type { Candidate, InvestigationResult, Level } from '../types.js';
import { securityRows, securityVerdict } from './securityRows.js';

export type AreaStatus = 'pass' | 'warn' | 'critical';

export interface AreaDef {
  key: string;
  label: string;
  /** What the area covers, shown to clients. */
  covers: string;
  categories: Candidate['category'][];
}

/** How findings roll up into client-facing areas. */
export const AREAS: AreaDef[] = [
  { key: 'visibility', label: 'Search visibility', covers: 'Indexing, robots.txt, sitemap, canonical URLs, redirects', categories: ['Indexing', 'Crawlability', 'Sitemap', 'Canonicalization', 'Redirects'] },
  { key: 'speed', label: 'Speed & Core Web Vitals', covers: 'Loading speed, layout stability, server response, images', categories: ['Performance', 'Core Web Vitals', 'Images'] },
  { key: 'mobile', label: 'Mobile experience', covers: 'Viewport, layout on phones, horizontal scrolling', categories: ['Mobile usability'] },
  { key: 'security', label: 'Security & HTTPS', covers: 'Malware, blacklists, SSL, security headers, email spoofing, outdated software', categories: ['Security', 'HTTPS', 'Server configuration', 'WordPress', 'Malware'] },
  { key: 'function', label: 'Site functionality', covers: 'Broken links, failing scripts and styles, JavaScript errors', categories: ['Broken functionality', 'Internal links'] },
  { key: 'content', label: 'On-page SEO & accessibility', covers: 'Titles, headings, structured data, alt text, social previews', categories: ['On-page SEO', 'Structured data', 'Accessibility'] },
];

/** Bump when the summary / score formula changes: stored summaries with an older version are recomputed. */
export const SUMMARY_VERSION = 2;

export interface ReportSummary {
  v?: number;
  siteUrl: string;
  host: string;
  primaryTitle: string | null;
  counts: { High: number; Medium: number; Low: number; unverified: number; verified: number };
  score: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  wordpress: boolean;
  pages: number;
  /** Verified malware / blacklist findings. */
  malware?: number;
  security?: 'clean' | 'warn' | 'threat';
  /** Verified issues (id, title, severity, category) for dashboard statistics. */
  issues: { id: string; title: string; severity: Level; category: string }[];
}

const PENALTY: Record<Level, number> = { High: 18, Medium: 8, Low: 3 };

export const verifiedFindings = (r: InvestigationResult): Candidate[] => {
  const all = [...(r.candidates ?? [])];
  // The primary issue is always part of the findings, even in results saved before all findings were kept.
  if (r.primary && !all.some((c) => c.id === r.primary!.id)) all.unshift(r.primary);
  return all.filter((c) => c.confidence !== 'Low');
};

/**
 * 0–100 health score from VERIFIED findings only (unverified signals never lower it).
 * Transparent: 100 − 18 per high, 8 per medium, 3 per low severity finding.
 */
export function healthScore(r: InvestigationResult): number {
  let s = 100;
  // Conversion / responsive-design findings have their own conversion-readiness score; they do not lower technical health.
  for (const c of verifiedFindings(r)) if (c.category !== 'Conversion' && c.category !== 'Responsive design') s -= PENALTY[c.severity];
  if (r.primary?.id === 'homepage-error') s = Math.min(s, 20);
  return Math.max(0, Math.min(100, Math.round(s)));
}

export function grade(score: number): ReportSummary['grade'] {
  return score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : score >= 40 ? 'D' : 'F';
}

export function gradeLabel(score: number): string {
  return score >= 90 ? 'Excellent' : score >= 75 ? 'Good' : score >= 60 ? 'Needs attention' : score >= 40 ? 'Poor' : 'Critical';
}

export function areaResults(r: InvestigationResult): (AreaDef & { status: AreaStatus; findings: Candidate[] })[] {
  const verified = verifiedFindings(r);
  return AREAS.map((a) => {
    const findings = verified.filter((c) => a.categories.includes(c.category));
    const status: AreaStatus = findings.some((c) => c.severity === 'High') ? 'critical' : findings.length ? 'warn' : 'pass';
    return { ...a, status, findings };
  });
}

export function summarize(r: InvestigationResult): ReportSummary {
  const verified = verifiedFindings(r);
  const count = (l: Level) => verified.filter((c) => c.severity === l).length;
  let host = r.siteUrl;
  try {
    host = new URL(r.siteUrl).hostname;
  } catch {
    /* keep raw */
  }
  const score = healthScore(r);
  return {
    v: SUMMARY_VERSION,
    siteUrl: r.siteUrl,
    host,
    primaryTitle: r.primary?.title ?? null,
    counts: { High: count('High'), Medium: count('Medium'), Low: count('Low'), unverified: (r.candidates ?? []).filter((c) => c.confidence === 'Low').length, verified: verified.length },
    score,
    grade: grade(score),
    wordpress: r.wordpress.detected,
    pages: r.stats.pagesAnalyzed,
    malware: verified.filter((c) => c.category === 'Malware').length,
    security: securityVerdict(securityRows(r)).status,
    issues: verified.map((c) => ({ id: c.id, title: c.title, severity: c.severity, category: c.category })),
  };
}

/** Google's published Core Web Vitals thresholds (good / poor boundaries). */
export const VITAL_THRESHOLDS = {
  lcp: { good: 2500, poor: 4000, unit: 'ms', label: 'Largest Contentful Paint' },
  fcp: { good: 1800, poor: 3000, unit: 'ms', label: 'First Contentful Paint' },
  ttfb: { good: 800, poor: 1800, unit: 'ms', label: 'Server response (TTFB)' },
  cls: { good: 0.1, poor: 0.25, unit: '', label: 'Cumulative Layout Shift' },
} as const;

export function rateVital(key: keyof typeof VITAL_THRESHOLDS, v: number | null | undefined): 'good' | 'ni' | 'poor' | 'na' {
  if (v == null) return 'na';
  const t = VITAL_THRESHOLDS[key];
  return v <= t.good ? 'good' : v <= t.poor ? 'ni' : 'poor';
}
