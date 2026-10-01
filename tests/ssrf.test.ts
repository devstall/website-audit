import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SafeFetcher } from '../src/net/fetcher.js';
import { assertPublicUrl, classifyIp, createSafeLookup, SsrfError, validateTargetUrl } from '../src/security/ssrf.js';
import { startServer, TEST_POLICY, type FixtureServer } from './helpers/server.js';

describe('classifyIp', () => {
  it.each([
    '127.0.0.1', '127.255.255.254', '10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '169.254.169.254', '0.0.0.0', '100.64.0.1', '224.0.0.1', '255.255.255.255', '198.18.0.1',
    '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'fe80::1%eth0', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:7f00:1', '64:ff9b::a00:1', '2002:7f00:1::1', '2001:db8::1',
  ])('blocks %s', (ip) => {
    expect(classifyIp(ip).blocked).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '192.169.0.1', '2606:4700:4700::1111', '2a00:1450:4001::200e', '::ffff:8.8.8.8'])(
    'allows public %s',
    (ip) => {
      expect(classifyIp(ip).blocked).toBe(false);
    },
  );
});

describe('validateTargetUrl', () => {
  it.each([
    'file:///etc/passwd',
    'ftp://example.com/',
    'gopher://example.com/',
    'data:text/html,hi',
    'javascript:alert(1)',
    'http://localhost/',
    'http://LOCALHOST./',
    'http://app.localhost/',
    'http://printer.local/',
    'http://metadata.google.internal/',
    'http://127.0.0.1/',
    'http://2130706433/', // decimal 127.0.0.1
    'http://0x7f.1/', // hex shorthand
    'http://017700000001/', // octal
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[fe80::1]/',
    'http://[fc00::1]/',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.5/',
    'http://172.16.3.4/',
    'http://192.168.0.1/',
    'http://intranet/',
    'http://user:pass@example.com/',
    'https://example.com:22/',
    'not a url',
  ])('rejects %s', (u) => {
    expect(() => validateTargetUrl(u)).toThrow(SsrfError);
  });

  it.each(['https://example.com', 'http://example.com/', 'https://www.example.co.uk/path?q=1', 'https://example.com:8443/', 'http://8.8.8.8/'])('accepts %s', (u) => {
    expect(validateTargetUrl(u).href).toBeTruthy();
  });
});

describe('DNS-level protection', () => {
  it('safe lookup refuses hostnames that resolve to loopback', async () => {
    const lookup = createSafeLookup();
    const err = await new Promise<Error | null>((resolve) => lookup('localhost', { all: true }, (e) => resolve(e)));
    expect(err).toBeInstanceOf(SsrfError);
  });

  it('assertPublicUrl rejects private targets', async () => {
    await expect(assertPublicUrl('http://127.0.0.1/')).rejects.toThrow(SsrfError);
    await expect(assertPublicUrl('http://localhost:8080/')).rejects.toThrow(SsrfError);
  });
});

describe('redirects cannot escape the public-address policy', () => {
  let srv: FixtureServer;
  beforeAll(async () => {
    srv = await startServer({
      '/to-metadata': { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } },
      '/to-private': { status: 301, headers: { location: 'http://10.0.0.1/admin' } },
      '/to-file': { status: 302, headers: { location: 'file:///etc/passwd' } },
      '/to-ipv6-private': { status: 302, headers: { location: 'http://[fd00::1]/' } },
    });
  });
  afterAll(() => srv.close());

  it.each(['/to-metadata', '/to-private', '/to-file', '/to-ipv6-private'])('blocks redirect %s', async (path) => {
    const f = new SafeFetcher({ perHostDelayMs: 0 }, TEST_POLICY);
    const res = await f.fetch(`${srv.base}${path}`);
    expect(res.status).toBe(0);
    expect(res.error).toMatch(/Redirect target blocked/);
    expect(res.chain[0]?.status).toBeGreaterThanOrEqual(300);
    await f.close();
  });

  it('the default policy refuses to contact the loopback fixture at all', async () => {
    const f = new SafeFetcher({ perHostDelayMs: 0 });
    await expect(f.fetch(`${srv.base}/`)).rejects.toThrow(SsrfError);
    expect(f.requestsMade).toBe(0);
    await f.close();
  });
});
