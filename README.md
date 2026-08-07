# Agentic Context Manager

Agentic Context Manager (ACM) is a vendor-neutral context control plane for long-running AI applications and coding agents. It treats memory as a lifecycle: durable ingestion, strict scoping, retrieval/context packing, later anticipation, and validated compaction.

The current implementation is the first RFC-0001 vertical slice: PostgreSQL + pgvector is the only mandatory service, source events remain distinct from derived memories, ingestion is asynchronous, retrieval is tenant/scope aware, and the same core flow is exposed over REST and an MCP tool surface.

## Requirements

- Node.js 24+
- pnpm 11.0.5+
- Docker with Docker Compose for integration tests

## Quality gates

```bash
corepack enable
pnpm install
pnpm build
pnpm test
pnpm lint
pnpm test:integration:compose
```

`pnpm test:integration:compose` is the normative end-to-end gate. It builds the ACM image, starts PostgreSQL 18 + pgvector, runs migrations, starts API and worker processes independently, and executes the hermetic integration suite with no commercial model/API credentials.

## Local stack

```bash
pnpm dev
```

The REST API is available at `http://localhost:8787`; the MCP endpoint is `http://localhost:8787/mcp`.

For local development, identity is provided by trusted headers:

- `X-ACM-Tenant-Id`
- `X-ACM-Principal-Id`

Compose additionally enables an explicit local identity fallback for Agent Plugin clients that cannot inject trusted headers. This mode is local-development-only. Production OIDC authentication is deliberately not implemented yet.

## REST example

```bash
curl -sS http://localhost:8787/v1/sessions \
  -H 'Content-Type: application/json' \
  -H 'X-ACM-Tenant-Id: 11111111-1111-4111-8111-111111111111' \
  -H 'X-ACM-Principal-Id: aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' \
  -d '{"workspaceId":"repo:example/acm","taskId":"issue:1"}'
```

Use the returned session ID to `POST /v1/events`, poll `/v1/ingestions/{id}`, and `POST /v1/context:retrieve`.

## MCP 2026-07-28

The `/mcp` endpoint implements the stateless 2026-07-28 shape used by the vertical slice. Requests must send `MCP-Protocol-Version` and `Mcp-Method`; `tools/call` also sends `Mcp-Name`. The server exposes `server/discover`, `tools/list`, and context lifecycle tools. The temporary wire adapter exists only until the official TypeScript SDK v2 clears this repository's seven-day release-age quarantine.

## Agent Plugin

The portable Agent Plugin source lives under `packages/agent-plugin/` and contains Agent Skills plus a Streamable HTTP MCP configuration for the local endpoint.

## Architecture status

See `docs/architecture/implementation-status.md` for what is implemented and intentionally deferred from RFC-0001.

## Security model

Tenant identity is never accepted as a model-controlled MCP tool argument. PostgreSQL row-level security provides a defense-in-depth tenant boundary for the API role, principal checks protect per-user session state, and the worker runs as a distinct `BYPASSRLS` role. Retrieved memories are untrusted data and must not be promoted to instruction priority by clients.

## License

Apache-2.0.
