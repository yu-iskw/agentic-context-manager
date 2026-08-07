import { describe, expect, it } from 'vitest';

import { buildValidatedCheckpoint, estimateTokens, packWithinBudget } from './index.js';

import type { CheckpointCandidate, RankedContextCandidate } from './index.js';

function candidate(overrides: Partial<RankedContextCandidate> = {}): RankedContextCandidate {
  return {
    memoryId: 'memory-1',
    category: 'decision',
    text: 'PostgreSQL is the source of truth',
    score: 0.9,
    estimatedTokens: 8,
    selectedBecause: [],
    provenance: [],
    createdAt: '2026-08-07T00:00:00Z',
    ...overrides,
  };
}

function checkpointCandidate(
  overrides: Partial<CheckpointCandidate> = {},
): CheckpointCandidate {
  return {
    memoryId: 'memory-1',
    category: 'decision',
    text: 'PostgreSQL is the source of truth',
    createdAt: '2026-08-07T00:00:00Z',
    ...overrides,
  };
}

describe('estimateTokens', () => {
  it('uses a conservative deterministic character approximation', () => {
    expect(estimateTokens('12345678')).toBe(2);
    expect(estimateTokens('')).toBe(1);
  });
});

describe('packWithinBudget', () => {
  it('selects higher-value items without exceeding the hard budget', () => {
    const result = packWithinBudget(
      [
        candidate({ memoryId: 'lower', score: 0.4, estimatedTokens: 8 }),
        candidate({
          memoryId: 'higher',
          text: 'Docker Compose is normative',
          score: 0.9,
          estimatedTokens: 6,
        }),
      ],
      10,
    );

    expect(result.selected.map((item) => item.memoryId)).toEqual(['higher']);
    expect(result.usedTokens).toBe(6);
    expect(result.omittedItems).toBe(1);
  });

  it('deduplicates equivalent normalized text', () => {
    const result = packWithinBudget(
      [
        candidate({ memoryId: 'first', text: 'Use   PostgreSQL' }),
        candidate({ memoryId: 'second', text: 'use postgresql', score: 0.8 }),
      ],
      100,
    );

    expect(result.selected).toHaveLength(1);
    expect(result.omittedItems).toBe(1);
  });
});

describe('buildValidatedCheckpoint', () => {
  it('preserves required lifecycle memories before optional observations', () => {
    const result = buildValidatedCheckpoint(
      [
        checkpointCandidate({
          memoryId: 'observation',
          category: 'observation',
          text: 'An optional observation that can be omitted.',
        }),
        checkpointCandidate({
          memoryId: 'decision',
          category: 'decision',
          text: 'Docker Compose is the normative integration environment.',
        }),
      ],
      32,
    );

    expect(result.status).toBe('validated');
    expect(result.sourceMemoryIds).toContain('decision');
    expect(result.validation).toEqual({ mustPreserveCount: 1, preservedCount: 1, coverage: 1 });
    expect(result.usedTokens).toBeLessThanOrEqual(32);
  });

  it('rejects a checkpoint when the budget would drop a must-preserve memory', () => {
    const result = buildValidatedCheckpoint(
      [
        checkpointCandidate({
          category: 'requirement',
          text: 'This required fact is intentionally too long for the tiny checkpoint budget.',
        }),
      ],
      1,
    );

    expect(result.status).toBe('rejected');
    expect(result.validation.coverage).toBe(0);
  });
});
