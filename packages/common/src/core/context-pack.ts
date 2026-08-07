import type { ContextPackItem } from '../contracts';

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export interface CandidateContextItem extends Omit<ContextPackItem, 'tokenEstimate'> {
  tokenEstimate?: number;
}

export function packToTokenBudget(
  candidates: readonly CandidateContextItem[],
  tokenBudget: number,
): { items: ContextPackItem[]; tokensUsed: number } {
  if (!Number.isInteger(tokenBudget) || tokenBudget < 1) {
    throw new Error('tokenBudget must be a positive integer');
  }

  const items: ContextPackItem[] = [];
  let tokensUsed = 0;

  for (const candidate of candidates) {
    const tokenEstimate = candidate.tokenEstimate ?? estimateTokens(candidate.text);
    if (tokensUsed + tokenEstimate > tokenBudget) {
      continue;
    }
    items.push({ ...candidate, tokenEstimate });
    tokensUsed += tokenEstimate;
  }

  return { items, tokensUsed };
}
