import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserSession, launchBrowser, renderPdf } from '../src/browser/browser.js';
import { page, startServer, TEST_POLICY, type FixtureServer } from './helpers/server.js';

let srv: FixtureServer;
let session: BrowserSession | null = null;
let unavailable = '';
const shotDir = path.join(os.tmpdir(), `wii-browser-test-${Date.now()}`);

beforeAll(async () => {
  try {
    const { browser } = await launchBrowser();
    await browser.close();
  } catch (e) {
    unavailable = (e as Error).message;
    return;
  }
  srv = await startServer({
    '/': {
      body: page({
        title: 'Overflow fixture',
        head: '<script src="/missing.js"></script><link rel="stylesheet" href="/missing.css">',
        body: `<h1>Hello</h1>
          <div class="too-wide" style="width:1200px;height:40px;background:#c00">wide</div>
          <img src="http://10.0.0.1/internal.png" alt="">
          <img src="http://169.254.169.254/latest/meta-data/" alt="">
          <script>window.addEventListener('load', () => { null.boom(); });</script>`,
      }),
    },
  });
  session = await BrowserSession.start(shotDir, TEST_POLICY);
}, 60_000);

afterAll(async () => {
  await session?.close();
  await srv?.close();
});

describe('browser analysis (Playwright)', () => {
  it('measures mobile layout, vitals and captures a screenshot', async (ctx) => {
    if (unavailable) ctx.skip();
    const m = await session!.measure(`${srv.base}/`, 'mobile', 2);
    expect(m.viewport.width).toBe(390);
    expect(m.contentWidth).toBeGreaterThanOrEqual(1200);
    expect(m.horizontalOverflow).toBe(true);
    expect(m.overflowingElements.some((e) => e.selector.includes('too-wide'))).toBe(true);
    expect(m.fcpMs).not.toBeNull();
    expect(m.ttfbMs).not.toBeNull();
    expect(fs.existsSync(path.join(shotDir, m.screenshotFile!))).toBe(true);
  });

  it('records failed JS/CSS requests and uncaught errors', async (ctx) => {
    if (unavailable) ctx.skip();
    const r = session!.report;
    expect(r.failedRequests.some((f) => f.url.endsWith('/missing.js') && f.status === 404 && f.resourceType === 'script')).toBe(true);
    expect(r.failedRequests.some((f) => f.url.endsWith('/missing.css') && f.status === 404)).toBe(true);
    expect(r.pageErrors.some((e) => /boom|null/i.test(e.message))).toBe(true);
  });

  it('blocks page sub-requests to private/metadata addresses (SSRF in the browser)', async (ctx) => {
    if (unavailable) ctx.skip();
    expect(session!.report.blockedBySsrf.some((u) => u.startsWith('http://10.0.0.1/'))).toBe(true);
    expect(session!.report.blockedBySsrf.some((u) => u.startsWith('http://169.254.169.254/'))).toBe(true);
  });

  it('highlights overflowing elements in an evidence screenshot', async (ctx) => {
    if (unavailable) ctx.skip();
    const file = await session!.captureAffected(`${srv.base}/`, 'overflow-evidence', { mobile: true, overflow: true });
    expect(file).toBe('overflow-evidence.jpg');
  });

  it('renders a PDF with network access disabled', async (ctx) => {
    if (unavailable) ctx.skip();
    const pdf = await renderPdf('<!doctype html><title>t</title><h1>Report</h1><img src="http://127.0.0.1:9/x.png">');
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });
});
