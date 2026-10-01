/**
 * Client-facing report: what is wrong, the evidence and the business impact — deliberately WITHOUT
 * fix instructions. Resolution is offered as a service through the agency call to action.
 * Everything that originates from the target site is escaped.
 */
import type { Branding } from '../branding.js';
import type { Candidate, EvidenceItem, InvestigationResult, Level } from '../types.js';
import { esc } from './esc.js';
import { COMMERCE_CSS, isCommerceFinding, renderCommerceSections } from './commerceSection.js';
import { securityRows, securityVerdict } from './securityRows.js';
import { areaResults, gradeLabel, rateVital, summarize, verifiedFindings, VITAL_THRESHOLDS } from './summary.js';

export interface ClientReportOptions {
  imageSrc: (file: string) => string | null;
  branding: Branding;
  /** "Prepared for" name; defaults to the site host. */
  clientName?: string | null;
}

const SEV_ORDER: Record<Level, number> = { High: 0, Medium: 1, Low: 2 };
const PRIORITY: Record<Level, string> = { High: 'High priority', Medium: 'Medium priority', Low: 'Low priority' };

function safeHref(url: string): string | null {
  return /^(https?:\/\/|mailto:|tel:)/i.test(url) ? esc(url) : null;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function evidenceRows(items: EvidenceItem[], max: number): string {
  return items
    .slice(0, max)
    .map((e) => `<div class="ev-row"><div class="ev-k">${esc(e.label)}</div><div class="ev-v">${e.code ? `<pre>${esc(truncate(e.value, 700))}</pre>` : esc(truncate(e.value, 400))}</div></div>`)
    .join('');
}

function scoreRing(score: number, size = 150): string {
  const r = 58;
  const c = 2 * Math.PI * r;
  const off = c * (1 - score / 100);
  const tone = score >= 75 ? 'var(--good)' : score >= 50 ? 'var(--ni)' : 'var(--poor)';
  return `<svg class="ring" viewBox="0 0 140 140" width="${size}" height="${size}" role="img" aria-label="Health score ${score} out of 100">
    <circle cx="70" cy="70" r="${r}" fill="none" stroke="var(--ring-bg)" stroke-width="12"/>
    <circle cx="70" cy="70" r="${r}" fill="none" stroke="${tone}" stroke-width="12" stroke-linecap="round" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}" transform="rotate(-90 70 70)"/>
    <text x="70" y="68" text-anchor="middle" class="ring-num">${score}</text>
    <text x="70" y="92" text-anchor="middle" class="ring-sub">/ 100</text>
  </svg>`;
}

function contactList(b: Branding): string {
  const items: string[] = [];
  const mail = b.email ? safeHref(`mailto:${b.email}`) : null;
  const tel = b.phone ? safeHref(`tel:${b.phone.replace(/[^\d+]/g, '')}`) : null;
  const web = b.website ? safeHref(b.website) : null;
  const book = b.bookingUrl ? safeHref(b.bookingUrl) : null;
  if (book) items.push(`<a class="cta-btn primary" href="${book}" target="_blank" rel="noopener">${esc(b.offer || 'Book a call')}</a>`);
  if (mail) items.push(`<a class="cta-btn" href="${mail}">✉ ${esc(b.email)}</a>`);
  if (tel) items.push(`<a class="cta-btn" href="${tel}">☎ ${esc(b.phone)}</a>`);
  if (web) items.push(`<a class="cta-btn" href="${web}" target="_blank" rel="noopener">⌂ ${esc(b.website.replace(/^https?:\/\//, '').replace(/\/$/, ''))}</a>`);
  return items.join('');
}

function brandMark(b: Branding, cls = 'brand'): string {
  return b.logo
    ? `<div class="${cls}"><img src="${esc(b.logo)}" alt="${esc(b.agencyName)}"></div>`
    : `<div class="${cls}"><span class="brand-dot"></span><span>${esc(b.agencyName)}</span></div>`;
}

function findingCard(c: Candidate, n: number, opts: { primary: boolean; imageSrc: ClientReportOptions['imageSrc']; homepageShown: boolean }): string {
  const sev = c.severity.toLowerCase();
  const shots = opts.primary
    ? (c.screenshots ?? [])
        .filter((s) => !(opts.homepageShown && /^homepage-(desktop|mobile)\.jpg$/.test(s.file)))
        .map((s) => {
          const src = opts.imageSrc(s.file);
          const narrow = /mobile/i.test(s.file) || /\(mobile\)|390px/i.test(s.caption);
          return src ? `<figure class="${narrow ? 'narrow' : 'wide'}"><img src="${esc(src)}" alt="${esc(s.caption)}"><figcaption>${esc(s.caption)}</figcaption></figure>` : '';
        })
        .filter(Boolean)
    : [];
  const pages = c.affectedUrls.length;
  return `<article class="finding sev-${sev}${opts.primary ? ' is-primary' : ''}">
    <header class="f-head">
      <span class="f-num">${n}</span>
      <div class="f-title">
        ${opts.primary ? '<div class="f-eyebrow">Top priority</div>' : ''}
        <h3>${esc(c.title)}</h3>
        <div class="pills"><span class="pill sev-${sev}">${PRIORITY[c.severity]}</span><span class="pill soft">${esc(c.category)}</span>${pages ? `<span class="pill soft">${pages} page${pages === 1 ? '' : 's'} affected</span>` : ''}</div>
      </div>
    </header>
    <div class="f-grid">
      <div><h4>What we found</h4><p>${esc(c.summary)}</p></div>
      <div class="impact"><h4>Business impact</h4><p>${esc(c.whyItMatters)}</p></div>
    </div>
    <h4>Evidence from your live website</h4>
    <div class="evidence">${evidenceRows(c.evidence, opts.primary ? 5 : 3)}</div>
    ${shots.length ? `<div class="shots">${shots.join('')}</div>` : ''}
    <div class="resolve"><span class="resolve-icon">✓</span><span><strong>We can resolve this for you.</strong> Estimated effort: ${esc(c.effort.total)}. Implementation and before/after verification are included in our service.</span></div>
  </article>`;
}

export const CLIENT_CSS = `
:root{--ink:#0f172a;--body:#334155;--muted:#64748b;--line:#e2e8f0;--soft:#f8fafc;--good:#16a34a;--ni:#d97706;--poor:#dc2626;--ring-bg:#e2e8f0;
  --high:#dc2626;--high-bg:#fef2f2;--med:#d97706;--med-bg:#fffbeb;--low:#0284c7;--low-bg:#f0f9ff}
*{box-sizing:border-box}
body{margin:0;background:#eef2f7;color:var(--body);font:14.5px/1.6 "Segoe UI",system-ui,-apple-system,Roboto,Helvetica,Arial,sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.doc{max-width:900px;margin:0 auto;background:#fff}
.page{padding:48px 56px}
h1,h2,h3,h4{color:var(--ink);margin:0}
a{color:var(--accent)}
pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.5 ui-monospace,Consolas,monospace;color:#0f172a}
/* cover */
.cover{position:relative;min-height:1180px;display:flex;flex-direction:column;padding:0;overflow:hidden;background:linear-gradient(160deg,#0b1220 0%,#111c34 55%,var(--accent) 160%);color:#e2e8f0;break-after:page}
.cover-inner{padding:56px;display:flex;flex-direction:column;flex:1}
.cover .brand{display:flex;align-items:center;gap:10px;font-weight:700;font-size:18px;color:#fff}
.cover .brand img{max-height:52px;max-width:220px;background:#fff;border-radius:8px;padding:6px 10px}
.brand-dot{width:14px;height:14px;border-radius:4px;background:var(--accent);box-shadow:0 0 0 4px rgba(255,255,255,.12)}
.cover-kicker{margin-top:96px;font-size:13px;letter-spacing:.18em;text-transform:uppercase;color:#93c5fd;font-weight:700}
.cover h1{color:#fff;font-size:44px;line-height:1.1;margin:14px 0 12px;letter-spacing:-.02em;max-width:640px}
.cover-site{font-size:22px;color:#fff;font-weight:600;overflow-wrap:anywhere}
.cover-meta{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-top:56px;padding-top:28px;border-top:1px solid rgba(255,255,255,.14)}
.cover-meta dt{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#94a3b8}
.cover-meta dd{margin:4px 0 0;color:#fff;font-weight:600;overflow-wrap:anywhere}
.cover-score{margin-top:auto;display:flex;align-items:center;gap:28px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);border-radius:18px;padding:22px 26px}
.cover-score .ring{flex:none}
.cover .ring-num{fill:#fff;font-size:38px;font-weight:800}
.cover .ring-sub{fill:#94a3b8;font-size:13px}
.cover-score h2{color:#fff;font-size:22px}
.cover-score p{margin:6px 0 0;color:#cbd5e1}
.sev-chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
.chip{border-radius:999px;padding:4px 12px;font-size:13px;font-weight:700;background:rgba(255,255,255,.1);color:#fff}
.chip i{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}
.chip.h i{background:#f87171}.chip.m i{background:#fbbf24}.chip.l i{background:#38bdf8}
.cover-top{margin-top:44px;max-width:680px}
.ct-title{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#94a3b8;font-weight:700;margin-bottom:10px}
.cover-top ol{list-style:none;margin:0;padding:0;display:grid;gap:8px}
.cover-top li{display:flex;align-items:center;gap:12px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:11px 14px;color:#fff;font-weight:600}
.cover-top li span{flex:1;min-width:0;overflow-wrap:anywhere}
.cover-top li em{font-style:normal;font-size:12px;color:#94a3b8;white-space:nowrap}
.cover-top .d{flex:none;width:10px;height:10px;border-radius:50%}
.cover-top .d.high{background:#f87171}.cover-top .d.medium{background:#fbbf24}.cover-top .d.low{background:#38bdf8}
.ct-more{margin-top:10px;font-size:13px;color:#93c5fd}
.cover-foot{padding:18px 56px;font-size:12px;color:#94a3b8;border-top:1px solid rgba(255,255,255,.1);display:flex;justify-content:space-between;gap:12px}
/* sections */
.section{padding:44px 56px 8px}
.section+.section{padding-top:20px}
.sec-kicker{font-size:12px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:var(--accent)}
.sec-title{font-size:26px;letter-spacing:-.01em;margin:6px 0 14px}
.lead{font-size:16px;color:var(--body);margin:0 0 20px}
.lead.urgent{margin-top:14px;padding:12px 16px;border-radius:12px;background:var(--soft);border-left:4px solid var(--accent);color:var(--ink)}
.lead.urgent.sev-high{background:var(--high-bg);border-left-color:var(--high)}
.lead.urgent.sev-medium{background:var(--med-bg);border-left-color:var(--med)}
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:18px 0 8px}
.kpi{border:1px solid var(--line);border-radius:14px;padding:14px 16px;background:var(--soft)}
.kpi b{display:block;font-size:26px;color:var(--ink);line-height:1.1}
.kpi span{font-size:12.5px;color:var(--muted)}
.kpi.h b{color:var(--high)}.kpi.m b{color:var(--med)}
.areas{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:14px}
.area{border:1px solid var(--line);border-radius:14px;padding:16px;break-inside:avoid;position:relative;overflow:hidden}
.area::before{content:"";position:absolute;inset:0 auto 0 0;width:4px}
.area.pass::before{background:var(--good)}.area.warn::before{background:var(--ni)}.area.critical::before{background:var(--poor)}
.area h3{font-size:15px}
.area .covers{font-size:12.5px;color:var(--muted);margin:4px 0 10px;min-height:38px}
.status{display:inline-flex;align-items:center;gap:6px;font-weight:700;font-size:13px}
.status i{width:9px;height:9px;border-radius:50%}
.status.pass{color:var(--good)}.status.pass i{background:var(--good)}
.status.warn{color:var(--ni)}.status.warn i{background:var(--ni)}
.status.critical{color:var(--poor)}.status.critical i{background:var(--poor)}
.vitals{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:14px 0}
.vital{border:1px solid var(--line);border-radius:14px;padding:14px 16px;break-inside:avoid}
.vital .v{font-size:24px;font-weight:800;color:var(--ink)}
.vital .l{font-size:12.5px;color:var(--muted)}
.vital .bar{height:6px;border-radius:99px;background:var(--line);margin-top:10px;overflow:hidden}
.vital .bar i{display:block;height:100%}
.vital.good .bar i{background:var(--good);width:33%}.vital.ni .bar i{background:var(--ni);width:66%}.vital.poor .bar i{background:var(--poor);width:100%}
.vital .r{font-size:12px;font-weight:700;margin-top:6px}
.vital.good .r{color:var(--good)}.vital.ni .r{color:var(--ni)}.vital.poor .r{color:var(--poor)}.vital.na .r{color:var(--muted)}
.note{font-size:12.5px;color:var(--muted)}
.shots{display:grid;grid-template-columns:3fr 1fr;gap:12px;margin:14px 0;align-items:start}
.shots figure{margin:0;border:1px solid var(--line);border-radius:12px;overflow:hidden;background:var(--soft);break-inside:avoid}
.shots figure.narrow{grid-column:2}.shots figure.wide{grid-column:1}
.shots figure:only-child{grid-column:1/-1}
.shots img{display:block;width:100%;height:auto}
.shots figcaption{font-size:12px;color:var(--muted);padding:6px 10px}
/* findings */
.finding{border:1px solid var(--line);border-radius:16px;padding:20px 22px;margin:14px 0;break-inside:avoid;position:relative;background:#fff}
.finding.is-primary{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 12%,transparent)}
.f-head{display:flex;gap:14px;align-items:flex-start}
.f-num{flex:none;width:32px;height:32px;border-radius:10px;display:inline-flex;align-items:center;justify-content:center;font-weight:800;color:#fff}
.sev-high .f-num{background:var(--high)}.sev-medium .f-num{background:var(--med)}.sev-low .f-num{background:var(--low)}
.f-eyebrow{font-size:11px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:var(--accent)}
.f-title h3{font-size:17px;line-height:1.35;overflow-wrap:anywhere}
.pills{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.pill{border-radius:999px;padding:2px 10px;font-size:12px;font-weight:700}
.pill.sev-high{background:var(--high-bg);color:var(--high)}.pill.sev-medium{background:var(--med-bg);color:var(--med)}.pill.sev-low{background:var(--low-bg);color:var(--low)}
.pill.soft{background:var(--soft);color:var(--muted);border:1px solid var(--line);font-weight:600}
.f-grid{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:14px}
.finding h4{font-size:11.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin:14px 0 6px}
.f-grid h4{margin-top:0}
.finding p{margin:0}
.impact{background:#fff7ed;border-radius:12px;padding:12px 14px}
.impact h4{color:#c2410c}
.evidence{border:1px solid var(--line);border-radius:12px;overflow:hidden}
.ev-row{display:grid;grid-template-columns:32% 1fr;border-bottom:1px solid var(--line)}
.ev-row:last-child{border-bottom:0}
.ev-k{background:var(--soft);padding:8px 12px;font-size:12.5px;font-weight:600;color:var(--ink);overflow-wrap:anywhere}
.ev-v{padding:8px 12px;font-size:13px;overflow-wrap:anywhere;min-width:0}
.ev-v pre{background:#f1f5f9;border-radius:8px;padding:8px 10px}
.resolve{display:flex;gap:10px;align-items:flex-start;margin-top:14px;padding:12px 14px;border-radius:12px;background:color-mix(in srgb,var(--accent) 8%,#fff);color:var(--ink);font-size:13.5px}
.resolve-icon{flex:none;width:22px;height:22px;border-radius:50%;background:var(--accent);color:#fff;display:inline-flex;align-items:center;justify-content:center;font-size:12px;font-weight:800}
/* CTA */
.cta{margin:36px 56px;border-radius:22px;padding:34px 36px;background:linear-gradient(135deg,var(--accent),#0b1220 140%);color:#fff;break-inside:avoid}
.cta h2{color:#fff;font-size:26px;letter-spacing:-.01em}
.cta p{color:#e2e8f0;margin:10px 0 0;font-size:15px;max-width:640px}
.cta-list{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:22px 0}
.cta-list div{background:rgba(255,255,255,.1);border-radius:12px;padding:12px 14px;font-size:13px}
.cta-list b{display:block;font-size:14px;color:#fff}
.cta-actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:6px}
.cta-btn{display:inline-block;border-radius:10px;padding:10px 16px;font-weight:700;text-decoration:none;background:rgba(255,255,255,.12);color:#fff;border:1px solid rgba(255,255,255,.25)}
.cta-btn.primary{background:#fff;color:var(--accent)}
.cta .who{margin-top:18px;font-size:13px;color:#cbd5e1}
.method{padding:0 56px 40px}
.method ul{margin:8px 0 0;padding-left:18px;color:var(--body);font-size:13.5px}
.doc-foot{display:flex;justify-content:space-between;gap:12px;padding:16px 56px;border-top:1px solid var(--line);font-size:12px;color:var(--muted)}
.doc-foot .brand{display:flex;align-items:center;gap:8px;font-weight:700;color:var(--ink)}
.doc-foot .brand img{max-height:24px}
.pb{break-before:page}
.verdict{display:flex;gap:14px;align-items:center;border-radius:16px;padding:16px 20px;margin:4px 0 14px}
.verdict strong{display:block;font-size:17px;color:var(--ink)}
.verdict span{font-size:13px;color:var(--muted)}
.verdict .v-icon{flex:none;width:40px;height:40px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-size:19px}
.verdict.clean{background:#f0fdf4;border:1px solid #bbf7d0}.verdict.clean .v-icon{background:var(--good)}
.verdict.warn{background:var(--med-bg);border:1px solid #fde68a}.verdict.warn .v-icon{background:var(--ni)}
.verdict.threat{background:var(--high-bg);border:1px solid #fecaca}.verdict.threat .v-icon{background:var(--poor)}
.sec-rows{border:1px solid var(--line);border-radius:14px;overflow:hidden}
.sec-row{display:grid;grid-template-columns:30px minmax(160px,34%) 1fr;gap:10px;align-items:center;padding:11px 16px;border-bottom:1px solid var(--line);break-inside:avoid}
.sec-row:last-child{border-bottom:0}
.s-icon{width:22px;height:22px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:12px;font-weight:800;color:#fff}
.sec-row.ok .s-icon{background:var(--good)}.sec-row.warn .s-icon{background:var(--ni)}.sec-row.bad .s-icon{background:var(--poor)}.sec-row.na .s-icon{background:#cbd5e1}
.s-label{font-weight:700;color:var(--ink);font-size:13.5px}
.s-value{font-size:13.5px;overflow-wrap:anywhere}
.sec-row.bad .s-value{color:var(--poor);font-weight:600}.sec-row.na .s-value{color:var(--muted)}
@media (max-width:720px){.page,.section,.method{padding-left:18px;padding-right:18px}.cover-inner{padding:28px 20px}.cover h1{font-size:32px}.cover-kicker{margin-top:60px}.cover{min-height:auto}
  .cover-meta,.kpis,.areas,.vitals,.cta-list,.f-grid{grid-template-columns:1fr 1fr}.cta{margin:24px 12px;padding:24px 20px}.shots{grid-template-columns:1fr}.shots figure.narrow,.shots figure.wide{grid-column:1}.ev-row{grid-template-columns:1fr}.doc-foot{padding:14px 18px}}
@page{size:A4;margin:14mm 0 14mm}
@page:first{margin:0}
@media print{body{background:#fff}.doc{max-width:none}.cover{min-height:297mm;height:297mm}.section{padding-top:18px}.cta{margin:24px 40px}.page,.section,.method{padding-left:40px;padding-right:40px}.doc-foot{padding:14px 40px}}
`;

export function renderClientReport(r: InvestigationResult, opts: ClientReportOptions): string {
  const b = opts.branding;
  const s = summarize(r);
  const prepared = opts.clientName?.trim() || s.host;
  const verified = verifiedFindings(r).sort((a, c) => SEV_ORDER[a.severity] - SEV_ORDER[c.severity]);
  // Primary issue first, then by severity.
  const ordered = r.primary && verified.some((c) => c.id === r.primary!.id) ? [verified.find((c) => c.id === r.primary!.id)!, ...verified.filter((c) => c.id !== r.primary!.id)] : verified;
  if (r.primary && !ordered.some((c) => c.id === r.primary!.id) && r.primary.confidence !== 'Low') ordered.unshift(r.primary);
  // E-commerce audits present conversion / responsive findings in their own sections (with concepts).
  const general = r.commerce ? ordered.filter((c) => !isCommerceFinding(c)) : ordered;
  const commerceSections = renderCommerceSections(r, opts.imageSrc, s.host, ordered);
  const areas = areaResults(r);
  const problemAreas = areas.filter((a) => a.status !== 'pass').map((a) => a.label);
  const m = r.browser.mobile;
  const accent = /^#[0-9a-f]{6}$/i.test(b.accent) ? b.accent : '#2563eb';

  const headline = s.counts.verified
    ? `We found <strong>${s.counts.verified} verified issue${s.counts.verified === 1 ? '' : 's'}</strong> on ${esc(s.host)}${s.counts.High ? `, including <strong>${s.counts.High} high-priority</strong> problem${s.counts.High === 1 ? '' : 's'}` : ''}. ${problemAreas.length ? `They affect: ${esc(problemAreas.join(' · '))}.` : ''}`
    : `No significant issues were verified on ${esc(s.host)} during this investigation.`;

  const scoreBlock = b.showScore
    ? `<div class="cover-score">${scoreRing(s.score)}<div><h2>Website health: ${esc(gradeLabel(s.score))} (grade ${s.grade})</h2><p>Score based on ${s.counts.verified} verified finding${s.counts.verified === 1 ? '' : 's'} across ${areas.length} areas.</p>
        <div class="sev-chips"><span class="chip h"><i></i>${s.counts.High} High</span><span class="chip m"><i></i>${s.counts.Medium} Medium</span><span class="chip l"><i></i>${s.counts.Low} Low</span></div></div></div>`
    : `<div class="cover-score"><div><h2>${s.counts.verified} verified issue${s.counts.verified === 1 ? '' : 's'}</h2>
        <div class="sev-chips"><span class="chip h"><i></i>${s.counts.High} High</span><span class="chip m"><i></i>${s.counts.Medium} Medium</span><span class="chip l"><i></i>${s.counts.Low} Low</span></div></div></div>`;

  const vital = (key: keyof typeof VITAL_THRESHOLDS, v: number | null | undefined) => {
    const rating = rateVital(key, v);
    const t = VITAL_THRESHOLDS[key];
    const shown = v == null ? 'n/a' : key === 'cls' ? v.toFixed(2) : `${(v / 1000).toFixed(2)} s`;
    const label = { good: 'Good', ni: 'Needs improvement', poor: 'Poor', na: 'Not measured' }[rating];
    return `<div class="vital ${rating}"><div class="v">${shown}</div><div class="l">${esc(t.label)}</div><div class="bar"><i></i></div><div class="r">${label}</div></div>`;
  };
  const homeShots = [r.browser.desktop?.screenshotFile, r.browser.mobile?.screenshotFile]
    .filter((f): f is string => !!f)
    .map((f) => ({ f, src: opts.imageSrc(f) }))
    .filter((x) => x.src)
    .map((x) => `<figure class="${/mobile/.test(x.f) ? 'narrow' : 'wide'}"><img src="${esc(x.src!)}" alt=""><figcaption>${/mobile/.test(x.f) ? 'Mobile (390px)' : 'Desktop (1366px)'}</figcaption></figure>`);

  const perf = r.browser.available && m
    ? `<section class="section"><div class="sec-kicker">Performance snapshot</div><h2 class="sec-title">How fast your homepage loads on mobile</h2>
      <div class="vitals">${vital('lcp', m.lcpMs)}${vital('fcp', m.fcpMs)}${vital('ttfb', m.ttfbMs)}${vital('cls', m.cls)}</div>
      <p class="note">Measured in a real Chrome browser (median of ${m.runs} load${m.runs === 1 ? '' : 's'}, unthrottled). Ratings use Google’s Core Web Vitals thresholds; real visitors on mobile networks typically see slower values.</p>
      ${homeShots.length ? `<div class="shots">${homeShots.join('')}</div>` : ''}</section>`
    : '';

  let n = 0;
  const findings = general.length
    ? general.map((c) => findingCard(c, ++n, { primary: c.id === r.primary?.id, imageSrc: opts.imageSrc, homepageShown: homeShots.length > 0 && !!perf })).join('')
    : '<p class="lead">Every check passed without a verified problem. We recommend a periodic re-audit, as plugins, themes and hosting changes frequently introduce new issues.</p>';

  const topIssues = ordered.length
    ? `<div class="cover-top"><div class="ct-title">Top issues found</div><ol>${ordered
        .slice(0, 3)
        .map((c) => `<li><i class="d ${c.severity.toLowerCase()}"></i><span>${esc(c.title)}</span><em>${PRIORITY[c.severity]}</em></li>`)
        .join('')}</ol>${ordered.length > 3 ? `<div class="ct-more">+ ${ordered.length - 3} more issue${ordered.length - 3 === 1 ? '' : 's'} inside this report</div>` : ''}</div>`
    : '';
  const rows = securityRows(r);
  const verdict = securityVerdict(rows);
  const ICON = { ok: '✓', warn: '!', bad: '✕', na: '–' } as const;
  const securitySection = `<section class="section"><div class="sec-kicker">Security &amp; malware scan</div><h2 class="sec-title">Is the website safe?</h2>
  <div class="verdict ${verdict.status}"><span class="v-icon">${verdict.status === 'clean' ? '✓' : verdict.status === 'threat' ? '✕' : '!'}</span><div><strong>${esc(verdict.label)}</strong><span>Malware signatures, blacklists, search-engine cloaking, SSL, email spoofing protection, software versions, security headers and exposed files were checked.</span></div></div>
  <div class="sec-rows">${rows
    .map((row) => `<div class="sec-row ${row.status}"><span class="s-icon">${ICON[row.status]}</span><div class="s-label">${esc(row.label)}</div><div class="s-value">${esc(row.value)}</div></div>`)
    .join('')}</div>
  <p class="note">Passive, external scan of publicly served pages — server files and the database were not accessed. A clean result does not guarantee the absence of well-hidden malware.</p></section>`;
  const contact = contactList(b);
  const who = [b.consultantName, b.agencyName].filter(Boolean).map(esc).join(' · ');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<title>Website Audit — ${esc(s.host)} — ${esc(b.agencyName)}</title>
<style>:root{--accent:${accent}}${CLIENT_CSS}${r.commerce ? COMMERCE_CSS : ''}</style></head>
<body><div class="doc">
<section class="cover"><div class="cover-inner">
  ${brandMark(b)}
  <div class="cover-kicker">${r.focus === 'security' ? 'Website Security Scan' : r.focus === 'ecommerce' ? 'E-commerce Growth Audit' : 'Website Technical Audit'}</div>
  <h1>${r.focus === 'security' ? 'Website Security &amp; Malware Report' : r.focus === 'ecommerce' ? 'E-commerce Growth &amp; Conversion Report' : 'Website Health &amp; Technical SEO Report'}</h1>
  <div class="cover-site">${esc(s.host)}</div>
  <dl class="cover-meta">
    <div><dt>Prepared for</dt><dd>${esc(prepared)}</dd></div>
    <div><dt>Prepared by</dt><dd>${esc(b.agencyName)}</dd></div>
    <div><dt>Date</dt><dd>${esc(r.date)}</dd></div>
  </dl>
  ${topIssues}
  ${scoreBlock}
</div><div class="cover-foot"><span>${esc(b.tagline)}</span><span>Confidential — prepared for ${esc(prepared)}</span></div></section>

<section class="section"><div class="sec-kicker">Executive summary</div><h2 class="sec-title">What we found</h2>
  <p class="lead">${headline}</p>
  <div class="kpis">
    <div class="kpi"><b>${s.pages}</b><span>Pages analysed</span></div>
    <div class="kpi"><b>${s.counts.verified}</b><span>Verified issues</span></div>
    <div class="kpi h"><b>${s.counts.High}</b><span>High priority</span></div>
    <div class="kpi m"><b>${s.counts.Medium}</b><span>Medium priority</span></div>
  </div>
  ${r.primary && r.primary.confidence !== 'Low' ? `<p class="lead urgent sev-${r.primary.severity.toLowerCase()}">Most urgent: <strong>${esc(r.primary.title)}</strong>.</p>` : ''}
</section>

<section class="section"><div class="sec-kicker">Scorecard</div><h2 class="sec-title">Health by area</h2>
  <div class="areas">${areas
    .map((a) => `<div class="area ${a.status}"><h3>${esc(a.label)}</h3><div class="covers">${esc(a.covers)}</div><span class="status ${a.status}"><i></i>${a.status === 'pass' ? 'No issues found' : `${a.findings.length} issue${a.findings.length === 1 ? '' : 's'}${a.status === 'critical' ? ' · critical' : ''}`}</span></div>`)
    .join('')}</div>
</section>
${commerceSections}
${securitySection}
${perf}
<section class="section pb"><div class="sec-kicker">Detailed findings</div><h2 class="sec-title">Issues on your website</h2>
  <p class="lead">Each issue below was observed directly on your live website. Findings are ordered by priority.</p>
  ${findings}
</section>

<section class="cta">
  <h2>${esc(b.ctaHeadline)}</h2>
  <p>${esc(b.ctaMessage)}</p>
  <div class="cta-list">
    <div><b>Fix</b>Every issue in this report resolved by an experienced specialist.</div>
    <div><b>Verify</b>A fresh re-check proves each fix worked — before and after.</div>
    <div><b>Protect</b>No downtime approach, with backups before any change.</div>
  </div>
  ${contact ? `<div class="cta-actions">${contact}</div>` : ''}
  ${who ? `<div class="who">${who}</div>` : ''}
</section>

<section class="method"><div class="sec-kicker">Methodology</div>
  <ul>
    <li>Independent, read-only investigation of the public website — no logins, plugins or server access were used, and nothing was changed.</li>
    <li>${s.pages} pages crawled (respecting robots.txt)${r.stats.browserTest ? ', homepage measured in a real Chrome browser on mobile and desktop' : ''}; robots.txt, sitemap, redirects, security headers and platform signals checked.</li>
    <li>Only findings with direct evidence are reported. Implementation details are provided as part of an engagement.</li>
  </ul>
</section>
<footer class="doc-foot">${brandMark(b)}<span>${esc(s.host)} · ${esc(r.date)}</span></footer>
</div></body></html>`;
}
