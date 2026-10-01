/**
 * Example design concepts (pure HTML/CSS wireframes) personalised with the store's own product data.
 * They illustrate WHAT the improvement looks like — not how to build it. All dynamic text is escaped;
 * images are only ever embedded data: URIs.
 */
import { esc } from '../report/esc.js';
import type { CommerceReport } from '../types.js';

export interface ConceptData {
  store: string;
  name: string;
  price: string;
  image: string | null;
  rating: number;
  reviews: number;
}

export function conceptData(c: CommerceReport, host: string): ConceptData {
  const s = c.sample;
  let price = s.price ?? '49.00';
  if (s.price && s.currency) {
    try {
      price = new Intl.NumberFormat('en', { style: 'currency', currency: s.currency }).format(Number(s.price));
    } catch {
      price = `${s.currency} ${s.price}`;
    }
  } else if (!s.price) price = '$49.00';
  return {
    store: host.replace(/^www\./, ''),
    name: (s.name ?? 'Your best-selling product').slice(0, 60),
    price,
    image: c.conceptImage && /^data:image\/(jpeg|png|webp|gif|avif);base64,[A-Za-z0-9+/=]+$/.test(c.conceptImage) ? c.conceptImage : null,
    rating: s.rating && s.rating > 0 && s.rating <= 5 ? s.rating : 4.8,
    reviews: s.reviewCount && s.reviewCount > 0 ? s.reviewCount : 126,
  };
}

const stars = (r: number) => `<span class="cc-stars" aria-label="${r.toFixed(1)} out of 5">${'★'.repeat(Math.round(r))}${'☆'.repeat(5 - Math.round(r))}</span>`;
const img = (d: ConceptData, cls = 'cc-img') => (d.image ? `<div class="${cls}"><img src="${esc(d.image)}" alt=""></div>` : `<div class="${cls} cc-ph"><span>Product photo</span></div>`);
const tag = (n: number) => `<span class="cc-num">${n}</span>`;

/** Full mobile product page concept; numbered markers match the numbered improvements listed beside it. */
export function productPageConcept(d: ConceptData, improvements: { key: string; label: string }[]): string {
  const n = (key: string) => {
    const i = improvements.findIndex((x) => x.key === key);
    return i >= 0 ? tag(i + 1) : '';
  };
  return `<div class="cc-phone" aria-label="Design concept: mobile product page">
    <div class="cc-status"><span>9:41</span><span>● ● ●</span></div>
    <div class="cc-announce">${n('free-shipping')}Free shipping over $50 · 30-day returns</div>
    <div class="cc-header"><span>☰</span><b>${esc(d.store)}</b><span>⌕ 🛒</span></div>
    <div class="cc-gallery">${img(d)}${n('product-images')}<div class="cc-dots"><i class="on"></i><i></i><i></i><i></i><i></i></div></div>
    <div class="cc-body">
      <div class="cc-title">${esc(d.name)}</div>
      <div class="cc-rating">${n('reviews')}${stars(d.rating)} <span>${d.rating.toFixed(1)} · ${d.reviews} reviews</span></div>
      <div class="cc-price">${n('price-above-fold')}${esc(d.price)} <span class="cc-stock">● In stock</span></div>
      <div class="cc-atc">${n('atc-above-fold')}Add to cart</div>
      <div class="cc-express">${n('express-pay')}<span>Apple Pay</span><span>G Pay</span><span>PayPal</span></div>
      <div class="cc-ship">${n('shipping-info')}🚚 Order in 3h 12m — delivered <b>Thu–Fri</b></div>
      <div class="cc-trust">${n('returns')}<span>↺ Free returns</span><span>🔒 Secure checkout</span><span>★ ${d.reviews}+ reviews</span></div>
    </div>
    <div class="cc-sticky">${n('sticky-atc')}<span>${esc(d.price)}</span><b>Add to cart</b></div>
  </div>`;
}

const MINI: Record<string, (d: ConceptData) => string> = {
  'product-mobile': (d) => `<div class="cc-mini"><div class="cc-mini-row">${img(d, 'cc-thumb')}<div><div class="cc-title sm">${esc(d.name)}</div>${stars(d.rating)}<div class="cc-price sm">${esc(d.price)}</div></div></div><div class="cc-atc sm">Add to cart</div><div class="cc-express sm"><span>Apple Pay</span><span>G Pay</span><span>PayPal</span></div></div>`,
  'sticky-atc': (d) => `<div class="cc-mini cc-scroll"><div class="cc-lines"><i></i><i></i><i class="s"></i><i></i><i class="s"></i></div><div class="cc-sticky inline"><span>${esc(d.price)}</span><b>Add to cart</b></div></div>`,
  reviews: (d) => `<div class="cc-mini"><div class="cc-rev-head"><b>${d.rating.toFixed(1)}</b>${stars(d.rating)}<span>${d.reviews} reviews</span></div>${[5, 4, 3].map((s, i) => `<div class="cc-bar"><span>${s}★</span><i><em class="w${i}"></em></i></div>`).join('')}<div class="cc-quote">“Great quality, arrived in 2 days.” — <b>Verified buyer</b></div></div>`,
  gallery: (d) => `<div class="cc-mini"><div class="cc-gal">${img(d, 'cc-gal-main')}<div class="cc-gal-thumbs">${[0, 1, 2, 3].map(() => (d.image ? `<div class="cc-gt"><img src="${esc(d.image)}" alt=""></div>` : '<div class="cc-gt cc-ph"></div>')).join('')}</div></div><div class="cc-cap">Angles · detail · in use · scale · zoom</div></div>`,
  'trust-bar': () => `<div class="cc-mini"><div class="cc-trust grid"><span>🚚 Free delivery over $50</span><span>↺ 30-day free returns</span><span>🔒 Secure checkout</span><span>💬 Chat with us</span></div><div class="cc-pay"><span>VISA</span><span>Mastercard</span><span>PayPal</span><span>Apple Pay</span></div></div>`,
  announcement: (d) => `<div class="cc-mini"><div class="cc-announce big">Free shipping on orders over $50 🚚</div><div class="cc-header"><span>☰</span><b>${esc(d.store)}</b><span>⌕ 🛒</span></div><div class="cc-progress"><span>You’re <b>$12</b> away from free shipping</span><i><em></em></i></div></div>`,
  'cross-sell': (d) => `<div class="cc-mini"><div class="cc-cap left">Frequently bought together</div><div class="cc-xs">${[0, 1, 2].map(() => `<div>${img(d, 'cc-xs-img')}<span>${esc(d.price)}</span></div>`).join('<b>+</b>')}</div><div class="cc-atc sm">Add all 3 to cart</div></div>`,
  header: (d) => `<div class="cc-mini"><div class="cc-header"><span>☰</span><b>${esc(d.store)}</b><span>🛒<sup>2</sup></span></div><div class="cc-search">⌕ Search products…</div><div class="cc-suggest"><span>${esc(d.name)}</span><span>Best sellers</span></div></div>`,
  email: (d) => `<div class="cc-mini cc-email"><b>Get 10% off your first order</b><span>New arrivals & offers from ${esc(d.store)}</span><div class="cc-email-row"><span>your@email.com</span><b>Join</b></div></div>`,
};

export function miniConcept(key: string | undefined, d: ConceptData): string {
  const f = key ? MINI[key] : undefined;
  return f ? `<div class="cc-mini-wrap"><div class="cc-label">Example concept</div>${f(d)}</div>` : '';
}

export const CONCEPT_CSS = `
.cc-phone{--cc:var(--accent,#2563eb);width:300px;border:10px solid #0f172a;border-radius:36px;background:#fff;overflow:hidden;position:relative;font:13px/1.35 system-ui,-apple-system,"Segoe UI",sans-serif;color:#0f172a;box-shadow:0 20px 50px rgba(15,23,42,.18);flex:none}
.cc-status{display:flex;justify-content:space-between;padding:6px 14px 2px;font-size:11px;font-weight:700}
.cc-announce{background:#0f172a;color:#fff;text-align:center;font-size:11px;font-weight:700;padding:5px 8px;position:relative}
.cc-announce.big{font-size:12.5px;padding:8px;border-radius:8px}
.cc-header{display:flex;justify-content:space-between;align-items:center;padding:8px 12px;border-bottom:1px solid #e2e8f0;font-size:15px}
.cc-header b{font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:60%}
.cc-header sup{background:var(--cc);color:#fff;border-radius:99px;padding:0 4px;font-size:9px}
.cc-gallery{position:relative}
.cc-img{height:190px;background:#f1f5f9;display:flex;align-items:center;justify-content:center;overflow:hidden}
.cc-img img,.cc-thumb img,.cc-gal-main img,.cc-gt img,.cc-xs-img img{width:100%;height:100%;object-fit:cover;display:block}
.cc-ph{background:linear-gradient(135deg,#e2e8f0,#f8fafc);color:#94a3b8;font-weight:700;font-size:12px}
.cc-dots{display:flex;gap:4px;justify-content:center;padding:6px}
.cc-dots i{width:6px;height:6px;border-radius:50%;background:#cbd5e1}.cc-dots i.on{background:#0f172a}
.cc-body{padding:4px 12px 64px;display:grid;gap:7px}
.cc-title{font-weight:800;font-size:15px;line-height:1.25}
.cc-title.sm{font-size:12.5px}
.cc-rating{display:flex;align-items:center;gap:6px;font-size:11.5px;color:#475569}
.cc-stars{color:#f59e0b;letter-spacing:1px}
.cc-price{font-size:19px;font-weight:800;display:flex;align-items:center;gap:8px}
.cc-price.sm{font-size:14px}
.cc-stock{font-size:11px;color:#16a34a;font-weight:700}
.cc-atc{background:var(--cc);color:#fff;text-align:center;font-weight:800;border-radius:10px;padding:11px;position:relative}
.cc-atc.sm{padding:8px;font-size:12.5px;margin-top:8px}
.cc-express{display:grid;grid-template-columns:repeat(3,1fr);gap:5px;position:relative}
.cc-express span{background:#0f172a;color:#fff;border-radius:8px;text-align:center;font-weight:700;font-size:11px;padding:7px 2px}
.cc-express.sm{margin-top:6px}
.cc-ship{font-size:11.5px;background:#f0fdf4;border-radius:8px;padding:7px 9px;color:#166534;position:relative}
.cc-trust{display:flex;flex-wrap:wrap;gap:5px;font-size:10.5px;position:relative}
.cc-trust span{background:#f1f5f9;border-radius:99px;padding:4px 8px;font-weight:600}
.cc-trust.grid{display:grid;grid-template-columns:1fr 1fr;gap:6px}
.cc-trust.grid span{border-radius:8px;padding:8px;font-size:11.5px}
.cc-pay{display:flex;gap:5px;margin-top:8px}
.cc-pay span{border:1px solid #e2e8f0;border-radius:6px;padding:3px 6px;font-size:10px;font-weight:800;color:#334155}
.cc-sticky{position:absolute;left:0;right:0;bottom:0;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 12px;background:#fff;border-top:1px solid #e2e8f0;box-shadow:0 -6px 16px rgba(15,23,42,.08);font-weight:800}
.cc-sticky b{background:var(--cc);color:#fff;border-radius:9px;padding:8px 16px}
.cc-sticky.inline{position:static;border-radius:12px;border:1px solid #e2e8f0;margin-top:8px}
.cc-num{position:absolute;left:-6px;top:-6px;width:20px;height:20px;border-radius:50%;background:#dc2626;color:#fff;font:800 11px/20px system-ui;text-align:center;box-shadow:0 0 0 3px #fff;z-index:2}
.cc-gallery .cc-num{left:8px;top:8px}.cc-rating,.cc-price{position:relative}.cc-rating .cc-num,.cc-price .cc-num{left:-10px}
.cc-sticky .cc-num{left:4px;top:-8px}.cc-announce .cc-num{left:4px;top:2px}
.cc-mini-wrap{border:1px dashed #cbd5e1;border-radius:14px;padding:10px;background:#f8fafc}
.cc-label{font:800 10px/1 system-ui;letter-spacing:.14em;text-transform:uppercase;color:#64748b;margin-bottom:8px}
.cc-mini{--cc:var(--accent,#2563eb);background:#fff;border-radius:12px;border:1px solid #e2e8f0;padding:10px;font:12.5px/1.35 system-ui,-apple-system,"Segoe UI",sans-serif;color:#0f172a}
.cc-mini-row{display:flex;gap:10px;align-items:center}
.cc-thumb{width:64px;height:64px;border-radius:8px;overflow:hidden;flex:none;background:#f1f5f9}
.cc-scroll .cc-lines{display:grid;gap:5px}.cc-lines i{height:8px;background:#e2e8f0;border-radius:4px}.cc-lines i.s{width:60%}
.cc-rev-head{display:flex;align-items:center;gap:8px;margin-bottom:6px}.cc-rev-head b{font-size:22px}.cc-rev-head span{color:#64748b;font-size:11.5px}
.cc-bar{display:flex;align-items:center;gap:6px;font-size:11px;margin:3px 0}.cc-bar i{flex:1;height:6px;background:#e2e8f0;border-radius:3px;overflow:hidden}.cc-bar em{display:block;height:100%;background:#f59e0b}
.cc-bar em.w0{width:82%}.cc-bar em.w1{width:13%}.cc-bar em.w2{width:4%}
.cc-quote{margin-top:6px;font-size:11.5px;color:#334155;background:#f8fafc;border-radius:8px;padding:6px 8px}
.cc-gal{display:grid;grid-template-columns:1fr 46px;gap:6px}.cc-gal-main{height:120px;border-radius:8px;overflow:hidden;background:#f1f5f9}
.cc-gal-thumbs{display:grid;gap:4px}.cc-gt{height:27px;border-radius:5px;overflow:hidden;background:#e2e8f0}
.cc-cap{font-size:11px;color:#64748b;text-align:center;margin-top:6px}.cc-cap.left{text-align:left;font-weight:700;color:#0f172a;margin:0 0 6px}
.cc-progress{margin-top:8px;font-size:11.5px}.cc-progress i{display:block;height:6px;background:#e2e8f0;border-radius:3px;margin-top:4px;overflow:hidden}.cc-progress em{display:block;width:76%;height:100%;background:#16a34a}
.cc-xs{display:flex;align-items:center;gap:4px}.cc-xs>div{flex:1;text-align:center;font-size:11px;font-weight:700}.cc-xs-img{height:56px;border-radius:8px;overflow:hidden;background:#f1f5f9;margin-bottom:3px}
.cc-search{margin-top:8px;border:2px solid var(--cc);border-radius:10px;padding:8px 10px;color:#64748b}
.cc-suggest{display:flex;gap:5px;flex-wrap:wrap;margin-top:6px}.cc-suggest span{background:#f1f5f9;border-radius:99px;padding:3px 8px;font-size:11px}
.cc-email{display:grid;gap:4px;text-align:center;background:linear-gradient(135deg,#fff,#eff6ff)}.cc-email b{font-size:14px}.cc-email>span{color:#64748b;font-size:11.5px}
.cc-email-row{display:flex;gap:5px;margin-top:6px}.cc-email-row span{flex:1;border:1px solid #cbd5e1;border-radius:8px;padding:7px;color:#94a3b8;text-align:left}.cc-email-row b{background:var(--cc);color:#fff;border-radius:8px;padding:7px 12px;font-size:12.5px}
`;
