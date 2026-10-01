/**
 * Security & malware scan beyond the page signatures:
 *  - SSL/TLS certificate validity and expiry, legacy protocol support (target host, public IP only)
 *  - Email spoofing protection: MX / SPF / DMARC DNS records
 *  - Google Safe Browsing blacklist lookup (optional API key)
 *  - Outdated WordPress core / theme / plugins vs the official api.wordpress.org
 *  - Cloaking: homepage as seen by Googlebot vs a normal visitor (hidden SEO spam)
 *  - Cookie security flags
 * All checks are passive and read-only.
 */
import dns from 'node:dns';
import net from 'node:net';
import tls from 'node:tls';
import { RequestBudgetExceeded, type SafeFetcher } from '../net/fetcher.js';
import { resolvePublicHost, type NetworkPolicy } from '../security/ssrf.js';
import type { FetchResult, MalwareSignal, PageFacts, SecurityScan, WordPressInfo } from '../types.js';
import { uniqueTerms } from './malware.js';

const GOOGLEBOT_UA = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label} timed out`)), ms))]);
}

// ---------------- TLS ----------------

function handshake(ip: string, host: string, opts: tls.ConnectionOptions): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: ip, port: 443, servername: host, rejectUnauthorized: false, timeout: 8000, ...opts }, () => resolve(socket));
    socket.once('error', reject);
    socket.once('timeout', () => {
      socket.destroy();
      reject(new Error('TLS handshake timed out'));
    });
  });
}

export async function checkTls(host: string, policy?: NetworkPolicy): Promise<SecurityScan['tls']> {
  const out: SecurityScan['tls'] = { checked: false, validTo: null, daysLeft: null, issuer: null, protocol: null, authorized: null, authError: null, legacyProtocols: [] };
  let ip: string;
  try {
    // Same public-address policy as the HTTP client; we connect to the address we validated.
    [ip] = (await resolvePublicHost(host, policy)) as [string];
  } catch (e) {
    return { ...out, note: `Not checked: ${(e as Error).message}` };
  }
  try {
    const socket = await handshake(ip, host, {});
    const cert = socket.getPeerCertificate();
    out.checked = true;
    out.protocol = socket.getProtocol();
    out.authorized = socket.authorized;
    out.authError = socket.authorized ? null : String(socket.authorizationError ?? 'unknown');
    if (cert?.valid_to) {
      out.validTo = new Date(cert.valid_to).toISOString().slice(0, 10);
      out.daysLeft = Math.floor((Date.parse(cert.valid_to) - Date.now()) / 86_400_000);
    }
    const issuer = cert?.issuer as unknown as Record<string, string> | undefined;
    out.issuer = issuer?.O ?? issuer?.CN ?? null;
    socket.destroy();
  } catch (e) {
    return { ...out, note: `TLS handshake failed: ${(e as Error).message}` };
  }
  // Best effort: does the server still accept TLS 1.0 / 1.1? Only a successful handshake is reported.
  for (const version of ['TLSv1', 'TLSv1.1'] as const) {
    try {
      const s = await handshake(ip, host, { minVersion: version, maxVersion: version, ciphers: 'DEFAULT@SECLEVEL=0' });
      if (s.getProtocol() === version) out.legacyProtocols.push(version === 'TLSv1' ? 'TLS 1.0' : 'TLS 1.1');
      s.destroy();
    } catch {
      /* refused (good) or unsupported by this client — not reported */
    }
  }
  return out;
}

// ---------------- Email (SPF / DMARC) ----------------

export async function checkEmail(host: string): Promise<SecurityScan['email']> {
  if (net.isIP(host)) return { checked: false, domain: null, hasMx: false, spf: null, dmarc: null, dmarcPolicy: null, note: 'Site is addressed by IP; no email domain to check.' };
  const base = host.replace(/^www\./, '');
  const labels = base.split('.');
  const candidates = [base, labels.slice(-2).join('.'), labels.slice(-3).join('.')].filter((d, i, a) => d.includes('.') && a.indexOf(d) === i);
  const out: SecurityScan['email'] = { checked: false, domain: null, hasMx: false, spf: null, dmarc: null, dmarcPolicy: null };
  try {
    for (const d of candidates) {
      const mx = await withTimeout(dns.promises.resolveMx(d), 5000, 'MX lookup').catch(() => []);
      if (mx.length) {
        out.domain = d;
        out.hasMx = true;
        break;
      }
    }
    out.domain ??= candidates[0] ?? base;
    // "No record" (ENODATA/ENOTFOUND) is a finding; any other DNS failure means we could not check.
    const txtOrEmpty = (name: string) =>
      withTimeout(dns.promises.resolveTxt(name), 5000, 'TXT lookup').catch((e: NodeJS.ErrnoException) => {
        if (e.code === 'ENODATA' || e.code === 'ENOTFOUND') return [] as string[][];
        throw e;
      });
    const txt = await txtOrEmpty(out.domain);
    out.spf = txt.map((r) => r.join('')).find((r) => /^v=spf1\b/i.test(r)) ?? null;
    const dm = await txtOrEmpty(`_dmarc.${out.domain}`);
    out.dmarc = dm.map((r) => r.join('')).find((r) => /^v=DMARC1\b/i.test(r)) ?? null;
    out.dmarcPolicy = out.dmarc ? (/;\s*p\s*=\s*(\w+)/i.exec(out.dmarc)?.[1]?.toLowerCase() ?? null) : null;
    out.checked = true;
  } catch (e) {
    out.note = `DNS lookup failed: ${(e as Error).message}`;
  }
  return out;
}

// ---------------- Google Safe Browsing ----------------

export async function checkSafeBrowsing(urls: string[], key: string | undefined): Promise<SecurityScan['blacklist']> {
  if (!key) return { checked: false, provider: null, matches: [], note: 'Not checked — add a Google Safe Browsing API key in Settings to enable blacklist checks.' };
  try {
    const res = await fetch(`https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({
        client: { clientId: 'website-independent-investigator', clientVersion: '1.0' },
        threatInfo: {
          threatTypes: ['MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE', 'POTENTIALLY_HARMFUL_APPLICATION'],
          platformTypes: ['ANY_PLATFORM'],
          threatEntryTypes: ['URL'],
          threatEntries: [...new Set(urls)].slice(0, 50).map((url) => ({ url })),
        },
      }),
    });
    if (!res.ok) return { checked: false, provider: 'Google Safe Browsing', matches: [], note: `Safe Browsing API error (HTTP ${res.status}) — check the API key.` };
    const body = (await res.json()) as { matches?: { threat: { url: string }; threatType: string }[] };
    return { checked: true, provider: 'Google Safe Browsing', matches: (body.matches ?? []).map((m) => ({ url: m.threat.url, threat: m.threatType })) };
  } catch (e) {
    return { checked: false, provider: 'Google Safe Browsing', matches: [], note: `Safe Browsing lookup failed: ${(e as Error).message}` };
  }
}

// ---------------- WordPress versions ----------------

const wpCache = new Map<string, { at: number; value: string | null }>();

async function wpApi(url: string, pick: (j: Record<string, unknown>) => string | null): Promise<string | null> {
  const hit = wpCache.get(url);
  if (hit && Date.now() - hit.at < 12 * 3600_000) return hit.value;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { accept: 'application/json' } });
    const value = res.ok ? pick((await res.json()) as Record<string, unknown>) : null;
    wpCache.set(url, { at: Date.now(), value });
    return value;
  } catch {
    return null;
  }
}

/** Numeric dotted-version compare: <0 when a is older than b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

const isVersion = (v: string | null | undefined): v is string => !!v && /^\d+\.\d+(\.\d+){0,2}$/.test(v);

export async function checkSoftware(wp: WordPressInfo): Promise<SecurityScan['software']> {
  if (!wp.detected) return { checked: false, core: null, theme: null, plugins: [], note: 'WordPress not detected.' };
  const out: SecurityScan['software'] = { checked: true, core: null, theme: null, plugins: [] };
  const latestCore = await wpApi('https://api.wordpress.org/core/version-check/1.7/', (j) => {
    const offers = j.offers as { current?: string }[] | undefined;
    return offers?.[0]?.current ?? null;
  });
  if (!latestCore) {
    out.checked = false;
    out.note = 'Could not reach api.wordpress.org to compare versions.';
    return out;
  }
  if (isVersion(wp.version)) out.core = { installed: wp.version, latest: latestCore, source: wp.versionSource ?? 'unknown' };
  if (wp.theme && isVersion(wp.theme.version) && !wp.theme.isChild) {
    const latest = await wpApi(`https://api.wordpress.org/themes/info/1.2/?action=theme_information&request%5Bslug%5D=${encodeURIComponent(wp.theme.slug)}`, (j) => (typeof j.version === 'string' ? j.version : null));
    if (isVersion(latest)) out.theme = { slug: wp.theme.slug, installed: wp.theme.version, latest };
  }
  for (const p of wp.plugins.slice(0, 25)) {
    // ?ver= on plugin assets is usually the plugin version, but some plugins pass the core version — skip those.
    const installed = p.versions.find((v) => isVersion(v) && v !== wp.version);
    if (!installed) continue;
    const latest = await wpApi(`https://api.wordpress.org/plugins/info/1.2/?action=plugin_information&request%5Bslug%5D=${encodeURIComponent(p.slug)}&request%5Bfields%5D%5Bsections%5D=0`, (j) =>
      typeof j.version === 'string' ? j.version : null,
    );
    if (isVersion(latest)) out.plugins.push({ slug: p.slug, installed, latest });
  }
  return out;
}

// ---------------- Cloaking ----------------

export async function checkCloaking(fetcher: SafeFetcher, homepage: FetchResult, siteUrl: string): Promise<{ result: SecurityScan['cloaking']; signal: MalwareSignal | null }> {
  let bot: FetchResult;
  try {
    bot = await fetcher.fetch(homepage.requestedUrl, { maxBytes: 3 * 1024 * 1024, headers: { 'user-agent': GOOGLEBOT_UA } });
  } catch (e) {
    const note = e instanceof RequestBudgetExceeded ? 'Not checked: request budget reached.' : `Not checked: ${(e as Error).message}`;
    return { result: { checked: false, different: false, googlebotOnlyTerms: [], googlebotFinalUrl: null, note }, signal: null };
  }
  if (bot.status === 0) return { result: { checked: false, different: false, googlebotOnlyTerms: [], googlebotFinalUrl: null, note: bot.error }, signal: null };
  const userTerms = new Set(uniqueTerms(homepage.body));
  const botOnly = uniqueTerms(bot.body).filter((t) => !userTerms.has(t));
  let otherHost = false;
  try {
    otherHost = new URL(bot.finalUrl).hostname.replace(/^www\./, '') !== new URL(siteUrl).hostname.replace(/^www\./, '');
  } catch {
    /* ignore */
  }
  const different = botOnly.length > 0 || otherHost;
  const result = { checked: true, different, googlebotOnlyTerms: botOnly, googlebotFinalUrl: bot.finalUrl };
  const signal: MalwareSignal | null = different
    ? {
        type: 'cloaking',
        confidence: 'High',
        page: homepage.requestedUrl,
        detail: otherHost
          ? `Googlebot is redirected to a different domain (${bot.finalUrl}) while normal visitors are not`
          : `Googlebot is served spam content that visitors do not see: ${botOnly.slice(0, 6).join(', ')}`,
      }
    : null;
  bot.body = '';
  return { result, signal };
}

// ---------------- Cookies ----------------

export function parseCookies(setCookies: string[] | undefined): SecurityScan['cookies'] {
  return (setCookies ?? []).slice(0, 30).map((c) => {
    const [pair = '', ...attrs] = c.split(';');
    const lower = attrs.map((a) => a.trim().toLowerCase());
    return {
      name: pair.split('=')[0]!.trim().slice(0, 60),
      secure: lower.includes('secure'),
      httpOnly: lower.includes('httponly'),
      sameSite: lower.find((a) => a.startsWith('samesite='))?.split('=')[1] ?? null,
    };
  });
}

// ---------------- Orchestration ----------------

export interface SecurityScanInput {
  fetcher: SafeFetcher;
  homepage: FetchResult;
  siteUrl: string;
  pages: PageFacts[];
  wordpress: WordPressInfo;
  policy?: NetworkPolicy;
  safeBrowsingKey?: string;
}

export async function runSecurityScan(i: SecurityScanInput): Promise<SecurityScan> {
  const host = new URL(i.siteUrl).hostname;
  const malware = i.pages.flatMap((p) => p.malware ?? []);
  const externalScriptHosts = [
    ...new Set(
      i.pages.flatMap((p) =>
        p.scripts
          .map((s) => {
            try {
              return new URL(s.src).hostname;
            } catch {
              return '';
            }
          })
          .filter((h) => h && h.replace(/^www\./, '') !== host.replace(/^www\./, '')),
      ),
    ),
  ].sort();

  const cloak = await checkCloaking(i.fetcher, i.homepage, i.siteUrl);
  if (cloak.signal) malware.push(cloak.signal);
  const [tlsInfo, email, blacklist, software] = await Promise.all([
    i.siteUrl.startsWith('https:') ? checkTls(host, i.policy) : Promise.resolve<SecurityScan['tls']>({ checked: false, validTo: null, daysLeft: null, issuer: null, protocol: null, authorized: null, authError: null, legacyProtocols: [], note: 'Site does not use HTTPS.' }),
    checkEmail(host),
    checkSafeBrowsing([i.siteUrl, `${new URL(i.siteUrl).origin}/`, ...externalScriptHosts.map((h) => `https://${h}/`)], i.safeBrowsingKey),
    checkSoftware(i.wordpress),
  ]);
  return {
    pagesScanned: i.pages.filter((p) => p.status >= 200 && p.status < 300).length,
    malware,
    externalScriptHosts,
    blacklist,
    cloaking: cloak.result,
    tls: tlsInfo,
    email,
    software,
    cookies: parseCookies(i.homepage.setCookies),
  };
}
