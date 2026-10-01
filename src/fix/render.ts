/**
 * HTML for the Fix Assistant, the re-check comparison and the resolution history.
 * Shared by the web UI, the WordPress plugin (which embeds these fragments) and the client report.
 * Every value derived from the target site is escaped.
 */
import { esc } from '../report/esc.js';
import type { InvestigationResult, Measurement, RecheckRecord, RecheckResult, ReportStatus } from '../types.js';
import type { FixGuide } from './knowledge.js';

export const STATUS_TEXT: Record<RecheckResult['status'], { badge: string; cls: string; message: string }> = {
  resolved: { badge: '✓ ISSUE RESOLVED', cls: 'ok', message: 'Great — the issue no longer appears to be present.' },
  'still-detected': { badge: '⚠ STILL DETECTED', cls: 'warn', message: 'The issue is still present.' },
  'unable-to-verify': { badge: '? UNABLE TO VERIFY', cls: 'unknown', message: 'The website could not be reliably checked.' },
};

const REPORT_STATUS_CLS: Record<ReportStatus, string> = { Open: 'open', 'In Progress': 'progress', Resolved: 'ok', 'Unable to Verify': 'unknown' };

export const FIX_CSS = `
.wii-fix{--ink:#14161a;--muted:#5b6270;--line:#e3e6eb;--soft:#f5f6f8;--accent:#1d4ed8;--ok:#1d6b3a;--ok-bg:#ecfdf3;--warn:#b54708;--warn-bg:#fffaeb;--bad:#b42318;--bad-bg:#fef3f2;--code-bg:#f3f5f9;
  color:var(--ink);font:15px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.wii-fix h2{font-size:19px;margin:0 0 6px}
.wii-fix h3{font-size:15px;margin:22px 0 8px;padding-top:14px;border-top:1px solid var(--line)}
.wii-fix h4{font-size:14px;margin:14px 0 6px}
.wii-fix .step{font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--accent);display:block}
.wii-fix .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:8px;margin:10px 0}
.wii-fix .grid div{background:var(--soft);border:1px solid var(--line);border-radius:10px;padding:8px 11px}
.wii-fix .grid dt{font-size:11.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.wii-fix .grid dd{margin:2px 0 0;font-weight:600;overflow-wrap:anywhere}
.wii-fix .pill{display:inline-block;border-radius:999px;padding:2px 10px;font-size:13px;font-weight:600;background:var(--soft);border:1px solid var(--line)}
.wii-fix .pill.ok,.wii-fix .lvl-low,.wii-fix .rc-confirmed{color:var(--ok);background:var(--ok-bg);border-color:transparent}
.wii-fix .pill.warn,.wii-fix .lvl-medium,.wii-fix .rc-likely{color:var(--warn);background:var(--warn-bg);border-color:transparent}
.wii-fix .pill.bad,.wii-fix .lvl-high{color:var(--bad);background:var(--bad-bg);border-color:transparent}
.wii-fix .pill.unknown,.wii-fix .rc-possible,.wii-fix .rc-unknown{color:var(--muted)}
.wii-fix .pill.open{color:var(--bad);background:var(--bad-bg);border-color:transparent}
.wii-fix .pill.progress{color:var(--accent);background:#eff4ff;border-color:transparent}
.wii-fix .method{border:1px solid var(--line);border-left:4px solid var(--accent);border-radius:10px;padding:10px 14px;margin:8px 0}
.wii-fix .method strong{font-size:16px}
.wii-fix .path{display:flex;flex-wrap:wrap;gap:4px;align-items:center;margin:4px 0}
.wii-fix ol.fsteps{padding-left:22px;margin:6px 0}
.wii-fix ol.fsteps li{margin:3px 0}
.wii-fix .why{font-size:12.5px;color:var(--muted);margin:2px 0 6px}
.wii-fix pre{background:var(--code-bg);border-radius:8px;padding:10px 12px;font:12.5px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere;margin:4px 0}
.wii-fix .codebox{border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin:10px 0}
.wii-fix .codebox .meta{font-size:13.5px}
.wii-fix .codebox dl{display:grid;grid-template-columns:minmax(110px,22%) 1fr;gap:4px 10px;margin:8px 0 0;font-size:13.5px}
.wii-fix .codebox dt{color:var(--muted);font-weight:600}
.wii-fix .codebox dd{margin:0}
.wii-fix .ba{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:8px 0}
.wii-fix .ba div>span{font-size:11.5px;font-weight:700;letter-spacing:.06em}
.wii-fix .ba .before span{color:var(--bad)}
.wii-fix .ba .after span{color:var(--ok)}
.wii-fix .callout{border-radius:8px;padding:9px 12px;margin:10px 0;font-size:14px}
.wii-fix .callout.warn{background:var(--warn-bg);color:#7a3406}
.wii-fix .callout.info{background:var(--soft);color:var(--muted)}
.wii-fix .callout.ok{background:var(--ok-bg);color:var(--ok)}
.wii-fix .callout.unknown{background:var(--soft);color:var(--ink)}
.wii-fix .verdict{border-radius:12px;padding:14px 16px;margin:12px 0}
.wii-fix .verdict.ok{background:var(--ok-bg)}
.wii-fix .verdict.warn{background:var(--warn-bg)}
.wii-fix .verdict.unknown{background:var(--soft)}
.wii-fix .verdict .big{font-size:18px;font-weight:800;letter-spacing:.02em}
.wii-fix table{width:100%;border-collapse:collapse;font-size:13.5px;margin:6px 0}
.wii-fix th,.wii-fix td{text-align:left;vertical-align:top;border-bottom:1px solid var(--line);padding:6px 8px;overflow-wrap:anywhere}
.wii-fix th{color:var(--muted);font-weight:600}
.wii-fix td.bad{color:var(--bad)}
.wii-fix td.ok{color:var(--ok)}
.wii-fix td.unknown{color:var(--muted);font-style:italic}
.wii-fix .copy{font:inherit;font-size:12.5px;font-weight:600;border:1px solid var(--line);background:#fff;color:var(--accent);border-radius:7px;padding:3px 10px;cursor:pointer;float:right}
.wii-fix .copy.done{color:var(--ok)}
.wii-fix .copy.all{float:none;font-size:14px;padding:7px 14px}
.wii-fix .history li{margin:6px 0}
.wii-fix .flow{font-size:13px;font-weight:700;letter-spacing:.06em;color:var(--muted);text-align:center;margin:6px 0}
@media (max-width:620px){.wii-fix .ba{grid-template-columns:1fr}.wii-fix .codebox dl{grid-template-columns:1fr}}
@media print{.wii-fix .copy{display:none}}
`;

interface Opts {
  /** Include Copy buttons (UI / WordPress admin). Reports are static. */
  interactive?: boolean;
}

let copyId = 0;
function copyable(text: string, opts: Opts): { button: string; source: string } {
  if (!opts.interactive) return { button: '', source: '' };
  const id = `wii-copy-${++copyId}`;
  return {
    button: `<button type="button" class="copy" data-copy-target="${id}">Copy</button>`,
    source: `<pre id="${id}" hidden>${esc(text)}</pre>`,
  };
}

const rcClass = (l: string) => `pill rc-${l.toLowerCase()}`;

function instructionsHtml(g: FixGuide, opts: Opts): string {
  if (!g.instructions.length) return '';
  return g.instructions
    .map((s) => {
      const text = `${s.title} (${s.platform})\n${s.steps.map((st, i) => `${i + 1}. ${st}`).join('\n')}`;
      const c = copyable(text, opts);
      return `<div class="codebox">${c.button}<h4>${esc(s.title)} <span class="pill">${esc(s.platform)}</span></h4>
        ${s.shownBecause ? `<p class="why">Shown because: ${esc(s.shownBecause)}</p>` : ''}
        <ol class="fsteps">${s.steps.map((st) => `<li>${esc(st)}</li>`).join('')}</ol>
        ${c.source}</div>`;
    })
    .join('');
}

function codeHtml(g: FixGuide, opts: Opts): string {
  return g.code
    .map((k) => {
      const c = copyable(k.code, opts);
      return `<div class="codebox">${c.button}<h4>${esc(k.title)}</h4>
        <p class="meta"><strong>File:</strong> ${esc(k.file)}<br><strong>Recommended location:</strong> ${esc(k.location)}</p>
        <pre>${esc(k.code)}</pre>
        <dl><dt>What it does</dt><dd>${esc(k.whatItDoes)}</dd><dt>Why it fixes it</dt><dd>${esc(k.whyItFixes)}</dd><dt>Side effects</dt><dd>${esc(k.sideEffects)}</dd><dt>How to revert</dt><dd>${esc(k.revert)}</dd></dl>${c.source}</div>`;
    })
    .join('');
}

function beforeAfterHtml(g: FixGuide): string {
  return g.beforeAfter
    .map((b) => `<h4>${esc(b.label)}</h4><div class="ba"><div class="before"><span>BEFORE</span><pre>${esc(b.before)}</pre></div><div class="after"><span>AFTER</span><pre>${esc(b.after)}</pre></div></div>`)
    .join('');
}

function effortHtml(g: FixGuide): string {
  return `<dl class="grid">
    <div><dt>Difficulty</dt><dd>${esc(g.difficulty)}</dd></div>
    <div><dt>Required access</dt><dd>${esc(g.access.join(' + '))}</dd></div>
    <div><dt>Estimated time</dt><dd>${esc(g.time)}</dd></div>
    <div><dt>Risk</dt><dd><span class="pill ${g.risk === 'High' ? 'bad' : g.risk === 'Medium' ? 'warn' : 'ok'}">${esc(g.risk)}</span></dd></div>
  </dl>
  ${g.backup ? '<p class="callout warn">Create a backup/staging copy before applying this change.</p>' : ''}
  ${g.staging ? '<p class="callout info"><strong>Recommended:</strong> Test this change on staging before production.</p>' : ''}`;
}

/** The guided fix panel (steps 1–5). */
export function renderFixPanel(g: FixGuide, opts: Opts = {}): string {
  copyId = 0;
  return `<div class="wii-fix">
  <span class="step">Fix Assistant</span>
  <h2>${esc(g.title)}</h2>
  ${g.detected.length ? `<p class="why">Detected publicly: ${esc(g.detected.join(' · '))}</p>` : '<p class="why">No platform-specific tools were detected publicly; instructions are generic.</p>'}

  <h3><span class="step">Step 1 — Understand</span></h3>
  <h4>What we found</h4><p>${esc(g.understand.found)}</p>
  <h4>Why it is happening</h4><p>${esc(g.understand.why)}</p>
  <h4>How confident we are</h4><p>${esc(g.understand.confidence)}</p>
  <dl class="grid">
    <div><dt>Issue confidence</dt><dd><span class="pill lvl-${g.confidence.issue === 'High' ? 'low' : g.confidence.issue === 'Medium' ? 'medium' : 'high'}">${esc(g.confidence.issue.toUpperCase())}</span></dd></div>
    <div><dt>Fix confidence</dt><dd><span class="pill lvl-${g.confidence.fix === 'High' ? 'low' : g.confidence.fix === 'Medium' ? 'medium' : 'high'}">${esc(g.confidence.fix.toUpperCase())}</span></dd></div>
  </dl>
  <p class="why">Reason: ${esc(g.confidence.reason)}</p>
  <dl class="grid">
    <div><dt>Issue</dt><dd><span class="${rcClass(g.rootCause.issue)}">${esc(g.rootCause.issue)}</span></dd></div>
    <div><dt>Root cause</dt><dd><span class="${rcClass(g.rootCause.rootCause)}">${esc(g.rootCause.rootCause)}</span></dd></div>
    <div><dt>Fix location</dt><dd><span class="${rcClass(g.rootCause.fixLocation)}">${esc(g.rootCause.fixLocation)}</span></dd></div>
  </dl>
  <p class="why">${esc(g.rootCause.explanation)} URL-only analysis cannot see private server or admin configuration.</p>

  <h3><span class="step">Step 2 — Fix method</span></h3>
  <div class="method">Recommended Fix Method:<br><strong>[${esc(g.method.label)}]</strong><p class="why">${esc(g.method.reason)}</p>
  ${g.method.alternatives.length ? `<p class="why">Also possible: ${esc(g.method.alternatives.map((a) => a.label).join(', '))}</p>` : ''}</div>
  ${effortHtml(g)}

  <h3><span class="step">Step 3 — Exact instructions</span></h3>
  ${instructionsHtml(g, opts) || '<p>No admin-panel steps apply; see the developer fix below.</p>'}

  <h3><span class="step">Step 4 — Developer fix</span></h3>
  ${g.code.length ? `${codeHtml(g, opts)}<p class="callout info">Never edit a parent theme directly — use a child theme or a custom plugin so updates do not erase the change.</p>` : '<p>No code change is required for this fix.</p>'}

  ${g.beforeAfter.length ? `<h3><span class="step">Step 5 — Before / After</span></h3>${beforeAfterHtml(g)}` : ''}

  <h3><span class="step">Verification</span></h3>
  <p>After applying the fix, <strong>Re-check This Issue</strong> tests only:</p>
  <ol class="fsteps">${g.verification.map((v) => `<li>${esc(v)}</li>`).join('')}</ol>
  <p class="callout info">These are instructions only. The investigator is read-only: it never changes the website, and it reports the issue as resolved only after a fresh re-check confirms it.</p>
</div>`;
}

// ------------------------------------------------------------------ re-check / tracking

function comparisonRows(before: Measurement[] | undefined, after: Measurement[]): { label: string; before: Measurement | null; after: Measurement | null }[] {
  const b = new Map((before ?? []).map((x) => [x.key, x]));
  const rows: { label: string; before: Measurement | null; after: Measurement | null }[] = [];
  for (const a of after) rows.push({ label: a.label, before: b.get(a.key) ?? null, after: a });
  for (const x of before ?? []) if (!after.some((a) => a.key === x.key) && x.state !== 'info') rows.push({ label: x.label, before: x, after: null });
  // Only show what was actually measured on at least one side.
  return rows.filter((r) => (r.before && r.before.state !== 'unknown') || (r.after && r.after.state !== 'unknown') || r.after?.state === 'unknown');
}

const cell = (m: Measurement | null) => (m ? `<td class="${m.state === 'bad' ? 'bad' : m.state === 'ok' ? 'ok' : m.state === 'unknown' ? 'unknown' : ''}">${esc(m.value)}</td>` : '<td class="unknown">not measured</td>');

export function comparisonTable(before: Measurement[] | undefined, after: Measurement[], labels = ['BEFORE', 'AFTER']): string {
  const rows = comparisonRows(before, after);
  if (!rows.length) return '';
  return `<table><thead><tr><th>Measurement</th><th>${labels[0]}</th><th>${labels[1]}</th></tr></thead><tbody>${rows
    .map((r) => `<tr><td>${esc(r.label)}</td>${cell(r.before)}${cell(r.after)}</tr>`)
    .join('')}</tbody></table>`;
}

function verdictHtml(rc: RecheckRecord, baseline: Measurement[] | undefined): string {
  if (rc.state === 'running') return `<div class="verdict unknown"><div class="big">Re-checking…</div><p>Testing only this issue again.</p></div>`;
  if (rc.state === 'failed' || !rc.result) return `<div class="verdict unknown"><div class="big">? UNABLE TO VERIFY</div><p>The website could not be reliably checked.</p><p class="why">${esc(rc.error ?? 'Unknown error')}</p></div>`;
  const r = rc.result;
  const t = STATUS_TEXT[r.status];
  const current = r.status === 'still-detected' && r.currentEvidence.length
    ? `<h4>Current evidence</h4><table><tbody>${r.currentEvidence.slice(0, 8).map((e) => `<tr><th>${esc(e.label)}</th><td><pre>${esc(e.value)}</pre></td></tr>`).join('')}</tbody></table>`
    : '';
  return `<div class="verdict ${t.cls}"><div class="big">${t.badge}</div><p>${esc(t.message)}</p>
    ${r.status === 'unable-to-verify' && r.reasons.length ? `<p><strong>Why:</strong></p><ul>${r.reasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    ${r.status !== 'unable-to-verify' && r.reasons.length ? `<p class="why">${esc(r.reasons.join(' '))}</p>` : ''}
    </div>
    ${comparisonTable(baseline, r.measurements, ['BEFORE', r.status === 'resolved' ? 'AFTER' : 'CURRENT'])}
    ${current}
    <p class="why">Re-checked: ${esc(r.checks.join(' · '))} — ${r.requestsMade} request(s)${r.browserUsed ? ' + browser' : ''}, ${Math.round(r.durationMs / 1000)} s, ${esc(new Date(rc.completedAt ?? rc.createdAt).toLocaleString('en-GB', { timeZone: 'UTC' }))} UTC.</p>`;
}

export interface TrackingInput {
  investigationId: string;
  result: InvestigationResult;
  reportStatus: ReportStatus;
  rechecks: RecheckRecord[];
  fixLog: { at: string; method: string }[];
}

function historyHtml(t: TrackingInput): string {
  const firstBad = t.result.baseline?.find((m) => m.state === 'bad');
  const items = t.rechecks.map((rc) => {
    const r = rc.result;
    const key = firstBad?.key;
    const m = r && key ? r.measurements.find((x) => x.key === key) : null;
    const status = rc.state === 'running' ? 'Running' : rc.state === 'failed' || !r ? 'Unable to verify' : r.status === 'resolved' ? 'Resolved' : r.status === 'still-detected' ? 'Still detected' : 'Unable to verify';
    return `<li><strong>Re-check #${rc.seq}</strong> — ${esc(rc.createdAt.slice(0, 16).replace('T', ' '))} UTC${m ? `: ${esc(m.value)}` : ''}<br>Status: ${esc(status)}${rc.fixShown ? `<br><span class="why">Fix instructions shown before this re-check: ${esc(rc.fixShown)}</span>` : ''}</li>`;
  });
  return `<ul class="history">
    <li><strong>Original investigation</strong> — ${esc(t.result.date)}${firstBad ? `: ${esc(firstBad.label)} = ${esc(firstBad.value)}` : ''}<br>Issue: ${esc(t.result.primary?.title ?? '')}</li>
    ${items.join('')}
  </ul>`;
}

/** Status + latest re-check + history. Used by the UI/WordPress panel. */
export function renderTracking(t: TrackingInput): string {
  const latest = t.rechecks.at(-1);
  return `<div class="wii-fix">
    <p>Report status: <span class="pill ${REPORT_STATUS_CLS[t.reportStatus]}">${esc(t.reportStatus)}</span>
    ${t.fixLog.length && t.reportStatus !== 'Resolved' ? '<span class="why"> · Fix instructions provided — resolution not yet verified.</span>' : ''}</p>
    ${latest ? verdictHtml(latest, t.result.baseline) : '<p class="why">Not re-checked yet. Apply the fix, then use Re-check This Issue — only the relevant test runs again.</p>'}
    ${t.rechecks.length ? `<h3>Re-check history</h3>${historyHtml(t)}` : ''}
  </div>`;
}

/** Client-report sections: exact fix, verification method and resolution status (static). */
export function renderReportFixSections(g: FixGuide, t: TrackingInput | null, n: { fix: number; verify: number }): string {
  copyId = 0;
  const latestDone = [...(t?.rechecks ?? [])].reverse().find((rc) => rc.state === 'complete' && rc.result);
  const resolved = latestDone?.result?.status === 'resolved' ? latestDone : null;
  const status = t?.reportStatus ?? 'Open';
  let statusBlock: string;
  if (resolved) {
    statusBlock = `<p><span class="pill ok">✓ Resolved</span> Verified by re-check #${resolved.seq} on ${esc(resolved.completedAt?.slice(0, 10) ?? '')}.</p>
      <div class="flow">BEFORE</div>${comparisonTable(t!.result.baseline, resolved.result!.measurements, ['BEFORE', 'AFTER'])}
      <div class="flow">↓<br>FIX APPLIED BY USER<br>↓</div><div class="flow">AFTER — fresh evidence from re-check #${resolved.seq}</div>
      <p class="callout info">The fix was applied by the site owner or their developer. This investigator is read-only: it did not change the website, it only verified the result.</p>`;
  } else if (latestDone?.result) {
    const r = latestDone.result;
    const txt = STATUS_TEXT[r.status];
    statusBlock = `<p><span class="pill ${REPORT_STATUS_CLS[status]}">${esc(status)}</span> Latest re-check #${latestDone.seq} (${esc(latestDone.completedAt?.slice(0, 10) ?? '')}): ${esc(txt.badge)} — ${esc(txt.message)}</p>
      ${comparisonTable(t!.result.baseline, r.measurements, ['BEFORE', 'CURRENT'])}
      ${r.reasons.length ? `<ul>${r.reasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}`;
  } else {
    statusBlock = `<p><span class="pill ${REPORT_STATUS_CLS[status]}">${esc(status)}</span> Fix instructions provided. The issue has not been verified as resolved — no re-check has confirmed it yet.</p>`;
  }
  return `<div class="wii-fix">
  <h2 class="sec">${n.fix}. Exact Fix Instructions</h2>
  ${g.detected.length ? `<p class="why">Environment detected from public signals: ${esc(g.detected.join(' · '))}</p>` : ''}
  <div class="method">Recommended Fix Method: <strong>[${esc(g.method.label)}]</strong><p class="why">${esc(g.method.reason)}</p></div>
  <dl class="grid">
    <div><dt>Issue confidence</dt><dd>${esc(g.confidence.issue)}</dd></div>
    <div><dt>Fix confidence</dt><dd>${esc(g.confidence.fix)}</dd></div>
    <div><dt>Root cause</dt><dd>${esc(g.rootCause.rootCause)}</dd></div>
    <div><dt>Fix location</dt><dd>${esc(g.rootCause.fixLocation)}</dd></div>
  </dl>
  <p class="why">${esc(g.confidence.reason)}</p>
  ${effortHtml(g)}
  ${instructionsHtml(g, {})}
  ${g.code.length ? `<h3>Code</h3>${codeHtml(g, {})}` : ''}
  ${g.beforeAfter.length ? `<h3>Before / After</h3>${beforeAfterHtml(g)}` : ''}
  <h2 class="sec">${n.verify}. Verification Method &amp; Resolution Status</h2>
  <p>The issue is verified by re-testing only:</p>
  <ol class="fsteps">${g.verification.map((v) => `<li>${esc(v)}</li>`).join('')}</ol>
  ${statusBlock}
  ${t?.rechecks.length ? `<h3>Re-check history</h3>${historyHtml(t)}` : ''}
</div>`;
}
