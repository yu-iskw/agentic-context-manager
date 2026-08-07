\set ON_ERROR_STOP on

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'acm_runtime') THEN
    CREATE ROLE acm_runtime LOGIN PASSWORD 'acm-runtime-local-only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS tenants (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS principals (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  external_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, external_id)
);

CREATE TABLE IF NOT EXISTS workspaces (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  external_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, external_id)
);

CREATE TABLE IF NOT EXISTS context_architectures (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  version text NOT NULL,
  status text NOT NULL CHECK (status IN ('draft', 'validated', 'evaluated', 'active', 'superseded', 'rejected')),
  spec jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name, version)
);

CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  principal_id uuid NOT NULL REFERENCES principals(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  task_external_id text,
  agent_name text,
  context_handle uuid NOT NULL UNIQUE,
  architecture_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  principal_id uuid NOT NULL REFERENCES principals(id),
  session_id uuid NOT NULL REFERENCES sessions(id),
  kind text NOT NULL,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  content jsonb NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key text,
  content_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS ingestion_status (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  event_id uuid NOT NULL UNIQUE REFERENCES events(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memory_items (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  workspace_id uuid REFERENCES workspaces(id),
  task_external_id text,
  session_id uuid REFERENCES sessions(id),
  category text NOT NULL,
  structured_value jsonb NOT NULL,
  retrieval_text text NOT NULL,
  embedding vector(8) NOT NULL,
  confidence double precision NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  architecture_version text NOT NULL,
  extractor_id text NOT NULL,
  source_event_id uuid NOT NULL REFERENCES events(id),
  status text NOT NULL CHECK (status IN ('active', 'superseded', 'disputed', 'deleted')),
  valid_from timestamptz,
  valid_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_event_id, extractor_id)
);

CREATE TABLE IF NOT EXISTS memory_sources (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  memory_id uuid NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (memory_id, event_id)
);

CREATE TABLE IF NOT EXISTS context_packs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  session_id uuid NOT NULL REFERENCES sessions(id),
  mode text NOT NULL CHECK (mode IN ('fast', 'accurate')),
  query text NOT NULL,
  budget_tokens integer NOT NULL,
  used_tokens integer NOT NULL,
  selected_items jsonb NOT NULL,
  omitted_items integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  principal_id uuid REFERENCES principals(id),
  action text NOT NULL,
  object_type text NOT NULL,
  object_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS events_session_time_idx ON events (tenant_id, session_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS ingestion_pending_idx ON ingestion_status (tenant_id, status, next_attempt_at, created_at);
CREATE INDEX IF NOT EXISTS memory_scope_idx ON memory_items (tenant_id, workspace_id, task_external_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS memory_retrieval_trgm_idx ON memory_items USING gin (retrieval_text gin_trgm_ops);
CREATE INDEX IF NOT EXISTS memory_embedding_hnsw_idx ON memory_items USING hnsw (embedding vector_cosine_ops);

INSERT INTO tenants (id, name)
VALUES ('00000000-0000-4000-8000-000000000001', 'local-development')
ON CONFLICT (id) DO NOTHING;

INSERT INTO principals (id, tenant_id, external_id)
VALUES (
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000001',
  'local-user'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO context_architectures (id, tenant_id, name, version, status, spec)
VALUES (
  '00000000-0000-4000-8000-000000000003',
  '00000000-0000-4000-8000-000000000001',
  'coding-agent-default',
  'coding-agent-default-v1',
  'active',
  '{
    "categories": ["observation", "decision", "requirement", "failed-attempt", "unresolved-question"],
    "retrieval": {"semanticWeight": 0.50, "lexicalWeight": 0.35, "scopeWeight": 0.15},
    "contextPacking": {"defaultBudgetTokens": 6000},
    "compaction": {"enabled": false},
    "anticipation": {"enabled": false}
  }'::jsonb
)
ON CONFLICT (id) DO NOTHING;

GRANT USAGE ON SCHEMA public TO acm_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO acm_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO acm_runtime;

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE principals ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE context_architectures ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingestion_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE context_packs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON tenants;
CREATE POLICY tenant_isolation ON tenants USING (id = current_setting('acm.tenant_id', true)::uuid) WITH CHECK (id = current_setting('acm.tenant_id', true)::uuid);
DROP POLICY IF EXISTS tenant_isolation ON principals;
CREATE POLICY tenant_isolation ON principals USING (tenant_id = current_setting('acm.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('acm.tenant_id', true)::uuid);
DROP POLICY IF EXISTS tenant_isolation ON workspaces;
CREATE POLICY tenant_isolation ON workspaces USING (tenant_id = current_setting('acm.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('acm.tenant_id', true)::uuid);
DROP POLICY IF EXISTS tenant_isolation ON context_architectures;
CREATE POLICY tenant_isolation ON context_architectures USING (tenant_id = current_setting('acm.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('acm.tenant_id', true)::uuid);
DROP POLICY IF EXISTS tenant_isolation ON sessions;
CREATE POLICY tenant_isolation ON sessions USING (tenant_id = current_setting('acm.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('acm.tenant_id', true)::uuid);
DROP POLICY IF EXISTS tenant_isolation ON events;
CREATE POLICY tenant_isolation ON events USING (tenant_id = current_setting('acm.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('acm.tenant_id', true)::uuid);
DROP POLICY IF EXISTS tenant_isolation ON ingestion_status;
CREATE POLICY tenant_isolation ON ingestion_status USING (tenant_id = current_setting('acm.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('acm.tenant_id', true)::uuid);
DROP POLICY IF EXISTS tenant_isolation ON memory_items;
CREATE POLICY tenant_isolation ON memory_items USING (tenant_id = current_setting('acm.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('acm.tenant_id', true)::uuid);
DROP POLICY IF EXISTS tenant_isolation ON memory_sources;
CREATE POLICY tenant_isolation ON memory_sources USING (tenant_id = current_setting('acm.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('acm.tenant_id', true)::uuid);
DROP POLICY IF EXISTS tenant_isolation ON context_packs;
CREATE POLICY tenant_isolation ON context_packs USING (tenant_id = current_setting('acm.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('acm.tenant_id', true)::uuid);
DROP POLICY IF EXISTS tenant_isolation ON audit_events;
CREATE POLICY tenant_isolation ON audit_events USING (tenant_id = current_setting('acm.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('acm.tenant_id', true)::uuid);
