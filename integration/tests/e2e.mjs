import assert from 'node:assert/strict';

const baseUrl = process.env.ACM_BASE_URL ?? 'http://127.0.0.1:8080';
const mcpUrl = process.env.ACM_MCP_URL ?? `${baseUrl}/mcp`;

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
  });
  const body = await response.json();
  return { response, body };
}

async function waitForIngestion(ingestionId) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const { response, body } = await jsonRequest(`${baseUrl}/v1/ingestions/${ingestionId}`);
    assert.equal(response.status, 200);
    if (body.status === 'completed') return body;
    if (body.status === 'failed') assert.fail(`ingestion failed: ${body.lastError}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  assert.fail('ingestion did not complete before timeout');
}

async function createSession() {
  const result = await jsonRequest(`${baseUrl}/v1/sessions`, {
    method: 'POST',
    body: JSON.stringify({
      workspace: { externalId: 'github:yu-iskw/agentic-context-manager' },
      task: { externalId: 'integration-test' },
      agent: { name: 'integration-runner' },
    }),
  });
  assert.equal(result.response.status, 201);
  assert.match(result.body.contextHandle, /^[0-9a-f-]{36}$/);
  return result.body;
}

console.log('integration: create session');
const session = await createSession();
const contextHandle = session.contextHandle;

const eventPayload = {
  contextHandle,
  kind: 'decision',
  content: {
    text: 'Decision: PostgreSQL is the durable source of truth and Docker Compose is the normative integration environment.',
  },
  idempotencyKey: 'integration-event-1',
};

console.log('integration: async event acceptance + idempotency');
const firstEvent = await jsonRequest(`${baseUrl}/v1/events`, {
  method: 'POST',
  body: JSON.stringify(eventPayload),
});
assert.equal(firstEvent.response.status, 202);
assert.ok(firstEvent.body.eventId);
assert.ok(firstEvent.body.ingestionId);

const duplicateEvent = await jsonRequest(`${baseUrl}/v1/events`, {
  method: 'POST',
  body: JSON.stringify(eventPayload),
});
assert.equal(duplicateEvent.response.status, 202);
assert.equal(duplicateEvent.body.eventId, firstEvent.body.eventId);
assert.equal(duplicateEvent.body.ingestionId, firstEvent.body.ingestionId);

console.log('integration: read-your-writes overlay before extraction completes');
const immediateRecall = await jsonRequest(`${baseUrl}/v1/context/query`, {
  method: 'POST',
  body: JSON.stringify({
    contextHandle,
    query: 'What is the durable source of truth?',
    budgetTokens: 500,
    includeExplanations: true,
  }),
});
assert.equal(immediateRecall.response.status, 200);
assert.ok(
  immediateRecall.body.items.some(
    (item) => item.category === 'recent-event' && item.text.includes('PostgreSQL'),
  ),
  'pending event should be visible through the recent-event overlay',
);

console.log('integration: worker materializes memory');
await waitForIngestion(firstEvent.body.ingestionId);

console.log('integration: validated checkpoint preserves the decision');
const checkpoint = await jsonRequest(`${baseUrl}/v1/context/checkpoint`, {
  method: 'POST',
  body: JSON.stringify({ contextHandle, budgetTokens: 500 }),
});
assert.equal(checkpoint.response.status, 201);
assert.equal(checkpoint.body.status, 'validated');
assert.equal(checkpoint.body.validation.coverage, 1);
assert.ok(checkpoint.body.sourceMemoryIds.length > 0);
assert.ok(checkpoint.body.summary.includes('[decision]'));
assert.ok(checkpoint.body.summary.includes('PostgreSQL'));
assert.ok(checkpoint.body.usedTokens <= 500);

console.log('integration: idempotency keys are scoped to a session');
const secondSession = await createSession();
const secondEvent = await jsonRequest(`${baseUrl}/v1/events`, {
  method: 'POST',
  body: JSON.stringify({
    ...eventPayload,
    contextHandle: secondSession.contextHandle,
    content: { text: 'A separate session may safely reuse the same idempotency key.' },
  }),
});
assert.equal(secondEvent.response.status, 202);
assert.notEqual(secondEvent.body.eventId, firstEvent.body.eventId);
assert.notEqual(secondEvent.body.ingestionId, firstEvent.body.ingestionId);
await waitForIngestion(secondEvent.body.ingestionId);

const recall = await jsonRequest(`${baseUrl}/v1/context/query`, {
  method: 'POST',
  body: JSON.stringify({
    contextHandle,
    query: 'Which system is the durable source of truth and how are integration tests run?',
    budgetTokens: 500,
    includeExplanations: true,
  }),
});
assert.equal(recall.response.status, 200);
assert.ok(recall.body.usedTokens <= 500);
assert.ok(recall.body.items.some((item) => item.text.includes('PostgreSQL')));
assert.ok(
  recall.body.items.some((item) =>
    item.selectedBecause.some((reason) => reason.includes('authorized')),
  ),
);

console.log('integration: invalid context handle is rejected');
const denied = await jsonRequest(`${baseUrl}/v1/context/query`, {
  method: 'POST',
  body: JSON.stringify({
    contextHandle: '11111111-1111-4111-8111-111111111111',
    query: 'show me context',
  }),
});
assert.equal(denied.response.status, 400);

console.log('integration: MCP tool discovery');
const toolsList = await jsonRequest(mcpUrl, {
  method: 'POST',
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
});
assert.equal(toolsList.response.status, 200);
assert.deepEqual(
  toolsList.body.result.tools.map((tool) => tool.name),
  [
    'acm.session.start',
    'acm.event.record',
    'acm.context.recall',
    'acm.context.checkpoint',
  ],
);

console.log('integration: MCP context recall');
const mcpRecall = await jsonRequest(mcpUrl, {
  method: 'POST',
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'acm.context.recall',
      arguments: {
        contextHandle,
        query: 'What did we decide about Docker Compose?',
        budgetTokens: 500,
      },
    },
  }),
});
assert.equal(mcpRecall.response.status, 200);
assert.equal(mcpRecall.body.result.isError, false);
assert.ok(
  mcpRecall.body.result.structuredContent.items.some((item) =>
    item.text.includes('Docker Compose'),
  ),
);

console.log('integration: MCP validated checkpoint');
const mcpCheckpoint = await jsonRequest(mcpUrl, {
  method: 'POST',
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'acm.context.checkpoint',
      arguments: { contextHandle, budgetTokens: 500 },
    },
  }),
});
assert.equal(mcpCheckpoint.response.status, 200);
assert.equal(mcpCheckpoint.body.result.isError, false);
assert.equal(mcpCheckpoint.body.result.structuredContent.status, 'validated');
assert.equal(mcpCheckpoint.body.result.structuredContent.validation.coverage, 1);

console.log('integration: PASS');
