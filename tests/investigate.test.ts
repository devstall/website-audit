import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { investigate } from '../src/investigate.js';
import { page, startServer, TEST_POLICY, type FixtureServer, type Route } from './helpers/server.js';

let srv: FixtureServer | null = null;
afterEach(async () => {
  await srv?.close();
  srv = null;
});

const run = (url: string) =>
  investigate(url, {
    policy: TEST_POLICY,
    browser: false,
    limits: { perHostDelayMs: 0 },
    screenshotDir: path.join(os.tmpdir(), 'wii-test-shots'),
  });

const healthy = (extra: Record<string, Route> = {}): Record<string, Route> => ({
  '/': {
    body: page({
      title: 'Acme Plumbing — Home',
      head: '<meta name="description" content="Plumbing"><meta property="og:image" content="/og.jpg">',
      body: '<header><nav><a href="/services/">Services</a><a href="/about/">About</a><a href="/contact/">Contact</a></nav></header><h1>Acme</h1>',
    }),
  },
  '/services/': { body: page({ title: 'Services', body: '<h1>Services</h1><a href="/about/">About</a>' }) },
  '/about/': { body: page({ title: 'About', body: '<h1>About</h1>' }) },
  '/contact/': { body: page({ title: 'Contact', body: '<h1>Contact</h1>' }) },
  '/robots.txt': { headers: { 'content-type': 'text/plain' }, body: 'User-agent: *\nDisallow:\n' },
  ...extra,
});

describe('end-to-end detection (browser disabled)', () => {
  it('reports a broken navigation link as the primary issue, with source-page evidence', async () => {
    const routes = healthy();
    routes['/'] = {
      body: page({
        title: 'Acme Plumbing — Home',
        body: '<header><nav><a href="/services/">Services</a><a href="/old-service/">Old service</a></nav></header><h1>Acme</h1>',
      }),
    };
    srv = await startServer(routes);
    const r = await run(`${srv.base}/`);
    expect(r.primary?.id).toBe('broken-internal-links');
    expect(r.primary?.severity).toBe('High');
    expect(r.primary?.confidence).toBe('High');
    const ev = r.primary!.evidence.map((e) => `${e.label}: ${e.value}`).join('\n');
    expect(ev).toContain(`${srv.base}/old-service/`);
    expect(ev).toContain('Status: 404');
    expect(ev).toContain(`${srv.base}/`);
    expect(r.stats.requestsMade).toBeLessThanOrEqual(100);
  });

  it('reports a sitewide noindex', async () => {
    const noindex = '<meta name="robots" content="noindex, nofollow">';
    const routes = healthy();
    for (const k of ['/', '/services/', '/about/', '/contact/']) {
      const body = routes[k]!.body as string;
      routes[k] = { body: body.replace('</head>', `${noindex}</head>`) };
    }
    srv = await startServer(routes);
    const r = await run(`${srv.base}/`);
    expect(r.primary?.id).toBe('noindex-important');
    expect(r.primary?.title).toMatch(/noindex/);
  });

  it('reports robots.txt blocking the whole site', async () => {
    srv = await startServer(healthy({ '/robots.txt': { headers: { 'content-type': 'text/plain' }, body: 'User-agent: *\nDisallow: /\n' } }));
    const r = await run(`${srv.base}/`);
    expect(r.primary?.id).toBe('robots-blocks-important');
    expect(r.primary?.evidence.some((e) => e.value.includes('Disallow: /'))).toBe(true);
    expect(r.stats.pagesAnalyzed).toBe(1); // the crawler itself obeyed the rule
  });

  it('does not flag a deliberately blocked low-value page (e.g. /contact)', async () => {
    srv = await startServer(healthy({ '/robots.txt': { headers: { 'content-type': 'text/plain' }, body: 'User-agent: *\nDisallow: /contact\n' } }));
    const r = await run(`${srv.base}/`);
    expect(r.candidates.some((c) => c.id === 'robots-blocks-important')).toBe(false);
  });

  it('downgrades a single explicitly named blocked page to Medium/Medium', async () => {
    srv = await startServer(healthy({ '/robots.txt': { headers: { 'content-type': 'text/plain' }, body: 'User-agent: *\nDisallow: /services/\n' } }));
    const r = await run(`${srv.base}/`);
    const c = r.candidates.find((x) => x.id === 'robots-blocks-important');
    expect(c).toMatchObject({ severity: 'Medium', confidence: 'Medium' });
  });

  it('keeps High severity when several navigation pages are blocked', async () => {
    srv = await startServer(healthy({ '/robots.txt': { headers: { 'content-type': 'text/plain' }, body: 'User-agent: *\nDisallow: /services/\nDisallow: /about/\n' } }));
    const r = await run(`${srv.base}/`);
    expect(r.primary).toMatchObject({ id: 'robots-blocks-important', severity: 'High', confidence: 'High' });
  });

  it('reports a soft 404 when unknown URLs return 200', async () => {
    srv = await startServer(healthy());
    // Replace the fixture's 404 handler: every unknown path returns 200.
    const routes = healthy();
    await srv.close();
    const http = await import('node:http');
    const server = http.createServer((req, res) => {
      const r = routes[req.url ?? '/'];
      res.writeHead(200, { 'content-type': r && req.url === '/robots.txt' ? 'text/plain' : 'text/html' });
      res.end((r?.body as string) ?? page({ title: 'Oops', body: '<h1>Page not found</h1>' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    srv = { base: `http://127.0.0.1:${port}`, hits: [], close: () => new Promise((res) => server.close(() => res())) };
    const r = await run(`${srv.base}/`);
    expect(r.candidates.some((c) => c.id === 'soft-404')).toBe(true);
  });

  it('never promotes a low-confidence finding: healthy site → no primary issue or only a verified one', async () => {
    srv = await startServer(healthy());
    const r = await run(`${srv.base}/`);
    if (r.primary) expect(r.primary.confidence).not.toBe('Low');
    expect(r.stats.pagesAnalyzed).toBe(4);
  });

  it('reports an unreachable homepage (HTTP 500) after re-checking', async () => {
    srv = await startServer({ '/': { status: 500, body: 'Fatal error' } });
    const r = await run(`${srv.base}/`);
    expect(r.primary?.id).toBe('homepage-error');
    expect(srv.hits.filter((h) => h === '/').length).toBe(2);
  });
});
