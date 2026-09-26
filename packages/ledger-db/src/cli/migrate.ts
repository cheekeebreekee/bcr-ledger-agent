/**
 * `corepack yarn workspace @bcr/ledger-db migrate [command]` — the operator's
 * tool for the index database, run from a laptop signed in with `az login` as
 * the server's Entra administrator. Wiring only; the logic is ../migrate.ts.
 *
 *   migrate                 apply the pending migrations, then run verify.sql
 *   migrate status          list applied and pending migrations (read-only)
 *   migrate verify          run verify.sql (read-only); exit 1 on any problem
 *   migrate grant-app <login>
 *                           GRANT ledger_app TO <login> WITH INHERIT FALSE, SET TRUE
 *                           (the login of the ingestion managed identity, named
 *                           after the Function App, created first with
 *                           pgaadauth_create_principal)
 *   migrate client-id <listItemId>
 *                           print the index client_id of a Client Directory row
 *                           (no database; needs CLIENT_DIRECTORY_LIST_ID)
 *
 * Environment: LEDGER_DB_HOST (`<server>.postgres.database.azure.com`),
 * LEDGER_DB_NAME (default `ledger`), LEDGER_DB_ADMIN_USER (the administrator's
 * UPN, exactly as the server's Entra administrator is set). The password is
 * an Entra token for the signed-in account, fetched here and never printed.
 * TLS is required and verified.
 */
import { DefaultAzureCredential } from '@azure/identity';
import { Client } from 'pg';
import { clientIdForDirectoryRow } from '../clientScope';
import { LedgerDbError } from '../errors';
import {
  applyMigrations,
  grantAppLogin,
  loadMigrations,
  verifySchema,
  type AdminClient,
} from '../migrate';
import { entraPassword } from '../pool';

const USAGE = `Usage: migrate [status | verify | grant-app <login> | client-id <listItemId>]
Environment: LEDGER_DB_HOST, LEDGER_DB_NAME (default ledger), LEDGER_DB_ADMIN_USER (your UPN);
client-id needs CLIENT_DIRECTORY_LIST_ID instead. Sign in with az login first.`;

function required(name: string): string {
  const value = (process.env[name] ?? '').trim();
  if (!value) throw new LedgerDbError('invalid_record', `${name} is not set`);
  return value;
}

async function connect(): Promise<Client> {
  const host = required('LEDGER_DB_HOST');
  const client = new Client({
    host,
    port: 5432,
    database: (process.env['LEDGER_DB_NAME'] ?? '').trim() || 'ledger',
    user: required('LEDGER_DB_ADMIN_USER'),
    password: entraPassword(new DefaultAzureCredential()),
    ssl: { rejectUnauthorized: true, servername: host, minVersion: 'TLSv1.2' },
    connectionTimeoutMillis: 15_000,
    application_name: 'bcr-ledger-migrate',
  });
  await client.connect();
  return client;
}

async function printVerify(client: AdminClient): Promise<number> {
  const problems = await verifySchema(client);
  if (problems.length === 0) {
    process.stdout.write('verify.sql: no problems\n');
    return 0;
  }
  for (const p of problems) process.stdout.write(`PROBLEM ${p.check}: ${p.object}: ${p.detail}\n`);
  return 1;
}

async function main(argv: readonly string[]): Promise<number> {
  const [command = 'apply', arg] = argv;
  if (command === 'help' || command === '--help' || command === '-h') {
    process.stderr.write(`${USAGE}\n`);
    return 0;
  }
  if (command === 'client-id') {
    if (!arg) throw new LedgerDbError('invalid_record', 'client-id needs a list item id');
    process.stdout.write(`${clientIdForDirectoryRow(required('CLIENT_DIRECTORY_LIST_ID'), arg)}\n`);
    return 0;
  }
  if (!['apply', 'status', 'verify', 'grant-app'].includes(command)) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const migrations = loadMigrations();
  const client = await connect();
  try {
    if (command === 'status') {
      const { rows } = await client
        .query<{ version: string }>('SELECT version FROM ledger_meta.schema_migrations')
        .catch(() => ({ rows: [] as { version: string }[] }));
      const done = new Set(rows.map((r) => r.version));
      for (const m of migrations) {
        process.stdout.write(
          `${done.has(m.version) ? 'applied' : 'PENDING'}  ${m.version}_${m.name}\n`,
        );
      }
      return 0;
    }
    if (command === 'verify') return await printVerify(client);
    if (command === 'grant-app') {
      if (!arg) throw new LedgerDbError('invalid_record', 'grant-app needs the login name');
      await grantAppLogin(client, arg);
      process.stdout.write(`granted ledger_app to ${arg} (INHERIT FALSE, SET TRUE)\n`);
      return await printVerify(client);
    }
    const run = await applyMigrations(client, migrations, (line) =>
      process.stdout.write(`${line}\n`),
    );
    process.stdout.write(
      `applied ${run.applied.length}, already applied ${run.alreadyApplied.length}\n`,
    );
    return await printVerify(client);
  } finally {
    await client.end();
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    // The message only: pg's and the SDK's say what failed without any token.
    process.stderr.write(`migrate: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);
