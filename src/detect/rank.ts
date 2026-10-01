import type { Candidate, Level } from '../types.js';

const SEVERITY: Record<Level, number> = { High: 3, Medium: 2, Low: 1 };
const CONFIDENCE: Record<Level, number> = { High: 1, Medium: 0.7, Low: 0.35 };

/**
 * Internal priority score (never exposed). Ordered by the brief:
 * evidence strength, confidence, impact (severity), scope, actionability.
 */
export function score(c: Candidate): number {
  return (
    SEVERITY[c.severity] *
    CONFIDENCE[c.confidence] *
    (0.5 + 0.5 * clamp(c.evidenceStrength)) *
    (0.6 + 0.4 * clamp(c.scope)) *
    (0.7 + 0.3 * clamp(c.actionability))
  );
}

function clamp(n: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));
}

/**
 * False-positive gate: a candidate may be the primary issue only if confidence is at least Medium and
 * the evidence is direct enough. Low-confidence findings are never promoted, even when nothing else exists.
 */
export function isEligible(c: Candidate): boolean {
  return c.confidence !== 'Low' && c.evidenceStrength >= 0.5 && c.evidence.length > 0;
}

export function rankCandidates(candidates: Candidate[]): Candidate[] {
  // De-duplicate by id (a detector may emit the same id for several variants).
  const byId = new Map<string, Candidate>();
  for (const c of candidates) {
    const prev = byId.get(c.id);
    if (!prev || score(c) > score(prev)) byId.set(c.id, c);
  }
  return [...byId.values()].sort((a, b) => score(b) - score(a) || b.evidenceStrength - a.evidenceStrength);
}

export function selectPrimary(candidates: Candidate[]): Candidate | null {
  return rankCandidates(candidates).find(isEligible) ?? null;
}
