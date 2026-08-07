const { createServer } = require('node:http');

const { EVENT_KINDS } = require('../contracts.js');
const { ContextStore } = require('../db/context-store.js');
const { PsqlClient } = require('../db/psql-client.js');
const { HttpError, readJsonBody, requirePrincipal, sendJson } = require('./http-utils.js');
const { handleMcpRequest } = require('./mcp-router.js');

const databaseUrl = process.env.ACM_DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error('ACM_DATABASE_URL is required');
}
const port = Number(process.env.ACM_PORT ?? '8787');
const store = new ContextStore(new PsqlClient({ databaseUrl, applicationName: 'acm-api' }));

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseSessionInput(value) {
  if (!isRecord(value)) {
    throw new HttpError(400, 'invalid_session', 'Request body must be an object');
  }
  return {
    ...(typeof value.workspaceId === 'string' ? { workspaceId: value.workspaceId } : {}),
    ...(typeof value.taskId === 'string' ? { taskId: value.taskId } : {}),
    ...(typeof value.agentId === 'string' ? { agentId: value.agentId } : {}),
    ...(isRecord(value.metadata) ? { metadata: value.metadata } : {}),
  };
}

function parseEventInput(value) {
  if (!isRecord(value) || !isRecord(value.content)) {
    throw new HttpError(400, 'invalid_event', 'sessionId, valid kind, and content.text are required');
  }
  const { kind, sessionId } = value;
  const text = value.content.text;
  if (
    typeof sessionId !== 'string' ||
    typeof kind !== 'string' ||
    !EVENT_KINDS.includes(kind) ||
    typeof text !== 'string' ||
    text.length === 0
  ) {
    throw new HttpError(400, 'invalid_event', 'sessionId, valid kind, and content.text are required');
  }
  return {
    sessionId,
    kind,
    content: { text },
    ...(isRecord(value.metadata) ? { metadata: value.metadata } : {}),
    ...(typeof value.occurredAt === 'string' ? { occurredAt: value.occurredAt } : {}),
  };
}

function parseRecallInput(value) {
  if (!isRecord(value) || typeof value.sessionId !== 'string' || typeof value.query !== 'string' || value.query.length === 0) {
    throw new HttpError(400, 'invalid_recall', 'sessionId and a non-empty query are required');
  }
  return {
    sessionId: value.sessionId,
    query: value.query,
    ...(typeof value.tokenBudget === 'number' ? { tokenBudget: value.tokenBudget } : {}),
    ...(typeof value.limit === 'number' ? { limit: value.limit } : {}),
    ...(value.mode === 'fast' || value.mode === 'accurate' ? { mode: value.mode } : {}),
  };
}

async function route(request, response) {
  const method = request.method ?? 'GET';
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

  if (method === 'GET' && url.pathname === '/health/live') {
    sendJson(response, 200, { status: 'live' });
    return;
  }
  if (method === 'GET' && url.pathname === '/health/ready') {
    await store.ping();
    sendJson(response, 200, { status: 'ready' });
    return;
  }
  if (method === 'POST' && url.pathname === '/v1/sessions') {
    const principal = requirePrincipal(request);
    sendJson(response, 201, await store.createSession(principal, parseSessionInput(await readJsonBody(request))));
    return;
  }
  if (method === 'POST' && url.pathname === '/v1/events') {
    const principal = requirePrincipal(request);
    const body = parseEventInput(await readJsonBody(request));
    const idempotencyKey = request.headers['idempotency-key'];
    const result = await store.recordEvent(
      principal,
      body,
      typeof idempotencyKey === 'string' ? idempotencyKey : undefined,
    );
    sendJson(response, 202, result);
    return;
  }
  if (method === 'POST' && url.pathname === '/v1/context:retrieve') {
    const principal = requirePrincipal(request);
    sendJson(response, 200, await store.retrieveContext(principal, parseRecallInput(await readJsonBody(request))));
    return;
  }
  if (method === 'GET' && url.pathname.startsWith('/v1/ingestions/')) {
    const principal = requirePrincipal(request);
    const ingestionId = url.pathname.slice('/v1/ingestions/'.length);
    const status = await store.getIngestionStatus(principal, ingestionId);
    if (status === undefined) {
      throw new HttpError(404, 'ingestion_not_found', 'Ingestion was not found');
    }
    sendJson(response, 200, status);
    return;
  }
  if (method === 'POST' && url.pathname === '/mcp') {
    sendJson(response, 200, await handleMcpRequest(request, store));
    return;
  }
  throw new HttpError(404, 'not_found', 'Route not found');
}

const server = createServer((request, response) => {
  void route(request, response).catch((error) => {
    const statusCode = error instanceof HttpError ? error.statusCode : 500;
    const code = error instanceof HttpError ? error.code : 'internal_error';
    const message = error instanceof HttpError ? error.message : 'Internal server error';
    if (statusCode >= 500) {
      console.error(JSON.stringify({ level: 'error', code, message: error instanceof Error ? error.message : String(error) }));
    }
    if (!response.headersSent) {
      sendJson(response, statusCode, { error: { code, message } });
    } else {
      response.end();
    }
  });
});

server.listen(port, '0.0.0.0', () => {
  console.log(JSON.stringify({ level: 'info', message: 'ACM API listening', port }));
});

function shutdown(signal) {
  console.log(JSON.stringify({ level: 'info', message: 'Shutting down API', signal }));
  server.close((error) => {
    process.exitCode = error === undefined ? 0 : 1;
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
