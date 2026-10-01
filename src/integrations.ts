import fs from 'node:fs';
import path from 'node:path';

/** Third-party API keys. Kept server-side only; the UI only ever sees whether a key is configured. */
export interface Integrations {
  safeBrowsingKey: string | null;
}

const file = (dataDir: string) => path.join(dataDir, 'integrations.json');

export function loadIntegrations(dataDir: string): Integrations {
  let stored: Partial<Integrations> = {};
  try {
    stored = JSON.parse(fs.readFileSync(file(dataDir), 'utf8'));
  } catch {
    /* none yet */
  }
  return { safeBrowsingKey: stored.safeBrowsingKey || process.env.GOOGLE_SAFE_BROWSING_KEY || null };
}

/** Accepts { safeBrowsingKey: string | null }; returns an error message or null. */
export function saveIntegrations(dataDir: string, input: unknown): string | null {
  const src = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const current = (() => {
    try {
      return JSON.parse(fs.readFileSync(file(dataDir), 'utf8')) as Partial<Integrations>;
    } catch {
      return {};
    }
  })();
  if ('safeBrowsingKey' in src) {
    const k = src.safeBrowsingKey;
    if (k === null || k === '') current.safeBrowsingKey = null;
    else if (typeof k === 'string' && /^[A-Za-z0-9_-]{20,80}$/.test(k.trim())) current.safeBrowsingKey = k.trim();
    else return 'The Safe Browsing API key looks invalid (expected 20–80 letters, digits, "-" or "_").';
  }
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file(dataDir), JSON.stringify(current, null, 2), { mode: 0o600 });
  return null;
}

export function publicIntegrations(i: Integrations) {
  return { safeBrowsingConfigured: !!i.safeBrowsingKey, safeBrowsingKeyHint: i.safeBrowsingKey ? `…${i.safeBrowsingKey.slice(-4)}` : null };
}
