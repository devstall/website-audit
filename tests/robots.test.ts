import { describe, expect, it } from 'vitest';
import { isAllowed, matchingRule, parseRobots, rulesFor } from '../src/crawl/robots.js';

const U = (p: string) => `https://example.com${p}`;

describe('robots.txt', () => {
  it('Disallow: / blocks everything for *', () => {
    const r = parseRobots('User-agent: *\nDisallow: /\n');
    expect(isAllowed(r, 'Googlebot', U('/'))).toBe(false);
    expect(isAllowed(r, 'Googlebot', U('/about/'))).toBe(false);
  });

  it('empty Disallow allows everything', () => {
    const r = parseRobots('User-agent: *\nDisallow:\n');
    expect(isAllowed(r, 'Googlebot', U('/anything'))).toBe(true);
  });

  it('longest match wins and Allow wins ties', () => {
    const r = parseRobots('User-agent: *\nDisallow: /wp-admin/\nAllow: /wp-admin/admin-ajax.php\n');
    expect(isAllowed(r, 'x', U('/wp-admin/'))).toBe(false);
    expect(isAllowed(r, 'x', U('/wp-admin/admin-ajax.php'))).toBe(true);
    expect(isAllowed(r, 'x', U('/services/'))).toBe(true);
  });

  it('supports * and $ patterns', () => {
    const r = parseRobots('User-agent: *\nDisallow: /*.pdf$\nDisallow: /*?replytocom=\n');
    expect(isAllowed(r, 'x', U('/files/a.pdf'))).toBe(false);
    expect(isAllowed(r, 'x', U('/files/a.pdf?x=1'))).toBe(true);
    expect(isAllowed(r, 'x', U('/post/?replytocom=5'))).toBe(false);
  });

  it('prefers a specific user-agent group over *', () => {
    const r = parseRobots('User-agent: *\nDisallow: /\n\nUser-agent: Googlebot\nDisallow: /private/\n');
    expect(isAllowed(r, 'Googlebot', U('/'))).toBe(true);
    expect(isAllowed(r, 'Googlebot', U('/private/x'))).toBe(false);
    expect(isAllowed(r, 'Bingbot', U('/'))).toBe(false);
  });

  it('groups consecutive user-agent lines', () => {
    const r = parseRobots('User-agent: a\nUser-agent: b\nDisallow: /x\n');
    expect(rulesFor(r, 'b')).toHaveLength(1);
  });

  it('collects sitemaps and reports syntax problems', () => {
    const r = parseRobots('Sitemap: https://example.com/sitemap.xml\nDisallow: /early\nUser-agent: *\nDisalow: /typo\nnonsense line\n');
    expect(r.sitemaps).toEqual(['https://example.com/sitemap.xml']);
    expect(r.warnings.join('\n')).toMatch(/before any User-agent/);
    expect(r.warnings.join('\n')).toMatch(/unknown directive "disalow"/);
    expect(r.warnings.join('\n')).toMatch(/missing ":"/);
  });

  it('reports the matching rule line', () => {
    const r = parseRobots('User-agent: *\n\nDisallow: /services/\n');
    expect(matchingRule(rulesFor(r, 'x'), '/services/web')?.line).toBe(3);
  });

  it('always allows /robots.txt itself', () => {
    const r = parseRobots('User-agent: *\nDisallow: /\n');
    expect(isAllowed(r, 'x', U('/robots.txt'))).toBe(true);
  });
});
