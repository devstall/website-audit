/**
 * Browser checks for the e-commerce audit (all read-only — nothing is clicked or added to a cart):
 *  - responsive check at several device sizes (overflow, small text, small tap targets) + screenshots
 *  - mobile product-page probe: is Add-to-Cart / price visible without scrolling, sticky Add-to-Cart,
 *    intrusive popups, and an annotated screenshot showing the fold and the buy button
 */
import path from 'node:path';
import { DESKTOP, MOBILE, type BrowserSession, type DeviceProfile } from '../browser/browser.js';
import type { ProductProbe, ViewportCheck } from '../types.js';

export const DEVICES: { name: string; profile: DeviceProfile }[] = [
  { name: 'Small phone', profile: { ...MOBILE, viewport: { width: 360, height: 740 } } },
  { name: 'Phone', profile: MOBILE },
  { name: 'Tablet', profile: { ...MOBILE, viewport: { width: 768, height: 1024 }, deviceScaleFactor: 1.5 } },
  { name: 'Laptop', profile: DESKTOP },
  { name: 'Large desktop', profile: { ...DESKTOP, viewport: { width: 1920, height: 1080 } } },
];

const ATC_SOURCE = String.raw`\b(add to (cart|bag|basket|trolley|order)|buy (it )?now|add to shopping (cart|bag)|in den warenkorb|ajouter au panier|añadir al carrito)\b`;

async function load(session: BrowserSession, profile: DeviceProfile, url: string) {
  const ctx = await session.contextFor(profile);
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'load', timeout: 30_000 });
  await page.waitForLoadState('networkidle', { timeout: 6_000 }).catch(() => undefined);
  await page.waitForTimeout(800);
  return { ctx, page };
}

export async function responsiveCheck(session: BrowserSession, url: string, shotPrefix: string, devices = DEVICES): Promise<ViewportCheck[]> {
  const out: ViewportCheck[] = [];
  for (const d of devices) {
    let ctx;
    try {
      const loaded = await load(session, d.profile, url);
      ctx = loaded.ctx;
      const page = loaded.page;
      const m = await page.evaluate(() => {
        const vw = document.documentElement.clientWidth || window.innerWidth;
        const contentWidth = Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0);
        const clip = (el: Element) => ['hidden', 'clip'].includes(getComputedStyle(el).overflowX);
        const clipped = clip(document.documentElement) || (document.body ? clip(document.body) : false);
        const label = (el: Element) => {
          const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 2) : [];
          return el.tagName.toLowerCase() + (el.id ? `#${el.id}` : '') + cls.map((c) => `.${c}`).join('');
        };
        const overflowing: string[] = [];
        if (contentWidth > vw + 1) {
          for (const el of Array.from(document.body?.querySelectorAll('*') ?? [])) {
            const r = el.getBoundingClientRect();
            if (!r.width || r.right <= vw + 1 || getComputedStyle(el).position === 'fixed') continue;
            const p = el.parentElement;
            if (p && p !== document.body && p.getBoundingClientRect().right > vw + 1) continue;
            overflowing.push(`${label(el)} (${Math.round(r.width)}px wide)`);
            if (overflowing.length >= 5) break;
          }
        }
        // Text size: share of visible characters rendered below 12px.
        let total = 0;
        let small = 0;
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const t = (n.textContent ?? '').trim();
          const el = n.parentElement;
          if (t.length < 3 || !el) continue;
          const st = getComputedStyle(el);
          if (st.visibility === 'hidden' || st.display === 'none') continue;
          const r = el.getBoundingClientRect();
          if (!r.width || !r.height) continue;
          total += t.length;
          if (parseFloat(st.fontSize) < 12) small += t.length;
        }
        // Tap targets below 24×24 CSS px (WCAG 2.2 SC 2.5.8), excluding links inside running text.
        const tiny: string[] = [];
        let tinyCount = 0;
        for (const el of Array.from(document.querySelectorAll('a[href], button, input:not([type=hidden]), select, [role=button]'))) {
          const r = el.getBoundingClientRect();
          if (!r.width || !r.height || r.bottom < 0) continue;
          const st = getComputedStyle(el);
          if (st.visibility === 'hidden') continue;
          const inline = st.display === 'inline' && !!el.parentElement?.closest('p, li, td, span');
          // Visually-hidden helpers (e.g. "Skip to content", sr-only) are not tap targets.
          const srOnly = r.width <= 2 || r.height <= 2 || /(^|\s)(sr-only|visually-hidden|screen-reader-text|skip-link|skip-to-content)(\s|$)/i.test(typeof el.className === 'string' ? el.className : '') || (st.clip && st.clip !== 'auto') || /inset\(50%\)|inset\(100%\)/.test(st.clipPath);
          if (srOnly) continue;
          if (inline) continue;
          if (r.width < 24 || r.height < 24) {
            tinyCount++;
            if (tiny.length < 5) tiny.push(`${label(el)} ${Math.round(r.width)}×${Math.round(r.height)}px${el.textContent?.trim() ? ` "${el.textContent.trim().slice(0, 20)}"` : ''}`);
          }
        }
        return { vw, contentWidth, overflow: contentWidth > vw + 1 && !clipped, overflowing, smallTextPct: total ? Math.round((small / total) * 100) : 0, tinyCount, tiny };
      });
      const file = `${shotPrefix}-${d.profile.viewport.width}.jpg`;
      await page.screenshot({ path: path.join(session.shotDir, file), type: 'jpeg', quality: 62 });
      out.push({
        device: d.name,
        width: d.profile.viewport.width,
        height: d.profile.viewport.height,
        contentWidth: m.contentWidth,
        overflow: m.overflow,
        overflowing: m.overflowing,
        smallTextPct: m.smallTextPct,
        smallTapTargets: m.tinyCount,
        smallTapExamples: m.tiny,
        screenshot: file,
      });
    } catch {
      /* this device could not be rendered — skipped, not reported as a problem */
    } finally {
      await ctx?.close().catch(() => undefined);
    }
  }
  return out;
}

/** HTML after JavaScript has run (footers, review widgets and payment icons are often client-rendered). */
export async function renderedHtml(session: BrowserSession, url: string): Promise<string | null> {
  let ctx;
  try {
    const loaded = await load(session, DESKTOP, url);
    ctx = loaded.ctx;
    await loaded.page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await loaded.page.waitForTimeout(1200); // lazy footers / review widgets
    return await loaded.page.content();
  } catch {
    return null;
  } finally {
    await ctx?.close().catch(() => undefined);
  }
}

export async function productProbe(session: BrowserSession, url: string, shotName: string): Promise<ProductProbe | null> {
  let ctx;
  try {
    const loaded = await load(session, MOBILE, url);
    ctx = loaded.ctx;
    const page = loaded.page;
    await page.waitForTimeout(1500); // let delayed popups appear
    const first = await page.evaluate((atcSource) => {
      const atcRe = new RegExp(atcSource, 'i');
      const vh = window.innerHeight;
      const visible = (el: Element) => {
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) !== 0;
      };
      // The main buy button lives in the normal page flow: not inside a fixed drawer/modal, not transparent
      // through an ancestor, and not moved off-screen (hidden size drawers reuse the same labels).
      const inFlow = (el: Element) => {
        const r = el.getBoundingClientRect();
        if (r.width < 40 || r.height < 20 || r.right <= 0 || r.left >= window.innerWidth || !visible(el)) return false;
        for (let n: Element | null = el; n && n !== document.body; n = n.parentElement) {
          const st = getComputedStyle(n);
          if (st.position === 'fixed' || st.opacity === '0' || st.visibility === 'hidden' || st.display === 'none') return false;
        }
        return true;
      };
      const formButton = Array.from(
        document.querySelectorAll('form[action*="/cart/add"] [type=submit], form[action*="/cart/add"] button[name=add], .product-form__submit, .single_add_to_cart_button, button[name="add-to-cart"], [data-add-to-cart], #product-addtocart-button, [data-testid*="add-to-cart" i]'),
      ).find((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && inFlow(el);
      });
      const gatedRe = /\b(select (a )?(size|option|variant|colou?r)|choose (a )?(size|option)|select options)\b/i;
      const byText = Array.from(document.querySelectorAll('button, input[type=submit], input[type=button], a, [role=button]')).filter(
        (el) => inFlow(el) && (atcRe.test(((el as HTMLElement).innerText || (el as HTMLInputElement).value || el.getAttribute('aria-label') || '').trim()) || gatedRe.test(((el as HTMLElement).innerText || '').trim())),
      );
      // The main buy button is the first one on the page (recommendation carousels further down reuse the label).
      const atc = formButton ?? byText.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0];
      const priceRe = /([$€£¥₹৳]|\b(usd|eur|gbp|inr|bdt|aud|cad|tk)\b)\s?\d|\d[\d.,]*\s?([$€£¥₹৳]|\b(usd|eur|gbp|kr|zł)\b)/i;
      const price = Array.from(document.querySelectorAll('[itemprop=price], [class*="price" i], [data-price], .money, .amount'))
        .filter((el) => visible(el) && priceRe.test((el as HTMLElement).innerText || ''))
        .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0] ??
        Array.from(document.querySelectorAll('main *, [role=main] *, body *'))
          .filter((el) => el.childElementCount === 0 && visible(el) && getComputedStyle(el).position !== 'fixed')
          .filter((el) => {
            const t = ((el as HTMLElement).innerText || '').trim();
            return t.length > 0 && t.length <= 24 && priceRe.test(t);
          })
          .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0];
      // Popups: sample points across the screen and ask what is really on top (hit-testing ignores
      // invisible / pointer-transparent wrappers that a bounding-box check would count).
      const overlayOf = (el: Element | null): HTMLElement | null => {
        let best: HTMLElement | null = null;
        for (let n = el; n && n !== document.body; n = n.parentElement) {
          const st = getComputedStyle(n);
          if (st.position === 'fixed') {
            const r = n.getBoundingClientRect();
            if (!(r.height < 130 && (r.top <= 0 || r.bottom >= vh))) best = n as HTMLElement; // not a header / bottom bar
          }
        }
        return best;
      };
      const hits = new Map<HTMLElement, number>();
      let samples = 0;
      for (let y = 0.2; y <= 0.9; y += 0.175) {
        for (const x of [0.15, 0.5, 0.85]) {
          samples++;
          const o = overlayOf(document.elementFromPoint(window.innerWidth * x, vh * y));
          if (o) hits.set(o, (hits.get(o) ?? 0) + 1);
        }
      }
      let coverage = 0;
      let popupLabel: string | null = null;
      for (const [o, n] of hits) {
        if (n / samples > coverage) {
          coverage = n / samples;
          const txt = (o.innerText || '').replace(/\s+/g, ' ').trim();
          popupLabel = (txt.slice(0, 60) || o.getAttribute('aria-label') || o.id || o.tagName.toLowerCase()).slice(0, 60);
        }
      }
      const top = (el: Element | undefined) => (el ? Math.round(el.getBoundingClientRect().top + window.scrollY) : null);
      if (atc) atc.setAttribute('data-wii-atc', '1');
      if (price) price.setAttribute('data-wii-price', '1');
      const geoPrompt = !!popupLabel && /shipping to|ship to|your (country|region|location)|choose (your )?(country|region|language|currency)|select (your )?(country|region|language|currency)|change (country|region)|you('| a)re (visiting|browsing) from|land auswählen/i.test(popupLabel);
      return { vh, geoPrompt, atcTop: top(atc), atcText: atc ? ((atc as HTMLElement).innerText || (atc as HTMLInputElement).value || '').trim().slice(0, 40) : null, priceTop: top(price), coverage: Math.round(coverage * 100) / 100, popupLabel };
    }, ATC_SOURCE);

    // Sticky add-to-cart: scroll well past the button and see whether a buy button stays on screen.
    await page.evaluate((y) => window.scrollTo(0, y), Math.max(first.vh * 2, (first.atcTop ?? 0) + first.vh));
    await page.waitForTimeout(700);
    const stickyAtc = await page.evaluate((atcSource) => {
      const atcRe = new RegExp(atcSource, 'i');
      return Array.from(document.querySelectorAll('button, input[type=submit], a, [role=button]')).some((el) => {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height || r.top < 0 || r.bottom > window.innerHeight) return false;
        if (!atcRe.test(((el as HTMLElement).innerText || (el as HTMLInputElement).value || '').trim())) return false;
        for (let n: Element | null = el; n; n = n.parentElement) if (['fixed', 'sticky'].includes(getComputedStyle(n).position)) return true;
        return false;
      });
    }, ATC_SOURCE);

    // Annotated screenshot: fold line + outlined buy button and price.
    await page.evaluate(({ vh }) => {
      window.scrollTo(0, 0);
      const mark = (sel: string, color: string, text: string) => {
        const el = document.querySelector(sel) as HTMLElement | null;
        if (!el) return;
        el.style.outline = `4px solid ${color}`;
        el.style.outlineOffset = '3px';
        const r = el.getBoundingClientRect();
        const tag = document.createElement('div');
        tag.textContent = text;
        tag.style.cssText = `position:absolute;left:8px;top:${r.top + window.scrollY - 30}px;background:${color};color:#fff;font:700 13px/1 system-ui;padding:6px 8px;border-radius:6px;z-index:2147483647`;
        document.body.appendChild(tag);
      };
      const line = document.createElement('div');
      line.style.cssText = `position:absolute;left:0;right:0;top:${vh}px;border-top:4px dashed #dc2626;z-index:2147483647`;
      const label = document.createElement('div');
      label.textContent = 'FOLD — shoppers see only the area above this line without scrolling';
      label.style.cssText = `position:absolute;left:8px;right:8px;top:${vh + 6}px;background:#dc2626;color:#fff;font:700 12px/1.3 system-ui;padding:6px 8px;border-radius:6px;z-index:2147483647`;
      document.body.append(line, label);
      const atc = document.querySelector('[data-wii-atc]') as HTMLElement | null;
      const aboveFold = !!atc && atc.getBoundingClientRect().top + window.scrollY + atc.getBoundingClientRect().height <= vh;
      mark('[data-wii-atc]', aboveFold ? '#16a34a' : '#dc2626', aboveFold ? 'Add to cart ✓ visible' : 'Add to cart — hidden below the fold');
      mark('[data-wii-price]', '#2563eb', 'Price');
    }, { vh: first.vh });
    await page.waitForTimeout(200);
    const shot = `${shotName}.jpg`;
    const docHeight = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.screenshot({ path: path.join(session.shotDir, shot), type: 'jpeg', quality: 70, fullPage: true, clip: { x: 0, y: 0, width: MOBILE.viewport.width, height: Math.min(docHeight, Math.round(first.vh * 1.6)) } });

    const atcBottomGuess = first.atcTop !== null ? first.atcTop + 44 : null;
    return {
      url,
      viewportHeight: first.vh,
      atcFound: first.atcTop !== null,
      atcText: first.atcText,
      atcTop: first.atcTop,
      atcAboveFold: atcBottomGuess !== null && atcBottomGuess <= first.vh,
      priceTop: first.priceTop,
      priceAboveFold: first.priceTop !== null && first.priceTop < first.vh,
      stickyAtc,
      popupCoverage: first.coverage,
      popupLabel: first.popupLabel,
      geoPrompt: first.geoPrompt,
      annotatedScreenshot: shot,
    };
  } catch {
    return null;
  } finally {
    await ctx?.close().catch(() => undefined);
  }
}
