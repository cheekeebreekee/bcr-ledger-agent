import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { main } from '../inventory-misfiled.mjs';
import { PLAN_KIND } from '../lib/bindings.mjs';
import { capture, fakeFetch, fakeJwt, jsonResponse } from './fake-graph.mjs';
import { U3, U4, traces } from './ir0-fixture.mjs';

const g = (s) => `00000000-0000-4000-8000-${s.padStart(12, '0')}`;
const INGEST = g('e1');
const OTHER = g('e9');
const TOKEN = fakeJwt({ upn: 'operator@contoso.example', exp: 1_900_000_000 });
const BASE = 'https://graph.microsoft.com/v1.0';

const by = (id) => ({ application: { id, displayName: id === INGEST ? 'BCR ledger ingestion' : 'Other app' } });
const f = (id, name, app = INGEST) => ({
  id,
  name,
  size: 1234,
  file: { mimeType: 'application/pdf' },
  createdDateTime: '2026-09-01T10:00:01Z',
  lastModifiedDateTime: '2026-09-01T10:00:01Z',
  createdBy: by(app),
  lastModifiedBy: by(app),
  webUrl: `https://contoso.sharepoint.com/x/${name}`,
});

/** BCRGROUP (the fallback bucket) and one client site. */
function tenant() {
  const sites = {
    '/sites/BCRGROUP': { id: 'contoso.sharepoint.com,s-bcr,w-bcr', drive: 'b!bcr' },
    '/sites/0001CLIENTA': { id: 'contoso.sharepoint.com,s-a,w-a', drive: 'b!a' },
  };
  const children = {
    'b!bcr:root': [
      [f('d1', 'a.pdf'), { id: 'F98', name: '98_Nieposortowane', folder: { childCount: 2 } }],
      [{ id: 'nb', name: 'Notes', package: { type: 'oneNote' } }],
    ],
    'b!bcr:F98': [[f('d6', 'e.pdf'), f('staff', 'staff.docx', OTHER)]],
    'b!a:root': [[f('d3', 'c.pdf')]],
  };
  const versions = { d1: 2, d6: 1, d3: 1 };
  return fakeFetch(({ method, path, query }) => {
    if (method !== 'GET') return jsonResponse(405, { error: { code: 'methodNotAllowed' } });
    let m;
    if ((m = path.match(/^\/sites\/contoso\.sharepoint\.com:(\/sites\/[^/]+)$/))) {
      const s = sites[m[1]];
      return s ? jsonResponse(200, { id: s.id, webUrl: `https://contoso.sharepoint.com${m[1]}` }) : undefined;
    }
    if ((m = path.match(/^\/sites\/([^/]+)\/drives$/))) {
      const s = Object.values(sites).find((x) => x.id === m[1]);
      return jsonResponse(200, {
        value: [
          { id: s.drive, name: 'Dokumenty', driveType: 'documentLibrary' },
          { id: `${s.drive}-2`, name: 'Zasoby witryny', driveType: 'documentLibrary' },
        ],
      });
    }
    if ((m = path.match(/^\/drives\/([^/]+)\/(?:root|items\/([^/]+))\/children$/))) {
      const pages = children[`${m[1]}:${m[2] ?? 'root'}`] ?? [[]];
      const page = Number(query.get('page') ?? 0);
      const next = page + 1 < pages.length ? `${BASE}${path}?page=${page + 1}` : undefined;
      return jsonResponse(200, { value: pages[page], ...(next ? { '@odata.nextLink': next } : {}) });
    }
    if ((m = path.match(/^\/drives\/([^/]+)\/items\/([^/]+)\/versions$/))) {
      const n = versions[m[2]] ?? 1;
      return jsonResponse(200, {
        value: Array.from({ length: n }, (_, i) => ({
          id: `${n - i}.0`,
          size: 1000 + i,
          lastModifiedDateTime: `2026-09-0${n - i}T10:00:00Z`,
          lastModifiedBy: by(INGEST),
        })),
      });
    }
    return undefined;
  });
}

function run(argv, fetch, outDir) {
  const out = capture();
  const promise = main(argv, {
    env: { GRAPH_TOKEN: TOKEN },
    print: out.print,
    graphFetch: fetch,
    sleep: async () => {},
    now: () => new Date('2026-09-25T10:00:00Z'),
    outDir,
  });
  return { promise, out };
}

describe('inventory-misfiled', () => {
  test('walks, joins IR-0, flags, and writes JSON + CSV — with GET requests only', async () => {
    const { fetch, calls } = tenant();
    const outDir = mkdtempSync(join(tmpdir(), 'ir1-test-'));
    const ir0File = join(outDir, 'ir0.json');
    writeFileSync(ir0File, JSON.stringify(traces()));

    const { promise, out } = run(
      [
        '--site', 'BCR=contoso.sharepoint.com:/sites/BCRGROUP',
        '--site', 'https://contoso.sharepoint.com/sites/0001CLIENTA',
        '--ingest-app-ids', INGEST,
        '--fallback-site', 'BCR',
        '--ir0', ir0File,
        '--site-guests', `0001CLIENTA=${U3}`,
      ],
      fetch,
      outDir,
    );
    assert.equal(await promise, 0);
    assert.deepEqual(calls.filter((c) => c.method !== 'GET'), [], 'IR-1 must be read-only');
    assert.ok(!out.text().includes(TOKEN));

    const files = readdirSync(outDir).filter((n) => n.startsWith('ir1-inventory-'));
    assert.equal(files.length, 2);
    const register = JSON.parse(readFileSync(join(outDir, files.find((n) => n.endsWith('.json'))), 'utf8'));
    const csv = readFileSync(join(outDir, files.find((n) => n.endsWith('.csv'))), 'utf8');

    const row = Object.fromEntries(register.rows.map((r) => [r.driveItemId, r]));
    assert.equal(row.staff, undefined, 'a file the ingestion did not write is not registered');
    assert.equal(row.d1.path, '/a.pdf');
    assert.equal(row.d1.versionCount, 2);
    for (const flag of ['fallback_site', 'ir0_fallback', 'has_prior_versions', 'library_root']) {
      assert.ok(row.d1.flags.includes(flag), `d1 ${flag}`);
    }
    assert.equal(row.d6.path, '/98_Nieposortowane/e.pdf');
    assert.ok(row.d6.flags.includes('admin_uploader'));
    assert.equal(row.d3.suspect, false);
    assert.ok(row.d4.flags.includes('not_found_in_walk'));
    assert.ok(row.d2.flags.includes('site_not_walked'));
    assert.ok(row.d2.flags.includes('promoted_by_content'));

    assert.deepEqual(
      register.creatorApps.map((a) => [a.appId, a.files]),
      [[INGEST, 3], [OTHER, 1]],
    );
    assert.equal(register.ir0Inputs[0].traces, traces().length - 1);
    assert.match(register.ir0Inputs[0].sha256, /^[0-9a-f]{64}$/);
    assert.equal(csv.split('\r\n').filter(Boolean).length, register.rows.length + 1);
    assert.match(out.text(), /sha256  [0-9a-f]{64}/);
  });

  test('an identity-routed upload is clean only against a guest list: none, a plan, --no-versions', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'ir1-test-'));
    const ir0File = join(outDir, 'ir0.json');
    writeFileSync(ir0File, JSON.stringify(traces()));
    const base = [
      '--site', 'BCR=contoso.sharepoint.com:/sites/BCRGROUP',
      '--site', 'https://contoso.sharepoint.com/sites/0001CLIENTA',
      '--ingest-app-ids', INGEST,
      '--fallback-site', 'BCR',
      '--ir0', ir0File,
    ];
    const registerOf = async (extra) => {
      const dir = mkdtempSync(join(tmpdir(), 'ir1-out-'));
      const { promise, out } = run([...base, ...extra, '--out-dir', dir], tenant().fetch, outDir);
      assert.equal(await promise, 0);
      const name = readdirSync(dir).find((n) => n.endsWith('.json'));
      const reg = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      return { reg, row: Object.fromEntries(reg.rows.map((r) => [r.driveItemId, r])), out };
    };

    const none = await registerOf([]);
    assert.ok(none.row.d3.flags.includes('uploader_guest_unverified'));
    assert.equal(none.row.d3.suspect, true);
    assert.match(none.out.text(), /no --site-guests or --bindings-plan/);

    const planFile = join(outDir, 'plan.json');
    writeFileSync(
      planFile,
      JSON.stringify({
        kind: PLAN_KIND,
        createdAt: '2026-09-25T09:00:00Z',
        rows: [{ sitePath: '/sites/0001CLIENTA', eligibleGuests: [{ id: U4 }] }],
      }),
    );
    const fromPlan = await registerOf(['--bindings-plan', planFile]);
    assert.ok(fromPlan.row.d3.flags.includes('uploader_not_site_guest'), 'U3 is not a guest of that Team');
    assert.deepEqual(fromPlan.reg.parameters.siteGuests, { '/sites/0001clienta': [U4] });
    assert.match(fromPlan.reg.parameters.bindingsPlan.sha256, /^[0-9a-f]{64}$/);

    const both = await registerOf(['--bindings-plan', planFile, '--site-guests', `0001CLIENTA=${U3}`]);
    assert.equal(both.row.d3.suspect, false);

    const noVersions = await registerOf(['--site-guests', `0001CLIENTA=${U3}`, '--no-versions']);
    assert.ok(noVersions.row.d3.flags.includes('versions_unreadable'));
    assert.equal(noVersions.row.d3.suspect, true, 'an unread version history fails closed');
  });

  test('prints the taxonomy folders at each root; an expected one not seen exits 3 with the register written', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'ir1-test-'));
    const base = [
      '--site', 'BCR=contoso.sharepoint.com:/sites/BCRGROUP',
      '--site', 'https://contoso.sharepoint.com/sites/0001CLIENTA',
      '--ingest-app-ids', INGEST,
    ];
    const registerIn = (dir) => JSON.parse(readFileSync(join(dir, readdirSync(dir).find((n) => n.endsWith('.json'))), 'utf8'));

    // 01_Faktury is locked (T-4) and this token cannot see it.
    const shortDir = mkdtempSync(join(tmpdir(), 'ir1-out-'));
    const short = run(
      [...base, '--expect-root-folders', 'BCR=98_nieposortowane,01_Faktury', '--out-dir', shortDir],
      tenant().fetch,
      outDir,
    );
    assert.equal(await short.promise, 3);
    const text = short.out.text();
    assert.match(text, /Dokumenty: taxonomy folders at the root: 98_Nieposortowane/);
    assert.match(text, /Dokumenty: taxonomy folders at the root: none seen/, 'the client site has none');
    assert.match(text, /INCOMPLETE[\s\S]*BCR: 01_Faktury/);
    assert.match(text, /Owner or site collection admin/);
    const reg = registerIn(shortDir);
    assert.equal(reg.complete, false);
    assert.deepEqual(reg.missingRootFolders, [{ sitePath: '/sites/bcrgroup', missing: ['01_Faktury'] }]);
    assert.deepEqual(reg.sites[0].drives[0].rootFolders, ['98_Nieposortowane']);

    const fullDir = mkdtempSync(join(tmpdir(), 'ir1-out-'));
    const full = run([...base, '--expect-root-folders', 'BCR=98_Nieposortowane', '--out-dir', fullDir], tenant().fetch, outDir);
    assert.equal(await full.promise, 0);
    assert.equal(registerIn(fullDir).complete, true);

    await assert.rejects(
      run([...base, '--expect-root-folders', 'NOPE=01_Faktury'], tenant().fetch, outDir).promise,
      /--expect-root-folders NOPE: not one of the --site values/,
    );
  });

  test('without --ir0 every file the ingestion wrote is suspect', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'ir1-test-'));
    const dir = mkdtempSync(join(tmpdir(), 'ir1-out-'));
    const { promise, out } = run(
      [
        '--site', 'https://contoso.sharepoint.com/sites/0001CLIENTA',
        '--ingest-app-ids', INGEST,
        '--site-guests', `0001CLIENTA=${U3}`,
        '--out-dir', dir,
      ],
      tenant().fetch,
      outDir,
    );
    assert.equal(await promise, 0);
    assert.match(out.text(), /no --ir0: [\s\S]*no_ir0_given/);
    const reg = JSON.parse(readFileSync(join(dir, readdirSync(dir).find((n) => n.endsWith('.json'))), 'utf8'));
    const d3 = reg.rows.find((r) => r.driveItemId === 'd3');
    assert.ok(d3.flags.includes('no_ir0_given'));
    assert.equal(d3.suspect, true);
  });

  test('refuses to run without --ingest-app-ids, a site, or with a bad drive name', async () => {
    const { fetch } = tenant();
    const outDir = mkdtempSync(join(tmpdir(), 'ir1-test-'));
    await assert.rejects(run(['--site', 'contoso.sharepoint.com:/sites/BCRGROUP'], fetch, outDir).promise, /--ingest-app-ids/);
    await assert.rejects(run(['--ingest-app-ids', INGEST], fetch, outDir).promise, /--site/);
    await assert.rejects(
      run(['--site', 'contoso.sharepoint.com:/sites/BCRGROUP', '--ingest-app-ids', INGEST, '--drive-name', 'Documents'], fetch, outDir).promise,
      /no drive named "Documents"; drives: Dokumenty/,
    );
    await assert.rejects(
      run(['--site', 'a=contoso.sharepoint.com:/sites/X', '--ingest-app-ids', INGEST, '--fallback-site', 'b'], fetch, outDir).promise,
      /not one of the --site values/,
    );
    await assert.rejects(
      run(['--site', 'a=contoso.sharepoint.com:/sites/X', '--ingest-app-ids', INGEST, '--site-guests', `b=${U3}`], fetch, outDir).promise,
      /--site-guests b: not one of the --site values/,
    );
    const notAPlan = join(outDir, 'not-a-plan.json');
    writeFileSync(notAPlan, JSON.stringify({ kind: 'something else', rows: [] }));
    await assert.rejects(
      run(['--site', 'a=contoso.sharepoint.com:/sites/X', '--ingest-app-ids', INGEST, '--bindings-plan', notAPlan], fetch, outDir).promise,
      /not a directory-bindings plan/,
    );
  });
});
