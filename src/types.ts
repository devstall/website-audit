export type Level = 'High' | 'Medium' | 'Low';

export interface RedirectHop {
  url: string;
  status: number;
  location?: string;
}

/** Result of one SSRF-safe HTTP request (after following redirects). */
export interface FetchResult {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  ok: boolean;
  /** Every hop, including the final response. */
  chain: RedirectHop[];
  headers: Record<string, string>;
  /** Body as text (truncated to maxBodyBytes). Empty for HEAD or binary. */
  body: string;
  bodyBytes: number;
  /** Base64 body (only when requested with `binary`). */
  bodyBase64?: string;
  /** Bytes on the wire (compressed). */
  transferBytes: number;
  /** Raw Set-Cookie headers of the final response (kept separate: cookies cannot be comma-joined safely). */
  setCookies?: string[];
  truncated: boolean;
  /** Time to response headers of the final hop (ms). */
  ttfbMs: number;
  totalMs: number;
  error?: string;
  /** Redirect loop detected. */
  loop?: boolean;
}

export interface LinkRef {
  url: string;
  text: string;
  rel?: string;
  /** Link sits in nav/header navigation. */
  inNav?: boolean;
}

export interface ImageRef {
  src: string;
  alt: string | null;
  width?: string;
  height?: string;
  loading?: string;
  srcset?: boolean;
}

export interface PageFacts {
  url: string;
  finalUrl: string;
  depth: number;
  status: number;
  contentType: string;
  ttfbMs: number;
  totalMs: number;
  htmlBytes: number;
  chain: RedirectHop[];
  headers: Record<string, string>;
  title: string | null;
  titleCount: number;
  metaDescription: string | null;
  canonical: string | null;
  canonicalCount: number;
  metaRobots: string | null;
  xRobotsTag: string | null;
  viewport: string | null;
  h1: string[];
  headingOutline: string[];
  lang: string | null;
  internalLinks: LinkRef[];
  externalLinkCount: number;
  images: ImageRef[];
  scripts: { src: string; async: boolean; defer: boolean; module: boolean; inHead: boolean }[];
  inlineScriptCount: number;
  stylesheets: { href: string; media: string | null }[];
  iframes: string[];
  mixedContent: { tag: string; url: string }[];
  jsonLd: { raw: string; valid: boolean; error?: string; types: string[] }[];
  microdata: boolean;
  rdfa: boolean;
  og: Record<string, string>;
  twitter: Record<string, string>;
  generator: string | null;
  /** Malware / hack signatures found in this page's served HTML. */
  malware?: MalwareSignal[];
  /** Online-store signals (product data, add-to-cart, trust, navigation). */
  commerce?: CommerceFacts;
  /** A lightweight fingerprint of visible text, for soft-404 comparisons. */
  textSample: string;
  wordCount: number;
}

export interface BrowserMetrics {
  label: 'mobile' | 'desktop';
  viewport: { width: number; height: number };
  runs: number;
  lcpMs: number | null;
  cls: number | null;
  fcpMs: number | null;
  ttfbMs: number | null;
  inpMs: number | null;
  /** document.documentElement.scrollWidth */
  contentWidth: number;
  horizontalOverflow: boolean;
  /** <h1> / role=heading level 1 elements in the rendered DOM (after JavaScript). */
  renderedH1Count: number;
  /** Elements that stick out beyond the viewport (selector + width). */
  overflowingElements: { selector: string; right: number; width: number }[];
  requestCount: number;
  transferBytes: number;
  screenshotFile?: string;
  highlightScreenshotFile?: string;
}

export interface BrowserNetworkEntry {
  url: string;
  status: number | null;
  resourceType: string;
  failure?: string;
  bytes?: number;
  fromPage: string;
}

export interface BrowserReport {
  available: boolean;
  reason?: string;
  engine?: string;
  version?: string;
  mobile?: BrowserMetrics;
  desktop?: BrowserMetrics;
  consoleErrors: { text: string; location?: string; page: string }[];
  pageErrors: { message: string; page: string }[];
  failedRequests: BrowserNetworkEntry[];
  /** Largest image responses observed. */
  largeImages: { url: string; bytes: number; naturalWidth?: number; renderedWidth?: number; page: string }[];
  mixedContent: string[];
  thirdPartyDomains: string[];
  blockedBySsrf: string[];
}

export interface RobotsInfo {
  url: string;
  status: number | null;
  fetched: boolean;
  body: string;
  sitemaps: string[];
  /** Raw rule lines applying to `*` for reporting. */
  starRules: { type: 'allow' | 'disallow'; path: string; line: number }[];
  syntaxWarnings: string[];
}

export interface SitemapInfo {
  discoveredFrom: string[];
  fetched: { url: string; status: number; kind: 'urlset' | 'index' | 'invalid' | 'error'; urlCount: number; error?: string }[];
  urls: string[];
  duplicates: string[];
  httpUrlsOnHttpsSite: string[];
  sampleChecks: { url: string; status: number; finalUrl: string; noindex: boolean; canonical: string | null }[];
}

export interface WordPressInfo {
  detected: boolean;
  signals: string[];
  version: string | null;
  versionSource: string | null;
  theme: { slug: string; version: string | null; name: string | null; isChild: boolean; parent: string | null } | null;
  plugins: { slug: string; versions: string[]; evidence: string }[];
  restApi: { available: boolean; status: number | null; userEnumeration: { exposed: boolean; count: number } };
  xmlrpc: { status: number | null; enabled: boolean };
}

export interface SecurityInfo {
  headers: Record<string, string | null>;
  serverHeaders: Record<string, string>;
  sensitiveFiles: { path: string; status: number; exposed: boolean; note: string }[];
  directoryListing: { url: string; listed: boolean }[];
}

export interface EvidenceItem {
  label: string;
  /** Plain-text value (URL, status, header dump, snippet). Rendered monospace when `code` is true. */
  value: string;
  code?: boolean;
}

export interface Candidate {
  id: string;
  title: string;
  category:
    | 'Indexing'
    | 'Crawlability'
    | 'Redirects'
    | 'HTTPS'
    | 'Canonicalization'
    | 'Internal links'
    | 'Sitemap'
    | 'On-page SEO'
    | 'Performance'
    | 'Core Web Vitals'
    | 'Mobile usability'
    | 'Broken functionality'
    | 'Security'
    | 'Structured data'
    | 'Images'
    | 'Accessibility'
    | 'WordPress'
    | 'Server configuration'
    | 'Malware'
    | 'Conversion'
    | 'Responsive design';
  severity: Level;
  confidence: Level;
  /** 0–1: how direct the evidence is (1 = observed HTTP status, 0.3 = heuristic). */
  evidenceStrength: number;
  /** 0–1: share of the site affected (1 = sitewide). */
  scope: number;
  /** 0–1: how clearly a developer can act on it. */
  actionability: number;
  summary: string;
  howIdentified: string;
  evidence: EvidenceItem[];
  affectedUrls: string[];
  whyItMatters: string;
  solution: string[];
  effort: { investigation: string; implementation: string; testing: string; total: string };
  /** False-positive review: why this is not intentional / what alternative explanations were ruled out. */
  verification: string[];
  screenshots?: { caption: string; file: string }[];
  /**
   * Machine-readable items behind the finding (broken URLs, asset URLs, file paths, missing headers…).
   * The re-check engine tests exactly these items again.
   */
  targets?: string[];
  /** Customer-facing recommendation: WHAT to improve (never HOW). Shown on client reports. */
  recommendation?: string;
  /** Key of an example design concept rendered on client reports. */
  concept?: string;
}

/**
 * One comparable measurement of an issue, taken at investigation time (baseline) and again on every re-check.
 * `bad` = this item still shows the problem, `ok` = it does not, `info` = context only, `unknown` = could not be measured.
 */
export interface Measurement {
  key: string;
  label: string;
  value: string;
  state: 'bad' | 'ok' | 'info' | 'unknown';
}

export type RecheckStatus = 'resolved' | 'still-detected' | 'unable-to-verify';
export type ReportStatus = 'Open' | 'In Progress' | 'Resolved' | 'Unable to Verify';

export interface RecheckResult {
  issueId: string;
  status: RecheckStatus;
  /** What was re-tested (e.g. "Homepage", "Canonical", "Final URL", "Redirect chain"). */
  checks: string[];
  measurements: Measurement[];
  /** Evidence produced by the same detector on fresh data (only when the issue is still detected). */
  currentEvidence: EvidenceItem[];
  /** Why the site could not be reliably checked (for unable-to-verify), or coverage caveats. */
  reasons: string[];
  requestsMade: number;
  browserUsed: boolean;
  durationMs: number;
}

export interface RecheckRecord {
  id: string;
  investigationId: string;
  /** 1-based sequence per investigation. */
  seq: number;
  issueId: string;
  state: 'running' | 'complete' | 'failed';
  createdAt: string;
  completedAt: string | null;
  result: RecheckResult | null;
  error: string | null;
  /** The fix instructions that had been shown before this re-check (fix method + title), for the history log. */
  fixShown: string | null;
}

export type StepKey =
  | 'discover'
  | 'homepage'
  | 'robots'
  | 'sitemap'
  | 'links'
  | 'seo'
  | 'performance'
  | 'mobile'
  | 'javascript'
  | 'security'
  | 'wordpress'
  | 'analysis';

export type StepState = 'pending' | 'running' | 'done' | 'skipped' | 'failed';

export interface InvestigationStats {
  pagesAnalyzed: number;
  requestsMade: number;
  browserRequests: number;
  desktopTested: boolean;
  mobileTested: boolean;
  robotsTested: boolean;
  sitemapTested: boolean;
  browserTest: boolean;
  durationMs: number;
}

export interface InvestigationResult {
  inputUrl: string;
  siteUrl: string;
  date: string;
  stats: InvestigationStats;
  wordpress: WordPressInfo;
  primary: Candidate | null;
  /** Measurements of the primary issue at investigation time — the BEFORE side of every re-check. */
  baseline?: Measurement[];
  /** Internal only (API/debug); the UI and report show the primary issue. */
  candidates: Candidate[];
  pages: Pick<PageFacts, 'url' | 'finalUrl' | 'status' | 'title' | 'ttfbMs' | 'htmlBytes'>[];
  browser: BrowserReport;
  homepageHeaders: Record<string, string>;
  homepageChain: { url: string; status: number }[];
  notes: string[];
  /** Security & malware scan (absent on results saved before the scan existed). */
  securityScan?: SecurityScan;
  /** 'security' = security & malware scan only (no performance/browser phase). */
  focus?: ScanFocus;
  /** E-commerce conversion audit (focus "ecommerce"). */
  commerce?: CommerceReport;
}

export type ScanFocus = 'full' | 'security' | 'ecommerce';

export interface CommerceFacts {
  platformHints: string[];
  isProduct: boolean;
  isCategory: boolean;
  product: {
    name: string | null;
    price: string | null;
    currency: string | null;
    availability: string | null;
    image: string | null;
    rating: number | null;
    reviewCount: number | null;
    hasSchema: boolean;
    schemaHasOffer: boolean;
    schemaHasRating: boolean;
  } | null;
  addToCart: { present: boolean; text: string | null };
  productImages: number;
  reviews: boolean;
  trust: { freeShipping: boolean; returns: boolean; guarantee: boolean; secure: boolean };
  paymentIcons: string[];
  expressPay: string[];
  shippingInfo: boolean;
  stock: boolean;
  crossSell: boolean;
  search: boolean;
  cartLink: boolean;
  chat: string[];
  newsletter: boolean;
  policyLinks: { returns: boolean; shipping: boolean; privacy: boolean; terms: boolean; contact: boolean };
  phone: boolean;
  descriptionWords: number;
  breadcrumbs: boolean;
  productLinks: string[];
}

export interface ViewportCheck {
  device: string;
  width: number;
  height: number;
  contentWidth: number;
  overflow: boolean;
  overflowing: string[];
  /** Share of visible text rendered below 12px. */
  smallTextPct: number;
  /** Interactive elements smaller than 24×24 CSS px (WCAG 2.2 target size), excluding inline text links. */
  smallTapTargets: number;
  smallTapExamples: string[];
  screenshot?: string;
}

export interface ResponsiveResult {
  url: string;
  label: string;
  checks: ViewportCheck[];
}

export interface ProductProbe {
  url: string;
  viewportHeight: number;
  atcFound: boolean;
  atcText: string | null;
  atcTop: number | null;
  atcAboveFold: boolean;
  priceTop: number | null;
  priceAboveFold: boolean;
  stickyAtc: boolean;
  /** Largest fixed overlay as a share of the viewport after load (popups). */
  popupCoverage: number;
  popupLabel: string | null;
  /** The overlay is a country / language / currency selector — typically shown only to foreign visitors like this test. */
  geoPrompt?: boolean;
  annotatedScreenshot?: string;
}

export type CommerceArea = 'Product page' | 'Trust & checkout' | 'Navigation & discovery' | 'Mobile & responsive' | 'Search visibility' | 'Speed';

export interface CommerceCheck {
  key: string;
  area: CommerceArea;
  label: string;
  /** null = not applicable / could not be measured. */
  pass: boolean | null;
  detail: string;
  impact: Level;
}

export interface CommerceReport {
  isStore: boolean;
  platform: string | null;
  platformEvidence: string[];
  productPages: string[];
  categoryPages: string[];
  sample: { name: string | null; price: string | null; currency: string | null; rating: number | null; reviewCount: number | null; url: string | null };
  /** Product image embedded as a data URI for the design concept (null when unavailable). */
  conceptImage: string | null;
  responsive: ResponsiveResult[];
  productProbe: ProductProbe | null;
  checks: CommerceCheck[];
  /** Conversion readiness 0–100 (weighted share of passed best practices). */
  score: number;
  notes: string[];
}

export type MalwareType =
  | 'crypto-miner'
  | 'injected-after-html'
  | 'obfuscated-script'
  | 'known-malware-domain'
  | 'hidden-spam-links'
  | 'spam-keywords'
  | 'foreign-keyword-hack'
  | 'malicious-redirect'
  | 'external-redirect'
  | 'card-skimmer'
  | 'defacement'
  | 'hidden-iframe'
  | 'cloaking';

export interface MalwareSignal {
  type: MalwareType;
  confidence: Level;
  page: string;
  /** Human-readable description of what matched. */
  detail: string;
  /** Short, escaped-on-render excerpt of the offending code. */
  snippet?: string;
}

export interface SecurityScan {
  pagesScanned: number;
  malware: MalwareSignal[];
  externalScriptHosts: string[];
  blacklist: { checked: boolean; provider: string | null; matches: { url: string; threat: string }[]; note?: string };
  cloaking: { checked: boolean; different: boolean; googlebotOnlyTerms: string[]; googlebotFinalUrl: string | null; note?: string };
  tls: { checked: boolean; validTo: string | null; daysLeft: number | null; issuer: string | null; protocol: string | null; authorized: boolean | null; authError: string | null; legacyProtocols: string[]; note?: string };
  email: { checked: boolean; domain: string | null; hasMx: boolean; spf: string | null; dmarc: string | null; dmarcPolicy: string | null; note?: string };
  software: {
    checked: boolean;
    core: { installed: string; latest: string; source: string } | null;
    theme: { slug: string; installed: string; latest: string } | null;
    plugins: { slug: string; installed: string; latest: string }[];
    note?: string;
  };
  cookies: { name: string; secure: boolean; httpOnly: boolean; sameSite: string | null }[];
}
