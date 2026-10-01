import crypto from 'node:crypto';
import path from 'node:path';
import type { Store, StepInfo } from './db.js';
import { investigate, InvestigationInputError, type InvestigateOptions } from './investigate.js';
import { recheckIssue, type RecheckOptions } from './recheck/engine.js';
import type { RecheckRecord, ReportStatus, ScanFocus, StepKey } from './types.js';

/** User-facing refusal to start a re-check (not complete, no issue, already running, busy). */
export class RecheckRefused extends Error {}

export const STEPS: { key: StepKey; label: string }[] = [
  { key: 'discover', label: 'Discovering website' },
  { key: 'homepage', label: 'Homepage' },
  { key: 'robots', label: 'Robots.txt' },
  { key: 'sitemap', label: 'Sitemap' },
  { key: 'links', label: 'Internal links' },
  { key: 'seo', label: 'Technical SEO' },
  { key: 'performance', label: 'Performance' },
  { key: 'mobile', label: 'Mobile' },
  { key: 'javascript', label: 'JavaScript' },
  { key: 'security', label: 'Security' },
  { key: 'wordpress', label: 'WordPress signals' },
  { key: 'analysis', label: 'Selecting primary issue' },
];

export function initialSteps(): StepInfo[] {
  return STEPS.map((s) => ({ ...s, state: 'pending' }));
}

/**
 * In-process background job queue with bounded concurrency.
 * Jobs survive only as records: an interrupted job is marked failed on restart.
 */
export class InvestigationQueue {
  private readonly pending: string[] = [];
  private running = 0;

  constructor(
    private readonly store: Store,
    private readonly dataDir: string,
    private readonly concurrency: number,
    private readonly options: Omit<InvestigateOptions, 'screenshotDir' | 'onProgress'> = {},
    private readonly recheckOptions: Omit<RecheckOptions, 'screenshotDir'> = {},
    /** Options read at job start (e.g. an API key changed in Settings). */
    private readonly dynamicOptions?: () => Partial<InvestigateOptions>,
  ) {}

  private readonly activeRechecks = new Set<string>();

  /** Per-job focus (full audit or security-only). In memory: a restart fails queued jobs anyway. */
  private readonly focus = new Map<string, ScanFocus>();

  enqueue(inputUrl: string, clientName: string | null = null, focus: ScanFocus = 'full'): string {
    const id = crypto.randomUUID();
    this.focus.set(id, focus);
    const now = new Date().toISOString();
    this.store.insert({ id, inputUrl, status: 'queued', createdAt: now, updatedAt: now, steps: initialSteps(), result: null, error: null, reportStatus: 'Open', fixLog: [], archived: false, clientName });
    this.pending.push(id);
    this.pump();
    return id;
  }

  get stats() {
    return { queued: this.pending.length, running: this.running };
  }

  /** True while the investigation is queued, running, or being re-checked (it must not be deleted then). */
  isBusy(id: string): boolean {
    const status = this.store.get(id)?.status;
    return this.pending.includes(id) || status === 'running' || status === 'queued' || this.activeRechecks.has(id);
  }

  screenshotDir(id: string): string {
    return path.join(this.dataDir, 'screenshots', id);
  }

  /**
   * Starts a targeted re-check of the investigation's primary issue in the background.
   * Only fresh evidence may move the report to Resolved / Unable to Verify.
   */
  enqueueRecheck(investigationId: string): RecheckRecord {
    const inv = this.store.get(investigationId);
    if (!inv || inv.status !== 'complete' || !inv.result) throw new RecheckRefused('The investigation is not complete yet.');
    const primary = inv.result.primary;
    if (!primary) throw new RecheckRefused('There is no primary issue to re-check.');
    if (this.activeRechecks.has(investigationId)) throw new RecheckRefused('A re-check of this issue is already running.');
    if (this.activeRechecks.size >= Math.max(1, this.concurrency)) throw new RecheckRefused('The re-check engine is busy. Please try again in a minute.');
    const previous = this.store.listRechecks(investigationId);
    const lastFix = inv.fixLog.at(-1);
    const rec: RecheckRecord = {
      id: crypto.randomUUID(),
      investigationId,
      seq: (previous.at(-1)?.seq ?? 0) + 1,
      issueId: primary.id,
      state: 'running',
      createdAt: new Date().toISOString(),
      completedAt: null,
      result: null,
      error: null,
      fixShown: lastFix ? `${lastFix.method} (opened ${lastFix.at})` : null,
    };
    this.store.insertRecheck(rec);
    this.activeRechecks.add(investigationId);
    const result = inv.result;
    void recheckIssue(result, { ...this.recheckOptions, screenshotDir: path.join(this.screenshotDir(investigationId), `recheck-${rec.seq}`) })
      .then((r) => {
        this.store.updateRecheck(rec.id, { state: 'complete', completedAt: new Date().toISOString(), result: r });
        const current = this.store.get(investigationId)?.reportStatus ?? 'Open';
        const next: ReportStatus = r.status === 'resolved' ? 'Resolved' : r.status === 'unable-to-verify' ? 'Unable to Verify' : current === 'In Progress' ? 'In Progress' : 'Open';
        this.store.update(investigationId, { reportStatus: next });
      })
      .catch((e: Error) => {
        console.error(`[recheck] ${rec.id}`, e);
        this.store.updateRecheck(rec.id, { state: 'failed', completedAt: new Date().toISOString(), error: `Re-check failed: ${e.message}` });
      })
      .finally(() => this.activeRechecks.delete(investigationId));
    return rec;
  }

  private pump(): void {
    while (this.running < this.concurrency && this.pending.length) {
      const id = this.pending.shift()!;
      this.running++;
      this.run(id).finally(() => {
        this.running--;
        this.pump();
      });
    }
  }

  private async run(id: string): Promise<void> {
    const rec = this.store.get(id);
    if (!rec) return;
    const steps = rec.steps;
    let lastWrite = 0;
    const persistSteps = (force = false) => {
      // Throttle progress writes; the UI polls about once a second.
      if (!force && Date.now() - lastWrite < 400) return;
      lastWrite = Date.now();
      this.store.update(id, { steps });
    };
    this.store.update(id, { status: 'running' });
    try {
      const dynamic = this.dynamicOptions?.() ?? {};
      const focus = this.focus.get(id) ?? 'full';
      this.focus.delete(id);
      const result = await investigate(rec.inputUrl, {
        ...this.options,
        ...dynamic,
        focus,
        screenshotDir: this.screenshotDir(id),
        onProgress: (key, state, detail) => {
          const s = steps.find((x) => x.key === key);
          if (!s) return;
          s.state = state;
          if (detail !== undefined) s.detail = detail.slice(0, 200);
          persistSteps(state !== 'running');
        },
      });
      for (const s of steps) if (s.state === 'pending' || s.state === 'running') s.state = 'done';
      this.store.update(id, { status: 'complete', steps, result });
    } catch (e) {
      const message = e instanceof InvestigationInputError ? e.message : `Investigation failed: ${(e as Error).message}`;
      if (!(e instanceof InvestigationInputError)) console.error(`[queue] ${id}`, e);
      for (const s of steps) if (s.state === 'running') s.state = 'failed';
      this.store.update(id, { status: 'failed', steps, error: message });
    }
  }
}
