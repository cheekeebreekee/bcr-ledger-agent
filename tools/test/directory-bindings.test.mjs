import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { main } from '../directory-bindings.mjs';
import { CliError } from '../lib/cli.mjs';
import { planDigest, validatePlan } from '../lib/bindings.mjs';
import { capture, fakeJwt, jsonResponse } from './fake-graph.mjs';
import { CLIENT_DOMAIN, IDS, createTenant } from './tenant-fixture.mjs';

const NOW = new Date('2026-09-25T10:00:00Z');
const TOKEN = fakeJwt({ upn: 'operator@contoso.example', scp: 'Sites.Read.All', exp: 1_900_000_000 });
const GUARD_ARGS = ['--forbidden-site-paths', '/sites/BCRGROUP'];
/** Without the forbidden list. The fixture's client accounts are `<NIP>@contoso.example`. */
const DIR_ONLY = [
  '--site-id', IDS.dirSite,
  '--list-id', IDS.list,
  '--ingest-app-ids', IDS.ingestApp,
  '--client-domain', CLIENT_DOMAIN,
];
const DIR_ARGS = [...DIR_ONLY, ...GUARD_ARGS];
const UPN_A = `0000000001@${CLIENT_DOMAIN}`;
const UPN_B = `0000000002@${CLIENT_DOMAIN}`;
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
    // 0: row 2 holds a staff id and a guest id, but it is unbound, so the ingestion routes nobody there.
    assert.equal(await h.run(['check', ...DIR_ARGS]), 0);
    const text = h.out.text();
    assert.match(text, /accounts +<the row's 10-digit NIP>@contoso\.example, a Member in the row's Team alone/);
    assert.match(text, /not routing \(unbound\): row\(s\) 2 hold ids that are not the row's client account/);
    assert.match(text, /Row 2 · ClientId 0002[\s\S]*not routing \(unbound\)[\s\S]*Row 3/);
    assert.doesNotMatch(text, /ACTION/);
    assert.match(text, /Row 1 · ClientId 0001[\s\S]*ready for propose/);
    assert.match(text, new RegExp(`Row 1 · [\\s\\S]*account +${UPN_A} \\S+ · enabled · \\S*eligible`));
    // Every guest of Team A, the one invited with client A's own address included, is not bound.
    assert.match(text, /not bound\S* 0000000001_contoso\.example#EXT#@contoso\.onmicrosoft\.com \(guest\)/);
    assert.match(text, /not bound\S* guest\.a_example\.com#EXT#@contoso\.onmicrosoft\.com \(guest\)/);
    assert.match(text, /Row 2 · ClientId 0002[\s\S]*SKIP staff_ids[\s\S]*WARN guest_ids[\s\S]*Row 3/);
    assert.match(text, /Row 2 · ClientId 0002[\s\S]*WARN team_not_bcr[\s\S]*Row 3/);
    assert.match(text, /Row 2 · [\s\S]*GUEST \(no capability; the PATCH removes it\)[\s\S]*Row 3/);
    assert.match(text, /verify read-only with GET \/sites\/\{site-id\}\/permissions/);
    assert.doesNotMatch(text, /verify via runbook/);
    assert.match(text, /Row 3[\s\S]*admin_row/);
    assert.match(text, /Row 4[\s\S]*public_team/);
    assert.match(text, /userId .* rows 2, 3/);
    assert.doesNotMatch(text, /Row 5 /);
    assert.ok(!text.includes(TOKEN), 'token printed');
    assert.deepEqual(h.writes(), []);
    // Memberships are read for the client accounts only, never for a guest.
    const memberOf = h.tenant.calls.filter((c) => c.path.endsWith('/memberOf'));
    assert.deepEqual(
      [...new Set(memberOf.map((c) => c.path.split('/')[2]))].sort(),
      [IDS.clientA, IDS.clientB, IDS.clientC].sort(),
    );
    for (const c of memberOf) assert.match(c.query.get('$select'), /resourceProvisioningOptions/);
    // Each client row's account is read by the UPN its NIP names.
    const byUpn = h.tenant.calls.filter((c) => /^\/users\/\d{10}@/.test(c.path)).map((c) => c.path);
    assert.deepEqual([...new Set(byUpn)].sort(), ['0000000001', '0000000002', '0000000003'].map((n) => `/users/${n}@${CLIENT_DOMAIN}`));
  });

  test('--client-domain is validated before any Graph call, and only where it belongs', async () => {
    const h = harness();
    for (const bad of ['contoso.example/x', '@contoso.example', 'https://contoso.example', 'contoso', '']) {
      for (const command of ['check', 'propose']) {
        await assert.rejects(h.run([command, ...DIR_ARGS, '--client-domain', bad]), /--client-domain: not a host name/, bad);
      }
    }
    await assert.rejects(h.run(['rollback', '--log', 'x.json', '--client-domain', CLIENT_DOMAIN]), /not valid for "rollback"/);
    assert.deepEqual(h.tenant.calls, [], 'refused before any Graph read');
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

  test('a bound client account later added to another Team is named, and check exits 3 until the plan is applied', async () => {
    const h = harness();
    h.tenant.state.columns.push({ name: 'DriveId', text: {} }, { name: 'TeamId', text: {} });
    // Row 2's staff id would also count; take it off so only the drift remains.
    h.tenant.state.items.get('2').UserAadObjectIds = IDS.guestB;
    const { file } = await proposePlan(h);
    assert.equal(await h.run(['apply', '--plan', file, '--apply', ...HEALTH_ARGS, '--out', join(h.outDir, 'l.json')]), 0);
    assert.equal(h.tenant.state.items.get('1').UserAadObjectIds, IDS.clientA);
    assert.equal(await h.run(['check', ...DIR_ARGS]), 0, 'bound and clean');

    // Client A's account is added to company C's Team (R46 by another route).
    h.tenant.state.members.get(IDS.teamC).push(IDS.clientA);
    const report = join(h.outDir, 'report.json');
    assert.equal(await h.run(['check', ...DIR_ARGS, '--out', report]), 3);
    assert.match(
      h.out.text(),
      new RegExp(
        `WARN client_account_ineligible — 1 client account id\\(s\\) on the row[\\s\\S]*` +
          `${UPN_A} \\(client_account_in_other_team: also in ${IDS.teamC}`,
      ),
    );
    assert.match(h.out.text(), new RegExp(`WARN client_account_in_other_team — ${UPN_A} is also in ${IDS.teamC}`));
    assert.deepEqual(JSON.parse(readFileSync(report, 'utf8')).routingDrift, ['1']);
    // The plan takes the account off row 1.
    const again = await proposePlan(h);
    const r1 = again.plan.rows.find((r) => r.listItemId === '1');
    assert.equal(r1.action, 'PATCH');
    assert.equal(r1.patch.UserAadObjectIds, '');
    assert.deepEqual(r1.removedUserIds.map((u) => [u.id, u.reason]), [[IDS.clientA, 'client_account_ineligible']]);
    assert.equal(r1.clientAccount, null);
  });

  test('a guest id on a bound row is drift (exit 3), and the whole plan removes it without a flag', async () => {
    const h = harness();
    await bind(h);
    h.tenant.state.items.get('1').UserAadObjectIds = `${IDS.clientA}\n${IDS.guestA}`;
    const report = fresh(h, 'report');
    assert.equal(await h.run(['check', ...DIR_ARGS, '--out', report]), 3);
    assert.match(h.out.text(), /WARN guest_ids — 1 guest id\(s\) on a client row/);
    assert.deepEqual(JSON.parse(readFileSync(report, 'utf8')).routingDrift, ['1']);
    const { plan } = await proposePlan(h);
    const r1 = plan.rows.find((r) => r.listItemId === '1');
    assert.equal(r1.action, 'PATCH');
    assert.equal(r1.patch.UserAadObjectIds, IDS.clientA);
    assert.deepEqual(r1.removedUserIds.map((u) => [u.id, u.reason]), [[IDS.guestA, 'guest']]);
  });

  test('exits 5 when a bound client account is disabled, and never unbinds it', async () => {
    const h = harness();
    await bind(h);
    h.tenant.state.users.get(IDS.clientA).accountEnabled = false;
    const report = fresh(h, 'report');
    assert.equal(await h.run(['check', ...DIR_ARGS, '--out', report]), 5);
    const text = h.out.text();
    assert.match(text, /WARN client_account_disabled/);
    assert.match(text, /CLIENT LOCKED OUT: row\(s\) 1 are bound to a client account that is disabled/);
    assert.match(text, /never block, disable, unlicense or convert a client account/);
    const r = JSON.parse(readFileSync(report, 'utf8'));
    assert.deepEqual([r.exitCode, r.lockedOut, r.routingDrift, r.incomplete], [5, ['1'], [], []]);
    // propose keeps it bound: a NOOP, with the warning.
    const { plan } = await proposePlan(h);
    const r1 = plan.rows.find((x) => x.listItemId === '1');
    assert.equal(r1.action, 'NOOP');
    assert.ok(r1.warnings.some((w) => w.code === 'client_account_disabled'));
    assert.equal(r1.clientAccount.accountEnabled, false);
    // Drift elsewhere still wins (3 over 5).
    h.tenant.state.items.get('1').UserAadObjectIds = `${IDS.clientA}\n${IDS.staff}`;
    assert.equal(await h.run(['check', ...DIR_ARGS]), 3);
    assert.deepEqual(h.writes().filter((c) => c.method === 'PATCH').length, 1, 'only the bind wrote');
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
    h.tenant.state.items.get('1').UserAadObjectIds = `${IDS.clientA}\n${IDS.staff}`;
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
      ['client_account_lookup_failed', (p) => p === `/users/${UPN_A}` && denied()],
      // Client A's own memberships: whether it is in Team A alone is unknown.
      ['client_account_memberships_unreadable', (p) => p === `/users/${IDS.clientA}/memberOf` && denied()],
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
    h.tenant.state.members.get(IDS.teamC).push(IDS.clientA);
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
    assert.equal(plan.version, 2);
    assert.equal(plan.clientDomain, CLIENT_DOMAIN);
    assert.equal(byId['1'].action, 'PATCH');
    assert.deepEqual(byId['1'].patch, {
      RootFolder: 'Dokumenty księgowe',
      UserAadObjectIds: IDS.clientA,
      DriveId: IDS.driveA,
      TeamId: IDS.teamA,
    });
    assert.equal(byId['2'].action, 'SKIP');
    assert.deepEqual(
      byId['2'].reasons.map((r) => r.code).sort(),
      ['staff_ids', 'write_grant_unknown'],
    );
    assert.ok(byId['2'].warnings.some((w) => w.code === 'guest_ids'));
    assert.ok(byId['3'].reasons.some((r) => r.code === 'admin_row'));
    assert.ok(byId['4'].reasons.some((r) => r.code === 'public_team'));
    assert.equal(byId['5'], undefined);
    // For IR-1 (--bindings-plan): each row's client account, only where it was assessed.
    assert.deepEqual(byId['1'].clientAccount, { id: IDS.clientA, userPrincipalName: UPN_A, accountEnabled: true });
    assert.equal(byId['4'].clientAccount.id, IDS.clientC, 'assessed, though the row is SKIP');
    assert.equal('clientAccount' in byId['3'], false, 'an admin row has no Team to read');
    for (const r of plan.rows) assert.equal('eligibleGuests' in r || 'excludedGuests' in r, false);
    assert.deepEqual(h.writes(), [], 'propose must not write to Graph');
  });

  test("binds row 2's client account and removes the confirmed staff id and the guest (no flag for the guest)", async () => {
    const h = harness();
    const { plan } = await proposePlan(h, [
      '--confirm-remove-staff',
      '2',
      '--write-verified',
      '/sites/0002CLIENTB',
    ]);
    const r2 = plan.rows.find((r) => r.listItemId === '2');
    assert.equal(r2.action, 'PATCH', 'a Team without the marker binds its own client account');
    assert.equal(r2.patch.UserAadObjectIds, IDS.clientB);
    assert.equal(r2.patch.TeamId, IDS.teamB);
    assert.ok(r2.warnings.some((w) => w.code === 'team_not_bcr'));
    assert.ok(r2.warnings.some((w) => w.code === 'staff_ids_removed'));
    assert.ok(r2.warnings.some((w) => w.code === 'guest_ids'));
    assert.deepEqual(
      r2.removedUserIds.map((u) => [u.id, u.reason]),
      [
        [IDS.staff, 'staff'],
        [IDS.guestB, 'guest'],
      ],
    );
    assert.deepEqual(r2.addedUserIds, [{ id: IDS.clientB, userPrincipalName: UPN_B }]);
    // Without --confirm-remove-staff the staff id keeps the row SKIP; the guest never does.
    const unconfirmed = (await proposePlan(h, ['--write-verified', '/sites/0002CLIENTB'])).plan;
    assert.deepEqual(unconfirmed.rows.find((r) => r.listItemId === '2').reasons.map((r) => r.code), ['staff_ids']);
  });

  test('never proposes a guest: every guest of the Team, the look-alike included, is listed as not bound', async () => {
    const h = harness();
    const { plan } = await proposePlan(h);
    const r1 = plan.rows.find((r) => r.listItemId === '1');
    assert.equal(r1.patch.UserAadObjectIds, IDS.clientA);
    const reason = Object.fromEntries(r1.notBound.map((e) => [e.id, e.reason]));
    assert.deepEqual(reason, {
      [IDS.guestA]: 'guest',
      [IDS.guestMulti]: 'guest',
      [IDS.guestLookalike]: 'guest',
      [IDS.staff]: 'staff',
      [IDS.onboarding]: 'staff',
      [IDS.ownerA]: 'owner',
    });
    assert.match(h.out.text(), /not bound\S* 0000000001_contoso\.example#EXT#@contoso\.onmicrosoft\.com \(guest\)/);
    assert.match(h.out.text(), new RegExp(`client account\\S* ${UPN_A}`));
  });

  test('R46 at propose: a client account also in another Team is not bound, with that Team', async () => {
    const h = harness();
    h.tenant.state.members.get(IDS.teamC).push(IDS.clientA);
    const { plan } = await proposePlan(h);
    const r1 = plan.rows.find((r) => r.listItemId === '1');
    assert.equal(r1.action, 'PATCH', 'the target is still bound');
    assert.equal('UserAadObjectIds' in r1.patch, false, 'no id to write');
    assert.equal(r1.clientAccount, null);
    const nb = r1.notBound.find((e) => e.id === IDS.clientA);
    assert.deepEqual([nb.reason, nb.otherTeams.map((t) => t.id)], ['client_account_ineligible', [IDS.teamC]]);
    assert.match(h.out.text(), new RegExp(`not bound\\S* ${UPN_A} \\(client_account_ineligible client_account_in_other_team: also in ${IDS.teamC}`));
  });

  test('a row without a valid NIP, or whose account does not exist, binds its target and no id', async () => {
    const h = harness();
    h.tenant.state.items.get('1').NIP = '12345';
    h.tenant.state.users.delete(IDS.clientB);
    const { plan } = await proposePlan(h, ['--confirm-remove-staff', '2', '--write-verified', '/sites/0002CLIENTB']);
    const [r1, r2] = ['1', '2'].map((id) => plan.rows.find((r) => r.listItemId === id));
    assert.equal(r1.action, 'PATCH');
    assert.equal(r1.patch.TeamId, IDS.teamA);
    assert.equal('UserAadObjectIds' in r1.patch, false);
    assert.ok(r1.warnings.some((w) => w.code === 'client_nip_invalid'));
    assert.equal(r2.action, 'PATCH');
    assert.equal(r2.patch.UserAadObjectIds, '', 'staff and guest off, nothing on');
    assert.ok(r2.warnings.some((w) => w.code === 'client_account_missing'));
    assert.ok(!h.tenant.calls.some((c) => c.path.startsWith('/users/12345')), 'an invalid NIP names no account to read');
  });

  test('two rows sharing a NIP are both skipped, and neither gets the account', async () => {
    const h = harness();
    h.tenant.state.items.get('2').NIP = '0000000001';
    const { plan } = await proposePlan(h, ['--confirm-remove-staff', '2', '--write-verified', '/sites/0002CLIENTB']);
    for (const id of ['1', '2']) {
      const r = plan.rows.find((x) => x.listItemId === id);
      assert.equal(r.action, 'SKIP', id);
      assert.ok(r.reasons.some((x) => x.code === 'duplicate_nip'), id);
      assert.deepEqual(r.patch, {}, id);
      assert.equal(r.proposed.UserAadObjectIds, '', id);
      assert.equal(r.clientAccount, null, id);
    }
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
    assert.deepEqual([log.version, log.clientDomain], [2, CLIENT_DOMAIN]);
    assert.equal(log.rows[0].result, 'patched');
    assert.equal(log.rows[0].before.RootFolder, '');
    assert.equal(log.rows[0].after.RootFolder, 'Dokumenty księgowe');
    assert.equal(log.rows[0].after.UserAadObjectIds, IDS.clientA);
    assert.equal(log.rows[0].before.NIP, '0000000001', 'the NIP is a guard field');
    assert.ok(!readFileSync(logFile, 'utf8').includes(TOKEN));
  });

  test("refuses a version-1 plan, an edited clientDomain, a --client-domain that differs, and a row whose NIP changed", async () => {
    const h = harness();
    h.tenant.state.columns.push({ name: 'DriveId', text: {} }, { name: 'TeamId', text: {} });
    const { file, plan } = await proposePlan(h);
    const reads = h.tenant.calls.length;
    const variant = (name, change, { digest = true } = {}) => {
      const copy = structuredClone(plan);
      change(copy);
      if (digest) copy.digest = planDigest(copy);
      const f = join(h.outDir, `${name}.json`);
      writeFileSync(f, JSON.stringify(copy));
      return f;
    };
    await assert.rejects(
      h.run(['apply', '--plan', variant('v1', (p) => (p.version = 1)), '--apply', ...HEALTH_ARGS]),
      /version is not 2 \(a plan made before the client-account rule/,
    );
    await assert.rejects(
      h.run(['apply', '--plan', variant('domain', (p) => (p.clientDomain = 'bcr-group.pl'), { digest: false }), '--apply', ...HEALTH_ARGS]),
      /digest does not match/,
    );
    await assert.rejects(
      h.run(['apply', '--plan', variant('nodomain', (p) => delete p.clientDomain), '--apply', ...HEALTH_ARGS]),
      /clientDomain is missing/,
    );
    await assert.rejects(
      h.run(['apply', '--plan', file, '--apply', ...HEALTH_ARGS, '--client-domain', 'bcr-group.pl']),
      /--client-domain bcr-group\.pl differs from the plan's \(contoso\.example\)/,
    );
    await assert.rejects(h.run(['apply', '--plan', file, ...HEALTH_ARGS, '--client-domain', 'x/y']), /--client-domain: not a host name/);
    assert.equal(h.tenant.calls.length, reads, 'all refused before any Graph call');
    // The same domain, spelt in another case, is the plan's.
    assert.equal(await h.run(['apply', '--plan', file, ...HEALTH_ARGS, '--client-domain', 'Contoso.Example']), 0);

    h.tenant.state.items.get('1').NIP = '0000000009';
    const logFile = fresh(h, 'nip-log');
    assert.equal(await h.run(['apply', '--plan', file, '--apply', ...HEALTH_ARGS, '--out', logFile]), 2);
    assert.deepEqual(h.writes().filter((c) => c.method === 'PATCH'), []);
    const [row] = JSON.parse(readFileSync(logFile, 'utf8')).rows;
    assert.deepEqual([row.result, row.staleFields], ['stale', ['NIP']]);
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

    // A plan too old to apply is not revived by a new date, and its guards,
    // client domain and directory are covered as well as its rows.
    const late = new Date(NOW.getTime() + 73 * 3_600_000);
    for (const [name, change] of [
      ['clientDomain', (p) => (p.clientDomain = 'bcr-group.pl')],
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

  test('re-reads the client account the row will route: a Guest, an owner, renamed, a second Team or deleted refuses it', async () => {
    for (const [name, change, want] of [
      ['became a Guest', (t) => (t.state.users.get(IDS.clientA).userType = 'Guest'), 'is a Guest: guests have no capability'],
      ['made an owner', (t) => t.state.owners.get(IDS.teamA).push(IDS.clientA), "is an owner of the row's Team"],
      [
        'renamed',
        (t) => (t.state.users.get(IDS.clientA).userPrincipalName = 'renamed@contoso.example'),
        `is not ${UPN_A}, the row's client account`,
      ],
      ['joined a second Team', (t) => t.state.members.get(IDS.teamC).push(IDS.clientA), `also in Team\\(s\\) ${IDS.teamC}`],
      [
        'removed from the Team',
        (t) => t.state.members.set(IDS.teamA, t.state.members.get(IDS.teamA).filter((id) => id !== IDS.clientA)),
        "no longer in the row's Team",
      ],
      ['deleted', (t) => t.state.users.delete(IDS.clientA), 'no longer exists'],
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

  test('does not refuse a client account that was disabled since propose: it is bound all the same', async () => {
    const h = harness();
    h.tenant.state.columns.push({ name: 'DriveId', text: {} }, { name: 'TeamId', text: {} });
    const { file } = await proposePlan(h);
    h.tenant.state.users.get(IDS.clientA).accountEnabled = false;
    const logFile = fresh(h, 'apply-log');
    assert.equal(await h.run(['apply', '--plan', file, '--apply', ...HEALTH_ARGS, '--out', logFile]), 0);
    assert.equal(JSON.parse(readFileSync(logFile, 'utf8')).rows[0].result, 'patched');
    assert.equal(h.tenant.state.items.get('1').UserAadObjectIds, IDS.clientA);
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

    // Restoring the before-state unbinds client A's account: allowed, and said.
    assert.match(h.out.text(), new RegExp(`warning\\S* the restore takes the row's client account ${IDS.clientA} off`));

    const rbLog = join(h.outDir, 'rollback-log.json');
    assert.equal(await h.run(['rollback', '--log', logFile, '--apply', '--out', rbLog]), 0);
    const restore = h.writes().at(-1);
    assert.deepEqual(restore.body, { RootFolder: '', UserAadObjectIds: '', DriveId: '', TeamId: '' });
    assert.equal(h.tenant.state.items.get('1').RootFolder, '');
    const rb = JSON.parse(readFileSync(rbLog, 'utf8'));
    assert.deepEqual([rb.version, rb.clientDomain], [2, CLIENT_DOMAIN]);
    assert.deepEqual([rb.rows[0].result, rb.rows[0].unbindsClientAccount], ['restored', [IDS.clientA]]);

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

  test('never puts back a client account that is now in another Team, and restores it once it qualifies again', async () => {
    const h = harness();
    await bind(h);
    // R46: client A's account joins company C's Team; the whole plan takes it off row 1.
    h.tenant.state.members.get(IDS.teamC).push(IDS.clientA);
    const removal = await bind(h);
    assert.equal(h.tenant.state.items.get('1').UserAadObjectIds, '');
    const patches = () => h.writes().filter((c) => c.method === 'PATCH').length;
    const before = patches();

    assert.equal(await h.run(['rollback', '--log', removal]), 2, 'the dry run refuses too');
    const rb = fresh(h, 'rollback-log');
    assert.equal(await h.run(['rollback', '--log', removal, '--apply', '--out', rb]), 2);
    assert.equal(patches(), before, 'nothing written');
    assert.equal(h.tenant.state.items.get('1').UserAadObjectIds, '', 'not routed to client A again');
    const [row] = JSON.parse(readFileSync(rb, 'utf8')).rows;
    assert.equal(row.result, 'client_account_recheck_failed');
    assert.deepEqual(row.readdedUserIds, [IDS.clientA]);
    assert.match(row.recheckReasons.join(' | '), new RegExp(`${IDS.clientA} is also in Team\\(s\\) ${IDS.teamC}`));
    assert.match(h.out.text(), /refused.*it would put back id\(s\) that must not route here/);

    // It leaves Team C: in Team A alone again, so the restore may add it.
    h.tenant.state.members.set(IDS.teamC, h.tenant.state.members.get(IDS.teamC).filter((id) => id !== IDS.clientA));
    const rb2 = fresh(h, 'rollback-log');
    assert.equal(await h.run(['rollback', '--log', removal, '--apply', '--out', rb2]), 0);
    assert.equal(h.tenant.state.items.get('1').UserAadObjectIds, IDS.clientA);
    const [row2] = JSON.parse(readFileSync(rb2, 'utf8')).rows;
    assert.deepEqual([row2.result, row2.readdedUserIds], ['restored', [IDS.clientA]]);
  });

  test('never puts back a guest id or a staff id, and --only limits the rollback to the rows named', async () => {
    const h = harness();
    // Row 2's staff id (confirmed) and guest id come off, and its client account goes on;
    // row 1 is bound from nothing.
    const log = await bind(h, ['--confirm-remove-staff', '2', '--write-verified', '/sites/0002CLIENTB']);
    assert.equal(h.tenant.state.items.get('2').UserAadObjectIds, IDS.clientB);
    const patchedItems = () => h.writes().filter((c) => c.method === 'PATCH').map((c) => c.path.match(/items\/(\d+)/)[1]);
    const before = patchedItems().length;

    await assert.rejects(h.run(['rollback', '--log', log, '--only', '9']), /--only 9: the log records no write/);

    // Row 1's restore adds no id: it is restored (unbinding client A, said so), and row 2 is not touched.
    const rb1 = fresh(h, 'rollback-log');
    assert.equal(await h.run(['rollback', '--log', log, '--only', '1', '--apply', '--out', rb1]), 0);
    assert.deepEqual(patchedItems().slice(before), ['1']);
    assert.equal(h.tenant.state.items.get('1').TeamId, '');
    assert.equal(h.tenant.state.items.get('2').TeamId, IDS.teamB, 'row 2 still bound');
    const out1 = JSON.parse(readFileSync(rb1, 'utf8'));
    assert.deepEqual(out1.only, ['1']);
    assert.deepEqual(out1.rows.map((r) => [r.listItemId, r.result, r.unbindsClientAccount]), [['1', 'restored', [IDS.clientA]]]);

    // Row 2's restore would put the staff (Member) id and the guest back: refused.
    const rb2 = fresh(h, 'rollback-log');
    assert.equal(await h.run(['rollback', '--log', log, '--only', '2', '--apply', '--out', rb2]), 2);
    assert.deepEqual(patchedItems().slice(before), ['1'], 'row 2 not written');
    const [row2] = JSON.parse(readFileSync(rb2, 'utf8')).rows;
    assert.equal(row2.result, 'client_account_recheck_failed');
    assert.deepEqual(row2.readdedUserIds.sort(), [IDS.guestB, IDS.staff].sort());
    const reasons = row2.recheckReasons.join(' | ');
    assert.match(reasons, /2 ids would route to the row; a row binds one client account/);
    assert.match(reasons, new RegExp(`${IDS.staff} is not ${UPN_B}, the row's client account`));
    assert.match(reasons, new RegExp(`${IDS.guestB} is a Guest: guests have no capability`));
    assert.equal(h.tenant.state.items.get('2').UserAadObjectIds, IDS.clientB);
  });

  test('a version-1 apply log is re-checked under the default domain; a log with no valid domain is refused', async () => {
    const h = harness();
    const log = await bind(h);
    const v1 = JSON.parse(readFileSync(log, 'utf8'));
    v1.version = 1;
    delete v1.clientDomain;
    const v1File = fresh(h, 'v1-log');
    writeFileSync(v1File, JSON.stringify(v1));
    assert.equal(await h.run(['rollback', '--log', v1File]), 0, 'a restore that adds no id');
    assert.match(h.out.text(), /accounts +<the row's 10-digit NIP>@bcr-group\.pl/);

    const broken = { ...v1, version: 2, clientDomain: 'Not A Domain' };
    const brokenFile = fresh(h, 'broken-log');
    writeFileSync(brokenFile, JSON.stringify(broken));
    await assert.rejects(h.run(['rollback', '--log', brokenFile]), /records no valid clientDomain/);
  });
});

test('no command sends anything to /users/* but GET, and check and propose send only GETs', async () => {
  const h = harness();
  assert.equal(await h.run(['check', ...DIR_ARGS]), 0);
  await proposePlan(h, ['--confirm-remove-staff', '2', '--write-verified', '/sites/0002CLIENTB']);
  assert.deepEqual(h.writes(), [], 'check and propose are read-only');
  const log = await bind(h, ['--confirm-remove-staff', '2', '--write-verified', '/sites/0002CLIENTB']);
  h.tenant.state.users.get(IDS.clientA).accountEnabled = false;
  assert.equal(await h.run(['check', ...DIR_ARGS]), 5);
  assert.equal(await h.run(['rollback', '--log', log, '--only', '1', '--apply', '--out', fresh(h, 'rb')]), 0);
  const users = h.tenant.calls.filter((c) => c.path.startsWith('/users/'));
  assert.ok(users.length > 0);
  assert.deepEqual(users.filter((c) => c.method !== 'GET'), []);
  // Every write is a list item or column of the Client Directory, never a user, group or Team.
  const listBase = `/sites/${IDS.dirSite}/lists/${IDS.list}/`;
  assert.deepEqual(h.writes().filter((c) => !c.path.startsWith(listBase)), []);
  assert.ok(h.writes().length > 0);
});

test('output files are private to the owner', async () => {
  const h = harness();
  await proposePlan(h);
  for (const name of readdirSync(h.outDir)) {
    const { mode } = await import('node:fs').then((fs) => fs.statSync(join(h.outDir, name)));
    assert.equal(mode & 0o077, 0, `${name} is readable by others`);
  }
});
