import type {
  AcceptedEvent,
  ContextPack,
  ContextRecallInput,
  CreateSessionInput,
  IngestionStatus,
  RecordEventInput,
  SessionRecord,
} from './contracts';

export interface AcmClientOptions {
  baseUrl: string;
  tenantId: string;
  principalId: string;
  fetch?: typeof fetch;
}

export class AcmClient {
  readonly #baseUrl: string;
  readonly #tenantId: string;
  readonly #principalId: string;
  readonly #fetch: typeof fetch;

  constructor(options: AcmClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/$/u, '');
    this.#tenantId = options.tenantId;
    this.#principalId = options.principalId;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  createSession(input: CreateSessionInput): Promise<SessionRecord> {
    return this.#request('/v1/sessions', { method: 'POST', body: input });
  }

  recordEvent(input: RecordEventInput, idempotencyKey?: string): Promise<AcceptedEvent> {
    return this.#request('/v1/events', {
      method: 'POST',
      body: input,
      headers: idempotencyKey === undefined ? {} : { 'idempotency-key': idempotencyKey },
    });
  }

  recall(input: ContextRecallInput): Promise<ContextPack> {
    return this.#request('/v1/context:retrieve', { method: 'POST', body: input });
  }

  ingestionStatus(ingestionId: string): Promise<IngestionStatus> {
    return this.#request(`/v1/ingestions/${encodeURIComponent(ingestionId)}`, { method: 'GET' });
  }

  async #request<T>(
    path: string,
    options: { method: 'GET' | 'POST'; body?: unknown; headers?: Record<string, string> },
  ): Promise<T> {
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      method: options.method,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'x-acm-tenant-id': this.#tenantId,
        'x-acm-principal-id': this.#principalId,
        ...options.headers,
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const payload = (await response.json()) as unknown;
    if (!response.ok) {
      throw new Error(`ACM request failed (${String(response.status)}): ${JSON.stringify(payload)}`);
    }
    return payload as T;
  }
}
