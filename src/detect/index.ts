import type { Candidate } from '../types.js';
import type { InvestigationContext } from './context.js';
import { commerce } from './commerce.js';
import { assetsAndJs, mobile } from './frontend.js';
import type { Detector } from './helpers.js';
import { homepageStatus, noindex, robotsBlocking, soft404 } from './indexing.js';
import { brokenLinks, sitemap } from './links.js';
import { malware, software, tlsAndEmail } from './malware.js';
import { onPage } from './onpage.js';
import { performance } from './performance.js';
import { canonical, redirects } from './redirects.js';
import { security } from './security.js';

export const DETECTORS: Record<string, Detector> = {
  homepageStatus,
  noindex,
  robotsBlocking,
  redirects,
  canonical,
  brokenLinks,
  sitemap,
  soft404,
  assetsAndJs,
  mobile,
  performance,
  security,
  malware,
  tlsAndEmail,
  software,
  commerce,
  onPage,
};

export function runDetectors(ctx: InvestigationContext): { candidates: Candidate[]; errors: string[] } {
  const candidates: Candidate[] = [];
  const errors: string[] = [];
  for (const [name, detect] of Object.entries(DETECTORS)) {
    try {
      candidates.push(...detect(ctx));
    } catch (e) {
      // A detector bug must never break the investigation; it only loses that detector's findings.
      errors.push(`${name}: ${(e as Error).message}`);
    }
  }
  return { candidates, errors };
}
