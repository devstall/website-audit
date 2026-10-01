/** Minimal RFC 9309 robots.txt parser: groups, Allow/Disallow, `*` and `$` patterns, longest-match wins. */

export interface RobotsRule {
  type: 'allow' | 'disallow';
  path: string;
  line: number;
}

interface Group {
  agents: string[];
  rules: RobotsRule[];
}

export interface ParsedRobots {
  groups: Group[];
  sitemaps: string[];
  warnings: string[];
}

const KNOWN_DIRECTIVES = new Set(['user-agent', 'allow', 'disallow', 'sitemap', 'crawl-delay', 'host', 'clean-param', 'noindex', 'request-rate', 'visit-time']);

export function parseRobots(body: string): ParsedRobots {
  const groups: Group[] = [];
  const sitemaps: string[] = [];
  const warnings: string[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;

  body.split(/\r\n|\r|\n/).forEach((rawLine, i) => {
    const lineNo = i + 1;
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) return;
    const colon = line.indexOf(':');
    if (colon === -1) {
      warnings.push(`Line ${lineNo}: missing ":" separator → "${rawLine.trim().slice(0, 80)}"`);
      return;
    }
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (!KNOWN_DIRECTIVES.has(key)) {
      warnings.push(`Line ${lineNo}: unknown directive "${key}"`);
      return;
    }
    if (key === 'sitemap') {
      if (value) sitemaps.push(value);
      return;
    }
    if (key === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      return;
    }
    lastWasAgent = false;
    if (key === 'allow' || key === 'disallow') {
      if (!current) {
        warnings.push(`Line ${lineNo}: "${key}" appears before any User-agent line and is ignored`);
        return;
      }
      // An empty Disallow means "allow everything" — it is not a rule.
      if (value === '') return;
      current.rules.push({ type: key, path: value, line: lineNo });
    }
  });
  return { groups, sitemaps, warnings };
}

/** Rules for a user agent: the most specific matching group(s), or the `*` group(s). */
export function rulesFor(robots: ParsedRobots, agent: string): RobotsRule[] {
  const a = agent.toLowerCase();
  const specific = robots.groups.filter((g) => g.agents.some((x) => x !== '*' && a.includes(x)));
  const chosen = specific.length ? specific : robots.groups.filter((g) => g.agents.includes('*'));
  return chosen.flatMap((g) => g.rules);
}

function patternToRegex(pattern: string): RegExp {
  const anchored = pattern.endsWith('$');
  const p = anchored ? pattern.slice(0, -1) : pattern;
  const escaped = p.replace(/[.+?^{}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}${anchored ? '$' : ''}`);
}

/** Returns the rule that decides `pathWithQuery`, or null when nothing matches (allowed). */
export function matchingRule(rules: RobotsRule[], pathWithQuery: string): RobotsRule | null {
  let best: RobotsRule | null = null;
  for (const r of rules) {
    let decoded = pathWithQuery;
    try {
      decoded = decodeURI(pathWithQuery);
    } catch {
      /* keep raw */
    }
    if (!patternToRegex(r.path).test(pathWithQuery) && !patternToRegex(r.path).test(decoded)) continue;
    if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.type === 'allow')) best = r;
  }
  return best;
}

export function isAllowed(robots: ParsedRobots, agent: string, url: string): boolean {
  if (/^\/robots\.txt$/i.test(new URL(url).pathname)) return true;
  const u = new URL(url);
  const rule = matchingRule(rulesFor(robots, agent), u.pathname + u.search);
  return !rule || rule.type === 'allow';
}
