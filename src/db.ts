import fs from 'node:fs';
import path from 'node:path';
import { SUMMARY_VERSION, summarize, type ReportSummary } from './report/summary.js';
import type { InvestigationResult, RecheckRecord, ReportStatus, StepKey, StepState } from './types.js';

export type JobStatus = 'queued' | 'running' | 'complete' | 'failed';

/** Sales pipeline stage of the prospect behind a report. */
export const LEAD_STATUSES = ['New', 'Contacted', 'Proposal sent', 'Won', 'Lost'] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export interface StepInfo {
  key: StepKey;
  label: string;
  state: StepState;
  detail?: string;
}

export interface InvestigationRecord {
  id: string;
  inputUrl: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  steps: StepInfo[];
  result: InvestigationResult | null;
  error: string | null;
  /** Open / In Progress (manual) — Resolved / Unable to Verify are only set from re-check evidence. */
  reportStatus: ReportStatus;
  /** When fix instructions were opened, and which method was shown. */
  fixLog: { at: string; method: string }[];
  /** Hidden from the default report list. */
  archived?: boolean;
  /** "Prepared for" name printed on the client report. */
  clientName?: string | null;
  /** Cached from `result` for fast lists and dashboard statistics. */
  summary?: ReportSummary | null;
  leadStatus?: LeadStatus;
  /** Private notes about the prospect (never shown on client reports). */
  notes?: string | null;
  /** Secret token for the public client-report link; null when not shared. */
  shareToken?: string | null;
  shareViews?: number;
  shareLastViewed?: string | null;
}

export type ListItem = Omit<InvestigationRecord, 'result' | 'steps' | 'fixLog' | 'notes'> & {
  archived: boolean;
  clientName: string | null;
  summary: ReportSummary | null;
  leadStatus: LeadStatus;
  shareToken: string | null;
  shareViews: number;
  shareLastViewed: string | null;
};

export interface ListQuery {
  page: number;
  pageSize: number;
  /** Matches URL or client name. */
  q?: string;
  view?: 'active' | 'archived' | 'all';
  status?: JobStatus;
  lead?: LeadStatus;
}

export interface Store {
  readonly kind: string;
  insert(rec: InvestigationRecord): void;
  update(id: string, patch: Partial<Omit<InvestigationRecord, 'id'>>): void;
  get(id: string): InvestigationRecord | null;
  /** Newest first (kept for older callers). */
  list(limit: number): ListItem[];
  listPage(q: ListQuery): { items: ListItem[]; total: number };
  /** Every record's lightweight fields — for dashboard statistics. */
  all(): ListItem[];
  /** Deletes the investigation and its re-checks. Returns false when it did not exist. */
  remove(id: string): boolean;
  getByShareToken(token: string): InvestigationRecord | null;
  insertRecheck(rec: RecheckRecord): void;
  updateRecheck(id: string, patch: Partial<Pick<RecheckRecord, 'state' | 'completedAt' | 'result' | 'error'>>): void;
  getRecheck(id: string): RecheckRecord | null;
  listRechecks(investigationId: string): RecheckRecord[];
  /** Mark jobs that were running when the process stopped as failed. */
  failInterrupted(): number;
}

interface Row {
  id: string;
  input_url: string;
  status: JobStatus;
  created_at: string;
  updated_at: string;
  steps: string;
  result: string | null;
  error: string | null;
  report_status: string | null;
  fix_log: string | null;
  archived: number | null;
  client_name: string | null;
  summary: string | null;
  lead_status: string | null;
  notes: string | null;
  share_token: string | null;
  share_views: number | null;
  share_last_viewed: string | null;
}

interface RecheckRow {
  id: string;
  investigation_id: string;
  seq: number;
  issue_id: string;
  state: RecheckRecord['state'];
  created_at: string;
  completed_at: string | null;
  result: string | null;
  error: string | null;
  fix_shown: string | null;
}

const toLead = (v: string | null | undefined): LeadStatus => ((LEAD_STATUSES as readonly string[]).includes(v ?? '') ? (v as LeadStatus) : 'New');

const safeSummary = (result: InvestigationResult | null): ReportSummary | null => {
  if (!result) return null;
  try {
    return summarize(result);
  } catch {
    return null;
  }
};

const fromRow = (r: Row): InvestigationRecord => ({
  id: r.id,
  inputUrl: r.input_url,
  status: r.status,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  steps: JSON.parse(r.steps),
  result: r.result ? JSON.parse(r.result) : null,
  error: r.error,
  reportStatus: (r.report_status as ReportStatus | null) ?? 'Open',
  fixLog: r.fix_log ? JSON.parse(r.fix_log) : [],
  archived: !!r.archived,
  clientName: r.client_name,
  summary: r.summary ? JSON.parse(r.summary) : null,
  leadStatus: toLead(r.lead_status),
  notes: r.notes,
  shareToken: r.share_token,
  shareViews: r.share_views ?? 0,
  shareLastViewed: r.share_last_viewed,
});

const fromRecheckRow = (r: RecheckRow): RecheckRecord => ({
  id: r.id,
  investigationId: r.investigation_id,
  seq: r.seq,
  issueId: r.issue_id,
  state: r.state,
  createdAt: r.created_at,
  completedAt: r.completed_at,
  result: r.result ? JSON.parse(r.result) : null,
  error: r.error,
  fixShown: r.fix_shown,
});

const clampQuery = (q: ListQuery) => ({
  page: Math.max(1, Math.floor(q.page) || 1),
  pageSize: Math.min(100, Math.max(1, Math.floor(q.pageSize) || 20)),
  q: (q.q ?? '').trim().slice(0, 200),
  view: q.view ?? 'active',
  status: q.status,
  lead: q.lead,
});

/** SQLite via Node's built-in `node:sqlite` (Node ≥ 22.5; needs --experimental-sqlite before 22.13). */
async function openSqlite(file: string): Promise<Store | null> {
  let mod: typeof import('node:sqlite');
  try {
    mod = await import('node:sqlite');
  } catch {
    return null;
  }
  const db = new mod.DatabaseSync(file);
  db.exec(`CREATE TABLE IF NOT EXISTS investigations (
    id TEXT PRIMARY KEY,
    input_url TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    steps TEXT NOT NULL,
    result TEXT,
    error TEXT
  ); CREATE INDEX IF NOT EXISTS idx_inv_created ON investigations(created_at);
  CREATE TABLE IF NOT EXISTS rechecks (
    id TEXT PRIMARY KEY,
    investigation_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    issue_id TEXT NOT NULL,
    state TEXT NOT NULL,
    created_at TEXT NOT NULL,
    completed_at TEXT,
    result TEXT,
    error TEXT,
    fix_shown TEXT
  ); CREATE INDEX IF NOT EXISTS idx_rechecks_inv ON rechecks(investigation_id, seq);`);
  // Migrate databases created by earlier versions.
  const existing = new Set((db.prepare('PRAGMA table_info(investigations)').all() as { name: string }[]).map((c) => c.name));
  if (!existing.has('report_status')) db.exec("ALTER TABLE investigations ADD COLUMN report_status TEXT NOT NULL DEFAULT 'Open'");
  if (!existing.has('fix_log')) db.exec('ALTER TABLE investigations ADD COLUMN fix_log TEXT');
  if (!existing.has('archived')) db.exec('ALTER TABLE investigations ADD COLUMN archived INTEGER NOT NULL DEFAULT 0');
  if (!existing.has('client_name')) db.exec('ALTER TABLE investigations ADD COLUMN client_name TEXT');
  if (!existing.has('summary')) db.exec('ALTER TABLE investigations ADD COLUMN summary TEXT');
  if (!existing.has('lead_status')) db.exec("ALTER TABLE investigations ADD COLUMN lead_status TEXT NOT NULL DEFAULT 'New'");
  if (!existing.has('notes')) db.exec('ALTER TABLE investigations ADD COLUMN notes TEXT');
  if (!existing.has('share_token')) db.exec('ALTER TABLE investigations ADD COLUMN share_token TEXT');
  if (!existing.has('share_views')) db.exec('ALTER TABLE investigations ADD COLUMN share_views INTEGER NOT NULL DEFAULT 0');
  if (!existing.has('share_last_viewed')) db.exec('ALTER TABLE investigations ADD COLUMN share_last_viewed TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_inv_share ON investigations(share_token) WHERE share_token IS NOT NULL');
  db.exec("UPDATE rechecks SET state='failed', error='Interrupted by server restart' WHERE state='running'");
  // Back-fill summaries for records completed before summaries existed.
  for (const row of db.prepare(`SELECT id, result FROM investigations WHERE result IS NOT NULL AND (summary IS NULL OR summary NOT LIKE '%"v":${SUMMARY_VERSION},%')`).all() as { id: string; result: string }[]) {
    const s = safeSummary(JSON.parse(row.result));
    if (s) db.prepare('UPDATE investigations SET summary = ? WHERE id = ?').run(JSON.stringify(s), row.id);
  }

  const cols: Record<string, string> = {
    inputUrl: 'input_url', status: 'status', createdAt: 'created_at', updatedAt: 'updated_at', steps: 'steps', result: 'result', error: 'error',
    reportStatus: 'report_status', fixLog: 'fix_log', archived: 'archived', clientName: 'client_name', summary: 'summary',
    leadStatus: 'lead_status', notes: 'notes', shareToken: 'share_token', shareViews: 'share_views', shareLastViewed: 'share_last_viewed',
  };
  const recheckCols: Record<string, string> = { state: 'state', completedAt: 'completed_at', result: 'result', error: 'error' };
  const toSql = (v: unknown) => (v === null || v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : typeof v === 'string' ? v : JSON.stringify(v));
  const LIGHT = 'id,input_url,status,created_at,updated_at,error,report_status,archived,client_name,summary,lead_status,share_token,share_views,share_last_viewed';
  const toItem = (r: Row): ListItem => ({
    id: r.id,
    inputUrl: r.input_url,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    error: r.error,
    reportStatus: (r.report_status as ReportStatus | null) ?? 'Open',
    archived: !!r.archived,
    clientName: r.client_name,
    summary: r.summary ? JSON.parse(r.summary) : null,
    leadStatus: toLead(r.lead_status),
    shareToken: r.share_token,
    shareViews: r.share_views ?? 0,
    shareLastViewed: r.share_last_viewed,
  });
  const where = (q: ReturnType<typeof clampQuery>) => {
    const parts: string[] = [];
    const args: (string | number)[] = [];
    if (q.view === 'active') parts.push('archived = 0');
    else if (q.view === 'archived') parts.push('archived = 1');
    if (q.status) {
      parts.push('status = ?');
      args.push(q.status);
    }
    if (q.lead) {
      parts.push('lead_status = ?');
      args.push(q.lead);
    }
    if (q.q) {
      parts.push("(input_url LIKE ? ESCAPE '\\' OR client_name LIKE ? ESCAPE '\\')");
      const like = `%${q.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      args.push(like, like);
    }
    return { sql: parts.length ? `WHERE ${parts.join(' AND ')}` : '', args };
  };

  const store: Store = {
    kind: 'sqlite',
    insert(rec) {
      db.prepare('INSERT INTO investigations (id,input_url,status,created_at,updated_at,steps,result,error,report_status,fix_log,archived,client_name,summary,lead_status,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
        rec.id, rec.inputUrl, rec.status, rec.createdAt, rec.updatedAt, JSON.stringify(rec.steps), rec.result ? JSON.stringify(rec.result) : null, rec.error, rec.reportStatus,
        JSON.stringify(rec.fixLog), rec.archived ? 1 : 0, rec.clientName ?? null, toSql(rec.summary ?? safeSummary(rec.result)), rec.leadStatus ?? 'New', rec.notes ?? null,
      );
    },
    update(id, patch) {
      const full: Record<string, unknown> = { ...patch, updatedAt: new Date().toISOString() };
      if (patch.result !== undefined && patch.summary === undefined) full.summary = safeSummary(patch.result);
      const sets: string[] = [];
      const values: (string | number | null)[] = [];
      for (const [k, v] of Object.entries(full)) {
        const col = cols[k];
        if (!col) continue;
        sets.push(`${col} = ?`);
        values.push(toSql(v));
      }
      db.prepare(`UPDATE investigations SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
    },
    get(id) {
      const row = db.prepare('SELECT * FROM investigations WHERE id = ?').get(id) as Row | undefined;
      return row ? fromRow(row) : null;
    },
    list(limit) {
      return store.listPage({ page: 1, pageSize: limit, view: 'all' }).items;
    },
    listPage(query) {
      const q = clampQuery(query);
      const w = where(q);
      const total = Number((db.prepare(`SELECT COUNT(*) AS n FROM investigations ${w.sql}`).get(...w.args) as { n: number }).n);
      const rows = db.prepare(`SELECT ${LIGHT} FROM investigations ${w.sql} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...w.args, q.pageSize, (q.page - 1) * q.pageSize) as unknown as Row[];
      return { items: rows.map(toItem), total };
    },
    all() {
      return (db.prepare(`SELECT ${LIGHT} FROM investigations ORDER BY created_at DESC`).all() as unknown as Row[]).map(toItem);
    },
    getByShareToken(token) {
      const row = db.prepare('SELECT * FROM investigations WHERE share_token = ?').get(token) as Row | undefined;
      return row ? fromRow(row) : null;
    },
    remove(id) {
      db.prepare('DELETE FROM rechecks WHERE investigation_id = ?').run(id);
      return Number(db.prepare('DELETE FROM investigations WHERE id = ?').run(id).changes) > 0;
    },
    insertRecheck(rec) {
      db.prepare('INSERT INTO rechecks (id,investigation_id,seq,issue_id,state,created_at,completed_at,result,error,fix_shown) VALUES (?,?,?,?,?,?,?,?,?,?)').run(
        rec.id, rec.investigationId, rec.seq, rec.issueId, rec.state, rec.createdAt, rec.completedAt, toSql(rec.result), rec.error, rec.fixShown,
      );
    },
    updateRecheck(id, patch) {
      const sets: string[] = [];
      const values: (string | number | null)[] = [];
      for (const [k, v] of Object.entries(patch)) {
        const col = recheckCols[k];
        if (!col) continue;
        sets.push(`${col} = ?`);
        values.push(toSql(v));
      }
      if (sets.length) db.prepare(`UPDATE rechecks SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
    },
    getRecheck(id) {
      const row = db.prepare('SELECT * FROM rechecks WHERE id = ?').get(id) as RecheckRow | undefined;
      return row ? fromRecheckRow(row) : null;
    },
    listRechecks(investigationId) {
      return (db.prepare('SELECT * FROM rechecks WHERE investigation_id = ? ORDER BY seq').all(investigationId) as unknown as RecheckRow[]).map(fromRecheckRow);
    },
    failInterrupted() {
      const res = db.prepare("UPDATE investigations SET status='failed', error='Interrupted by server restart' WHERE status IN ('queued','running')").run();
      return Number(res.changes);
    },
  };
  return store;
}

/** Fallback: one JSON file per investigation. */
function openJsonStore(dir: string): Store {
  fs.mkdirSync(dir, { recursive: true });
  const file = (id: string) => path.join(dir, `${id}.json`);
  const read = (id: string): InvestigationRecord | null => {
    try {
      const rec = JSON.parse(fs.readFileSync(file(id), 'utf8'));
      return { reportStatus: 'Open', fixLog: [], archived: false, clientName: null, notes: null, shareToken: null, shareViews: 0, shareLastViewed: null, ...rec, leadStatus: toLead(rec.leadStatus), summary: rec.summary ?? safeSummary(rec.result) };
    } catch {
      return null;
    }
  };
  const recheckDir = path.join(dir, 'rechecks');
  fs.mkdirSync(recheckDir, { recursive: true });
  const recheckFile = (id: string) => path.join(recheckDir, `${id}.json`);
  const readRecheck = (id: string): RecheckRecord | null => {
    try {
      return JSON.parse(fs.readFileSync(recheckFile(id), 'utf8'));
    } catch {
      return null;
    }
  };
  const writeRecheck = (rec: RecheckRecord) => fs.writeFileSync(recheckFile(rec.id), JSON.stringify(rec));
  const write = (rec: InvestigationRecord) => fs.writeFileSync(file(rec.id), JSON.stringify({ ...rec, summary: rec.summary ?? safeSummary(rec.result) }));
  const records = () =>
    fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => read(f.slice(0, -5)))
      .filter((r): r is InvestigationRecord => !!r)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const toItem = ({ result: _r, steps: _s, fixLog: _f, notes: _n, ...rest }: InvestigationRecord): ListItem => ({
    ...rest,
    archived: !!rest.archived,
    clientName: rest.clientName ?? null,
    summary: rest.summary ?? null,
    leadStatus: toLead(rest.leadStatus),
    shareToken: rest.shareToken ?? null,
    shareViews: rest.shareViews ?? 0,
    shareLastViewed: rest.shareLastViewed ?? null,
  });
  const store: Store = {
    kind: 'json-files',
    insert: write,
    update(id, patch) {
      const rec = read(id);
      if (!rec) return;
      const next = { ...rec, ...patch, updatedAt: new Date().toISOString() };
      if (patch.result !== undefined && patch.summary === undefined) next.summary = safeSummary(patch.result);
      write(next);
    },
    get: read,
    list(limit) {
      return records().slice(0, limit).map(toItem);
    },
    listPage(query) {
      const q = clampQuery(query);
      const needle = q.q.toLowerCase();
      const filtered = records().filter(
        (r) =>
          (q.view === 'all' || (q.view === 'archived') === !!r.archived) &&
          (!q.status || r.status === q.status) &&
          (!q.lead || toLead(r.leadStatus) === q.lead) &&
          (!needle || r.inputUrl.toLowerCase().includes(needle) || (r.clientName ?? '').toLowerCase().includes(needle)),
      );
      return { items: filtered.slice((q.page - 1) * q.pageSize, q.page * q.pageSize).map(toItem), total: filtered.length };
    },
    all() {
      return records().map(toItem);
    },
    getByShareToken(token) {
      return records().find((r) => r.shareToken === token) ?? null;
    },
    remove(id) {
      if (!fs.existsSync(file(id))) return false;
      fs.rmSync(file(id));
      for (const r of store.listRechecks(id)) fs.rmSync(recheckFile(r.id), { force: true });
      return true;
    },
    insertRecheck: writeRecheck,
    updateRecheck(id, patch) {
      const rec = readRecheck(id);
      if (rec) writeRecheck({ ...rec, ...patch });
    },
    getRecheck: readRecheck,
    listRechecks(investigationId) {
      return fs
        .readdirSync(recheckDir)
        .map((f) => readRecheck(f.slice(0, -5)))
        .filter((r): r is RecheckRecord => !!r && r.investigationId === investigationId)
        .sort((a, b) => a.seq - b.seq);
    },
    failInterrupted() {
      let n = 0;
      for (const r of records()) {
        if (r.status === 'queued' || r.status === 'running') {
          write({ ...r, status: 'failed', error: 'Interrupted by server restart' });
          n++;
        }
      }
      return n;
    },
  };
  return store;
}

export async function openStore(dataDir: string): Promise<Store> {
  fs.mkdirSync(dataDir, { recursive: true });
  return (await openSqlite(path.join(dataDir, 'investigations.sqlite'))) ?? openJsonStore(path.join(dataDir, 'investigations'));
}
