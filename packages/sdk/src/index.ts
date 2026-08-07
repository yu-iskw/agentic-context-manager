import type {
  ContextCheckpoint,
  ContextCheckpointRequest,
  ContextPack,
  ContextQueryRequest,
  RecordEventRequest,
  RecordEventResponse,
  StartSessionRequest,
  StartSessionResponse,
} from '../../contracts/src/index.js';

export interface AcmClientOptions {
  baseUrl: string;
  fetchImplementation?: typeof fetch;
}

export interface IngestionStatus {
  ingestionId: string;
  eventId: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  attempts: number;
  lastError: string | null;
  createdAt: string;
  completedAt: string | null;
}

function isTerminalStatus(status: IngestionStatus['status']): boolean {
  return status === 'completed' || status === 'failed';
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

export class AcmApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    super(`ACM request failed with HTTP ${status}`);
    this.name = 'AcmApiError';
    this.status = status;
    this.body = body;
  }
}

export class AcmClient {
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;

  constructor(options: AcmClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, '');
    this.#fetch = options.fetchImplementation ?? fetch;
  }

  async startSession(request: StartSessionRequest): Promise<StartSessionResponse> {
    return await this.#request<StartSessionResponse>('/v1/sessions', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }

  async recordEvent(request: RecordEventRequest): Promise<RecordEventResponse> {
    return await this.#request<RecordEventResponse>('/v1/events', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }

  async ingestionStatus(ingestionId: string): Promise<IngestionStatus> {
    return await this.#request<IngestionStatus>(
      `/v1/ingestions/${encodeURIComponent(ingestionId)}`,
      { method: 'GET' },
    );
  }

  async queryContext(request: ContextQueryRequest): Promise<ContextPack> {
    return await this.#request<ContextPack>('/v1/context/query', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }

  async checkpointContext(request: ContextCheckpointRequest): Promise<ContextCheckpoint> {
    return await this.#request<ContextCheckpoint>('/v1/context/checkpoint', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }

  async waitForIngestion(
    ingestionId: string,
    options: { timeoutMs?: number; pollIntervalMs?: number } = {},
  ): Promise<IngestionStatus> {
    const timeoutMs = options.timeoutMs ?? 30_000;
    const pollIntervalMs = options.pollIntervalMs ?? 250;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const status = await this.ingestionStatus(ingestionId);
      if (isTerminalStatus(status.status)) return status;
      await delay(pollIntervalMs);
    }

    throw new Error(`ACM ingestion ${ingestionId} did not finish within ${timeoutMs} ms`);
  }

  async #request<T>(path: string, init: RequestInit): Promise<T> {
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      ...init,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...init.headers,
      },
    });

    const body = (await response.json()) as unknown;
    if (!response.ok) throw new AcmApiError(response.status, body);
    return body as T;
  }
}
