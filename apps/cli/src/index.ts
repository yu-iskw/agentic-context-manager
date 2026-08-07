import { PsqlClient } from '../../../packages/db/src/psql.js';

async function main(): Promise<void> {
  const [, , command, subcommandOrUrl] = process.argv;
  if (command === 'db' && subcommandOrUrl === 'migrate') {
    const databaseUrl = process.env.ACM_ADMIN_DATABASE_URL ?? process.env.DATABASE_URL;
    if (databaseUrl === undefined) throw new Error('ACM_ADMIN_DATABASE_URL or DATABASE_URL is required');
    const db = new PsqlClient({ databaseUrl });
    await db.executeFile(`${process.cwd()}/db/migrations/0001_initial.sql`);
    console.log(JSON.stringify({ level: 'info', message: 'database migrations complete' }));
    return;
  }
  if (command === 'healthcheck' && subcommandOrUrl !== undefined) {
    const response = await fetch(subcommandOrUrl);
    if (!response.ok) throw new Error(`healthcheck failed: ${response.status}`);
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
