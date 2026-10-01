import dns from 'node:dns';
import net from 'node:net';

/**
 * SSRF protection.
 *
 * Two layers:
 *  1. `validateTargetUrl` — static checks on every URL before any request (scheme, credentials,
 *     hostname blocklist, literal-IP check, port allowlist). Applied to the input URL AND every
 *     redirect hop.
 *  2. `createSafeLookup` — a DNS lookup used by the HTTP agent at *connect time*. Every resolved
 *     address is checked, so a hostname cannot resolve to a private IP (including DNS rebinding
 *     between validation and connection: the address we check is the address we connect to).
 */

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfError';
  }
}

export interface NetworkPolicy {
  /** Tests only: allow loopback so local fixture servers can be crawled. Never exposed via the API. */
  allowLoopback?: boolean;
  /** Ports that may be contacted. */
  allowedPorts?: number[];
}

export const DEFAULT_POLICY: Required<NetworkPolicy> = {
  allowLoopback: false,
  allowedPorts: [80, 443, 8080, 8443],
};

const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.intranet', '.lan', '.home.arpa', '.corp'];
const BLOCKED_HOSTS = new Set(['localhost', 'metadata.google.internal', 'metadata', 'instance-data']);

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, oct) => (acc << 8) + Number(oct), 0) >>> 0;
}

function inV4Cidr(ip: string, cidr: string): boolean {
  const [base, bitsStr] = cidr.split('/') as [string, string];
  const bits = Number(bitsStr);
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

/** Ranges that are not publicly routable (RFC 6890 special-purpose registry and friends). */
const BLOCKED_V4 = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10', // carrier-grade NAT
  '127.0.0.0/8',
  '169.254.0.0/16', // link-local, cloud metadata (169.254.169.254)
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.88.99.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4', // multicast
  '240.0.0.0/4', // reserved + broadcast
];

/** Expand an IPv6 address to 8 groups of 16-bit numbers. Handles embedded IPv4 tails. */
export function expandIpv6(ip: string): number[] | null {
  let addr = ip.toLowerCase();
  const zone = addr.indexOf('%');
  if (zone !== -1) addr = addr.slice(0, zone);
  // Embedded dotted IPv4 tail (e.g. ::ffff:127.0.0.1)
  const lastColon = addr.lastIndexOf(':');
  const tail = addr.slice(lastColon + 1);
  if (tail.includes('.')) {
    if (!net.isIPv4(tail)) return null;
    const n = ipv4ToInt(tail);
    addr = `${addr.slice(0, lastColon + 1)}${((n >>> 16) & 0xffff).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const parts = addr.split('::');
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(':') : [];
  const rest = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
  const missing = 8 - head.length - rest.length;
  if (parts.length === 1 && head.length !== 8) return null;
  if (missing < 0) return null;
  const groups = [...head, ...Array(parts.length === 2 ? missing : 0).fill('0'), ...rest];
  if (groups.length !== 8) return null;
  const nums = groups.map((g) => parseInt(g, 16));
  return nums.some((n) => Number.isNaN(n) || n < 0 || n > 0xffff) ? null : nums;
}

function embeddedV4(g: number[], from: number): string {
  return [g[from]! >> 8, g[from]! & 0xff, g[from + 1]! >> 8, g[from + 1]! & 0xff].join('.');
}

export interface IpClassification {
  blocked: boolean;
  reason?: string;
  loopback?: boolean;
}

export function classifyIp(ip: string): IpClassification {
  if (net.isIPv4(ip)) {
    for (const cidr of BLOCKED_V4) {
      if (inV4Cidr(ip, cidr)) return { blocked: true, reason: `address ${ip} is in non-public range ${cidr}`, loopback: cidr === '127.0.0.0/8' };
    }
    return { blocked: false };
  }
  if (net.isIPv6(ip)) {
    const g = expandIpv6(ip);
    if (!g) return { blocked: true, reason: `unparseable IPv6 address ${ip}` };
    const allZeroPrefix = (n: number) => g.slice(0, n).every((x) => x === 0);
    if (g.every((x) => x === 0)) return { blocked: true, reason: 'unspecified address ::' };
    if (allZeroPrefix(7) && g[7] === 1) return { blocked: true, reason: 'IPv6 loopback ::1', loopback: true };
    // IPv4-mapped ::ffff:a.b.c.d and IPv4-compatible ::a.b.c.d → classify the embedded IPv4.
    if (allZeroPrefix(5) && (g[5] === 0xffff || g[5] === 0)) return classifyIp(embeddedV4(g, 6));
    // NAT64 64:ff9b::/96 embeds IPv4.
    if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return classifyIp(embeddedV4(g, 6));
    // 6to4 2002::/16 embeds IPv4 in groups 1-2.
    if (g[0] === 0x2002) return classifyIp(embeddedV4(g, 1));
    const first = g[0]!;
    if ((first & 0xfe00) === 0xfc00) return { blocked: true, reason: `unique-local address ${ip} (fc00::/7)` };
    if ((first & 0xffc0) === 0xfe80) return { blocked: true, reason: `link-local address ${ip} (fe80::/10)` };
    if ((first & 0xffc0) === 0xfec0) return { blocked: true, reason: `site-local address ${ip} (fec0::/10)` };
    if ((first & 0xff00) === 0xff00) return { blocked: true, reason: `multicast address ${ip}` };
    if (first === 0x2001 && g[1] === 0x0db8) return { blocked: true, reason: `documentation address ${ip}` };
    if (first === 0x2001 && g[1] === 0) return { blocked: true, reason: `Teredo address ${ip}` };
    if (first === 0x0100 && g.slice(1, 4).every((x) => x === 0)) return { blocked: true, reason: `discard-only address ${ip}` };
    return { blocked: false };
  }
  return { blocked: true, reason: `not an IP address: ${ip}` };
}

function isAllowedIp(ip: string, policy: NetworkPolicy): IpClassification {
  const c = classifyIp(ip);
  if (c.blocked && c.loopback && policy.allowLoopback) return { blocked: false };
  return c;
}

function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/**
 * Static validation of a URL. Does not touch the network.
 * Returns the parsed URL or throws SsrfError.
 */
export function validateTargetUrl(input: string | URL, policy: NetworkPolicy = DEFAULT_POLICY): URL {
  let url: URL;
  try {
    url = typeof input === 'string' ? new URL(input) : new URL(input.href);
  } catch {
    throw new SsrfError('Invalid URL format.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfError(`Scheme "${url.protocol.replace(':', '')}" is not allowed. Only http and https are supported.`);
  }
  if (url.username || url.password) throw new SsrfError('URLs containing credentials are not allowed.');

  const host = stripBrackets(url.hostname.toLowerCase().replace(/\.$/, ''));
  if (!host) throw new SsrfError('URL has no host.');

  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  const allowedPorts = policy.allowedPorts ?? DEFAULT_POLICY.allowedPorts;
  const loopbackTest = policy.allowLoopback && (host === '127.0.0.1' || host === 'localhost' || host === '::1');
  if (!allowedPorts.includes(port) && !loopbackTest) {
    throw new SsrfError(`Port ${port} is not allowed. Allowed ports: ${allowedPorts.join(', ')}.`);
  }

  if (net.isIP(host)) {
    const c = isAllowedIp(host, policy);
    if (c.blocked) throw new SsrfError(`Target is not a public address: ${c.reason}.`);
    return url;
  }

  if (!(policy.allowLoopback && host === 'localhost')) {
    if (BLOCKED_HOSTS.has(host) || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) {
      throw new SsrfError(`Host "${host}" refers to a local or internal network.`);
    }
    if (!host.includes('.')) throw new SsrfError(`Host "${host}" is not a public domain name.`);
  }
  return url;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;

/**
 * A `dns.lookup`-compatible function that rejects any hostname resolving to a non-public address.
 * If ANY resolved address is non-public, the whole lookup fails (prevents mixed-record tricks).
 */
export function createSafeLookup(policy: NetworkPolicy = DEFAULT_POLICY) {
  return function safeLookup(hostname: string, options: dns.LookupOptions | number | LookupCallback, callback?: LookupCallback): void {
    const cb = (typeof options === 'function' ? options : callback) as LookupCallback;
    const opts: dns.LookupOptions = typeof options === 'object' && options !== null ? options : typeof options === 'number' ? { family: options } : {};
    dns.lookup(hostname, { ...opts, all: true }, (err, addresses) => {
      if (err) return cb(err, opts.all ? [] : '', undefined);
      const list = addresses as dns.LookupAddress[];
      if (list.length === 0) return cb(Object.assign(new Error(`No addresses for ${hostname}`), { code: 'ENOTFOUND' }), opts.all ? [] : '');
      for (const a of list) {
        const c = isAllowedIp(a.address, policy);
        if (c.blocked) {
          const e = new SsrfError(`Blocked: ${hostname} resolves to a non-public address (${c.reason}).`) as SsrfError & NodeJS.ErrnoException;
          e.code = 'ESSRFBLOCKED';
          return cb(e, opts.all ? [] : '');
        }
      }
      if (opts.all) return cb(null, list);
      const first = list[0]!;
      return cb(null, first.address, first.family);
    });
  };
}

/** Resolve and validate a hostname (used by the browser request guard, where we cannot hook the connect). */
export async function resolvePublicHost(hostname: string, policy: NetworkPolicy = DEFAULT_POLICY): Promise<string[]> {
  const host = stripBrackets(hostname);
  if (net.isIP(host)) {
    const c = isAllowedIp(host, policy);
    if (c.blocked) throw new SsrfError(`Target is not a public address: ${c.reason}.`);
    return [host];
  }
  const list = await dns.promises.lookup(host, { all: true });
  if (list.length === 0) throw new SsrfError(`No addresses for ${host}`);
  for (const a of list) {
    const c = isAllowedIp(a.address, policy);
    if (c.blocked) throw new SsrfError(`Blocked: ${host} resolves to a non-public address (${c.reason}).`);
  }
  return list.map((a) => a.address);
}

/** Validate a URL statically and confirm that its hostname resolves only to public addresses. */
export async function assertPublicUrl(input: string, policy: NetworkPolicy = DEFAULT_POLICY): Promise<URL> {
  const url = validateTargetUrl(input, policy);
  try {
    await resolvePublicHost(url.hostname, policy);
  } catch (e) {
    if (e instanceof SsrfError) throw e;
    throw new SsrfError(`The domain "${url.hostname}" could not be resolved.`);
  }
  return url;
}
