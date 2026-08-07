\set ON_ERROR_STOP on

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'acm_runtime') THEN
    CREATE ROLE acm_runtime LOGIN PASSWORD 'acm_runtime_dev';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'acm_worker') THEN
    CREATE ROLE acm_worker LOGIN PASSWORD 'acm_worker_dev' BYPASSRLS;
  END IF;
END
$$;

GRANT CONNECT ON DATABASE acm TO acm_runtime, acm_worker;
