import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Central limits. Every value is deliberately conservative: the tool must never overload a target. */
export interface CrawlLimits {
  /** Pages fully fetched and parsed (homepage included). */
  maxPages: number;
  /** Hard cap on HTTP requests made by the crawler/checkers (browser sub-resources are counted separately). */
  maxRequests: number;
  maxDepth: number;
  /** Per-request timeout. */
  timeoutMs: number;
  /** Minimum delay between two requests to the same host. */
  perHostDelayMs: number;
  /** Body bytes read at most per response (larger bodies are truncated, size is still reported from headers). */
  maxBodyBytes: number;
  maxRedirects: number;
  /** Sitemap URLs sampled for status checks. */
  sitemapSampleSize: number;
  /** Internal link targets (not crawled as pages) that get a status check. */
  linkCheckBudget: number;
}

export const DEFAULT_LIMITS: CrawlLimits = {
  maxPages: 20,
  maxRequests: 100,
  maxDepth: 3,
  timeoutMs: 15_000,
  perHostDelayMs: 250,
  maxBodyBytes: 5 * 1024 * 1024,
  maxRedirects: 10,
  sitemapSampleSize: 15,
  linkCheckBudget: 25,
};

export const USER_AGENT =
  'Mozilla/5.0 (compatible; WebsiteIndependentInvestigator/1.0; +passive-technical-audit)';

/** Robots.txt group name we match against (falls back to `*`). */
export const ROBOTS_AGENT = 'WebsiteIndependentInvestigator';

/** Dashboard login (HTTP Basic auth). When a password is set, every page, report and API call requires it. */
export const AUTH_USER = process.env.WII_USER || 'admin';
export const AUTH_PASSWORD = process.env.WII_PASSWORD ?? '';
/** Shortest password accepted before the server agrees to start with login enabled. */
export const MIN_PASSWORD_LENGTH = 10;

/** A port number, or a socket/pipe path (some hosts, e.g. Passenger or LiteSpeed, pass one in PORT). */
const RAW_PORT = process.env.PORT || '4173';
export const SERVER_PORT: number | string = /^\d+$/.test(RAW_PORT) ? Number(RAW_PORT) : RAW_PORT;
/**
 * Bind address. Without a login it stays on loopback (local use). With a login it defaults to all
 * interfaces, so a hosting proxy (Hostinger, Render, a VPS behind Nginx) can reach it.
 */
export const SERVER_HOST = process.env.HOST || (AUTH_PASSWORD ? '0.0.0.0' : '127.0.0.1');
/** Relative paths resolve against the project root, not the working directory, so hosts that start the app elsewhere keep the same data. */
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.resolve(PROJECT_ROOT, process.env.WII_DATA_DIR || 'data');
/** Concurrent investigations. Each one runs a browser, so keep this small. */
export const QUEUE_CONCURRENCY = Number(process.env.WII_CONCURRENCY ?? 2);
/** Optional shared secret for the API (required when the engine is reachable by a WordPress site over the network). */
export const API_KEY = process.env.WII_API_KEY ?? '';
