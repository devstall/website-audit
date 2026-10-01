import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/server.js';

const closers: (() => void)[] = [];
afterEach(() => {
  while (closers.length) closers.pop()!();
});

async function boot(apiKey = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wii-api-'));
  const { app, store } = await createApp(dir, { apiKey });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  closers.push(() => server.close());
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, store };
}

const completeRecord = (id: string) => ({
  id,
  inputUrl: 'https://example.com/',
  status: 'complete' as const,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  steps: [],
  result: {
    inputUrl: 'https://example.com/',
    siteUrl: 'https://example.com/',
    date: '2026-09-30',
    stats: { pagesAnalyzed: 1, requestsMade: 1, browserRequests: 0, desktopTested: false, mobileTested: false, robotsTested: true, sitemapTested: true, browserTest: false, durationMs: 1 },
    wordpress: { detected: false, signals: [], version: null, versionSource: null, theme: null, plugins: [], restApi: { available: false, status: null, userEnumeration: { exposed: false, count: 0 } }, xmlrpc: { status: null, enabled: false } },
    primary: {
      id: 'no-lang',
      title: 'Homepage <html> element has no lang attribute',
      category: 'Accessibility' as const,
      severity: 'Low' as const,
      confidence: 'High' as const,
      evidenceStrength: 1,
      scope: 0.5,
      actionability: 0.9,
      summary: 's',
      howIdentified: 'h',
      evidence: [{ label: 'HTML', value: '<html> without lang=""' }],
      affectedUrls: ['https://example.com/'],
      whyItMatters: 'w',
      solution: ['x'],
      effort: { investigation: 'a', implementation: 'b', testing: 'c', total: 'd' },
      verification: [],
    },
    candidates: [],
    pages: [],
    browser: { available: false, consoleErrors: [], pageErrors: [], failedRequests: [], largeImages: [], mixedContent: [], thirdPartyDomains: [], blockedBySsrf: [] },
    homepageHeaders: {},
    homepageChain: [],
    notes: [],
  },
  error: null,
  reportStatus: 'Open' as const,
  fixLog: [],
});

describe('fix / status API', () => {
  it('allows only Open ↔ In Progress manually; Resolved is refused', async () => {
    const { base, store } = await boot();
    const id = '11111111-1111-4111-8111-111111111111';
    store.insert(completeRecord(id));
    const post = (status: string) => fetch(`${base}/api/investigations/${id}/status`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status }) });
    expect((await post('Resolved')).status).toBe(400);
    expect((await post('In Progress')).status).toBe(200);
    expect(store.get(id)?.reportStatus).toBe('In Progress');

    const fix = await (await fetch(`${base}/api/investigations/${id}/fix`)).json();
    expect(fix.guide.method.label).toBe('Child theme code');
    expect(fix.html).toContain('Step 1');
    expect(fix.text).toContain('Recommended fix method');

    await fetch(`${base}/api/investigations/${id}/fix-log`, { method: 'POST' });
    expect(store.get(id)?.fixLog).toHaveLength(1);

    const tracking = await (await fetch(`${base}/api/investigations/${id}/tracking`)).json();
    expect(tracking.html).toMatch(/Not re-checked yet/);

    // The analyst report (private) keeps the fix instructions…
    const analyst = await (await fetch(`${base}/api/investigations/${id}/analyst-report.html`)).text();
    expect(analyst).toMatch(/Exact Fix Instructions/);
    expect(analyst).toMatch(/Verification Method/);
    expect(analyst).toMatch(/not been verified as resolved/);

    // …the client report never reveals how to fix anything.
    const client = await (await fetch(`${base}/api/investigations/${id}/report.html`)).text();
    expect(client).toMatch(/Website Health &amp; Technical SEO Report/);
    expect(client).toContain('Homepage &lt;html&gt; element has no lang attribute');
    expect(client).not.toMatch(/Exact Fix Instructions|Recommended Solution|Recommended fix|Verification Method|Step 1/i);
    expect(client).not.toContain('language_attributes'); // text from the candidate's solution
    expect(client).toMatch(/We can resolve this for you/);
  });

  it('prints agency branding and the call to action on client reports; validates settings', async () => {
    const { base, store } = await boot();
    const id = '22222222-2222-4222-8222-222222222222';
    store.insert({ ...completeRecord(id), clientName: 'Acme <Plumbing>' });
    const put = (branding: unknown) => fetch(`${base}/api/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ branding }) });
    expect((await put({ agencyName: 'Pixel & Co', email: 'not-an-email' })).status).toBe(400);
    expect((await put({ agencyName: 'X', accent: 'red' })).status).toBe(400);
    expect((await put({ agencyName: 'X', logo: 'data:image/svg+xml;base64,PHN2Zz4=' })).status).toBe(400);
    const ok = await put({ agencyName: 'Pixel & Co', email: 'hi@pixel.co', bookingUrl: 'calendly.com/pixel/15', accent: '#FF5500', ctaHeadline: 'Hire <us>' });
    expect(ok.status).toBe(200);
    expect((await ok.json()).branding).toMatchObject({ accent: '#ff5500', bookingUrl: 'https://calendly.com/pixel/15' });

    const client = await (await fetch(`${base}/api/investigations/${id}/report.html?inline=1`)).text();
    expect(client).toContain('Pixel &amp; Co');
    expect(client).toContain('Hire &lt;us&gt;');
    expect(client).toContain('mailto:hi@pixel.co');
    expect(client).toContain('https://calendly.com/pixel/15');
    expect(client).toContain('Acme &lt;Plumbing&gt;');
    expect(client).toContain('--accent:#ff5500');
  });

  it('paginates, searches, archives, bulk-updates and deletes reports; computes stats', async () => {
    const { base, store } = await boot();
    const ids = Array.from({ length: 25 }, (_, i) => `33333333-3333-4333-8333-${String(i).padStart(12, '0')}`);
    ids.forEach((id, i) => store.insert({ ...completeRecord(id), inputUrl: `https://site${i}.example.com/`, createdAt: new Date(Date.now() - i * 60_000).toISOString() }));
    const list = async (qs: string) => (await fetch(`${base}/api/investigations?${qs}`)).json();

    const p1 = await list('page=1&pageSize=10');
    expect(p1.total).toBe(25);
    expect(p1.items).toHaveLength(10);
    expect(p1.items[0].summary).toMatchObject({ score: 97, counts: { verified: 1, Low: 1 } });
    expect((await list('page=3&pageSize=10')).items).toHaveLength(5);
    expect((await list('q=site12')).total).toBe(1);
    expect((await list('q=%25')).total).toBe(0); // LIKE wildcards are escaped

    await fetch(`${base}/api/investigations/${ids[0]}/meta`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ archived: true }) });
    expect((await list('view=active')).total).toBe(24);
    expect((await list('view=archived')).total).toBe(1);

    const bulk = await fetch(`${base}/api/investigations/bulk`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: ids.slice(1, 4), action: 'archive' }) });
    expect(await bulk.json()).toEqual({ done: 3, skipped: 0 });
    expect((await list('view=archived')).total).toBe(4);
    const bad = await fetch(`${base}/api/investigations/bulk`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: ['../x'], action: 'delete' }) });
    expect(bad.status).toBe(400);

    expect((await fetch(`${base}/api/investigations/${ids[5]}`, { method: 'DELETE' })).status).toBe(200);
    expect((await fetch(`${base}/api/investigations/${ids[5]}`)).status).toBe(404);
    expect((await list('view=all')).total).toBe(24);

    const running = '44444444-4444-4444-8444-444444444444';
    store.insert({ ...completeRecord(running), status: 'running', result: null });
    expect((await fetch(`${base}/api/investigations/${running}`, { method: 'DELETE' })).status).toBe(409);

    const stats = await (await fetch(`${base}/api/stats`)).json();
    expect(stats).toMatchObject({ reports: 25, completed: 24, archived: 4, sites: 1 }); // all fixtures share example.com as siteUrl
    expect(stats.activity).toHaveLength(14);
    expect(stats.brandingComplete).toBe(false);
  });

  it('requires the API key when one is configured', async () => {
    const { base } = await boot('s3cret-key');
    expect((await fetch(`${base}/api/investigations`)).status).toBe(401);
    expect((await fetch(`${base}/api/investigations`, { headers: { 'x-wii-key': 'wrong' } })).status).toBe(401);
    expect((await fetch(`${base}/api/investigations`, { headers: { 'x-wii-key': 's3cret-key' } })).status).toBe(200);
  });
});

describe('sales features', () => {
  const json = (method: string, body: unknown) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('share links: public view counting, no API key needed, revocable, noindex', async () => {
    const { base, store } = await boot('k3y-for-api');
    const id = '55555555-5555-4555-8555-555555555555';
    store.insert(completeRecord(id));
    const auth = { 'x-wii-key': 'k3y-for-api' };
    const share = await (await fetch(`${base}/api/investigations/${id}/share`, { method: 'POST', headers: auth })).json();
    expect(share.path).toMatch(/^\/r\/[A-Za-z0-9_-]{32}$/);
    const again = await (await fetch(`${base}/api/investigations/${id}/share`, { method: 'POST', headers: auth })).json();
    expect(again.path).toBe(share.path); // idempotent

    const pub = await fetch(`${base}${share.path}`); // no API key: public link
    expect(pub.status).toBe(200);
    expect(pub.headers.get('x-robots-tag')).toMatch(/noindex/);
    expect(await pub.text()).not.toMatch(/Exact Fix Instructions/);
    await fetch(`${base}${share.path}`);
    const job = await (await fetch(`${base}/api/investigations/${id}`, { headers: auth })).json();
    expect(job.share.views).toBe(2);

    await fetch(`${base}/api/investigations/${id}/share`, { method: 'DELETE', headers: auth });
    expect((await fetch(`${base}${share.path}`)).status).toBe(404);
    expect((await fetch(`${base}/r/not-a-valid-token`)).status).toBe(404);
  });

  it('lead stage, notes, lead filter, outreach draft and CSV export', async () => {
    const { base, store } = await boot();
    const id = '66666666-6666-4666-8666-666666666666';
    store.insert({ ...completeRecord(id), clientName: '=HYPERLINK("http://evil")' });
    expect((await fetch(`${base}/api/investigations/${id}/meta`, json('POST', { leadStatus: 'Hot' }))).status).toBe(400);
    const ok = await (await fetch(`${base}/api/investigations/${id}/meta`, json('POST', { leadStatus: 'Contacted', notes: 'Call back Friday' }))).json();
    expect(ok).toMatchObject({ leadStatus: 'Contacted', notes: 'Call back Friday' });
    expect((await (await fetch(`${base}/api/investigations?lead=Contacted`)).json()).total).toBe(1);
    expect((await (await fetch(`${base}/api/investigations?lead=Won`)).json()).total).toBe(0);

    const draft = await (await fetch(`${base}/api/investigations/${id}/outreach`)).json();
    expect(draft.subject).toContain('example.com');
    expect(draft.body).toContain('Homepage <html> element has no lang attribute');
    expect(draft.body).not.toContain('language_attributes'); // no fix instructions in sales emails
    expect(draft.followUp).toBeTruthy();

    const csv = await (await fetch(`${base}/api/export.csv?view=all`)).text();
    expect(csv.split('\r\n')[0]).toMatch(/^Date,Website,Client,Lead status/);
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"")"`); // formula neutralised and quoted
    expect(csv).toContain('Contacted');
    const stats = await (await fetch(`${base}/api/stats`)).json();
    expect(stats.pipeline.Contacted).toBe(1);
  });

  it('batch audits validate every URL and never queue private targets', async () => {
    const { base } = await boot();
    expect((await fetch(`${base}/api/investigations/batch`, json('POST', { urls: [] }))).status).toBe(400);
    expect((await fetch(`${base}/api/investigations/batch`, json('POST', { urls: Array(21).fill('https://example.com') }))).status).toBe(400);
    const r = await fetch(`${base}/api/investigations/batch`, json('POST', { urls: ['http://127.0.0.1/', 'file:///etc/passwd', 'http://169.254.169.254/'] }));
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(body.queued).toHaveLength(0);
    expect(body.errors).toHaveLength(3);
  });

  it('stores the Safe Browsing key server-side and only reveals a hint', async () => {
    const { base } = await boot();
    const bad = await fetch(`${base}/api/settings`, json('PUT', { integrations: { safeBrowsingKey: 'x' } }));
    expect(bad.status).toBe(400);
    const key = 'AIzaSyTESTKEY_1234567890abcdWXYZ';
    const r = await (await fetch(`${base}/api/settings`, json('PUT', { integrations: { safeBrowsingKey: key } }))).json();
    expect(r.integrations).toEqual({ safeBrowsingConfigured: true, safeBrowsingKeyHint: '…WXYZ' });
    const text = await (await fetch(`${base}/api/settings`)).text();
    expect(text).not.toContain(key);
  });
});
