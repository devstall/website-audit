import { buildFixGuide } from '../fix/knowledge.js';
import { FIX_CSS, renderReportFixSections, type TrackingInput } from '../fix/render.js';
import type { Candidate, InvestigationResult, Level } from '../types.js';
import { esc } from './esc.js';

export { esc };

/** Only http(s) links are rendered as anchors. */
function link(url: string): string {
  return /^https?:\/\//i.test(url) ? `<a href="${esc(url)}" rel="noopener noreferrer nofollow" target="_blank">${esc(url)}</a>` : esc(url);
}

const levelClass = (l: Level) => `lvl lvl-${l.toLowerCase()}`;
const yesNo = (b: boolean) => (b ? 'Yes' : 'No');
const ms = (v: number | null | undefined) => (v == null ? 'n/a' : `${Math.round(v)} ms`);

export const REPORT_CSS = `
.wii-report{--ink:#14161a;--muted:#5b6270;--line:#e3e6eb;--soft:#f5f6f8;--accent:#1d4ed8;--high:#b42318;--high-bg:#fef3f2;--med:#b54708;--med-bg:#fffaeb;--low:#1d6b3a;--low-bg:#ecfdf3;--code:#0f172a;--code-bg:#f3f5f9;
  color:var(--ink);font:15px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;max-width:900px;margin:0 auto}
.wii-report h1{font-size:26px;line-height:1.25;margin:0 0 4px;letter-spacing:-.01em}
.wii-report h2{font-size:18px;margin:32px 0 10px;padding-top:18px;border-top:1px solid var(--line)}
.wii-report h3{font-size:15px;margin:18px 0 6px}
.wii-report .sub{color:var(--muted);margin:0 0 18px}
.wii-report .meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin:16px 0}
.wii-report .meta div{background:var(--soft);border:1px solid var(--line);border-radius:10px;padding:10px 12px}
.wii-report .meta dt{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.wii-report .meta dd{margin:2px 0 0;font-weight:600;overflow-wrap:anywhere}
.wii-report .primary{border:1px solid var(--line);border-left:5px solid var(--accent);border-radius:12px;padding:18px 20px;margin:18px 0;background:#fff}
.wii-report .primary .eyebrow{font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--accent)}
.wii-report .primary h2{border:0;margin:6px 0 10px;padding:0;font-size:21px}
.wii-report .badges{display:flex;flex-wrap:wrap;gap:8px}
.wii-report .lvl{display:inline-block;border-radius:999px;padding:2px 10px;font-size:13px;font-weight:600}
.wii-report .lvl-high{color:var(--high);background:var(--high-bg)}
.wii-report .lvl-medium{color:var(--med);background:var(--med-bg)}
.wii-report .lvl-low{color:var(--low);background:var(--low-bg)}
.wii-report .tag{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:2px 10px;font-size:13px;color:var(--muted)}
.wii-report table{width:100%;border-collapse:collapse;margin:8px 0;font-size:14px}
.wii-report th,.wii-report td{text-align:left;vertical-align:top;border-bottom:1px solid var(--line);padding:7px 8px;overflow-wrap:anywhere}
.wii-report th{color:var(--muted);font-weight:600}
.wii-report table.kv th{width:32%}
.wii-report table.data th:first-child{width:40%}
.wii-report table.data td{font-size:13.5px}
.wii-report pre{background:var(--code-bg);color:var(--code);border-radius:8px;padding:10px 12px;font:12.5px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere;margin:4px 0}
.wii-report .evidence{border:1px solid var(--line);border-radius:10px;overflow:hidden}
.wii-report .evidence .row{display:grid;grid-template-columns:minmax(120px,30%) 1fr;border-bottom:1px solid var(--line)}
.wii-report .evidence .row:last-child{border-bottom:0}
.wii-report .evidence .k{background:var(--soft);padding:9px 12px;font-weight:600;font-size:13.5px;overflow-wrap:anywhere}
.wii-report .evidence .v{padding:9px 12px;min-width:0;overflow-wrap:anywhere}
.wii-report figure{margin:14px 0;border:1px solid var(--line);border-radius:10px;overflow:hidden;background:var(--soft);break-inside:avoid}
.wii-report figure img{display:block;width:100%;height:auto}
.wii-report figcaption{font-size:13px;color:var(--muted);padding:8px 12px}
.wii-report .shots{display:grid;grid-template-columns:3fr 1fr;gap:12px;align-items:start}
.wii-report .shots figure{margin:0}
.wii-report .shots figure.wide{grid-column:1}
.wii-report .shots figure.narrow{grid-column:2;max-width:280px}
.wii-report .shots figure.wide:only-child,.wii-report .shots figure.narrow:only-child{grid-column:1/-1}
.wii-report .shots figure.narrow:only-child{max-width:320px}
.wii-report ol,.wii-report ul{padding-left:22px}
.wii-report li{margin:4px 0}
.wii-report a{color:var(--accent)}
.wii-report .note{background:var(--soft);border-radius:8px;padding:10px 12px;color:var(--muted);font-size:14px}
.wii-report .footer{margin-top:36px;color:var(--muted);font-size:12.5px;border-top:1px solid var(--line);padding-top:12px}
.wii-report .findings{display:grid;gap:10px;margin:12px 0}
.wii-report details.finding{border:1px solid var(--line);border-radius:10px;background:#fff;break-inside:avoid-page}
.wii-report details.finding>summary{list-style:none;cursor:pointer;display:grid;grid-template-columns:28px 1fr;gap:4px 10px;padding:12px 14px;align-items:start}
.wii-report details.finding>summary::-webkit-details-marker{display:none}
.wii-report details.finding[open]>summary{border-bottom:1px solid var(--line);background:var(--soft);border-radius:10px 10px 0 0}
.wii-report details.finding .num{grid-row:span 2;width:24px;height:24px;border-radius:50%;background:var(--soft);border:1px solid var(--line);font-size:12px;font-weight:700;display:inline-flex;align-items:center;justify-content:center}
.wii-report details.finding .ftitle{font-weight:600;overflow-wrap:anywhere}
.wii-report details.finding .badges{gap:6px}
.wii-report details.finding .fbody{padding:4px 14px 12px}
.wii-report details.finding h4{font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin:14px 0 6px}
.wii-report .primary-tag{border-color:var(--accent);color:var(--accent);font-weight:600}
@media (max-width:560px){.wii-report .evidence .row{grid-template-columns:1fr}.wii-report table.kv th{width:40%}.wii-report .shots{grid-template-columns:1fr}.wii-report .shots figure.wide,.wii-report .shots figure.narrow{grid-column:1;max-width:none}}
@media print{.wii-report h2{break-after:avoid}.wii-report .primary,.wii-report .evidence .row{break-inside:avoid}}
`;

function evidenceBlock(c: Candidate): string {
  const rows = c.evidence
    .map((e) => {
      const value = e.code ? `<pre>${esc(e.value)}</pre>` : /^https?:\/\/\S+$/.test(e.value) ? link(e.value) : esc(e.value);
      return `<div class="row"><div class="k">${esc(e.label)}</div><div class="v">${value}</div></div>`;
    })
    .join('');
  return `<div class="evidence">${rows}</div>`;
}

function screenshots(c: Candidate, imageSrc: (file: string) => string | null): string {
  const figs = (c.screenshots ?? [])
    .map((s) => {
      const src = imageSrc(s.file);
      // Phone-sized captures get a narrow column so the report does not balloon in height.
      const narrow = /mobile/i.test(s.file) || /\(mobile\)|390px/i.test(s.caption);
      return src ? `<figure class="${narrow ? 'narrow' : 'wide'}"><img src="${esc(src)}" alt="${esc(s.caption)}" loading="lazy"><figcaption>${esc(s.caption)}</figcaption></figure>` : '';
    })
    .filter(Boolean);
  if (!figs.length) return '';
  return `<h3>Screenshot evidence</h3><div class="shots">${figs.join('')}</div>`;
}

function dashboard(r: InvestigationResult): string {
  const s = r.stats;
  const items: [string, string][] = [
    ['Pages analyzed', String(s.pagesAnalyzed)],
    ['Requests made', `${s.requestsMade}${s.browserRequests ? ` (+${s.browserRequests} in browser)` : ''}`],
    ['Desktop tested', yesNo(s.desktopTested)],
    ['Mobile tested', yesNo(s.mobileTested)],
    ['Robots tested', yesNo(s.robotsTested)],
    ['Sitemap tested', yesNo(s.sitemapTested)],
    ['Browser test', yesNo(s.browserTest)],
    ['Duration', `${Math.round(s.durationMs / 1000)} s`],
  ];
  return `<dl class="meta">${items.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>`;
}

function technicalDetails(r: InvestigationResult, c: Candidate | null): string {
  const b = r.browser;
  const wp = r.wordpress;
  const vitals = (label: string, m: typeof b.mobile) =>
    m
      ? `<tr><td>${esc(label)} (${m.viewport.width}×${m.viewport.height}, ${m.runs} run${m.runs === 1 ? '' : 's'})</td><td>${ms(m.lcpMs)}</td><td>${m.cls ?? 'n/a'}</td><td>${ms(m.fcpMs)}</td><td>${ms(m.ttfbMs)}</td><td>${m.inpMs == null ? 'not measured*' : ms(m.inpMs)}</td></tr>`
      : '';
  const cwv = b.available
    ? `<table class="data"><thead><tr><th>Profile</th><th>LCP</th><th>CLS</th><th>FCP</th><th>TTFB</th><th>INP</th></tr></thead><tbody>${vitals('Mobile', b.mobile)}${vitals('Desktop', b.desktop)}</tbody></table>
       <p class="note">Lab values measured in ${esc(b.engine ?? 'Chromium')} from the investigator's network without throttling (median of runs). *INP requires real user interaction and is not simulated. Field data from real users may differ.</p>`
    : `<p class="note">Core Web Vitals could not be directly measured. ${esc(b.reason ?? '')}</p>`;
  const headers = ['server', 'content-type', 'content-encoding', 'cache-control', 'strict-transport-security', 'x-robots-tag', 'x-powered-by', 'vary', 'etag', 'last-modified']
    .map((h) => `${h}: ${r.homepageHeaders[h] ?? '(not present)'}`)
    .join('\n');
  const theme = wp.theme ? `${wp.theme.name ?? wp.theme.slug} (slug: ${wp.theme.slug}${wp.theme.version ? `, version ${wp.theme.version}` : ''}${wp.theme.isChild ? `, child of ${wp.theme.parent}` : ''})` : 'Not detected';
  const plugins = wp.plugins.length ? wp.plugins.map((p) => `${p.slug}${p.versions.length ? ` (${p.versions.join(', ')})` : ''}`).join(', ') : 'None publicly exposed';
  return `
  <h2>${c ? 10 : 1}. Technical Details</h2>
  ${c ? `<table class="kv"><tbody>
    <tr><th>Detection method</th><td>${esc(c.howIdentified)}</td></tr>
    <tr><th>Category</th><td>${esc(c.category)}</td></tr>
    <tr><th>Affected URLs (${c.affectedUrls.length})</th><td>${c.affectedUrls.slice(0, 25).map(link).join('<br>')}${c.affectedUrls.length > 25 ? `<br>… and ${c.affectedUrls.length - 25} more` : ''}</td></tr>
    <tr><th>False-positive checks</th><td><ul>${c.verification.map((v) => `<li>${esc(v)}</li>`).join('')}</ul></td></tr>
  </tbody></table>` : ''}
  <h3>Measurements</h3>
  ${cwv}
  <h3>HTTP information</h3>
  <table class="kv"><tbody>
    <tr><th>URL entered</th><td>${link(r.inputUrl)}</td></tr>
    <tr><th>Final homepage URL</th><td>${link(r.siteUrl)}</td></tr>
    <tr><th>Redirect chain</th><td><pre>${esc(r.homepageChain.map((h) => `${h.url}  [${h.status}]`).join('\n→ '))}</pre></td></tr>
    <tr><th>Homepage headers</th><td><pre>${esc(headers)}</pre></td></tr>
  </tbody></table>
  <h3>Browser information</h3>
  <table class="kv"><tbody>
    <tr><th>Engine</th><td>${esc(b.available ? b.engine : `Unavailable — ${b.reason ?? ''}`)}</td></tr>
    <tr><th>Third-party domains</th><td>${esc(b.thirdPartyDomains.length ? `${b.thirdPartyDomains.length}: ${b.thirdPartyDomains.slice(0, 30).join(', ')}` : 'None observed')}</td></tr>
    <tr><th>Uncaught JS errors / failed requests</th><td>${b.pageErrors.length} / ${b.failedRequests.length}</td></tr>
  </tbody></table>
  <h3>Platform fingerprint (public signals only)</h3>
  <table class="kv"><tbody>
    <tr><th>WordPress detected</th><td>${yesNo(wp.detected)}${wp.signals.length ? `<br><small>${esc(wp.signals.join(' · '))}</small>` : ''}</td></tr>
    ${wp.detected ? `<tr><th>WordPress version</th><td>${esc(wp.version ? `${wp.version} (${wp.versionSource})` : 'Not publicly exposed')}</td></tr>
    <tr><th>Theme</th><td>${esc(theme)}</td></tr>
    <tr><th>Plugins (asset paths)</th><td>${esc(plugins)}</td></tr>
    <tr><th>REST API</th><td>${esc(wp.restApi.available ? `Available (HTTP ${wp.restApi.status})` : `Not confirmed${wp.restApi.status ? ` (HTTP ${wp.restApi.status})` : ''}`)}</td></tr>` : ''}
  </tbody></table>
  <p class="note">Version numbers are reported as observed. No plugin, theme or core version is claimed to be vulnerable: this investigation does not consult a vulnerability database.</p>
  ${r.notes.length ? `<h3>Investigation notes</h3><ul>${r.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
  <h3>Pages analyzed</h3>
  <table class="data"><thead><tr><th>URL</th><th>Status</th><th>TTFB</th><th>Title</th></tr></thead><tbody>
  ${r.pages.map((p) => `<tr><td>${link(p.finalUrl)}</td><td>${p.status}</td><td>${p.ttfbMs} ms</td><td>${esc(p.title ?? '—')}</td></tr>`).join('')}
  </tbody></table>`;
}

export interface RenderOptions {
  /** Maps a screenshot file name to an img src (URL or data URI). Return null to omit. */
  imageSrc: (file: string) => string | null;
  /** Include the Fix Assistant, verification and resolution sections (default true). The UI shows them in its own panel. */
  includeFix?: boolean;
  /** Report status and re-check history, when the report comes from a stored investigation. */
  tracking?: TrackingInput | null;
  /** Render every finding expanded (downloads/PDF). The UI keeps them collapsed. */
  expandFindings?: boolean;
}

const SEVERITY_ORDER: Record<Level, number> = { High: 0, Medium: 1, Low: 2 };

/** Counts by severity, for the headline summary. Low-confidence signals are counted separately. */
function findingCounts(r: InvestigationResult): string {
  const verified = r.candidates.filter((c) => c.confidence !== 'Low');
  const unverified = r.candidates.length - verified.length;
  if (!r.candidates.length) return 'No issues detected';
  const by = (l: Level) => verified.filter((c) => c.severity === l).length;
  const parts = (['High', 'Medium', 'Low'] as Level[]).filter((l) => by(l)).map((l) => `${by(l)} ${l}`);
  return `${verified.length} verified${parts.length ? ` (${parts.join(', ')})` : ''}${unverified ? ` · ${unverified} unverified` : ''}`;
}

function findingCard(c: Candidate, index: number, isPrimary: boolean, open: boolean): string {
  const urls = c.affectedUrls.slice(0, 10).map(link).join('<br>');
  const more = c.affectedUrls.length > 10 ? `<br>… and ${c.affectedUrls.length - 10} more` : '';
  return `<details class="finding"${open ? ' open' : ''}>
    <summary>
      <span class="num">${index}</span>
      <span class="ftitle">${esc(c.title)}</span>
      <span class="badges">${isPrimary ? '<span class="tag primary-tag">Primary</span>' : ''}<span class="${levelClass(c.severity)}">${esc(c.severity)}</span><span class="${levelClass(c.confidence)}">Confidence: ${esc(c.confidence)}</span><span class="tag">${esc(c.category)}</span></span>
    </summary>
    <div class="fbody">
      <p>${esc(c.summary)}</p>
      <h4>Evidence</h4>
      ${evidenceBlock(c)}
      <h4>Why it matters</h4>
      <p>${esc(c.whyItMatters)}</p>
      <h4>Recommended fix</h4>
      <ol>${c.solution.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
      <table class="kv"><tbody>
        <tr><th>Affected URLs (${c.affectedUrls.length})</th><td>${urls || '—'}${more}</td></tr>
        <tr><th>Estimated effort</th><td>${esc(c.effort.total)}</td></tr>
        <tr><th>How it was identified</th><td>${esc(c.howIdentified)}</td></tr>
        ${c.verification.length ? `<tr><th>False-positive checks</th><td><ul>${c.verification.map((v) => `<li>${esc(v)}</li>`).join('')}</ul></td></tr>` : ''}
      </tbody></table>
    </div>
  </details>`;
}

/** Every detected finding, verified ones ordered by severity then internal rank; low-confidence signals listed separately. */
function allFindings(r: InvestigationResult, heading: string, open: boolean): string {
  const ranked = r.candidates; // already in internal rank order
  const verified = ranked.filter((c) => c.confidence !== 'Low').sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  const unverified = ranked.filter((c) => c.confidence === 'Low');
  if (!ranked.length) return `<h2>${heading}</h2><p class="note">No issues were detected by any check.</p>`;
  let n = 0;
  const card = (c: Candidate) => findingCard(c, ++n, c.id === r.primary?.id, open);
  return `<h2>${heading} (${ranked.length})</h2>
  <p class="note">${esc(findingCounts(r))}. ${r.primary ? 'The primary issue above is explained in full; every other finding is summarised here with its evidence and fix.' : ''}</p>
  <div class="findings">${verified.map(card).join('')}</div>
  ${unverified.length ? `<h3>Unverified signals (low confidence)</h3>
  <p class="note">These were observed but could not be confirmed as real problems (for example bot protection or errors whose impact is unknown). Review before acting.</p>
  <div class="findings">${unverified.map(card).join('')}</div>` : ''}`;
}

/** The report body (no <html>/<head>) — used by the UI and wrapped by renderReportDocument. */
export function renderReportBody(r: InvestigationResult, opts: RenderOptions): string {
  const c = r.primary;
  const header = `
  <h1>Independent Website Investigation Report</h1>
  <p class="sub">A passive, public-URL-only technical investigation. The most important issue is explained in full, followed by every other finding.</p>
  <dl class="meta">
    <div><dt>Website</dt><dd>${link(r.siteUrl)}</dd></div>
    <div><dt>Investigation date</dt><dd>${esc(r.date)}</dd></div>
    <div><dt>WordPress detected</dt><dd>${yesNo(r.wordpress.detected)}</dd></div>
    <div><dt>Findings</dt><dd>${esc(findingCounts(r))}</dd></div>
  </dl>
  <h3>Evidence dashboard</h3>
  ${dashboard(r)}`;

  if (!c) {
    return `<div class="wii-report">${header}
    <section class="primary"><div class="eyebrow">Result</div><h2>No significant verified issue found</h2>
    <p>Every check completed without producing a finding that met the evidence and confidence threshold for a primary issue. Weaker signals are listed below as unverified.</p></section>
    ${allFindings(r, 'All Findings', !!opts.expandFindings)}
    ${technicalDetails(r, null)}
    <p class="footer">Generated by Website Independent Investigator — passive checks against publicly accessible URLs only. No authentication, plugins or server access were used.</p></div>`;
  }

  const guide = buildFixGuide(r);
  const includeFix = opts.includeFix !== false && !!guide;
  // The fix component emits "7. Exact Fix Instructions" and "9. Verification…"; split it around section 8.
  const fixHtml = includeFix ? renderReportFixSections(guide!, opts.tracking ?? null, { fix: 7, verify: 9 }) : '';
  const cut = fixHtml.indexOf('<h2 class="sec">9.');
  const fixSections = includeFix ? `${fixHtml.slice(0, cut)}</div>` : '';
  const verifySections = includeFix ? `<div class="wii-fix">${fixHtml.slice(cut)}` : '';
  const statusBadge = opts.tracking ? `<span class="tag">Status: ${esc(opts.tracking.reportStatus)}</span>` : '';

  return `<div class="wii-report">${header}
  <section class="primary">
    <div class="eyebrow">Primary issue discovered</div>
    <h2>${esc(c.title)}</h2>
    <div class="badges"><span class="${levelClass(c.severity)}">Severity: ${esc(c.severity)}</span><span class="${levelClass(c.confidence)}">Confidence: ${esc(c.confidence)}</span><span class="tag">${esc(c.category)}</span>${statusBadge}</div>
  </section>

  <h2>1. Issue Discovered</h2>
  <p>${esc(c.summary)}</p>

  <h2>2. How It Was Identified</h2>
  <p>${esc(c.howIdentified)}</p>

  <h2>3. Evidence</h2>
  ${evidenceBlock(c)}
  ${screenshots(c, opts.imageSrc)}

  <h2>4. Why It Matters</h2>
  <p>${esc(c.whyItMatters)}</p>

  <h2>5. Root Cause</h2>
  ${guide ? `<p>${esc(guide.understand.why)}</p>
  <table class="kv"><tbody>
    <tr><th>Issue</th><td>${esc(guide.rootCause.issue)}</td></tr>
    <tr><th>Root cause</th><td>${esc(guide.rootCause.rootCause)}</td></tr>
    <tr><th>Fix location</th><td>${esc(guide.rootCause.fixLocation)}</td></tr>
  </tbody></table>
  <p class="note">${esc(guide.rootCause.explanation)} A URL-only investigation cannot see private server, hosting or admin configuration.</p>` : '<p class="note">Not determined.</p>'}

  <h2>6. Recommended Solution</h2>
  <ol>${c.solution.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
  <p class="note">Recommendation only — no changes were made to the website.</p>

  ${fixSections || '<h2>7. Exact Fix Instructions</h2><p class="note">Shown in the Fix Assistant panel.</p>'}

  <h2>8. Estimated Effort</h2>
  <table class="kv"><tbody>
    <tr><th>Investigation</th><td>${esc(c.effort.investigation)}</td></tr>
    <tr><th>Implementation</th><td>${esc(c.effort.implementation)}</td></tr>
    <tr><th>Testing</th><td>${esc(c.effort.testing)}</td></tr>
    <tr><th>Total</th><td><strong>${esc(c.effort.total)}</strong></td></tr>
    ${guide ? `<tr><th>Difficulty / risk</th><td>${esc(guide.difficulty)} / ${esc(guide.risk)}</td></tr><tr><th>Required access</th><td>${esc(guide.access.join(' + '))}</td></tr>` : ''}
  </tbody></table>
  ${verifySections}

  ${allFindings(r, 'All Findings', !!opts.expandFindings)}

  ${technicalDetails(r, c)}
  <p class="footer">Generated by Website Independent Investigator on ${esc(r.date)} — passive checks against publicly accessible URLs only. No authentication, plugins or server access were used, and the website was not modified.</p>
  </div>`;
}

/** Standalone, self-contained HTML document (for download and PDF rendering). */
export function renderReportDocument(r: InvestigationResult, opts: RenderOptions): string {
  let host = r.siteUrl;
  try {
    host = new URL(r.siteUrl).hostname;
  } catch {
    /* keep raw */
  }
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<title>Client Report — ${esc(host)}</title>
<style>body{margin:0;padding:32px 20px;background:#fff}${REPORT_CSS}${FIX_CSS}.wii-report .wii-fix h2.sec{font-size:18px;margin:32px 0 10px;padding-top:18px;border-top:1px solid #e3e6eb}</style></head>
<body>${renderReportBody(r, { ...opts, expandFindings: true })}</body></html>`;
}
