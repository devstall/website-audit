import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RequestBudgetExceeded, SafeFetcher } from '../src/net/fetcher.js';
import { page, startServer, TEST_POLICY, type FixtureServer } from './helpers/server.js';

let srv: FixtureServer;

beforeAll(async () => {
  srv = await startServer({
    '/a': { status: 301, headers: { location: '/b' } },
    '/b': { status: 302, headers: { location: '/c' } },
    '/c': (base) => ({ status: 307, headers: { location: `${base}/final` } }),
    '/final': { body: page({ title: 'Final' }) },
    '/loop1': { status: 301, headers: { location: '/loop2' } },
    '/loop2': { status: 301, headers: { location: '/loop1' } },
    '/bad-location': { status: 301, headers: { location: 'http://[bad' } },
    '/big': { body: 'x'.repeat(50_000) },
    '/500': { status: 500, body: 'error' },
  });
});
afterAll(() => srv.close());

const make = (limits = {}) => new SafeFetcher({ perHostDelayMs: 0, ...limits }, TEST_POLICY);

describe('redirect handling', () => {
  it('follows and records every hop of a redirect chain', async () => {
    const f = make();
    const r = await f.fetch(`${srv.base}/a`);
    expect(r.status).toBe(200);
    expect(r.finalUrl).toBe(`${srv.base}/final`);
    expect(r.chain.map((h) => h.status)).toEqual([301, 302, 307, 200]);
    expect(f.requestsMade).toBe(4);
    await f.close();
  });

  it('detects redirect loops', async () => {
    const f = make();
    const r = await f.fetch(`${srv.base}/loop1`);
    expect(r.loop).toBe(true);
    expect(r.error).toMatch(/loop/i);
    expect(r.chain.map((h) => h.status)).toEqual([301, 301]);
    await f.close();
  });

  it('stops after maxRedirects', async () => {
    const f = make({ maxRedirects: 2 });
    const r = await f.fetch(`${srv.base}/a`);
    expect(r.status).toBe(0);
    expect(r.error).toMatch(/More than 2 redirects/);
    await f.close();
  });

  it('can be told not to follow redirects', async () => {
    const f = make();
    const r = await f.fetch(`${srv.base}/a`, { followRedirects: false });
    expect(r.status).toBe(301);
    expect(r.chain).toHaveLength(1);
    await f.close();
  });

  it('handles an invalid Location header', async () => {
    const f = make();
    const r = await f.fetch(`${srv.base}/bad-location`);
    expect(r.status).toBe(0);
    expect(r.error).toBeTruthy();
    await f.close();
  });
});

describe('limits', () => {
  it('enforces the request budget', async () => {
    const f = make({ maxRequests: 3 });
    await f.fetch(`${srv.base}/final`);
    await f.fetch(`${srv.base}/final`);
    await f.fetch(`${srv.base}/final`);
    await expect(f.fetch(`${srv.base}/final`)).rejects.toBeInstanceOf(RequestBudgetExceeded);
    expect(f.requestsMade).toBe(3);
    await f.close();
  });

  it('counts redirect hops against the budget', async () => {
    const f = make({ maxRequests: 2 });
    await expect(f.fetch(`${srv.base}/a`)).rejects.toBeInstanceOf(RequestBudgetExceeded);
    await f.close();
  });

  it('truncates large bodies', async () => {
    const f = make();
    const r = await f.fetch(`${srv.base}/big`, { maxBytes: 1000 });
    expect(r.body.length).toBe(1000);
    expect(r.truncated).toBe(true);
    await f.close();
  });

  it('paces requests to the same host', async () => {
    const f = make({ perHostDelayMs: 150 });
    const t = Date.now();
    await Promise.all([f.fetch(`${srv.base}/final`), f.fetch(`${srv.base}/final`), f.fetch(`${srv.base}/final`)]);
    expect(Date.now() - t).toBeGreaterThanOrEqual(290);
    await f.close();
  });

  it('reports server errors without throwing', async () => {
    const f = make();
    const r = await f.fetch(`${srv.base}/500`);
    expect(r.status).toBe(500);
    expect(r.ok).toBe(false);
    await f.close();
  });
});
