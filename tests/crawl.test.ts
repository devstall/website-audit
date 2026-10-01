import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crawlSite } from '../src/crawl/crawler.js';
import { parseRobots } from '../src/crawl/robots.js';
import { SafeFetcher } from '../src/net/fetcher.js';
import { page, startServer, TEST_POLICY, type FixtureServer, type Route } from './helpers/server.js';

let srv: FixtureServer;

/** 40 pages in a chain /p1 → /p2 → … so depth grows with each hop, plus traps that must never be requested. */
function buildSite(): Record<string, Route> {
  const routes: Record<string, Route> = {
    '/': {
      body: page({
        title: 'Home',
        body: `<header><nav><a href="/p1">P1</a><a href="/about/?utm_source=nav&utm_medium=x">About</a><a href="/cart/">Cart</a><a href="/wp-login.php">Login</a></nav></header>
        <a href="/about/">About again</a><a href="/about/#team">About team</a><a href="/private/secret">Private</a><a href="/?s=query">Search</a>
        <a href="mailto:x@y.z">Mail</a><a href="https://other.example/">External</a>`,
      }),
    },
    '/about/': { body: page({ title: 'About' }) },
    '/robots.txt': { headers: { 'content-type': 'text/plain' }, body: 'User-agent: *\nDisallow: /private/\n' },
  };
  for (let i = 1; i <= 40; i++) {
    routes[`/p${i}`] = { body: page({ title: `Page ${i}`, body: `<h1>P${i}</h1><a href="/p${i + 1}">next</a>` }) };
  }
  return routes;
}

beforeAll(async () => {
  srv = await startServer(buildSite());
});
afterAll(() => srv.close());

async function crawl(limits: { maxPages: number; maxDepth: number; maxRequests: number }) {
  const fetcher = new SafeFetcher({ perHostDelayMs: 0, maxRequests: limits.maxRequests }, TEST_POLICY);
  const homepage = await fetcher.fetch(`${srv.base}/`);
  const robots = parseRobots('User-agent: *\nDisallow: /private/\n');
  const out = await crawlSite({ fetcher, homepage, robots, sitemapUrls: [], maxPages: limits.maxPages, maxDepth: limits.maxDepth, reserveRequests: 0 });
  await fetcher.close();
  return { out, fetcher };
}

describe('crawl limits', () => {
  it('never exceeds maxPages', async () => {
    const { out } = await crawl({ maxPages: 5, maxDepth: 10, maxRequests: 100 });
    expect(out.pages.length).toBeLessThanOrEqual(5);
  });

  it('never exceeds maxDepth', async () => {
    const { out } = await crawl({ maxPages: 50, maxDepth: 3, maxRequests: 100 });
    expect(Math.max(...out.pages.map((p) => p.depth))).toBeLessThanOrEqual(3);
    expect(out.pages.some((p) => p.url.endsWith('/p4'))).toBe(false);
  });

  it('never exceeds the request budget', async () => {
    const { out, fetcher } = await crawl({ maxPages: 50, maxDepth: 50, maxRequests: 8 });
    expect(fetcher.requestsMade).toBeLessThanOrEqual(8);
    expect(out.pages.length).toBeLessThanOrEqual(8);
  });

  it('respects robots.txt and never requests excluded URLs', async () => {
    srv.hits.length = 0;
    const { out } = await crawl({ maxPages: 20, maxDepth: 3, maxRequests: 100 });
    expect(srv.hits.some((h) => h.startsWith('/private'))).toBe(false);
    expect(srv.hits.some((h) => h.startsWith('/cart'))).toBe(false);
    expect(srv.hits.some((h) => h.startsWith('/wp-login'))).toBe(false);
    expect(srv.hits.some((h) => h.includes('s=query'))).toBe(false);
    expect(out.robotsBlocked.some((u) => u.includes('/private/'))).toBe(true);
  });

  it('de-duplicates tracking-parameter and fragment variants', async () => {
    srv.hits.length = 0;
    await crawl({ maxPages: 20, maxDepth: 3, maxRequests: 100 });
    expect(srv.hits.filter((h) => h.startsWith('/about/'))).toEqual(['/about/']);
  });

  it('records link sources for every internal target', async () => {
    const { out } = await crawl({ maxPages: 3, maxDepth: 3, maxRequests: 100 });
    const about = [...out.linkSources.entries()].find(([k]) => k.endsWith('/about/'));
    expect(about?.[1][0]?.source).toBe(`${srv.base}/`);
  });
});
