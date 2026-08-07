import type { ContextPackItem } from '../../contracts/src/index.js';

export interface RankedContextCandidate extends ContextPackItem {
  createdAt: string;
}

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function packWithinBudget(
  candidates: readonly RankedContextCandidate[],
  budgetTokens: number,
): { selected: ContextPackItem[]; usedTokens: number; omittedItems: number } {
  const sorted = [...candidates].sort((left, right) => {
    const scoreDifference = right.score - left.score;
    if (scoreDifference !== 0) return scoreDifference;
    return right.createdAt.localeCompare(left.createdAt);
  });

  const selected: ContextPackItem[] = [];
  let usedTokens = 0;
  let omittedItems = 0;
  const seen = new Set<string>();

  for (const candidate of sorted) {
    const normalized = candidate.text.trim().replaceAll(/\s+/g, ' ').toLowerCase();
    if (seen.has(normalized)) {
      omittedItems += 1;
      continue;
    }
    if (usedTokens + candidate.estimatedTokens > budgetTokens) {
      omittedItems += 1;
      continue;
    }
    seen.add(normalized);
    usedTokens += candidate.estimatedTokens;
    const { createdAt: _createdAt, ...item } = candidate;
    selected.push(item);
  }

  return { selected, usedTokens, omittedItems };
}
