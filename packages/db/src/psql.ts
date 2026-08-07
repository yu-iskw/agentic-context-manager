import { spawn } from 'node:child_process';

interface PsqlClientOptions {
  databaseUrl: string;
  tenantId?: string;
}

function encodedText(value: string): string {
  const encoded = Buffer.from(value, 'utf8').toString('base64');
  return `convert_from(decode('${encoded}', 'base64'), 'utf8')`;
}

export function sqlText(value: string): string {
  return encodedText(value);
}

export function sqlNullableText(value: string | undefined | null): string {
  return value === undefined || value === null ? 'NULL' : encodedText(value);
}

export function sqlJson(value: unknown): string {
  return `${encodedText(JSON.stringify(value))}::jsonb`;
}

export function sqlUuid(value: string): string {
  return `${encodedText(value)}::uuid`;
}

export function sqlTimestamp(value: string): string {
  return `${encodedText(value)}::timestamptz`;
}

export function sqlNumber(value: number): string {
  if (!Number.isFinite(value)) throw new Error('SQL number must be finite');
  return String(value);
}

export function sqlVector(values: readonly number[]): string {
  if (values.length === 0 || values.some((value) => !Number.isFinite(value))) {
    throw new Error('vector must contain finite numbers');
  }
  return `'[${values.map((value) => value.toFixed(8)).join(',')}]'::vector`;
}

async function runPsql(
  databaseUrl: string,
  sql: string,
  tenantId?: string,
  filePath?: string,
): Promise<string> {
  const args = ['--dbname', databaseUrl, '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'];
  if (filePath === undefined) args.push('-c', sql);
  else args.push('-f', filePath);

  const env: Record<string, string | undefined> = { ...process.env };
  if (tenantId !== undefined) env.PGOPTIONS = `-c acm.tenant_id=${tenantId}`;

  return new Promise<string>((resolve, reject) => {
    // `psql` is a fixed executable and dynamic SQL scalars are encoded by the helpers above.
    const child = spawn('psql', args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`psql failed with code ${String(code)}: ${stderr.trim()}`));
    });
  });
}

export class PsqlClient {
  readonly #databaseUrl: string;
  readonly #tenantId: string | undefined;

  constructor(options: PsqlClientOptions) {
    this.#databaseUrl = options.databaseUrl;
    this.#tenantId = options.tenantId;
  }

  async rows<T>(selectSql: string): Promise<T[]> {
    const wrapped = `SELECT COALESCE(json_agg(row_to_json(acm_row)), '[]'::json)::text FROM (${selectSql}) AS acm_row`;
    const output = await runPsql(this.#databaseUrl, wrapped, this.#tenantId);
    const value = output.trim();
    if (value === '') return [];
    return JSON.parse(value) as T[];
  }

  async execute(sql: string): Promise<void> {
    await runPsql(this.#databaseUrl, sql, this.#tenantId);
  }

  async executeFile(path: string): Promise<void> {
    await runPsql(this.#databaseUrl, '', this.#tenantId, path);
  }
}
