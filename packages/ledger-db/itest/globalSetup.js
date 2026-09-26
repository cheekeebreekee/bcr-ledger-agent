/**
 * `test:db` setup: a superuser URL for a PostgreSQL 16 server.
 *
 * With LEDGER_TEST_DATABASE_URL set (CI's postgres:16 service container), that
 * server is used. Otherwise a throwaway `postgres:16` container is started
 * with Docker on a random loopback port, with a random password, and
 * globalTeardown.js removes it. Nothing here ever reaches Azure.
 */
const { execFileSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { Client } = require('pg');

async function waitFor(url, timeoutMs) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    const client = new Client({ connectionString: url });
    try {
      await client.connect();
      await client.query('SELECT 1');
      await client.end();
      return;
    } catch (err) {
      last = err;
      await client.end().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`PostgreSQL did not answer within ${timeoutMs} ms: ${last && last.message}`);
}

module.exports = async function globalSetup() {
  if (process.env.LEDGER_TEST_DATABASE_URL) {
    await waitFor(process.env.LEDGER_TEST_DATABASE_URL, 60_000);
    return;
  }
  const password = randomBytes(16).toString('hex');
  const id = execFileSync(
    'docker',
    [
      'run',
      '--detach',
      '--rm',
      '--env',
      `POSTGRES_PASSWORD=${password}`,
      '--publish',
      '127.0.0.1::5432',
      '--label',
      'bcr-ledger-db-itest=1',
      'postgres:16',
    ],
    { encoding: 'utf8' },
  ).trim();
  process.env.LEDGER_TEST_CONTAINER = id;
  const mapping = execFileSync('docker', ['port', id, '5432/tcp'], { encoding: 'utf8' })
    .trim()
    .split('\n')[0];
  const port = mapping.slice(mapping.lastIndexOf(':') + 1);
  process.env.LEDGER_TEST_DATABASE_URL = `postgres://postgres:${password}@127.0.0.1:${port}/postgres`;
  await waitFor(process.env.LEDGER_TEST_DATABASE_URL, 90_000);
};
