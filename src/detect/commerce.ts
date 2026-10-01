import { CHECKS } from '../ecommerce/checks.js';
import type { Candidate, Level } from '../types.js';
import { candidate, EFFORT, type Detector } from './helpers.js';

/** Checks whose absence is inferred from HTML heuristics (a custom widget could be missed) → Medium confidence. */
const HEURISTIC = new Set(['reviews', 'shipping-info', 'cross-sell', 'express-pay', 'returns', 'free-shipping', 'payment-icons', 'contact', 'policies', 'search', 'cart-link', 'email-capture', 'description', 'product-images']);
/** Measured in a real browser. */
const MEASURED = new Set(['atc-above-fold', 'price-above-fold', 'sticky-atc', 'popup', 'no-overflow', 'readable-text', 'tap-targets']);
/** Already reported by other detectors. */
const SKIP = new Set(['mobile-speed']);

const EFFORT_BY_IMPACT: Record<Level, Candidate['effort']> = { High: EFFORT.medium, Medium: EFFORT.small, Low: EFFORT.quick };

/** One finding per failed conversion / responsive best practice (e-commerce audits only). */
export const commerce: Detector = (ctx) => {
  const report = ctx.commerce;
  if (!report) return [];
  const out: Candidate[] = [];
  const probe = report.productProbe;
  for (const check of report.checks) {
    if (check.pass !== false || SKIP.has(check.key)) continue;
    const def = CHECKS.find((c) => c.key === check.key);
    if (!def) continue;
    const measured = MEASURED.has(check.key);
    let confidence: Level = HEURISTIC.has(check.key) ? 'Medium' : 'High';
    if (check.key === 'atc-above-fold' && probe && !probe.atcFound) confidence = 'Low'; // button may exist under a custom label
    const pages = check.area === 'Mobile & responsive' ? report.responsive.map((r) => r.url) : report.productPages.length ? report.productPages : [ctx.siteUrl];

    const screenshots: { caption: string; file: string }[] = [];
    if (['atc-above-fold', 'price-above-fold', 'sticky-atc', 'popup'].includes(check.key) && probe?.annotatedScreenshot) {
      screenshots.push({ caption: 'Mobile product page (390px) — red dashed line = what shoppers see without scrolling', file: probe.annotatedScreenshot });
    }
    if (['no-overflow', 'readable-text', 'tap-targets'].includes(check.key)) {
      const bad = report.responsive.flatMap((r) => r.checks.map((c) => ({ r, c }))).find(({ c }) => (check.key === 'no-overflow' ? c.overflow : check.key === 'readable-text' ? c.smallTextPct >= 15 : c.smallTapTargets > 3) && c.screenshot);
      if (bad?.c.screenshot) screenshots.push({ caption: `${bad.r.label} on ${bad.c.device} (${bad.c.width}px)`, file: bad.c.screenshot });
    }
    const extra = check.key === 'tap-targets' || check.key === 'no-overflow' ? report.responsive.flatMap((r) => r.checks.flatMap((c) => (check.key === 'no-overflow' ? c.overflowing : c.smallTapExamples).slice(0, 2).map((x) => `${r.label} @ ${c.device}: ${x}`))).slice(0, 6) : [];

    out.push(
      candidate({
        id: `cro-${check.key}`,
        title: def.failTitle,
        category: check.area === 'Mobile & responsive' ? 'Responsive design' : 'Conversion',
        severity: check.key === 'atc-above-fold' && probe?.stickyAtc ? 'Medium' : check.impact,
        confidence,
        evidenceStrength: measured ? 0.9 : 0.7,
        scope: 0.8,
        actionability: 0.9,
        summary: check.detail,
        howIdentified: measured
          ? 'Measured in a real Chrome browser on the live store (read-only — nothing was clicked or added to a cart).'
          : 'Detected from the served HTML of the homepage, category and product pages (text, structured data and page elements).',
        evidence: [
          { label: 'Best practice', value: def.label },
          { label: 'What we observed', value: check.detail },
          ...(report.productPages[0] && check.area !== 'Mobile & responsive' ? [{ label: 'Product page analysed', value: report.productPages[0] }] : []),
          ...(extra.length ? [{ label: 'Examples', value: extra.join('\n'), code: true }] : []),
        ],
        affectedUrls: pages,
        whyItMatters: def.why,
        recommendation: def.recommendation,
        ...(def.concept ? { concept: def.concept } : {}),
        solution: def.how(report.platform),
        effort: EFFORT_BY_IMPACT[check.impact],
        verification: [
          measured ? 'Measured on the live page at the stated screen size.' : 'Based on page content; a feature loaded only after interaction may not be visible to this check.',
          ...(report.platform ? [`Store platform detected from public signals: ${report.platform}.`] : []),
        ],
        ...(screenshots.length ? { screenshots } : {}),
      }),
    );
  }
  return out;
};
