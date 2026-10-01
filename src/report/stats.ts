import { LEAD_STATUSES, type LeadStatus, type ListItem } from '../db.js';

export interface DashboardStats {
  reports: number;
  completed: number;
  archived: number;
  sites: number;
  issues: { total: number; High: number; Medium: number; Low: number };
  averageScore: number | null;
  wordpressSites: number;
  last7Days: number;
  /** Most frequent verified issue types across all reports (sales talking points). */
  commonIssues: { id: string; title: string; count: number; severity: string }[];
  /** Report count per day for the last 14 days (oldest first). */
  activity: { date: string; count: number }[];
  /** Reports with the lowest scores — the hottest leads. */
  opportunities: { id: string; host: string; score: number; high: number; clientName: string | null; createdAt: string; leadStatus: LeadStatus; security: string | null }[];
  /** Reports per sales stage (active reports). */
  pipeline: Record<LeadStatus, number>;
  /** Sites whose latest audit found malware, blacklisting or cloaking. */
  securityThreats: number;
  /** Shared reports and how many times prospects opened them. */
  shared: { links: number; views: number };
}

export function computeStats(items: ListItem[], now = new Date()): DashboardStats {
  const done = items.filter((i) => i.status === 'complete' && i.summary);
  const active = done.filter((i) => !i.archived);
  const issues = { total: 0, High: 0, Medium: 0, Low: 0 };
  const byType = new Map<string, { id: string; title: string; count: number; severity: string }>();
  for (const i of active) {
    const s = i.summary!;
    issues.High += s.counts.High;
    issues.Medium += s.counts.Medium;
    issues.Low += s.counts.Low;
    for (const issue of s.issues) {
      const e = byType.get(issue.id) ?? { id: issue.id, title: issue.title.replace(/^\d+\s+/, '').replace(/\(\d+(\.\d+)?\s*(ms|s|KB|MB|px)[^)]*\)/g, '').trim(), count: 0, severity: issue.severity };
      e.count++;
      byType.set(issue.id, e);
    }
  }
  issues.total = issues.High + issues.Medium + issues.Low;
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const activity: DashboardStats['activity'] = [];
  for (let k = 13; k >= 0; k--) {
    const d = new Date(now.getTime() - k * 86_400_000);
    activity.push({ date: day(d), count: 0 });
  }
  const idx = new Map(activity.map((a, i) => [a.date, i]));
  for (const i of items) {
    const pos = idx.get(i.createdAt.slice(0, 10));
    if (pos !== undefined) activity[pos]!.count++;
  }
  return {
    reports: items.length,
    completed: done.length,
    archived: items.filter((i) => i.archived).length,
    sites: new Set(done.map((i) => i.summary!.host)).size,
    issues,
    averageScore: active.length ? Math.round(active.reduce((a, i) => a + i.summary!.score, 0) / active.length) : null,
    wordpressSites: new Set(active.filter((i) => i.summary!.wordpress).map((i) => i.summary!.host)).size,
    last7Days: items.filter((i) => now.getTime() - Date.parse(i.createdAt) < 7 * 86_400_000).length,
    commonIssues: [...byType.values()].sort((a, b) => b.count - a.count).slice(0, 6),
    activity,
    // One lead per website: its most recent audit (items are newest first).
    // (a site whose latest audit is clean is not a lead).
    opportunities: active
      .filter((i, idx, arr) => arr.findIndex((x) => x.summary!.host === i.summary!.host) === idx)
      .filter((i) => i.summary!.counts.verified > 0)
      .sort((a, b) => a.summary!.score - b.summary!.score)
      .slice(0, 5)
      .map((i) => ({ id: i.id, host: i.summary!.host, score: i.summary!.score, high: i.summary!.counts.High, clientName: i.clientName, createdAt: i.createdAt, leadStatus: i.leadStatus, security: i.summary!.security ?? null })),
    pipeline: Object.fromEntries(LEAD_STATUSES.map((l) => [l, active.filter((i) => i.leadStatus === l).length])) as Record<LeadStatus, number>,
    securityThreats: active.filter((i, idx, arr) => arr.findIndex((x) => x.summary!.host === i.summary!.host) === idx && i.summary!.security === 'threat').length,
    shared: { links: items.filter((i) => i.shareToken).length, views: items.reduce((a, i) => a + (i.shareViews ?? 0), 0) },
  };
}
