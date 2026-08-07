const { setTimeout: sleep } = require('node:timers/promises');

const { ContextStore } = require('../db/context-store.js');
const { PsqlClient } = require('../db/psql-client.js');

const databaseUrl = process.env.ACM_WORKER_DATABASE_URL ?? process.env.ACM_DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error('ACM_WORKER_DATABASE_URL or ACM_DATABASE_URL is required');
}
const pollMs = Number(process.env.ACM_WORKER_POLL_MS ?? '250');
const store = new ContextStore(new PsqlClient({ databaseUrl, applicationName: 'acm-worker' }));
let stopping = false;

async function processOne() {
  const job = await store.claimIngestionJob();
  if (job === undefined) {
    return false;
  }
  try {
    const event = await store.loadEventForIngestion(job.event_id);
    if (event === undefined) {
      throw new Error(`Event ${job.event_id} was not found`);
    }
    await store.completeIngestion(job, event);
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error(String(error));
    await store.failIngestion(job, normalized);
  }
  return true;
}

async function main() {
  await store.ping();
  console.log(JSON.stringify({ level: 'info', message: 'ACM worker started' }));
  while (!stopping) {
    const processed = await processOne();
    if (!processed) {
      await sleep(pollMs);
    }
  }
}

process.on('SIGTERM', () => {
  stopping = true;
});
process.on('SIGINT', () => {
  stopping = true;
});

void main().catch((error) => {
  console.error(JSON.stringify({ level: 'error', message: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
});
