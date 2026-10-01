/**
 * Command-line investigation (no server/database):
 *   npm run investigate -- https://example.com [--no-browser] [--out ./reports]
 *   npm run investigate -- --recheck data/cli/<report>.json [--no-browser]   (re-tests only the primary issue)
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { investigate } from './investigate.js';
import { recheckIssue } from './recheck/engine.js';
import { loadBranding } from './branding.js';
import { DATA_DIR } from './config.js';
import { renderClientReport } from './report/client.js';
import { renderReportDocument } from './report/render.js';
import type { InvestigationResult } from './types.js';

const args = process.argv.slice(2);
const recheckIdx = args.indexOf('--recheck');
if (recheckIdx >= 0) {
  const file = args[recheckIdx + 1];
  if (!file) {
    console.error('Usage: npm run investigate -- --recheck <investigation.json> [--no-browser]');
    process.exit(2);
  }
  const original = JSON.parse(await fs.readFile(file, 'utf8')) as InvestigationResult;
  if (!original.primary) {
    console.log('That investigation has no primary issue to re-check.');
    process.exit(0);
  }
  console.log(`Re-checking: ${original.primary.title}`);
  const r = await recheckIssue(original, { browser: !args.includes('--no-browser'), screenshotDir: path.join(path.dirname(file), 'recheck-shots') });
  const label = { resolved: '✓ ISSUE RESOLVED', 'still-detected': '⚠ STILL DETECTED', 'unable-to-verify': '? UNABLE TO VERIFY' }[r.status];
  console.log(`Checked: ${r.checks.join(' · ')}`);
  const before = new Map((original.baseline ?? []).map((m) => [m.key, m.value]));
  for (const m of r.measurements) console.log(`  ${m.label}
    BEFORE: ${before.get(m.key) ?? '(not measured)'}
    NOW:    ${m.value}  [${m.state}]`);
  for (const reason of r.reasons) console.log(`  note: ${reason}`);
  console.log(`
RESULT: ${label}  (${r.requestsMade} requests${r.browserUsed ? ' + browser' : ''}, ${Math.round(r.durationMs / 1000)} s)`);
  process.exit(0);
}
const url = args.find((a) => !a.startsWith('--'));
if (!url) {
  console.error('Usage: npm run investigate -- <url> [--no-browser] [--out <dir>]');
  process.exit(2);
}
const outIdx = args.indexOf('--out');
const outDir = path.resolve(outIdx >= 0 && args[outIdx + 1] ? args[outIdx + 1]! : 'data/cli');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const shotDir = path.join(outDir, `screenshots-${stamp}`);

const result = await investigate(url, {
  browser: !args.includes('--no-browser'),
  focus: args.includes('--ecommerce') ? 'ecommerce' : args.includes('--security') ? 'security' : 'full',
  screenshotDir: shotDir,
  onProgress: (step, state, detail) => {
    if (state !== 'running') console.log(`${state === 'done' ? '✓' : state === 'skipped' ? '–' : '✗'} ${step}${detail ? ` — ${detail}` : ''}`);
  },
});

const images = new Map<string, string>();
for (const f of await fs.readdir(shotDir).catch(() => [] as string[])) {
  images.set(f, `data:image/jpeg;base64,${(await fs.readFile(path.join(shotDir, f))).toString('base64')}`);
}
await fs.mkdir(outDir, { recursive: true });
const host = new URL(result.siteUrl).hostname;
const htmlFile = path.join(outDir, `${host}-${stamp}.html`);
await fs.writeFile(htmlFile, renderReportDocument(result, { imageSrc: (f) => images.get(f) ?? null }));
const clientFile = htmlFile.replace(/\.html$/, '-client.html');
await fs.writeFile(clientFile, renderClientReport(result, { imageSrc: (f) => images.get(f) ?? null, branding: loadBranding(DATA_DIR), clientName: null }));
await fs.writeFile(path.join(outDir, `${host}-${stamp}.json`), JSON.stringify(result, null, 2));

console.log('\n==================================================');
console.log(`Website:   ${result.siteUrl}`);
console.log(`WordPress: ${result.wordpress.detected ? 'Yes' : 'No'}`);
console.log(`Pages: ${result.stats.pagesAnalyzed}  Requests: ${result.stats.requestsMade}  Browser: ${result.stats.browserTest ? 'Yes' : 'No'}  (${Math.round(result.stats.durationMs / 1000)} s)`);
if (result.primary) {
  console.log(`\nPRIMARY ISSUE: ${result.primary.title}`);
  console.log(`Severity: ${result.primary.severity}  Confidence: ${result.primary.confidence}  Category: ${result.primary.category}`);
} else {
  console.log('\nNo significant verified issue found.');
}
console.log(`\nALL FINDINGS (${result.candidates.length}):`);
for (const [i, c] of result.candidates.entries()) {
  console.log(`  ${String(i + 1).padStart(2)}. [${c.severity} / ${c.confidence} confidence] ${c.title}${c.id === result.primary?.id ? '  ← primary' : ''}`);
}
console.log(`Report: ${htmlFile}`);
