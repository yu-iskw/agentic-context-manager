const DIMENSION = 8;

export const EMBEDDING_DIMENSION = DIMENSION;

function hashToken(token: string): number {
  let hash = 2166136261;
  for (const char of token) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function deterministicEmbedding(input: string): number[] {
  const vector = Array.from<number>({ length: DIMENSION }).fill(0);
  const tokens = input.toLocaleLowerCase().match(/[\p{L}\p{N}_./:-]+/gu) ?? [];

  for (const token of tokens) {
    const hash = hashToken(token);
    const bucket = hash % DIMENSION;
    const sign = (hash & 0x100) === 0 ? 1 : -1;
    vector[bucket] = (vector[bucket] ?? 0) + sign * (1 + (hash % 13) / 13);
  }

  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (norm === 0) {
    return vector;
  }
  return vector.map((value) => Number((value / norm).toFixed(8)));
}

export function toPgVector(vector: readonly number[]): string {
  if (vector.length !== DIMENSION || vector.some((value) => !Number.isFinite(value))) {
    throw new Error(`Expected a finite ${DIMENSION}-dimensional embedding`);
  }
  return `[${vector.join(',')}]`;
}
