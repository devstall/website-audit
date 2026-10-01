/**
 * Online-store signals from served HTML: platform hints, product data (schema.org / Open Graph),
 * add-to-cart, reviews, trust & payment cues, navigation helpers and policy links.
 * Read-only: nothing is clicked or added to a cart.
 */
import type { CheerioAPI } from 'cheerio';
import { isSameSite } from '../crawl/url.js';
import type { CommerceFacts } from '../types.js';

export const PRODUCT_URL_RE = /\/(products?|p|item|shop\/[^/]+\/[^/]+)\/[^/?#]+/i;
const CATEGORY_URL_RE = /\/(collections?|product-category|category|categories|shop|catalog|c)\/[^/?#]*/i;
export const ATC_RE = /\b(add to (cart|bag|basket|trolley|order)|buy (it )?now|add to shopping (cart|bag)|in den warenkorb|ajouter au panier|añadir al carrito)\b/i;

const PLATFORMS: [string, RegExp][] = [
  ['Shopify', /cdn\.shopify\.com|Shopify\.theme|window\.Shopify|myshopify\.com/],
  ['WooCommerce', /woocommerce|wc-block|wp-content\/plugins\/woocommerce/i],
  ['Magento / Adobe Commerce', /Magento_|mage\/cookies|data-mage-init|\/static\/version\d+\/frontend\//],
  ['BigCommerce', /cdn\d*\.bigcommerce\.com|stencil-utils|BCData/],
  ['Wix Stores', /wixstatic\.com.*(wix-ecommerce|stores)|wix-ecommerce/i],
  ['Squarespace Commerce', /squarespace.*commerce|sqs-add-to-cart/i],
  ['PrestaShop', /prestashop/i],
  ['OpenCart', /route=(product|checkout)\//],
  ['Ecwid', /app\.ecwid\.com|ecwid/i],
  ['Shopware', /shopware/i],
];

const PAYMENT_RE: [string, RegExp][] = [
  ['Visa', /\bvisa\b/i],
  ['Mastercard', /master-?card/i],
  ['American Express', /amex|american express/i],
  ['PayPal', /paypal/i],
  ['Apple Pay', /apple[- ]?pay/i],
  ['Google Pay', /google[- ]?pay|\bgpay\b/i],
  ['Shop Pay', /shop[- ]?pay/i],
  ['Klarna', /klarna/i],
  ['Afterpay / Clearpay', /afterpay|clearpay/i],
  ['Stripe', /stripe/i],
];

const EXPRESS_RE: [string, RegExp][] = [
  ['Shopify dynamic checkout', /shopify-payment-button|dynamic-checkout/i],
  ['Apple Pay', /apple-pay-button|applepay/i],
  ['Google Pay', /gpay-button|google-pay-button/i],
  ['PayPal', /paypal-button|paypal-buttons|ppc-button/i],
  ['Stripe payment request', /wc-stripe-payment-request|payment-request-button/i],
  ['Shop Pay', /shop-pay-button|shopify-accelerated-checkout/i],
];

const CHAT_RE: [string, RegExp][] = [
  ['Tawk.to', /tawk\.to/i],
  ['Intercom', /intercom/i],
  ['Tidio', /tidio/i],
  ['Crisp', /crisp\.chat/i],
  ['Zendesk', /zdassets|zendesk/i],
  ['LiveChat', /livechatinc/i],
  ['Drift', /drift\.com|driftt/i],
  ['Gorgias', /gorgias/i],
  ['WhatsApp', /wa\.me\/|api\.whatsapp\.com/i],
  ['Messenger', /m\.me\/|facebook\.com\/customer_chat/i],
  ['HubSpot chat', /hs-scripts|hubspot.*conversations/i],
];

const REVIEW_WIDGETS = /judge\.?me|yotpo|trustpilot|stamped|okendo|loox|reviews\.io|feefo|bazaarvoice|trustspot|woocommerce-product-rating|star-rating|spr-badge|jdgm/i;

function jsonLdProducts($: CheerioAPI): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const visit = (n: unknown) => {
    if (Array.isArray(n)) return n.forEach(visit);
    if (!n || typeof n !== 'object') return;
    const o = n as Record<string, unknown>;
    const t = o['@type'];
    if (t === 'Product' || (Array.isArray(t) && t.includes('Product')) || t === 'ProductGroup') out.push(o);
    if (o['@graph']) visit(o['@graph']);
  };
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      visit(JSON.parse($(el).contents().text()));
    } catch {
      /* invalid JSON-LD handled elsewhere */
    }
  });
  return out;
}

const first = <T>(v: T | T[] | undefined): T | undefined => (Array.isArray(v) ? v[0] : v);
const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/**
 * Combines served-HTML facts with facts from the JavaScript-rendered DOM. Many stores render footers,
 * review widgets and payment icons client-side, so a signal seen in EITHER version counts as present.
 */
export function mergeFacts(served: CommerceFacts, rendered: CommerceFacts): CommerceFacts {
  const or = <T extends Record<string, boolean>>(a: T, b: T): T => Object.fromEntries(Object.keys(a).map((k) => [k, a[k] || b[k]])) as T;
  const union = (a: string[], b: string[]) => [...new Set([...a, ...b])];
  return {
    ...served,
    platformHints: union(served.platformHints, rendered.platformHints),
    isProduct: served.isProduct || rendered.isProduct,
    isCategory: served.isCategory || rendered.isCategory,
    product: served.product && rendered.product
      ? {
          ...served.product,
          ...Object.fromEntries(Object.entries(rendered.product).filter(([k, v]) => v !== null && (served.product as Record<string, unknown>)[k] == null)),
          hasSchema: served.product.hasSchema || rendered.product.hasSchema,
          schemaHasOffer: served.product.schemaHasOffer || rendered.product.schemaHasOffer,
          schemaHasRating: served.product.schemaHasRating || rendered.product.schemaHasRating,
        }
      : (served.product ?? rendered.product),
    addToCart: served.addToCart.present ? served.addToCart : rendered.addToCart,
    productImages: Math.max(served.productImages, rendered.productImages),
    reviews: served.reviews || rendered.reviews,
    trust: or(served.trust, rendered.trust),
    paymentIcons: union(served.paymentIcons, rendered.paymentIcons),
    expressPay: union(served.expressPay, rendered.expressPay),
    shippingInfo: served.shippingInfo || rendered.shippingInfo,
    stock: served.stock || rendered.stock,
    crossSell: served.crossSell || rendered.crossSell,
    search: served.search || rendered.search,
    cartLink: served.cartLink || rendered.cartLink,
    chat: union(served.chat, rendered.chat),
    newsletter: served.newsletter || rendered.newsletter,
    policyLinks: or(served.policyLinks, rendered.policyLinks),
    phone: served.phone || rendered.phone,
    descriptionWords: Math.max(served.descriptionWords, rendered.descriptionWords),
    breadcrumbs: served.breadcrumbs || rendered.breadcrumbs,
    productLinks: union(served.productLinks, rendered.productLinks).slice(0, 40),
  };
}

export function extractCommerce($: CheerioAPI, rawHtml: string, pageUrl: string): CommerceFacts {
  const text = $('body').text().replace(/\s+/g, ' ');
  const lowerHtml = rawHtml.length > 600_000 ? rawHtml.slice(0, 600_000) : rawHtml;

  // Product data: schema.org first, then Open Graph / microdata.
  const schema = jsonLdProducts($)[0];
  const offers = first(schema?.offers as Record<string, unknown> | Record<string, unknown>[] | undefined);
  const rating = schema?.aggregateRating as Record<string, unknown> | undefined;
  const ogType = ($('meta[property="og:type"]').attr('content') ?? '').toLowerCase();
  const metaPrice = $('meta[property="product:price:amount"], meta[property="og:price:amount"]').attr('content') ?? $('[itemprop="price"]').first().attr('content') ?? null;
  const metaCurrency = $('meta[property="product:price:currency"], meta[property="og:price:currency"]').attr('content') ?? $('[itemprop="priceCurrency"]').first().attr('content') ?? null;
  const image = first(schema?.image as string | string[] | { url?: string } | undefined);
  const imageUrl = typeof image === 'string' ? image : (image as { url?: string } | undefined)?.url ?? $('meta[property="og:image"]').attr('content') ?? null;

  const atcEl = $('button, input[type=submit], input[type=button], a, [role=button]')
    .toArray()
    .find((el) => ATC_RE.test(($(el).text() || $(el).attr('value') || $(el).attr('aria-label') || '').trim()));
  const atcForm = $('form[action*="/cart/add"], button[name="add-to-cart"], .single_add_to_cart_button, [data-add-to-cart], .add-to-cart, #add-to-cart, .product-form__submit').length > 0;
  const addToCart = { present: !!atcEl || atcForm, text: atcEl ? ($(atcEl).text() || $(atcEl).attr('value') || '').replace(/\s+/g, ' ').trim().slice(0, 40) || null : null };

  const isProduct = !!schema || ogType === 'product' || ogType === 'og:product' || (addToCart.present && PRODUCT_URL_RE.test(new URL(pageUrl).pathname));

  const productLinks = [
    ...new Set(
      $('a[href]')
        .toArray()
        .map((a) => {
          try {
            return new URL($(a).attr('href') ?? '', pageUrl).href.split('#')[0]!;
          } catch {
            return '';
          }
        })
        .filter((u) => u && isSameSite(u, pageUrl) && PRODUCT_URL_RE.test(new URL(u).pathname) && !/\/cart|\/checkout/i.test(u)),
    ),
  ].slice(0, 40);
  const isCategory = !isProduct && (CATEGORY_URL_RE.test(new URL(pageUrl).pathname) ? productLinks.length >= 3 : productLinks.length >= 8);

  const galleryImgs = new Set(
    $('.product-gallery img, .product__media img, .woocommerce-product-gallery img, [data-product-media] img, .product-images img, .product-single__photos img, .product__photos img, .gallery img, [class*="product-gallery"] img, [class*="ProductGallery"] img, .fotorama img')
      .toArray()
      .map((i) => $(i).attr('src') ?? $(i).attr('data-src') ?? '')
      .filter(Boolean),
  );
  const schemaImages = Array.isArray(schema?.image) ? (schema!.image as unknown[]).length : schema?.image ? 1 : 0;

  // Include href-less links and link buttons (many stores open policies in JS modals).
  const anchors = $('a, [role=link], footer button').toArray().map((a) => `${$(a).text()} ${$(a).attr("href") ?? ""} ${$(a).attr("aria-controls") ?? ""}`.toLowerCase());
  const hasLink = (re: RegExp) => anchors.some((a) => re.test(a));

  const descEl = $('[itemprop="description"], .product-description, .product__description, .product-single__description, #tab-description, .woocommerce-product-details__short-description, .product-info__description').first();
  const descText = descEl.length ? descEl.text() : typeof schema?.description === 'string' ? schema.description : '';

  const platformHints = PLATFORMS.filter(([, re]) => re.test(lowerHtml)).map(([name]) => name);
  const paymentSources = $('img, svg, [class*="payment"], [class*="icon"]')
    .toArray()
    .map((el) => `${$(el).attr('alt') ?? ''} ${$(el).attr('class') ?? ''} ${$(el).attr('src') ?? ''} ${$(el).attr('title') ?? ''} ${$(el).attr('aria-label') ?? ''} ${$(el).is('svg') ? $(el).find('title').text() : ''}`)
    .join(' ');

  return {
    platformHints,
    isProduct,
    isCategory,
    product: isProduct
      ? {
          name: (typeof schema?.name === 'string' ? schema.name : null) ?? ($('meta[property="og:title"]').attr('content') ?? $('h1').first().text().trim()) ?? null,
          price: offers?.price !== undefined ? String(offers.price) : offers?.lowPrice !== undefined ? String(offers.lowPrice) : metaPrice,
          currency: (typeof offers?.priceCurrency === 'string' ? offers.priceCurrency : null) ?? metaCurrency,
          availability: typeof offers?.availability === 'string' ? offers.availability.replace(/^https?:\/\/schema\.org\//, '') : null,
          image: imageUrl ? (() => {
            try {
              return new URL(imageUrl, pageUrl).href;
            } catch {
              return null;
            }
          })() : null,
          rating: num(rating?.ratingValue),
          reviewCount: num(rating?.reviewCount ?? rating?.ratingCount),
          hasSchema: !!schema,
          schemaHasOffer: !!offers && (offers.price !== undefined || offers.lowPrice !== undefined),
          schemaHasRating: !!rating && num(rating.ratingValue) !== null,
        }
      : null,
    addToCart,
    productImages: Math.max(galleryImgs.size, schemaImages),
    reviews: !!rating || REVIEW_WIDGETS.test(lowerHtml) || /\b\d+(\.\d)?\s*(out of 5|\/\s*5 stars?)|\b\d+\s+(customer )?reviews?\b|\breviews?\s*\(\d+\)/i.test(text),
    trust: {
      freeShipping: /free (shipping|delivery)|free uk delivery|kostenloser versand|livraison gratuite/i.test(text),
      returns: /(\d+[- ]day|free|easy|hassle[- ]free)\s+returns?|returns? (policy|&)|money[- ]back|refund policy/i.test(text),
      guarantee: /guarantee|warranty/i.test(text),
      secure: /secure (checkout|payment|shopping)|ssl secured|256-?bit|safe checkout/i.test(text),
    },
    paymentIcons: PAYMENT_RE.filter(([, re]) => re.test(paymentSources)).map(([n]) => n),
    expressPay: EXPRESS_RE.filter(([, re]) => re.test(lowerHtml)).map(([n]) => n),
    shippingInfo: /(ships|delivered|dispatched|arrives)\s+(in|within|by|today|tomorrow)|estimated delivery|delivery (time|estimate|info)|shipping (info|details|calculated|times?)|order (today|now|before)/i.test(text),
    stock: /\bin stock\b|only \d+ left|low stock|out of stock|available now/i.test(text) || /InStock|OutOfStock/.test(String(offers?.availability ?? '')),
    crossSell: /you may also like|related products|customers also (bought|viewed|liked)|frequently bought together|recommended for you|complete the look|pairs well with|similar products/i.test(text),
    search: $('input[type=search], form[role=search], input[name=q], input[name=s], input[name=search], [aria-label*="search" i], a[href*="/search"]').length > 0,
    cartLink: $('a[href*="/cart"], a[href*="/basket"], a[href*="/bag"], [class*="cart-icon"], [aria-label*="cart" i], [class*="minicart"], [class*="header__cart"]').length > 0,
    chat: CHAT_RE.filter(([, re]) => re.test(lowerHtml)).map(([n]) => n),
    newsletter: $('input[type=email]').toArray().some((i) => !$(i).closest('form[action*="login"], form[action*="checkout"], form[action*="account"]').length) && /newsletter|subscribe|sign up|join (our|the) (list|club)|% off your first/i.test(text),
    policyLinks: {
      returns: hasLink(/return|refund/),
      shipping: hasLink(/shipping|delivery/),
      privacy: hasLink(/privacy/),
      terms: hasLink(/terms|conditions|agb/),
      contact: hasLink(/contact/),
    },
    phone: $('a[href^="tel:"]').length > 0,
    descriptionWords: descText.split(/\s+/).filter(Boolean).length,
    breadcrumbs: $('nav[aria-label*="breadcrumb" i], .breadcrumb, .breadcrumbs, .woocommerce-breadcrumb').length > 0 || /"BreadcrumbList"/.test(lowerHtml),
    productLinks,
  };
}
