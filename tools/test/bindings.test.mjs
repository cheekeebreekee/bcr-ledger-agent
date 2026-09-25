import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  assessRow,
  buildPlan,
  changedSinceApply,
  classifyTeamPeople,
  diffBinding,
  evaluateWriteGrant,
  findDuplicates,
  findTeamForSite,
  folderAtDriveRoot,
  forbiddenTargetReasons,
  healthExpectations,
  healthSatisfies,
  isSiteCollectionPath,
  isTeamGroup,
  mapSitesToTeams,
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
const INGEST = g('e1');
const DRIVE_A = 'b!fakeDriveA';
const ROOT_A = 'ROOT-A';
const CHANNEL = 'Dokumenty księgowe';

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
      { id: GUEST_A, userType: 'Guest', userPrincipalName: 'guest.a#EXT#' },
      { id: STAFF, userType: 'Member', userPrincipalName: 'staff@contoso.example' },
      { id: OWNER, userType: 'Member' },
    ],
    owners: [{ id: OWNER }],
    memberOfByUser: new Map([[GUEST_A, [bcrGroup(TEAM_A), plainGroup(g('f1'))]]]),
    permissions: [{ roles: ['write'], grantedToIdentitiesV2: [{ application: { id: INGEST } }] }],
    ...over,
  };
}

const ctxA = (over = {}) => ({ ingestAppIds: new Set([INGEST]), duplicates: [], ...over });
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

  test('classifyTeamPeople binds guests of this Team alone, never Members or owners', () => {
    const memberOf = new Map([
      [GUEST_A, [bcrGroup(TEAM_A), plainGroup(g('f1'))]],
      [GUEST_2, [bcrGroup(TEAM_A), bcrGroup(TEAM_X, '0099')]],
      [g('b003'), [bcrGroup(TEAM_X, '0099')]],
      [g('b004'), { error: '403' }],
      [g('b005'), [bcrGroup(TEAM_A)]],
      [g('b006'), [plainGroup(g('f1'))]],
    ]);
    const { eligible, excluded } = classifyTeamPeople({
      teamId: TEAM_A,
      members: [
        { id: GUEST_A, userType: 'Guest' },
        { id: GUEST_2, userType: 'Guest' },
        { id: g('b003'), userType: 'Guest' },
        { id: g('b004'), userType: 'Guest' },
        { id: g('b005'), userType: 'Guest' },
        { id: g('b006'), userType: 'Guest' },
        { id: STAFF, userType: 'Member' },
      ],
      owners: [{ id: g('b005') }],
      memberOfByUser: memberOf,
    });
    assert.deepEqual(eligible.map((e) => e.id), [GUEST_A], 'a non-Team group does not count');
    const reason = Object.fromEntries(excluded.map((e) => [e.id, e.reason]));
    assert.deepEqual(reason, {
      [GUEST_2]: 'guest_in_other_team',
      [g('b003')]: 'guest_in_other_team',
      [g('b004')]: 'memberships_unreadable',
      [g('b005')]: 'owner',
      [g('b006')]: 'guest_not_in_this_team',
      [STAFF]: 'not_a_guest',
    });
    const other = excluded.find((e) => e.id === GUEST_2);
    assert.deepEqual(other.otherTeams, [{ id: TEAM_X, displayName: '0099 Client' }]);
  });

  test('every Team counts, marked or not; an unreadable kind counts as a Team', () => {
    const run = (groups, knownTeamIds) =>
      classifyTeamPeople({
        teamId: TEAM_A,
        members: [{ id: GUEST_A, userType: 'Guest' }],
        owners: [],
        memberOfByUser: new Map([[GUEST_A, groups]]),
        ...(knownTeamIds ? { knownTeamIds } : {}),
      });
    const legacy = run([bcrGroup(TEAM_A), plainTeam(TEAM_LEGACY, '0003 Legacy client')]);
    assert.deepEqual(legacy.eligible, []);
    assert.deepEqual(legacy.excluded[0].otherTeams, [{ id: TEAM_LEGACY, displayName: '0003 Legacy client' }]);

    const staff = run([bcrGroup(TEAM_A), plainTeam(TEAM_STAFF, 'BCR GROUP')]);
    assert.equal(staff.excluded[0].reason, 'guest_in_other_team');

    // The tenant's Team listing counts even when memberOf leaves the options empty.
    const listed = run([bcrGroup(TEAM_A), plainGroup(TEAM_X)], new Set([TEAM_X]));
    assert.equal(listed.excluded[0].reason, 'guest_in_other_team');

    // A group whose kind was not returned at all may only exclude, never bind.
    assert.equal(isTeamGroup({ id: g('f9') }), true);
    assert.equal(isTeamGroup(plainGroup(g('f9'))), false);
    const unknownKind = run([bcrGroup(TEAM_A), { id: g('f9'), displayName: '?' }]);
    assert.equal(unknownKind.excluded[0].reason, 'guest_in_other_team');
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
  test('a clean row proposes the channel folder, its drive, its team and its one guest', () => {
    const a = assessRow(rowA(), factsA(), ctxA());
    assert.deepEqual(skipCodes(a), []);
    assert.deepEqual(a.proposed, {
      RootFolder: CHANNEL,
      UserAadObjectIds: GUEST_A,
      DriveId: DRIVE_A,
      TeamId: TEAM_A,
    });
    assert.deepEqual(a.addedUserIds.map((u) => u.id), [GUEST_A]);
    assert.equal(a.evidence.writeGrant, 'granted');
  });

  test('staff on a client row: skipped until confirmed, then removed', () => {
    const facts = factsA({
      usersById: new Map([
        [STAFF, { id: STAFF, userType: 'Member', userPrincipalName: 'staff@contoso.example' }],
        [GUEST_A, { id: GUEST_A, userType: 'Guest' }],
      ]),
    });
    const row = rowA({ UserAadObjectIds: `${STAFF}\n${GUEST_A}` });
    assert.ok(skipCodes(assessRow(row, facts, ctxA())).includes('staff_ids'));

    const confirmed = assessRow(row, facts, ctxA({ confirmRemoveStaff: new Set(['1']) }));
    assert.deepEqual(skipCodes(confirmed), []);
    assert.ok(codes(confirmed).includes('warn:staff_ids_removed'));
    assert.equal(confirmed.proposed.UserAadObjectIds, GUEST_A);
    assert.deepEqual(confirmed.removedUserIds.map((r) => [r.id, r.reason]), [[STAFF, 'staff']]);
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

  test('a Team without the "BCR Group —" marker still binds its guest, with a warning', () => {
    const legacyTeam = team({ description: '' });
    const facts = factsA({
      team: legacyTeam,
      memberOfByUser: new Map([[GUEST_A, [plainTeam(TEAM_A, '0001 Client A'), plainGroup(g('f1'))]]]),
    });
    const a = assessRow(rowA(), facts, ctxA({ knownTeamIds: new Set([TEAM_A]) }));
    assert.deepEqual(skipCodes(a), []);
    assert.ok(codes(a).includes('warn:team_not_bcr'));
    assert.equal(a.proposed.UserAadObjectIds, GUEST_A);
    assert.equal(a.proposed.TeamId, TEAM_A);
  });

  test('a guest also in an unmarked Team, or in BCR GROUP, is not bound, and says where', () => {
    for (const [other, name] of [
      [TEAM_LEGACY, '0003 Legacy client'],
      [TEAM_STAFF, 'BCR GROUP'],
    ]) {
      const facts = factsA({ memberOfByUser: new Map([[GUEST_A, [bcrGroup(TEAM_A), plainTeam(other, name)]]]) });
      const a = assessRow(rowA(), facts, ctxA({ knownTeamIds: new Set([TEAM_A, other]) }));
      assert.equal(a.proposed.UserAadObjectIds, '', name);
      const w = a.problems.find((p) => p.code === 'guest_in_other_team');
      assert.equal(w.severity, 'warn');
      assert.match(w.detail, new RegExp(other));
      assert.ok(codes(a).includes('warn:no_eligible_guest'));
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
    const unreadable = factsA({ memberOfByUser: new Map([[GUEST_A, { error: '403' }]]) });
    assert.ok(skipCodes(assessRow(rowA(), unreadable, ctxA())).includes('guest_memberships_unreadable'));
  });

  test('a client row without RootFolder, DriveId and TeamId is reported as routing nobody (C3)', () => {
    assert.ok(codes(assessRow(rowA(), factsA(), ctxA())).includes('warn:unbound_target'));
    const half = assessRow(rowA({ RootFolder: CHANNEL, DriveId: DRIVE_A }), factsA(), ctxA());
    assert.ok(codes(half).includes('warn:unbound_target'), 'one missing field is enough');
    const bound = rowA({ RootFolder: CHANNEL, DriveId: DRIVE_A, TeamId: TEAM_A });
    assert.ok(!codes(assessRow(bound, factsA(), ctxA())).includes('warn:unbound_target'));
    assert.ok(!codes(assessRow(rowA({ IsAdmin: true }), {}, ctxA())).includes('warn:unbound_target'));
  });

  test('a duplicate key skips; a duplicate user id only warns', () => {
    const dups = [
      { kind: 'nip', key: '0000000001', listItemIds: ['1', '7'] },
      { kind: 'userId', key: GUEST_A, listItemIds: ['1', '7'] },
    ];
    const a = assessRow(rowA(), factsA(), ctxA({ duplicates: dups }));
    assert.ok(codes(a).includes('skip:duplicate_nip'));
    assert.ok(codes(a).includes('warn:duplicate_user_id'));
  });
});

describe('buildPlan', () => {
  const directory = { siteId: 'contoso.sharepoint.com,d1,d2', listId: 'list' };

  function plan(rows, factsById, ctx = ctxA()) {
    const assessments = rows.map((r) => assessRow(r, factsById[r.listItemId], ctx));
    return buildPlan({ rows, assessments, directory, ingestAppIds: [INGEST], createdAt: '2026-01-01T00:00:00.000Z' });
  }

  test('PATCH carries only changed fields; a bound row is NOOP; SKIP keeps its reasons and proposal', () => {
    const TEAM_B = g('a002');
    const DRIVE_B = 'b!fakeDriveB';
    const bound = rowA({ RootFolder: CHANNEL, UserAadObjectIds: GUEST_A, DriveId: DRIVE_A, TeamId: TEAM_A });
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
      members: [{ id: GUEST_2, userType: 'Guest' }],
      owners: [],
      memberOfByUser: new Map([[GUEST_2, [bcrGroup(TEAM_B, '0002')]]]),
    });
    const p = plan([bound, half, pub], {
      1: factsA(),
      2: factsB,
      3: factsA({ team: team({ visibility: 'Public' }) }),
    });
    const [r1, r2, r3] = p.rows;
    assert.equal(r1.action, 'NOOP');
    assert.equal(r2.action, 'PATCH');
    assert.deepEqual(r2.patch, { UserAadObjectIds: GUEST_2, DriveId: DRIVE_B, TeamId: TEAM_B });
    assert.equal(r3.action, 'SKIP');
    assert.ok(r3.reasons.some((x) => x.code === 'public_team'));
    assert.deepEqual(r3.patch, {});
    assert.equal(r3.proposed.RootFolder, CHANNEL, 'a SKIP row still shows what it would have been');
    assert.deepEqual(validatePlan(p), []);
  });

  test('a guest already on another row is not added (no new duplicate)', () => {
    const other = parseDirectoryRow(
      item(9, { ClientId: '0009', NIP: '0000000009', SitePath: '/sites/0009', UserAadObjectIds: GUEST_A }),
    );
    const p = plan([rowA(), other], { 1: factsA(), 9: { usersById: new Map(), site: { error: 'x' } } });
    const r1 = p.rows.find((r) => r.listItemId === '1');
    assert.equal(r1.action, 'PATCH');
    assert.equal('UserAadObjectIds' in r1.patch, false);
    assert.equal(r1.patch.RootFolder, CHANNEL);
    assert.ok(r1.warnings.some((w) => w.code === 'user_id_conflict'));
    assert.deepEqual(r1.addedUserIds, []);
  });

  test('the plan lists guests left out for being in another Team, with that Team', () => {
    const facts = factsA({
      members: [
        { id: GUEST_A, userType: 'Guest', userPrincipalName: 'guest.a#EXT#' },
        { id: GUEST_2, userType: 'Guest', userPrincipalName: 'guest.2#EXT#' },
      ],
      owners: [],
      memberOfByUser: new Map([
        [GUEST_A, [bcrGroup(TEAM_A)]],
        [GUEST_2, [bcrGroup(TEAM_A), plainTeam(TEAM_LEGACY, '0003 Legacy client')]],
      ]),
    });
    const [r] = plan([rowA()], { 1: facts }).rows;
    assert.equal(r.action, 'PATCH');
    assert.equal(r.patch.UserAadObjectIds, GUEST_A);
    assert.deepEqual(r.excludedGuests, [
      {
        id: GUEST_2,
        userPrincipalName: 'guest.2#EXT#',
        reason: 'guest_in_other_team',
        otherTeams: [{ id: TEAM_LEGACY, displayName: '0003 Legacy client' }],
      },
    ]);
  });

  test('two rows that would end on the same target are both skipped', () => {
    const twin = parseDirectoryRow(
      item(2, { ClientId: '0002', NIP: '0000000002', SitePath: '/sites/0001CLIENTA' }),
    );
    const noGuests = { members: [], owners: [], memberOfByUser: new Map() };
    const p = plan([rowA(), twin], { 1: factsA(noGuests), 2: factsA(noGuests) });
    for (const r of p.rows) {
      assert.equal(r.action, 'SKIP');
      assert.ok(r.reasons.some((x) => x.code === 'target_conflict'), JSON.stringify(r.reasons));
    }
  });

  test('two rows on different sites that would end with one DriveId or TeamId are both skipped (C4)', () => {
    const twin = parseDirectoryRow(item(2, { ClientId: '0002', NIP: '0000000002', SitePath: '/sites/0002ALIAS' }));
    const noGuests = { members: [], owners: [], memberOfByUser: new Map() };
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
    unbound.digest = planDigest(unbound.rows);
    assert.ok(validatePlan(unbound).some((e) => /leaves TeamId empty/.test(e)));
  });

  test('validatePlan refuses a plan edited after propose', () => {
    const p = plan([rowA()], { 1: factsA() });
    assert.deepEqual(validatePlan(p), []);
    const edited = structuredClone(p);
    edited.rows[0].patch.UserAadObjectIds = `${GUEST_A}\n${STAFF}`;
    assert.ok(validatePlan(edited).some((e) => /digest/.test(e)));

    const forged = structuredClone(p);
    forged.rows[0].patch.Status = 'Inactive';
    forged.digest = planDigest(forged.rows);
    assert.ok(validatePlan(forged).some((e) => /not a binding field/.test(e)));

    const unsafe = structuredClone(p);
    unsafe.rows[0].patch.RootFolder = '../x';
    unsafe.digest = planDigest(unsafe.rows);
    assert.ok(validatePlan(unsafe).some((e) => /RootFolder unsafe/.test(e)));

    assert.ok(validatePlan({ ...p, rows: [null] }).length > 0);
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

  test('staleFields names what changed in the binding or the guard', () => {
    const planRow = {
      before: { RootFolder: '', UserAadObjectIds: '', DriveId: '', TeamId: '' },
      guard: { ClientId: '0001', SiteHostname: 'h', SitePath: '/sites/a', DriveName: 'Dokumenty', Status: 'Active', IsAdmin: '' },
    };
    const same = { ClientId: '0001', SiteHostname: 'h', SitePath: '/sites/a', DriveName: 'Dokumenty', Status: 'Active' };
    assert.deepEqual(staleFields(planRow, same), []);
    assert.deepEqual(staleFields(planRow, { ...same, SitePath: '/sites/b', RootFolder: 'x' }).sort(), [
      'RootFolder',
      'SitePath',
    ]);
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
