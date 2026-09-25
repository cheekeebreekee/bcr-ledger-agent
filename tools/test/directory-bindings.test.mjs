import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { main } from '../directory-bindings.mjs';
import { CliError } from '../lib/cli.mjs';
import { validatePlan } from '../lib/bindings.mjs';
import { capture, fakeJwt, jsonResponse } from './fake-graph.mjs';
import { IDS, createTenant } from './tenant-fixture.mjs';

const NOW = new Date('2026-09-25T10:00:00Z');
const TOKEN = fakeJwt({ upn: 'operator@contoso.example', scp: 'Sites.Read.All', exp: 1_900_000_000 });
const DIR_ARGS = ['--site-id', IDS.dirSite, '--list-id', IDS.list, '--ingest-app-ids', IDS.ingestApp];
const HEALTH_ARGS = ['--health-url', 'https://ingest.contoso.example/api/health', '--expect-health', 'build.phase=p0'];

function harness({ health = { status: 'ok', build: { phase: 'p0' } }, now = NOW } = {}) {
  const tenant = createTenant();
  const out = capture();
  const outDir = mkdtempSync(join(tmpdir(), 'bindings-test-'));
  const healthCalls = [];
  const run = (argv, extra = {}) =>
    main(argv, {
      env: { GRAPH_TOKEN: TOKEN },
      print: out.print,
      graphFetch: tenant.fetch,
      healthFetch: async (url, init) => {
        healthCalls.push({ url, init });
        return jsonResponse(200, health);
      },
      sleep: async () => {},
      now: () => extra.now ?? now,
      outDir,
    });
  const writes = () => tenant.calls.filter((c) => c.method !== 'GET');
  return { tenant, out, outDir, run, writes, healthCalls };
}

async function proposePlan(h, extra = []) {
  const file = join(h.outDir, `plan-${Math.random().toString(16).slice(2)}.json`);
  assert.equal(await h.run(['propose', ...DIR_ARGS, '--out', file, ...extra]), 0);
  return { file, plan: JSON.parse(readFileSync(file, 'utf8')) };
}

describe('directory-bindings check', () => {
  test('reports each Active row read-only, and never prints the token', async () => {
    const h = harness();
    assert.equal(await h.run(['check', ...DIR_ARGS]), 0);
    const text = h.out.text();
    assert.match(text, /Row 1 · ClientId 0001[\s\S]*ready for propose/);
    assert.match(text, /Row 2 · ClientId 0002[\s\S]*SKIP staff_ids/);
    assert.match(text, /unknown, verify via runbook/);
    assert.match(text, /Row 3[\s\S]*admin_row/);
    assert.match(text, /Row 4[\s\S]*public_team/);
    assert.match(text, /guest_in_several_bcr_teams/);
    assert.match(text, /userId .* rows 2, 3/);
    assert.doesNotMatch(text, /Row 5 /);
    assert.ok(!text.includes(TOKEN), 'token printed');
    assert.deepEqual(h.writes(), []);
  });

  test('refuses flags that belong to another command', async () => {
    const h = harness();
    await assert.rejects(h.run(['check', ...DIR_ARGS, '--apply']), CliError);
    await assert.rejects(h.run(['check', ...DIR_ARGS, '--plan', 'x']), /not valid for "check"/);
    await assert.rejects(h.run(['chek']), /unknown command/);
  });

  test('refuses to run without the directory ids or the token', async () => {
    const h = harness();
    await assert.rejects(h.run(['check']), /not named/);
    await assert.rejects(
      main(['check', ...DIR_ARGS], { env: {}, print: () => {} }),
      /no GRAPH_TOKEN/,
    );
  });
});

describe('directory-bindings propose', () => {
  test('writes a reviewable plan: PATCH for the clean row, SKIP with reasons for the rest', async () => {
    const h = harness();
    const { plan } = await proposePlan(h);
    assert.deepEqual(validatePlan(plan), []);
    const byId = Object.fromEntries(plan.rows.map((r) => [r.listItemId, r]));
    assert.equal(byId['1'].action, 'PATCH');
    assert.deepEqual(byId['1'].patch, {
      RootFolder: 'Dokumenty księgowe',
      UserAadObjectIds: IDS.guestA,
      DriveId: IDS.driveA,
      TeamId: IDS.teamA,
    });
    assert.equal(byId['2'].action, 'SKIP');
    assert.deepEqual(
      byId['2'].reasons.map((r) => r.code).sort(),
      ['staff_ids', 'write_grant_unknown'],
    );
    assert.ok(byId['3'].reasons.some((r) => r.code === 'admin_row'));
    assert.ok(byId['4'].reasons.some((r) => r.code === 'public_team'));
    assert.equal(byId['5'], undefined);
    assert.deepEqual(h.writes(), [], 'propose must not write to Graph');
  });

  test('removes staff only for a confirmed row, and binds its guest once the grant is verified', async () => {
    const h = harness();
    const { plan } = await proposePlan(h, [
      '--confirm-remove-staff',
      '2',
      '--write-verified',
      '/sites/0002CLIENTB',
    ]);
    const r2 = plan.rows.find((r) => r.listItemId === '2');
    assert.equal(r2.action, 'PATCH');
    assert.equal(r2.patch.UserAadObjectIds, IDS.guestB);
    assert.deepEqual(r2.removedUserIds.map((u) => [u.id, u.reason]), [[IDS.staff, 'staff']]);
  });
});

describe('directory-bindings apply', () => {
  test('needs the new columns, then dry-runs without writing', async () => {
    const h = harness();
    const { file } = await proposePlan(h);
    await assert.rejects(h.run(['apply', '--plan', file]), /--add-columns --apply/);

    assert.equal(await h.run(['--add-columns', '--site-id', IDS.dirSite, '--list-id', IDS.list]), 0);
    assert.deepEqual(h.writes(), [], 'add-columns without --apply must not write');
    assert.equal(await h.run(['--add-columns', '--site-id', IDS.dirSite, '--list-id', IDS.list, '--apply']), 0);
    assert.deepEqual(
      h.writes().map((c) => [c.method, c.body.name]),
      [
        ['POST', 'DriveId'],
        ['POST', 'TeamId'],
      ],
    );
    assert.equal(await h.run(['--add-columns', '--site-id', IDS.dirSite, '--list-id', IDS.list, '--apply']), 0);
    assert.equal(h.writes().length, 2, 'second run is idempotent');

    const before = h.writes().length;
    assert.equal(await h.run(['apply', '--plan', file]), 0);
    assert.equal(h.writes().length, before, 'dry run wrote');
    assert.match(h.out.text(), /Dry run\. Re-run with --apply/);
  });

  test('refuses --apply without the P0 health gate, or when health shows another build', async () => {
    const h = harness({ health: { status: 'ok', service: 'document-ingestion' } });
    h.tenant.state.columns.push({ name: 'DriveId', text: {} }, { name: 'TeamId', text: {} });
    const { file } = await proposePlan(h);
    await assert.rejects(h.run(['apply', '--plan', file, '--apply']), /--health-url/);
    await assert.rejects(h.run(['apply', '--plan', file, '--apply', ...HEALTH_ARGS]), /does not show the P0 build/);
    assert.deepEqual(h.writes(), []);
    assert.equal(h.healthCalls[0].init.headers.Authorization, undefined, 'health got the token');
  });

  test('applies the reviewed rows, reads them back and logs before and after', async () => {
    const h = harness();
    h.tenant.state.columns.push({ name: 'DriveId', text: {} }, { name: 'TeamId', text: {} });
    const { file } = await proposePlan(h);
    const logFile = join(h.outDir, 'apply-log.json');
    assert.equal(await h.run(['apply', '--plan', file, '--apply', ...HEALTH_ARGS, '--out', logFile]), 0);

    const patches = h.writes().filter((c) => c.method === 'PATCH');
    assert.equal(patches.length, 1, 'only the PATCH row is written');
    assert.match(patches[0].path, /\/items\/1\/fields$/);
    assert.deepEqual(Object.keys(patches[0].body).sort(), ['DriveId', 'RootFolder', 'TeamId', 'UserAadObjectIds']);
    assert.equal(h.tenant.state.items.get('1').RootFolder, 'Dokumenty księgowe');
    assert.equal(h.tenant.state.items.get('2').UserAadObjectIds, `${IDS.staff}\n${IDS.guestB}`, 'SKIP row touched');

    const log = JSON.parse(readFileSync(logFile, 'utf8'));
    assert.equal(log.mode, 'apply');
    assert.equal(log.rows[0].result, 'patched');
    assert.equal(log.rows[0].before.RootFolder, '');
    assert.equal(log.rows[0].after.RootFolder, 'Dokumenty księgowe');
    assert.equal(log.rows[0].after.UserAadObjectIds, IDS.guestA);
    assert.ok(!readFileSync(logFile, 'utf8').includes(TOKEN));
  });

  test('refuses a SKIP row asked for by --only, a stale row, an edited plan and an old plan', async () => {
    const h = harness();
    h.tenant.state.columns.push({ name: 'DriveId', text: {} }, { name: 'TeamId', text: {} });
    const { file, plan } = await proposePlan(h);

    await assert.rejects(h.run(['apply', '--plan', file, '--only', '2', '--apply', ...HEALTH_ARGS]), /SKIP/);

    const edited = join(h.outDir, 'edited.json');
    const copy = structuredClone(plan);
    copy.rows[0].patch.UserAadObjectIds = IDS.staff;
    writeFileSync(edited, JSON.stringify(copy));
    await assert.rejects(h.run(['apply', '--plan', edited, '--apply', ...HEALTH_ARGS]), /digest/);

    const later = new Date(NOW.getTime() + 25 * 3_600_000);
    await assert.rejects(
      h.run(['apply', '--plan', file, '--apply', ...HEALTH_ARGS], { now: later }),
      /Re-run propose/,
    );

    h.tenant.state.items.get('1').SitePath = '/sites/SomewhereElse';
    const logFile = join(h.outDir, 'stale-log.json');
    assert.equal(await h.run(['apply', '--plan', file, '--apply', ...HEALTH_ARGS, '--out', logFile]), 2);
    assert.deepEqual(h.writes().filter((c) => c.method === 'PATCH'), []);
    const log = JSON.parse(readFileSync(logFile, 'utf8'));
    assert.equal(log.rows[0].result, 'stale');
    assert.deepEqual(log.rows[0].staleFields, ['SitePath']);
  });
});

describe('directory-bindings rollback', () => {
  test('restores the before-state, and refuses a row changed since the apply', async () => {
    const h = harness();
    h.tenant.state.columns.push({ name: 'DriveId', text: {} }, { name: 'TeamId', text: {} });
    const { file } = await proposePlan(h);
    const logFile = join(h.outDir, 'apply-log.json');
    await h.run(['apply', '--plan', file, '--apply', ...HEALTH_ARGS, '--out', logFile]);
    const applied = h.writes().length;

    assert.equal(await h.run(['rollback', '--log', logFile]), 0);
    assert.equal(h.writes().length, applied, 'rollback dry run wrote');

    const rbLog = join(h.outDir, 'rollback-log.json');
    assert.equal(await h.run(['rollback', '--log', logFile, '--apply', '--out', rbLog]), 0);
    const restore = h.writes().at(-1);
    assert.deepEqual(restore.body, { RootFolder: '', UserAadObjectIds: '', DriveId: '', TeamId: '' });
    assert.equal(h.tenant.state.items.get('1').RootFolder, '');
    assert.equal(JSON.parse(readFileSync(rbLog, 'utf8')).rows[0].result, 'restored');

    // Re-apply, then have someone edit the row: rollback must not clobber it.
    const again = await proposePlan(h);
    const log2 = join(h.outDir, 'apply-log-2.json');
    await h.run(['apply', '--plan', again.file, '--apply', ...HEALTH_ARGS, '--out', log2]);
    h.tenant.state.items.get('1').RootFolder = 'Edited by a person';
    const before = h.writes().length;
    assert.equal(await h.run(['rollback', '--log', log2, '--apply', '--out', join(h.outDir, 'rb2.json')]), 2);
    assert.equal(h.writes().length, before);
    assert.match(h.out.text(), /changed since the apply: RootFolder/);
  });

  test('refuses a dry-run log', async () => {
    const h = harness();
    const f = join(h.outDir, 'not-a-log.json');
    writeFileSync(f, JSON.stringify({ kind: 'bcr.directory-bindings.apply-log', mode: 'dry-run', rows: [] }));
    await assert.rejects(h.run(['rollback', '--log', f, '--apply']), /not an apply log/);
  });
});

test('output files are private to the owner', async () => {
  const h = harness();
  await proposePlan(h);
  for (const name of readdirSync(h.outDir)) {
    const { mode } = await import('node:fs').then((fs) => fs.statSync(join(h.outDir, name)));
    assert.equal(mode & 0o077, 0, `${name} is readable by others`);
  }
});
