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
const GUARD_ARGS = ['--forbidden-site-paths', '/sites/BCRGROUP'];
const DIR_ARGS = ['--site-id', IDS.dirSite, '--list-id', IDS.list, '--ingest-app-ids', IDS.ingestApp, ...GUARD_ARGS];
/** The same, without the forbidden list. */
const DIR_ONLY = DIR_ARGS.slice(0, -GUARD_ARGS.length);
const HEALTH_URL = 'https://ingest.contoso.example/api/health';
const HEALTH_ARGS = ['--health-url', HEALTH_URL];
const P0_HEALTH = { status: 'ok', build: { phase: 'p0', routing: 'identity-only' } };

/** The operator's shell, as H-7 sets it: the forbidden list comes from there for apply. */
const SHELL_ENV = { GRAPH_TOKEN: TOKEN, FORBIDDEN_TARGET_SITE_PATHS: '/sites/BCRGROUP' };

/**
 * @param {object} [o]
 * @param {(url: string, init: object, next: typeof fetch) => Promise<Response>} [o.intercept]
 *   sees every Graph request before the fake tenant does
 * @param {object} [o.env]  the environment; default SHELL_ENV
 */
function harness({ health = P0_HEALTH, now = NOW, intercept, env = SHELL_ENV } = {}) {
  const tenant = createTenant();
  const out = capture();
  const outDir = mkdtempSync(join(tmpdir(), 'bindings-test-'));
  const healthCalls = [];
  const graphFetch = intercept ? (url, init) => intercept(url, init ?? {}, tenant.fetch) : tenant.fetch;
  const run = (argv, extra = {}) =>
    main(argv, {
      env,
      print: out.print,
      graphFetch,
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

/** A fresh output path in the harness's directory. */
const fresh = (h, name) => join(h.outDir, `${name}-${Math.random().toString(16).slice(2)}.json`);

/** Propose and apply the whole plan with --apply; returns the apply log path. */
async function bind(h, extra = []) {
  if (!h.tenant.state.columns.some((c) => c.name === 'DriveId')) {
    h.tenant.state.columns.push({ name: 'DriveId', text: {} }, { name: 'TeamId', text: {} });
  }
  const { file } = await proposePlan(h, extra);
  const log = fresh(h, 'apply-log');
  assert.equal(await h.run(['apply', '--plan', file, '--apply', ...HEALTH_ARGS, '--out', log]), 0);
  return log;
}

const denied = () => jsonResponse(403, { error: { code: 'accessDenied', message: 'Access denied' } });
const pathOf = (url) => decodeURIComponent(new URL(url).pathname.replace(/^\/v1\.0/, ''));

describe('directory-bindings check', () => {
  test('reports each Active row read-only, and never prints the token', async () => {
    const h = harness();
    // 0: row 2 holds a staff id, but it is unbound, so the ingestion routes nobody there.
    assert.equal(await h.run(['check', ...DIR_ARGS]), 0);
    const text = h.out.text();
    assert.match(text, /not routing \(unbound\): row\(s\) 2 hold staff ids/);
    assert.match(text, /Row 2 · ClientId 0002[\s\S]*not routing \(unbound\)[\s\S]*Row 3/);
    assert.doesNotMatch(text, /ACTION/);
    assert.match(text, /Row 1 · ClientId 0001[\s\S]*ready for propose/);
    assert.match(text, /Row 2 · ClientId 0002[\s\S]*SKIP staff_ids/);
    assert.match(text, /Row 2 · ClientId 0002[\s\S]*WARN team_not_bcr[\s\S]*Row 3/);
    assert.match(text, /verify read-only with GET \/sites\/\{site-id\}\/permissions/);
    assert.doesNotMatch(text, /verify via runbook/);
    assert.match(text, /Row 3[\s\S]*admin_row/);
    assert.match(text, /Row 4[\s\S]*public_team/);
    assert.match(text, new RegExp(`guest_in_other_team — 1 guest\\(s\\) not bound: \\S+ also in ${IDS.teamC}`));
    assert.match(text, /userId .* rows 2, 3/);
    assert.doesNotMatch(text, /Row 5 /);
    assert.ok(!text.includes(TOKEN), 'token printed');
    assert.deepEqual(h.writes(), []);
    const memberOf = h.tenant.calls.filter((c) => c.path.endsWith('/memberOf'));
    assert.ok(memberOf.length > 0);
    for (const c of memberOf) assert.match(c.query.get('$select'), /resourceProvisioningOptions/);
  });

  test('refuses a forbidden-path value that is not a plain site path', async () => {
    const h = harness();
    await assert.rejects(
      h.run(['check', ...DIR_ARGS, '--forbidden-site-paths', 'https://contoso.sharepoint.com/sites/BCRGROUP']),
      /not a \/sites\/<name> or \/teams\/<name> path/,
    );
    await assert.rejects(h.run(['check', ...DIR_ARGS, '--forbidden-site-paths', '/sites/x/../BCRGROUP']), CliError);
  });

  test('refuses to run without the forbidden list, or with a malformed guard value', async () => {
    const withList = harness();
    const { file } = await proposePlan(withList);
    const h = harness({ env: { GRAPH_TOKEN: TOKEN } });
    for (const command of ['check', 'propose']) {
      await assert.rejects(h.run([command, ...DIR_ONLY]), /FORBIDDEN_TARGET_SITE_PATHS \/ --forbidden-site-paths is required/);
    }
    await assert.rejects(h.run(['apply', '--plan', file, ...HEALTH_ARGS]), /--forbidden-site-paths is required/);
    await assert.rejects(h.run(['check', ...DIR_ARGS, '--quarantine-site-path', '/sites/Q/sub']), /--quarantine-site-path/);
    await assert.rejects(h.run(['check', ...DIR_ARGS, '--tenant-host', 'contoso.example']), /--tenant-host/);
    // The environment counts as the flag does.
    assert.equal(await withList.run(['check', ...DIR_ONLY]), 0);
    assert.match(withList.out.text(), /forbidden +\/sites\/bcrgroup/);
    assert.deepEqual([...h.writes(), ...withList.writes()], []);
  });

  test('never binds BCR GROUP, the quarantine or another host, whatever the path list says', async () => {
    const h = harness();
    const client = { Status: 'Active', DriveName: 'Dokumenty', RootFolder: '' };
    h.tenant.state.items.set('6', {
      ...client,
      Title: 'Row on BCR GROUP',
      ClientId: '0006',
      NIP: '0000000006',
      SiteHostname: IDS.host,
      SitePath: '/sites/BCRGROUP',
    });
    h.tenant.state.items.set('7', {
      ...client,
      Title: 'Row on the quarantine',
      ClientId: '0007',
      NIP: '0000000007',
      SiteHostname: IDS.host,
      SitePath: '/sites/QUARANTINE',
    });
    h.tenant.state.items.set('8', {
      ...client,
      Title: 'Row on another host',
      ClientId: '0008',
      NIP: '0000000008',
      SiteHostname: 'fabrikam.sharepoint.com',
      SitePath: '/sites/0008CLIENT',
    });
    // BCR GROUP is not on this list: its site collection is the Directory's.
    const file = join(h.outDir, 'guarded-plan.json');
    const args = [...DIR_ONLY, '--forbidden-site-paths', '/sites/SomethingElse', '--out', file];
    assert.equal(
      await h.run(['propose', ...args, '--quarantine-site-path', '/sites/QUARANTINE', '--tenant-host', IDS.host]),
      0,
    );
    const plan = JSON.parse(readFileSync(file, 'utf8'));
    const byId = Object.fromEntries(plan.rows.map((r) => [r.listItemId, r]));
    for (const id of ['6', '7', '8']) {
      assert.equal(byId[id].action, 'SKIP', id);
      assert.ok(byId[id].reasons.some((r) => r.code === 'forbidden_target'), `${id}: ${JSON.stringify(byId[id].reasons)}`);
    }
    assert.match(byId['6'].reasons.find((r) => r.code === 'forbidden_target').detail, /Client Directory's own site collection/);
    assert.match(byId['8'].reasons.find((r) => r.code === 'forbidden_target').detail, /not contoso\.sharepoint\.com/);
    assert.equal(byId['1'].action, 'PATCH', 'the clean row is unaffected');
    assert.deepEqual(plan.guards, {
      forbiddenSitePaths: ['/sites/quarantine', '/sites/somethingelse'],
      quarantineSitePath: '/sites/quarantine',
      tenantHost: IDS.host,
      directorySiteCollectionId: IDS.dirSite.split(',')[1],
    });
    assert.match(h.out.text(), /site collection \S+ \(the Client Directory's\) is never bound/);
    assert.deepEqual(h.writes(), []);
  });

  test('a bound guest later added to another Team is named, and check exits 3 until the plan is applied', async () => {
    const h = harness();
    h.tenant.state.columns.push({ name: 'DriveId', text: {} }, { name: 'TeamId', text: {} });
    // Row 2's staff id would also count; take it off so only the drift remains.
    h.tenant.state.items.get('2').UserAadObjectIds = IDS.guestB;
    const { file } = await proposePlan(h);
    assert.equal(await h.run(['apply', '--plan', file, '--apply', ...HEALTH_ARGS, '--out', join(h.outDir, 'l.json')]), 0);
    assert.equal(await h.run(['check', ...DIR_ARGS]), 0, 'bound and clean');

    // Onboarding reuses guest A for company C's Team (R46).
    h.tenant.state.members.get(IDS.teamC).push(IDS.guestA);
    const report = join(h.outDir, 'report.json');
    assert.equal(await h.run(['check', ...DIR_ARGS, '--out', report]), 3);
    assert.match(
      h.out.text(),
      new RegExp(`WARN bound_guest_ineligible — 1 id\\(s\\) on the row[\\s\\S]*guest_in_other_team: also in ${IDS.teamC}`),
    );
    assert.deepEqual(JSON.parse(readFileSync(report, 'utf8')).routingDrift, ['1']);
    // The plan takes the guest off row 1.
    const again = await proposePlan(h);
    const r1 = again.plan.rows.find((r) => r.listItemId === '1');
    assert.equal(r1.action, 'PATCH');
    assert.equal(r1.patch.UserAadObjectIds, '');
  });

  test('staff ids on a bound row are drift (exit 3); on an unbound row they route nobody (exit 0)', async () => {
    const h = harness();
    const unboundReport = fresh(h, 'report');
    assert.equal(await h.run(['check', ...DIR_ARGS, '--out', unboundReport]), 0);
    const unbound = JSON.parse(readFileSync(unboundReport, 'utf8'));
    assert.deepEqual(
      [unbound.exitCode, unbound.routingDrift, unbound.incomplete, unbound.notRoutingUnbound],
      [0, [], [], ['2']],
    );

    await bind(h);
    h.tenant.state.items.get('1').UserAadObjectIds = `${IDS.guestA}\n${IDS.staff}`;
    const boundReport = fresh(h, 'report');
    assert.equal(await h.run(['check', ...DIR_ARGS, '--out', boundReport]), 3);
    assert.match(h.out.text(), /ACTION: row\(s\) 1 hold an id that routes there and should not/);
    const bound = JSON.parse(readFileSync(boundReport, 'utf8'));
    assert.deepEqual([bound.exitCode, bound.routingDrift, bound.notRoutingUnbound], [3, ['1'], ['2']]);
  });

  test('exits 4 when a bound row holding user ids could not be fully assessed', async () => {
    const teamSiteOf = (team) => `/groups/${team}/sites/root`;
    const cases = [
      ['site_unresolved', (p) => p === `/sites/${IDS.host}:/sites/0001CLIENTA` && denied()],
      ['no_team', (p) => p === teamSiteOf(IDS.teamA) && denied()],
      [
        'team_lookup_failed',
        // A second Team claims row 1's site as its root site.
        (p) => p === teamSiteOf(IDS.teamC) && jsonResponse(200, { id: IDS.siteA, webUrl: `https://${IDS.host}/sites/0001CLIENTA` }),
      ],
      ['membership_lookup_failed', (p) => p === `/groups/${IDS.teamA}/members` && denied()],
      // Guest "multi" is in Team A but not on row 1: row 1's own guest reads fine.
      ['guest_memberships_unreadable', (p) => p === `/users/${IDS.guestMulti}/memberOf` && denied()],
    ];
    for (const [code, fault] of cases) {
      let failing = false;
      const h = harness({
        intercept: async (url, init, next) => (failing && fault(pathOf(url))) || next(url, init),
      });
      await bind(h);
      assert.equal(await h.run(['check', ...DIR_ARGS]), 0, `${code}: clean before the fault`);
      failing = true;
      const report = fresh(h, 'report');
      assert.equal(await h.run(['check', ...DIR_ARGS, '--out', report]), 4, code);
      const r = JSON.parse(readFileSync(report, 'utf8'));
      assert.deepEqual([r.exitCode, r.routingDrift, r.incomplete], [4, [], ['1']], code);
      assert.ok(r.rows.find((a) => a.listItemId === '1').problems.some((p) => p.code === code), code);
      assert.match(h.out.text(), /ACTION: row\(s\) 1 are bound and hold user ids, but could not be fully assessed/, code);

      // A bound row that holds no ids routes nobody: nothing to assess.
      h.tenant.state.items.get('1').UserAadObjectIds = '';
      assert.equal(await h.run(['check', ...DIR_ARGS]), 0, `${code}: no ids`);
    }
  });

  test('drift on one bound row wins over another that could not be assessed (3, not 4)', async () => {
    let failing = false;
    const h = harness({
      intercept: async (url, init, next) =>
        failing && pathOf(url) === `/groups/${IDS.teamB}/members` ? denied() : next(url, init),
    });
    await bind(h, ['--confirm-remove-staff', '2', '--write-verified', '/sites/0002CLIENTB']);
    h.tenant.state.members.get(IDS.teamC).push(IDS.guestA);
    failing = true;
    const report = fresh(h, 'report');
    assert.equal(await h.run(['check', ...DIR_ARGS, '--out', report]), 3);
    const r = JSON.parse(readFileSync(report, 'utf8'));
    assert.deepEqual([r.exitCode, r.routingDrift, r.incomplete], [3, ['1'], ['2']]);
  });

  test('refuses flags that belong to another command', async () => {
    const h = harness();
    await assert.rejects(h.run(['check', ...DIR_ARGS, '--apply']), CliError);
    await assert.rejects(h.run(['check', ...DIR_ARGS, '--plan', 'x']), /not valid for "check"/);
    await assert.rejects(h.run(['chek']), /unknown command/);
  });

  test('a 403 that stops the whole run says the app registration lacks consent', async () => {
    const h = harness({
      intercept: async (url, init, next) => (pathOf(url) === '/groups' ? denied() : next(url, init)),
    });
    await assert.rejects(h.run(['check', ...DIR_ARGS]), (err) => {
      assert.ok(err instanceof CliError);
      assert.match(err.message, /GET \/groups → 403 accessDenied/);
      assert.match(err.message, /Graph refused this request \(403\)[\s\S]*lacks admin consent/);
      return true;
    });
  });

  test('refuses to run without the directory ids or the token', async () => {
    const h = harness();
    await assert.rejects(h.run(['check']), /not named/);
    await assert.rejects(
      main(['check', ...DIR_ARGS], { env: {}, print: () => {} }),
      /no GRAPH_TOKEN/,
    );
  });

  test('--out never replaces an existing file, and refuses before reading anything', async () => {
    const h = harness();
    const existing = join(h.outDir, 'apply-log-from-history.json');
    writeFileSync(existing, '{"keep":true}\n');
    for (const command of ['check', 'propose']) {
      await assert.rejects(h.run([command, ...DIR_ARGS, '--out', existing]), /exists; choose a new name/, command);
    }
    assert.equal(readFileSync(existing, 'utf8'), '{"keep":true}\n');
    assert.deepEqual(h.tenant.calls, [], 'refused before any Graph read');
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
    // For IR-1 (--bindings-plan): the guests of each Team alone, only where they were read.
    assert.deepEqual(byId['1'].eligibleGuests.map((g) => g.id), [IDS.guestA]);
    assert.deepEqual(byId['4'].eligibleGuests, []);
    assert.equal('eligibleGuests' in byId['3'], false, 'an admin row has no Team to read');
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
    assert.equal(r2.action, 'PATCH', 'a Team without the marker binds its own guest');
    assert.equal(r2.patch.UserAadObjectIds, IDS.guestB);
    assert.equal(r2.patch.TeamId, IDS.teamB);
    assert.ok(r2.warnings.some((w) => w.code === 'team_not_bcr'));
    assert.deepEqual(r2.removedUserIds.map((u) => [u.id, u.reason]), [[IDS.staff, 'staff']]);
  });

  test('shows a guest who is also in another Team as not bound, with that Team', async () => {
    const h = harness();
    const { plan } = await proposePlan(h);
    const r1 = plan.rows.find((r) => r.listItemId === '1');
    assert.equal(r1.patch.UserAadObjectIds, IDS.guestA);
    assert.deepEqual(
      r1.excludedGuests.map((e) => [e.id, e.reason, e.otherTeams.map((t) => t.id)]),
      [[IDS.guestMulti, 'guest_in_other_team', [IDS.teamC]]],
    );
    assert.match(h.out.text(), new RegExp(`not bound .*guest_in_other_team: also in ${IDS.teamC}`));
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
    // A value the old build also reports does not stand in for the marker.
    await assert.rejects(
      h.run(['apply', '--plan', file, '--apply', ...HEALTH_ARGS, '--expect-health', 'status=ok']),
      /build\.routing=identity-only \(got nothing\)/,
    );
    assert.deepEqual(h.writes(), []);
    assert.equal(h.healthCalls[0].init.headers.Authorization, undefined, 'health got the token');
  });

  test('the routing marker is required even when other expectations hold, and only over https', async () => {
    const h = harness({ health: { status: 'ok', build: { phase: 'p0' } } });
    h.tenant.state.columns.push({ name: 'DriveId', text: {} }, { name: 'TeamId', text: {} });
    const { file } = await proposePlan(h);
    await assert.rejects(
      h.run(['apply', '--plan', file, '--apply', ...HEALTH_ARGS, '--expect-health', 'build.phase=p0']),
      /does not show the P0 build/,
    );
    const p0 = harness();
    p0.tenant.state.columns.push({ name: 'DriveId', text: {} }, { name: 'TeamId', text: {} });
    const plan2 = await proposePlan(p0);
    await assert.rejects(
      p0.run(['apply', '--plan', plan2.file, '--apply', '--health-url', 'http://localhost:7071/api/health']),
      /must be https/,
    );
    assert.deepEqual([...h.writes(), ...p0.writes()], []);
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

    // A plan too old to apply is not revived by a new date, and its guards
    // and directory are covered as well as its rows.
    const late = new Date(NOW.getTime() + 73 * 3_600_000);
    for (const [name, change] of [
      ['createdAt', (p) => (p.createdAt = late.toISOString())],
      ['guards', (p) => (p.guards.forbiddenSitePaths = [])],
      ['directory', (p) => (p.directory.listId = 'another-list')],
    ]) {
      const copy2 = structuredClone(plan);
      change(copy2);
      const f = join(h.outDir, `edited-${name}.json`);
      writeFileSync(f, JSON.stringify(copy2));
      await assert.rejects(
        h.run(['apply', '--plan', f, '--apply', ...HEALTH_ARGS], { now: late }),
        /digest does not match/,
        name,
      );
    }

    const later = new Date(NOW.getTime() + 73 * 3_600_000);
    await assert.rejects(
      h.run(['apply', '--plan', file, '--apply', ...HEALTH_ARGS], { now: later }),
      /the limit is 72 h[\s\S]*Re-run propose/,
    );
    const shorter = new Date(NOW.getTime() + 25 * 3_600_000);
    await assert.rejects(
      h.run(['apply', '--plan', file, '--apply', ...HEALTH_ARGS, '--max-plan-age-hours', '24'], { now: shorter }),
      /the limit is 24 h/,
    );
    // 72 h is a hard cap: no flag widens it.
    await assert.rejects(
      h.run(['apply', '--plan', file, ...HEALTH_ARGS, '--max-plan-age-hours', '100']),
      /at most 72/,
    );

    h.tenant.state.items.get('1').SitePath = '/sites/SomewhereElse';
    const logFile = join(h.outDir, 'stale-log.json');
    assert.equal(await h.run(['apply', '--plan', file, '--apply', ...HEALTH_ARGS, '--out', logFile]), 2);
    assert.deepEqual(h.writes().filter((c) => c.method === 'PATCH'), []);
    const log = JSON.parse(readFileSync(logFile, 'utf8'));
    assert.equal(log.rows[0].result, 'stale');
    assert.deepEqual(log.rows[0].staleFields, ['SitePath']);
  });

  test('re-reads every guest the row will route: a second Team, a lost Team or a changed userType refuses it', async () => {
    for (const [name, change, want] of [
      ['added to a second Team', (t) => t.state.members.get(IDS.teamC).push(IDS.guestA), `also in Team\\(s\\) ${IDS.teamC}`],
      [
        'removed from the Team',
        (t) => t.state.members.set(IDS.teamA, t.state.members.get(IDS.teamA).filter((id) => id !== IDS.guestA)),
        "no longer in the row's Team",
      ],
      ['now a Member', (t) => (t.state.users.get(IDS.guestA).userType = 'Member'), 'is a Member'],
      ['deleted', (t) => t.state.users.delete(IDS.guestA), 'no longer exists'],
    ]) {
      const h = harness();
      h.tenant.state.columns.push({ name: 'DriveId', text: {} }, { name: 'TeamId', text: {} });
      const { file } = await proposePlan(h);
      change(h.tenant);
      const logFile = join(h.outDir, 'apply-log.json');
      assert.equal(await h.run(['apply', '--plan', file, '--apply', ...HEALTH_ARGS, '--out', logFile]), 2, name);
      assert.deepEqual(h.writes().filter((c) => c.method === 'PATCH'), [], `${name}: written`);
      const [row] = JSON.parse(readFileSync(logFile, 'utf8')).rows;
      assert.equal(row.result, 'stale', name);
      assert.match(row.staleReasons.join(' | '), new RegExp(want), name);
    }
  });

  test('checks each row again against the guards it is given, whatever propose was given', async () => {
    const h = harness();
    h.tenant.state.columns.push({ name: 'DriveId', text: {} }, { name: 'TeamId', text: {} });
    const { file } = await proposePlan(h);
    const logFile = join(h.outDir, 'apply-log.json');
    const args = ['apply', '--plan', file, '--apply', ...HEALTH_ARGS, '--out', logFile];
    assert.equal(await h.run([...args, '--quarantine-site-path', '/sites/0001CLIENTA']), 2);
    assert.deepEqual(h.writes().filter((c) => c.method === 'PATCH'), []);
    const [row] = JSON.parse(readFileSync(logFile, 'utf8')).rows;
    assert.equal(row.result, 'forbidden_target');
    assert.match(row.forbiddenReasons.join(' '), /forbidden target/);

    // The site behind SitePath changed since propose: stale, not written.
    h.tenant.state.sites.get('/sites/0001CLIENTA').id = IDS.siteC;
    const log2 = join(h.outDir, 'apply-log-2.json');
    assert.equal(await h.run(['apply', '--plan', file, '--apply', ...HEALTH_ARGS, '--out', log2]), 2);
    assert.match(JSON.parse(readFileSync(log2, 'utf8')).rows[0].staleReasons[0], /now resolves to site/);
    assert.deepEqual(h.writes().filter((c) => c.method === 'PATCH'), []);
  });

  test('--only that leaves out a row taking ids off says to apply the whole plan', async () => {
    const h = harness();
    h.tenant.state.columns.push({ name: 'DriveId', text: {} }, { name: 'TeamId', text: {} });
    // Row 2's staff id comes off once confirmed and verified: a removal.
    const { file } = await proposePlan(h, ['--confirm-remove-staff', '2', '--write-verified', '/sites/0002CLIENTB']);
    assert.equal(await h.run(['apply', '--plan', file, ...HEALTH_ARGS, '--only', '1']), 0);
    assert.match(h.out.text(), /--only leaves out PATCH row\(s\) 2, which take user ids off a row/);
  });

  test('the log never replaces an existing file, and leaves no temporary file behind', async () => {
    const h = harness();
    h.tenant.state.columns.push({ name: 'DriveId', text: {} }, { name: 'TeamId', text: {} });
    const { file, plan } = await proposePlan(h);
    await assert.rejects(
      h.run(['apply', '--plan', file, '--apply', ...HEALTH_ARGS, '--out', file]),
      /exists; choose a new name/,
    );
    assert.deepEqual(h.writes().filter((c) => c.method === 'PATCH'), [], 'refused before any write');
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), plan, 'the plan is intact');

    const logFile = join(h.outDir, 'apply-log.json');
    assert.equal(await h.run(['apply', '--plan', file, '--apply', ...HEALTH_ARGS, '--out', logFile]), 0);
    assert.deepEqual(readdirSync(h.outDir).filter((n) => n.includes('.tmp-')), []);
    await assert.rejects(h.run(['rollback', '--log', logFile, '--apply', '--out', logFile]), /exists/);
    assert.equal(JSON.parse(readFileSync(logFile, 'utf8')).kind, 'bcr.directory-bindings.apply-log');
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

  test('the log on disk names the row, with its before-state, before its PATCH is sent', async () => {
    let logFile;
    let onDisk;
    const h = harness({
      intercept: async (url, init, next) => {
        if (init.method === 'PATCH') onDisk = JSON.parse(readFileSync(logFile, 'utf8'));
        return next(url, init);
      },
    });
    h.tenant.state.columns.push({ name: 'DriveId', text: {} }, { name: 'TeamId', text: {} });
    const { file } = await proposePlan(h);
    logFile = join(h.outDir, 'apply-log.json');
    assert.equal(await h.run(['apply', '--plan', file, '--apply', ...HEALTH_ARGS, '--out', logFile]), 0);
    assert.equal(onDisk.rows.length, 1);
    assert.equal(onDisk.rows[0].listItemId, '1');
    assert.equal(onDisk.rows[0].result, 'writing');
    assert.equal(onDisk.rows[0].before.RootFolder, '');
    assert.equal(JSON.parse(readFileSync(logFile, 'utf8')).rows[0].result, 'patched');
  });

  test('a PATCH with an unknown outcome is rolled back only if it landed', async () => {
    let patchMode = 'normal';
    const h = harness({
      intercept: async (url, init, next) => {
        if (init.method === 'PATCH' && patchMode === 'lost-response') {
          await next(url, init);
          throw new TypeError('fetch failed');
        }
        if (init.method === 'PATCH' && patchMode === 'never-sent') throw new TypeError('fetch failed');
        return next(url, init);
      },
    });
    h.tenant.state.columns.push({ name: 'DriveId', text: {} }, { name: 'TeamId', text: {} });

    // The write landed but its answer was lost: rollback restores it.
    patchMode = 'lost-response';
    const landed = await proposePlan(h);
    const log1 = join(h.outDir, 'apply-lost.json');
    assert.equal(await h.run(['apply', '--plan', landed.file, '--apply', ...HEALTH_ARGS, '--out', log1]), 2);
    assert.equal(JSON.parse(readFileSync(log1, 'utf8')).rows[0].result, 'write_unknown');
    assert.equal(h.tenant.state.items.get('1').RootFolder, 'Dokumenty księgowe');
    patchMode = 'normal';
    const rb1 = join(h.outDir, 'rb-lost.json');
    assert.equal(await h.run(['rollback', '--log', log1, '--apply', '--out', rb1]), 0);
    assert.equal(JSON.parse(readFileSync(rb1, 'utf8')).rows[0].result, 'restored');
    assert.equal(h.tenant.state.items.get('1').RootFolder, '');

    // The write never reached the list: rollback leaves the row alone.
    patchMode = 'never-sent';
    const unsent = await proposePlan(h);
    const log2 = join(h.outDir, 'apply-unsent.json');
    assert.equal(await h.run(['apply', '--plan', unsent.file, '--apply', ...HEALTH_ARGS, '--out', log2]), 2);
    patchMode = 'normal';
    const before = h.writes().length;
    const rb2 = join(h.outDir, 'rb-unsent.json');
    assert.equal(await h.run(['rollback', '--log', log2, '--apply', '--out', rb2]), 0);
    assert.equal(JSON.parse(readFileSync(rb2, 'utf8')).rows[0].result, 'not_written');
    assert.equal(h.writes().length, before, 'nothing to restore, nothing written');

    // A run killed mid-PATCH leaves `writing`; rollback treats it the same way.
    const killed = JSON.parse(readFileSync(log1, 'utf8'));
    killed.rows[0].result = 'writing';
    const log3 = join(h.outDir, 'apply-killed.json');
    writeFileSync(log3, JSON.stringify(killed));
    assert.equal(await h.run(['rollback', '--log', log3]), 0);
    assert.match(h.out.text(), /not written.*the row still holds its before-state/);
  });

  test('refuses a dry-run log', async () => {
    const h = harness();
    const f = join(h.outDir, 'not-a-log.json');
    writeFileSync(f, JSON.stringify({ kind: 'bcr.directory-bindings.apply-log', mode: 'dry-run', rows: [] }));
    await assert.rejects(h.run(['rollback', '--log', f, '--apply']), /not an apply log/);
  });

  test('never puts back a guest who is now in another Team, and restores them once they qualify again', async () => {
    const h = harness();
    await bind(h);
    // R46: guest A joins company C's Team; the whole plan takes them off row 1.
    h.tenant.state.members.get(IDS.teamC).push(IDS.guestA);
    const removal = await bind(h);
    assert.equal(h.tenant.state.items.get('1').UserAadObjectIds, '');
    const patches = () => h.writes().filter((c) => c.method === 'PATCH').length;
    const before = patches();

    assert.equal(await h.run(['rollback', '--log', removal]), 2, 'the dry run refuses too');
    const rb = fresh(h, 'rollback-log');
    assert.equal(await h.run(['rollback', '--log', removal, '--apply', '--out', rb]), 2);
    assert.equal(patches(), before, 'nothing written');
    assert.equal(h.tenant.state.items.get('1').UserAadObjectIds, '', 'guest A routes to client A again');
    const [row] = JSON.parse(readFileSync(rb, 'utf8')).rows;
    assert.equal(row.result, 'guest_recheck_failed');
    assert.deepEqual(row.readdedUserIds, [IDS.guestA]);
    assert.match(row.recheckReasons.join(' | '), new RegExp(`${IDS.guestA} is also in Team\\(s\\) ${IDS.teamC}`));
    assert.match(h.out.text(), /refused.*it would put back id\(s\) that must not route here/);

    // Guest A leaves Team C: a guest of Team A alone again, so the restore may add them.
    h.tenant.state.members.set(IDS.teamC, h.tenant.state.members.get(IDS.teamC).filter((id) => id !== IDS.guestA));
    const rb2 = fresh(h, 'rollback-log');
    assert.equal(await h.run(['rollback', '--log', removal, '--apply', '--out', rb2]), 0);
    assert.equal(h.tenant.state.items.get('1').UserAadObjectIds, IDS.guestA);
    const [row2] = JSON.parse(readFileSync(rb2, 'utf8')).rows;
    assert.deepEqual([row2.result, row2.readdedUserIds], ['restored', [IDS.guestA]]);
  });

  test('never puts back a staff id, and --only limits the rollback to the rows named', async () => {
    const h = harness();
    // Row 2's staff id comes off as confirmed; row 1 is bound from nothing.
    const log = await bind(h, ['--confirm-remove-staff', '2', '--write-verified', '/sites/0002CLIENTB']);
    assert.equal(h.tenant.state.items.get('2').UserAadObjectIds, IDS.guestB);
    const patchedItems = () => h.writes().filter((c) => c.method === 'PATCH').map((c) => c.path.match(/items\/(\d+)/)[1]);
    const before = patchedItems().length;

    await assert.rejects(h.run(['rollback', '--log', log, '--only', '9']), /--only 9: the log records no write/);

    // Row 1's restore adds no id: it is restored, and row 2 is not touched.
    const rb1 = fresh(h, 'rollback-log');
    assert.equal(await h.run(['rollback', '--log', log, '--only', '1', '--apply', '--out', rb1]), 0);
    assert.deepEqual(patchedItems().slice(before), ['1']);
    assert.equal(h.tenant.state.items.get('1').TeamId, '');
    assert.equal(h.tenant.state.items.get('2').TeamId, IDS.teamB, 'row 2 still bound');
    const out1 = JSON.parse(readFileSync(rb1, 'utf8'));
    assert.deepEqual(out1.only, ['1']);
    assert.deepEqual(out1.rows.map((r) => [r.listItemId, r.result]), [['1', 'restored']]);

    // Row 2's restore would put the staff (Member) id back: refused.
    const rb2 = fresh(h, 'rollback-log');
    assert.equal(await h.run(['rollback', '--log', log, '--only', '2', '--apply', '--out', rb2]), 2);
    assert.deepEqual(patchedItems().slice(before), ['1'], 'row 2 not written');
    const [row2] = JSON.parse(readFileSync(rb2, 'utf8')).rows;
    assert.equal(row2.result, 'guest_recheck_failed');
    assert.match(row2.recheckReasons.join(' | '), new RegExp(`${IDS.staff} is a Member`));
    assert.equal(h.tenant.state.items.get('2').UserAadObjectIds, IDS.guestB);
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
