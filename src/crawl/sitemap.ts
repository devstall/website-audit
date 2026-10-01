import * as cheerio from 'cheerio';

export interface ParsedSitemap {
  kind: 'urlset' | 'index' | 'invalid';
  locs: string[];
  error?: string;
}

/** Parse a sitemap or sitemap index. Tolerant of namespaces; flags non-XML (e.g. an HTML page served at /sitemap.xml). */
export function parseSitemap(body: string, contentType = ''): ParsedSitemap {
  const trimmed = body.trimStart();
  if (!trimmed) return { kind: 'invalid', locs: [], error: 'Empty response body' };
  if (/^<!doctype html|^<html/i.test(trimmed) || /text\/html/i.test(contentType)) {
    return { kind: 'invalid', locs: [], error: 'Response is an HTML page, not an XML sitemap' };
  }
  let $: cheerio.CheerioAPI;
  try {
    $ = cheerio.load(body, { xml: true });
  } catch (e) {
    return { kind: 'invalid', locs: [], error: `XML parse error: ${(e as Error).message}` };
  }
  const root = $.root().children().first();
  const name = (root.prop('tagName') as string | undefined)?.toLowerCase().replace(/^.*:/, '');
  if (name === 'sitemapindex') {
    return { kind: 'index', locs: $('sitemap > loc, sitemap loc').map((_, el) => $(el).text().trim()).get().filter(Boolean) };
  }
  if (name === 'urlset') {
    return { kind: 'urlset', locs: $('url > loc, url loc').map((_, el) => $(el).text().trim()).get().filter(Boolean) };
  }
  return { kind: 'invalid', locs: [], error: `Root element is <${name ?? 'none'}>, expected <urlset> or <sitemapindex>` };
}
