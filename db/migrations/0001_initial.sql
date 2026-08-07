\set ON_ERROR_STOP on

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS tenants (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS principals (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  external_subject text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, external_subject)
);

CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  principal_id uuid NOT NULL REFERENCES principals(id),
  workspace_id text,
  task_id text,
  agent_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  principal_id uuid NOT NULL REFERENCES principals(id),
  session_id uuid NOT NULL REFERENCES sessions(id),
  workspace_id text,
  task_id text,
  kind text NOT NULL,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  content jsonb NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key text,
  sensitivity text NOT NULL DEFAULT 'internal',
  content_hash text GENERATED ALWAYS AS (encode(digest(content::text, 'sha256'), 'hex')) STORED
);
CREATE UNIQUE INDEX IF NOT EXISTS events_tenant_idempotency_key_idx
  ON events (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS events_session_received_idx ON events (session_id, received_at DESC);

CREATE TABLE IF NOT EXISTS ingestion_jobs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  event_id uuid NOT NULL UNIQUE REFERENCES events(id),
  status text NOT NULL CHECK (status IN ('queued', 'processing', 'completed', 'retry', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ingestion_jobs_claim_idx ON ingestion_jobs (status, available_at, created_at);

CREATE TABLE IF NOT EXISTS memory_items (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  source_event_id uuid NOT NULL REFERENCES events(id),
  workspace_id text,
  task_id text,
  session_id uuid REFERENCES sessions(id),
  category text NOT NULL,
  structured_value jsonb NOT NULL,
  retrieval_text text NOT NULL,
  sensitivity text NOT NULL DEFAULT 'internal',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'disputed', 'deleted')),
  extractor_id text NOT NULL,
  confidence double precision NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_event_id, extractor_id)
);
CREATE INDEX IF NOT EXISTS memory_items_trgm_idx ON memory_items USING gin (retrieval_text gin_trgm_ops);
CREATE INDEX IF NOT EXISTS memory_items_scope_idx ON memory_items (tenant_id, workspace_id, task_id, session_id);

CREATE TABLE IF NOT EXISTS memory_sources (
  memory_id uuid NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
  event_id uuid NOT NULL REFERENCES events(id),
  PRIMARY KEY (memory_id, event_id)
);

CREATE TABLE IF NOT EXISTS memory_embeddings (
  memory_id uuid PRIMARY KEY REFERENCES memory_items(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  embedding vector(8) NOT NULL,
  provider_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS memory_embeddings_hnsw_idx
  ON memory_embeddings USING hnsw (embedding vector_cosine_ops);

CREATE TABLE IF NOT EXISTS context_packs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  session_id uuid NOT NULL REFERENCES sessions(id),
  query text NOT NULL,
  mode text NOT NULL,
  token_budget integer NOT NULL,
  tokens_used integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS context_pack_items (
  context_pack_id uuid NOT NULL REFERENCES context_packs(id) ON DELETE CASCADE,
  ordinal integer NOT NULL,
  memory_id uuid REFERENCES memory_items(id),
  event_id uuid REFERENCES events(id),
  score double precision NOT NULL,
  reason jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (context_pack_id, ordinal),
  CHECK ((memory_id IS NOT NULL) <> (event_id IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  principal_id uuid,
  action text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE principals ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingestion_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_embeddings ENABLE ROW LEVEL SECURITY;
ALTER TABLE context_packs ENABLE ROW LEVEL SECURITY;
ALTER TABLE context_pack_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;

ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
ALTER TABLE principals FORCE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE events FORCE ROW LEVEL SECURITY;
ALTER TABLE ingestion_jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE memory_items FORCE ROW LEVEL SECURITY;
ALTER TABLE memory_sources FORCE ROW LEVEL SECURITY;
ALTER TABLE memory_embeddings FORCE ROW LEVEL SECURITY;
ALTER TABLE context_packs FORCE ROW LEVEL SECURITY;
ALTER TABLE context_pack_items FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON tenants;
CREATE POLICY tenant_isolation ON tenants
  USING (id = current_setting('acm.tenant_id', true)::uuid)
  WITH CHECK (id = current_setting('acm.tenant_id', true)::uuid);

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['principals','sessions','events','ingestion_jobs','memory_items','memory_embeddings','context_packs','audit_events']
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_setting(''acm.tenant_id'', true)::uuid) WITH CHECK (tenant_id = current_setting(''acm.tenant_id'', true)::uuid)',
      table_name
    );
  END LOOP;
END
$$;

DROP POLICY IF EXISTS tenant_isolation ON memory_sources;
CREATE POLICY tenant_isolation ON memory_sources USING (
  EXISTS (
    SELECT 1 FROM memory_items m
    WHERE m.id = memory_sources.memory_id
      AND m.tenant_id = current_setting('acm.tenant_id', true)::uuid
  )
);

DROP POLICY IF EXISTS tenant_isolation ON context_pack_items;
CREATE POLICY tenant_isolation ON context_pack_items USING (
  EXISTS (
    SELECT 1 FROM context_packs p
    WHERE p.id = context_pack_items.context_pack_id
      AND p.tenant_id = current_setting('acm.tenant_id', true)::uuid
  )
);

GRANT USAGE ON SCHEMA public TO acm_runtime, acm_worker;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO acm_runtime, acm_worker;
GRANT DELETE ON memory_sources, memory_embeddings, context_pack_items TO acm_worker;
