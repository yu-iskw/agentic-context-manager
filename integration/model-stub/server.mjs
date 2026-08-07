import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

const host = process.env.MODEL_STUB_HOST ?? '127.0.0.1';
const port = Number(process.env.MODEL_STUB_PORT ?? '9090');
const extractionDelayMs = Number(process.env.MODEL_STUB_DELAY_MS ?? '0');

function embedding(text) {
  const digest = createHash('sha256').update(text.trim().toLowerCase()).digest();
  const values = Array.from({ length: 8 }, (_, index) => digest[index] / 127.5 - 1);
  const norm = Math.sqrt(values.reduce((total, value) => total + value * value, 0)) || 1;
  return values.map((value) => value / norm);
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (
    content &&
    typeof content === 'object' &&
    !Array.isArray(content) &&
    typeof content.text === 'string'
  ) {
    return content.text;
  }
  return JSON.stringify(content);
}

async function readJson(request) {
  let body = '';
  for await (const chunk of request) body += chunk.toString();
  return body === '' ? {} : JSON.parse(body);
}

function json(response, status, value) {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(value));
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && request.url === '/health') {
      json(response, 200, { status: 'ok' });
      return;
    }
    if (request.method === 'POST' && request.url === '/embed') {
      const body = await readJson(request);
      json(response, 200, { vectors: body.input.map(embedding) });
      return;
    }
    if (request.method === 'POST' && request.url === '/extract') {
      const body = await readJson(request);
      if (extractionDelayMs > 0) await sleep(extractionDelayMs);
      const text = textFromContent(body.content).trim();
      json(response, 200, {
        memories:
          text === ''
            ? []
            : [
                {
                  category: 'observation',
                  retrievalText: text,
                  structuredValue: { text },
                  confidence: 1,
                  extractorId: 'http-test-stub-v1',
                },
              ],
      });
      return;
    }
    json(response, 404, { error: 'not_found' });
  } catch (error) {
    json(response, 500, { error: error instanceof Error ? error.message : String(error) });
  }
}).listen(port, host, () => {
  console.log(JSON.stringify({ level: 'info', message: 'model stub listening', host, port }));
});
