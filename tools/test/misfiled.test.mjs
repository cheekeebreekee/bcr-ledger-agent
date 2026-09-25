import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { toCsv } from '../lib/cli.mjs';
import {
  REGISTER_COLUMNS,
  buildRegister,
  classifyItem,
  dedupeTraces,
  indexIr0,
  normalizeTrace,
  parseIr0Export,
  parseSiteSpec,
  sitePathFromWebUrl,
  summarizeRegister,
} from '../lib/misfiled.mjs';
import { HOST, U1, U2, U3, U4, U5, U6, traces } from './ir0-fixture.mjs';

const g = (s) => `00000000-0000-4000-8000-${s.padStart(12, '0')}`;
const INGEST = g('e1');

describe('site specs', () => {
  test('parseSiteSpec accepts host:/path and URLs, with an optional label', () => {
    assert.deepEqual(parseSiteSpec('BCR=contoso.sharepoint.com:/sites/BCRGROUP'), {
      label: 'BCR',
      hostname: 'contoso.sharepoint.com',
      sitePath: '/sites/BCRGROUP',
    });
    assert.deepEqual(parseSiteSpec('https://Contoso.sharepoint.com/sites/0001%20A/'), {
      label: '0001 A',
      hostname: 'contoso.sharepoint.com',
      sitePath: '/sites/0001 A',
    });
    for (const bad of ['contoso', 'contoso.sharepoint.com:/sites/a/b', 'x=/sites/a', 'http://h/sites/a']) {
      assert.throws(() => parseSiteSpec(bad), Error, bad);
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
  const ctx = { ingestAppIds, ir0, fallbackSitePaths: new Set(['/sites/bcrgroup']) };

  test('a fallback-bucket file is suspect, with the reasons', () => {
    const r = classifyItem(file('d1', '/98_Nieposortowane', 'a.pdf'), bcr, ctx);
    assert.equal(r.suspect, true);
    for (const f of ['ingest_created', 'fallback_site', 'ir0_fallback', 'taxonomy_folder']) {
      assert.ok(r.flags.includes(f), f);
    }
    assert.equal(r.ir0.uploaderOid, U1);
  });

  test('a clean directory upload in its own site is not suspect', () => {
    const r = classifyItem(file('d3', '', 'c.pdf'), cliA, ctx);
    assert.deepEqual(r.flags, ['ingest_created', 'library_root']);
    assert.equal(r.suspect, false);
  });

  test('flags: site mismatch, prior versions, no IR-0 record, overwritten by ingestion', () => {
    const moved = classifyItem(file('d2', '', 'b.pdf'), cliA, ctx);
    assert.ok(moved.flags.includes('ir0_site_mismatch'));
    assert.ok(moved.flags.includes('promoted_by_content'));

    const versions = [{ id: '1.0' }, { id: '2.0' }];
    assert.ok(classifyItem(file('zz', '', 'v.pdf', { versions }), cliA, ctx).flags.includes('has_prior_versions'));
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
    const rows = buildRegister({ walked, ir0, ingestAppIds, fallbackSitePaths: ctx.fallbackSitePaths });
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
