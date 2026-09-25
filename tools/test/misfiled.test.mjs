import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { toCsv } from '../lib/cli.mjs';
import {
  LEGACY_MESSAGES as M,
  REGISTER_COLUMNS,
  buildRegister,
  classifyItem,
  dedupeTraces,
  indexIr0,
  normalizeTrace,
  parseIr0Export,
  parseSiteGuests,
  parseSiteSpec,
  siteGuestsFromPlan,
  sitePathFromWebUrl,
  summarizeRegister,
} from '../lib/misfiled.mjs';
import { PLAN_KIND } from '../lib/bindings.mjs';
import { HOST, U1, U2, U3, U4, U5, U6, line, traces } from './ir0-fixture.mjs';
import { SITE_PATH_CASES } from './site-path-cases.mjs';

const g = (s) => `00000000-0000-4000-8000-${s.padStart(12, '0')}`;
const INGEST = g('e1');

describe('site specs', () => {
  test('parseSiteSpec accepts host:/path and URLs, with an optional label', () => {
    assert.deepEqual(parseSiteSpec('BCR=contoso.sharepoint.com:/sites/BCRGROUP'), {
      label: 'BCR',
      hostname: 'contoso.sharepoint.com',
      sitePath: '/sites/BCRGROUP',
    });
    assert.deepEqual(parseSiteSpec('https://Contoso.sharepoint.com/sites/0001A/'), {
      label: '0001A',
      hostname: 'contoso.sharepoint.com',
      sitePath: '/sites/0001A',
    });
    for (const bad of [
      'contoso',
      'contoso.sharepoint.com:/sites/a/b',
      'x=/sites/a',
      'http://h/sites/a',
      'h.example:/sites/..',
      'https://contoso.sharepoint.com/sites/0001%20A',
      'contoso.sharepoint.com:/sites/a.',
      'contoso.sharepoint.com:/foo/a',
    ]) {
      assert.throws(() => parseSiteSpec(bad), Error, bad);
    }
    // The same table as the ingestion and directory-bindings (C1).
    for (const [path, canonical] of SITE_PATH_CASES) {
      const spec = `contoso.sharepoint.com:${path.trim().startsWith('/') ? path.trim() : `/${path.trim()}`}`;
      if (canonical === null) assert.throws(() => parseSiteSpec(spec), Error, spec);
      else assert.equal(parseSiteSpec(spec).sitePath.toLowerCase(), canonical, spec);
    }
  });

  test('sitePathFromWebUrl', () => {
    assert.equal(sitePathFromWebUrl(`${HOST}/sites/BCRGROUP/Shared%20Documents/a.pdf`), '/sites/bcrgroup');
    assert.equal(sitePathFromWebUrl(`${HOST}/teams/X/y`), '/teams/x');
    assert.equal(sitePathFromWebUrl(`${HOST}/Shared%20Documents/a.pdf`), '');
    assert.equal(sitePathFromWebUrl('junk'), '');
  });
});

describe('IR-0 parsing', () => {
  test('reads az query output ({tables}), arrays and raw pino messages', () => {
    const az = {
      tables: [
        {
          name: 'PrimaryResult',
          columns: [{ name: 'timestamp' }, { name: 'msg' }, { name: 'driveItemId' }, { name: 'message' }],
          rows: [['2026-09-01T10:00:00Z', 'uploaded', '', JSON.stringify({ msg: 'uploaded', driveItemId: 'dX' })]],
        },
      ],
    };
    const [r] = parseIr0Export(az);
    assert.equal(r.msg, 'uploaded');
    assert.equal(r.driveItemId, 'dX', 'an empty projected column falls through to the JSON');
    assert.equal(parseIr0Export(traces()).length, traces().length - 1, 'non-JSON lines are dropped');
    assert.throws(() => parseIr0Export({ nope: 1 }), /unrecognised/);
  });

  test('a projected column wins over the raw JSON', () => {
    const r = normalizeTrace({
      timestamp: '2026-09-01T10:00:00Z',
      msg: 'client resolved',
      clientId: '0001',
      message: JSON.stringify({ msg: 'client resolved', clientId: 'other', promotedFromFallback: 'true' }),
    });
    assert.equal(r.clientId, '0001');
    assert.equal(r.promotedFromFallback, true);
    assert.equal(normalizeTrace({ message: 'plain text' }), null);
  });
});

describe('indexIr0', () => {
  const { byDriveItemId: idx, stats } = indexIr0(parseIr0Export(traces()));

  test('fallback upload: uploader from the resolver line of the same conversation', () => {
    const d1 = idx.get('d1');
    assert.equal(d1.resolution, 'fallback');
    assert.equal(d1.uploaderOid, U1);
    assert.equal(d1.uploaderOidSource, 'conversationId+time');
    assert.equal(d1.promotedFromFallback, false);
    assert.equal(d1.webUrlSitePath, '/sites/bcrgroup');
  });

  test('promoted upload: routing, target and uploader all recorded', () => {
    const d2 = idx.get('d2');
    assert.equal(d2.resolution, 'fallback');
    assert.equal(d2.promotedFromFallback, true);
    assert.equal(d2.refinedClientId, '0002');
    assert.equal(d2.finalSitePath, '/sites/0002CLIENTB');
    assert.equal(d2.uploaderOid, U2);
    assert.equal(d2.documentType, '');
    assert.equal(d2.folderPath, '01_Faktury/01_Faktury_sprzedaży/2026/09');
  });

  test('directory upload: uploader from the resolver line of the same client', () => {
    const d3 = idx.get('d3');
    assert.equal(d3.uploaderOid, U3);
    assert.equal(d3.uploaderOidSource, 'clientId+time');
  });

  test('two candidate uploaders are reported, never picked', () => {
    const d4 = idx.get('d4');
    assert.equal(d4.uploaderOid, '');
    assert.equal(d4.uploaderOidAmbiguous, true);
    assert.deepEqual(d4.uploaderOidCandidates.sort(), [U4, U5].sort());
  });

  test('an admin uploader is marked', () => {
    const d6 = idx.get('d6');
    assert.equal(d6.adminUploader, true);
    assert.equal(d6.adminClientId, 'BCR');
    assert.equal(d6.uploaderOid, U6);
  });

  test('an upload without its batch line is kept, and says so', () => {
    assert.equal(idx.get('d7').batchFound, false);
    assert.equal(stats.uploadsWithoutBatch, 1);
    assert.equal(stats.uploads, 6);
    assert.equal(stats.promoted, 1);
    assert.equal(stats.fallback, 3);
  });

  test('the same export read twice (routing + all-traces) counts each upload once', () => {
    const twice = [...parseIr0Export(traces()), ...parseIr0Export(traces())];
    const once = indexIr0(dedupeTraces(twice));
    assert.equal(once.stats.uploads, 6);
    assert.equal(once.byDriveItemId.get('d1').uploadCount, 1);
    const withIds = [{ itemId: 'a', timestamp: 't', msg: 'x' }, { itemId: 'a', timestamp: 't2', msg: 'x' }];
    assert.equal(dedupeTraces(withIds.map(normalizeTrace)).length, 1, 'itemId identifies a trace');
  });

  test('a resolver line outside the window is not joined', () => {
    const far = indexIr0(parseIr0Export(traces()), { windowMs: 1 }).byDriveItemId;
    assert.equal(far.get('d1').uploaderOid, '', '3 ms apart is outside a 1 ms window');
  });

  test('every upload of one item is kept; two uploaders make it ambiguous', () => {
    const replaced = [
      line(0, M.noDirectoryMatch, { conversationId: 'c1', userAadObjectId: U1 }),
      line(2, M.clientResolved, { invocationId: 'i1', conversationId: 'c1', resolution: 'fallback', sitePath: '/sites/BCRGROUP' }),
      line(500, M.uploaded, { invocationId: 'i1', filename: 'scan.pdf', driveItemId: 'D1', webUrl: `${HOST}/sites/BCRGROUP/x/scan.pdf` }),
      line(600, M.noDirectoryMatch, { conversationId: 'c2', userAadObjectId: U2 }),
      line(602, M.clientResolved, { invocationId: 'i2', conversationId: 'c2', resolution: 'fallback', sitePath: '/sites/BCRGROUP' }),
      line(900, M.uploaded, { invocationId: 'i2', filename: 'scan.pdf', driveItemId: 'D1', webUrl: `${HOST}/sites/BCRGROUP/x/scan.pdf` }),
    ];
    const { byDriveItemId, stats } = indexIr0(parseIr0Export(replaced));
    const d = byDriveItemId.get('D1');
    assert.equal(d.uploadCount, 2);
    assert.equal(stats.itemsWithSeveralUploads, 1);
    assert.equal(d.uploaderOid, '', 'never picks the last writer');
    assert.equal(d.uploaderOidAmbiguous, true);
    assert.deepEqual(d.uploaderOidCandidates, [U1, U2]);
    assert.deepEqual(d.uploads.map((u) => [u.invocationId, u.uploaderOid]), [['i1', U1], ['i2', U2]]);
    assert.equal(d.invocationId, 'i2', 'the latest upload describes the current content');

    const bcr = { site: { label: 'BCR', sitePath: '/sites/BCRGROUP' }, drive: { id: 'b', name: 'Dokumenty' } };
    const r = classifyItem({ id: 'D1', name: 'scan.pdf', parentPath: '/x', createdBy: {}, lastModifiedBy: {} }, bcr, {
      ingestAppIds: new Set(),
      ir0: byDriveItemId,
    });
    assert.equal(r.suspect, true);
    for (const f of ['multiple_uploads_same_item', 'uploader_ambiguous']) assert.ok(r.flags.includes(f), f);
    const csv = toCsv([r], REGISTER_COLUMNS);
    assert.ok(csv.includes(U1) && csv.includes(U2), 'the CSV lists every uploader');
  });

  test('two uploads of one name in one batch take no classified/refined line of each other', () => {
    const batch = [
      line(0, M.noDirectoryMatch, { conversationId: 'c', userAadObjectId: U1 }),
      line(2, M.clientResolved, { invocationId: 'i', conversationId: 'c', resolution: 'fallback', sitePath: '/sites/BCRGROUP' }),
      line(100, M.refined, { invocationId: 'i', filename: 'attachment.bin', clientId: '0002', sitePath: '/sites/0002CLIENTB', promotedFromFallback: true }),
      line(200, M.uploaded, { invocationId: 'i', filename: 'attachment.bin', driveItemId: 'A', webUrl: `${HOST}/sites/0002CLIENTB/x/attachment.bin` }),
      line(300, M.uploaded, { invocationId: 'i', filename: 'attachment.bin', driveItemId: 'B', webUrl: `${HOST}/sites/BCRGROUP/x/attachment_1.bin` }),
    ];
    const idx = indexIr0(parseIr0Export(batch)).byDriveItemId;
    for (const id of ['A', 'B']) {
      assert.equal(idx.get(id).filenameRepeatedInBatch, true, id);
      assert.equal(idx.get(id).refined, false, `${id} took a sibling's refined line`);
    }
    const rows = buildRegister({ walked: [], ir0: idx, ingestAppIds: new Set() });
    for (const r of rows) assert.ok(r.flags.includes('ir0_filename_repeated_in_batch'), r.driveItemId);
  });
});

describe('guests of each site', () => {
  const sites = [
    { label: 'A', sitePath: '/sites/0001CLIENTA' },
    { label: 'B', sitePath: '/sites/0002CLIENTB' },
  ];

  test('parseSiteGuests reads <label>=<oid,...> and refuses what it cannot place', () => {
    const m = parseSiteGuests([`A=${U3.toUpperCase()}, ${U4}`, `/sites/0001clienta=${U5}`], sites);
    assert.deepEqual([...m.get('/sites/0001clienta')].sort(), [U3, U4, U5].sort());
    assert.throws(() => parseSiteGuests([`Z=${U3}`], sites), /not one of the --site values/);
    assert.throws(() => parseSiteGuests(['A=nope'], sites), /not GUIDs/);
    assert.throws(() => parseSiteGuests([U3], sites), /expected/);
  });

  test('siteGuestsFromPlan takes each row\'s Team guests, and drops a site two rows share', () => {
    const plan = {
      kind: PLAN_KIND,
      rows: [
        { sitePath: '/sites/0001CLIENTA', eligibleGuests: [{ id: U3 }] },
        { sitePath: '/sites/0002CLIENTB', proposed: { UserAadObjectIds: `${U4}\n${U5}` } },
        { sitePath: '/sites/0003SHARED', eligibleGuests: [{ id: U1 }] },
        { sitePath: '/sites//0003shared', eligibleGuests: [{ id: U2 }] },
        { sitePath: '/sites/0004NOFACTS', proposed: null },
        { sitePath: '', eligibleGuests: [] },
      ],
    };
    const { guests, sharedSites } = siteGuestsFromPlan(plan);
    assert.deepEqual([...guests.keys()].sort(), ['/sites/0001clienta', '/sites/0002clientb']);
    assert.deepEqual([...guests.get('/sites/0002clientb')].sort(), [U4, U5].sort());
    assert.deepEqual(sharedSites, ['/sites/0003shared']);
    assert.throws(() => siteGuestsFromPlan({ kind: 'other', rows: [] }), /not a directory-bindings plan/);
  });
});

describe('register', () => {
  const { byDriveItemId: ir0 } = indexIr0(parseIr0Export(traces()));
  const ingestAppIds = new Set([INGEST]);
  const app = (id) => ({ application: { id, displayName: id === INGEST ? 'ingest' : 'other' } });
  const file = (id, parentPath, name, over = {}) => ({
    id,
    name,
    path: `${parentPath}/${name}`,
    parentPath,
    size: 100,
    createdBy: app(INGEST),
    lastModifiedBy: app(INGEST),
    versions: [{ id: '1.0', size: 100, lastModifiedDateTime: '2026-09-01T10:00:00Z' }],
    ...over,
  });
  const bcr = { site: { label: 'BCRGROUP', sitePath: '/sites/BCRGROUP' }, drive: { id: 'b!bcr', name: 'Dokumenty' } };
  const cliA = { site: { label: '0001', sitePath: '/sites/0001CLIENTA' }, drive: { id: 'b!a', name: 'Dokumenty' } };
  const guestsA = new Map([['/sites/0001clienta', new Set([U3])]]);
  const ctx = { ingestAppIds, ir0, fallbackSitePaths: new Set(['/sites/bcrgroup']), siteGuests: guestsA };

  test('a fallback-bucket file is suspect, with the reasons', () => {
    const r = classifyItem(file('d1', '/98_Nieposortowane', 'a.pdf'), bcr, ctx);
    assert.equal(r.suspect, true);
    for (const f of ['ingest_created', 'fallback_site', 'ir0_fallback', 'taxonomy_folder']) {
      assert.ok(r.flags.includes(f), f);
    }
    assert.equal(r.ir0.uploaderOid, U1);
  });

  test('a directory upload by a guest of the site\'s own Team, one version, is not suspect', () => {
    const r = classifyItem(file('d3', '', 'c.pdf'), cliA, ctx);
    assert.deepEqual(r.flags, ['ingest_created', 'library_root']);
    assert.equal(r.suspect, false);
  });

  test('a directory upload by anyone else, or with no guest list, is suspect', () => {
    const staffRouted = classifyItem(file('d3', '', 'c.pdf'), cliA, {
      ...ctx,
      siteGuests: new Map([['/sites/0001clienta', new Set([U4])]]),
    });
    assert.ok(staffRouted.flags.includes('uploader_not_site_guest'));
    assert.equal(staffRouted.suspect, true);

    const noList = classifyItem(file('d3', '', 'c.pdf'), cliA, { ...ctx, siteGuests: null });
    assert.ok(noList.flags.includes('uploader_guest_unverified'));
    assert.equal(noList.suspect, true);

    const otherSiteOnly = classifyItem(file('d3', '', 'c.pdf'), cliA, {
      ...ctx,
      siteGuests: new Map([['/sites/bcrgroup', new Set([U3])]]),
    });
    assert.ok(otherSiteOnly.flags.includes('uploader_guest_unverified'), 'no list for this site');

    // Two candidates: one outside the guests is enough.
    const d4 = classifyItem(file('d4', '', 'd.pdf'), cliA, {
      ...ctx,
      siteGuests: new Map([['/sites/0001clienta', new Set([U4])]]),
    });
    assert.ok(d4.flags.includes('uploader_not_site_guest'));
  });

  test('flags: site mismatch, prior versions, no IR-0 record, overwritten by ingestion', () => {
    const moved = classifyItem(file('d2', '', 'b.pdf'), cliA, ctx);
    assert.ok(moved.flags.includes('ir0_site_mismatch'));
    assert.ok(moved.flags.includes('promoted_by_content'));

    const versions = [{ id: '1.0' }, { id: '2.0' }];
    const twoVersions = classifyItem(file('d3', '', 'v.pdf', { versions }), cliA, ctx);
    assert.ok(twoVersions.flags.includes('has_prior_versions'));
    assert.equal(twoVersions.suspect, true, 'an earlier version may hold another document');
    const unreadable = classifyItem(file('d3', '', 'v.pdf', { versions: undefined, versionsError: '403' }), cliA, ctx);
    assert.ok(unreadable.flags.includes('versions_unreadable'));
    assert.equal(unreadable.suspect, true);
    assert.ok(classifyItem(file('zz', '', 'n.pdf'), cliA, ctx).flags.includes('no_ir0_record'));
    assert.equal(
      classifyItem(file('zz', '', 'n.pdf'), cliA, { ...ctx, ir0: null }).flags.includes('no_ir0_record'),
      false,
      'without an IR-0 export there is nothing to be missing from',
    );
    const overwritten = classifyItem(file('zz', '', 'o.pdf', { createdBy: app(g('e9')) }), cliA, ctx);
    assert.ok(overwritten.flags.includes('overwritten_by_ingest'));
  });

  test('buildRegister: candidates only, IR-0 items not found are rows too, suspects first', () => {
    const walked = [
      { ...bcr, items: [file('d1', '', 'a.pdf'), file('staff', '', 'staff.docx', { createdBy: app(g('e9')), lastModifiedBy: app(g('e9')) })] },
      { ...cliA, items: [file('d3', '', 'c.pdf')] },
    ];
    const rows = buildRegister({
      walked,
      ir0,
      ingestAppIds,
      fallbackSitePaths: ctx.fallbackSitePaths,
      siteGuests: guestsA,
    });
    const ids = rows.map((r) => r.driveItemId);
    assert.ok(!ids.includes('staff'), 'a file the ingestion never touched is not registered');
    const byId = Object.fromEntries(rows.map((r) => [r.driveItemId, r]));
    assert.ok(byId.d4.flags.includes('not_found_in_walk'), 'd4 was logged on a walked site');
    assert.ok(byId.d2.flags.includes('site_not_walked'), 'd2 went to a site that was not walked');
    assert.ok(byId.d7.flags.includes('site_not_walked'));
    assert.equal(byId.d3.suspect, false);
    const firstClean = rows.findIndex((r) => !r.suspect);
    assert.ok(rows.slice(firstClean).every((r) => !r.suspect), 'suspects sort first');

    const all = buildRegister({ walked, ir0: null, ingestAppIds, fallbackSitePaths: new Set(), includeAll: true });
    assert.equal(all.length, 3);

    const summary = summarizeRegister(rows);
    assert.equal(summary.rows, rows.length);
    assert.equal(summary.bySite.BCRGROUP.rows, 1);
  });

  test('the CSV keeps an uploader-chosen file name as text', () => {
    const r = classifyItem(file('d1', '', '=HYPERLINK("http://x","click").pdf'), bcr, ctx);
    const csv = toCsv([r], REGISTER_COLUMNS);
    assert.ok(csv.startsWith('﻿suspect,flags,'));
    assert.match(csv, /"'=HYPERLINK\(""http:\/\/x"",""click""\)\.pdf"/);
    assert.match(csv, /1\.0:100@2026-09-01T10:00:00Z/);
  });
});
