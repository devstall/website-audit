import { describe, expect, it } from 'vitest';
import { crawlFilter, isSameSite, normalizeInputUrl, normalizeUrl } from '../src/crawl/url.js';

describe('normalizeInputUrl', () => {
  it.each([
    ['https://example.com', 'https://example.com/'],
    ['https://example.com/', 'https://example.com/'],
    ['example.com', 'https://example.com/'],
    ['  HTTPS://Example.COM  ', 'https://example.com/'],
    ['https://example.com/#top', 'https://example.com/'],
    ['http://example.com', 'http://example.com/'],
    ['example.com:8443', 'https://example.com:8443/'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeInputUrl(input)).toBe(expected);
  });

  it('rejects empty input', () => {
    expect(() => normalizeInputUrl('   ')).toThrow();
  });
});

describe('normalizeUrl', () => {
  it('removes tracking parameters and fragments, sorts the rest', () => {
    expect(normalizeUrl('https://Example.com/p/?utm_source=x&b=2&utm_medium=y&a=1&fbclid=z&gclid=q#frag')).toBe('https://example.com/p/?a=1&b=2');
  });
  it('drops default ports', () => {
    expect(normalizeUrl('https://example.com:443/x')).toBe('https://example.com/x');
    expect(normalizeUrl('http://example.com:80/x')).toBe('http://example.com/x');
  });
  it('resolves relative URLs against a base', () => {
    expect(normalizeUrl('../about/', 'https://example.com/services/web/')).toBe('https://example.com/services/about/');
  });
  it('preserves trailing slash distinctions', () => {
    expect(normalizeUrl('https://example.com/a')).not.toBe(normalizeUrl('https://example.com/a/'));
  });
  it('rejects non-http schemes', () => {
    expect(normalizeUrl('mailto:a@b.com')).toBeNull();
    expect(normalizeUrl('javascript:void(0)')).toBeNull();
  });
});

describe('crawlFilter', () => {
  it.each([
    'https://example.com/wp-admin/',
    'https://example.com/wp-login.php',
    'https://example.com/login/',
    'https://example.com/logout',
    'https://example.com/cart/',
    'https://example.com/checkout/',
    'https://example.com/my-account/',
    'https://example.com/account/orders',
    'https://example.com/?s=shoes',
    'https://example.com/search/shoes',
    'https://example.com/events/?tribe-bar-date=2026-01',
    'https://example.com/2024/05/',
    'https://example.com/shop/?a=1&b=2&c=3',
    'https://example.com/?add-to-cart=12',
    'https://example.com/file.pdf',
    'https://example.com/wp-json/wp/v2/posts',
  ])('excludes %s', (u) => {
    expect(crawlFilter(u).allowed).toBe(false);
  });

  it.each(['https://example.com/', 'https://example.com/services/', 'https://example.com/blog/my-post/', 'https://example.com/shop/?page=2'])('allows %s', (u) => {
    expect(crawlFilter(u).allowed).toBe(true);
  });
});

describe('isSameSite', () => {
  it('treats www and non-www as the same site', () => {
    expect(isSameSite('https://www.example.com/a', 'http://example.com/')).toBe(true);
    expect(isSameSite('https://blog.example.com/', 'https://example.com/')).toBe(false);
    expect(isSameSite('https://example.org/', 'https://example.com/')).toBe(false);
  });
});
