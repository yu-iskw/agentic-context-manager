import { PsqlClient } from '../../../packages/db/src/psql.js';

const MIGRATIONS = ['0001_initial.sql', '0002_checkpoints.sql'] as const;

async function migrateDatabase(): Promise<void> {
  const databaseUrl = process.env.ACM_ADMIN_DATABASE_URL ?? process.env.DATABASE_URL;
  if (databaseUrl === undefined) {
    throw new Error('ACM_ADMIN_DATABASE_URL or DATABASE_URL is required');
  }
  const db = new PsqlClient({ databaseUrl });
  for (const migration of MIGRATIONS) {
    await db.executeFile(`${process.cwd()}/db/migrations/${migration}`);
  }
  console.log(JSON.stringify({ level: 'info', message: 'database migrations complete' }));
}

async function runHealthcheck(url: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`healthcheck failed: ${response.status}`);
}

async function main(): Promise<void> {
  const [, , command, subcommandOrUrl] = process.argv;
  if (command === 'db' && subcommandOrUrl === 'migrate') {
    await migrateDatabase();
    return;
  }
  if (command === 'healthcheck' && subcommandOrUrl !== undefined) {
    await runHealthcheck(subcommandOrUrl);
    return;
  }
  throw new Error('usage: acm db migrate | acm healthcheck <url>');
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
