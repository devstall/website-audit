import fs from 'node:fs';
import path from 'node:path';

/** Your agency / consultant details, printed on every client report and used for the "hire us" call to action. */
export interface Branding {
  agencyName: string;
  consultantName: string;
  tagline: string;
  email: string;
  phone: string;
  website: string;
  /** Calendly or similar booking link. */
  bookingUrl: string;
  /** data:image/(png|jpeg|webp);base64,… — null for a text logo. */
  logo: string | null;
  /** #rrggbb */
  accent: string;
  ctaHeadline: string;
  ctaMessage: string;
  /** e.g. "Free 15-minute consultation" */
  offer: string;
  /** Show the 0–100 health score and grade on client reports. */
  showScore: boolean;
}

export const DEFAULT_BRANDING: Branding = {
  agencyName: 'Your Agency',
  consultantName: '',
  tagline: 'Technical SEO & WordPress performance',
  email: '',
  phone: '',
  website: '',
  bookingUrl: '',
  logo: null,
  accent: '#2563eb',
  ctaHeadline: 'Let’s fix these issues for you',
  ctaMessage:
    'Every issue in this report was verified on your live website. We can resolve them for you — safely, with before/after verification — so your site ranks better, loads faster and converts more visitors.',
  offer: 'Free 15-minute consultation',
  showScore: true,
};

const MAX_LOGO_BYTES = 400 * 1024;
const LIMITS: Partial<Record<keyof Branding, number>> = {
  agencyName: 80, consultantName: 80, tagline: 120, email: 120, phone: 40, website: 200, bookingUrl: 300, ctaHeadline: 120, ctaMessage: 600, offer: 120,
};

export interface BrandingValidation {
  branding: Branding;
  errors: string[];
}

/** Validates untrusted settings input. Unknown keys are dropped; invalid values produce errors. */
export function sanitizeBranding(input: unknown, base: Branding = DEFAULT_BRANDING): BrandingValidation {
  const errors: string[] = [];
  const src = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const out: Branding = { ...base };
  for (const [key, max] of Object.entries(LIMITS) as [keyof Branding, number][]) {
    if (!(key in src)) continue;
    const v = src[key];
    if (typeof v !== 'string') {
      errors.push(`${key} must be text`);
      continue;
    }
    const t = v.trim();
    if (t.length > max) errors.push(`${key} is too long (max ${max} characters)`);
    else (out as unknown as Record<string, unknown>)[key] = t;
  }
  if (out.email && !/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(out.email)) errors.push('email is not a valid address');
  if (out.phone && !/^[+()\d\s.-]{5,40}$/.test(out.phone)) errors.push('phone may contain only digits, spaces and + ( ) - .');
  for (const k of ['website', 'bookingUrl'] as const) {
    if (!out[k]) continue;
    if (!/^https?:\/\//i.test(out[k])) out[k] = `https://${out[k]}`;
    try {
      const u = new URL(out[k]);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error();
      out[k] = u.href;
    } catch {
      errors.push(`${k} is not a valid URL`);
    }
  }
  if ('accent' in src) {
    if (typeof src.accent === 'string' && /^#[0-9a-f]{6}$/i.test(src.accent)) out.accent = src.accent.toLowerCase();
    else errors.push('accent must be a #rrggbb colour');
  }
  if ('showScore' in src) out.showScore = src.showScore === true;
  if ('logo' in src) {
    const logo = src.logo;
    if (logo === null || logo === '') out.logo = null;
    else if (typeof logo === 'string' && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(logo)) {
      // Base64 expands by 4/3.
      if ((logo.length - logo.indexOf(',') - 1) * 0.75 > MAX_LOGO_BYTES) errors.push('logo must be smaller than 400 KB');
      else out.logo = logo;
    } else errors.push('logo must be a PNG, JPEG or WebP image');
  }
  if (!out.agencyName) errors.push('agencyName is required');
  return { branding: out, errors };
}

const file = (dataDir: string) => path.join(dataDir, 'branding.json');

export function loadBranding(dataDir: string): Branding {
  try {
    return sanitizeBranding(JSON.parse(fs.readFileSync(file(dataDir), 'utf8'))).branding;
  } catch {
    return { ...DEFAULT_BRANDING };
  }
}

export function saveBranding(dataDir: string, b: Branding): void {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file(dataDir), JSON.stringify(b, null, 2));
}

/** Branding is considered set up once an agency name and at least one contact method exist. */
export function brandingComplete(b: Branding): boolean {
  return b.agencyName !== DEFAULT_BRANDING.agencyName && !!(b.email || b.phone || b.website || b.bookingUrl);
}
