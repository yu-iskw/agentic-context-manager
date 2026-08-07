\set ON_ERROR_STOP on

CREATE TABLE IF NOT EXISTS checkpoints (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('validated', 'rejected')),
  budget_tokens integer NOT NULL CHECK (budget_tokens > 0),
  used_tokens integer NOT NULL CHECK (used_tokens >= 0),
  summary text NOT NULL,
  source_memory_ids jsonb NOT NULL,
  validation jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS checkpoints_session_idx
  ON checkpoints (tenant_id, session_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON checkpoints TO acm_runtime;

ALTER TABLE checkpoints ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON checkpoints;
CREATE POLICY tenant_isolation ON checkpoints
  USING (tenant_id = current_setting('acm.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('acm.tenant_id', true)::uuid);

UPDATE context_architectures
SET spec = jsonb_set(
  spec,
  '{compaction}',
  '{"enabled": true, "strategy": "validated-extractive-v1"}'::jsonb,
  true
)
WHERE name = 'coding-agent-default'
  AND version = 'coding-agent-default-v1';
