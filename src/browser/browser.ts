import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page, type Request, type Response } from 'playwright';
import { USER_AGENT } from '../config.js';
import { isSameSite } from '../crawl/url.js';
import { DEFAULT_POLICY, resolvePublicHost, validateTargetUrl, type NetworkPolicy } from '../security/ssrf.js';
import type { BrowserMetrics, BrowserNetworkEntry, BrowserReport } from '../types.js';

export interface DeviceProfile {
  viewport: { width: number; height: number };
  deviceScaleFactor: number;
  isMobile: boolean;
  hasTouch: boolean;
  userAgent: string;
}

export const MOBILE: DeviceProfile = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  userAgent:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36 WebsiteIndependentInvestigator/1.0',
};
export const DESKTOP: DeviceProfile = {
  viewport: { width: 1366, height: 768 },
  deviceScaleFactor: 1,
  isMobile: false,
  hasTouch: false,
  userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 ${USER_AGENT.split(' ')[1]}`,
};

/** Injected before any page script: collects Web Vitals via PerformanceObserver (buffered). */
const VITALS_INIT = `
// Functions passed to page.evaluate are serialized; when this app runs under tsx/esbuild (keepNames)
// they reference an injected __name helper that does not exist in the page. Provide a no-op.
if (typeof globalThis.__name !== 'function') globalThis.__name = (fn) => fn;
(() => {
  const v = { lcp: null, cls: 0, fcp: null, inp: null, lcpElement: null };
  let sessionValue = 0, sessionEntries = [];
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        v.lcp = e.startTime;
        try { const el = e.element; v.lcpElement = el ? (el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.currentSrc || el.src ? ' ' + (el.currentSrc || el.src).slice(0, 160) : '')) : null; } catch {}
      }
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  } catch {}
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.hadRecentInput) continue;
        const first = sessionEntries[0], last = sessionEntries[sessionEntries.length - 1];
        if (sessionValue && e.startTime - last.startTime < 1000 && e.startTime - first.startTime < 5000) {
          sessionValue += e.value; sessionEntries.push(e);
        } else { sessionValue = e.value; sessionEntries = [e]; }
        if (sessionValue > v.cls) v.cls = sessionValue;
      }
    }).observe({ type: 'layout-shift', buffered: true });
  } catch {}
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (e.name === 'first-contentful-paint') v.fcp = e.startTime;
    }).observe({ type: 'paint', buffered: true });
  } catch {}
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (e.interactionId) v.inp = Math.max(v.inp || 0, e.duration);
    }).observe({ type: 'event', buffered: true, durationThreshold: 16 });
  } catch {}
  Object.defineProperty(window, '__wiiVitals', { value: v, configurable: false });
})();
`;

export interface LaunchedBrowser {
  browser: Browser;
  engine: string;
}

/** Bundled Chromium first; falls back to an installed Chrome/Edge so the tool works without `playwright install`. */
export async function launchBrowser(): Promise<LaunchedBrowser> {
  const attempts: { label: string; channel?: string }[] = [];
  if (process.env.WII_BROWSER_CHANNEL) attempts.push({ label: process.env.WII_BROWSER_CHANNEL, channel: process.env.WII_BROWSER_CHANNEL });
  attempts.push({ label: 'Playwright Chromium' }, { label: 'Google Chrome', channel: 'chrome' }, { label: 'Microsoft Edge', channel: 'msedge' });
  const errors: string[] = [];
  for (const a of attempts) {
    try {
      const browser = await chromium.launch({ headless: true, ...(a.channel ? { channel: a.channel } : {}) });
      return { browser, engine: `${a.label} ${browser.version()}` };
    } catch (e) {
      errors.push(`${a.label}: ${(e as Error).message.split('\n')[0]}`);
    }
  }
  throw new Error(`No browser available. ${errors.join(' | ')}`);
}

function median(values: (number | null)[]): number | null {
  const v = values.filter((x): x is number => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
}

interface RunResult {
  lcpMs: number | null;
  cls: number | null;
  fcpMs: number | null;
  ttfbMs: number | null;
  inpMs: number | null;
  contentWidth: number;
  viewportWidth: number;
  horizontalOverflow: boolean;
  overflowingElements: BrowserMetrics['overflowingElements'];
  requestCount: number;
  transferBytes: number;
  images: { src: string; naturalWidth: number; renderedWidth: number }[];
  renderedH1Count: number;
  visibility?: string;
}

/**
 * A browser session that is SSRF-guarded: every request and WebSocket the page makes is resolved and
 * checked against the public-address policy before it is allowed to leave the machine.
 */
export class BrowserSession {
  private constructor(
    private readonly launched: LaunchedBrowser,
    private readonly policy: NetworkPolicy,
    private readonly screenshotDir: string,
  ) {}

  readonly report: BrowserReport = {
    available: true,
    consoleErrors: [],
    pageErrors: [],
    failedRequests: [],
    largeImages: [],
    mixedContent: [],
    thirdPartyDomains: [],
    blockedBySsrf: [],
  };
  private readonly hostVerdicts = new Map<string, Promise<boolean>>();
  private readonly thirdParty = new Set<string>();
  private readonly imageBytes = new Map<string, number>();
  requestCount = 0;
  /** document.visibilityState at measurement time (paint timing is not reported for hidden pages). */
  lastVisibility?: string;

  static async start(screenshotDir: string, policy: NetworkPolicy = DEFAULT_POLICY): Promise<BrowserSession> {
    const launched = await launchBrowser();
    await fs.mkdir(screenshotDir, { recursive: true });
    const s = new BrowserSession(launched, policy, screenshotDir);
    s.report.engine = launched.engine;
    s.report.version = launched.browser.version();
    return s;
  }

  async close(): Promise<void> {
    await this.launched.browser.close().catch(() => undefined);
  }

  private isPublic(urlStr: string): Promise<boolean> {
    let url: URL;
    try {
      url = new URL(urlStr);
    } catch {
      return Promise.resolve(false);
    }
    if (url.protocol === 'data:' || url.protocol === 'blob:') return Promise.resolve(true);
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return Promise.resolve(false);
    const key = `${url.hostname}:${url.port}`;
    let verdict = this.hostVerdicts.get(key);
    if (!verdict) {
      verdict = (async () => {
        try {
          const httpish = new URL(urlStr.replace(/^ws/, 'http'));
          // Sub-resources may legitimately live on non-standard public ports; only the address class matters here.
          validateTargetUrl(httpish, { ...this.policy, allowedPorts: [Number(httpish.port || (httpish.protocol === 'https:' ? 443 : 80))] });
          await resolvePublicHost(httpish.hostname, this.policy);
          return true;
        } catch {
          return false;
        }
      })();
      this.hostVerdicts.set(key, verdict);
    }
    return verdict;
  }

  /** SSRF-guarded context for any device profile (used by the e-commerce / responsive checks). */
  contextFor(profile: DeviceProfile): Promise<BrowserContext> {
    return this.newContext(profile);
  }

  get shotDir(): string {
    return this.screenshotDir;
  }

  private async newContext(mobile: boolean | DeviceProfile): Promise<BrowserContext> {
    const profile = typeof mobile === 'boolean' ? (mobile ? MOBILE : DESKTOP) : mobile;
    const ctx = await this.launched.browser.newContext({
      ...profile,
      serviceWorkers: 'block', // service workers would bypass request routing
      ignoreHTTPSErrors: false,
      javaScriptEnabled: true,
      locale: 'en-US',
    });
    await ctx.route('**/*', async (route) => {
      const url = route.request().url();
      if (await this.isPublic(url)) return route.continue();
      this.report.blockedBySsrf.push(url.slice(0, 200));
      return route.abort('blockedbyclient');
    });
    await ctx.routeWebSocket(/.*/, async (ws) => {
      if (await this.isPublic(ws.url())) ws.connectToServer();
      else {
        this.report.blockedBySsrf.push(ws.url().slice(0, 200));
        await ws.close();
      }
    });
    await ctx.addInitScript(VITALS_INIT);
    return ctx;
  }

  private attachListeners(page: Page, pageUrl: string): void {
    const isHttps = pageUrl.startsWith('https:');
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      const text = msg.text();
      if (/net::ERR_BLOCKED_BY_CLIENT/.test(text)) return;
      if (this.report.consoleErrors.length < 50 && !this.report.consoleErrors.some((e) => e.text === text && e.page === pageUrl)) {
        const loc = msg.location();
        this.report.consoleErrors.push({ text: text.slice(0, 500), ...(loc.url ? { location: `${loc.url}:${loc.lineNumber}` } : {}), page: pageUrl });
      }
    });
    page.on('pageerror', (err) => {
      if (this.report.pageErrors.length < 30 && !this.report.pageErrors.some((e) => e.message === err.message && e.page === pageUrl)) {
        this.report.pageErrors.push({ message: `${err.name}: ${err.message}`.slice(0, 500), page: pageUrl });
      }
    });
    page.on('request', (req: Request) => {
      this.requestCount++;
      const u = req.url();
      if (/^https?:/.test(u) && !isSameSite(u, pageUrl)) {
        try {
          this.thirdParty.add(new URL(u).hostname);
        } catch {
          /* ignore */
        }
      }
      if (isHttps && u.startsWith('http://') && req.resourceType() !== 'document' && !this.report.mixedContent.includes(u)) {
        this.report.mixedContent.push(u);
      }
    });
    page.on('requestfailed', (req: Request) => {
      const failure = req.failure()?.errorText ?? 'failed';
      if (/ERR_BLOCKED_BY_CLIENT|ERR_ABORTED/.test(failure)) return;
      this.pushFailed({ url: req.url(), status: null, resourceType: req.resourceType(), failure, fromPage: pageUrl });
    });
    page.on('response', (res: Response) => {
      const req = res.request();
      const status = res.status();
      const type = req.resourceType();
      if (status >= 400) this.pushFailed({ url: res.url(), status, resourceType: type, fromPage: pageUrl });
      if (type === 'image') {
        const len = Number(res.headers()['content-length'] ?? 0);
        if (len) this.imageBytes.set(res.url(), len);
      }
    });
  }

  private pushFailed(entry: BrowserNetworkEntry): void {
    if (this.report.failedRequests.length >= 80) return;
    if (this.report.failedRequests.some((f) => f.url === entry.url && f.fromPage === entry.fromPage)) return;
    this.report.failedRequests.push({ ...entry, url: entry.url.slice(0, 500) });
  }

  private async singleRun(url: string, mobile: boolean, screenshotName?: string): Promise<RunResult & { screenshot?: string }> {
    const ctx = await this.newContext(mobile);
    const page = await ctx.newPage();
    this.attachListeners(page, url);
    try {
      await page.goto(url, { waitUntil: 'load', timeout: 30_000 });
      await page.waitForLoadState('networkidle', { timeout: 6_000 }).catch(() => undefined);
      await page.waitForTimeout(1_000);
      const data = await page.evaluate(async () => {
        // Two animation frames guarantee at least one committed paint before paint/LCP entries are read.
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))));
        for (let i = 0; i < 15 && !performance.getEntriesByType('paint').length; i++) await new Promise((r) => setTimeout(r, 100));
        const w = window as unknown as { __wiiVitals?: { lcp: number | null; cls: number; fcp: number | null; inp: number | null } };
        const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
        const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
        // Layout viewport width. innerWidth is unreliable: mobile emulation zooms out to fit overflowing content.
        const vw = document.documentElement.clientWidth || window.innerWidth;
        const doc = document.documentElement;
        const clip = (el: Element) => ['hidden', 'clip'].includes(getComputedStyle(el).overflowX);
        const contentWidth = Math.max(doc.scrollWidth, document.body?.scrollWidth ?? 0);
        const clipped = clip(doc) || (document.body ? clip(document.body) : false);
        const overflowing: { selector: string; right: number; width: number }[] = [];
        if (contentWidth > vw + 1) {
          const label = (el: Element) => {
            const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 2) : [];
            return el.tagName.toLowerCase() + (el.id ? `#${el.id}` : '') + cls.map((c) => `.${c}`).join('');
          };
          for (const el of Array.from(document.body?.querySelectorAll('*') ?? [])) {
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0 || r.right <= vw + 1) continue;
            const style = getComputedStyle(el);
            if (style.position === 'fixed' || style.visibility === 'hidden') continue;
            const parent = el.parentElement;
            if (parent && parent !== document.body && parent.getBoundingClientRect().right > vw + 1) continue;
            el.setAttribute('data-wii-overflow', '1');
            overflowing.push({ selector: label(el), right: Math.round(r.right), width: Math.round(r.width) });
            if (overflowing.length >= 8) break;
          }
        }
        const images = Array.from(document.images)
          .filter((i) => i.complete && i.naturalWidth > 0)
          .map((i) => ({ src: i.currentSrc || i.src, naturalWidth: i.naturalWidth, renderedWidth: Math.round(i.getBoundingClientRect().width) }));
        return {
          lcpMs: w.__wiiVitals?.lcp ?? null,
          cls: w.__wiiVitals?.cls ?? null,
          fcpMs: w.__wiiVitals?.fcp ?? performance.getEntriesByType('paint').find((e) => e.name === 'first-contentful-paint')?.startTime ?? null,
          visibility: document.visibilityState,
          inpMs: w.__wiiVitals?.inp ?? null,
          ttfbMs: nav ? nav.responseStart - nav.startTime : null,
          contentWidth,
          viewportWidth: vw,
          horizontalOverflow: contentWidth > vw + 1 && !clipped,
          overflowingElements: overflowing,
          renderedH1Count: document.querySelectorAll('h1, [role="heading"][aria-level="1"]').length,
          requestCount: resources.length + 1,
          transferBytes: Math.round(resources.reduce((a, r) => a + (r.transferSize || 0), nav?.transferSize ?? 0)),
          images,
        };
      });
      this.lastVisibility = data.visibility;
      let screenshot: string | undefined;
      if (screenshotName) {
        screenshot = path.join(this.screenshotDir, `${screenshotName}.jpg`);
        await page.screenshot({ path: screenshot, type: 'jpeg', quality: 70, fullPage: false });
      }
      return { ...data, ...(screenshot ? { screenshot } : {}) };
    } finally {
      await ctx.close().catch(() => undefined);
    }
  }

  /** Measure a page `runs` times in one profile; returns medians and the first screenshot. */
  async measure(url: string, label: 'mobile' | 'desktop', runs = 2): Promise<BrowserMetrics> {
    const results: (RunResult & { screenshot?: string })[] = [];
    let lastError: Error | null = null;
    for (let i = 0; i < runs; i++) {
      try {
        results.push(await this.singleRun(url, label === 'mobile', i === 0 ? `homepage-${label}` : undefined));
      } catch (e) {
        lastError = e as Error;
      }
    }
    if (!results.length) throw lastError ?? new Error('Browser run failed');
    const first = results[0]!;
    for (const r of results) {
      for (const img of r.images) {
        const bytes = this.imageBytes.get(img.src);
        if (bytes && bytes > 300 * 1024 && !this.report.largeImages.some((x) => x.url === img.src)) {
          this.report.largeImages.push({ url: img.src, bytes, naturalWidth: img.naturalWidth, renderedWidth: img.renderedWidth, page: url });
        }
      }
    }
    this.report.thirdPartyDomains = [...this.thirdParty].sort();
    const metrics: BrowserMetrics = {
      label,
      viewport: label === 'mobile' ? MOBILE.viewport : DESKTOP.viewport,
      runs: results.length,
      lcpMs: round(median(results.map((r) => r.lcpMs))),
      cls: median(results.map((r) => r.cls)) === null ? null : Math.round(median(results.map((r) => r.cls))! * 1000) / 1000,
      fcpMs: round(median(results.map((r) => r.fcpMs))),
      ttfbMs: round(median(results.map((r) => r.ttfbMs))),
      inpMs: round(median(results.map((r) => r.inpMs))),
      contentWidth: first.contentWidth,
      horizontalOverflow: results.every((r) => r.horizontalOverflow),
      renderedH1Count: Math.max(...results.map((r) => r.renderedH1Count)),
      overflowingElements: first.overflowingElements,
      requestCount: first.requestCount,
      transferBytes: first.transferBytes,
      ...(first.screenshot ? { screenshotFile: path.basename(first.screenshot) } : {}),
    };
    this.report[label] = metrics;
    return metrics;
  }

  /** Load a page (desktop, once) purely to collect console errors / failed requests. Returns false if the load failed. */
  async visit(url: string): Promise<boolean> {
    return this.singleRun(url, false).then(
      () => true,
      () => false,
    );
  }

  /**
   * Screenshot of an affected page with the affected elements outlined in red.
   * `hrefs` highlights links by href; `overflow` highlights elements flagged during the overflow scan.
   */
  async captureAffected(url: string, name: string, opts: { mobile?: boolean; hrefs?: string[]; overflow?: boolean; selectors?: string[] }): Promise<string | null> {
    const ctx = await this.newContext(!!opts.mobile);
    const page = await ctx.newPage();
    try {
      await page.goto(url, { waitUntil: 'load', timeout: 30_000 });
      await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
      const found = await page.evaluate(
        ({ hrefs, overflow, selectors, vw }) => {
          const targets: Element[] = [];
          if (hrefs?.length) {
            for (const a of Array.from(document.querySelectorAll('a[href]'))) {
              const abs = (a as HTMLAnchorElement).href;
              if (hrefs.some((h) => abs === h || abs.replace(/\/$/, '') === h.replace(/\/$/, ''))) targets.push(a);
            }
          }
          if (overflow) {
            for (const el of Array.from(document.body.querySelectorAll('*'))) {
              const r = el.getBoundingClientRect();
              const p = el.parentElement;
              if (r.width && r.right > vw + 1 && getComputedStyle(el).position !== 'fixed' && !(p && p !== document.body && p.getBoundingClientRect().right > vw + 1)) targets.push(el);
              if (targets.length > 8) break;
            }
          }
          for (const s of selectors ?? []) targets.push(...Array.from(document.querySelectorAll(s)).slice(0, 5));
          const visible = targets.filter((t) => {
            const r = t.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          });
          for (const t of visible) {
            const el = t as HTMLElement;
            el.style.outline = '4px solid #e11d48';
            el.style.outlineOffset = '2px';
            el.style.boxShadow = '0 0 0 9999px rgba(225,29,72,0.0)';
          }
          if (visible[0]) visible[0].scrollIntoView({ block: 'center' });
          return visible.length;
        },
        { hrefs: opts.hrefs ?? [], overflow: !!opts.overflow, selectors: opts.selectors ?? [], vw: opts.mobile ? MOBILE.viewport.width : DESKTOP.viewport.width },
      );
      if (!found && (opts.hrefs?.length || opts.selectors?.length)) return null;
      await page.waitForTimeout(300);
      const file = path.join(this.screenshotDir, `${name}.jpg`);
      await page.screenshot({ path: file, type: 'jpeg', quality: 72 });
      return path.basename(file);
    } catch {
      return null;
    } finally {
      await ctx.close().catch(() => undefined);
    }
  }
}

function round(n: number | null): number | null {
  return n === null ? null : Math.round(n);
}

/** Render a self-contained HTML report to PDF. All network access is blocked (the report embeds its images). */
export async function renderPdf(html: string, opts: { cssPageSize?: boolean } = {}): Promise<Buffer> {
  const { browser } = await launchBrowser();
  try {
    const ctx = await browser.newContext();
    await ctx.route('**/*', (route) => (route.request().url().startsWith('data:') ? route.continue() : route.abort()));
    const page = await ctx.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    // cssPageSize: the document controls size and margins via @page (e.g. a full-bleed cover page).
    return opts.cssPageSize
      ? await page.pdf({ printBackground: true, preferCSSPageSize: true })
      : await page.pdf({ format: 'A4', printBackground: true, margin: { top: '16mm', bottom: '16mm', left: '14mm', right: '14mm' } });
  } finally {
    await browser.close().catch(() => undefined);
  }
}
