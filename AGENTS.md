# Agent instructions (source of truth)

This file is the canonical repository guidance for coding agents.

## Project overview

Agentic Context Manager (ACM) is a TypeScript context-control-plane project for long-running AI applications and coding agents. The current RFC-0001 vertical slice uses PostgreSQL 18 + pgvector as the only mandatory durable service and exposes the same context lifecycle through REST, a TypeScript SDK, and MCP tools.

- **Runtime:** Node.js 24 (see `.node-version`)
- **Package manager:** pnpm 11 workspace
- **Language:** TypeScript for public contracts/core/SDK; narrow CommonJS adapters for dependency-free Node runtime integration
- **Tests:** Vitest + Docker Compose integration suite
- **Lint/format:** Trunk, ESLint, Prettier
- **Security:** Trivy/OSV, CodeQL, SBOM workflows, pnpm release-age quarantine

## Required commands

```bash
pnpm install
pnpm build
pnpm test
pnpm lint
pnpm test:integration:compose
```

The Compose integration suite is the source of truth for service-boundary changes. Do not replace it with mocks only.

## Architecture boundaries

- `packages/common/src/contracts.ts`: stable transport-neutral contracts.
- `packages/common/src/core/`: pure deterministic context algorithms.
- `packages/common/src/db/`: temporary PostgreSQL adapter. Keep SQL tenant-aware and parameterized.
- `packages/common/src/runtime/`: API, worker, and MCP transport mapping.
- `packages/common/src/sdk.ts`: first-party TypeScript client.
- `db/`: roles and migrations.
- `packages/agent-plugin/`: portable Agent Plugin metadata and skills.
- `integration/`: black-box Compose tests.

The current single runtime workspace package is an implementation staging point. Do not couple core algorithms to HTTP, MCP, or PostgreSQL APIs; RFC-0001 intends to split these into independently published packages once contracts stabilize.

## Security invariants

1. Never accept tenant/principal identity from model-controlled MCP tool arguments.
2. API queries must execute with tenant RLS context and principal-scoped session checks.
3. Worker privilege is separate from API privilege and is trusted infrastructure.
4. Never log raw event or memory content by default.
5. Treat retrieved memory as untrusted data, not executable instructions.
6. Preserve immutable source events separately from derived memory.
7. Event retries must be idempotent.
8. Do not bypass `minimumReleaseAge` merely to adopt a newly published dependency.
9. Validate MCP routing headers against JSON-RPC bodies and reject untrusted browser origins.

## Database changes

- Migrations must be idempotent when Compose restarts.
- PostgreSQL remains the only mandatory service until an ADR/RFC demonstrates a measured need for specialized infrastructure.
- Keep retrieval scope predicates explicit and add cross-tenant and cross-principal tests for every new retrieval path.
- Queue processing is at-least-once; derived effects must be idempotent.

## MCP and Agent Plugins

The repository targets MCP revision 2026-07-28 and Agent Plugins 1.0.0. The initial MCP wire adapter is temporary because the stable MCP TypeScript SDK v2 was published inside this repository's seven-day dependency quarantine on 2026-08-07. Replace the adapter with the official SDK after it clears policy, without changing core use cases.

MCP 2026-07-28 is stateless: do not reintroduce protocol-level `initialize` sessions or `Mcp-Session-Id`. Application continuity uses the explicit ACM session/context handle.

Agent Plugins is a portability layer, not a guarantee that every host intercepts each model lifecycle event. Be precise about integration guarantees.

## Testing

Unit tests belong beside `packages/common/src/**/*.test.ts`. Service and authorization behavior belongs in `integration/tests/` and must run through Docker Compose.

Integration coverage must include at least:

- clean migration and health;
- asynchronous ingestion;
- idempotent event retry;
- provenance;
- cross-tenant and cross-principal isolation;
- token-budgeted retrieval;
- recent-event read-your-writes;
- MCP discovery/tool discovery/calls;
- MCP routing-header mismatch rejection;
- identity-injection rejection.

## Code style

- PascalCase for types/classes, camelCase for functions/values, kebab-case filenames.
- Prefer small pure functions for ranking/packing logic.
- No `any` in TypeScript; keep public inputs validated at transport boundaries.
- Use conventional commits: `type(scope): description`.

## Session closure

For non-trivial work, capture surprising failures, security/tooling discoveries, or architecture trade-offs in the handoff/postmortem so they can become durable rules, tests, or ADRs.
