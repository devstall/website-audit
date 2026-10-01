# Website Independent Investigator

Enter a public URL. The tool investigates the live website **from the outside only**, with no admin login, FTP, SSH, database, plugin, Search Console or hosting access. It reports **every** evidence-backed finding ranked by severity and confidence. The top issue gets a full deep-dive (evidence, screenshots, root cause, fix, re-check), and low-confidence signals are listed separately as unverified.

It is not an SEO score generator. The pipeline is:

**discover → verify → collect evidence → eliminate false positives → rank all findings (top issue explained in full) → recommend fixes**

## Quick start

```bash
npm install
npm start            # http://localhost:4173
```

Command-line mode (no server or database; writes an HTML report and JSON to `data/cli/`):

```bash
npm run investigate -- https://example.com
npm run investigate -- https://example.com --no-browser
```

Browser: Playwright uses its bundled Chromium if installed (`npx playwright install chromium`). Otherwise it falls back to an installed **Google Chrome** or **Microsoft Edge**. Set `WII_BROWSER_CHANNEL=chrome|msedge` to force one. Without any browser the investigation still runs, but it states that Core Web Vitals could not be measured.

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `4173` | HTTP port |
| `HOST` | `127.0.0.1` | Bind address (use `0.0.0.0` only behind an access-controlled proxy) |
| `WII_DATA_DIR` | `data` | SQLite database + screenshots |
| `WII_CONCURRENCY` | `2` | Parallel investigations (each runs a browser); also the max parallel re-checks |
| `WII_API_KEY` | (none) | When set, every `/api` call needs `X-WII-Key` (required when a WordPress site reaches the engine over a network) |

Requires Node ≥ 22.5 for the built-in `node:sqlite` (the npm scripts pass `--experimental-sqlite` for 22.5–22.12). If `node:sqlite` is unavailable, storage falls back to one JSON file per investigation.

## Fix Assistant, re-check and client report

After an investigation, the primary issue gets a **Fix This Issue** button that opens a guided panel:

1. **Understand**: what we found, why it is happening, how confident we are.
2. **Fix method**: one of WordPress Admin, SEO plugin setting, theme configuration, child theme code, custom plugin code, server, CDN/Cloudflare, content editor, image optimization, JS/CSS, redirects or hosting. Includes difficulty, required access, estimated time and risk, plus backup and staging advice where the change is risky.
3. **Exact instructions** for the environment detected from public signals. Yoast SEO, Rank Math, AIOSEO, LiteSpeed Cache, WP Rocket, W3TC, WP Super Cache, Elementor, WooCommerce and Cloudflare menu paths appear **only when that tool was detected**.
4. **Developer fix** (when code is needed): file, location (child theme or `mu-plugins`, never the parent theme), code, what it does, why it fixes the issue, side effects and how to revert.
5. **Before / After** built from the real evidence (for example the actual canonical tag or redirect chain).

Issue confidence and fix confidence are shown separately. Root cause is graded Confirmed / Likely / Possible / Unknown. Buttons: View Fix Instructions, Copy Fix (plus a Copy button on each block), Re-check This Issue. There is no automatic fix: the tool is read-only.

**Re-check engine** (`src/recheck/`): each issue type has a probe (`probes.ts`). A probe says which evidence to collect again and which detector decides the result. It also defines how the affected items are measured. The same `measure()` runs at investigation time (stored as `result.baseline`) and at re-check time, so BEFORE and AFTER are comparable. A re-check fetches only what the issue needs, for example the homepage, the affected pages, their canonical tags and targets, and the redirect chain. In practice that is about 2–10 requests instead of ~100. The browser starts only for browser-measured issues.

| Status | When |
|---|---|
| ✓ Resolved | The detector no longer reproduces the issue **and** every measured item is ok **and** nothing blocked the check |
| ⚠ Still detected | The detector reproduces it, or any affected item still shows the problem (current evidence shown) |
| ? Unable to verify | Homepage unreachable/blocked, affected pages could not be fetched, a required browser was unavailable, or no fresh evidence |

The report status is Open or In Progress (set manually), or Resolved or Unable to Verify. Those last two are set **only** from re-check evidence. Re-check history records each re-check's date, evidence, status, and which fix instructions were shown before it. The private **analyst report** (`…/analyst-report.html`) adds sections for root cause, exact fix instructions, code, verification method and resolution status. When the issue was resolved, it shows BEFORE → FIX APPLIED BY USER → AFTER.

## Client report (sales-ready) vs analyst report

| | Client report (`report.html` / `report.pdf`) | Analyst report (`analyst-report.html`) |
|---|---|---|
| Audience | The prospect / client | You |
| Content | Cover with your branding, health score 0–100 and grade, top issues, executive summary, scorecard for 6 areas, mobile Core Web Vitals with Google thresholds, screenshots, every verified issue with evidence and **business impact** | Everything, including root cause, **exact fix instructions**, code, re-check history |
| Fix instructions | **Never included**. Each issue says "We can resolve this for you" with an effort estimate, and the report ends with your call to action | Included |

The health score is transparent: 100 − 18 per High, 8 per Medium and 3 per Low **verified** finding. Unverified (low-confidence) signals are left out of the client report and never lower the score.

**Branding** (Dashboard → Branding & settings, stored in `data/branding.json`): agency name, your name, logo (PNG/JPEG/WebP under 400 KB), tagline, email, phone, website, booking link, CTA headline and message, offer text, accent colour, and whether to show the score. All input is validated server-side, and every value is escaped in reports.

## Dashboard

- **Dashboard**: KPIs (reports, sites, verified issues, average score, WordPress sites), 14-day activity, issues by severity, **hottest leads** (lowest-scoring sites, one per site), and the most common issues across your audits.
- **New audit**: URL plus an optional client name ("Prepared for" on the cover), with a live progress bar.
- **Reports**: search (URL or client), Active / Archived / All, status filter, pagination (10/20/50 rows), per-row Open / PDF / Archive / Delete, and bulk Archive / Restore / Delete (with confirmation). Running audits cannot be deleted.
- **Report**: score ring, editable client name, client PDF/HTML download, live client preview, the analyst report, and the private Fix Assistant and re-check tools.

API: `GET /api/investigations?page&pageSize&q&view=active|archived|all&status&lead`, `GET /api/stats`, `GET|PUT /api/settings`, `POST /api/investigations/:id/meta` (`{clientName?, archived?, leadStatus?, notes?}`), `DELETE /api/investigations/:id`, `POST /api/investigations/bulk` (`{ids, action: archive|unarchive|delete}`), `GET …/report.html?inline=1` (preview).

## Security & malware scan

Every audit includes the scan. **New audit → "Security & malware scan"** runs it on its own; that mode is faster because it skips the browser and performance phase. All checks are passive and read-only. Nothing is executed, logged into or changed.

| Check | How |
|---|---|
| Malware & hack signatures | Served HTML of every crawled page is scanned for crypto-miners, known malware-campaign domains, decode-and-execute / char-code obfuscation, foreign or obfuscated code appended after `</html>`, card-skimmer patterns (card fields + encoded beacon to another domain), defacement, conditional redirects (referrer/device/cookie), meta-refresh hijacks, invisible third-party iframes, hidden spam links, spam keywords in titles, and the Japanese keyword hack |
| Cloaking | The homepage is fetched as a normal browser and as Googlebot, and the responses are compared for spam terms or a redirect to another domain |
| Blacklist | Google Safe Browsing v4 lookup of the site and its external script hosts (**optional key**: Settings → Integrations, or `GOOGLE_SAFE_BROWSING_KEY`). The key is stored server-side only |
| SSL / TLS | Certificate trust, expiry (days left), and whether TLS 1.0/1.1 are still accepted. It connects only to the validated public IP |
| Email spoofing | MX, SPF and DMARC DNS records (missing, too permissive, or `p=none`). DNS errors are reported as "not checked", never as "missing" |
| Outdated software | WordPress core, theme and plugin versions from public signals, compared with the latest releases from **api.wordpress.org** (cached for 12 h). Versions are reported, and vulnerabilities are never claimed |
| Cookies, headers, exposed files | Secure/HttpOnly/SameSite flags; security headers; `.env`, `.git`, config source, `debug.log`, directory listing |

False-positive guards (each covered by a regression test from a real site):
- Hidden `display:none` blocks with outbound links (menus, consent dialogs) are **not** spam unless they contain spam terms. Without spam terms, only off-screen positioning counts.
- The site's own scripts after `</html>` are ignored.
- Tag-manager, analytics and payment iframes and scripts are allow-listed.

The client report shows a **"Is the website safe?"** section with a verdict and one status line per check. The dashboard shows the same scan per report, and security threats are counted on the home page.

## E-commerce growth audit

**New audit → "E-commerce growth audit"** (CLI: `--ecommerce`). It finds the store platform (Shopify, WooCommerce, Magento, BigCommerce, Wix, Squarespace, PrestaShop, OpenCart, Ecwid, Shopware) and up to 3 product pages. It then checks what drives sales. Everything is read-only: nothing is clicked or added to a cart.

- **24 best-practice checks** in 6 areas:
  - Product page: Add-to-Cart and price visible without scrolling on mobile, sticky Add-to-Cart, reviews, images, cross-sells, description.
  - Search visibility: Product schema with price, star ratings in Google.
  - Trust & checkout: delivery info, returns, free shipping, express pay, payment icons, contact options, policies.
  - Navigation: search, cart, email capture.
  - Mobile & responsive: overflow, text size, 24×24 px tap targets (WCAG 2.2), intrusive popups.
  - Speed.
- **Conversion readiness score**: the weighted share of passed checks. It is kept separate from the technical health score.
- **Responsive check** at 5 screen sizes (360 / 390 / 768 / 1366 / 1920) for the homepage and a product page, with screenshots.
- **Visual recommendations**: an annotated mobile product screenshot (fold line, buy button and price outlined). Next to it is an **example design concept** built from the store's own product name, price, rating and image. Each revenue opportunity also has a mini concept (sticky bar, reviews block, trust bar, announcement bar, cross-sell, search header, email capture, gallery).
- The client report says **what** to improve and why it affects sales. The platform-specific **how** (Shopify / WooCommerce steps) stays in the analyst report.

Accuracy guards (all from real-store testing):
- The buy button is taken from the product form and must be in the page flow, not a hidden drawer. Size-gated labels such as "Select a size" are recognised.
- Popups are detected by hit-testing what is actually on screen. Country/language selectors are not blamed on the store, because the test browser is abroad.
- Signals are re-read from the JavaScript-rendered page (client-rendered footers and review widgets). Links without an `href` count.
- Screen-reader-only elements are excluded from tap targets.

## Sales tools

- **Lead pipeline**: each report has a stage (New → Contacted → Proposal sent → Won / Lost) and private notes. The dashboard shows the pipeline, and Reports can be filtered by stage.
- **Share link**: a revocable, unguessable `/r/<token>` link to the client report, marked `noindex` and needing no login. The dashboard shows **how many times the prospect opened it**. The link only works where the server is reachable by the client, so deploy it (behind HTTPS) before sending links.
- **Outreach email**: a cold email plus a follow-up, generated from the verified findings (no fix instructions). You can copy them or open them in your email app. Nothing is sent by the tool.
- **Bulk prospecting**: paste up to 20 URLs to queue audits for a whole list of prospects.
- **CSV export** of the current list (stage, score, issues, top issue, link views), with spreadsheet formula injection neutralised.
- **Audit history** per website (score over time), which shows improvement after your work.

```bash
npm run investigate -- --recheck data/cli/<report>.json      # CLI re-check of a saved investigation
```

API: `GET /api/investigations/:id/fix`, `POST …/fix-log`, `GET …/tracking`, `POST …/status` (`{"status":"In Progress"|"Open"}` only), `POST …/rechecks`, `GET …/rechecks/:rid`. Set `WII_API_KEY` to require an `X-WII-Key` header on every `/api` call.

## WordPress plugin

`wordpress-plugin/website-investigator/` is a WordPress admin plugin. It adds an **Investigator** menu (Investigate → Fix Assistant → Re-check → Download Client Report) and **Settings → Website Investigator** (engine URL, API key, Test connection). It is a thin, authenticated front end for this engine. All calls go through `admin-ajax.php` with a nonce and the `manage_options` capability. Only a fixed set of engine endpoints is forwarded, IDs are validated, and engine HTML is filtered through `wp_kses` as a second escaping layer. Screenshots and report downloads are proxied, so the API key never reaches the browser.

```bash
npm run build:wp      # copies report/fix CSS into the plugin and writes wordpress-plugin/website-investigator.zip
```

Run the engine next to WordPress (`WII_API_KEY=… npm start`), then install the zip under Plugins → Add New → Upload.

## Architecture

```
public/            Vanilla UI (CSP: script-src 'self'): form → live step list → report
src/server.ts      Express API, report/screenshot/PDF endpoints, rate limit, security headers
src/queue.ts       In-process background job queue (bounded concurrency, progress persistence)
src/db.ts          node:sqlite store (JSON-file fallback)
src/investigate.ts Orchestrator: the investigation pipeline and request-budget allocation
src/security/ssrf.ts  URL validation, IP classification, connect-time DNS validation
src/net/fetcher.ts    The only HTTP client: manual redirects, per-hop validation, budget, pacing, size caps
src/crawl/         URL normalization, robots.txt (RFC 9309), sitemap parser, priority crawler
src/analyze/       HTML facts (Cheerio), WordPress/theme/plugin fingerprint, security headers & exposed files
src/browser/       Playwright: CWV observers, overflow detection, console/network capture, screenshots, PDF
src/detect/        Detectors → candidates; rank.ts scores internally and applies the false-positive gate
src/report/        Escaped, self-contained report renderer (HTML download, PDF, UI body)
src/phases.ts      Investigation phases shared by the full run and the re-check engine
src/fix/           Fix Assistant: environment detection, per-issue fix knowledge map, panel/report HTML
src/recheck/       Targeted re-check: per-issue probes + measurements, status decision
wordpress-plugin/  WordPress admin plugin (front end for this engine)
```

### Pipeline

1. Validate and normalize the input, resolve DNS, and reject non-public targets.
2. Fetch the homepage (a 5xx or network error is re-checked once), plus the `http://` and www/non-www variants.
3. Fetch and parse robots.txt; the crawler obeys it.
4. Fetch the sitemap: robots `Sitemap:` lines, then `/sitemap.xml`, `/sitemap_index.xml` and `/wp-sitemap.xml`. Indexes are followed for up to 2 children.
5. Crawl the homepage plus up to 19 pages, prioritising navigation, homepage links, sitemap URLs and service/product paths (depth ≤ 3).
6. Probe for soft 404s, run WordPress and security checks, check canonical targets, check uncrawled link targets (navigation first), and sample sitemap URLs (spread across the sitemap).
7. Browser phase: 2 mobile (390px) and 2 desktop (1366px) loads, plus 2 navigation pages for JS/network errors.
8. Run the detectors, rank the candidates, pass them through the false-positive gate, pick the primary issue, and capture evidence screenshots (e.g. the broken link or overflowing elements outlined in red).

### Limits (src/config.ts)

20 pages, 100 crawler requests, depth 3, 15 s timeout, 250 ms minimum spacing per host, 5 MB body cap, 10 redirects. The crawler never visits login, admin, logout, cart, checkout, account, search, feed, date-archive or deep-pagination URLs, or query strings with more than 2 parameters. Tracking parameters (`utm_*`, `fbclid`, `gclid`, …) are stripped.

## Supported checks

| Area | What is detected (only when evidence supports it) |
|---|---|
| HTTP / redirects | Homepage 4xx/5xx/unreachable, HTTP served without HTTPS redirect, chains ≥ 3 hops, HTTPS→HTTP downgrade hops, loops, www + non-www both serving, TLS errors on the alternate host |
| Indexing | noindex (meta + X-Robots-Tag, googlebot-scoped) on homepage/navigation pages, soft 404s, blanket redirects to the homepage |
| robots.txt | 5xx (Google pauses crawling), rules blocking the homepage/navigation pages for Googlebot, rules blocking CSS/JS used by the homepage |
| Sitemap | Declared but broken or invalid, sampled URLs returning 4xx/5xx, redirects, noindex URLs listed, http:// URLs on an HTTPS site, missing |
| Canonical | Cross-domain, pointing to 4xx/5xx, inner pages canonicalized to the homepage, HTTP canonical on HTTPS, multiple tags |
| Internal links | Broken targets (404/410/5xx) with source page and anchor text, redirecting internal links |
| JS / CSS | Script/stylesheet 4xx/5xx seen by the browser (HTTP fallback without a browser), uncaught exceptions, mixed content (active vs passive) |
| Mobile | Missing or fixed-width viewport, measured horizontal overflow with the culprit elements |
| Performance / CWV | Measured LCP, CLS, FCP, TTFB (medians); slow server response across pages; missing compression; huge HTML; oversized images; render-blocking resources |
| Security | Exposed `.env`, `.git/HEAD`, `wp-config.php` source, `debug.log` (format confirmed from the first bytes, never stored); directory listing; missing security headers; EOL PHP from `X-Powered-By`; WordPress REST user enumeration (count only) |
| On-page / structured data | Missing homepage title, duplicate titles, invalid JSON-LD, duplicate Organization/WebSite, missing alt, missing `lang`, missing og:image, missing H1 (verified in the rendered DOM) |
| WordPress | Detection from wp-content/wp-includes assets, generator tag, REST API link and `/wp-json/`; version; theme (from `style.css` headers, child/parent); plugins from asset paths and HTML signatures |

### False-positive protection

- Every candidate has a severity, a confidence, and 0–1 scores for evidence strength, scope and actionability. The internal score is never shown.
- **Low-confidence findings are never promoted**, even when nothing else was found. The report then says "No significant verified issue found".
- Intent checks: noindex on thank-you/privacy/tag pages is ignored; robots rules on contact/legal/login pages are ignored; a single page blocked by a rule naming it exactly is downgraded; staging hostnames reduce confidence; duplicate titles are only compared across self-canonical pages; missing H1 is re-checked after JavaScript renders; mobile overflow must reproduce in every run and must not be clipped by html/body.
- Transient failures (5xx, timeouts) are re-requested before being reported.
- Vulnerabilities are never claimed from version numbers; no vulnerability database is consulted.

## SSRF protection

- Only `http:`/`https:` URLs on ports 80, 443, 8080 and 8443; no credentials in URLs.
- Rejected host names: `localhost`, `.local`, `.internal`, `.lan`, `.home.arpa`, single-label names and cloud metadata names.
- Blocked IPv4 ranges: 0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.0.0/24, 192.0.2/24, 192.88.99/24, 192.168/16, 198.18/15, 198.51.100/24, 203.0.113/24, 224/4 and 240/4.
- Blocked IPv6 ranges: ::, ::1, fc00::/7, fe80::/10, fec0::/10, ff00::/8, 2001:db8::/32 and Teredo. IPv4-mapped, IPv4-compatible, NAT64 and 6to4 addresses are unwrapped and checked as IPv4. Decimal, hex and octal IP forms are normalized by the WHATWG URL parser.
- **Connect-time DNS validation**: the HTTP agent's `lookup` rejects any hostname with a non-public address, so the address that gets checked is the address that gets connected to (no DNS-rebinding window).
- Redirects are followed manually, and every `Location` is re-validated.
- Browser: every request and WebSocket is intercepted and its host resolved and checked; service workers are blocked. PDF rendering blocks all network access.

## Tests

```bash
npm run typecheck && npm run lint && npm test
```

172 tests cover the following: SSRF (IP classes, URL forms, DNS-level blocking, redirect escapes); URL normalization; robots.txt semantics; the fetcher (chains, loops, max redirects, budget, pacing, truncation); crawl limits (pages, depth, requests, robots and exclusions, dedup); end-to-end detection on fixture sites (broken nav link, sitewide noindex, robots `Disallow: /`, deliberate robots rules, soft 404, homepage 500); ranking and the false-positive gate; XSS escaping in reports; and Playwright (overflow, vitals, failed assets, JS errors, SSRF inside the browser, highlighted screenshots, PDF).

## Known limitations

- Core Web Vitals are **lab** values from one location without throttling; field (CrUX) data is not used. INP needs real interaction and is reported as "not measured".
- The browser request guard resolves DNS separately from Chromium, so a DNS-rebinding window remains for browser sub-resources. The server-side fetcher does not have this gap. For hostile-input deployments, run the browser in a network namespace or egress proxy that only allows public IPs.
- Only ~20 pages are sampled, so site-wide issues on deep pages can be missed. Sitemap checks are sample-based.
- Sites behind bot protection (403/429) produce a low-confidence finding and a limited investigation.
- The queue is in-process: jobs running during a restart are marked failed.
- No vulnerability database: plugin, theme and core versions are reported, but never judged.
