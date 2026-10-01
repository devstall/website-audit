/**
 * Conversion best-practice checklist. Each check has:
 *  - an observable pass/fail rule on the collected evidence (null = not applicable / not measurable)
 *  - a revenue rationale and a customer-facing recommendation (WHAT — shown on client reports)
 *  - private, platform-aware implementation steps (HOW — analyst report only)
 *  - an optional design concept key
 * Research references are limited to widely published studies and phrased conservatively.
 */
import type { BrowserReport, CommerceArea, CommerceCheck, CommerceFacts, Level, ProductProbe, ResponsiveResult } from '../types.js';

export interface CheckInput {
  platform: string | null;
  home: CommerceFacts | null;
  products: { url: string; facts: CommerceFacts }[];
  probe: ProductProbe | null;
  responsive: ResponsiveResult[];
  browser: BrowserReport;
}

export interface CheckDef {
  key: string;
  area: CommerceArea;
  label: string;
  impact: Level;
  /** Outcome-style title used when the check fails. */
  failTitle: string;
  why: string;
  recommendation: string;
  how: (platform: string | null) => string[];
  concept?: string;
  evaluate: (i: CheckInput) => { pass: boolean | null; detail: string };
}

const anyPage = (i: CheckInput, f: (c: CommerceFacts) => boolean) => [i.home, ...i.products.map((p) => p.facts)].some((c) => !!c && f(c));
const allProducts = (i: CheckInput, f: (c: CommerceFacts) => boolean) => i.products.length > 0 && i.products.every((p) => f(p.facts));
const someProducts = (i: CheckInput, f: (c: CommerceFacts) => boolean) => i.products.some((p) => f(p.facts));
const noProducts = { pass: null, detail: 'No product page could be analysed' };

const shopify = (p: string | null) => p === 'Shopify';
const woo = (p: string | null) => p === 'WooCommerce';
const platformSteps = (p: string | null, s: { shopify?: string[]; woo?: string[]; other: string[] }) => (shopify(p) && s.shopify ? s.shopify : woo(p) && s.woo ? s.woo : s.other);

export const CHECKS: CheckDef[] = [
  // ---------------- Product page ----------------
  {
    key: 'atc-above-fold',
    area: 'Product page',
    label: 'Add-to-Cart visible without scrolling (mobile)',
    impact: 'High',
    failTitle: 'Add-to-Cart button is hidden below the fold on mobile',
    why: 'Most shoppers browse on phones. If the buy button is not visible on the first screen, fewer visitors ever start checkout — every extra scroll loses buyers.',
    recommendation: 'Move the product title, price and Add-to-Cart button into the first screen on mobile (compact image gallery above, details below), and add a sticky Add-to-Cart bar.',
    how: (p) =>
      platformSteps(p, {
        shopify: ['Theme editor → Product template: reduce media height on mobile / use a slider gallery.', 'Move the "Buy buttons" block directly under title & price.', 'Add a sticky Add-to-Cart app or theme setting (many Online Store 2.0 themes include one).'],
        woo: ['Reduce the mobile gallery height (theme customizer or CSS on .woocommerce-product-gallery).', 'Move the add-to-cart form under the price (theme hooks: woocommerce_single_product_summary priorities).', 'Add a sticky add-to-cart plugin or theme option.'],
        other: ['Reorder the mobile product layout: compact gallery, then title, price and buy button.', 'Add a sticky buy bar on mobile.'],
      }),
    concept: 'product-mobile',
    evaluate: (i) => {
      const p = i.probe;
      if (!p) return noProducts;
      if (!p.atcFound) return { pass: false, detail: 'No Add-to-Cart / Buy button was found on the mobile product page' };
      return { pass: p.atcAboveFold, detail: p.atcAboveFold ? `"${p.atcText}" is visible on the first screen` : `"${p.atcText}" starts ${p.atcTop}px down — the phone screen shows only ${p.viewportHeight}px${p.stickyAtc ? ' (a sticky buy bar appears after scrolling)' : ''}` };
    },
  },
  {
    key: 'price-above-fold',
    area: 'Product page',
    label: 'Price visible without scrolling (mobile)',
    impact: 'Medium',
    failTitle: 'Price is not visible on the first mobile screen',
    why: 'Shoppers decide within seconds; hiding the price creates friction and makes visitors leave to compare elsewhere.',
    recommendation: 'Show the price (and any discount) right under the product title, above the fold on mobile.',
    how: () => ['Place the price block directly under the title in the product template; keep the gallery compact on mobile.'],
    concept: 'product-mobile',
    evaluate: (i) => (!i.probe ? noProducts : i.probe.priceTop === null ? { pass: null, detail: 'Price element could not be identified' } : { pass: i.probe.priceAboveFold, detail: `Price starts ${i.probe.priceTop}px down (screen height ${i.probe.viewportHeight}px)` }),
  },
  {
    key: 'sticky-atc',
    area: 'Product page',
    label: 'Sticky Add-to-Cart on mobile',
    impact: 'Medium',
    failTitle: 'No sticky Add-to-Cart on mobile product pages',
    why: 'Shoppers scroll down to read details and reviews. A buy button that stays on screen lets them purchase at the moment they are convinced.',
    recommendation: 'Add a slim sticky bar at the bottom of mobile product pages with the price and an Add-to-Cart button.',
    how: (p) => platformSteps(p, { shopify: ['Enable the theme’s sticky add-to-cart setting or install a lightweight sticky ATC app.'], woo: ['Enable the theme option or add a sticky add-to-cart plugin.'], other: ['Add a position:sticky bottom bar containing price + Add to cart on viewports < 768px.'] }),
    concept: 'sticky-atc',
    evaluate: (i) => (!i.probe?.atcFound ? { pass: null, detail: 'Needs a detectable Add-to-Cart button' } : { pass: i.probe.stickyAtc, detail: i.probe.stickyAtc ? 'A buy button stays on screen while scrolling' : 'After scrolling down, no buy button remains on screen' }),
  },
  {
    key: 'reviews',
    area: 'Product page',
    label: 'Customer reviews & star ratings on product pages',
    impact: 'High',
    failTitle: 'Product pages show no customer reviews or star ratings',
    why: 'Reviews are one of the strongest purchase triggers online; shoppers trust other buyers more than product copy. Pages without social proof convert noticeably worse.',
    recommendation: 'Collect and display product reviews with a star-rating summary near the title, and ask customers for a review after delivery.',
    how: (p) => platformSteps(p, { shopify: ['Install a reviews app (e.g. Judge.me, Okendo, Loox) and add its star-rating block under the title.', 'Enable automatic review-request emails.'], woo: ['Enable reviews (WooCommerce → Settings → Products → Enable product reviews / star rating).', 'Add review-request emails (plugin).'], other: ['Add a reviews system with a rating summary on product pages and post-purchase review requests.'] }),
    concept: 'reviews',
    evaluate: (i) => (i.products.length ? { pass: someProducts(i, (c) => c.reviews), detail: someProducts(i, (c) => c.reviews) ? 'Reviews / ratings found on product pages' : `None of ${i.products.length} product page(s) show reviews or ratings` } : noProducts),
  },
  {
    key: 'product-schema',
    area: 'Search visibility',
    label: 'Product structured data with price (Google rich results)',
    impact: 'High',
    failTitle: 'Products are missing price data for Google (Product schema)',
    why: 'Product structured data lets Google show price, availability and star ratings directly in search and Shopping results — listings that stand out get more clicks from ready-to-buy shoppers.',
    recommendation: 'Add complete Product structured data (name, image, price, currency, availability, rating) to every product page.',
    how: (p) => platformSteps(p, { shopify: ['Most OS 2.0 themes output Product JSON-LD — check the theme’s product template or add an SEO/schema app.'], woo: ['Ensure WooCommerce structured data is not disabled; an SEO plugin (Yoast WooCommerce SEO / Rank Math) completes it.'], other: ['Output JSON-LD "Product" with "offers" (price, priceCurrency, availability) and "aggregateRating".'] }),
    evaluate: (i) => (i.products.length ? { pass: allProducts(i, (c) => !!c.product?.schemaHasOffer), detail: allProducts(i, (c) => !!c.product?.schemaHasOffer) ? 'Product schema with price found' : `${i.products.filter((p) => !p.facts.product?.schemaHasOffer).length} product page(s) lack Product schema with a price` } : noProducts),
  },
  {
    key: 'rating-schema',
    area: 'Search visibility',
    label: 'Star ratings eligible for Google (aggregateRating)',
    impact: 'Medium',
    failTitle: 'Reviews exist but stars cannot appear in Google',
    why: 'Star ratings in search results increase click-through; the reviews are already there but not exposed to Google.',
    recommendation: 'Include the review rating and count in the product structured data so stars can show in Google.',
    how: () => ['Enable the review app’s "rich snippets"/schema option or add aggregateRating to the Product JSON-LD.'],
    evaluate: (i) => (!someProducts(i, (c) => c.reviews) ? { pass: null, detail: 'Not applicable until reviews are shown' } : { pass: someProducts(i, (c) => !!c.product?.schemaHasRating), detail: someProducts(i, (c) => !!c.product?.schemaHasRating) ? 'aggregateRating present' : 'Reviews are visible but not in structured data' }),
  },
  {
    key: 'product-images',
    area: 'Product page',
    label: 'At least 3 product images',
    impact: 'Medium',
    failTitle: 'Products have too few images',
    why: 'Shoppers cannot touch the product; multiple angles, scale and in-use photos reduce doubt and returns.',
    recommendation: 'Show 4–6 images per product: angles, close-up detail, scale/in-use and packaging; add zoom.',
    how: () => ['Upload additional product media; use the theme gallery with thumbnails and zoom.'],
    concept: 'gallery',
    evaluate: (i) => {
      if (!i.products.length) return noProducts;
      const counts = i.products.map((p) => p.facts.productImages).filter((n) => n > 0);
      if (!counts.length) return { pass: null, detail: 'Gallery images could not be identified' };
      const min = Math.min(...counts);
      return { pass: min >= 3, detail: `Fewest images on a product page: ${min}` };
    },
  },
  {
    key: 'shipping-info',
    area: 'Trust & checkout',
    label: 'Delivery time / shipping info on product page',
    impact: 'Medium',
    failTitle: 'Product pages don’t say when the order will arrive',
    why: 'Unexpected costs and unclear delivery are among the most common reasons shoppers abandon a purchase (Baymard Institute cart-abandonment research).',
    recommendation: 'Show delivery time and shipping cost (or the free-shipping threshold) next to the Add-to-Cart button.',
    how: () => ['Add a delivery/shipping info block under the buy button (theme block or small snippet).'],
    concept: 'trust-bar',
    evaluate: (i) => (i.products.length ? { pass: someProducts(i, (c) => c.shippingInfo || c.trust.freeShipping), detail: someProducts(i, (c) => c.shippingInfo || c.trust.freeShipping) ? 'Delivery / shipping information found' : 'No delivery time or shipping message on product pages' } : noProducts),
  },
  {
    key: 'cross-sell',
    area: 'Product page',
    label: 'Related products / cross-sells',
    impact: 'Medium',
    failTitle: 'No related products or cross-sells on product pages',
    why: '"You may also like" and "Frequently bought together" raise average order value and keep shoppers browsing instead of leaving.',
    recommendation: 'Add a "You may also like" / "Frequently bought together" section on product pages and in the cart.',
    how: (p) => platformSteps(p, { shopify: ['Add the "Related products"/"Product recommendations" section in the theme editor.'], woo: ['Set Linked Products (Upsells/Cross-sells) per product; ensure the theme shows related products.'], other: ['Add a recommendations block to the product template.'] }),
    concept: 'cross-sell',
    evaluate: (i) => (i.products.length ? { pass: someProducts(i, (c) => c.crossSell), detail: someProducts(i, (c) => c.crossSell) ? 'Related-product section found' : 'No related-product section detected' } : noProducts),
  },
  {
    key: 'express-pay',
    area: 'Trust & checkout',
    label: 'Express checkout (Apple Pay, Google Pay, PayPal, Shop Pay)',
    impact: 'Medium',
    failTitle: 'No express checkout buttons',
    why: 'One-tap wallets skip form filling on mobile — long checkout forms are a well-documented reason for abandoned carts.',
    recommendation: 'Offer express payment buttons (Apple Pay / Google Pay / PayPal / Shop Pay) on product and cart pages.',
    how: (p) => platformSteps(p, { shopify: ['Settings → Payments: enable Shop Pay, Apple Pay, Google Pay; enable "dynamic checkout buttons" in the product section.'], woo: ['Enable Payment Request buttons in WooPayments/Stripe settings; add PayPal Payments smart buttons.'], other: ['Enable wallet payments with your payment provider and show them on product/cart pages.'] }),
    concept: 'product-mobile',
    evaluate: (i) => (i.products.length ? { pass: anyPage(i, (c) => c.expressPay.length > 0), detail: anyPage(i, (c) => c.expressPay.length > 0) ? `Found: ${[...new Set([i.home, ...i.products.map((p) => p.facts)].flatMap((c) => c?.expressPay ?? []))].join(', ')}` : 'No express payment buttons detected on product pages' } : noProducts),
  },
  {
    key: 'description',
    area: 'Product page',
    label: 'Descriptive product copy (80+ words)',
    impact: 'Low',
    failTitle: 'Product descriptions are very short',
    why: 'Thin descriptions leave questions unanswered (size, material, use) and rank poorly in search.',
    recommendation: 'Write benefit-led descriptions with key specs, sizing/fit and care details; add an FAQ for common questions.',
    how: () => ['Expand descriptions in the product editor; use bullet points and a specs table.'],
    evaluate: (i) => {
      const words = i.products.map((p) => p.facts.descriptionWords).filter((n) => n > 0);
      if (!words.length) return i.products.length ? { pass: null, detail: 'Description block could not be identified' } : noProducts;
      return { pass: Math.min(...words) >= 80, detail: `Shortest description: ${Math.min(...words)} words` };
    },
  },
  // ---------------- Trust & checkout ----------------
  {
    key: 'returns',
    area: 'Trust & checkout',
    label: 'Returns / refund policy easy to find',
    impact: 'High',
    failTitle: 'No visible returns / refund policy',
    why: 'A clear, easy returns promise removes purchase risk — especially for first-time customers who don’t know the brand yet.',
    recommendation: 'Publish a clear returns policy, link it in the footer, and mention it near the Add-to-Cart button (e.g. "30-day free returns").',
    how: (p) => platformSteps(p, { shopify: ['Settings → Policies → Refund policy (auto-generates a page); add it to the footer menu.'], woo: ['Create a Returns & Refunds page and add it to the footer menu.'], other: ['Create a returns page, link it from the footer and product pages.'] }),
    concept: 'trust-bar',
    evaluate: (i) => ({ pass: anyPage(i, (c) => c.policyLinks.returns || c.trust.returns), detail: anyPage(i, (c) => c.policyLinks.returns || c.trust.returns) ? 'Returns information found' : 'No returns/refund link or message found' }),
  },
  {
    key: 'free-shipping',
    area: 'Trust & checkout',
    label: 'Free-shipping offer or threshold communicated',
    impact: 'Medium',
    failTitle: 'No free-shipping message or threshold',
    why: 'Shipping costs are the most common reason for abandoned carts (Baymard Institute). A free-shipping threshold also raises average order value.',
    recommendation: 'Add an announcement bar such as "Free shipping on orders over $50" and repeat it in the cart with a progress indicator.',
    how: (p) => platformSteps(p, { shopify: ['Settings → Shipping: add a free-shipping rate above a threshold; enable the theme announcement bar.'], woo: ['WooCommerce → Shipping → add Free shipping (minimum order amount); add a header notice bar.'], other: ['Configure a free-shipping threshold and announce it site-wide.'] }),
    concept: 'announcement',
    evaluate: (i) => ({ pass: anyPage(i, (c) => c.trust.freeShipping), detail: anyPage(i, (c) => c.trust.freeShipping) ? 'Free-shipping message found' : 'No free-shipping message on the analysed pages' }),
  },
  {
    key: 'payment-icons',
    area: 'Trust & checkout',
    label: 'Accepted payment methods shown',
    impact: 'Low',
    failTitle: 'Accepted payment methods are not shown',
    why: 'Familiar payment logos reassure shoppers that paying is safe and convenient.',
    recommendation: 'Show accepted payment method icons in the footer and near the buy button.',
    how: () => ['Enable the theme’s payment-icons option in the footer; add icons under the buy button.'],
    concept: 'trust-bar',
    evaluate: (i) => ({ pass: anyPage(i, (c) => c.paymentIcons.length >= 2), detail: anyPage(i, (c) => c.paymentIcons.length > 0) ? `Found: ${[...new Set([i.home, ...i.products.map((p) => p.facts)].flatMap((c) => c?.paymentIcons ?? []))].join(', ')}` : 'No payment method icons found' }),
  },
  {
    key: 'contact',
    area: 'Trust & checkout',
    label: 'Easy to contact (phone, chat or contact page)',
    impact: 'Medium',
    failTitle: 'Shoppers have no quick way to ask a question',
    why: 'Unanswered pre-purchase questions (sizing, delivery, compatibility) turn into lost sales. Visible contact options also signal a real, trustworthy business.',
    recommendation: 'Add live chat or WhatsApp, and show a phone number/contact link in the header or footer.',
    how: () => ['Install a chat widget (Tidio, Tawk.to, Shopify Inbox, WhatsApp button); add phone and contact links to the footer.'],
    concept: 'trust-bar',
    evaluate: (i) => {
      const chat = anyPage(i, (c) => c.chat.length > 0);
      const other = anyPage(i, (c) => c.phone || c.policyLinks.contact);
      return { pass: chat || other, detail: chat ? 'Live chat found' : other ? 'Contact page / phone found (no live chat)' : 'No chat, phone or contact link found' };
    },
  },
  {
    key: 'policies',
    area: 'Trust & checkout',
    label: 'Shipping, privacy and terms pages linked',
    impact: 'Low',
    failTitle: 'Key store policy pages are missing from the site navigation',
    why: 'Policy pages are expected by shoppers and required by payment providers and ad platforms (e.g. Google Merchant Center).',
    recommendation: 'Link Shipping, Returns, Privacy and Terms pages in the footer.',
    how: () => ['Create the pages and add them to the footer menu.'],
    evaluate: (i) => {
      const l = (k: keyof CommerceFacts['policyLinks']) => anyPage(i, (c) => c.policyLinks[k]);
      const missing = (['shipping', 'privacy', 'terms'] as const).filter((k) => !l(k));
      return { pass: missing.length === 0, detail: missing.length ? `Missing links: ${missing.join(', ')}` : 'All found' };
    },
  },
  // ---------------- Navigation & discovery ----------------
  {
    key: 'search',
    area: 'Navigation & discovery',
    label: 'Product search available',
    impact: 'High',
    failTitle: 'The store has no visible product search',
    why: 'Visitors who search know what they want — they are among the highest-intent shoppers. Without search, they leave when the menu doesn’t show the product.',
    recommendation: 'Add a prominent search bar (with product suggestions) in the header, visible on mobile.',
    how: (p) => platformSteps(p, { shopify: ['Enable the header search in the theme editor; use predictive search.'], woo: ['Add a product search block/widget to the header (e.g. FiboSearch for suggestions).'], other: ['Add a header product search with autocomplete.'] }),
    concept: 'header',
    evaluate: (i) => ({ pass: anyPage(i, (c) => c.search), detail: anyPage(i, (c) => c.search) ? 'Search found' : 'No search field or search link found' }),
  },
  {
    key: 'cart-link',
    area: 'Navigation & discovery',
    label: 'Cart visible in the header',
    impact: 'Medium',
    failTitle: 'No visible cart link in the header',
    why: 'Shoppers need to see and reach their cart from every page; hidden carts lead to abandoned purchases.',
    recommendation: 'Show a cart icon with an item count in the header on all pages.',
    how: () => ['Enable the header cart icon / mini-cart in the theme.'],
    concept: 'header',
    evaluate: (i) => ({ pass: anyPage(i, (c) => c.cartLink), detail: anyPage(i, (c) => c.cartLink) ? 'Cart link found' : 'No cart link or icon detected' }),
  },
  {
    key: 'email-capture',
    area: 'Navigation & discovery',
    label: 'Email capture (newsletter / first-order offer)',
    impact: 'Medium',
    failTitle: 'No email sign-up to win back visitors',
    why: 'Most first-time visitors don’t buy immediately. Capturing their email lets you bring them back with offers and new arrivals — usually one of a store’s most profitable channels.',
    recommendation: 'Add a newsletter sign-up with a first-order incentive (e.g. 10% off) in the footer and a polite, delayed popup.',
    how: () => ['Enable the footer newsletter form; use an email tool (Klaviyo, Mailchimp, Shopify Email) with a delayed, mobile-friendly popup.'],
    concept: 'email',
    evaluate: (i) => ({ pass: anyPage(i, (c) => c.newsletter), detail: anyPage(i, (c) => c.newsletter) ? 'Email sign-up found' : 'No newsletter / email sign-up found' }),
  },
  // ---------------- Mobile & responsive ----------------
  {
    key: 'no-overflow',
    area: 'Mobile & responsive',
    label: 'No sideways scrolling on any screen size',
    impact: 'High',
    failTitle: 'Pages scroll sideways on some screen sizes',
    why: 'Layouts that are wider than the screen look broken, hide content and make buttons hard to reach — shoppers lose trust quickly.',
    recommendation: 'Make every section fit the screen on phones and tablets (flexible images, tables and banners).',
    how: () => ['Fix the elements listed in the evidence: max-width:100% on media, flex-wrap on rows, no fixed pixel widths.'],
    evaluate: (i) => {
      const bad = i.responsive.flatMap((r) => r.checks.filter((c) => c.overflow).map((c) => `${r.label} @ ${c.device} (${c.width}px → ${c.contentWidth}px)`));
      if (!i.responsive.length) return { pass: null, detail: 'Browser check unavailable' };
      return { pass: bad.length === 0, detail: bad.length ? bad.join('; ') : 'No horizontal overflow at any tested size' };
    },
  },
  {
    key: 'readable-text',
    area: 'Mobile & responsive',
    label: 'Readable text on phones (≥ 12px)',
    impact: 'Medium',
    failTitle: 'Much of the text is too small to read on phones',
    why: 'Tiny text forces pinch-zooming; shoppers skim and leave instead of reading product details.',
    recommendation: 'Use at least 16px body text on mobile and 12px minimum for secondary text.',
    how: () => ['Raise mobile font sizes in the theme typography settings or CSS media queries.'],
    evaluate: (i) => {
      const phones = i.responsive.flatMap((r) => r.checks.filter((c) => c.width < 500).map((c) => ({ r, c })));
      if (!phones.length) return { pass: null, detail: 'Browser check unavailable' };
      const worst = phones.sort((a, b) => b.c.smallTextPct - a.c.smallTextPct)[0]!;
      return { pass: worst.c.smallTextPct < 15, detail: `${worst.c.smallTextPct}% of the text on ${worst.r.label} (${worst.c.device}) is smaller than 12px` };
    },
  },
  {
    key: 'tap-targets',
    area: 'Mobile & responsive',
    label: 'Buttons and links large enough to tap',
    impact: 'Medium',
    failTitle: 'Many buttons and links are too small to tap on phones',
    why: 'Small tap targets cause mis-taps and frustration, especially on menus, variant selectors and quantity buttons.',
    recommendation: 'Make every button, icon and link at least 24×24px (ideally 44×44px) with spacing between them.',
    how: () => ['Increase padding on icons, swatches, quantity steppers and footer links on mobile.'],
    evaluate: (i) => {
      const phones = i.responsive.flatMap((r) => r.checks.filter((c) => c.width < 500).map((c) => ({ r, c })));
      if (!phones.length) return { pass: null, detail: 'Browser check unavailable' };
      const worst = phones.sort((a, b) => b.c.smallTapTargets - a.c.smallTapTargets)[0]!;
      return { pass: worst.c.smallTapTargets <= 3, detail: `${worst.c.smallTapTargets} controls under 24×24px on ${worst.r.label} (${worst.c.device})${worst.c.smallTapExamples[0] ? `, e.g. ${worst.c.smallTapExamples[0]}` : ''}` };
    },
  },
  {
    key: 'popup',
    area: 'Mobile & responsive',
    label: 'No intrusive popup covering the product on mobile',
    impact: 'Medium',
    failTitle: 'A popup covers most of the mobile product page',
    why: 'Popups that cover the product on arrival interrupt shoppers; Google also treats intrusive mobile interstitials as a poor experience.',
    recommendation: 'Delay popups (e.g. after 30 seconds or on exit intent), keep them small on mobile, and make them easy to close.',
    how: () => ['Change the popup trigger to time/scroll/exit-intent; use a bottom slide-in on mobile.'],
    evaluate: (i) => {
      const p = i.probe;
      if (!p) return noProducts;
      if (p.popupCoverage >= 0.4 && p.geoPrompt) return { pass: null, detail: `A country/language selector (“${p.popupLabel}”) appeared — shown to our non-local test browser, likely not to local customers` };
      return { pass: p.popupCoverage < 0.4, detail: p.popupCoverage >= 0.4 ? `An overlay (“${p.popupLabel}”) covers ${Math.round(p.popupCoverage * 100)}% of the screen after load` : 'No large overlay after load' };
    },
  },
  // ---------------- Speed ----------------
  {
    key: 'mobile-speed',
    area: 'Speed',
    label: 'Fast mobile loading (LCP ≤ 2.5 s)',
    impact: 'High',
    failTitle: 'The store loads slowly on mobile',
    why: 'Speed directly affects sales: Deloitte’s “Milliseconds Make Millions” study found that even a 0.1 s mobile speed improvement increased retail conversions.',
    recommendation: 'Speed up the homepage and product pages on mobile (image sizes, apps/plugins, caching).',
    how: () => ['See the Core Web Vitals finding in the analyst report for the exact bottleneck.'],
    evaluate: (i) => {
      const lcp = i.browser.mobile?.lcpMs;
      return lcp == null ? { pass: null, detail: 'Not measured' } : { pass: lcp <= 2500, detail: `Mobile LCP ${(lcp / 1000).toFixed(1)} s (good ≤ 2.5 s)` };
    },
  },
];

const WEIGHT: Record<Level, number> = { High: 3, Medium: 2, Low: 1 };

export function evaluateChecks(i: CheckInput): CommerceCheck[] {
  return CHECKS.map((c) => {
    let r: { pass: boolean | null; detail: string };
    try {
      r = c.evaluate(i);
    } catch {
      r = { pass: null, detail: 'Could not be evaluated' };
    }
    return { key: c.key, area: c.area, label: c.label, pass: r.pass, detail: r.detail, impact: c.impact };
  });
}

/** Weighted share of applicable checks that pass. */
export function conversionScore(checks: CommerceCheck[]): number {
  const applicable = checks.filter((c) => c.pass !== null);
  const total = applicable.reduce((a, c) => a + WEIGHT[c.impact], 0);
  if (!total) return 0;
  return Math.round((applicable.filter((c) => c.pass).reduce((a, c) => a + WEIGHT[c.impact], 0) / total) * 100);
}
