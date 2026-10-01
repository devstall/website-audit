import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildFixGuide } from '../src/fix/knowledge.js';
import { renderFixPanel, renderReportFixSections, renderTracking } from '../src/fix/render.js';
import { investigate } from '../src/investigate.js';
import { decideStatus, recheckIssue } from '../src/recheck/engine.js';
import type { InvestigationResult, Measurement, RecheckRecord } from '../src/types.js';
import { page, startServer, TEST_POLICY, type FixtureServer, type Route } from './helpers/server.js';

let srv: FixtureServer | null = null;
afterEach(async () => {
  await srv?.close();
  srv = null;
});

const shots = path.join(os.tmpdir(), 'wii-test-shots');
const run = (url: string) => investigate(url, { policy: TEST_POLICY, browser: false, limits: { perHostDelayMs: 0 }, screenshotDir: shots });
const recheck = (r: InvestigationResult) => recheckIssue(r, { policy: TEST_POLICY, browser: false, limits: { perHostDelayMs: 0 }, screenshotDir: shots });

function site(): Record<string, Route> {
  return {
    '/': { body: page({ title: 'Acme — Home', head: '<meta property="og:image" content="/og.jpg">', body: '<header><nav><a href="/services/">Services</a><a href="/old-service/">Old service</a></nav></header><h1>Acme</h1>' }) },
    '/services/': { body: page({ title: 'Services', body: '<h1>Services</h1>' }) },
    '/robots.txt': { headers: { 'content-type': 'text/plain' }, body: 'User-agent: *\nDisallow:\n' },
  };
}

describe('decideStatus', () => {
  const m = (state: Measurement['state']): Measurement => ({ key: 'k', label: 'l', value: 'v', state });
  it('never resolves without fresh evidence', () => {
    expect(decideStatus(false, [], [])).toBe('unable-to-verify');
    expect(decideStatus(false, [m('info')], [])).toBe('unable-to-verify');
    expect(decideStatus(false, [m('ok'), m('unknown')], [])).toBe('unable-to-verify');
    expect(decideStatus(false, [m('ok')], ['homepage down'])).toBe('unable-to-verify');
  });
  it('still detected wins over everything', () => {
    expect(decideStatus(true, [m('ok')], [])).toBe('still-detected');
    expect(decideStatus(false, [m('ok'), m('bad')], ['x'])).toBe('still-detected');
  });
  it('resolves only when every measured item is ok', () => {
    expect(decideStatus(false, [m('ok'), m('info')], [])).toBe('resolved');
  });
});

describe('re-check engine', () => {
  it('broken link: still detected → resolved after the link target is restored, with before/after evidence', async () => {
    const routes = site();
    srv = await startServer(routes);
    const r = await run(`${srv.base}/`);
    expect(r.primary?.id).toBe('broken-internal-links');
    expect(r.primary?.targets).toContain(`${srv.base}/old-service/`);
    expect(r.baseline?.some((b) => b.state === 'bad' && /404/.test(b.value))).toBe(true);

    const hitsBefore = srv.hits.length;
    const still = await recheck(r);
    expect(still.status).toBe('still-detected');
    expect(still.currentEvidence.length).toBeGreaterThan(0);
    // Targeted: far fewer requests than a full investigation.
    expect(srv.hits.length - hitsBefore).toBeLessThan(10);

    routes['/old-service/'] = { body: page({ title: 'Old service', body: '<h1>Back</h1>' }) };
    const fixed = await recheck(r);
    expect(fixed.status).toBe('resolved');
    expect(fixed.measurements.find((x) => x.key.startsWith('link:'))).toMatchObject({ state: 'ok', value: expect.stringContaining('HTTP 200') });
  });

  it('broken link: removing the link (instead of restoring the page) also resolves it', async () => {
    const routes = site();
    srv = await startServer(routes);
    const r = await run(`${srv.base}/`);
    routes['/'] = { body: page({ title: 'Acme — Home', body: '<header><nav><a href="/services/">Services</a></nav></header><h1>Acme</h1>' }) };
    const res = await recheck(r);
    expect(res.status).toBe('resolved');
    expect(res.measurements[0]!.value).toMatch(/no longer linked/);
  });

  it('noindex: resolved once the directive is removed', async () => {
    const noindex = '<meta name="robots" content="noindex">';
    const routes: Record<string, Route> = {
      '/': { body: page({ title: 'Home', head: noindex, body: '<nav><a href="/a/">A</a></nav><h1>x</h1>' }) },
      '/a/': { body: page({ title: 'A', head: noindex }) },
      '/robots.txt': { headers: { 'content-type': 'text/plain' }, body: 'User-agent: *\nDisallow:\n' },
    };
    srv = await startServer(routes);
    const r = await run(`${srv.base}/`);
    expect(r.primary?.id).toBe('noindex-important');
    routes['/'] = { body: page({ title: 'Home', body: '<nav><a href="/a/">A</a></nav><h1>x</h1>' }) };
    routes['/a/'] = { body: page({ title: 'A' }) };
    const res = await recheck(r);
    expect(res.status).toBe('resolved');
    expect(res.checks).toContain('Homepage');
  });

  it('is unable to verify (never "resolved") when the site cannot be reached', async () => {
    const routes = site();
    srv = await startServer(routes);
    const r = await run(`${srv.base}/`);
    routes['/'] = { status: 503, body: 'down' };
    const res = await recheck(r);
    expect(res.status).toBe('unable-to-verify');
    expect(res.reasons.join(' ')).toMatch(/could not be loaded/);
  });

  it('browser-only issues are unable to verify without a browser', async () => {
    const routes = site();
    srv = await startServer(routes);
    const r = await run(`${srv.base}/`);
    const fake: InvestigationResult = { ...r, primary: { ...r.primary!, id: 'mobile-overflow', affectedUrls: [`${srv.base}/`] } };
    const res = await recheck(fake);
    expect(res.status).toBe('unable-to-verify');
    expect(res.reasons.join(' ')).toMatch(/browser/i);
  });
});

describe('fix assistant', () => {
  function wpResult(plugins: string[], theme: { isChild: boolean } | null = null): InvestigationResult {
    return {
      inputUrl: 'https://example.com/',
      siteUrl: 'https://example.com/',
      date: '2026-09-30',
      stats: { pagesAnalyzed: 1, requestsMade: 1, browserRequests: 0, desktopTested: false, mobileTested: false, robotsTested: true, sitemapTested: true, browserTest: false, durationMs: 1 },
      wordpress: {
        detected: true,
        signals: [],
        version: '6.6',
        versionSource: 'generator',
        theme: theme ? { slug: 'astra-child', name: 'Astra Child', version: null, isChild: theme.isChild, parent: theme.isChild ? 'astra' : null } : null,
        plugins: plugins.map((slug) => ({ slug, versions: [], evidence: `/wp-content/plugins/${slug}/x.js` })),
        restApi: { available: true, status: 200, userEnumeration: { exposed: false, count: 0 } },
        xmlrpc: { status: null, enabled: false },
      },
      primary: {
        id: 'canonical-http',
        title: '3 HTTPS pages declare an HTTP canonical URL',
        category: 'Canonicalization',
        severity: 'Medium',
        confidence: 'High',
        evidenceStrength: 1,
        scope: 1,
        actionability: 1,
        summary: 'Pages served over HTTPS name the insecure http:// version as canonical.',
        howIdentified: '',
        evidence: [
          { label: 'Page', value: 'https://example.com/' },
          { label: 'Canonical', value: 'http://example.com/', code: true },
        ],
        affectedUrls: ['https://example.com/'],
        whyItMatters: '',
        solution: [],
        effort: { investigation: '', implementation: '', testing: '', total: '' },
        verification: [],
      },
      candidates: [],
      pages: [],
      browser: { available: false, consoleErrors: [], pageErrors: [], failedRequests: [], largeImages: [], mixedContent: [], thirdPartyDomains: [], blockedBySsrf: [] },
      homepageHeaders: { server: 'Apache' },
      homepageChain: [],
      notes: [],
      baseline: [{ key: 'canonical:https://example.com/', label: 'Canonical — https://example.com/', value: 'http://example.com/', state: 'bad' }],
    };
  }

  it('shows Yoast menu paths only when Yoast is detected', () => {
    const withYoast = buildFixGuide(wpResult(['wordpress-seo']))!;
    expect(withYoast.instructions.some((i) => i.platform === 'Yoast SEO')).toBe(true);
    expect(withYoast.detected).toContain('Yoast SEO');
    const without = buildFixGuide(wpResult([]))!;
    expect(JSON.stringify(without.instructions)).not.toMatch(/Yoast|Rank Math|All in One SEO/);
  });

  it('separates issue confidence from fix confidence and gives root-cause levels', () => {
    const g = buildFixGuide(wpResult([]))!;
    expect(g.confidence.issue).toBe('High');
    expect(g.confidence.fix).toBe('Medium');
    expect(g.confidence.reason).toMatch(/without backend access/);
    expect(g.rootCause.issue).toBe('Confirmed');
    expect(['Likely', 'Possible']).toContain(g.rootCause.rootCause);
    expect(g.method.label).toBe('WordPress Admin');
  });

  it('shows the real canonical as a before/after example', () => {
    const g = buildFixGuide(wpResult([]))!;
    expect(g.beforeAfter[0]).toMatchObject({ before: expect.stringContaining('http://example.com/'), after: expect.stringContaining('https://example.com/') });
  });

  it('never recommends editing a parent theme', () => {
    const r = wpResult([], { isChild: false });
    r.primary!.id = 'no-lang';
    const g = buildFixGuide(r)!;
    const text = JSON.stringify(g.code) + JSON.stringify(g.instructions);
    expect(text).toMatch(/Create a child theme/);
    expect(text).toMatch(/Do NOT edit/);
    expect(text).not.toMatch(/themes\/astra-child\/header\.php/);
  });

  it('never says "Fixed"; only "Resolved" after a verified re-check', () => {
    const r = wpResult([]);
    const g = buildFixGuide(r)!;
    const panel = renderFixPanel(g, { interactive: true });
    expect(panel).not.toMatch(/\bFixed\b/);
    const open = renderReportFixSections(g, { investigationId: 'x', result: r, reportStatus: 'Open', rechecks: [], fixLog: [{ at: 'now', method: 'WordPress Admin' }] }, { fix: 7, verify: 9 });
    expect(open).toMatch(/Fix instructions provided/);
    expect(open).not.toMatch(/Resolved/);
    const resolved: RecheckRecord = {
      id: 'r1',
      investigationId: 'x',
      seq: 1,
      issueId: 'canonical-http',
      state: 'complete',
      createdAt: '2026-09-30T10:00:00Z',
      completedAt: '2026-09-30T10:00:05Z',
      error: null,
      fixShown: null,
      result: { issueId: 'canonical-http', status: 'resolved', checks: [], measurements: [{ key: 'canonical:https://example.com/', label: 'Canonical — https://example.com/', value: 'https://example.com/', state: 'ok' }], currentEvidence: [], reasons: [], requestsMade: 3, browserUsed: false, durationMs: 100 },
    };
    const t = { investigationId: 'x', result: r, reportStatus: 'Resolved' as const, rechecks: [resolved], fixLog: [] };
    const html = renderReportFixSections(g, t, { fix: 7, verify: 9 });
    expect(html).toMatch(/FIX APPLIED BY USER/);
    expect(html).toMatch(/did not change the website/);
    expect(html).toContain('http://example.com/');
    expect(renderTracking(t)).toMatch(/ISSUE RESOLVED/);
  });

  it('escapes target-site values in the fix panel', () => {
    const r = wpResult([]);
    r.primary!.evidence[1]!.value = 'http://example.com/"><script>alert(1)</script>';
    const html = renderFixPanel(buildFixGuide(r)!, { interactive: true });
    expect(html).not.toContain('<script>alert(1)</script>');
  });
});
