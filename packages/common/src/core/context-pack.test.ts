import { describe, expect, it } from 'vitest';

import { estimateTokens, packToTokenBudget } from './context-pack';
import { deterministicEmbedding } from './embedding';

describe('context packing', () => {
  it('never exceeds the token budget', () => {
    const result = packToTokenBudget(
      [
        {
          kind: 'memory',
          id: '1',
          text: 'a'.repeat(20),
          category: 'decision',
          score: 1,
          scope: 'session',
          sourceEventIds: ['e1'],
        },
        {
          kind: 'memory',
          id: '2',
          text: 'b'.repeat(20),
          category: 'decision',
          score: 0.9,
          scope: 'task',
          sourceEventIds: ['e2'],
        },
      ],
      6,
    );
    expect(result.tokensUsed).toBeLessThanOrEqual(6);
    expect(result.items).toHaveLength(1);
  });

  it('uses a conservative character-based estimate', () => {
    expect(estimateTokens('12345678')).toBe(2);
  });

  it('produces deterministic normalized embeddings', () => {
    const first = deterministicEmbedding('PaymentService timeout');
    const second = deterministicEmbedding('PaymentService timeout');
    expect(first).toEqual(second);
    const norm = Math.sqrt(first.reduce((sum, value) => sum + value * value, 0));
    expect(norm).toBeCloseTo(1, 6);
  });
});
