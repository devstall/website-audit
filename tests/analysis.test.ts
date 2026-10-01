import { describe, expect, it } from 'vitest';
import { analyzeHtml, hasDirective, xRobotsNoindex } from '../src/analyze/html.js';
import { isEligible, rankCandidates, selectPrimary } from '../src/detect/rank.js';
import { candidate, EFFORT } from '../src/detect/helpers.js';
import { renderReportBody } from '../src/report/render.js';
import type { Candidate, FetchResult, InvestigationResult } from '../src/types.js';

const res = (body: string, url = 'https://example.com/'): FetchResult => ({
  requestedUrl: url, finalUrl: url, status: 200, ok: true, chain: [{ url, status: 200 }], headers: { 'content-type': 'text/html' },
  body, bodyBytes: body.length, transferBytes: body.length, truncated: false, ttfbMs: 10, totalMs: 12,
});

describe('HTML analysis', () => {
  const html = `<!doctype html><html lang="en"><head><title> Hello  World </title>
    <link rel="canonical" href="/canonical/"><meta name="ROBOTS" content="noindex,follow">
    <script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Organization"},{"@type":"WebSite"}]}</script>
    <script type="application/ld+json">{"@type": "Product",}</script>
    <script src="http://example.com/insecure.js"></script></head>
    <body><nav><a href="/services/">Services</a></nav><a href="https://www.example.com/about">About</a><a href="https://other.com/">x</a>
    <img src="/a.jpg"><img src="/b.jpg" alt=""><h1>One</h1><h1>Two</h1></body></html>`;
  const f = analyzeHtml(res(html), 0);

  it('extracts core fields', () => {
    expect(f.title).toBe('Hello World');
    expect(f.canonical).toBe('https://example.com/canonical/');
    expect(f.lang).toBe('en');
    expect(f.h1).toEqual(['One', 'Two']);
    expect(hasDirective(f.metaRobots, 'noindex')).toBe(true);
  });
  it('classifies links', () => {
    expect(f.internalLinks.map((l) => l.url)).toEqual(['https://example.com/services/', 'https://www.example.com/about']);
    expect(f.internalLinks[0]?.inNav).toBe(true);
    expect(f.externalLinkCount).toBe(1);
  });
  it('validates JSON-LD and collects @graph types', () => {
    expect(f.jsonLd[0]).toMatchObject({ valid: true, types: ['Organization', 'WebSite'] });
    expect(f.jsonLd[1]?.valid).toBe(false);
  });
  it('finds mixed content and missing alt (empty alt is fine)', () => {
    expect(f.mixedContent).toEqual([{ tag: 'script', url: 'http://example.com/insecure.js' }]);
    expect(f.images.filter((i) => i.alt === null)).toHaveLength(1);
  });
});

describe('robots directives', () => {
  it('parses meta robots and X-Robots-Tag', () => {
    expect(hasDirective('none', 'noindex')).toBe(true);
    expect(hasDirective('index, follow', 'noindex')).toBe(false);
    expect(xRobotsNoindex('noindex')).toBe(true);
    expect(xRobotsNoindex('googlebot: noindex')).toBe(true);
    expect(xRobotsNoindex('otherbot: noindex')).toBe(false);
    expect(xRobotsNoindex('noarchive')).toBe(false);
  });
});

const mk = (id: string, over: Partial<Candidate>): Candidate =>
  candidate({
    id, title: id, category: 'Indexing', severity: 'Medium', confidence: 'High', summary: '', howIdentified: '',
    evidence: [{ label: 'x', value: 'y' }], affectedUrls: [], whyItMatters: '', solution: [], effort: EFFORT.quick, ...over,
  });

describe('ranking and false-positive protection', () => {
  it('prefers high severity + high confidence', () => {
    const top = selectPrimary([mk('a', { severity: 'Low' }), mk('b', { severity: 'High' }), mk('c', { severity: 'Medium' })]);
    expect(top?.id).toBe('b');
  });
  it('confidence outweighs raw severity when evidence is weak', () => {
    const top = selectPrimary([mk('weak', { severity: 'High', confidence: 'Medium', evidenceStrength: 0.5 }), mk('solid', { severity: 'High', confidence: 'High' })]);
    expect(top?.id).toBe('solid');
  });
  it('never selects a low-confidence candidate', () => {
    expect(isEligible(mk('x', { confidence: 'Low', severity: 'High' }))).toBe(false);
    expect(selectPrimary([mk('x', { confidence: 'Low', severity: 'High' })])).toBeNull();
  });
  it('requires evidence', () => {
    expect(isEligible(mk('x', { evidence: [] }))).toBe(false);
  });
  it('de-duplicates by id', () => {
    expect(rankCandidates([mk('a', {}), mk('a', { severity: 'High' })])).toHaveLength(1);
  });
});

describe('report rendering', () => {
  it('escapes hostile content from the target site', () => {
    const c = mk('xss', { title: '<script>alert(1)</script>', evidence: [{ label: '<img src=x onerror=alert(1)>', value: '"><svg onload=alert(1)>', code: true }] });
    const r = {
      inputUrl: 'https://example.com/', siteUrl: 'https://example.com/', date: '2026-01-01',
      stats: { pagesAnalyzed: 1, requestsMade: 1, browserRequests: 0, desktopTested: false, mobileTested: false, robotsTested: true, sitemapTested: true, browserTest: false, durationMs: 1 },
      wordpress: { detected: false, signals: [], version: null, versionSource: null, theme: null, plugins: [], restApi: { available: false, status: null, userEnumeration: { exposed: false, count: 0 } }, xmlrpc: { status: null, enabled: false } },
      primary: c, candidates: [c], pages: [{ url: 'x', finalUrl: 'javascript:alert(1)', status: 200, title: '<b>t</b>', ttfbMs: 1, htmlBytes: 1 }],
      browser: { available: false, consoleErrors: [], pageErrors: [], failedRequests: [], largeImages: [], mixedContent: [], thirdPartyDomains: [], blockedBySsrf: [] },
      homepageHeaders: {}, homepageChain: [], notes: [],
    } satisfies InvestigationResult;
    const html = renderReportBody(r, { imageSrc: () => null });
    expect(html).not.toMatch(/<script>alert/);
    expect(html).not.toMatch(/<img src=x/);
    expect(html).not.toMatch(/<svg onload/);
    expect(html).not.toMatch(/href="javascript:/);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('lists every finding, marks the primary, and separates unverified signals', () => {
    const primary = mk('p', { title: 'Primary thing', severity: 'High' });
    const second = mk('s', { title: 'Second <b>thing</b>', severity: 'Medium' });
    const weak = mk('w', { title: 'Weak signal', confidence: 'Low' });
    const r = {
      inputUrl: 'https://example.com/', siteUrl: 'https://example.com/', date: '2026-01-01',
      stats: { pagesAnalyzed: 1, requestsMade: 1, browserRequests: 0, desktopTested: false, mobileTested: false, robotsTested: true, sitemapTested: true, browserTest: false, durationMs: 1 },
      wordpress: { detected: false, signals: [], version: null, versionSource: null, theme: null, plugins: [], restApi: { available: false, status: null, userEnumeration: { exposed: false, count: 0 } }, xmlrpc: { status: null, enabled: false } },
      primary, candidates: [primary, second, weak], pages: [],
      browser: { available: false, consoleErrors: [], pageErrors: [], failedRequests: [], largeImages: [], mixedContent: [], thirdPartyDomains: [], blockedBySsrf: [] },
      homepageHeaders: {}, homepageChain: [], notes: [],
    } satisfies InvestigationResult;
    const html = renderReportBody(r, { imageSrc: () => null });
    expect(html).toContain('All Findings (3)');
    expect(html).toContain('2 verified (1 High, 1 Medium) · 1 unverified');
    expect(html).toContain('Second &lt;b&gt;thing&lt;/b&gt;');
    expect(html.indexOf('Weak signal')).toBeGreaterThan(html.indexOf('Unverified signals'));
    expect(html).toContain('primary-tag');
    expect(html).not.toMatch(/<details class="finding" open>/);
    expect(renderReportBody(r, { imageSrc: () => null, expandFindings: true })).toMatch(/<details class="finding" open>/);
  });
});
