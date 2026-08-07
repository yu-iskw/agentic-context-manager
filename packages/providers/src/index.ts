import { createHash } from 'node:crypto';

import type { JsonValue } from '../../contracts/src/index.js';

export interface ExtractedMemory {
  category: string;
  retrievalText: string;
  structuredValue: JsonValue;
  confidence: number;
  extractorId: string;
}

export interface ContextProvider {
  extract(content: JsonValue): Promise<readonly ExtractedMemory[]>;
  embed(input: readonly string[]): Promise<readonly number[][]>;
}

function eventText(content: JsonValue): string {
  if (typeof content === 'string') return content;
  if (typeof content === 'object' && content !== null && !Array.isArray(content)) {
    const candidate = content.text;
    if (typeof candidate === 'string') return candidate;
  }
  return JSON.stringify(content);
}

function deterministicEmbedding(text: string): number[] {
  const digest = createHash('sha256').update(text.trim().toLowerCase()).digest();
  const values = Array.from({ length: 8 }, (_unused, index) => (digest.at(index) ?? 0) / 127.5 - 1);
  const norm = Math.sqrt(values.reduce((total, value) => total + value * value, 0)) || 1;
  return values.map((value) => value / norm);
}

class DeterministicProvider implements ContextProvider {
  extract(content: JsonValue): Promise<readonly ExtractedMemory[]> {
    const text = eventText(content).trim();
    if (text === '') return Promise.resolve([]);
    return Promise.resolve([
      {
        category: 'observation',
        retrievalText: text,
        structuredValue: { text },
        confidence: 1,
        extractorId: 'deterministic-v1',
      },
    ]);
  }

  embed(input: readonly string[]): Promise<readonly number[][]> {
    return Promise.resolve(input.map(deterministicEmbedding));
  }
}

class HttpTestProvider implements ContextProvider {
  readonly #baseUrl: string;

  constructor(baseUrl: string) {
    this.#baseUrl = baseUrl.replace(/\/$/, '');
  }

  async extract(content: JsonValue): Promise<readonly ExtractedMemory[]> {
    const response = await fetch(`${this.#baseUrl}/extract`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    if (!response.ok) throw new Error(`provider extract failed: ${response.status}`);
    const body = (await response.json()) as { memories: ExtractedMemory[] };
    return body.memories;
  }

  async embed(input: readonly string[]): Promise<readonly number[][]> {
    const response = await fetch(`${this.#baseUrl}/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input }),
    });
    if (!response.ok) throw new Error(`provider embed failed: ${response.status}`);
    const body = (await response.json()) as { vectors: number[][] };
    return body.vectors;
  }
}

export function createProviderFromEnvironment(): ContextProvider {
  if (process.env.ACM_PROVIDER_MODE === 'http') {
    const baseUrl = process.env.ACM_PROVIDER_BASE_URL;
    if (baseUrl === undefined) {
      throw new Error('ACM_PROVIDER_BASE_URL is required in http provider mode');
    }
    return new HttpTestProvider(baseUrl);
  }
  return new DeterministicProvider();
}
