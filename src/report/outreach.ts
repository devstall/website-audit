/**
 * Cold-outreach email draft built from verified findings. Plain text only; it is copied by the user
 * (nothing is ever sent by this tool). Like the client report, it never reveals how to fix anything.
 */
import type { Branding } from '../branding.js';
import type { InvestigationResult, Level } from '../types.js';
import { securityRows, securityVerdict } from './securityRows.js';
import { summarize, verifiedFindings } from './summary.js';

const ORDER: Record<Level, number> = { High: 0, Medium: 1, Low: 2 };

export interface OutreachDraft {
  subject: string;
  body: string;
  followUp: string;
}

export function buildOutreach(r: InvestigationResult, b: Branding, opts: { clientName?: string | null; shareUrl?: string | null }): OutreachDraft {
  const s = summarize(r);
  const findings = verifiedFindings(r).sort((a, c) => ORDER[a.severity] - ORDER[c.severity]);
  const verdict = securityVerdict(securityRows(r));
  const greeting = opts.clientName ? `Hi ${opts.clientName} team,` : 'Hi there,';
  const signer = [b.consultantName || b.agencyName, b.consultantName ? b.agencyName : '', b.phone, b.website].filter(Boolean).join('\n');
  const top = findings.slice(0, 3).map((c) => `• ${c.title} — ${c.whyItMatters.split(/(?<=\.)\s/)[0]}`);

  const subject =
    verdict.status === 'threat'
      ? `Security warning for ${s.host}`
      : s.counts.High
        ? `${s.counts.High} urgent issue${s.counts.High === 1 ? '' : 's'} found on ${s.host}`
        : findings.length
          ? `Quick website audit of ${s.host} (${findings.length} findings)`
          : `Your website ${s.host} — audit results`;

  const lines = [
    greeting,
    '',
    `I ran an independent technical audit of ${s.host} and wanted to share what I found${verdict.status === 'threat' ? ' — including signs that the site may be compromised' : ''}.`,
    '',
  ];
  if (findings.length) {
    lines.push(`Health score: ${s.score}/100. The most important issue${top.length > 1 ? 's' : ''}:`, ...top, '');
    if (findings.length > 3) lines.push(`There are ${findings.length - 3} more issues in the full report.`, '');
  } else {
    lines.push('The site is in good shape overall — I only found minor opportunities, which are in the report.', '');
  }
  if (opts.shareUrl) lines.push(`Full report with evidence and screenshots: ${opts.shareUrl}`, '');
  else lines.push('I have attached the full report with evidence and screenshots.', '');
  lines.push(
    `Every issue was verified on your live site. I can fix these for you${b.offer ? ` — happy to walk you through it on a ${b.offer.toLowerCase().replace(/^free /, 'free ')}` : ''}.`,
    b.bookingUrl ? `You can pick a time here: ${b.bookingUrl}` : 'Would you be open to a short call this week?',
    '',
    'Best regards,',
    signer,
  );

  const followUp = [
    greeting,
    '',
    `Just following up on the audit of ${s.host} I sent over. ${findings[0] ? `The most pressing item was “${findings[0].title}”.` : ''}`,
    '',
    'Issues like these usually get worse over time (rankings, security, lost enquiries). If it helps, I can fix the top items first so you can see the difference.',
    b.bookingUrl ? `Grab a time here: ${b.bookingUrl}` : 'Would a quick 15-minute call work?',
    '',
    'Best,',
    b.consultantName || b.agencyName,
  ].join('\n');

  return { subject, body: lines.join('\n').replace(/\n{3,}/g, '\n\n'), followUp };
}
