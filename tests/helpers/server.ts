import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { NetworkPolicy } from '../../src/security/ssrf.js';

export interface Route {
  status?: number;
  headers?: Record<string, string>;
  body?: string | ((base: string) => string);
}

export interface FixtureServer {
  base: string;
  hits: string[];
  close: () => Promise<void>;
}

/** Tests only: allow loopback so fixture servers are reachable. */
export const TEST_POLICY: NetworkPolicy = { allowLoopback: true, allowedPorts: [80, 443] };

/** Tiny HTTP server with a static route table. Unknown paths return 404. */
export async function startServer(routes: Record<string, Route | ((base: string) => Route)>): Promise<FixtureServer> {
  const hits: string[] = [];
  let base = '';
  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    hits.push(url);
    const entry = routes[url] ?? routes[url.split('?')[0]!];
    const route = typeof entry === 'function' ? entry(base) : entry;
    if (!route) {
      res.writeHead(404, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>Not found</title><h1>404</h1>');
      return;
    }
    const body = typeof route.body === 'function' ? route.body(base) : (route.body ?? '');
    res.writeHead(route.status ?? 200, { 'content-type': 'text/html; charset=utf-8', ...route.headers });
    res.end(req.method === 'HEAD' ? undefined : body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    hits,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

export function page(opts: { title?: string; body?: string; head?: string; lang?: string } = {}): string {
  return `<!doctype html><html lang="${opts.lang ?? 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${opts.title ?? 'Page'}</title>${opts.head ?? ''}</head><body>${opts.body ?? '<h1>Page</h1><p>Content</p>'}</body></html>`;
}
