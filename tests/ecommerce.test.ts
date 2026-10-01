import os from 'node:os';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchBrowser, BrowserSession } from '../src/browser/browser.js';
import { conversionScore, evaluateChecks } from '../src/ecommerce/checks.js';
import { conceptData, productPageConcept } from '../src/ecommerce/concepts.js';
import { extractCommerce, mergeFacts } from '../src/ecommerce/extract.js';
import { DEVICES, productProbe, responsiveCheck } from '../src/ecommerce/probe.js';
import { investigate } from '../src/investigate.js';
import { renderClientReport } from '../src/report/client.js';
import { DEFAULT_BRANDING } from '../src/branding.js';
import { page, startServer, TEST_POLICY, type FixtureServer } from './helpers/server.js';

const PRODUCT_LD = JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'Product',
  name: 'Merino Runner',
  image: ['https://shop.example/a.jpg', 'https://shop.example/b.jpg', 'https://shop.example/c.jpg'],
  offers: { '@type': 'Offer', price: '98.00', priceCurrency: 'USD', availability: 'https://schema.org/InStock' },
  aggregateRating: { '@type': 'AggregateRating', ratingValue: '4.7', reviewCount: '212' },
});

const productHtml = (extraBody = '') => `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Merino Runner</title>
  <script type="application/ld+json">${PRODUCT_LD}</script><meta property="og:type" content="product">
  <script src="https://cdn.shopify.com/s/files/theme.js"></script></head><body>
  <header><a href="/cart">Cart</a><form role="search"><input type="search" name="q"></form></header>
  <h1>Merino Runner</h1><span class="price">$98.00</span>
  <form action="/cart/add"><button type="submit" name="add">Add to cart</button><div class="shopify-payment-button"></div></form>
  <p>Free shipping on orders over $50. 30-day free returns. Ships within 2 days.</p>
  <div class="product__description">${'Soft merino wool upper. '.repeat(30)}</div>
  <h2>You may also like</h2><a href="/products/tree-dasher">Tree Dasher</a>
  <footer><a href="/policies/shipping">Shipping</a><a href="/policies/privacy">Privacy</a><a href="/policies/terms">Terms of service</a><a href="/contact">Contact</a>
  <svg class="icon"><title>Visa</title></svg><svg class="icon"><title>Mastercard</title></svg>
  <form><input type="email" placeholder="Email"><button>Subscribe to our newsletter</button></form></footer>${extraBody}</body></html>`;

describe('commerce extraction', () => {
  const facts = extractCommerce(cheerio.load(productHtml()), productHtml(), 'https://shop.example/products/merino-runner');

  it('reads product data from schema.org', () => {
    expect(facts.isProduct).toBe(true);
    expect(facts.product).toMatchObject({ name: 'Merino Runner', price: '98.00', currency: 'USD', rating: 4.7, reviewCount: 212, schemaHasOffer: true, schemaHasRating: true });
    expect(facts.productImages).toBe(3);
  });

  it('detects buying, trust and navigation signals', () => {
    expect(facts.platformHints).toContain('Shopify');
    expect(facts.addToCart.present).toBe(true);
    expect(facts.expressPay).toContain('Shopify dynamic checkout');
    expect(facts.trust).toMatchObject({ freeShipping: true, returns: true });
    expect(facts.paymentIcons).toEqual(expect.arrayContaining(['Visa', 'Mastercard'])); // SVG <title>
    expect(facts).toMatchObject({ shippingInfo: true, crossSell: true, search: true, cartLink: true, newsletter: true, reviews: true });
    expect(facts.policyLinks).toMatchObject({ shipping: true, privacy: true, terms: true, contact: true });
  });

  it('finds href-less policy links (JS modals) and merges rendered-DOM facts', () => {
    const bare = '<html><body><h1>Shop</h1><footer><a @click="openModal()">Terms of service</a></footer></body></html>';
    const served = extractCommerce(cheerio.load(bare), bare, 'https://shop.example/');
    expect(served.policyLinks.terms).toBe(true);
    const rendered = extractCommerce(cheerio.load(productHtml()), productHtml(), 'https://shop.example/');
    expect(mergeFacts(served, rendered)).toMatchObject({ reviews: true, search: true, policyLinks: { privacy: true } });
  });

  it('does not mistake an ordinary content page for a product page', () => {
    const blog = '<html><head><title>Blog</title></head><body><h1>Our story</h1><p>Hello</p><a href="/contact">Contact</a></body></html>';
    const f = extractCommerce(cheerio.load(blog), blog, 'https://shop.example/blog/our-story');
    expect(f.isProduct).toBe(false);
    expect(f.addToCart.present).toBe(false);
  });
});

describe('checklist and score', () => {
  const good = extractCommerce(cheerio.load(productHtml()), productHtml(), 'https://shop.example/products/merino-runner');
  const bareHtml = '<html><body><h1>Thing</h1><form action="/cart/add"><button>Add to cart</button></form></body></html>';
  const bare = extractCommerce(cheerio.load(bareHtml), bareHtml, 'https://shop.example/products/thing');
  const browser = { available: false, consoleErrors: [], pageErrors: [], failedRequests: [], largeImages: [], mixedContent: [], thirdPartyDomains: [], blockedBySsrf: [] };

  it('scores a well-built store higher than a bare one', () => {
    const gs = conversionScore(evaluateChecks({ platform: 'Shopify', home: good, products: [{ url: 'u', facts: good }], probe: null, responsive: [], browser }));
    const bs = conversionScore(evaluateChecks({ platform: null, home: bare, products: [{ url: 'u', facts: bare }], probe: null, responsive: [], browser }));
    expect(gs).toBeGreaterThan(80);
    expect(bs).toBeLessThan(40);
  });

  it('marks checks without evidence as not applicable instead of failing them', () => {
    const checks = evaluateChecks({ platform: null, home: good, products: [], probe: null, responsive: [], browser });
    expect(checks.find((c) => c.key === 'atc-above-fold')?.pass).toBeNull();
    expect(checks.find((c) => c.key === 'no-overflow')?.pass).toBeNull();
  });

  it('does not blame the store for a country selector shown to a foreign test browser', () => {
    const probe = { url: 'u', viewportHeight: 844, atcFound: true, atcText: 'Add to cart', atcTop: 500, atcAboveFold: true, priceTop: 300, priceAboveFold: true, stickyAtc: true, popupCoverage: 1, popupLabel: 'Where are we shipping to?', geoPrompt: true };
    const checks = evaluateChecks({ platform: null, home: good, products: [{ url: 'u', facts: good }], probe, responsive: [], browser });
    expect(checks.find((c) => c.key === 'popup')?.pass).toBeNull();
  });
});

describe('concepts and client report', () => {
  it('escapes store data inside design concepts', () => {
    const d = conceptData(
      { isStore: true, platform: null, platformEvidence: [], productPages: [], categoryPages: [], sample: { name: '<img src=x onerror=alert(1)>', price: '10', currency: 'USD', rating: 5, reviewCount: 3, url: null }, conceptImage: 'javascript:alert(1)', responsive: [], productProbe: null, checks: [], score: 0, notes: [] },
      'shop.example',
    );
    const html = productPageConcept(d, [{ key: 'reviews', label: 'Reviews' }]);
    expect(html).not.toMatch(/<img src=x/);
    expect(html).not.toContain('javascript:');
    expect(html).toContain('$10.00');
  });
});

let srv: FixtureServer;
let unavailable = '';
beforeAll(async () => {
  srv = await startServer({
    '/': { body: page({ title: 'Merino Shop', body: '<header><nav><a href="/products/merino-runner">Runner</a><a href="/collections/all">Shop</a></nav></header><h1>Merino Shop</h1>' }) },
    '/collections/all': { body: page({ title: 'All', body: '<h1>All</h1><a href="/products/merino-runner">Runner</a>' }) },
    // A tall hero pushes the buy button below the fold; a popup covers the page after load.
    '/products/merino-runner': { body: productHtml('<div style="height:1400px">hero</div>').replace('<h1>Merino Runner</h1>', '<div style="height:1200px;background:#eee">gallery</div><h1>Merino Runner</h1>') },
    '/robots.txt': { headers: { 'content-type': 'text/plain' }, body: 'User-agent: *\nDisallow:\n' },
  });
  try {
    const { browser } = await launchBrowser();
    await browser.close();
  } catch (e) {
    unavailable = (e as Error).message;
  }
}, 60_000);
afterAll(() => srv?.close());

describe('e-commerce browser probes and end-to-end audit', () => {
  it('finds the buy button below the fold and checks responsive layouts', async (ctx) => {
    if (unavailable) ctx.skip();
    const session = await BrowserSession.start(path.join(os.tmpdir(), 'wii-ecom'), TEST_POLICY);
    try {
      const probe = await productProbe(session, `${srv.base}/products/merino-runner`, 'probe-test');
      expect(probe).toMatchObject({ atcFound: true, atcAboveFold: false });
      expect(probe!.atcTop).toBeGreaterThan(probe!.viewportHeight);
      const checks = await responsiveCheck(session, `${srv.base}/`, 'resp-test', DEVICES.slice(0, 2));
      expect(checks.map((c) => c.width)).toEqual([360, 390]);
      expect(checks.every((c) => !c.overflow && c.screenshot)).toBe(true);
    } finally {
      await session.close();
    }
  }, 120_000);

  it('runs an e-commerce audit whose client report recommends WHAT (with a concept) but never HOW', async (ctx) => {
    if (unavailable) ctx.skip();
    const r = await investigate(`${srv.base}/`, { policy: TEST_POLICY, limits: { perHostDelayMs: 0 }, screenshotDir: path.join(os.tmpdir(), 'wii-ecom-e2e'), focus: 'ecommerce' });
    expect(r.commerce?.isStore).toBe(true);
    expect(r.commerce?.platform).toBe('Shopify');
    expect(r.commerce?.productPages[0]).toContain('/products/merino-runner');
    const atc = r.candidates.find((c) => c.id === 'cro-atc-above-fold');
    expect(atc?.category).toBe('Conversion');
    expect(atc?.recommendation).toMatch(/Add-to-Cart/);
    expect(atc?.solution.join(' ')).toMatch(/Theme editor/); // Shopify-specific HOW — analyst only
    const html = renderClientReport(r, { imageSrc: () => null, branding: DEFAULT_BRANDING, clientName: null });
    expect(html).toContain('E-commerce Growth &amp; Conversion Report');
    expect(html).toContain('Conversion readiness');
    expect(html).toContain('cc-phone'); // before → after concept
    expect(html).toContain('Our recommendation');
    expect(html).not.toContain('Theme editor');
  }, 240_000);
});
