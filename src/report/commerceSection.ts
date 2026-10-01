/**
 * Client-report sections for e-commerce audits: conversion scorecard, before → after concept,
 * revenue opportunities (WHAT to improve + example concept, never HOW) and the responsive check.
 */
import { conceptData, miniConcept, productPageConcept, CONCEPT_CSS } from '../ecommerce/concepts.js';
import type { Candidate, InvestigationResult, Level } from '../types.js';
import { esc } from './esc.js';

const ORDER: Record<Level, number> = { High: 0, Medium: 1, Low: 2 };
const IMPACT: Record<Level, string> = { High: 'High revenue impact', Medium: 'Medium revenue impact', Low: 'Quick win' };
const PRODUCT_KEYS = ['atc-above-fold', 'price-above-fold', 'sticky-atc', 'reviews', 'product-images', 'express-pay', 'shipping-info', 'returns', 'free-shipping'];

export const isCommerceFinding = (c: Candidate) => c.category === 'Conversion' || c.category === 'Responsive design';

function ring(score: number): string {
  const r = 46;
  const c = 2 * Math.PI * r;
  const tone = score >= 75 ? 'var(--good)' : score >= 50 ? 'var(--ni)' : 'var(--poor)';
  return `<svg viewBox="0 0 110 110" width="120" height="120" role="img" aria-label="Conversion readiness ${score} of 100"><circle cx="55" cy="55" r="${r}" fill="none" stroke="#e2e8f0" stroke-width="10"/><circle cx="55" cy="55" r="${r}" fill="none" stroke="${tone}" stroke-width="10" stroke-linecap="round" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${(c * (1 - score / 100)).toFixed(1)}" transform="rotate(-90 55 55)"/><text x="55" y="58" text-anchor="middle" class="cr-num">${score}</text><text x="55" y="76" text-anchor="middle" class="cr-sub">/ 100</text></svg>`;
}

export function renderCommerceSections(r: InvestigationResult, imageSrc: (f: string) => string | null, host: string, verified: Candidate[]): string {
  const c = r.commerce;
  if (!c) return '';
  const d = conceptData(c, host);
  const areas = [...new Set(c.checks.map((x) => x.area))];
  const passed = c.checks.filter((x) => x.pass === true).length;
  const failed = c.checks.filter((x) => x.pass === false).length;
  const opportunities = verified.filter(isCommerceFinding).sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);

  const scorecard = `<section class="section"><div class="sec-kicker">Sales &amp; conversion</div><h2 class="sec-title">How well does the store turn visitors into buyers?</h2>
  <div class="cr-head">${ring(c.score)}<div><strong>Conversion readiness: ${c.score}/100</strong>
    <p>${c.isStore ? `${esc(c.platform ?? 'Online store')} · ${c.productPages.length} product page${c.productPages.length === 1 ? '' : 's'} analysed · ${passed} best practices in place, <b>${failed} missing</b>.` : 'No online store was detected; only mobile and speed checks apply.'}</p>
    <p class="note">Score = weighted share of ${c.checks.filter((x) => x.pass !== null).length} proven e-commerce best practices found on the live store (high-impact items count 3×).</p></div></div>
  <div class="cr-areas">${areas
    .map(
      (a) => `<div class="cr-area"><h3>${esc(a)}</h3><ul>${c.checks
        .filter((x) => x.area === a)
        .map((x) => `<li class="${x.pass === true ? 'ok' : x.pass === false ? 'bad' : 'na'}"><span class="s-icon">${x.pass === true ? '✓' : x.pass === false ? '✕' : '–'}</span><span>${esc(x.label)}${x.pass === false && x.impact === 'High' ? ' <em>high impact</em>' : ''}</span></li>`)
        .join('')}</ul></div>`,
    )
    .join('')}</div></section>`;

  // Before → after: their annotated mobile product page next to the concept.
  const improvements = PRODUCT_KEYS.filter((k) => c.checks.some((x) => x.key === k && x.pass === false)).map((k) => ({ key: k, label: c.checks.find((x) => x.key === k)!.label }));
  const before = c.productProbe?.annotatedScreenshot ? imageSrc(c.productProbe.annotatedScreenshot) : null;
  const beforeAfter = c.isStore && c.productPages.length
    ? `<section class="section pb"><div class="sec-kicker">Visual recommendation</div><h2 class="sec-title">Your mobile product page — today and an improved concept</h2>
  <p class="lead">Left: your live product page on a phone, with the fold marked. Right: an example concept using your own product, showing ${improvements.length ? 'the numbered improvements' : 'best-practice layout'}.</p>
  <div class="ba">
    <figure class="ba-before">${before ? `<img src="${esc(before)}" alt="Current mobile product page">` : '<div class="ba-na">Screenshot unavailable</div>'}<figcaption>Today — ${esc(c.productPages[0] ?? '')}</figcaption></figure>
    <div class="ba-arrow">→</div>
    <figure class="ba-after">${productPageConcept(d, improvements)}<figcaption>Example concept</figcaption></figure>
    ${improvements.length ? `<ol class="ba-list">${improvements.map((x) => `<li>${esc(x.label)}</li>`).join('')}</ol>` : ''}
  </div></section>`
    : '';

  const opp = opportunities.length
    ? `<section class="section"><div class="sec-kicker">Revenue opportunities</div><h2 class="sec-title">What will increase sales — in priority order</h2>
  ${opportunities
    .map(
      (o, i) => `<article class="opp sev-${o.severity.toLowerCase()}${miniConcept(o.concept, d) ? '' : ' no-concept'}"><div class="opp-main"><div class="opp-top"><span class="f-num">${i + 1}</span><div><h3>${esc(o.title)}</h3><span class="pill sev-${o.severity.toLowerCase()}">${IMPACT[o.severity]}</span> <span class="pill soft">${esc(o.category === 'Responsive design' ? 'Mobile & responsive' : 'Conversion')}</span></div></div>
      <h4>What we saw</h4><p>${esc(o.summary)}</p>
      <h4>Why it affects sales</h4><p>${esc(o.whyItMatters)}</p>
      ${o.recommendation ? `<div class="opp-rec"><h4>Our recommendation</h4><p>${esc(o.recommendation)}</p></div>` : ''}
      </div>${miniConcept(o.concept, d)}</article>`,
    )
    .join('')}
  <p class="note">Research references: Baymard Institute (cart-abandonment reasons), Deloitte “Milliseconds Make Millions” (mobile speed and retail conversion). Actual uplift depends on the store, traffic and products.</p></section>`
    : '';

  const cols = ['Small phone', 'Phone', 'Tablet', 'Laptop', 'Large desktop'];
  const responsive = c.responsive.length
    ? `<section class="section"><div class="sec-kicker">Responsive check</div><h2 class="sec-title">Does the store work on every screen?</h2>
  <div class="rt-wrap"><table class="rt"><thead><tr><th>Page</th>${cols.map((col) => `<th>${col}</th>`).join('')}</tr></thead><tbody>${c.responsive
    .map(
      (row) => `<tr><th>${esc(row.label)}</th>${cols
        .map((col) => {
          const x = row.checks.find((k) => k.device === col);
          if (!x) return '<td class="na">–</td>';
          const problems = [x.overflow ? 'scrolls sideways' : '', x.smallTextPct >= 15 ? `${x.smallTextPct}% tiny text` : '', x.width < 800 && x.smallTapTargets > 3 ? `${x.smallTapTargets} small tap targets` : ''].filter(Boolean);
          return `<td class="${problems.length ? 'bad' : 'ok'}"><b>${problems.length ? '✕' : '✓'}</b> ${x.width}px${problems.length ? `<span>${esc(problems.join(', '))}</span>` : ''}</td>`;
        })
        .join('')}</tr>`,
    )
    .join('')}</tbody></table></div>
  <div class="rt-shots">${(c.responsive[0]?.checks ?? [])
    .filter((x) => x.screenshot)
    .map((x) => {
      const src = imageSrc(x.screenshot!);
      return src ? `<figure class="${x.width >= 1000 ? 'wide' : 'narrow'}"><img src="${esc(src)}" alt="Homepage on ${esc(x.device)}"><figcaption>${esc(x.device)} · ${x.width}px</figcaption></figure>` : '';
    })
    .join('')}</div></section>`
    : '';

  return `${scorecard}${beforeAfter}${opp}${responsive}`;
}

export const COMMERCE_CSS = `${CONCEPT_CSS}
.cr-head{display:flex;gap:22px;align-items:center;margin-bottom:16px}
.cr-head strong{font-size:18px;color:var(--ink)}.cr-head p{margin:6px 0 0}
.cr-num{font:800 28px system-ui;fill:var(--ink)}.cr-sub{font:12px system-ui;fill:var(--muted)}
.cr-areas{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
.cr-area{border:1px solid var(--line);border-radius:14px;padding:14px;break-inside:avoid}
.cr-area h3{font-size:14px;margin-bottom:8px}
.cr-area ul{list-style:none;margin:0;padding:0;display:grid;gap:6px}
.cr-area li{display:flex;gap:8px;font-size:12.5px;align-items:flex-start}
.cr-area li em{font-style:normal;color:var(--poor);font-weight:700;font-size:11px}
.cr-area li.na{color:var(--muted)}
.cr-area .s-icon,.opp .s-icon{flex:none;width:18px;height:18px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:10px;font-weight:800;color:#fff}
.cr-area .ok .s-icon{background:var(--good)}.cr-area .bad .s-icon{background:var(--poor)}.cr-area .na .s-icon{background:#cbd5e1}
.ba{display:grid;grid-template-columns:minmax(0,300px) 40px 320px minmax(0,1fr);gap:14px;align-items:start}
.ba figure{margin:0}.ba figcaption{font-size:12px;color:var(--muted);margin-top:8px;text-align:center;overflow-wrap:anywhere}
.ba-before img{width:100%;border-radius:22px;border:10px solid #0f172a;display:block}
.ba-na{height:300px;border:1px dashed var(--line);border-radius:18px;display:flex;align-items:center;justify-content:center;color:var(--muted)}
.ba-arrow{font-size:34px;color:var(--accent);font-weight:800;align-self:center;text-align:center}
.ba-list{margin:0;padding-left:22px;display:grid;gap:8px;font-size:13.5px;color:var(--ink);counter-reset:none}
.ba-list li::marker{color:#dc2626;font-weight:800}
.opp{display:grid;grid-template-columns:minmax(0,1fr) 260px;gap:18px;border:1px solid var(--line);border-radius:16px;padding:18px 20px;margin:14px 0;break-inside:avoid;background:#fff}
.opp.no-concept{grid-template-columns:1fr}
.opp-top{display:flex;gap:12px;align-items:flex-start;margin-bottom:6px}.opp-top h3{font-size:16px;margin-bottom:6px}
.opp h4{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin:12px 0 4px}.opp p{margin:0}
.opp-rec{background:color-mix(in srgb,var(--accent) 8%,#fff);border-radius:12px;padding:10px 12px;margin-top:12px}.opp-rec h4{margin-top:0;color:var(--accent)}
.rt-wrap{overflow-x:auto}
.rt{width:100%;border-collapse:collapse;font-size:13px}
.rt th,.rt td{border:1px solid var(--line);padding:9px 10px;text-align:left;vertical-align:top}
.rt thead th{background:var(--soft);font-size:12px}
.rt td.ok b{color:var(--good)}.rt td.bad{background:var(--high-bg)}.rt td.bad b{color:var(--poor)}.rt td span{display:block;font-size:11.5px;color:var(--poor)}.rt td.na{color:var(--muted)}
.rt-shots{display:flex;gap:10px;align-items:flex-start;margin-top:14px;overflow:hidden}
.rt-shots figure{margin:0;border:1px solid var(--line);border-radius:10px;overflow:hidden;background:var(--soft)}
.rt-shots figure.narrow{width:120px;flex:none}.rt-shots figure.wide{flex:1;min-width:0}
.rt-shots img{display:block;width:100%;height:auto}.rt-shots figcaption{font-size:11px;color:var(--muted);padding:4px 6px}
@media (max-width:720px){.cr-areas{grid-template-columns:1fr}.ba{grid-template-columns:1fr}.ba-arrow{transform:rotate(90deg)}.opp{grid-template-columns:1fr}.cr-head{flex-direction:column;align-items:flex-start}.rt-shots{flex-wrap:wrap}}
`;
