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
  healthSatisfies,
  mapSitesToTeams,
  parseDirectoryRow,
  pickAccountingChannel,
  planDigest,
  rollbackPatch,
  staleFields,
  survivesIngestionSanitiser,
  validatePlan,
} from '../lib/bindings.mjs';

// Synthetic ids only.
const g = (s) => `00000000-0000-4000-8000-${s.padStart(12, '0')}`;
const TEAM_A = g('a001');
const TEAM_X = g('a0aa');
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

const bcrGroup = (id, n = '0001') => ({ id, description: `BCR Group — ${n}` });

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
    memberOfByUser: new Map([[GUEST_A, [bcrGroup(TEAM_A), { id: g('f1'), description: 'unrelated' }]]]),
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

describe('findDuplicates', () => {
  const rows = [
    rowA({ UserAadObjectIds: GUEST_A }),
    parseDirectoryRow(item(2, { ClientId: '0001', NIP: '0000000002', SitePath: '/sites/B', UserAadObjectIds: GUEST_A })),
    parseDirectoryRow(item(3, { ClientId: '0003', NIP: '0000000001', SitePath: '/sites/0001clienta/' })),
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

  test('classifyTeamPeople binds guests of exactly this BCR team, never Members or owners', () => {
    const memberOf = new Map([
      [GUEST_A, [bcrGroup(TEAM_A)]],
      [GUEST_2, [bcrGroup(TEAM_A), bcrGroup(TEAM_X, '0099')]],
      [g('b003'), [bcrGroup(TEAM_X, '0099')]],
      [g('b004'), { error: '403' }],
      [g('b005'), [bcrGroup(TEAM_A)]],
    ]);
    const { eligible, excluded } = classifyTeamPeople({
      teamId: TEAM_A,
      members: [
        { id: GUEST_A, userType: 'Guest' },
        { id: GUEST_2, userType: 'Guest' },
        { id: g('b003'), userType: 'Guest' },
        { id: g('b004'), userType: 'Guest' },
        { id: g('b005'), userType: 'Guest' },
        { id: STAFF, userType: 'Member' },
      ],
      owners: [{ id: g('b005') }],
      memberOfByUser: memberOf,
    });
    assert.deepEqual(eligible.map((e) => e.id), [GUEST_A]);
    const reason = Object.fromEntries(excluded.map((e) => [e.id, e.reason]));
    assert.deepEqual(reason, {
      [GUEST_2]: 'guest_in_several_bcr_teams',
      [g('b003')]: 'guest_not_in_this_bcr_team',
      [g('b004')]: 'memberships_unreadable',
      [g('b005')]: 'owner',
      [STAFF]: 'not_a_guest',
    });
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
    assert.match(p.detail, /unknown, verify via runbook/);

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
});
