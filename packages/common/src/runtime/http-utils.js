const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

class HttpError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

function requirePrincipal(request) {
  let tenantId = request.headers['x-acm-tenant-id'];
  let principalId = request.headers['x-acm-principal-id'];

  if (
    (typeof tenantId !== 'string' || typeof principalId !== 'string') &&
    process.env.ACM_TRUST_LOCAL_IDENTITY === 'true'
  ) {
    tenantId = process.env.ACM_LOCAL_TENANT_ID;
    principalId = process.env.ACM_LOCAL_PRINCIPAL_ID;
  }

  if (typeof tenantId !== 'string' || typeof principalId !== 'string') {
    throw new HttpError(401, 'identity_required', 'Trusted tenant and principal identity is required');
  }
  if (!UUID_PATTERN.test(tenantId) || !UUID_PATTERN.test(principalId)) {
    throw new HttpError(400, 'identity_invalid', 'Tenant and principal identifiers must be UUIDs');
  }
  return { tenantId, principalId };
}

async function readJsonBody(request, maxBytes = 1_048_576) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes) {
      throw new HttpError(413, 'request_too_large', 'Request body exceeds the configured limit');
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) {
    return {};
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid_json', 'Request body must be valid JSON');
  }
}

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

module.exports = { HttpError, readJsonBody, requirePrincipal, sendJson };
