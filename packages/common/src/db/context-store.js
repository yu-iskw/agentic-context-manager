const { randomUUID } = require('node:crypto');

const { packToTokenBudget } = require('../core/context-pack.js');
const { deterministicEmbedding, toPgVector } = require('../core/embedding.js');
const { PsqlClient } = require('./psql-client.js');

class ContextStore {
  #db;

  constructor(db) {
    this.#db = db;
  }

  async ping() {
    await this.#db.ping();
  }

  async ensurePrincipal(context) {
    await this.#db.queryJson(
      `
      INSERT INTO tenants (id, name)
      VALUES (:'tenant_id'::uuid, 'local-' || :'tenant_id')
      ON CONFLICT (id) DO NOTHING;
      INSERT INTO principals (id, tenant_id, external_subject)
      VALUES (:'principal_id'::uuid, :'tenant_id'::uuid, :'principal_id')
      ON CONFLICT (id) DO NOTHING;
      SELECT json_build_object('ok', true)::text;
      `,
      { tenant_id: context.tenantId, principal_id: context.principalId },
      context.tenantId,
    );
  }

  async createSession(context, input) {
    await this.ensurePrincipal(context);
    const id = randomUUID();
    const rows = await this.#db.queryJson(
      `
      WITH inserted AS (
        INSERT INTO sessions (
          id, tenant_id, principal_id, workspace_id, task_id, agent_id, metadata
        ) VALUES (
          :'id'::uuid,
          :'tenant_id'::uuid,
          :'principal_id'::uuid,
          NULLIF(:'workspace_id', '')::text,
          NULLIF(:'task_id', '')::text,
          NULLIF(:'agent_id', '')::text,
          :'metadata'::jsonb
        )
        RETURNING *
      )
      SELECT COALESCE(json_agg(row_to_json(inserted)), '[]'::json)::text FROM inserted;
      `,
      {
        id,
        tenant_id: context.tenantId,
        principal_id: context.principalId,
        workspace_id: input.workspaceId ?? '',
        task_id: input.taskId ?? '',
        agent_id: input.agentId ?? '',
        metadata: JSON.stringify(input.metadata ?? {}),
      },
      context.tenantId,
    );
    const row = rows.at(0);
    if (row === undefined) {
      throw new Error('Failed to create session');
    }
    return {
      id: row.id,
      tenantId: row.tenant_id,
      principalId: row.principal_id,
      ...(row.workspace_id === null ? {} : { workspaceId: row.workspace_id }),
      ...(row.task_id === null ? {} : { taskId: row.task_id }),
      ...(row.agent_id === null ? {} : { agentId: row.agent_id }),
      metadata: row.metadata,
      createdAt: row.created_at,
    };
  }

  async recordEvent(context, input, idempotencyKey) {
    const eventId = randomUUID();
    const ingestionId = randomUUID();
    const occurredAt = input.occurredAt ?? new Date().toISOString();
    const result = await this.#db.queryJson(
      `
      WITH session_scope AS (
        SELECT workspace_id, task_id
        FROM sessions
        WHERE id = :'session_id'::uuid
          AND principal_id = :'principal_id'::uuid
      ), inserted_event AS (
        INSERT INTO events (
          id, tenant_id, principal_id, session_id, workspace_id, task_id,
          kind, occurred_at, content, metadata, idempotency_key, sensitivity
        )
        SELECT
          :'event_id'::uuid,
          :'tenant_id'::uuid,
          :'principal_id'::uuid,
          :'session_id'::uuid,
          workspace_id,
          task_id,
          :'kind',
          :'occurred_at'::timestamptz,
          :'content'::jsonb,
          :'metadata'::jsonb,
          NULLIF(:'idempotency_key', ''),
          :'sensitivity'
        FROM session_scope
        ON CONFLICT (tenant_id, idempotency_key)
          WHERE idempotency_key IS NOT NULL
        DO NOTHING
        RETURNING id
      ), selected_event AS (
        SELECT id FROM inserted_event
        UNION ALL
        SELECT id FROM events
        WHERE tenant_id = :'tenant_id'::uuid
          AND principal_id = :'principal_id'::uuid
          AND session_id = :'session_id'::uuid
          AND idempotency_key = NULLIF(:'idempotency_key', '')
        LIMIT 1
      ), inserted_job AS (
        INSERT INTO ingestion_jobs (id, tenant_id, event_id, status)
        SELECT :'ingestion_id'::uuid, :'tenant_id'::uuid, id, 'queued'
        FROM selected_event
        ON CONFLICT (event_id) DO NOTHING
        RETURNING id, event_id, status
      ), selected_job AS (
        SELECT id, event_id, status FROM inserted_job
        UNION ALL
        SELECT id, event_id, status
        FROM ingestion_jobs
        WHERE event_id = (SELECT id FROM selected_event)
        LIMIT 1
      )
      SELECT COALESCE(
        (SELECT json_build_object(
          'eventId', event_id,
          'ingestionId', id,
          'status', CASE WHEN status = 'queued' THEN 'accepted' ELSE status END
        ) FROM selected_job),
        json_build_object('eventId', '', 'ingestionId', '', 'status', 'failed')
      )::text;
      `,
      {
        event_id: eventId,
        ingestion_id: ingestionId,
        tenant_id: context.tenantId,
        principal_id: context.principalId,
        session_id: input.sessionId,
        kind: input.kind,
        occurred_at: occurredAt,
        content: JSON.stringify(input.content),
        metadata: JSON.stringify(input.metadata ?? {}),
        idempotency_key: idempotencyKey ?? '',
        sensitivity: input.sensitivity ?? 'internal',
      },
      context.tenantId,
    );
    if (result.eventId.length === 0) {
      throw new Error('Event session was not found or not authorized');
    }
    return result;
  }

  async getIngestionStatus(context, ingestionId) {
    const rows = await this.#db.queryJson(
      `
      SELECT COALESCE(json_agg(json_build_object(
        'ingestionId', j.id,
        'eventId', j.event_id,
        'status', j.status,
        'attempts', j.attempts,
        'lastError', j.last_error,
        'updatedAt', j.updated_at
      )), '[]'::json)::text
      FROM ingestion_jobs j
      JOIN events ev ON ev.id = j.event_id
      WHERE j.id = :'ingestion_id'::uuid
        AND ev.principal_id = :'principal_id'::uuid;
      `,
      { ingestion_id: ingestionId, principal_id: context.principalId },
      context.tenantId,
    );
    return rows.at(0);
  }

  async retrieveContext(context, input) {
    const tokenBudget = Math.min(Math.max(input.tokenBudget ?? 2_000, 64), 32_000);
    const limit = Math.min(Math.max(input.limit ?? 40, 1), 100);
    const mode = input.mode ?? 'fast';
    const vector = toPgVector(deterministicEmbedding(input.query));
    const candidates = await this.#db.queryJson(
      `
      WITH current_session AS (
        SELECT workspace_id, task_id
        FROM sessions
        WHERE id = :'session_id'::uuid
          AND principal_id = :'principal_id'::uuid
      ), memory_candidates AS (
        SELECT
          'memory'::text AS kind,
          m.id::text AS id,
          m.retrieval_text AS text,
          m.category,
          (
            0.45 * similarity(m.retrieval_text, :'query') +
            0.40 * GREATEST(0, 1 - (e.embedding <=> :'embedding'::vector(8))) +
            0.10 * CASE
              WHEN m.session_id = :'session_id'::uuid THEN 1.0
              WHEN m.task_id IS NOT NULL AND m.task_id = s.task_id THEN 0.85
              WHEN m.workspace_id IS NOT NULL AND m.workspace_id = s.workspace_id THEN 0.65
              ELSE 0.20
            END +
            0.05 * (1.0 / (1.0 + EXTRACT(EPOCH FROM (now() - m.created_at)) / 86400.0))
          ) AS score,
          CASE
            WHEN m.session_id = :'session_id'::uuid THEN 'session'
            WHEN m.task_id IS NOT NULL AND m.task_id = s.task_id THEN 'task'
            WHEN m.workspace_id IS NOT NULL AND m.workspace_id = s.workspace_id THEN 'workspace'
            ELSE 'tenant'
          END AS scope,
          ARRAY_REMOVE(ARRAY_AGG(ms.event_id::text), NULL) AS source_event_ids
        FROM memory_items m
        JOIN events source_event ON source_event.id = m.source_event_id
        JOIN memory_embeddings e ON e.memory_id = m.id
        CROSS JOIN current_session s
        LEFT JOIN memory_sources ms ON ms.memory_id = m.id
        WHERE m.status = 'active'
          AND source_event.principal_id = :'principal_id'::uuid
          AND (
            m.session_id = :'session_id'::uuid OR
            (m.task_id IS NOT NULL AND m.task_id = s.task_id) OR
            (m.workspace_id IS NOT NULL AND m.workspace_id = s.workspace_id)
          )
        GROUP BY m.id, e.embedding, s.task_id, s.workspace_id
      ), recent_events AS (
        SELECT
          'recent-event'::text AS kind,
          ev.id::text AS id,
          ev.content ->> 'text' AS text,
          'recent-event'::text AS category,
          1.05::double precision AS score,
          'session'::text AS scope,
          ARRAY[ev.id::text] AS source_event_ids
        FROM events ev
        JOIN ingestion_jobs j ON j.event_id = ev.id
        WHERE ev.session_id = :'session_id'::uuid
          AND ev.principal_id = :'principal_id'::uuid
          AND j.status <> 'completed'
        ORDER BY ev.received_at DESC
        LIMIT 8
      ), combined AS (
        SELECT * FROM recent_events
        UNION ALL
        SELECT * FROM memory_candidates
      )
      SELECT COALESCE(json_agg(row_to_json(c)), '[]'::json)::text
      FROM (
        SELECT * FROM combined
        ORDER BY score DESC, id ASC
        LIMIT :limit
      ) c;
      `,
      {
        session_id: input.sessionId,
        principal_id: context.principalId,
        query: input.query,
        embedding: vector,
        limit,
      },
      context.tenantId,
    );

    const normalized = candidates.map((candidate) => ({
      kind: candidate.kind,
      id: candidate.id,
      text: candidate.text,
      category: candidate.category,
      score: Number(candidate.score),
      scope: candidate.scope,
      sourceEventIds: candidate.source_event_ids,
    }));
    const packed = packToTokenBudget(normalized, tokenBudget);
    return {
      id: randomUUID(),
      sessionId: input.sessionId,
      query: input.query,
      mode,
      tokenBudget,
      tokensUsed: packed.tokensUsed,
      items: packed.items,
      createdAt: new Date().toISOString(),
    };
  }

  async claimIngestionJob() {
    const rows = await this.#db.queryJson(`
      WITH candidate AS (
        SELECT id
        FROM ingestion_jobs
        WHERE status IN ('queued', 'retry')
          AND available_at <= now()
        ORDER BY created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      ), claimed AS (
        UPDATE ingestion_jobs j
        SET status = 'processing', attempts = attempts + 1, locked_at = now(), updated_at = now()
        FROM candidate c
        WHERE j.id = c.id
        RETURNING j.id, j.tenant_id, j.event_id, j.attempts
      )
      SELECT COALESCE(json_agg(row_to_json(claimed)), '[]'::json)::text FROM claimed;
    `);
    return rows.at(0);
  }

  async loadEventForIngestion(eventId) {
    const rows = await this.#db.queryJson(
      `
      SELECT COALESCE(json_agg(row_to_json(e)), '[]'::json)::text
      FROM (
        SELECT id, tenant_id, session_id, workspace_id, task_id, kind, content, sensitivity
        FROM events
        WHERE id = :'event_id'::uuid
      ) e;
      `,
      { event_id: eventId },
    );
    return rows.at(0);
  }

  async completeIngestion(job, event) {
    const memoryId = randomUUID();
    const text = event.content.text.trim();
    const category = event.kind === 'decision' ? 'decision' : 'observation';
    const embedding = toPgVector(deterministicEmbedding(text));
    await this.#db.queryJson(
      `
      WITH inserted_memory AS (
        INSERT INTO memory_items (
          id, tenant_id, source_event_id, workspace_id, task_id, session_id, category,
          structured_value, retrieval_text, sensitivity, extractor_id, confidence
        ) VALUES (
          :'memory_id'::uuid, :'tenant_id'::uuid, :'event_id'::uuid, NULLIF(:'workspace_id', ''),
          NULLIF(:'task_id', ''), :'session_id'::uuid, :'category',
          jsonb_build_object('text', :'text'), :'text', :'sensitivity',
          'deterministic-v0', 1.0
        )
        ON CONFLICT (source_event_id, extractor_id) DO NOTHING
        RETURNING id
      ), selected_memory AS (
        SELECT id FROM inserted_memory
        UNION ALL
        SELECT id FROM memory_items
        WHERE source_event_id = :'event_id'::uuid AND extractor_id = 'deterministic-v0'
        LIMIT 1
      ), source_insert AS (
        INSERT INTO memory_sources (memory_id, event_id)
        SELECT id, :'event_id'::uuid FROM selected_memory
        ON CONFLICT DO NOTHING
      ), embedding_insert AS (
        INSERT INTO memory_embeddings (memory_id, tenant_id, embedding, provider_id)
        SELECT id, :'tenant_id'::uuid, :'embedding'::vector(8), 'deterministic-v0'
        FROM selected_memory
        ON CONFLICT (memory_id) DO UPDATE SET embedding = EXCLUDED.embedding
      ), job_update AS (
        UPDATE ingestion_jobs
        SET status = 'completed', last_error = NULL, updated_at = now(), locked_at = NULL
        WHERE id = :'job_id'::uuid
      )
      SELECT json_build_object('ok', true)::text;
      `,
      {
        memory_id: memoryId,
        tenant_id: event.tenant_id,
        workspace_id: event.workspace_id ?? '',
        task_id: event.task_id ?? '',
        session_id: event.session_id,
        category,
        text,
        sensitivity: event.sensitivity,
        event_id: event.id,
        embedding,
        job_id: job.id,
      },
    );
  }

  async failIngestion(job, error) {
    const terminal = job.attempts >= 5;
    const delaySeconds = Math.min(60, 2 ** Math.max(0, job.attempts - 1));
    await this.#db.queryJson(
      `
      UPDATE ingestion_jobs
      SET
        status = :'status',
        last_error = left(:'last_error', 500),
        available_at = now() + make_interval(secs => :delay_seconds),
        locked_at = NULL,
        updated_at = now()
      WHERE id = :'job_id'::uuid;
      SELECT json_build_object('ok', true)::text;
      `,
      {
        status: terminal ? 'failed' : 'retry',
        last_error: error.message,
        delay_seconds: delaySeconds,
        job_id: job.id,
      },
    );
  }
}

module.exports = { ContextStore };
