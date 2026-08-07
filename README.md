# Agentic Context Manager

Agentic Context Manager (ACM) is a vendor-neutral context lifecycle service for long-running applications and coding agents. It is inspired by the lifecycle model in *Agentic Context Management: Solving Agent Memory and Cost by Treating Them as Lifecycle and Architecture Problems* while defining independently implementable contracts rather than attempting to reproduce undisclosed mechanisms.

## Status

This repository currently implements the **RFC-0001 vertical slice**, not the complete target platform.

Implemented:

- explicit application-owned `contextHandle` sessions;
- immutable raw event ingestion with idempotency keys;
- asynchronous worker processing with durable PostgreSQL job state;
- PostgreSQL row-level tenant isolation;
- provenance from derived memory back to source events;
- pgvector semantic retrieval plus `pg_trgm` lexical retrieval;
- authorization/scope filtering before ranking;
- hard token-budget context packing;
- a recent-event read-your-writes overlay while asynchronous extraction is pending;
- REST endpoints and a minimal stateless MCP JSON-RPC surface;
- a portable Agent Plugin with context-management skills;
- deterministic providers for tests; and
- Docker Compose as the normative local integration-test environment.

Planned after the vertical slice is validated:

- validated compaction/checkpoints;
- architecture lifecycle APIs and evaluation gates;
- anticipation/prefetch;
- production OIDC/OAuth identity and policy enforcement;
- first-party TypeScript/Python SDK middleware;
- full MCP SDK integration and protocol conformance testing;
- native coding-agent hooks/wrappers where lifecycle APIs exist; and
- specialized queue/vector/graph infrastructure only when measurements justify it.

## Architecture

```text
Applications / coding agents
          |
      REST / MCP
          |
       ACM API
       /     \
      /       \
PostgreSQL   read-your-writes overlay
  |   |
  |   +-- pgvector + pg_trgm retrieval
  |
 durable ingestion state
  |
ACM Worker
  |
provider abstraction
  |
derived memory + provenance
```

PostgreSQL is the durable source of truth in the initial architecture. The local implementation intentionally keeps protocol, domain, provider, and database boundaries separate so infrastructure can evolve without changing the public contracts.

## Prerequisites

- Node.js **24.13.0+** (`.node-version` pins the development/CI version)
- pnpm **11.0.5+** via Corepack
- Docker with Docker Compose v2 for integration tests

Enable Corepack and install dependencies:

```bash
corepack enable
pnpm install --frozen-lockfile
```

The repository retains its pnpm supply-chain controls, including a seven-day minimum package release age, exotic transitive dependency blocking, and explicit build-script allowlisting.

## Build and Unit Tests

```bash
pnpm build
pnpm test
pnpm lint
```

## Local Stack

Start PostgreSQL, run the one-shot migration, and launch the API and worker:

```bash
docker compose up --build
```

The development topology binds PostgreSQL and the API to loopback only. Local Compose uses PostgreSQL trust authentication to avoid committing example passwords; **this is development-only and must not be copied into production deployments**.

The API is then available on `http://127.0.0.1:8080`.

### Start a context session

```bash
curl --fail-with-body \
  --request POST \
  --header 'content-type: application/json' \
  --data '{
    "workspace": {"externalId": "github:owner/repository"},
    "task": {"externalId": "issue-123"},
    "agent": {"name": "local-agent"}
  }' \
  http://127.0.0.1:8080/v1/sessions
```

Use the returned `contextHandle` when recording events and querying context.

## Docker Compose Integration Tests

The canonical integration-test command is:

```bash
pnpm test:integration:compose
```

The command builds and starts an isolated stack containing:

```text
PostgreSQL
    |
 one-shot migration
    |
 +----------+
 |          |
API       Worker
 |          |
 +----+-----+
      |
deterministic delayed model stub
      |
integration-test runner
```

The integration suite validates:

- session creation;
- durable asynchronous event acceptance;
- idempotent retries;
- read-your-writes behavior before extraction finishes;
- worker materialization and provenance;
- token-budgeted hybrid recall;
- invalid context-handle rejection;
- MCP tool discovery; and
- MCP recall through the same application service.

The test stack uses a temporary PostgreSQL filesystem and removes host port mappings so it is safe to run independently from the developer stack. GitHub Actions runs the same `pnpm test:integration:compose` command.

## API Surface

Current REST endpoints:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health/live` | Process liveness |
| `GET` | `/health/ready` | Service readiness |
| `POST` | `/v1/sessions` | Start an explicit ACM context |
| `POST` | `/v1/events` | Durably accept an event for asynchronous ingestion |
| `GET` | `/v1/ingestions/:id` | Read ingestion state |
| `POST` | `/v1/context/query` | Build a scoped, budgeted context pack |
| `POST` | `/mcp` | Initial stateless MCP JSON-RPC surface |

Current MCP tools:

- `acm.session.start`
- `acm.event.record`
- `acm.context.recall`

The MCP endpoint is an intentionally small vertical-slice implementation. Full MCP TypeScript SDK integration and compatibility/conformance testing across major clients remain roadmap work.

## Project Structure

```text
apps/
  api/                 HTTP + MCP adapter
  cli/                 migrations and health checks
  worker/              asynchronous ingestion worker
packages/
  contracts/           public request/response contracts
  core/                context ranking and packing logic
  db/                  persistence adapter
  providers/           extraction/embedding provider abstractions
  common/              existing shared-template package
agent-plugin/           portable Agent Plugin assets
db/migrations/          PostgreSQL schema, indexes, and RLS
integration/
  model-stub/           deterministic delayed provider
  tests/                end-to-end Compose tests
compose.yaml             local development topology
compose.integration.yaml isolated integration-test override
```

### Bootstrap database adapter

The first slice uses the PostgreSQL `psql` client behind `packages/db` instead of adding runtime npm dependencies while the repository's frozen pnpm lock remains unchanged. This is a deliberate bootstrap seam, not a target production implementation. A native PostgreSQL driver/queue library can replace it behind the same domain boundary in a follow-up dependency change.

## Security Model of the Vertical Slice

The initial implementation establishes structural controls but is **not production-auth complete**:

- tenant identity is passed into PostgreSQL through a connection-scoped setting;
- RLS applies tenant filtering at the database boundary;
- context handles are validated against the configured principal;
- retrieval filters authorization/scope before ranking;
- raw events remain provenance anchors for derived memory;
- plugin guidance treats recalled content as untrusted historical data; and
- local database authentication is intentionally development-only.

Production deployment requires authenticated principal derivation (OIDC/OAuth or workload identity), credential management, audit policy, retention/deletion controls, and deployment-specific database identities before exposing ACM to untrusted networks.

## License

Apache License 2.0.
