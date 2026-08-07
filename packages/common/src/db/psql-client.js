const { spawn } = require('node:child_process');

function safeVariableName(name) {
  return /^[a-z][a-z0-9_]*$/u.test(name);
}

class PsqlClient {
  #databaseUrl;
  #applicationName;

  constructor(options) {
    this.#databaseUrl = options.databaseUrl;
    this.#applicationName = options.applicationName;
  }

  async queryJson(query, variables = {}, tenantId) {
    const wrappedQuery = tenantId
      ? `BEGIN; SET LOCAL acm.tenant_id TO :'acm_tenant_id'; ${query}; COMMIT;`
      : query;
    const args = ['-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1'];
    const allVariables = tenantId ? { ...variables, acm_tenant_id: tenantId } : variables;

    for (const [name, value] of Object.entries(allVariables)) {
      if (!safeVariableName(name)) {
        throw new Error(`Unsafe psql variable name: ${name}`);
      }
      if (value !== undefined) {
        args.push('-v', `${name}=${String(value)}`);
      }
    }
    args.push('-c', wrappedQuery, this.#databaseUrl);

    const stdout = await this.#run(args);
    const lines = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const payload = lines.at(-1);
    if (payload === undefined) {
      throw new Error('Database query returned no JSON payload');
    }
    return JSON.parse(payload);
  }

  async ping() {
    await this.queryJson("SELECT json_build_object('ok', true)::text;");
  }

  #run(args) {
    return new Promise((resolve, reject) => {
      const child = spawn('psql', args, {
        env: { ...process.env, PGAPPNAME: this.#applicationName },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.once('error', reject);
      child.once('close', (code) => {
        if (code === 0) {
          resolve(stdout);
          return;
        }
        const diagnostic = stderr.replaceAll(/\s+/gu, ' ').slice(0, 400);
        reject(new Error(`psql exited with code ${String(code)}: ${diagnostic}`));
      });
    });
  }
}

module.exports = { PsqlClient };
