import { randomUUID } from 'node:crypto';

import {
  PsqlClient,
  sqlJson,
  sqlNullableText,
  sqlNumber,
  sqlText,
  sqlUuid,
  sqlVector,
} from '../../../packages/db/src/psql.js';
import { createProviderFromEnvironment } from '../../../packages/providers/src/index.js';

import type { EventKind, JsonValue } from '../../../packages/contracts/src/index.js';
import type { ContextProvider } from '../../../packages/providers/src/index.js';

const DEFAULT_TENANT_ID = '00000000-0000-4000-8000-000000000001';

interface ClaimedIngestion {
  ingestionId: string;
  eventId: string;
  attempts: number;
}

interface EventRow {
  eventId: string;
  kind: EventKind;
  content: JsonValue;
  workspaceId: string;
  taskExternalId: string | null;
  sessionId: string;
}

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required');
const tenantId = process.env.ACM_TENANT_ID ?? DEFAULT_TENANT_ID;
const pollMilliseconds = Number(process.env.ACM_WORKER_POLL_MS ?? '250');
const db = new PsqlClient({ databaseUrl, tenantId });
const provider = createProviderFromEnvironment();
const workerState = { stopRequested: false };

async function recoverAbandonedJobs(): Promise<void> {
  await db.execute(`
    UPDATE ingestion_status
    SET status = 'pending', started_at = NULL, next_attempt_at = now()
    WHERE status = 'processing'
      AND started_at < now() - interval '5 minutes'
  `);
}

async function claimJob(): Promise<ClaimedIngestion | undefined> {
  const rows = await db.rows<ClaimedIngestion>(`
    WITH candidate AS (
      SELECT id
      FROM ingestion_status
      WHERE status = 'pending'
        AND next_attempt_at <= now()
      ORDER BY created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE ingestion_status AS ingestion
    SET status = 'processing', started_at = now(), attempts = ingestion.attempts + 1
    FROM candidate
    WHERE ingestion.id = candidate.id
    RETURNING ingestion.id::text AS "ingestionId", ingestion.event_id::text AS "eventId", ingestion.attempts
  `);
  return rows[0];
}

async function loadEvent(eventId: string): Promise<EventRow> {
  const rows = await db.rows<EventRow>(`
    SELECT
      e.id::text AS "eventId",
      e.kind,
      e.content,
      s.workspace_id::text AS "workspaceId",
      s.task_external_id AS "taskExternalId",
      s.id::text AS "sessionId"
    FROM events e
    JOIN sessions s ON s.id = e.session_id
    WHERE e.id = ${sqlUuid(eventId)}
  `);
  const row = rows[0];
  if (row === undefined) throw new Error(`event not found: ${eventId}`);
  return row;
}

function memoryCategory(eventKind: EventKind, extractedCategory: string): string {
  if (eventKind === 'decision') return 'decision';
  if (eventKind === 'handoff') return 'handoff';
  if (eventKind === 'test_result') return 'test-result';
  return extractedCategory;
}

async function processJob(job: ClaimedIngestion, contextProvider: ContextProvider): Promise<void> {
  const event = await loadEvent(job.eventId);
  const memories = await contextProvider.extract(event.content);

  for (const memory of memories) {
    const vectors = await contextProvider.embed([memory.retrievalText]);
    const embedding = vectors[0];
    if (embedding === undefined) throw new Error('embedding provider returned no vector');
    const memoryId = randomUUID();
    const category = memoryCategory(event.kind, memory.category);
    await db.execute(`
      BEGIN;
      INSERT INTO memory_items (
        id, tenant_id, workspace_id, task_external_id, session_id, category,
        structured_value, retrieval_text, embedding, confidence, architecture_version,
        extractor_id, source_event_id, status
      ) VALUES (
        ${sqlUuid(memoryId)}, ${sqlUuid(tenantId)}, ${sqlUuid(event.workspaceId)},
        ${sqlNullableText(event.taskExternalId)}, NULL, ${sqlText(category)},
        ${sqlJson(memory.structuredValue)}, ${sqlText(memory.retrievalText)}, ${sqlVector(embedding)},
        ${sqlNumber(memory.confidence)}, ${sqlText('coding-agent-default-v1')},
        ${sqlText(memory.extractorId)}, ${sqlUuid(event.eventId)}, 'active'
      )
      ON CONFLICT (source_event_id, extractor_id)
      DO UPDATE SET
        category = EXCLUDED.category,
        structured_value = EXCLUDED.structured_value,
        retrieval_text = EXCLUDED.retrieval_text,
        embedding = EXCLUDED.embedding,
        confidence = EXCLUDED.confidence,
        updated_at = now();

      INSERT INTO memory_sources (tenant_id, memory_id, event_id)
      SELECT ${sqlUuid(tenantId)}, id, ${sqlUuid(event.eventId)}
      FROM memory_items
      WHERE source_event_id = ${sqlUuid(event.eventId)}
        AND extractor_id = ${sqlText(memory.extractorId)}
      ON CONFLICT DO NOTHING;
      COMMIT;
    `);
  }

  await db.execute(`
    UPDATE ingestion_status
    SET status = 'completed', completed_at = now(), started_at = NULL, last_error = NULL
    WHERE id = ${sqlUuid(job.ingestionId)}
  `);
}

function retrySql(job: ClaimedIngestion): {
  shouldRetry: boolean;
  status: string;
  nextAttempt: string;
} {
  const shouldRetry = job.attempts < 3;
  return {
    shouldRetry,
    status: shouldRetry ? 'pending' : 'failed',
    nextAttempt: shouldRetry
      ? `now() + interval '${Math.min(30, 2 ** job.attempts)} seconds'`
      : 'now()',
  };
}

async function failJob(job: ClaimedIngestion, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const retry = retrySql(job);
  await db.execute(`
    UPDATE ingestion_status
    SET
      status = ${sqlText(retry.status)},
      last_error = ${sqlText(message.slice(0, 2000))},
      started_at = NULL,
      next_attempt_at = ${retry.nextAttempt}
    WHERE id = ${sqlUuid(job.ingestionId)}
  `);
  console.error(
    JSON.stringify({
      level: 'error',
      message: 'ingestion failed',
      ingestionId: job.ingestionId,
      attempts: job.attempts,
      retry: retry.shouldRetry,
    }),
  );
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function run(): Promise<void> {
  await recoverAbandonedJobs();
  console.log(JSON.stringify({ level: 'info', message: 'ACM worker started' }));
  while (workerState.stopRequested === false) {
    const job = await claimJob();
    if (job === undefined) {
      await sleep(pollMilliseconds);
      continue;
    }
    try {
      await processJob(job, provider);
    } catch (error) {
      await failJob(job, error);
    }
  }
  console.log(JSON.stringify({ level: 'info', message: 'ACM worker stopped' }));
}

function requestStop(): void {
  workerState.stopRequested = true;
}

process.on('SIGTERM', requestStop);
process.on('SIGINT', requestStop);

await run();
