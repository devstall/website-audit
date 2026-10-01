import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import { renderPdf } from './browser/browser.js';
import { API_KEY, AUTH_PASSWORD, AUTH_USER, DATA_DIR, MIN_PASSWORD_LENGTH, QUEUE_CONCURRENCY, SERVER_HOST, SERVER_PORT } from './config.js';
import { normalizeInputUrl } from './crawl/url.js';
import { brandingComplete, loadBranding, sanitizeBranding, saveBranding } from './branding.js';
import { LEAD_STATUSES, openStore, type InvestigationRecord, type JobStatus, type LeadStatus, type ListItem } from './db.js';
import { loadIntegrations, publicIntegrations, saveIntegrations } from './integrations.js';
import { buildOutreach } from './report/outreach.js';
import { securityRows, securityVerdict } from './report/securityRows.js';
import { buildFixGuide, fixAsText } from './fix/knowledge.js';
import { FIX_CSS, renderFixPanel, renderTracking, type TrackingInput } from './fix/render.js';
import { InvestigationQueue, RecheckRefused } from './queue.js';
import { renderClientReport } from './report/client.js';
import type { ScanFocus } from './types.js';
import { REPORT_CSS, renderReportBody, renderReportDocument } from './report/render.js';
import { computeStats } from './report/stats.js';
import { assertPublicUrl, SsrfError } from './security/ssrf.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHOT_RE = /^[a-z0-9-]{1,60}\.jpg$/;

/** Very small fixed-window limiter: investigations are expensive for us and must not hammer targets. */
function rateLimiter(max: number, windowMs: number) {
  const hits = new Map<string, { count: number; reset: number }>();
  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.ip ?? 'unknown';
    const now = Date.now();
    const h = hits.get(key);
    if (!h || h.reset < now) hits.set(key, { count: 1, reset: now + windowMs });
    else if (++h.count > max) {
      res.status(429).json({ error: 'Too many investigations started. Please wait a few minutes.' });
      return;
    }
    next();
  };
}

/** Constant-time string comparison (hashing first makes the lengths equal). */
function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function apiKeyFrom(req: Request): string {
  const header = req.headers['x-wii-key'];
  if (typeof header === 'string' && header) return header;
  const auth = req.headers.authorization ?? '';
  return /^Bearer\s+/i.test(auth) ? auth.replace(/^Bearer\s+/i, '') : '';
}

/**
 * Dashboard login (HTTP Basic auth). The browser asks once and then sends the credentials with every
 * page and API call, so the UI needs no changes. A valid API key is also accepted on /api so the
 * WordPress plugin keeps working.
 */
function loginGuard(user: string, password: string, apiKey: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    // Share links are the reports you send to clients: they stay public (each one is an unguessable, revocable token).
    if (req.method === 'GET' && req.path.startsWith('/r/')) return next();
    if (apiKey && req.path.startsWith('/api/')) {
      const key = apiKeyFrom(req);
      if (key && safeEqual(key, apiKey)) {
        res.locals.authenticated = true;
        return next();
      }
    }
    const match = /^Basic\s+(.+)$/i.exec(req.headers.authorization ?? '');
    if (match) {
      const decoded = Buffer.from(match[1]!, 'base64').toString('utf8');
      const sep = decoded.indexOf(':');
      // Evaluate both comparisons so timing does not reveal which one failed.
      const userOk = sep >= 0 && safeEqual(decoded.slice(0, sep), user);
      const passOk = sep >= 0 && safeEqual(decoded.slice(sep + 1), password);
      if (userOk && passOk) {
        res.locals.authenticated = true;
        return next();
      }
    }
    res.setHeader('WWW-Authenticate', 'Basic realm="Website Investigator", charset="UTF-8"');
    if (req.path.startsWith('/api/')) res.status(401).json({ error: 'Login required' });
    else res.status(401).type('text/plain').send('Login required');
  };
}

/**
 * Optional shared-secret auth for the API (used by the WordPress plugin when the engine is not on loopback).
 * Requests already signed in through the dashboard login pass; otherwise the key is required.
 */
function apiKeyGuard(key: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (res.locals.authenticated) return next();
    const given = apiKeyFrom(req);
    if (!given || !safeEqual(given, key)) {
      res.status(401).json({ error: 'Missing or invalid API key' });
      return;
    }
    next();
  };
}

export async function createApp(dataDir = DATA_DIR, opts: { apiKey?: string; user?: string; password?: string } = {}) {
  const apiKey = opts.apiKey ?? API_KEY;
  const password = opts.password ?? AUTH_PASSWORD;
  const user = opts.user ?? AUTH_USER;
  const store = await openStore(dataDir);
  const interrupted = store.failInterrupted();
  if (interrupted) console.warn(`[store] marked ${interrupted} interrupted investigation(s) as failed`);
  // The Safe Browsing key is read when each job starts, so saving it in Settings applies immediately.
  const queue = new InvestigationQueue(store, dataDir, QUEUE_CONCURRENCY, {}, {}, () => {
    const key = loadIntegrations(dataDir).safeBrowsingKey;
    return key ? { safeBrowsingKey: key } : {};
  });
  const isLead = (v: unknown): v is LeadStatus => typeof v === 'string' && (LEAD_STATUSES as readonly string[]).includes(v);
  const focusOf = (v: unknown): ScanFocus => (v === 'security' || v === 'ecommerce' ? v : 'full');

  const app = express();
  app.disable('x-powered-by');
  // Hosting proxies on the same machine forward the real client IP (used by the rate limiter).
  app.set('trust proxy', 'loopback');
  app.use((_req, res, next) => {
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });
  if (password) app.use(loginGuard(user, password, apiKey));
  // Settings carry an uploaded logo; everything else is tiny.
  const smallJson = express.json({ limit: '16kb' });
  const settingsJson = express.json({ limit: '700kb' });
  app.use((req, res, next) => (req.path === '/api/settings' ? settingsJson : smallJson)(req, res, next));
  if (apiKey) app.use('/api', apiKeyGuard(apiKey));
  app.use(express.static(path.join(ROOT, 'public'), { index: 'index.html' }));
  app.get('/report.css', (_req, res) => {
    res.type('text/css').send(REPORT_CSS);
  });
  app.get('/fix.css', (_req, res) => {
    res.type('text/css').send(FIX_CSS);
  });

  const load = (req: Request, res: Response): InvestigationRecord | null => {
    const id = String(req.params.id ?? '');
    const rec = ID_RE.test(id) ? store.get(id) : null;
    if (!rec) res.status(404).json({ error: 'Investigation not found' });
    return rec;
  };
  const requireResult = (req: Request, res: Response) => {
    const rec = load(req, res);
    if (!rec) return null;
    if (rec.status !== 'complete' || !rec.result) {
      res.status(409).json({ error: 'Investigation is not complete yet' });
      return null;
    }
    return rec as InvestigationRecord & { result: NonNullable<InvestigationRecord['result']> };
  };

  app.post('/api/investigations', rateLimiter(10, 10 * 60_000), async (req, res) => {
    const raw = typeof req.body?.url === 'string' ? req.body.url : '';
    let url: string;
    try {
      url = normalizeInputUrl(raw);
      await assertPublicUrl(url);
    } catch (e) {
      res.status(400).json({ error: e instanceof SsrfError || e instanceof TypeError ? (e as Error).message : (e as Error).message || 'Invalid URL' });
      return;
    }
    if (queue.stats.queued >= 20) {
      res.status(503).json({ error: 'The investigation queue is full. Please try again in a few minutes.' });
      return;
    }
    const clientName = typeof req.body?.clientName === 'string' ? req.body.clientName.trim().slice(0, 80) || null : null;
    const id = queue.enqueue(url, clientName, focusOf(req.body?.focus));
    res.status(202).json({ id, url });
  });

  /** Bulk prospecting: queue several websites at once. */
  app.post('/api/investigations/batch', rateLimiter(5, 10 * 60_000), async (req, res) => {
    const urls: unknown = req.body?.urls;
    if (!Array.isArray(urls) || !urls.length || urls.length > 20 || !urls.every((u) => typeof u === 'string')) {
      res.status(400).json({ error: 'Provide between 1 and 20 website URLs.' });
      return;
    }
    const queued: { id: string; url: string }[] = [];
    const errors: { url: string; error: string }[] = [];
    const seen = new Set<string>();
    for (const raw of urls as string[]) {
      const input = raw.trim();
      if (!input) continue;
      let url: string;
      try {
        url = normalizeInputUrl(input);
        await assertPublicUrl(url);
      } catch (e) {
        errors.push({ url: input.slice(0, 200), error: (e as Error).message });
        continue;
      }
      if (seen.has(url)) continue;
      seen.add(url);
      if (queue.stats.queued >= 20) {
        errors.push({ url, error: 'Queue is full — try again once some audits have finished.' });
        continue;
      }
      queued.push({ id: queue.enqueue(url, null, focusOf(req.body?.focus)), url });
    }
    res.status(queued.length ? 202 : 400).json({ queued, errors, ...(queued.length ? {} : { error: errors[0]?.error ?? 'No valid URLs' }) });
  });

  /** Paginated, searchable report list. Defaults (page 1, 20 items, active only) keep older callers working. */
  app.get('/api/investigations', (req, res) => {
    const view = ['active', 'archived', 'all'].includes(String(req.query.view)) ? (String(req.query.view) as 'active' | 'archived' | 'all') : 'active';
    const status = ['queued', 'running', 'complete', 'failed'].includes(String(req.query.status)) ? (String(req.query.status) as JobStatus) : undefined;
    const page = Number(req.query.page) || 1;
    const pageSize = Number(req.query.pageSize) || 20;
    const lead = isLead(req.query.lead) ? req.query.lead : undefined;
    const { items, total } = store.listPage({ page, pageSize, view, q: typeof req.query.q === 'string' ? req.query.q : '', ...(status ? { status } : {}), ...(lead ? { lead } : {}) });
    res.json({ items, total, page: Math.max(1, page), pageSize: Math.min(100, Math.max(1, pageSize)), queue: queue.stats, storage: store.kind });
  });

  app.get('/api/stats', (_req, res) => {
    res.json({ ...computeStats(store.all()), queue: queue.stats, brandingComplete: brandingComplete(loadBranding(dataDir)) });
  });

  app.get('/api/settings', (_req, res) => {
    res.json({ branding: loadBranding(dataDir), integrations: publicIntegrations(loadIntegrations(dataDir)) });
  });

  app.put('/api/settings', (req, res) => {
    const { branding, errors } = sanitizeBranding(req.body?.branding, loadBranding(dataDir));
    if (errors.length) {
      res.status(400).json({ error: errors.join('; '), errors });
      return;
    }
    if (req.body?.integrations !== undefined) {
      const err = saveIntegrations(dataDir, req.body.integrations);
      if (err) {
        res.status(400).json({ error: err });
        return;
      }
    }
    saveBranding(dataDir, branding);
    res.json({ branding, integrations: publicIntegrations(loadIntegrations(dataDir)) });
  });

  /** Leads / reports as CSV (for a CRM or spreadsheet). */
  app.get('/api/export.csv', (req, res) => {
    const view = ['active', 'archived', 'all'].includes(String(req.query.view)) ? (String(req.query.view) as 'active' | 'archived' | 'all') : 'active';
    const lead = isLead(req.query.lead) ? req.query.lead : undefined;
    const items: ListItem[] = [];
    for (let page = 1; page <= 50; page++) {
      const chunk = store.listPage({ page, pageSize: 100, view, q: typeof req.query.q === 'string' ? req.query.q : '', ...(lead ? { lead } : {}) });
      items.push(...chunk.items);
      if (items.length >= chunk.total) break;
    }
    // Neutralise spreadsheet formula injection (cells starting with = + - @ tab CR).
    const cell = (v: unknown) => {
      let t = v === null || v === undefined ? '' : String(v);
      if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`;
      return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    };
    const header = ['Date', 'Website', 'Client', 'Lead status', 'Health score', 'Grade', 'High', 'Medium', 'Low', 'Security', 'Top issue', 'Report status', 'Share views'];
    const lines = items.map((i) =>
      [i.createdAt.slice(0, 10), i.summary?.host ?? i.inputUrl, i.clientName, i.leadStatus, i.summary?.score, i.summary?.grade, i.summary?.counts.High, i.summary?.counts.Medium, i.summary?.counts.Low, i.summary?.security, i.summary?.primaryTitle, i.status === 'complete' ? i.reportStatus : i.status, i.shareViews]
        .map(cell)
        .join(','),
    );
    res.setHeader('Content-Disposition', `attachment; filename="leads-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.type('text/csv').send([header.join(','), ...lines].join('\r\n'));
  });

  /** Rename the client ("prepared for") or archive / restore a report. */
  app.post('/api/investigations/:id/meta', (req, res) => {
    const rec = load(req, res);
    if (!rec) return;
    const patch: Partial<InvestigationRecord> = {};
    if (typeof req.body?.clientName === 'string') patch.clientName = req.body.clientName.trim().slice(0, 80) || null;
    if (typeof req.body?.archived === 'boolean') patch.archived = req.body.archived;
    if (req.body?.leadStatus !== undefined) {
      if (!isLead(req.body.leadStatus)) {
        res.status(400).json({ error: `leadStatus must be one of: ${LEAD_STATUSES.join(', ')}` });
        return;
      }
      patch.leadStatus = req.body.leadStatus;
    }
    if (typeof req.body?.notes === 'string') patch.notes = req.body.notes.slice(0, 4000) || null;
    if (!Object.keys(patch).length) {
      res.status(400).json({ error: 'Nothing to update' });
      return;
    }
    store.update(rec.id, patch);
    res.json({
      ok: true,
      clientName: patch.clientName !== undefined ? patch.clientName : (rec.clientName ?? null),
      archived: patch.archived ?? !!rec.archived,
      leadStatus: patch.leadStatus ?? rec.leadStatus ?? 'New',
      notes: patch.notes !== undefined ? patch.notes : (rec.notes ?? null),
    });
  });

  // ---- Shareable client report links (read-only, revocable) ----
  app.post('/api/investigations/:id/share', (req, res) => {
    const rec = requireResult(req, res);
    if (!rec) return;
    const token = rec.shareToken ?? crypto.randomBytes(24).toString('base64url');
    if (!rec.shareToken) store.update(rec.id, { shareToken: token, shareViews: 0, shareLastViewed: null });
    res.json({ path: `/r/${token}`, views: rec.shareViews ?? 0 });
  });

  app.delete('/api/investigations/:id/share', (req, res) => {
    const rec = load(req, res);
    if (!rec) return;
    store.update(rec.id, { shareToken: null });
    res.json({ ok: true });
  });

  app.get('/api/investigations/:id/outreach', (req, res) => {
    const rec = requireResult(req, res);
    if (!rec) return;
    const shareUrl = rec.shareToken ? `${req.protocol}://${req.get('host')}/r/${rec.shareToken}` : null;
    res.json(buildOutreach(rec.result, loadBranding(dataDir), { clientName: rec.clientName ?? null, shareUrl }));
  });

  const removeInvestigation = async (id: string) => {
    if (queue.isBusy(id)) return 'busy' as const;
    if (!store.remove(id)) return 'missing' as const;
    await fs.rm(queue.screenshotDir(id), { recursive: true, force: true }).catch(() => undefined);
    return 'deleted' as const;
  };

  app.delete('/api/investigations/:id', async (req, res) => {
    const rec = load(req, res);
    if (!rec) return;
    const r = await removeInvestigation(rec.id);
    if (r === 'busy') res.status(409).json({ error: 'This investigation is still running. Delete it once it has finished.' });
    else res.json({ ok: true });
  });

  app.post('/api/investigations/bulk', async (req, res) => {
    const ids: unknown = req.body?.ids;
    const action = req.body?.action;
    if (!Array.isArray(ids) || !ids.length || ids.length > 100 || !ids.every((i) => typeof i === 'string' && ID_RE.test(i)) || !['archive', 'unarchive', 'delete'].includes(action)) {
      res.status(400).json({ error: 'Provide up to 100 report ids and an action (archive, unarchive or delete).' });
      return;
    }
    const outcome = { done: 0, skipped: 0 };
    for (const id of ids as string[]) {
      if (!store.get(id)) {
        outcome.skipped++;
        continue;
      }
      if (action === 'delete') {
        if ((await removeInvestigation(id)) === 'deleted') outcome.done++;
        else outcome.skipped++;
      } else {
        store.update(id, { archived: action === 'archive' });
        outcome.done++;
      }
    }
    res.json(outcome);
  });

  app.get('/api/investigations/:id', (req, res) => {
    const rec = load(req, res);
    if (!rec) return;
    const result = rec.result;
    const host = rec.summary?.host;
    const history = host
      ? store
          .all()
          .filter((i) => i.summary?.host === host && i.status === 'complete')
          .map((i) => ({ id: i.id, createdAt: i.createdAt, score: i.summary!.score, verified: i.summary!.counts.verified }))
          .slice(0, 12)
      : [];
    const rows = result ? securityRows(result) : [];
    res.json({
      id: rec.id,
      inputUrl: rec.inputUrl,
      status: rec.status,
      steps: rec.steps,
      error: rec.error,
      createdAt: rec.createdAt,
      reportStatus: rec.reportStatus,
      archived: !!rec.archived,
      clientName: rec.clientName ?? null,
      summary: rec.summary ?? null,
      leadStatus: rec.leadStatus ?? 'New',
      notes: rec.notes ?? null,
      share: rec.shareToken ? { path: `/r/${rec.shareToken}`, views: rec.shareViews ?? 0, lastViewed: rec.shareLastViewed ?? null } : null,
      security: result ? { rows, verdict: securityVerdict(rows) } : null,
      history,
      result,
    });
  });

  const tracking = (rec: InvestigationRecord & { result: NonNullable<InvestigationRecord['result']> }): TrackingInput => ({
    investigationId: rec.id,
    result: rec.result,
    reportStatus: rec.reportStatus,
    rechecks: store.listRechecks(rec.id),
    fixLog: rec.fixLog,
  });

  // ---- Fix Assistant (read-only guidance; never applies anything) ----
  app.get('/api/investigations/:id/fix', (req, res) => {
    const rec = requireResult(req, res);
    if (!rec) return;
    const guide = buildFixGuide(rec.result);
    if (!guide) {
      res.status(404).json({ error: 'No primary issue — nothing to fix.' });
      return;
    }
    res.json({ guide, text: fixAsText(guide), html: renderFixPanel(guide, { interactive: true }) });
  });

  /** Records that fix instructions were shown (re-check history keeps which fix preceded each re-check). */
  app.post('/api/investigations/:id/fix-log', (req, res) => {
    const rec = requireResult(req, res);
    if (!rec) return;
    const guide = buildFixGuide(rec.result);
    if (!guide) {
      res.status(404).json({ error: 'No primary issue' });
      return;
    }
    const fixLog = [...rec.fixLog, { at: new Date().toISOString(), method: guide.method.label }].slice(-50);
    store.update(rec.id, { fixLog });
    res.json({ ok: true });
  });

  app.get('/api/investigations/:id/tracking', (req, res) => {
    const rec = requireResult(req, res);
    if (!rec) return;
    const t = tracking(rec);
    res.json({ reportStatus: t.reportStatus, rechecks: t.rechecks, baseline: rec.result.baseline ?? [], running: t.rechecks.some((r) => r.state === 'running'), html: renderTracking(t) });
  });

  /** Manual status: only Open ↔ In Progress. Resolved / Unable to Verify come exclusively from re-check evidence. */
  app.post('/api/investigations/:id/status', (req, res) => {
    const rec = requireResult(req, res);
    if (!rec) return;
    const status = req.body?.status;
    if (status !== 'In Progress' && status !== 'Open') {
      res.status(400).json({ error: 'Only "In Progress" or "Open" can be set manually. "Resolved" is set only when a re-check confirms it.' });
      return;
    }
    store.update(rec.id, { reportStatus: status });
    res.json({ reportStatus: status });
  });

  app.post('/api/investigations/:id/rechecks', rateLimiter(20, 10 * 60_000), (req, res) => {
    const rec = requireResult(req, res);
    if (!rec) return;
    try {
      const rc = queue.enqueueRecheck(rec.id);
      res.status(202).json(rc);
    } catch (e) {
      if (e instanceof RecheckRefused) res.status(409).json({ error: e.message });
      else throw e;
    }
  });

  app.get('/api/investigations/:id/rechecks/:rid', (req, res) => {
    const rec = load(req, res);
    if (!rec) return;
    const rid = String(req.params.rid);
    const rc = ID_RE.test(rid) ? store.getRecheck(rid) : null;
    if (!rc || rc.investigationId !== rec.id) {
      res.status(404).json({ error: 'Re-check not found' });
      return;
    }
    res.json(rc);
  });

  app.get('/api/investigations/:id/report-body', (req, res) => {
    const rec = requireResult(req, res);
    if (!rec) return;
    res.type('text/html').send(
      renderReportBody(rec.result, {
        imageSrc: (f) => (SHOT_RE.test(f) ? `/api/investigations/${rec.id}/screenshots/${f}` : null),
        includeFix: req.query.fix !== '0',
        tracking: tracking(rec),
      }),
    );
  });

  app.get('/api/investigations/:id/screenshots/:file', async (req, res) => {
    const rec = load(req, res);
    if (!rec) return;
    const file = String(req.params.file);
    if (!SHOT_RE.test(file)) {
      res.status(400).end();
      return;
    }
    res.sendFile(path.resolve(queue.screenshotDir(rec.id), file), (err) => {
      if (err && !res.headersSent) res.status(404).end();
    });
  });

  const embeddedImages = async (id: string) => {
    const dir = queue.screenshotDir(id);
    const map = new Map<string, string>();
    for (const f of await fs.readdir(dir).catch(() => [] as string[])) {
      if (SHOT_RE.test(f)) map.set(f, `data:image/jpeg;base64,${(await fs.readFile(path.join(dir, f))).toString('base64')}`);
    }
    return (f: string) => map.get(f) ?? null;
  };
  const fileName = (rec: InvestigationRecord, ext: string) => {
    let host = 'website';
    try {
      host = new URL(rec.result?.siteUrl ?? rec.inputUrl).hostname.replace(/[^a-z0-9.-]/gi, '');
    } catch {
      /* default */
    }
    return `client-report-${host}-${rec.result?.date ?? 'report'}.${ext}`;
  };

  /** Client report: findings, evidence and impact — no fix instructions — with your branding and call to action. */
  const clientHtml = async (rec: InvestigationRecord & { result: NonNullable<InvestigationRecord['result']> }) =>
    renderClientReport(rec.result, { imageSrc: await embeddedImages(rec.id), branding: loadBranding(dataDir), clientName: rec.clientName ?? null });
  const REPORT_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; frame-ancestors 'self'";

  app.get('/api/investigations/:id/report.html', async (req, res) => {
    const rec = requireResult(req, res);
    if (!rec) return;
    const html = await clientHtml(rec);
    res.setHeader('Content-Security-Policy', REPORT_CSP);
    if (req.query.inline !== '1') res.setHeader('Content-Disposition', `attachment; filename="${fileName(rec, 'html')}"`);
    res.type('text/html').send(html);
  });

  /** Public, token-protected client report. Counts views so you know when a prospect opened it. */
  app.get('/r/:token', async (req, res) => {
    const token = String(req.params.token);
    const rec = /^[A-Za-z0-9_-]{32}$/.test(token) ? store.getByShareToken(token) : null;
    if (!rec || rec.status !== 'complete' || !rec.result) {
      res.status(404).type('text/plain').send('This report link is invalid or has been revoked.');
      return;
    }
    store.update(rec.id, { shareViews: (rec.shareViews ?? 0) + 1, shareLastViewed: new Date().toISOString() });
    const html = await clientHtml(rec as InvestigationRecord & { result: NonNullable<InvestigationRecord['result']> });
    res.setHeader('Content-Security-Policy', REPORT_CSP.replace("frame-ancestors 'self'", "frame-ancestors 'none'"));
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('Cache-Control', 'private, no-store');
    res.type('text/html').send(html);
  });

  /** Full analyst report for your own use (includes fix instructions and verification details). */
  app.get('/api/investigations/:id/analyst-report.html', async (req, res) => {
    const rec = requireResult(req, res);
    if (!rec) return;
    const html = renderReportDocument(rec.result, { imageSrc: await embeddedImages(rec.id), tracking: tracking(rec) });
    res.setHeader('Content-Security-Policy', REPORT_CSP);
    res.setHeader('Content-Disposition', `attachment; filename="${fileName(rec, 'html').replace('client-report', 'analyst-report')}"`);
    res.type('text/html').send(html);
  });

  app.get('/api/investigations/:id/report.pdf', async (req, res) => {
    const rec = requireResult(req, res);
    if (!rec) return;
    try {
      const pdf = await renderPdf(await clientHtml(rec), { cssPageSize: true });
      res.setHeader('Content-Disposition', `attachment; filename="${fileName(rec, 'pdf')}"`);
      res.type('application/pdf').send(pdf);
    } catch (e) {
      res.status(503).json({ error: `PDF export needs a Chromium browser: ${(e as Error).message.split('\n')[0]}` });
    }
  });

  // Malformed / oversized JSON bodies → JSON errors instead of HTML stack pages.
  app.use((err: Error & { status?: number; type?: string }, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    if (err.type === 'entity.too.large') res.status(413).json({ error: 'Request too large (logos must be under 400 KB).' });
    else if (err.type === 'entity.parse.failed') res.status(400).json({ error: 'Invalid JSON body' });
    else {
      console.error(err);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  return { app, store, queue };
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

/** Starts the HTTP server. Refuses to expose the dashboard on a network without a login. */
export async function startServer() {
  if (AUTH_PASSWORD && AUTH_PASSWORD.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`WII_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (!AUTH_PASSWORD && !LOOPBACK.has(SERVER_HOST)) {
    throw new Error(`Refusing to listen on ${SERVER_HOST} without a login. Set WII_PASSWORD (and optionally WII_USER).`);
  }
  if (!AUTH_PASSWORD && process.env.NODE_ENV === 'production') {
    console.warn('[security] NODE_ENV=production but WII_PASSWORD is not set: anyone who can reach this server can use the dashboard.');
  }
  const { app, store } = await createApp();
  const server = app.listen(SERVER_PORT, SERVER_HOST, () => {
    const shown = SERVER_HOST === '0.0.0.0' ? 'localhost' : SERVER_HOST;
    console.log(`Website Independent Investigator running at http://${shown}:${SERVER_PORT} (storage: ${store.kind}, data: ${DATA_DIR}, login: ${AUTH_PASSWORD ? 'on' : 'off'})`);
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  return server;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await startServer();
