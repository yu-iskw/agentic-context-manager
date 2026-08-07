import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import {
  ValidationError,
  parseContextCheckpointRequest,
  parseContextQueryRequest,
  parseRecordEventRequest,
  parseStartSessionRequest,
  type ContextCheckpoint,
  type ContextMode,
  type ContextPack,
  type JsonValue,
} from '../../../packages/contracts/src/index.js';
import {
  buildValidatedCheckpoint,
  estimateTokens,
  packWithinBudget,
  type CheckpointCandidate,
  type RankedContextCandidate,
} from '../../../packages/core/src/index.js';
import {
  PsqlClient,
  sqlJson,
  sqlNullableText,
  sqlText,
  sqlTimestamp,
  sqlUuid,
  sqlVector,
} from '../../../packages/db/src/psql.js';
import {
  createProviderFromEnvironment,
  type ContextProvider,
} from '../../../packages/providers/src/index.js';

const DEFAULT_TENANT_ID = '00000000-0000-4000-8000-000000000001';
const ARCHITECTURE_VERSION = 'coding-agent-default-v1';

interface RuntimeConfig {
  databaseUrl: string;
  tenantId: string;
  principalId: string;
  host: string;
  port: number;
}

interface SessionRow {
  sessionId: string;
  contextHandle: string;
  workspaceId: string;
  taskExternalId: string | null;
}

interface EventIngestionRow {
  eventId: string;
  ingestionId: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
}

interface MemoryRow {
  memoryId: string;
  category: string;
  text: string;
  createdAt: string;
  eventId: string;
  occurredAt: string;
  semanticScore: number;
  lexicalScore: number;
  scopeScore: number;
  score: number;
}

interface OverlayRow {
  eventId: string;
  text: string;
  occurredAt: string;
}

function localPrincipalFallback(): string {
  return ['00000000', '0000', '4000', '8000', '000000000002'].join('-');
}

function retrievalLimit(mode: ContextMode): number {
  return mode === 'accurate' ? 100 : 50;
}

function loadConfig(): RuntimeConfig {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined) throw new Error('DATABASE_URL is required');
  return {
    databaseUrl,
    tenantId: process.env.ACM_TENANT_ID ?? DEFAULT_TENANT_ID,
    principalId: process.env.ACM_PRINCIPAL_ID ?? localPrincipalFallback(),
    host: process.env.ACM_HTTP_HOST ?? '127.0.0.1',
    port: Number(process.env.ACM_HTTP_PORT ?? '8080'),
  };
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: string[] = [];
  let bytes = 0;
  await new Promise<void>((resolve, reject) => {
    request.on('data', (chunk) => {
      const value = chunk.toString();
      bytes += value.length;
      if (bytes > 1_048_576) {
        reject(new ValidationError('request body exceeds 1 MiB'));
        return;
      }
      chunks.push(value);
    });
    request.on('end', resolve);
    request.on('error', reject);
  });
  const body = chunks.join('');
  if (body === '') return {};
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new ValidationError('request body must be valid JSON');
  }
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.end(JSON.stringify(value));
}

function contentHash(content: JsonValue): string {
  const digest = createHash('sha256').update(JSON.stringify(content)).digest();
  return digest.toString('hex');
}

function taskPredicate(session: SessionRow, tableAlias: string): string {
  if (session.taskExternalId === null) return `${tableAlias}.task_external_id IS NULL`;
  return `(${tableAlias}.task_external_id IS NULL OR ${tableAlias}.task_external_id = ${sqlText(session.taskExternalId)})`;
}

class AcmService {
  readonly #db: PsqlClient;
  readonly #provider: ContextProvider;
  readonly #tenantId: string;
  readonly #principalId: string;

  constructor(config: RuntimeConfig, provider: ContextProvider) {
    this.#db = new PsqlClient({ databaseUrl: config.databaseUrl, tenantId: config.tenantId });
    this.#provider = provider;
    this.#tenantId = config.tenantId;
    this.#principalId = config.principalId;
  }

  async ready(): Promise<boolean> {
    const rows = await this.#db.rows<{ ready: number }>(`
      SELECT 1 AS ready
      FROM principals
      WHERE id = ${sqlUuid(this.#principalId)}
        AND tenant_id = ${sqlUuid(this.#tenantId)}
      LIMIT 1
    `);
    return rows.length === 1;
  }

  async startSession(
    body: unknown,
  ): Promise<{ sessionId: string; contextHandle: string; architectureVersion: string }> {
    const request = parseStartSessionRequest(body);
    const workspaceId = randomUUID();
    const sessionId = randomUUID();
    const contextHandle = randomUUID();
    const rows = await this.#db.rows<{ sessionId: string; contextHandle: string }>(`
      WITH workspace AS (
        INSERT INTO workspaces (id, tenant_id, principal_id, external_id)
        VALUES (
          ${sqlUuid(workspaceId)}, ${sqlUuid(this.#tenantId)}, ${sqlUuid(this.#principalId)},
          ${sqlText(request.workspace.externalId)}
        )
        ON CONFLICT (tenant_id, principal_id, external_id)
        DO UPDATE SET external_id = EXCLUDED.external_id
        RETURNING id
      )
      INSERT INTO sessions (
        id, tenant_id, principal_id, workspace_id, task_external_id, agent_name,
        context_handle, architecture_version
      )
      SELECT
        ${sqlUuid(sessionId)}, ${sqlUuid(this.#tenantId)}, ${sqlUuid(this.#principalId)}, workspace.id,
        ${sqlNullableText(request.task?.externalId)}, ${sqlNullableText(request.agent?.name)},
        ${sqlUuid(contextHandle)}, ${sqlText(ARCHITECTURE_VERSION)}
      FROM workspace
      RETURNING id::text AS "sessionId", context_handle::text AS "contextHandle"
    `);
    const row = rows[0];
    if (row === undefined) throw new Error('session could not be created');
    return { ...row, architectureVersion: ARCHITECTURE_VERSION };
  }

  async recordEvent(body: unknown): Promise<EventIngestionRow> {
    const request = parseRecordEventRequest(body);
    const eventId = randomUUID();
    const ingestionId = randomUUID();
    const occurredAt = request.occurredAt ?? new Date().toISOString();
    const idempotencyKey = request.idempotencyKey ?? null;
    const rows = await this.#db.rows<EventIngestionRow>(`
      WITH target_session AS (
        SELECT id
        FROM sessions
        WHERE context_handle = ${sqlUuid(request.contextHandle)}
          AND principal_id = ${sqlUuid(this.#principalId)}
      ), inserted_event AS (
        INSERT INTO events (
          id, tenant_id, principal_id, session_id, kind, occurred_at, content, metadata,
          idempotency_key, content_hash
        )
        SELECT
          ${sqlUuid(eventId)}, ${sqlUuid(this.#tenantId)}, ${sqlUuid(this.#principalId)}, target_session.id,
          ${sqlText(request.kind)}, ${sqlTimestamp(occurredAt)}, ${sqlJson(request.content)},
          ${sqlJson(request.metadata ?? {})}, ${sqlNullableText(idempotencyKey)},
          ${sqlText(contentHash(request.content))}
        FROM target_session
        ON CONFLICT (tenant_id, session_id, idempotency_key)
        DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
        RETURNING id
      ), queued AS (
        INSERT INTO ingestion_status (id, tenant_id, event_id, status)
        SELECT ${sqlUuid(ingestionId)}, ${sqlUuid(this.#tenantId)}, inserted_event.id, 'pending'
        FROM inserted_event
        ON CONFLICT (event_id)
        DO UPDATE SET event_id = EXCLUDED.event_id
        RETURNING id, event_id, status
      )
      SELECT event_id::text AS "eventId", id::text AS "ingestionId", status
      FROM queued
    `);
    const row = rows[0];
    if (row === undefined) throw new ValidationError('unknown or unauthorized contextHandle');
    return row;
  }

  async ingestionStatus(ingestionId: string): Promise<Record<string, JsonValue> | undefined> {
    const rows = await this.#db.rows<Record<string, JsonValue>>(`
      SELECT
        i.id::text AS "ingestionId",
        i.event_id::text AS "eventId",
        i.status,
        i.attempts,
        i.last_error AS "lastError",
        i.created_at::text AS "createdAt",
        i.completed_at::text AS "completedAt"
      FROM ingestion_status i
      JOIN events e ON e.id = i.event_id
      WHERE i.id = ${sqlUuid(ingestionId)}
        AND e.principal_id = ${sqlUuid(this.#principalId)}
    `);
    return rows[0];
  }

  async recall(body: unknown): Promise<ContextPack> {
    const request = parseContextQueryRequest(body);
    const mode = request.mode ?? 'fast';
    const budgetTokens = request.budgetTokens ?? 6000;
    const session = await this.#loadSession(request.contextHandle);
    const vectors = await this.#provider.embed([request.query]);
    const embedding = vectors[0];
    if (embedding === undefined) throw new Error('embedding provider returned no vector');

    const memories = await this.#loadRankedMemories(
      session,
      request.query,
      mode,
      sqlVector(embedding),
    );
    const overlays = await this.#loadOverlays(session.sessionId);
    const candidates = this.#contextCandidates(memories, overlays, request.includeExplanations);
    const packed = packWithinBudget(candidates, budgetTokens);
    const pack: ContextPack = {
      id: randomUUID(),
      sessionId: session.sessionId,
      mode,
      budgetTokens,
      usedTokens: packed.usedTokens,
      items: packed.selected,
      omittedItems: packed.omittedItems,
      createdAt: new Date().toISOString(),
    };
    await this.#persistContextPack(pack, request.query);
    return pack;
  }

  async checkpoint(body: unknown): Promise<ContextCheckpoint> {
    const request = parseContextCheckpointRequest(body);
    const budgetTokens = request.budgetTokens ?? 6000;
    const session = await this.#loadSession(request.contextHandle);
    await this.#assertCheckpointStable(session.sessionId);
    const candidates = await this.#checkpointCandidates(session);
    const built = buildValidatedCheckpoint(candidates, budgetTokens);
    if (built.status === 'rejected') {
      throw new ValidationError(
        `checkpoint rejected: preserved ${built.validation.preservedCount} of ${built.validation.mustPreserveCount} required memories`,
      );
    }

    const checkpoint: ContextCheckpoint = {
      id: randomUUID(),
      sessionId: session.sessionId,
      status: 'validated',
      budgetTokens,
      usedTokens: built.usedTokens,
      summary: built.summary,
      sourceMemoryIds: built.sourceMemoryIds,
      validation: built.validation,
      createdAt: new Date().toISOString(),
    };
    await this.#db.execute(`
      INSERT INTO checkpoints (
        id, tenant_id, session_id, status, budget_tokens, used_tokens,
        summary, source_memory_ids, validation
      ) VALUES (
        ${sqlUuid(checkpoint.id)}, ${sqlUuid(this.#tenantId)}, ${sqlUuid(session.sessionId)},
        'validated', ${budgetTokens}, ${checkpoint.usedTokens}, ${sqlText(checkpoint.summary)},
        ${sqlJson(checkpoint.sourceMemoryIds)}, ${sqlJson(checkpoint.validation)}
      )
    `);
    return checkpoint;
  }

  async #loadSession(contextHandle: string): Promise<SessionRow> {
    const sessions = await this.#db.rows<SessionRow>(`
      SELECT
        id::text AS "sessionId",
        context_handle::text AS "contextHandle",
        workspace_id::text AS "workspaceId",
        task_external_id AS "taskExternalId"
      FROM sessions
      WHERE context_handle = ${sqlUuid(contextHandle)}
        AND principal_id = ${sqlUuid(this.#principalId)}
    `);
    const session = sessions[0];
    if (session === undefined) throw new ValidationError('unknown or unauthorized contextHandle');
    return session;
  }

  async #loadRankedMemories(
    session: SessionRow,
    query: string,
    mode: ContextMode,
    vector: string,
  ): Promise<MemoryRow[]> {
    return await this.#db.rows<MemoryRow>(`
      SELECT
        m.id::text AS "memoryId",
        m.category,
        m.retrieval_text AS text,
        m.created_at::text AS "createdAt",
        e.id::text AS "eventId",
        e.occurred_at::text AS "occurredAt",
        GREATEST(0, 1 - (m.embedding <=> ${vector}))::float8 AS "semanticScore",
        GREATEST(0, similarity(m.retrieval_text, ${sqlText(query)}))::float8 AS "lexicalScore",
        CASE
          WHEN m.session_id = ${sqlUuid(session.sessionId)} THEN 1.0
          WHEN m.task_external_id IS NOT NULL THEN 0.85
          WHEN m.workspace_id IS NOT NULL THEN 0.70
          ELSE 0.50
        END::float8 AS "scopeScore",
        (
          0.50 * GREATEST(0, 1 - (m.embedding <=> ${vector})) +
          0.35 * GREATEST(0, similarity(m.retrieval_text, ${sqlText(query)})) +
          0.15 * CASE
            WHEN m.session_id = ${sqlUuid(session.sessionId)} THEN 1.0
            WHEN m.task_external_id IS NOT NULL THEN 0.85
            WHEN m.workspace_id IS NOT NULL THEN 0.70
            ELSE 0.50
          END
        )::float8 AS score
      FROM memory_items m
      JOIN events e ON e.id = m.source_event_id
      WHERE m.status = 'active'
        AND (m.workspace_id IS NULL OR m.workspace_id = ${sqlUuid(session.workspaceId)})
        AND ${taskPredicate(session, 'm')}
        AND (m.session_id IS NULL OR m.session_id = ${sqlUuid(session.sessionId)})
      ORDER BY score DESC, m.created_at DESC
      LIMIT ${retrievalLimit(mode)}
    `);
  }

  async #persistContextPack(pack: ContextPack, query: string): Promise<void> {
    await this.#db.execute(`
      INSERT INTO context_packs (
        id, tenant_id, session_id, mode, query, budget_tokens, used_tokens,
        selected_items, omitted_items
      ) VALUES (
        ${sqlUuid(pack.id)}, ${sqlUuid(this.#tenantId)}, ${sqlUuid(pack.sessionId)},
        ${sqlText(pack.mode)}, ${sqlText(query)}, ${pack.budgetTokens}, ${pack.usedTokens},
        ${sqlJson(pack.items)}, ${pack.omittedItems}
      )
    `);
  }

  async #loadOverlays(sessionId: string): Promise<OverlayRow[]> {
    return await this.#db.rows<OverlayRow>(`
      SELECT
        e.id::text AS "eventId",
        COALESCE(e.content ->> 'text', e.content::text) AS text,
        e.occurred_at::text AS "occurredAt"
      FROM events e
      JOIN ingestion_status i ON i.event_id = e.id
      WHERE e.session_id = ${sqlUuid(sessionId)}
        AND i.status IN ('pending', 'processing')
      ORDER BY e.occurred_at DESC
      LIMIT 8
    `);
  }

  #contextCandidates(
    memories: readonly MemoryRow[],
    overlays: readonly OverlayRow[],
    includeExplanations: boolean | undefined,
  ): RankedContextCandidate[] {
    return [
      ...overlays.map((row) => ({
        memoryId: `event:${row.eventId}`,
        category: 'recent-event',
        text: row.text,
        score: 1.05,
        estimatedTokens: estimateTokens(row.text),
        selectedBecause: ['recent unprocessed session event', 'read-your-writes overlay'],
        provenance: [{ eventId: row.eventId, occurredAt: row.occurredAt }],
        createdAt: row.occurredAt,
      })),
      ...memories.map((row) => ({
        memoryId: row.memoryId,
        category: row.category,
        text: row.text,
        score: row.score,
        estimatedTokens: estimateTokens(row.text),
        selectedBecause:
          includeExplanations === false
            ? []
            : [
                `semantic=${row.semanticScore.toFixed(3)}`,
                `lexical=${row.lexicalScore.toFixed(3)}`,
                `scope=${row.scopeScore.toFixed(3)}`,
                'authorized before ranking',
              ],
        provenance: [{ eventId: row.eventId, occurredAt: row.occurredAt }],
        createdAt: row.createdAt,
      })),
    ];
  }

  async #assertCheckpointStable(sessionId: string): Promise<void> {
    const rows = await this.#db.rows<{ count: number }>(`
      SELECT count(*)::int AS count
      FROM ingestion_status i
      JOIN events e ON e.id = i.event_id
      WHERE e.session_id = ${sqlUuid(sessionId)}
        AND i.status IN ('pending', 'processing')
    `);
    if ((rows[0]?.count ?? 0) > 0) {
      throw new ValidationError('checkpoint requires all session ingestions to finish');
    }
  }

  async #checkpointCandidates(session: SessionRow): Promise<CheckpointCandidate[]> {
    return await this.#db.rows<CheckpointCandidate>(`
      SELECT
        m.id::text AS "memoryId",
        m.category,
        m.retrieval_text AS text,
        m.created_at::text AS "createdAt"
      FROM memory_items m
      WHERE m.status = 'active'
        AND (m.workspace_id IS NULL OR m.workspace_id = ${sqlUuid(session.workspaceId)})
        AND ${taskPredicate(session, 'm')}
        AND (m.session_id IS NULL OR m.session_id = ${sqlUuid(session.sessionId)})
      ORDER BY m.created_at DESC
      LIMIT 500
    `);
  }
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

const tools = [
  {
    name: 'acm.session.start',
    description: 'Start or resume an explicit ACM context handle for a workspace/task.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: {
          type: 'object',
          properties: { externalId: { type: 'string' } },
          required: ['externalId'],
        },
        task: { type: 'object', properties: { externalId: { type: 'string' } } },
        agent: { type: 'object', properties: { name: { type: 'string' } } },
      },
      required: ['workspace'],
      additionalProperties: false,
    },
  },
  {
    name: 'acm.event.record',
    description: 'Durably record an ACM event and asynchronously derive memory from it.',
    inputSchema: {
      type: 'object',
      properties: {
        contextHandle: { type: 'string' },
        kind: { type: 'string' },
        content: {},
        idempotencyKey: { type: 'string' },
      },
      required: ['contextHandle', 'kind', 'content'],
      additionalProperties: true,
    },
  },
  {
    name: 'acm.context.recall',
    description: 'Retrieve a scoped, token-budgeted context pack.',
    inputSchema: {
      type: 'object',
      properties: {
        contextHandle: { type: 'string' },
        query: { type: 'string' },
        mode: { enum: ['fast', 'accurate'] },
        budgetTokens: { type: 'integer', minimum: 64, maximum: 32000 },
        includeExplanations: { type: 'boolean' },
      },
      required: ['contextHandle', 'query'],
      additionalProperties: false,
    },
  },
  {
    name: 'acm.context.checkpoint',
    description: 'Create a validated, token-budgeted extractive checkpoint.',
    inputSchema: {
      type: 'object',
      properties: {
        contextHandle: { type: 'string' },
        budgetTokens: { type: 'integer', minimum: 64, maximum: 32000 },
      },
      required: ['contextHandle'],
      additionalProperties: false,
    },
  },
] as const;

function recordValue(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

async function callMcpTool(service: AcmService, name: unknown, args: unknown): Promise<unknown> {
  switch (name) {
    case 'acm.session.start':
      return await service.startSession(args);
    case 'acm.event.record':
      return await service.recordEvent(args);
    case 'acm.context.recall':
      return await service.recall(args);
    case 'acm.context.checkpoint':
      return await service.checkpoint(args);
    default:
      throw new ValidationError(`unknown tool: ${String(name)}`);
  }
}

async function handleMcp(service: AcmService, body: unknown): Promise<Record<string, unknown>> {
  const message = recordValue(body);
  if (message === undefined) return rpcError(null, -32600, 'Invalid Request');
  const id = message.id;
  if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return rpcError(id, -32600, 'Invalid Request');
  }

  switch (message.method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id: id ?? null,
        result: {
          protocolVersion: '2026-07-28',
          capabilities: { tools: {} },
          serverInfo: { name: 'agentic-context-manager', version: '0.1.0' },
        },
      };
    case 'tools/list':
      return { jsonrpc: '2.0', id: id ?? null, result: { tools } };
    case 'tools/call':
      return await handleMcpToolCall(service, id, message.params);
    default:
      return rpcError(id, -32601, 'Method not found');
  }
}

async function handleMcpToolCall(
  service: AcmService,
  id: unknown,
  paramsValue: unknown,
): Promise<Record<string, unknown>> {
  const params = recordValue(paramsValue);
  if (params === undefined) return rpcError(id, -32602, 'Invalid params');
  try {
    const result = await callMcpTool(service, params.name, params.arguments ?? {});
    return {
      jsonrpc: '2.0',
      id: id ?? null,
      result: {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result,
        isError: false,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      jsonrpc: '2.0',
      id: id ?? null,
      result: { content: [{ type: 'text', text: message }], isError: true },
    };
  }
}

async function handleHealthRoute(
  service: AcmService,
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
): Promise<boolean> {
  if (request.method !== 'GET') return false;
  if (path === '/health/live') {
    writeJson(response, 200, { status: 'ok' });
    return true;
  }
  if (path !== '/health/ready') return false;
  const ready = await service.ready();
  writeJson(response, ready ? 200 : 503, { status: ready ? 'ready' : 'not_ready' });
  return true;
}

async function handleApiRoute(
  service: AcmService,
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
): Promise<boolean> {
  if (request.method === 'POST' && path === '/v1/sessions') {
    writeJson(response, 201, await service.startSession(await readJson(request)));
    return true;
  }
  if (request.method === 'POST' && path === '/v1/events') {
    writeJson(response, 202, await service.recordEvent(await readJson(request)));
    return true;
  }
  if (request.method === 'POST' && path === '/v1/context/query') {
    writeJson(response, 200, await service.recall(await readJson(request)));
    return true;
  }
  if (request.method === 'POST' && path === '/v1/context/checkpoint') {
    writeJson(response, 201, await service.checkpoint(await readJson(request)));
    return true;
  }
  return await handleIngestionRoute(service, request, response, path);
}

async function handleIngestionRoute(
  service: AcmService,
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
): Promise<boolean> {
  if (request.method !== 'GET' || !path.startsWith('/v1/ingestions/')) return false;
  const ingestionId = path.slice('/v1/ingestions/'.length);
  const result = await service.ingestionStatus(ingestionId);
  if (result === undefined) {
    writeJson(response, 404, { error: { code: 'not_found', message: 'ingestion not found' } });
  } else {
    writeJson(response, 200, result);
  }
  return true;
}

async function dispatchRequest(
  service: AcmService,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? '/', `http://${request.headers?.host ?? 'localhost'}`);
  const healthHandled = await handleHealthRoute(service, request, response, url.pathname);
  if (healthHandled) return;
  const apiHandled = await handleApiRoute(service, request, response, url.pathname);
  if (apiHandled) return;
  if (request.method === 'POST' && url.pathname === '/mcp') {
    writeJson(response, 200, await handleMcp(service, await readJson(request)));
    return;
  }
  writeJson(response, 404, { error: { code: 'not_found', message: 'route not found' } });
}

function writeRequestError(response: ServerResponse, error: unknown): void {
  if (error instanceof ValidationError) {
    writeJson(response, 400, { error: { code: error.code, message: error.message } });
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ level: 'error', message }));
  writeJson(response, 500, {
    error: { code: 'internal_error', message: 'internal server error' },
  });
}

const config = loadConfig();
const service = new AcmService(config, createProviderFromEnvironment());
const server = createServer(async (request, response) => {
  try {
    await dispatchRequest(service, request, response);
  } catch (error) {
    writeRequestError(response, error);
  }
});

server.listen(config.port, config.host, () => {
  console.log(
    JSON.stringify({
      level: 'info',
      message: 'ACM API listening',
      host: config.host,
      port: config.port,
    }),
  );
});

function shutdown(): void {
  server.close(() => {
    process.exitCode = 0;
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
