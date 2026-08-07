const { EVENT_KINDS } = require('../contracts.js');
const { HttpError, readJsonBody, requirePrincipal } = require('./http-utils.js');

const PROTOCOL_VERSION = '2026-07-28';
const SERVER_INFO = { name: 'agentic-context-manager', version: '0.1.0' };
const TOOL_DEFINITIONS = [
  {
    name: 'acm.session.start',
    description: 'Create an explicit ACM context handle for a coding task.',
    inputSchema: {
      type: 'object',
      properties: { workspaceId: { type: 'string' }, taskId: { type: 'string' }, agentId: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'acm.event.record',
    description: 'Record a context event for asynchronous durable ingestion.',
    inputSchema: {
      type: 'object',
      required: ['sessionId', 'kind', 'text'],
      properties: {
        sessionId: { type: 'string', format: 'uuid' },
        kind: { type: 'string', enum: EVENT_KINDS },
        text: { type: 'string' },
        idempotencyKey: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'acm.context.recall',
    description: 'Retrieve a scope-aware token-budgeted context pack with provenance.',
    inputSchema: {
      type: 'object',
      required: ['sessionId', 'query'],
      properties: {
        sessionId: { type: 'string', format: 'uuid' },
        query: { type: 'string' },
        tokenBudget: { type: 'integer', minimum: 64, maximum: 32000 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'acm.ingestion.status',
    description: 'Read asynchronous ingestion status.',
    inputSchema: {
      type: 'object',
      required: ['ingestionId'],
      properties: { ingestionId: { type: 'string', format: 'uuid' } },
      additionalProperties: false,
    },
  },
];

function successfulToolResult(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
}

function forbiddenIdentityArguments(args) {
  return 'tenantId' in args || 'principalId' in args || 'tenant_id' in args || 'principal_id' in args;
}

function validateOrigin(request) {
  const origin = request.headers.origin;
  if (origin === undefined) {
    return;
  }
  const configured = (process.env.ACM_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const localOrigin = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/u.test(origin);
  const localAllowed = process.env.ACM_TRUST_LOCAL_IDENTITY === 'true' && localOrigin;
  if (!localAllowed && !configured.includes(origin)) {
    throw new HttpError(403, 'mcp_origin_forbidden', 'Origin is not allowed for the MCP endpoint');
  }
}

function validateTransportHeaders(request, message) {
  const version = request.headers['mcp-protocol-version'];
  const methodHeader = request.headers['mcp-method'];
  const nameHeader = request.headers['mcp-name'];
  if (version !== PROTOCOL_VERSION) {
    throw new HttpError(400, 'mcp_protocol_version', `MCP-Protocol-Version must be ${PROTOCOL_VERSION}`);
  }
  if (methodHeader !== message.method) {
    throw new HttpError(400, 'mcp_method_mismatch', 'Mcp-Method header must match the JSON-RPC method');
  }
  if (message.method === 'tools/call') {
    const bodyName = message.params && typeof message.params === 'object' ? message.params.name : undefined;
    if (typeof bodyName !== 'string' || nameHeader !== bodyName) {
      throw new HttpError(400, 'mcp_name_mismatch', 'Mcp-Name header must match params.name for tools/call');
    }
  }
}

async function handleMcpRequest(request, store) {
  const message = await readJsonBody(request);
  const id = message && typeof message === 'object' ? message.id ?? null : null;
  if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid JSON-RPC request' } };
  }

  validateOrigin(request);
  validateTransportHeaders(request, message);

  if (message.method === 'server/discover') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        resultType: 'complete',
        supportedVersions: [PROTOCOL_VERSION],
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions: 'Use acm.session.start, record durable context, then recall bounded provenance-linked context.',
      },
    };
  }
  if (message.method === 'ping') {
    return { jsonrpc: '2.0', id, result: {} };
  }
  if (message.method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id,
      result: { tools: TOOL_DEFINITIONS, ttlMs: 300000, cacheScope: 'public' },
    };
  }
  if (message.method !== 'tools/call') {
    return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } };
  }

  const principal = requirePrincipal(request);
  const params = message.params && typeof message.params === 'object' ? message.params : {};
  const name = params.name;
  const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
  if (typeof name !== 'string' || forbiddenIdentityArguments(args)) {
    return { jsonrpc: '2.0', id, error: { code: -32602, message: 'Invalid tool parameters' } };
  }

  try {
    if (name === 'acm.session.start') {
      const result = await store.createSession(principal, {
        ...(typeof args.workspaceId === 'string' ? { workspaceId: args.workspaceId } : {}),
        ...(typeof args.taskId === 'string' ? { taskId: args.taskId } : {}),
        ...(typeof args.agentId === 'string' ? { agentId: args.agentId } : {}),
      });
      return { jsonrpc: '2.0', id, result: successfulToolResult(result) };
    }
    if (name === 'acm.event.record') {
      if (
        typeof args.sessionId !== 'string' ||
        typeof args.kind !== 'string' ||
        !EVENT_KINDS.includes(args.kind) ||
        typeof args.text !== 'string'
      ) {
        throw new HttpError(400, 'invalid_tool_arguments', 'sessionId, kind, and text are required');
      }
      const result = await store.recordEvent(
        principal,
        { sessionId: args.sessionId, kind: args.kind, content: { text: args.text } },
        typeof args.idempotencyKey === 'string' ? args.idempotencyKey : undefined,
      );
      return { jsonrpc: '2.0', id, result: successfulToolResult(result) };
    }
    if (name === 'acm.context.recall') {
      if (typeof args.sessionId !== 'string' || typeof args.query !== 'string') {
        throw new HttpError(400, 'invalid_tool_arguments', 'sessionId and query are required');
      }
      const result = await store.retrieveContext(principal, {
        sessionId: args.sessionId,
        query: args.query,
        ...(typeof args.tokenBudget === 'number' ? { tokenBudget: args.tokenBudget } : {}),
      });
      return { jsonrpc: '2.0', id, result: successfulToolResult(result) };
    }
    if (name === 'acm.ingestion.status') {
      if (typeof args.ingestionId !== 'string') {
        throw new HttpError(400, 'invalid_tool_arguments', 'ingestionId is required');
      }
      const result = await store.getIngestionStatus(principal, args.ingestionId);
      return { jsonrpc: '2.0', id, result: successfulToolResult(result ?? null) };
    }
    return { jsonrpc: '2.0', id, error: { code: -32602, message: 'Unknown tool' } };
  } catch (error) {
    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32602, message: error instanceof Error ? error.message : 'Tool invocation failed' },
    };
  }
}

module.exports = { handleMcpRequest, PROTOCOL_VERSION };
