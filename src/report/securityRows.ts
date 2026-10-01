import { compareVersions } from '../analyze/securityscan.js';
import type { InvestigationResult } from '../types.js';

export type RowStatus = 'ok' | 'warn' | 'bad' | 'na';

export interface SecurityRow {
  key: string;
  label: string;
  status: RowStatus;
  value: string;
}

const plural = (n: number, s: string, p = `${s}s`) => `${n} ${n === 1 ? s : p}`;

/** One status line per security area — shared by the client report and the dashboard. */
export function securityRows(r: InvestigationResult): SecurityRow[] {
  const s = r.securityScan;
  const rows: SecurityRow[] = [];
  const notScanned = 'Not scanned — re-run the audit to include this check';

  if (s) {
    const verified = s.malware.filter((m) => m.confidence !== 'Low');
    const high = verified.filter((m) => m.confidence === 'High');
    rows.push({
      key: 'malware',
      label: 'Malware & injected code',
      status: high.length ? 'bad' : verified.length ? 'warn' : 'ok',
      value: verified.length ? `${plural(verified.length, 'suspicious signature')} found (${[...new Set(verified.map((m) => m.type.replace(/-/g, ' ')))].join(', ')})` : `No known malware signatures on ${plural(s.pagesScanned, 'page')} scanned`,
    });
    rows.push({
      key: 'blacklist',
      label: 'Blacklist status (Google Safe Browsing)',
      status: s.blacklist.matches.length ? 'bad' : s.blacklist.checked ? 'ok' : 'na',
      value: s.blacklist.matches.length ? `Listed as ${[...new Set(s.blacklist.matches.map((m) => m.threat))].join(', ')}` : s.blacklist.checked ? 'Not blacklisted' : (s.blacklist.note ?? 'Not checked'),
    });
    rows.push({
      key: 'cloaking',
      label: 'Hidden spam shown to Google (cloaking)',
      status: s.cloaking.different ? 'bad' : s.cloaking.checked ? 'ok' : 'na',
      value: s.cloaking.different ? 'Google receives different content than visitors' : s.cloaking.checked ? 'Google sees the same content as visitors' : (s.cloaking.note ?? 'Not checked'),
    });
    const t = s.tls;
    rows.push({
      key: 'ssl',
      label: 'SSL certificate',
      status: !r.siteUrl.startsWith('https:') ? 'bad' : !t.checked ? 'na' : t.authorized === false || (t.daysLeft ?? 99) < 0 ? 'bad' : (t.daysLeft ?? 99) < 30 || t.legacyProtocols.length ? 'warn' : 'ok',
      value: !r.siteUrl.startsWith('https:')
        ? 'Site does not use HTTPS'
        : !t.checked
          ? (t.note ?? 'Not checked')
          : t.authorized === false
            ? `Not trusted: ${t.authError}`
            : `Valid until ${t.validTo} (${plural(t.daysLeft ?? 0, 'day')} left)${t.legacyProtocols.length ? ` · accepts outdated ${t.legacyProtocols.join('/')}` : ''}`,
    });
    const e = s.email;
    const enforcing = e.dmarcPolicy === 'quarantine' || e.dmarcPolicy === 'reject';
    const spfOk = !!e.spf && !/[+?]all\b/i.test(e.spf);
    rows.push({
      key: 'email',
      label: 'Email spoofing protection (SPF / DMARC)',
      status: !e.checked || !e.hasMx ? 'na' : spfOk && enforcing ? 'ok' : !e.dmarc && !spfOk ? 'bad' : 'warn',
      value: !e.checked ? (e.note ?? 'Not checked') : !e.hasMx ? 'Domain does not receive email' : `SPF ${e.spf ? (spfOk ? 'present' : 'too permissive') : 'missing'} · DMARC ${e.dmarc ? `p=${e.dmarcPolicy ?? '?'}` : 'missing'}`,
    });
    const sw = s.software;
    const outdated = [...sw.plugins.filter((p) => compareVersions(p.installed, p.latest) < 0), ...(sw.theme && compareVersions(sw.theme.installed, sw.theme.latest) < 0 ? [sw.theme] : [])];
    const coreOld = !!sw.core && compareVersions(sw.core.installed, sw.core.latest) < 0;
    rows.push({
      key: 'software',
      label: 'Software updates (WordPress core, plugins, theme)',
      status: !sw.checked ? 'na' : coreOld && sw.core!.installed.split('.')[0] !== sw.core!.latest.split('.')[0] ? 'bad' : coreOld || outdated.length ? 'warn' : sw.core || sw.plugins.length ? 'ok' : 'na',
      value: !sw.checked
        ? (sw.note ?? 'Not checked')
        : [coreOld ? `WordPress ${sw.core!.installed} (latest ${sw.core!.latest})` : sw.core ? `WordPress ${sw.core.installed} is current` : 'WordPress version hidden', outdated.length ? `${plural(outdated.length, 'plugin/theme', 'plugins/themes')} outdated` : sw.plugins.length ? 'detected plugins up to date' : ''].filter(Boolean).join(' · '),
    });
  } else {
    for (const [key, label] of [['malware', 'Malware & injected code'], ['blacklist', 'Blacklist status'], ['ssl', 'SSL certificate'], ['email', 'Email spoofing protection']] as const) {
      rows.push({ key, label, status: 'na', value: notScanned });
    }
  }

  const headerCandidates = r.candidates.find((c) => c.id === 'security-headers');
  const missing = headerCandidates ? (/Missing security headers: (.*)$/.exec(headerCandidates.title)?.[1]?.split(', ').length ?? 0) : 0;
  const present = 6 - missing;
  rows.push({ key: 'headers', label: 'Browser security headers', status: present >= 4 ? 'ok' : present >= 2 ? 'warn' : 'bad', value: `${present} of 6 recommended headers present` });
  const exposed = r.candidates.find((c) => c.id === 'sensitive-file');
  const listing = r.candidates.find((c) => c.id === 'directory-listing');
  rows.push({
    key: 'files',
    label: 'Exposed sensitive files & folders',
    status: exposed ? 'bad' : listing ? 'warn' : 'ok',
    value: exposed ? 'Sensitive files are publicly downloadable' : listing ? 'Folder listing is enabled' : 'None found (.env, .git, config backups, debug logs, folder listings)',
  });
  return rows;
}

export function securityVerdict(rows: SecurityRow[]): { status: 'clean' | 'warn' | 'threat'; label: string } {
  const threat = rows.some((r) => (r.key === 'malware' || r.key === 'blacklist' || r.key === 'cloaking') && r.status === 'bad');
  if (threat) return { status: 'threat', label: 'Security threats detected' };
  if (rows.some((r) => r.status === 'bad' || r.status === 'warn')) return { status: 'warn', label: 'No malware found — security weaknesses need attention' };
  return { status: 'clean', label: 'No malware or security problems found' };
}
