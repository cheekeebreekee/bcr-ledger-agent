import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import {
  CLIENT_ACCOUNT_DOMAIN,
  DRIFT_UNASSESSED_CODES,
  GUARD_FIELDS,
  PLAN_VERSION,
  ROUTING_DRIFT_CODES,
  assessRow,
  buildPlan,
  changedSinceApply,
  checkVerdict,
  classifyClientAccount,
  clientAccountNipOf,
  clientAccountUpn,
  clientAccountVerdict,
  clientNipsOf,
  diffBinding,
  evaluateWriteGrant,
  findDuplicates,
  findTeamForSite,
  folderAtDriveRoot,
  forbiddenTargetReasons,
  healthExpectations,
  healthSatisfies,
  idsRollbackAdds,
  idsRollbackRemoves,
  isBoundRow,
  isClientDomain,
  isSiteCollectionPath,
  isTeamGroup,
  mapSitesToTeams,
  nipChecksumOk,
  normalizeSitePath,
  parseDirectoryRow,
  pickAccountingChannel,
  planDigest,
  rollbackPatch,
  sitePathSegments,
  staleFields,
  survivesIngestionSanitiser,
  targetKey,
  validatePlan,
} from '../lib/bindings.mjs';
import { SITE_PATH_CASES } from './site-path-cases.mjs';

// Synthetic ids only.
const g = (s) => `00000000-0000-4000-8000-${s.padStart(12, '0')}`;
const TEAM_A = g('a001');
const TEAM_X = g('a0aa');
const TEAM_LEGACY = g('a0bb');
const TEAM_STAFF = g('a0ff');
const GUEST_A = g('b001');
const GUEST_2 = g('b002');
const STAFF = g('c001');
const OWNER = g('c002');
const CLIENT_A = g('c0a1');
const CLIENT_B = g('c0a2');
const INGEST = g('e1');
const DRIVE_A = 'b!fakeDriveA';
const ROOT_A = 'ROOT-A';
const CHANNEL = 'Dokumenty księgowe';
/** The fixtures' client-account domain; the tool's default is CLIENT_ACCOUNT_DOMAIN. */
const DOMAIN = 'contoso.example';
const UPN_A = `0000000001@${DOMAIN}`;
const UPN_B = `0000000002@${DOMAIN}`;

/** The one case table the runtime (`@bcr/shared` clientAccount.test.ts) tests too. */
const CASES = JSON.parse(readFileSync(new URL('./client-account-cases.json', import.meta.url), 'utf8'));

function item(id, fields) {
  return {
    id: String(id),
    fields: {
      Status: 'Active',
      SiteHostname: 'contoso.sharepoint.com',
      DriveName: 'Dokumenty',
      ...fields,
    },
  };
}

const rowA = (fields = {}) =>
  parseDirectoryRow(
    item(1, { Title: 'Client A', ClientId: '0001', NIP: '0000000001', SitePath: '/sites/0001CLIENTA', ...fields }),
  );

const team = (over = {}) => ({
  id: TEAM_A,
  displayName: '0001 Client A',
  description: 'BCR Group — 0001',
  visibility: 'Private',
  ...over,
});

/** A memberOf entry for a client Team carrying the onboarding marker. */
const bcrGroup = (id, n = '0001') => ({
  id,
  displayName: `${n} Client`,
  description: `BCR Group — ${n}`,
  resourceProvisioningOptions: ['Team'],
});
/** A Team without the marker: one that predates onboarding, or BCR GROUP. */
const plainTeam = (id, displayName) => ({ id, displayName, description: '', resourceProvisioningOptions: ['Team'] });
/** A group that is not a Team (a security group, a plain M365 group). */
const plainGroup = (id) => ({ id, displayName: 'unrelated', description: 'unrelated', resourceProvisioningOptions: [] });

/** Client A's account as `GET /users/{upn}` returns it. */
const accountA = (over = {}) => ({ id: CLIENT_A, userType: 'Member', userPrincipalName: UPN_A, accountEnabled: true, ...over });
/** A Team member entry. */
const member = (id, userType, userPrincipalName) => ({ id, userType, ...(userPrincipalName ? { userPrincipalName } : {}) });

/** Facts for a clean row A, with overrides. */
function factsA(over = {}) {
  return {
    usersById: new Map(),
    site: { id: 'contoso.sharepoint.com,site-a,web-a', webUrl: 'https://contoso.sharepoint.com/sites/0001CLIENTA' },
    team: team(),
    drives: [
      { id: DRIVE_A, name: 'Dokumenty' },
      { id: 'b!assets', name: 'Zasoby witryny' },
    ],
    channels: [
      { id: '19:general', displayName: 'General', membershipType: 'standard' },
      { id: '19:docs', displayName: CHANNEL, membershipType: 'standard' },
    ],
    filesFolder: {
      id: 'FOLDER-A',
      name: CHANNEL,
      parentReference: { driveId: DRIVE_A, id: ROOT_A },
      driveRootId: ROOT_A,
    },
    members: [
      member(CLIENT_A, 'Member', UPN_A),
      member(GUEST_A, 'Guest', 'guest.a#EXT#'),
      member(STAFF, 'Member', 'staff@contoso.example'),
      member(OWNER, 'Member'),
    ],
    owners: [{ id: OWNER }],
    account: accountA(),
    accountMemberOf: [bcrGroup(TEAM_A), plainGroup(g('f1'))],
    permissions: [{ roles: ['write'], grantedToIdentitiesV2: [{ application: { id: INGEST } }] }],
    ...over,
  };
}

const normalize = (id) => String(id).toLowerCase();
const ctxA = (over = {}) => ({ ingestAppIds: new Set([INGEST]), duplicates: [], clientDomain: DOMAIN, ...over });
const user = (id, userType, userPrincipalName, extra = {}) => [id, { id, userType, userPrincipalName, ...extra }];
const codes = (a) => a.problems.map((p) => `${p.severity}:${p.code}`);
const skipCodes = (a) => a.problems.filter((p) => p.severity === 'skip').map((p) => p.code);

describe('parseDirectoryRow', () => {
  test('normalises ids, drops duplicates and keeps bad lines aside', () => {
    const row = rowA({ UserAadObjectIds: ` ${GUEST_A.toUpperCase()} \n${GUEST_A}\nnot-a-guid\n\n` });
    assert.deepEqual(row.userIds, [GUEST_A]);
    assert.deepEqual(row.invalidUserIds, ['not-a-guid']);
  });

  test('defaults like the ingestion reader: Documents drive, Active status', () => {
    const row = parseDirectoryRow({ id: '9', fields: { ClientId: 'X', DriveName: '', Status: '' } });
    assert.equal(row.driveName, 'Documents');
    assert.equal(row.active, true);
    assert.equal(parseDirectoryRow({ id: '9', fields: { Status: 'Inactive' } }).active, false);
  });

  test('NIP keeps digits only', () => {
    assert.equal(rowA({ NIP: '000-000-00 01' }).nip, '0000000001');
  });
});

describe('the client-account rule (shared with @bcr/shared)', () => {
  test('clientAccountVerdict answers every case of the shared table', () => {
    const wrong = CASES.cases
      .filter((c) => clientAccountVerdict(c, c.rowNip, c.domain) !== c.verdict)
      .map((c) => `${c.name}: want ${c.verdict}, got ${clientAccountVerdict(c, c.rowNip, c.domain)}`);
    assert.deepEqual(wrong, []);
    assert.ok(CASES.cases.length >= 30, 'the table was read');
  });

  test("the domain is the table's, and the default argument", () => {
    assert.equal(CLIENT_ACCOUNT_DOMAIN, CASES.domain);
    const own = CASES.cases.find((c) => c.name === "the row's account");
    assert.equal(clientAccountVerdict(own, own.rowNip), 'client');
    assert.equal(clientAccountVerdict({ userType: 'Member', userPrincipalName: UPN_A }, '0000000001'), 'upn_mismatch');
    assert.equal(clientAccountUpn('0000000001'), `0000000001@${CLIENT_ACCOUNT_DOMAIN}`);
    assert.equal(clientAccountUpn('0000000001', DOMAIN), UPN_A);
  });

  test('clientAccountNipOf reads only the exact client shape', () => {
    assert.equal(clientAccountNipOf(' 0000000002@Contoso.Example ', DOMAIN), '0000000002');
    for (const upn of [
      'staff@contoso.example',
      '00000000020@contoso.example',
      '0000000002@sub.contoso.example',
      '0000000002@contoso.example.x',
      '0000000002_contoso.example#EXT#@contoso.onmicrosoft.com',
      '０００００００００２@contoso.example',
      '',
      undefined,
    ]) {
      assert.equal(clientAccountNipOf(upn, DOMAIN), '', String(upn));
    }
  });

  test('isClientDomain takes a lower-case host name and nothing else', () => {
    for (const d of ['bcr-group.pl', 'contoso.example', 'a.b.c']) assert.equal(isClientDomain(d), true, d);
    for (const d of ['BCR-Group.pl', 'bcr-group', '@bcr-group.pl', 'bcr-group.pl.', 'https://bcr-group.pl', 'x.pl/y', '-a.pl', '', null, 7]) {
      assert.equal(isClientDomain(d), false, String(d));
    }
  });

  test('nipChecksumOk: the Polish NIP checksum; the canary NIP never passes', () => {
    assert.equal(nipChecksumOk('1234563218'), true);
    assert.equal(nipChecksumOk('1234563219'), false);
    assert.equal(nipChecksumOk('9000000000'), false, 'remainder 10: no company can hold it');
    assert.equal(nipChecksumOk('123'), false);
  });
});

describe('site paths', () => {
  test('normalizeSitePath follows the ingestion rule on the shared edge-case table (C1)', () => {
    const wrong = SITE_PATH_CASES.filter(([input, want]) => normalizeSitePath(input) !== want).map(
      ([input, want]) => `${JSON.stringify(input)}: want ${want}, got ${normalizeSitePath(input)}`,
    );
    assert.deepEqual(wrong, []);
    for (const [input, want] of SITE_PATH_CASES) {
      assert.equal(sitePathSegments(input) === null, want === null, JSON.stringify(input));
    }
  });

  test('normalizeSitePath folds the spellings of one site, and refuses everything else', () => {
    for (const p of ['/sites/Foo', '/sites//Foo', '//sites/foo/', ' /SITES/foo/ ', 'sites/foo']) {
      assert.equal(normalizeSitePath(p), '/sites/foo', p);
    }
    for (const p of [
      '',
      '/',
      '/sites/',
      '/personal/x',
      '/sites/./foo',
      '/sites/x/../foo',
      '/sites/foo/.',
      '/sites/foo/..',
      '/sites/.foo',
      '/sites/%2e%2e',
      '/sites\\foo',
      '/sites/fo​o',
      '​/sites/foo',
      '/sites/foo?x',
      '/sites/foo#x',
    ]) {
      assert.equal(normalizeSitePath(p), null, JSON.stringify(p));
    }
  });

  test('an operator-named site must be canonical /sites/<name> or /teams/<name>', () => {
    assert.equal(isSiteCollectionPath('/sites/BCRGROUP'), true);
    assert.equal(isSiteCollectionPath('/teams/x/'), true);
    for (const p of ['https://contoso.sharepoint.com/sites/BCRGROUP', '/sites/a/b', '/sites/../x', '', '/']) {
      assert.equal(isSiteCollectionPath(p), false, p);
    }
  });

  test('a non-canonical path has no target key; spellings of one site share one', () => {
    const a = rowA({ SitePath: '/sites/0001CLIENTA' });
    assert.equal(targetKey(a), targetKey(rowA({ SitePath: '/sites//0001clienta/' })));
    assert.equal(targetKey(rowA({ SitePath: '/sites/x/../0001CLIENTA' })), '');
  });
});

describe('findDuplicates', () => {
  const rows = [
    rowA({ UserAadObjectIds: GUEST_A }),
    parseDirectoryRow(item(2, { ClientId: '0001', NIP: '0000000002', SitePath: '/sites/B', UserAadObjectIds: GUEST_A })),
    parseDirectoryRow(item(3, { ClientId: '0003', NIP: '0000000001', SitePath: '/sites//0001clienta/' })),
    parseDirectoryRow(item(4, { ClientId: '0004', NIP: '0000000001', SitePath: '/sites/D' })),
    parseDirectoryRow(item(5, { ClientId: '0001', NIP: '0000000001', SitePath: '/sites/0001CLIENTA', Status: 'Inactive' })),
  ];
  const dups = findDuplicates(rows);
  const byKind = (k) => dups.filter((d) => d.kind === k);

  test('reports every row sharing a key, three or more included', () => {
    assert.deepEqual(byKind('nip').map((d) => d.listItemIds), [['1', '3', '4']]);
  });

  test('covers ClientId, user id, site and target; inactive rows ignored', () => {
    assert.deepEqual(byKind('clientId').map((d) => d.listItemIds), [['1', '2']]);
    assert.deepEqual(byKind('userId').map((d) => d.listItemIds), [['1', '2']]);
    assert.deepEqual(byKind('site').map((d) => d.listItemIds), [['1', '3']]);
    assert.deepEqual(byKind('target').map((d) => d.listItemIds), [['1', '3']]);
  });

  test('a DriveId or TeamId on two client rows is a conflict, case-folded (C4); admin rows have none', () => {
    const bound = (id, site, drive, teamId, extra = {}) =>
      parseDirectoryRow(
        item(id, { ClientId: `00${id}`, NIP: `000000000${id}`, SitePath: site, DriveId: drive, TeamId: teamId, ...extra }),
      );
    const d = findDuplicates([
      bound(1, '/sites/A', 'b!Drive', TEAM_A),
      bound(2, '/sites/B', 'B!DRIVE', g('a0b2')),
      bound(3, '/sites/C', 'b!other', TEAM_A.toUpperCase()),
      bound(4, '', 'b!Drive', TEAM_A, { IsAdmin: true }),
    ]);
    const of = (k) => d.filter((x) => x.kind === k).map((x) => x.listItemIds);
    assert.deepEqual(of('driveId'), [['1', '2']]);
    assert.deepEqual(of('teamId'), [['1', '3']]);
    const a = assessRow(rowA(), factsA(), ctxA({ duplicates: d }));
    assert.ok(skipCodes(a).includes('duplicate_driveId') && skipCodes(a).includes('duplicate_teamId'));
  });
});

describe('forbiddenTargetReasons', () => {
  const DIR_COLLECTION = g('d01');
  const guard = (over = {}) => ({
    forbiddenSitePaths: new Set(['/sites/bcrgroup', '/sites/quarantine']),
    tenantHost: 'contoso.sharepoint.com',
    directorySiteCollectionId: DIR_COLLECTION,
    ...over,
  });
  const site = (collection, path = '/sites/0001CLIENTA', host = 'contoso.sharepoint.com') => ({
    id: `${host},${collection},${g('0e0')}`,
    webUrl: `https://${host}${path}`,
  });

  test('nothing forbids a client row on its own site', () => {
    assert.deepEqual(forbiddenTargetReasons(rowA(), site(g('5a1')), guard()), []);
  });

  test('by path, by host, and by the site Graph resolves', () => {
    const why = (row, s, g2 = guard()) => forbiddenTargetReasons(row, s, g2).join(' | ');
    assert.match(why(rowA({ SitePath: '/sites/BCRGROUP' })), /forbidden target/);
    assert.match(why(rowA({ SitePath: '/Sites//Quarantine/' })), /forbidden target/);
    assert.match(why(rowA({ SiteHostname: 'fabrikam.sharepoint.com' })), /not contoso\.sharepoint\.com/);
    // Whatever the path says: the Directory's collection, an alias of a
    // forbidden site, a sub-site of one, another host.
    assert.match(why(rowA(), site(DIR_COLLECTION.toUpperCase())), /Client Directory's own site collection/);
    assert.match(why(rowA(), site(g('5a1'), '/sites/BCRGROUP')), /resolves to \/sites\/bcrgroup/);
    assert.match(why(rowA(), site(g('5a1'), '/sites/Quarantine/sub')), /resolves to \/sites\/quarantine/);
    assert.match(why(rowA(), site(g('5a1'), '/sites/0001CLIENTA', 'fabrikam.sharepoint.com')), /host fabrikam/);
    assert.match(why(rowA(), { id: 'not-three-parts', webUrl: 'https://contoso.sharepoint.com/sites/x' }), /cannot be checked/);
  });

  test('an unresolved site and an admin row add nothing; the checks need no resolution', () => {
    assert.deepEqual(forbiddenTargetReasons(rowA(), { error: '404' }, guard()), []);
    assert.deepEqual(forbiddenTargetReasons(rowA({ IsAdmin: true, SitePath: '/sites/BCRGROUP' }), undefined, guard()), []);
    assert.equal(forbiddenTargetReasons(rowA({ SitePath: '/sites/bcrgroup' }), undefined, guard()).length, 1);
  });

  test('assessRow skips a row resolving to BCR GROUP and gives it no grant advice', () => {
    const a = assessRow(
      rowA(),
      factsA({ site: site(DIR_COLLECTION), permissions: null }),
      ctxA(guard()),
    );
    assert.ok(skipCodes(a).includes('forbidden_target'));
    assert.equal(a.evidence.writeGrant, 'n/a');
    assert.equal(a.proposed.TeamId, TEAM_A, 'the proposal is still shown, never applied');
  });
});

describe('team facts', () => {
  test('pickAccountingChannel: ok, missing, ambiguous, private', () => {
    const std = { id: '1', displayName: CHANNEL, membershipType: 'standard' };
    assert.equal(pickAccountingChannel([std]).status, 'ok');
    assert.equal(pickAccountingChannel([{ ...std, displayName: '  dokumenty   KSIĘGOWE ' }]).status, 'ok');
    assert.equal(pickAccountingChannel([]).status, 'missing');
    assert.equal(pickAccountingChannel([std, { ...std, id: '2' }]).status, 'ambiguous');
    assert.equal(pickAccountingChannel([{ ...std, membershipType: 'private' }]).status, 'not_standard');
    assert.equal(pickAccountingChannel([{ ...std, membershipType: 'shared' }]).status, 'not_standard');
  });

  describe('classifyClientAccount', () => {
    const classify = (over = {}) =>
      classifyClientAccount({
        teamId: TEAM_A,
        rowNip: '0000000001',
        clientDomain: DOMAIN,
        account: accountA(),
        accountMemberOf: [bcrGroup(TEAM_A), plainGroup(g('f1'))],
        members: [
          member(CLIENT_A, 'Member', UPN_A),
          member(GUEST_A, 'Guest', 'guest.a#EXT#'),
          member(g('b004'), 'Guest', '0000000001_contoso.example#EXT#@contoso.onmicrosoft.com'),
          member(STAFF, 'Member', 'staff@contoso.example'),
          member(CLIENT_B, 'Member', UPN_B),
          member(OWNER, 'Member', 'owner@contoso.example'),
        ],
        owners: [{ id: OWNER }],
        ...over,
      });
    const codesOf = (r) => r.problems.map((p) => `${p.severity}:${p.code}`);

    test("the row's account is eligible; every other person is not bound, with the reason", () => {
      const r = classify();
      assert.deepEqual(r.eligible.map((e) => e.id), [CLIENT_A]);
      assert.equal(r.assessed, true);
      assert.deepEqual(r.problems, []);
      assert.deepEqual(r.account, { id: CLIENT_A, displayName: '', userPrincipalName: UPN_A, accountEnabled: true });
      const reason = Object.fromEntries(r.notBound.map((p) => [p.id, p.reason]));
      assert.deepEqual(reason, {
        [GUEST_A]: 'guest', // a guest of this Team alone: guests have no capability
        [g('b004')]: 'guest', // invited with the client's own address
        [STAFF]: 'staff',
        [CLIENT_B]: 'other_client_account',
        [OWNER]: 'owner',
      });
      assert.ok(!(CLIENT_A in reason), 'never staff_ids, never not bound');
    });

    test('an owner is refused, whatever else holds', () => {
      const r = classify({ owners: [{ id: OWNER }, { id: CLIENT_A }] });
      assert.deepEqual(r.eligible, []);
      assert.ok(codesOf(r).includes('warn:client_account_owner'));
      assert.equal(r.notBound.find((p) => p.id === CLIENT_A).reason, 'owner');
    });

    test('a disabled account is still eligible, and is reported', () => {
      const r = classify({ account: accountA({ accountEnabled: false }) });
      assert.deepEqual(r.eligible.map((e) => [e.id, e.accountEnabled]), [[CLIENT_A, false]]);
      assert.deepEqual(codesOf(r), ['warn:client_account_disabled']);
      assert.match(r.problems[0].detail, /never unbinds or blocks a client/);
    });

    test('in any other Team it is not bound: a client Team, BCR GROUP, a group of unknown kind', () => {
      for (const [other, name] of [
        [bcrGroup(TEAM_X, '0099'), 'client Team'],
        [plainTeam(TEAM_STAFF, 'BCR GROUP'), 'BCR GROUP'],
        [plainTeam(TEAM_LEGACY, '0003 Legacy client'), 'legacy Team'],
        [{ id: g('f9'), displayName: '?' }, 'kind not returned'],
      ]) {
        const r = classify({ accountMemberOf: [bcrGroup(TEAM_A), other] });
        assert.deepEqual(r.eligible, [], name);
        const w = r.problems.find((p) => p.code === 'client_account_in_other_team');
        assert.equal(w?.severity, 'warn', name);
        assert.match(w.detail, new RegExp(normalize(other.id)), name);
        const nb = r.notBound.find((p) => p.id === CLIENT_A);
        assert.equal(nb.reason, 'client_account_ineligible', name);
        assert.deepEqual(nb.otherTeams.map((t) => t.id), [normalize(other.id)], name);
      }
      // The tenant's Team listing counts even when memberOf leaves the options empty.
      const listed = classify({ accountMemberOf: [bcrGroup(TEAM_A), plainGroup(TEAM_X)], knownTeamIds: new Set([TEAM_X]) });
      assert.ok(listed.problems.some((p) => p.code === 'client_account_in_other_team'));
      // A group that is not a Team does not count.
      assert.deepEqual(classify({ accountMemberOf: [bcrGroup(TEAM_A), plainGroup(g('f1'))] }).eligible.length, 1);
    });

    test("not on the Team's roster, or its memberships without the Team: not bound", () => {
      const off = classify({ members: [member(GUEST_A, 'Guest')] });
      assert.deepEqual(off.eligible, []);
      assert.ok(codesOf(off).includes('warn:client_account_not_in_team'));
      const disagree = classify({ accountMemberOf: [plainGroup(g('f1'))] });
      assert.deepEqual(disagree.eligible, []);
      assert.deepEqual(codesOf(disagree), ['warn:client_account_not_in_this_team']);
    });

    test('memberships or the account unreadable: a skip, and not assessed', () => {
      const memberships = classify({ accountMemberOf: { error: '403 accessDenied' } });
      assert.deepEqual([memberships.eligible, memberships.assessed], [[], false]);
      assert.deepEqual(codesOf(memberships), ['skip:client_account_memberships_unreadable']);
      for (const account of [{ error: '403 accessDenied' }, undefined]) {
        const r = classify({ account });
        assert.deepEqual([r.eligible, r.assessed, r.account], [[], false, null]);
        assert.deepEqual(codesOf(r), ['skip:client_account_lookup_failed']);
      }
    });

    test('no account at the UPN, or one that is not a Member: no id', () => {
      const missing = classify({ account: null });
      assert.deepEqual([missing.eligible, missing.assessed], [[], true]);
      assert.deepEqual(codesOf(missing), ['warn:client_account_missing']);
      assert.match(missing.problems[0].detail, new RegExp(UPN_A));
      for (const userType of ['Guest', null]) {
        const r = classify({ account: accountA({ userType }) });
        assert.deepEqual(r.eligible, [], String(userType));
        assert.deepEqual(codesOf(r), ['warn:client_account_not_member'], String(userType));
      }
    });

    test('a row without a valid NIP has no client account and reads none', () => {
      for (const rowNip of ['', '000000001', '00000000011']) {
        const r = classify({ rowNip, account: undefined, accountMemberOf: undefined });
        assert.deepEqual([r.eligible, r.problems, r.assessed], [[], [], true], rowNip);
        assert.equal(r.notBound.find((p) => p.id === CLIENT_A).reason, 'other_client_account', rowNip);
      }
    });
  });

  test('isTeamGroup: a group whose kind was not returned at all may only exclude, never bind', () => {
    assert.equal(isTeamGroup({ id: g('f9') }), true);
    assert.equal(isTeamGroup(plainGroup(g('f9'))), false);
  });

  test('evaluateWriteGrant', () => {
    const perm = (roles, id = INGEST, key = 'grantedToIdentitiesV2') => ({ roles, [key]: [{ application: { id } }] });
    const ids = new Set([INGEST]);
    assert.equal(evaluateWriteGrant([perm(['write'])], ids), 'granted');
    assert.equal(evaluateWriteGrant([perm(['owner'], INGEST.toUpperCase(), 'grantedToIdentities')], ids), 'granted');
    assert.equal(evaluateWriteGrant([perm(['read'])], ids), 'missing');
    assert.equal(evaluateWriteGrant([perm(['write'], g('e9'))], ids), 'missing');
    assert.equal(evaluateWriteGrant(null, ids), 'unknown');
    assert.equal(evaluateWriteGrant([perm(['write'])], new Set()), 'unknown');
  });

  test('folderAtDriveRoot by parent id, else by path', () => {
    assert.equal(folderAtDriveRoot({ parentReference: { id: 'R' } }, 'R'), true);
    assert.equal(folderAtDriveRoot({ parentReference: { id: 'X' } }, 'R'), false);
    assert.equal(folderAtDriveRoot({ parentReference: { path: '/drives/d/root:' } }), true);
    assert.equal(folderAtDriveRoot({ parentReference: { path: '/drives/d/root:/General' } }), false);
    assert.equal(folderAtDriveRoot({ parentReference: {} }), false);
  });

  test('survivesIngestionSanitiser mirrors pathBuilder.sanitizeSegment', () => {
    assert.equal(survivesIngestionSanitiser(CHANNEL), true);
    for (const bad of ['', ' lead', 'trail ', 'a:b', 'a/b', 'two  spaces', '.hidden', 'CON', 'lpt1.txt', '..']) {
      assert.equal(survivesIngestionSanitiser(bad), false, bad);
    }
  });

  test('mapSitesToTeams and findTeamForSite', () => {
    const a = { id: TEAM_A, displayName: 'A' };
    const x = { id: TEAM_X, displayName: 'X' };
    const idx = mapSitesToTeams([
      { team: a, site: { id: 'Host,S1,W1', webUrl: 'https://host/sites/Alpha' } },
      { team: x, site: { error: '403' } },
    ]);
    assert.equal(findTeamForSite(idx, { id: 'host,s1,w1' }), a);
    assert.equal(findTeamForSite(idx, { id: 'other', webUrl: 'https://HOST/sites/alpha/' }), a);
    assert.equal(findTeamForSite(idx, { id: 'none', webUrl: 'https://host/sites/beta' }), null);
    assert.deepEqual(idx.unreadable.map((u) => u.teamId), [TEAM_X]);

    const clash = mapSitesToTeams([
      { team: a, site: { id: 's', webUrl: 'https://host/sites/a' } },
      { team: x, site: { id: 's', webUrl: 'https://host/sites/a' } },
    ]);
    assert.match(findTeamForSite(clash, { id: 's' }).error, /2 Teams/);
  });
});

describe('assessRow', () => {
  test('a clean row proposes the channel folder, its drive, its team and its one client account', () => {
    const a = assessRow(rowA(), factsA(), ctxA());
    assert.deepEqual(skipCodes(a), []);
    assert.deepEqual(a.proposed, {
      RootFolder: CHANNEL,
      UserAadObjectIds: CLIENT_A,
      DriveId: DRIVE_A,
      TeamId: TEAM_A,
    });
    assert.deepEqual(a.addedUserIds, [{ id: CLIENT_A, userPrincipalName: UPN_A }]);
    assert.deepEqual(a.clientAccount, { id: CLIENT_A, userPrincipalName: UPN_A, accountEnabled: true });
    assert.equal(a.accountAssessed, true);
    assert.equal(a.lockedOut, false);
    assert.equal(a.evidence.writeGrant, 'granted');
    // The guest of this Team alone is never proposed.
    assert.equal(a.notBound.find((p) => p.id === GUEST_A).reason, 'guest');
  });

  test('without a client domain in ctx, the default domain names the account', () => {
    const upn = `0000000001@${CLIENT_ACCOUNT_DOMAIN}`;
    const facts = factsA({ account: accountA({ userPrincipalName: upn }), members: [member(CLIENT_A, 'Member', upn)] });
    const a = assessRow(rowA(), facts, { ingestAppIds: new Set([INGEST]) });
    assert.equal(a.proposed.UserAadObjectIds, CLIENT_A);
    const wrongDomain = assessRow(rowA(), factsA(), { ingestAppIds: new Set([INGEST]) });
    assert.equal(wrongDomain.proposed.UserAadObjectIds, '');
    assert.ok(codes(wrongDomain).includes('warn:client_account_not_member'));
  });

  test("staff on a client row: skipped until confirmed, then removed; another client's account is named so", () => {
    const facts = factsA({
      usersById: new Map([
        user(STAFF, 'Member', 'staff@contoso.example'),
        user(CLIENT_B, 'Member', UPN_B),
        user(CLIENT_A, 'Member', UPN_A),
      ]),
    });
    const row = rowA({ UserAadObjectIds: `${STAFF}\n${CLIENT_B}\n${CLIENT_A}` });
    const clientNips = new Map([['0000000001', ['1']], ['0000000002', ['2']]]);
    const skipped = assessRow(row, facts, ctxA({ clientNips }));
    assert.ok(skipCodes(skipped).includes('staff_ids'));
    const detail = skipped.problems.find((p) => p.code === 'staff_ids').detail;
    assert.match(detail, /staff@contoso\.example/);
    assert.match(detail, new RegExp(`${UPN_B} \\(another client's account: the NIP of row\\(s\\) 2\\)`));
    assert.ok(!codes(skipped).includes('warn:client_account_ineligible'));

    const confirmed = assessRow(row, facts, ctxA({ clientNips, confirmRemoveStaff: new Set(['1']) }));
    assert.deepEqual(skipCodes(confirmed), []);
    assert.ok(codes(confirmed).includes('warn:staff_ids_removed'));
    assert.equal(confirmed.proposed.UserAadObjectIds, CLIENT_A);
    assert.deepEqual(confirmed.removedUserIds.map((r) => [r.id, r.reason]), [
      [STAFF, 'staff'],
      [CLIENT_B, 'other_client_account'],
    ]);
  });

  test('a guest id on a bound row is removed without a flag, as guest_ids (drift)', () => {
    const bound = { RootFolder: CHANNEL, DriveId: DRIVE_A, TeamId: TEAM_A };
    const row = rowA({ ...bound, UserAadObjectIds: `${GUEST_A}\n${CLIENT_A}` });
    const facts = factsA({
      usersById: new Map([user(GUEST_A, 'Guest', 'guest.a#EXT#'), user(CLIENT_A, 'Member', UPN_A)]),
    });
    const a = assessRow(row, facts, ctxA());
    assert.deepEqual(skipCodes(a), [], 'no --confirm-remove-staff needed');
    const w = a.problems.find((p) => p.code === 'guest_ids');
    assert.equal(w.severity, 'warn');
    assert.match(w.detail, /^1 guest id\(s\) on a client row: guest\.a#EXT#\. Guests have no capability/);
    assert.equal(a.proposed.UserAadObjectIds, CLIENT_A);
    assert.deepEqual(a.removedUserIds.map((r) => [r.id, r.reason]), [[GUEST_A, 'guest']]);
    assert.deepEqual(checkVerdict([row], [a]).routingDrift, ['1']);
  });

  test("this row's account that no longer qualifies is client_account_ineligible, and the PATCH takes it off", () => {
    const bound = { RootFolder: CHANNEL, DriveId: DRIVE_A, TeamId: TEAM_A, UserAadObjectIds: CLIENT_A };
    const users = new Map([user(CLIENT_A, 'Member', UPN_A)]);
    for (const [name, over, why] of [
      ['in a second Team (R46)', { accountMemberOf: [bcrGroup(TEAM_A), bcrGroup(TEAM_X, '0099')] }, `client_account_in_other_team: also in ${TEAM_X}`],
      ['made an owner', { owners: [{ id: OWNER }, { id: CLIENT_A }] }, 'client_account_owner'],
      ['taken out of the Team', { members: [member(GUEST_A, 'Guest')], accountMemberOf: [] }, 'client_account_not_in_team'],
    ]) {
      const a = assessRow(rowA(bound), factsA({ usersById: users, ...over }), ctxA());
      const w = a.problems.find((p) => p.code === 'client_account_ineligible');
      assert.equal(w?.severity, 'warn', name);
      assert.match(w.detail, new RegExp(`${UPN_A} \\(${why}`), name);
      assert.equal(a.proposed.UserAadObjectIds, '', name);
      assert.deepEqual(a.removedUserIds.map((r) => [r.id, r.reason]), [[CLIENT_A, 'client_account_ineligible']], name);
      assert.equal(checkVerdict([rowA(bound)], [a]).exitCode, 3, name);
    }
  });

  test('a NIP edited by hand (or the account renamed): the bound account is client_account_ineligible', () => {
    const bound = { RootFolder: CHANNEL, DriveId: DRIVE_A, TeamId: TEAM_A, UserAadObjectIds: CLIENT_A };
    const row = rowA({ ...bound, NIP: '0000000009' });
    const facts = factsA({ usersById: new Map([user(CLIENT_A, 'Member', UPN_A)]), account: null });
    const a = assessRow(row, facts, ctxA({ clientNips: new Map([['0000000009', ['1']]]) }));
    assert.deepEqual(skipCodes(a), [], 'no flag: it is a client account, never staff');
    const w = a.problems.find((p) => p.code === 'client_account_ineligible');
    assert.match(w.detail, /a client account for NIP 0000000001, not this row's 0000000009: was the NIP edited/);
    assert.ok(codes(a).includes('warn:client_account_missing'), 'the new NIP names no account');
    assert.equal(a.proposed.UserAadObjectIds, '');
    assert.deepEqual(a.removedUserIds.map((r) => [r.id, r.reason]), [[CLIENT_A, 'client_account_ineligible']]);
  });

  test("an account with this row's UPN but no Member type is client_account_ineligible, removed without a flag", () => {
    const row = rowA({ UserAadObjectIds: CLIENT_A });
    const facts = factsA({ usersById: new Map([user(CLIENT_A, null, UPN_A)]), account: accountA({ userType: null }) });
    const a = assessRow(row, facts, ctxA({ clientNips: new Map([['0000000001', ['1']]]) }));
    assert.deepEqual(skipCodes(a), []);
    assert.match(a.problems.find((p) => p.code === 'client_account_ineligible').detail, /this row's UPN, but userType none, not Member/);
    assert.deepEqual(a.removedUserIds.map((r) => [r.id, r.reason]), [[CLIENT_A, 'client_account_ineligible']]);
  });

  test('a row without a valid NIP: client_nip_invalid, no id, the target still proposed', () => {
    for (const NIP of ['', '12345', '000-000-00-011']) {
      const a = assessRow(rowA({ NIP }), factsA({ account: undefined, accountMemberOf: undefined }), ctxA());
      assert.ok(codes(a).includes('warn:client_nip_invalid'), NIP);
      assert.deepEqual(skipCodes(a), [], NIP);
      assert.deepEqual(a.proposed, { RootFolder: CHANNEL, UserAadObjectIds: '', DriveId: DRIVE_A, TeamId: TEAM_A }, NIP);
      assert.equal(a.clientAccount, null, NIP);
    }
    // A NIP that fails the checksum only warns; its account is bound.
    const checksum = assessRow(rowA(), factsA(), ctxA());
    assert.ok(codes(checksum).includes('warn:client_nip_checksum'));
    assert.equal(checksum.proposed.UserAadObjectIds, CLIENT_A);
  });

  test('a disabled bound account stays bound and marks the row locked out', () => {
    const bound = { RootFolder: CHANNEL, DriveId: DRIVE_A, TeamId: TEAM_A, UserAadObjectIds: CLIENT_A };
    const facts = factsA({
      usersById: new Map([user(CLIENT_A, 'Member', UPN_A, { accountEnabled: false })]),
      account: accountA({ accountEnabled: false }),
    });
    const a = assessRow(rowA(bound), facts, ctxA());
    assert.equal(a.lockedOut, true);
    assert.equal(a.problems.filter((p) => p.code === 'client_account_disabled').length, 1);
    assert.equal(a.proposed.UserAadObjectIds, CLIENT_A, 'never unbound for it');
    assert.deepEqual(a.removedUserIds, []);
    // Read on the row only (the UPN read failed): still reported once.
    const rowOnly = assessRow(rowA(bound), { ...facts, account: { error: '503' } }, ctxA());
    assert.equal(rowOnly.lockedOut, true);
    assert.equal(rowOnly.problems.filter((p) => p.code === 'client_account_disabled').length, 1);
    // Read by UPN only (the read by id failed): the lockout is not hidden.
    const upnOnly = assessRow(rowA(bound), { ...facts, usersById: new Map([[CLIENT_A, { error: '429' }]]) }, ctxA());
    assert.equal(upnOnly.lockedOut, true);
    assert.equal(upnOnly.problems.filter((p) => p.code === 'client_account_disabled').length, 1);
    assert.deepEqual(checkVerdict([rowA(bound)], [upnOnly]).lockedOut, [upnOnly.listItemId]);
  });

  test('an id that was not read, or could not be, skips the row', () => {
    const row = rowA({ UserAadObjectIds: CLIENT_A });
    assert.ok(skipCodes(assessRow(row, factsA(), ctxA())).includes('user_lookup_failed'));
    const failed = assessRow(row, factsA({ usersById: new Map([[CLIENT_A, { error: '403' }]]) }), ctxA());
    assert.ok(skipCodes(failed).includes('user_lookup_failed'));
    // On a bound row, an unread id is unassessed: check exits 4, never 0.
    const boundRow = rowA({ RootFolder: CHANNEL, DriveId: DRIVE_A, TeamId: TEAM_A, UserAadObjectIds: STAFF });
    const unread = assessRow(boundRow, factsA({ usersById: new Map([[STAFF, { error: '503' }]]) }), ctxA());
    const verdict = checkVerdict([boundRow], [unread]);
    assert.deepEqual(verdict.incomplete, [unread.listItemId]);
    assert.equal(verdict.exitCode, 4);
    // A deleted user: reported, and the PATCH drops it.
    const gone = assessRow(rowA({ UserAadObjectIds: STAFF }), factsA({ usersById: new Map([[STAFF, null]]) }), ctxA());
    assert.ok(codes(gone).includes('warn:unknown_user_ids'));
    assert.deepEqual(gone.removedUserIds.map((r) => [r.id, r.reason]), [[STAFF, 'not_found']]);
    assert.equal(gone.proposed.UserAadObjectIds, CLIENT_A);
  });

  test('a Public team is skipped and never changed', () => {
    const a = assessRow(rowA(), factsA({ team: team({ visibility: 'Public' }) }), ctxA());
    assert.ok(skipCodes(a).includes('public_team'));
  });

  for (const [name, channels, code] of [
    ['missing channel', [], 'channel_missing'],
    ['two channels', [
      { id: '1', displayName: CHANNEL, membershipType: 'standard' },
      { id: '2', displayName: CHANNEL, membershipType: 'standard' },
    ], 'channel_ambiguous'],
    ['private channel', [{ id: '1', displayName: CHANNEL, membershipType: 'private' }], 'channel_not_standard'],
  ]) {
    test(`${name} skips the row`, () => {
      assert.ok(skipCodes(assessRow(rowA(), factsA({ channels }), ctxA())).includes(code));
    });
  }

  test('the channel folder in another drive than DriveName skips', () => {
    const facts = factsA();
    facts.filesFolder = { ...facts.filesFolder, parentReference: { driveId: 'b!assets', id: ROOT_A } };
    assert.ok(skipCodes(assessRow(rowA(), facts, ctxA())).includes('drive_mismatch'));
  });

  test('a channel folder below the root skips', () => {
    const facts = factsA();
    facts.filesFolder = { ...facts.filesFolder, parentReference: { driveId: DRIVE_A, id: 'SUBFOLDER' } };
    assert.ok(skipCodes(assessRow(rowA(), facts, ctxA())).includes('folder_not_at_root'));
  });

  test('a DriveName that is not an exact drive name skips, with a hint', () => {
    const a = assessRow(rowA({ DriveName: 'dokumenty' }), factsA(), ctxA());
    const p = a.problems.find((x) => x.code === 'drive_not_found');
    assert.match(p.detail, /did you mean "Dokumenty"/);
  });

  test('write grant: missing skips; unknown skips unless verified by the operator', () => {
    const missing = assessRow(rowA(), factsA({ permissions: [] }), ctxA());
    assert.ok(skipCodes(missing).includes('write_grant_missing'));

    const unknown = assessRow(rowA(), factsA({ permissions: null }), ctxA());
    const p = unknown.problems.find((x) => x.code === 'write_grant_unknown');
    assert.match(p.detail, /verify read-only with GET \/sites\/\{site-id\}\/permissions/);
    assert.match(p.detail, /Grant-TeamSiteAccess\.ps1 CREATES a write grant/, 'the runbook is named as a write');
    assert.doesNotMatch(p.detail, /verify via runbook/);

    const verified = assessRow(
      rowA(),
      factsA({ permissions: null }),
      ctxA({ writeVerified: new Set(['/sites/0001clienta']) }),
    );
    assert.deepEqual(skipCodes(verified), []);
    assert.equal(verified.evidence.writeGrant, 'operator-verified');
  });

  test('forbidden targets and admin rows are skipped', () => {
    const forbidden = assessRow(rowA(), factsA(), ctxA({ forbiddenSitePaths: new Set(['/sites/0001clienta']) }));
    assert.ok(skipCodes(forbidden).includes('forbidden_target'));
    const admin = assessRow(rowA({ IsAdmin: true }), {}, ctxA());
    assert.ok(skipCodes(admin).includes('admin_row'));
  });

  test('a forbidden site gets no write-grant advice at all', () => {
    const a = assessRow(
      rowA(),
      factsA({ permissions: null }),
      ctxA({ forbiddenSitePaths: new Set(['/sites/0001clienta']) }),
    );
    assert.deepEqual(skipCodes(a), ['forbidden_target']);
    assert.equal(a.evidence.writeGrant, 'n/a');
  });

  test('SitePath spellings: empty segments fold; anything not canonical makes the row invalid', () => {
    const forbiddenCtx = ctxA({ forbiddenSitePaths: new Set(['/sites/0001clienta']) });
    for (const spelling of ['/sites//0001CLIENTA', '//sites/0001CLIENTA/', ' /Sites/0001clienta ']) {
      const a = assessRow(rowA({ SitePath: spelling }), factsA(), forbiddenCtx);
      assert.ok(skipCodes(a).includes('forbidden_target'), spelling);
    }
    for (const spelling of [
      '/sites/./0001CLIENTA',
      '/sites/x/../0001CLIENTA',
      '/sites/0001CLIENTA/.',
      '/sites/0001CLIENTA/sub',
      '/sites/0001CLIENTA.',
      '/sites/ 0001CLIENTA',
      '/sites/%30001CLIENTA',
      '/personal/0001CLIENTA',
    ]) {
      const a = assessRow(rowA({ SitePath: spelling }), factsA({ permissions: null }), forbiddenCtx);
      assert.ok(skipCodes(a).includes('site_path_not_canonical'), spelling);
      assert.ok(!skipCodes(a).includes('write_grant_unknown'), `${spelling}: no grant advice`);
    }
  });

  test('a Team without the "BCR Group —" marker still binds its client account, with a warning', () => {
    const legacyTeam = team({ description: '' });
    const facts = factsA({
      team: legacyTeam,
      accountMemberOf: [plainTeam(TEAM_A, '0001 Client A'), plainGroup(g('f1'))],
    });
    const a = assessRow(rowA(), facts, ctxA({ knownTeamIds: new Set([TEAM_A]) }));
    assert.deepEqual(skipCodes(a), []);
    assert.ok(codes(a).includes('warn:team_not_bcr'));
    assert.equal(a.proposed.UserAadObjectIds, CLIENT_A);
    assert.equal(a.proposed.TeamId, TEAM_A);
  });

  test('a client account also in an unmarked Team, or in BCR GROUP, is not bound, and says where', () => {
    for (const [other, name] of [
      [TEAM_LEGACY, '0003 Legacy client'],
      [TEAM_STAFF, 'BCR GROUP'],
    ]) {
      const facts = factsA({ accountMemberOf: [bcrGroup(TEAM_A), plainTeam(other, name)] });
      const a = assessRow(rowA(), facts, ctxA({ knownTeamIds: new Set([TEAM_A, other]) }));
      assert.equal(a.proposed.UserAadObjectIds, '', name);
      assert.equal(a.clientAccount, null, name);
      const w = a.problems.find((p) => p.code === 'client_account_in_other_team');
      assert.equal(w.severity, 'warn');
      assert.match(w.detail, new RegExp(other));
    }
  });

  test('an existing different binding is not overwritten', () => {
    const a = assessRow(rowA({ RootFolder: 'Elsewhere', TeamId: TEAM_X, DriveId: 'b!other' }), factsA(), ctxA());
    const s = skipCodes(a);
    for (const c of ['root_folder_conflict', 'team_id_conflict', 'drive_id_conflict']) assert.ok(s.includes(c), c);
  });

  test('unreadable facts skip rather than read as absent', () => {
    assert.ok(skipCodes(assessRow(rowA(), factsA({ site: { error: '404' } }), ctxA())).includes('site_unresolved'));
    assert.ok(skipCodes(assessRow(rowA(), factsA({ team: null }), ctxA())).includes('no_team'));
    assert.ok(skipCodes(assessRow(rowA(), factsA({ members: { error: '403' } }), ctxA())).includes('membership_lookup_failed'));
    const unreadable = factsA({ accountMemberOf: { error: '403' } });
    assert.ok(skipCodes(assessRow(rowA(), unreadable, ctxA())).includes('client_account_memberships_unreadable'));
    const noAccount = factsA({ account: { error: '403' } });
    const a = assessRow(rowA(), noAccount, ctxA());
    assert.ok(skipCodes(a).includes('client_account_lookup_failed'));
    assert.equal(a.accountAssessed, false);
  });

  test('a client row without RootFolder, DriveId and TeamId is reported as routing nobody (C3)', () => {
    assert.ok(codes(assessRow(rowA(), factsA(), ctxA())).includes('warn:unbound_target'));
    const half = assessRow(rowA({ RootFolder: CHANNEL, DriveId: DRIVE_A }), factsA(), ctxA());
    assert.ok(codes(half).includes('warn:unbound_target'), 'one missing field is enough');
    const bound = rowA({ RootFolder: CHANNEL, DriveId: DRIVE_A, TeamId: TEAM_A });
    assert.ok(!codes(assessRow(bound, factsA(), ctxA())).includes('warn:unbound_target'));
    assert.ok(!codes(assessRow(rowA({ IsAdmin: true }), {}, ctxA())).includes('warn:unbound_target'));
  });

  test('each kind of id on the row has its own code; guests and staff never read as drift of the account', () => {
    const users = new Map([
      user(CLIENT_A, 'Member', UPN_A),
      user(GUEST_A, 'Guest', 'guest.a#EXT#'),
      user(GUEST_2, 'Guest', '0000000001_contoso.example#EXT#@contoso.onmicrosoft.com'),
      user(STAFF, 'Member', 'staff@contoso.example'),
    ]);
    const row = rowA({ UserAadObjectIds: `${GUEST_A}\n${GUEST_2}\n${STAFF}\n${CLIENT_A}` });
    const a = assessRow(row, factsA({ usersById: users }), ctxA({ confirmRemoveStaff: new Set(['1']) }));
    assert.match(a.problems.find((p) => p.code === 'guest_ids').detail, /^2 guest id\(s\)/);
    assert.match(a.problems.find((p) => p.code === 'staff_ids_removed').detail, /staff@contoso\.example/);
    assert.ok(!codes(a).includes('warn:client_account_ineligible'), 'the account qualifies');
    assert.equal(a.proposed.UserAadObjectIds, CLIENT_A);
    assert.deepEqual(
      a.removedUserIds.map((r) => [r.id, r.reason]),
      [
        [GUEST_A, 'guest'],
        [GUEST_2, 'guest'],
        [STAFF, 'staff'],
      ],
    );
  });

  test('an admin row: its ids are never judged by the client-account rule', () => {
    const users = new Map([user(STAFF, 'Member', 'staff@contoso.example'), user(GUEST_A, 'Guest', 'g#EXT#')]);
    const a = assessRow(rowA({ IsAdmin: true, UserAadObjectIds: `${STAFF}\n${GUEST_A}` }), { usersById: users }, ctxA());
    assert.deepEqual(codes(a).filter((c) => /staff|guest|client_/.test(c)), []);
  });

  test('a duplicate key skips; a duplicate user id only warns; a shared NIP gives neither row the account', () => {
    const dups = [
      { kind: 'nip', key: '0000000001', listItemIds: ['1', '7'] },
      { kind: 'userId', key: GUEST_A, listItemIds: ['1', '7'] },
    ];
    const a = assessRow(rowA(), factsA(), ctxA({ duplicates: dups }));
    assert.ok(codes(a).includes('skip:duplicate_nip'));
    assert.ok(codes(a).includes('warn:duplicate_user_id'));
    assert.equal(a.proposed.UserAadObjectIds, '');
    assert.equal(a.clientAccount, null);
  });
});

describe('buildPlan', () => {
  const directory = { siteId: 'contoso.sharepoint.com,d1,d2', listId: 'list' };

  function plan(rows, factsById, ctx = ctxA()) {
    const assessments = rows.map((r) => assessRow(r, factsById[r.listItemId], ctx));
    return buildPlan({
      rows,
      assessments,
      directory,
      ingestAppIds: [INGEST],
      createdAt: '2026-01-01T00:00:00.000Z',
      clientDomain: DOMAIN,
    });
  }
  const readA = new Map([user(CLIENT_A, 'Member', UPN_A)]);

  test('PATCH carries only changed fields; a bound row is NOOP; SKIP keeps its reasons and proposal', () => {
    const TEAM_B = g('a002');
    const DRIVE_B = 'b!fakeDriveB';
    const bound = rowA({ RootFolder: CHANNEL, UserAadObjectIds: CLIENT_A, DriveId: DRIVE_A, TeamId: TEAM_A });
    const half = parseDirectoryRow(
      item(2, { ClientId: '0002', NIP: '0000000002', SitePath: '/sites/0002B', RootFolder: CHANNEL }),
    );
    const pub = parseDirectoryRow(item(3, { ClientId: '0003', NIP: '0000000003', SitePath: '/sites/0003C' }));
    const factsB = factsA({
      team: team({ id: TEAM_B, description: 'BCR Group — 0002' }),
      drives: [{ id: DRIVE_B, name: 'Dokumenty' }],
      filesFolder: {
        id: 'FOLDER-B',
        name: CHANNEL,
        parentReference: { driveId: DRIVE_B, id: 'ROOT-B' },
        driveRootId: 'ROOT-B',
      },
      members: [member(CLIENT_B, 'Member', UPN_B), member(GUEST_2, 'Guest')],
      owners: [],
      account: { id: CLIENT_B, userType: 'Member', userPrincipalName: UPN_B, accountEnabled: true },
      accountMemberOf: [bcrGroup(TEAM_B, '0002')],
    });
    const p = plan([bound, half, pub], {
      1: factsA({ usersById: readA }),
      2: factsB,
      3: factsA({ team: team({ visibility: 'Public' }) }),
    });
    const [r1, r2, r3] = p.rows;
    assert.equal(r1.action, 'NOOP');
    assert.equal(r2.action, 'PATCH');
    assert.deepEqual(r2.patch, { UserAadObjectIds: CLIENT_B, DriveId: DRIVE_B, TeamId: TEAM_B });
    assert.deepEqual(r2.clientAccount, { id: CLIENT_B, userPrincipalName: UPN_B, accountEnabled: true });
    assert.deepEqual(r2.notBound.map((n) => [n.id, n.reason]), [[GUEST_2, 'guest']]);
    assert.equal('eligibleGuests' in r2 || 'excludedGuests' in r2, false, 'no guest lists in a v2 plan');
    assert.equal(p.version, PLAN_VERSION);
    assert.equal(PLAN_VERSION, 2);
    assert.equal(p.clientDomain, DOMAIN);
    assert.equal(r3.action, 'SKIP');
    assert.ok(r3.reasons.some((x) => x.code === 'public_team'));
    assert.deepEqual(r3.patch, {});
    assert.equal(r3.proposed.RootFolder, CHANNEL, 'a SKIP row still shows what it would have been');
    assert.deepEqual(validatePlan(p), []);
  });

  test('a client account already on another row is not added (no new duplicate)', () => {
    const other = parseDirectoryRow(
      item(9, { ClientId: '0009', NIP: '0000000009', SitePath: '/sites/0009', UserAadObjectIds: CLIENT_A }),
    );
    const p = plan([rowA(), other], { 1: factsA(), 9: { usersById: readA, site: { error: 'x' } } });
    const r1 = p.rows.find((r) => r.listItemId === '1');
    assert.equal(r1.action, 'PATCH');
    assert.equal('UserAadObjectIds' in r1.patch, false);
    assert.equal(r1.patch.RootFolder, CHANNEL);
    assert.ok(r1.warnings.some((w) => w.code === 'user_id_conflict'));
    assert.deepEqual(r1.addedUserIds, []);
  });

  test('the plan lists who is not bound: a client account in another Team, with that Team', () => {
    const facts = factsA({
      members: [member(CLIENT_A, 'Member', UPN_A), member(GUEST_A, 'Guest', 'guest.a#EXT#')],
      owners: [],
      accountMemberOf: [bcrGroup(TEAM_A), plainTeam(TEAM_LEGACY, '0003 Legacy client')],
    });
    const [r] = plan([rowA()], { 1: facts }).rows;
    assert.equal(r.action, 'PATCH');
    assert.equal('UserAadObjectIds' in r.patch, false, 'nothing to bind, nothing on the row');
    assert.equal(r.clientAccount, null, 'assessed: no account qualifies');
    assert.deepEqual(r.notBound, [
      { id: GUEST_A, userPrincipalName: 'guest.a#EXT#', reason: 'guest' },
      {
        id: CLIENT_A,
        userPrincipalName: UPN_A,
        reason: 'client_account_ineligible',
        why: 'client_account_in_other_team',
        otherTeams: [{ id: TEAM_LEGACY, displayName: '0003 Legacy client' }],
      },
    ]);
  });

  test('two rows that would end on the same target are both skipped', () => {
    const twin = parseDirectoryRow(
      item(2, { ClientId: '0002', NIP: '0000000002', SitePath: '/sites/0001CLIENTA' }),
    );
    const noGuests = { members: [], owners: [], account: null };
    const p = plan([rowA(), twin], { 1: factsA(noGuests), 2: factsA(noGuests) });
    for (const r of p.rows) {
      assert.equal(r.action, 'SKIP');
      assert.ok(r.reasons.some((x) => x.code === 'target_conflict'), JSON.stringify(r.reasons));
    }
  });

  test('two rows on different sites that would end with one DriveId or TeamId are both skipped (C4)', () => {
    const twin = parseDirectoryRow(item(2, { ClientId: '0002', NIP: '0000000002', SitePath: '/sites/0002ALIAS' }));
    const noGuests = { members: [], owners: [], account: null };
    // Both sites lead to Team A and its drive: the second is an alias.
    const p = plan([rowA(), twin], { 1: factsA(noGuests), 2: factsA(noGuests) });
    for (const r of p.rows) {
      assert.equal(r.action, 'SKIP');
      const details = r.reasons.filter((x) => x.code === 'target_conflict').map((x) => x.detail).join(' | ');
      assert.match(details, /(DriveId|TeamId) would equal that of row\(s\) [12]/);
    }

    // A row already bound to that Team keeps it; the newcomer is skipped.
    const bound = rowA({ RootFolder: CHANNEL, DriveId: DRIVE_A, TeamId: TEAM_A });
    const q = plan([bound, twin], { 1: factsA(noGuests), 2: factsA(noGuests) });
    assert.deepEqual(q.rows.map((r) => r.action), ['NOOP', 'SKIP']);
  });

  test('validatePlan refuses a PATCH that leaves the row unbound (C3)', () => {
    const p = plan([rowA()], { 1: factsA() });
    const unbound = structuredClone(p);
    delete unbound.rows[0].patch.TeamId;
    unbound.digest = planDigest(unbound);
    assert.ok(validatePlan(unbound).some((e) => /leaves TeamId empty/.test(e)));
  });

  test('validatePlan refuses a plan edited after propose', () => {
    const p = plan([rowA()], { 1: factsA() });
    assert.deepEqual(validatePlan(p), []);
    const edited = structuredClone(p);
    edited.rows[0].patch.UserAadObjectIds = `${GUEST_A}\n${STAFF}`;
    assert.ok(validatePlan(edited).some((e) => /digest/.test(e)));

    // A row binds one client account: two GUIDs are refused even with a fresh digest.
    const two = structuredClone(p);
    two.rows[0].patch.UserAadObjectIds = `${CLIENT_A}\n${GUEST_A}`;
    two.digest = planDigest(two);
    assert.deepEqual(validatePlan(two), ['row 1: UserAadObjectIds has 2 lines; a row binds one client account']);

    const forged = structuredClone(p);
    forged.rows[0].patch.Status = 'Inactive';
    forged.digest = planDigest(forged);
    assert.ok(validatePlan(forged).some((e) => /not a binding field/.test(e)));

    const unsafe = structuredClone(p);
    unsafe.rows[0].patch.RootFolder = '../x';
    unsafe.digest = planDigest(unsafe);
    assert.ok(validatePlan(unsafe).some((e) => /RootFolder unsafe/.test(e)));

    assert.ok(validatePlan({ ...p, rows: [null] }).length > 0);
  });

  test('validatePlan refuses a version-1 plan, and a missing or malformed clientDomain', () => {
    const p = plan([rowA()], { 1: factsA() });
    assert.deepEqual(validatePlan(p), []);
    const refused = (change) => {
      const x = structuredClone(p);
      change(x);
      x.digest = planDigest(x);
      return validatePlan(x);
    };
    assert.deepEqual(refused((x) => (x.version = 1)), [
      'version is not 2 (a plan made before the client-account rule, which bound guests). Re-run propose',
    ]);
    for (const bad of [undefined, '', 'Contoso.Example', '@contoso.example', 'contoso', 'contoso.example/x']) {
      assert.deepEqual(
        refused((x) => (bad === undefined ? delete x.clientDomain : (x.clientDomain = bad))),
        ['clientDomain is missing or not a lower-case host name'],
        String(bad),
      );
    }
  });

  test('the digest covers clientDomain, createdAt, directory and guards, not only the rows', () => {
    const p = buildPlan({
      rows: [rowA()],
      assessments: [assessRow(rowA(), factsA(), ctxA())],
      directory,
      guards: { forbiddenSitePaths: ['/sites/bcrgroup'], quarantineSitePath: '', tenantHost: '', directorySiteCollectionId: 'x' },
      createdAt: '2026-01-01T00:00:00.000Z',
      clientDomain: DOMAIN,
    });
    assert.deepEqual(validatePlan(p), []);
    assert.equal(buildPlan({ rows: [], assessments: [], directory }).clientDomain, CLIENT_ACCOUNT_DOMAIN, 'the default');
    for (const [name, change] of [
      ['clientDomain', (x) => (x.clientDomain = 'bcr-group.pl')],
      ['createdAt', (x) => (x.createdAt = '2026-09-25T00:00:00.000Z')],
      ['directory', (x) => (x.directory.listId = 'another')],
      ['guards', (x) => (x.guards.forbiddenSitePaths = [])],
      ['guards removed', (x) => delete x.guards],
      ['ingestAppIds', (x) => x.ingestAppIds.push(INGEST)],
    ]) {
      const edited = structuredClone(p);
      change(edited);
      assert.ok(validatePlan(edited).some((e) => /digest does not match/.test(e)), name);
    }
    // A JSON round trip (the plan file) keeps it valid.
    assert.deepEqual(validatePlan(JSON.parse(JSON.stringify(p))), []);
  });
});

describe('apply and rollback helpers', () => {
  test('diffBinding compares id lists as sets and rewrites a list with junk', () => {
    const before = { RootFolder: '', UserAadObjectIds: `${GUEST_2}\n${GUEST_A}`, DriveId: '', TeamId: '' };
    assert.deepEqual(diffBinding(before, { UserAadObjectIds: `${GUEST_A}\n${GUEST_2}` }), {});
    assert.deepEqual(
      diffBinding({ ...before, UserAadObjectIds: `${GUEST_A}\njunk` }, { UserAadObjectIds: GUEST_A }),
      { UserAadObjectIds: GUEST_A },
    );
  });

  test('staleFields names what changed in the binding or the guard, the NIP included', () => {
    assert.ok(GUARD_FIELDS.includes('NIP'));
    const planRow = {
      before: { RootFolder: '', UserAadObjectIds: '', DriveId: '', TeamId: '' },
      guard: rowA().guard,
    };
    const same = {
      ClientId: '0001',
      NIP: '0000000001',
      SiteHostname: 'contoso.sharepoint.com',
      SitePath: '/sites/0001CLIENTA',
      DriveName: 'Dokumenty',
      Status: 'Active',
    };
    assert.deepEqual(staleFields(planRow, same), []);
    assert.deepEqual(staleFields(planRow, { ...same, SitePath: '/sites/b', RootFolder: 'x' }).sort(), [
      'RootFolder',
      'SitePath',
    ]);
    assert.deepEqual(staleFields(planRow, { ...same, NIP: '0000000009' }), ['NIP']);
  });

  test('idsRollbackAdds names the GUIDs a restore puts back, as the ingestion reads them', () => {
    const current = { UserAadObjectIds: GUEST_A };
    assert.deepEqual(
      idsRollbackAdds({ UserAadObjectIds: `${GUEST_A}\n ${GUEST_2.toUpperCase()} \njunk\n${GUEST_2}` }, current),
      [GUEST_2],
    );
    assert.deepEqual(idsRollbackAdds({ UserAadObjectIds: '' }, current), []);
    assert.deepEqual(idsRollbackAdds({ RootFolder: '' }, current), [], 'ids not restored');
    assert.deepEqual(idsRollbackAdds({ UserAadObjectIds: STAFF }, {}), [STAFF]);
  });

  test('idsRollbackRemoves names the GUIDs a restore takes off', () => {
    const current = { UserAadObjectIds: `${CLIENT_A}\n${GUEST_A}` };
    assert.deepEqual(idsRollbackRemoves({ UserAadObjectIds: GUEST_A.toUpperCase() }, current), [CLIENT_A]);
    assert.deepEqual(idsRollbackRemoves({ UserAadObjectIds: '' }, current), [CLIENT_A, GUEST_A]);
    assert.deepEqual(idsRollbackRemoves({ RootFolder: '' }, current), [], 'ids not restored');
  });

  test('rollbackPatch restores the before-state of patched fields only', () => {
    const logRow = {
      patch: { RootFolder: CHANNEL, TeamId: TEAM_A },
      before: { RootFolder: '', UserAadObjectIds: STAFF, TeamId: undefined },
      after: { RootFolder: CHANNEL, TeamId: TEAM_A },
    };
    assert.deepEqual(rollbackPatch(logRow), { RootFolder: '', TeamId: '' });
    assert.deepEqual(changedSinceApply(logRow, { RootFolder: CHANNEL, TeamId: TEAM_A }), []);
    assert.deepEqual(changedSinceApply(logRow, { RootFolder: 'moved', TeamId: TEAM_A }), ['RootFolder']);
  });

  test('healthSatisfies checks dotted keys as strings', () => {
    const body = { status: 'ok', build: { phase: 'p0', n: 7 } };
    assert.deepEqual(healthSatisfies(body, ['status=ok', 'build.phase=p0', 'build.n=7']), { ok: true, missing: [] });
    const r = healthSatisfies(body, ['build.phase=p1', 'nothing=x', 'junk']);
    assert.equal(r.ok, false);
    assert.equal(r.missing.length, 3);
  });

  test('the P0 routing marker is always expected; extras only add to it', () => {
    assert.deepEqual(healthExpectations(), ['build.routing=identity-only']);
    assert.deepEqual(healthExpectations(['status=ok']), ['build.routing=identity-only', 'status=ok']);
    const legacy = { status: 'ok', service: 'document-ingestion', timestamp: 't' };
    assert.equal(healthSatisfies(legacy, healthExpectations(['status=ok'])).ok, false);
    assert.equal(healthSatisfies({ build: { phase: 'p0' } }, healthExpectations(['build.phase=p0'])).ok, false);
    const p0 = { status: 'ok', build: { phase: 'p0', routing: 'identity-only' } };
    assert.equal(healthSatisfies(p0, healthExpectations(['build.phase=p0'])).ok, true);
  });
});

describe('clientNipsOf', () => {
  test('the NIPs of the Active client rows, with the rows that carry each', () => {
    const rows = [
      rowA(),
      parseDirectoryRow(item(2, { ClientId: '0002', NIP: '0000000001' })),
      parseDirectoryRow(item(3, { ClientId: 'BCR', NIP: '0000000003', IsAdmin: true })),
      parseDirectoryRow(item(4, { ClientId: '0004', NIP: '0000000004', Status: 'Inactive' })),
      parseDirectoryRow(item(5, { ClientId: '0005', NIP: '' })),
    ];
    assert.deepEqual([...clientNipsOf(rows)], [['0000000001', ['1', '2']]]);
  });
});

describe('checkVerdict', () => {
  const bound = { RootFolder: CHANNEL, DriveId: DRIVE_A, TeamId: TEAM_A };
  const rowOf = (id, fields) => parseDirectoryRow(item(id, { ClientId: `000${id}`, NIP: `000000000${id}`, ...fields }));
  const assessed = (id, ...codes) => ({ listItemId: String(id), problems: codes.map((code) => ({ code, severity: 'skip' })) });

  test('drift on a bound row is 3; on an unbound row it routes nobody and is only reported', () => {
    const rows = [rowOf(1, { ...bound, UserAadObjectIds: STAFF }), rowOf(2, { UserAadObjectIds: STAFF })];
    const v = checkVerdict(rows, [assessed(1, 'staff_ids'), assessed(2, 'staff_ids', 'unbound_target')]);
    assert.deepEqual(v, { routingDrift: ['1'], incomplete: [], notRoutingUnbound: ['2'], lockedOut: [], exitCode: 3 });
    const unboundOnly = checkVerdict([rows[1]], [assessed(2, 'guest_ids')]);
    assert.deepEqual([unboundOnly.exitCode, unboundOnly.notRoutingUnbound], [0, ['2']]);
  });

  test('guest_ids and client_account_ineligible on a bound row are drift: 3', () => {
    assert.deepEqual([...ROUTING_DRIFT_CODES].sort(), ['client_account_ineligible', 'guest_ids', 'staff_ids', 'staff_ids_removed']);
    for (const code of ['guest_ids', 'client_account_ineligible']) {
      const rows = [rowOf(1, { ...bound, UserAadObjectIds: GUEST_A })];
      assert.equal(checkVerdict(rows, [assessed(1, code)]).exitCode, 3, code);
    }
  });

  test('a disabled client account bound on a bound row is 5; 3 and 4 win over it', () => {
    const lockedOut = (id, ...codes) => ({ ...assessed(id, ...codes), lockedOut: true });
    const rows = [rowOf(1, { ...bound, UserAadObjectIds: CLIENT_A })];
    assert.deepEqual(checkVerdict(rows, [lockedOut(1, 'client_account_disabled')]), {
      routingDrift: [],
      incomplete: [],
      notRoutingUnbound: [],
      lockedOut: ['1'],
      exitCode: 5,
    });
    // Unbound, the client routes nowhere anyway: reported by the warning only.
    assert.equal(checkVerdict([rowOf(1, { UserAadObjectIds: CLIENT_A })], [lockedOut(1)]).exitCode, 0);
    const two = [rows[0], rowOf(2, { ...bound, TeamId: g('a002'), UserAadObjectIds: CLIENT_B })];
    assert.equal(checkVerdict(two, [lockedOut(1), assessed(2, 'client_account_lookup_failed')]).exitCode, 4);
    assert.equal(checkVerdict(two, [lockedOut(1), assessed(2, 'guest_ids')]).exitCode, 3);
  });

  test('a bound row with ids that could not be assessed is 4; 3 wins over 4', () => {
    assert.deepEqual(DRIFT_UNASSESSED_CODES, [
      'user_lookup_failed',
      'site_unresolved',
      'no_team',
      'team_lookup_failed',
      'membership_lookup_failed',
      'client_account_lookup_failed',
      'client_account_memberships_unreadable',
    ]);
    for (const code of DRIFT_UNASSESSED_CODES) {
      const rows = [rowOf(1, { ...bound, UserAadObjectIds: GUEST_A })];
      assert.deepEqual(checkVerdict(rows, [assessed(1, code)]).exitCode, 4, code);
      // No ids on it: it routes nobody, so there is nothing to assess.
      assert.equal(checkVerdict([rowOf(1, bound)], [assessed(1, code)]).exitCode, 0, `${code}, no ids`);
      // Unbound: routes nobody either.
      assert.equal(checkVerdict([rowOf(1, { UserAadObjectIds: GUEST_A })], [assessed(1, code)]).exitCode, 0, `${code}, unbound`);
    }
    const rows = [rowOf(1, { ...bound, UserAadObjectIds: GUEST_A }), rowOf(2, { ...bound, TeamId: g('a002'), UserAadObjectIds: GUEST_2 })];
    const v = checkVerdict(rows, [assessed(1, 'client_account_ineligible'), assessed(2, 'no_team')]);
    assert.deepEqual(v, { routingDrift: ['1'], incomplete: ['2'], notRoutingUnbound: [], lockedOut: [], exitCode: 3 });
  });

  test('admin and inactive rows never count; isBoundRow needs all three binding fields', () => {
    const admin = rowOf(3, { ...bound, IsAdmin: true, UserAadObjectIds: STAFF });
    const inactive = rowOf(4, { ...bound, Status: 'Inactive', UserAadObjectIds: STAFF });
    assert.equal(checkVerdict([admin, inactive], [assessed(3, 'staff_ids'), assessed(4, 'staff_ids')]).exitCode, 0);
    assert.equal(isBoundRow(rowOf(1, bound)), true);
    for (const field of Object.keys(bound)) assert.equal(isBoundRow(rowOf(1, { ...bound, [field]: '' })), false, field);
    assert.equal(isBoundRow(admin), false);
  });
});
