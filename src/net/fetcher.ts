import zlib from 'node:zlib';
import { Agent, request } from 'undici';
import { DEFAULT_LIMITS, USER_AGENT, type CrawlLimits } from '../config.js';
import { createSafeLookup, DEFAULT_POLICY, SsrfError, validateTargetUrl, type NetworkPolicy } from '../security/ssrf.js';
import type { FetchResult, RedirectHop } from '../types.js';

export class RequestBudgetExceeded extends Error {
  constructor() {
    super('Request budget exhausted');
    this.name = 'RequestBudgetExceeded';
  }
}

export interface FetchOptions {
  method?: 'GET' | 'HEAD';
  /** Follow redirects (each hop is re-validated). Default true. */
  followRedirects?: boolean;
  /** Read at most this many (decoded) bytes. Default: limits.maxBodyBytes. */
  maxBytes?: number;
  /** Do not read the body at all (still counts size from Content-Length). */
  skipBody?: boolean;
  /** Also return the (decoded) body bytes as base64 — for images. */
  binary?: boolean;
  headers?: Record<string, string>;
}

export interface LoggedRequest {
  url: string;
  method: string;
  status: number | null;
  ms: number;
  error?: string;
}

/**
 * The ONLY way the investigator talks to a target over HTTP.
 * - connect-time DNS validation (no private IPs, no rebinding)
 * - manual redirect following with static validation of every Location
 * - global request budget, per-host pacing, timeouts, body size caps
 */
export class SafeFetcher {
  readonly limits: CrawlLimits;
  readonly policy: NetworkPolicy;
  private readonly agent: Agent;
  private used = 0;
  private readonly hostNextSlot = new Map<string, number>();
  readonly log: LoggedRequest[] = [];

  constructor(limits: Partial<CrawlLimits> = {}, policy: NetworkPolicy = DEFAULT_POLICY) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.policy = policy;
    this.agent = new Agent({
      connect: { lookup: createSafeLookup(policy) as never, timeout: this.limits.timeoutMs },
      headersTimeout: this.limits.timeoutMs,
      bodyTimeout: this.limits.timeoutMs,
      connections: 4,
    });
  }

  get requestsMade(): number {
    return this.used;
  }

  remaining(): number {
    return Math.max(0, this.limits.maxRequests - this.used);
  }

  async close(): Promise<void> {
    await this.agent.close().catch(() => undefined);
  }

  private async pace(host: string): Promise<void> {
    const now = Date.now();
    const slot = Math.max(now, this.hostNextSlot.get(host) ?? 0);
    this.hostNextSlot.set(host, slot + this.limits.perHostDelayMs);
    if (slot > now) await new Promise((r) => setTimeout(r, slot - now));
  }

  /** Fetch with redirect following. Never throws for HTTP errors; throws only for budget/SSRF on the *initial* URL. */
  async fetch(input: string, opts: FetchOptions = {}): Promise<FetchResult> {
    const method = opts.method ?? 'GET';
    const follow = opts.followRedirects ?? true;
    const started = performance.now();
    const chain: RedirectHop[] = [];
    const seen = new Set<string>();
    let current = validateTargetUrl(input, this.policy).href;

    for (let hop = 0; hop <= this.limits.maxRedirects; hop++) {
      if (this.used >= this.limits.maxRequests) throw new RequestBudgetExceeded();
      if (seen.has(current)) {
        return this.failure(input, current, chain, started, 'Redirect loop detected', true);
      }
      seen.add(current);

      let url: URL;
      try {
        url = validateTargetUrl(current, this.policy);
      } catch (e) {
        return this.failure(input, current, chain, started, `Redirect target blocked: ${(e as Error).message}`);
      }

      await this.pace(url.host);
      this.used++;
      const hopStart = performance.now();
      let res;
      try {
        res = await request(url, {
          method,
          dispatcher: this.agent,
          headers: {
            'user-agent': USER_AGENT,
            accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'accept-encoding': 'gzip, deflate, br',
            'accept-language': 'en-US,en;q=0.8',
            ...opts.headers,
          },
          signal: AbortSignal.timeout(this.limits.timeoutMs),
        });
      } catch (e) {
        const err = e as Error & { cause?: Error };
        const msg = err.cause instanceof SsrfError || err instanceof SsrfError ? (err.cause ?? err).message : describeNetworkError(err);
        this.log.push({ url: url.href, method, status: null, ms: Math.round(performance.now() - hopStart), error: msg });
        return this.failure(input, url.href, chain, started, msg);
      }
      const ttfb = performance.now() - hopStart;
      const headers = flattenHeaders(res.headers);
      const rawCookies = res.headers["set-cookie"];
      const setCookies = rawCookies === undefined ? [] : Array.isArray(rawCookies) ? rawCookies : [rawCookies];
      const status = res.statusCode;
      this.log.push({ url: url.href, method, status, ms: Math.round(ttfb) });

      const location = headers['location'];
      if (status >= 300 && status < 400 && location && follow) {
        res.body.dump().catch(() => undefined);
        let next: string;
        try {
          next = new URL(location, url).href;
        } catch {
          chain.push({ url: url.href, status, location });
          return this.failure(input, url.href, chain, started, `Invalid Location header: ${location}`);
        }
        chain.push({ url: url.href, status, location: next });
        current = next;
        continue;
      }

      chain.push({ url: url.href, status, ...(location ? { location } : {}) });
      const { text, bytes, transferBytes, truncated, base64 } =
        method === 'HEAD' || opts.skipBody
          ? await discard(res.body, headers)
          : await readBody(res.body, headers, opts.maxBytes ?? this.limits.maxBodyBytes, !!opts.binary);

      return {
        requestedUrl: input,
        finalUrl: url.href,
        status,
        ok: status >= 200 && status < 300,
        chain,
        headers,
        body: opts.binary ? '' : text,
        ...(base64 !== undefined ? { bodyBase64: base64 } : {}),
        bodyBytes: bytes,
        transferBytes,
        ...(setCookies.length ? { setCookies } : {}),
        truncated,
        ttfbMs: Math.round(ttfb),
        totalMs: Math.round(performance.now() - started),
      };
    }
    return this.failure(input, current, chain, started, `More than ${this.limits.maxRedirects} redirects`);
  }

  private failure(input: string, finalUrl: string, chain: RedirectHop[], started: number, error: string, loop = false): FetchResult {
    return {
      requestedUrl: input,
      finalUrl,
      status: 0,
      ok: false,
      chain,
      headers: {},
      body: '',
      bodyBytes: 0,
      transferBytes: 0,
      truncated: false,
      ttfbMs: 0,
      totalMs: Math.round(performance.now() - started),
      error,
      ...(loop ? { loop: true } : {}),
    };
  }
}

function describeNetworkError(err: Error & { code?: string; cause?: Error & { code?: string } }): string {
  const code = err.code ?? err.cause?.code;
  if (err.name === 'TimeoutError' || code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') return 'Request timed out';
  if (code === 'ENOTFOUND') return 'DNS lookup failed (domain not found)';
  if (code === 'ECONNREFUSED') return 'Connection refused';
  if (code === 'ECONNRESET') return 'Connection reset';
  if (code && /CERT|SSL|TLS/i.test(code)) return `TLS/certificate error (${code})`;
  return err.cause?.message ?? err.message;
}

export function flattenHeaders(h: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    if (v === undefined) continue;
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
}

type Body = AsyncIterable<Buffer> & { destroy: (e?: Error) => void; dump: () => Promise<void> };

async function discard(body: Body, headers: Record<string, string>): Promise<{ text: string; bytes: number; transferBytes: number; truncated: boolean; base64?: string }> {
  await body.dump().catch(() => undefined);
  const len = Number(headers['content-length'] ?? 0);
  return { text: '', bytes: len, transferBytes: len, truncated: false };
}

async function readBody(body: Body, headers: Record<string, string>, maxBytes: number, binary = false): Promise<{ text: string; bytes: number; transferBytes: number; truncated: boolean; base64?: string }> {
  const chunks: Buffer[] = [];
  let transferBytes = 0;
  let truncated = false;
  const encoding = (headers['content-encoding'] ?? '').toLowerCase().trim();
  // Compressed bodies are allowed to be larger on the wire only up to maxBytes too; decoded output is capped again below.
  try {
    for await (const chunk of body) {
      transferBytes += chunk.length;
      if (transferBytes > maxBytes) {
        truncated = true;
        chunks.push(chunk.subarray(0, chunk.length - (transferBytes - maxBytes)));
        body.destroy();
        break;
      }
      chunks.push(chunk);
    }
  } catch {
    truncated = true;
  }
  let raw = Buffer.concat(chunks);
  try {
    const flush = { finishFlush: zlib.constants.Z_SYNC_FLUSH };
    if (encoding === 'gzip' || encoding === 'x-gzip') raw = zlib.gunzipSync(raw, flush);
    else if (encoding === 'deflate') raw = zlib.inflateSync(raw, flush);
    else if (encoding === 'br') raw = zlib.brotliDecompressSync(raw, { finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH });
  } catch {
    // Leave raw bytes; content will simply not parse as HTML.
  }
  if (raw.length > maxBytes) {
    raw = raw.subarray(0, maxBytes);
    truncated = true;
  }
  const charset = /charset=([\w-]+)/i.exec(headers['content-type'] ?? '')?.[1]?.toLowerCase() ?? 'utf-8';
  let text: string;
  try {
    text = new TextDecoder(charset, { fatal: false }).decode(raw);
  } catch {
    text = new TextDecoder('utf-8').decode(raw);
  }
  const contentLength = Number(headers['content-length'] ?? 0);
  return { text, bytes: raw.length, transferBytes: truncated ? Math.max(transferBytes, contentLength) : transferBytes, truncated, ...(binary ? { base64: raw.toString('base64') } : {}) };
}
