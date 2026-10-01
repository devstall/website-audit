import type { CrawlOutput, UrlStatus } from '../crawl/crawler.js';
import type { ParsedRobots } from '../crawl/robots.js';
import type { BrowserReport, CommerceReport, FetchResult, PageFacts, RobotsInfo, SecurityInfo, SecurityScan, SitemapInfo, WordPressInfo } from '../types.js';

export interface HostVariant {
  label: string;
  url: string;
  result: FetchResult | null;
  canonical?: string | null;
}

/** Everything the detectors may look at. Built by the orchestrator; detectors never make requests. */
export interface InvestigationContext {
  inputUrl: string;
  siteUrl: string;
  origin: string;
  homepage: FetchResult;
  home: PageFacts | null;
  /** The input URL, http:// root, alternate www/non-www root. */
  variants: HostVariant[];
  robots: RobotsInfo;
  robotsParsed: ParsedRobots | null;
  sitemap: SitemapInfo;
  crawl: CrawlOutput;
  /** Status for internal link targets (crawled pages + extra link checks + re-checks), keyed by normalized URL. */
  statuses: Map<string, UrlStatus>;
  canonicalTargets: Map<string, UrlStatus>;
  soft404: { url: string; status: number; finalUrl: string; redirectedToHome: boolean; wordCount?: number } | null;
  assetChecks: { url: string; status: number; type: 'script' | 'stylesheet' | 'image'; cacheControl: string | null; contentType: string | null; page: string }[];
  wordpress: WordPressInfo;
  security: SecurityInfo;
  /** Security & malware scan (not collected by targeted re-checks). */
  securityScan?: SecurityScan;
  /** E-commerce conversion audit data (focus "ecommerce" only). */
  commerce?: CommerceReport;
  browser: BrowserReport;
  /** Median server response time across crawled pages. */
  medianTtfbMs: number | null;
}
