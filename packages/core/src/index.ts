import type { ContextCheckpointValidation, ContextPackItem } from '../../contracts/src/index.js';

export interface RankedContextCandidate extends ContextPackItem {
  createdAt: string;
}

export interface CheckpointCandidate {
  memoryId: string;
  category: string;
  text: string;
  createdAt: string;
}

export interface CheckpointBuildResult {
  status: 'validated' | 'rejected';
  summary: string;
  sourceMemoryIds: string[];
  usedTokens: number;
  validation: ContextCheckpointValidation;
}

const MUST_PRESERVE_CATEGORIES = new Set(['decision', 'requirement', 'unresolved-question']);

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function toContextPackItem(candidate: RankedContextCandidate): ContextPackItem {
  return {
    memoryId: candidate.memoryId,
    category: candidate.category,
    text: candidate.text,
    score: candidate.score,
    estimatedTokens: candidate.estimatedTokens,
    selectedBecause: candidate.selectedBecause,
    provenance: candidate.provenance,
  };
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
    selected.push(toContextPackItem(candidate));
  }

  return { selected, usedTokens, omittedItems };
}

function uniqueCheckpointCandidates(
  candidates: readonly CheckpointCandidate[],
): CheckpointCandidate[] {
  const seen = new Set<string>();
  const unique: CheckpointCandidate[] = [];
  for (const candidate of candidates) {
    const normalized = candidate.text.trim().replaceAll(/\s+/g, ' ').toLowerCase();
    if (normalized === '' || seen.has(normalized)) continue;
    seen.add(normalized);
    unique.push(candidate);
  }
  return unique;
}

function checkpointLine(candidate: CheckpointCandidate): string {
  return `- [${candidate.category}] ${candidate.text.trim()}`;
}

export function buildValidatedCheckpoint(
  candidates: readonly CheckpointCandidate[],
  budgetTokens: number,
): CheckpointBuildResult {
  const unique = uniqueCheckpointCandidates(candidates);
  const byRecency = (left: CheckpointCandidate, right: CheckpointCandidate): number =>
    right.createdAt.localeCompare(left.createdAt);
  const mustPreserve = unique
    .filter((candidate) => MUST_PRESERVE_CATEGORIES.has(candidate.category))
    .sort(byRecency);
  const optional = unique
    .filter((candidate) => !MUST_PRESERVE_CATEGORIES.has(candidate.category))
    .sort(byRecency);

  const selected: CheckpointCandidate[] = [];
  let usedTokens = 0;
  for (const candidate of [...mustPreserve, ...optional]) {
    const lineTokens = estimateTokens(checkpointLine(candidate));
    if (usedTokens + lineTokens > budgetTokens) continue;
    selected.push(candidate);
    usedTokens += lineTokens;
  }

  const selectedIds = new Set(selected.map((candidate) => candidate.memoryId));
  const preservedCount = mustPreserve.filter((candidate) => selectedIds.has(candidate.memoryId)).length;
  const validation: ContextCheckpointValidation = {
    mustPreserveCount: mustPreserve.length,
    preservedCount,
    coverage: mustPreserve.length === 0 ? 1 : preservedCount / mustPreserve.length,
  };

  return {
    status: preservedCount === mustPreserve.length ? 'validated' : 'rejected',
    summary: selected.map(checkpointLine).join('\n'),
    sourceMemoryIds: selected.map((candidate) => candidate.memoryId),
    usedTokens,
    validation,
  };
}
