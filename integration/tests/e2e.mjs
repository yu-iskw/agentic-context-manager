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

console.log('integration: create session');
const sessionResult = await jsonRequest(`${baseUrl}/v1/sessions`, {
  method: 'POST',
  body: JSON.stringify({
    workspace: { externalId: 'github:yu-iskw/agentic-context-manager' },
    task: { externalId: 'integration-test' },
    agent: { name: 'integration-runner' },
  }),
});
assert.equal(sessionResult.response.status, 201);
assert.match(sessionResult.body.contextHandle, /^[0-9a-f-]{36}$/);
const contextHandle = sessionResult.body.contextHandle;

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
  immediateRecall.body.items.some((item) => item.category === 'recent-event' && item.text.includes('PostgreSQL')),
  'pending event should be visible through the recent-event overlay',
);

console.log('integration: worker materializes memory');
await waitForIngestion(firstEvent.body.ingestionId);

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
assert.ok(recall.body.items.some((item) => item.selectedBecause.some((reason) => reason.includes('authorized'))));

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
  ['acm.session.start', 'acm.event.record', 'acm.context.recall'],
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
assert.ok(mcpRecall.body.result.structuredContent.items.some((item) => item.text.includes('Docker Compose')));

console.log('integration: PASS');
