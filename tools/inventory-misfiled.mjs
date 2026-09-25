#!/usr/bin/env node
/**
 * IR-1: inventory of every file the ledger ingestion wrote, with the evidence
 * of whose it is. Read-only. It moves nothing and deletes nothing.
 *
 * ## What it produces
 *
 * One register row per file that the ingestion identity created or last
 * modified (or that the IR-0 export names), on the sites given with `--site`
 * (in the incident: BCR GROUP, PESKOVOI and TEST):
 *
 *   driveItemId, path, created/modified time, createdBy.application.id, size,
 *   every version with its size and time,
 *   and, joined on driveItemId from the IR-0 App Insights export: the routing
 *   (fallback or directory), whether content promotion moved it, the
 *   uploader's AAD object id, and the site the log says it went to.
 *
 * Rows get flags; a row with any "suspect" flag needs a decision in IR-2
 * (see tools/README.md for the meaning of each flag). IR-0 uploads that the
 * walk did not find are rows too: a file promoted into a client site that was
 * not walked is exactly the case that matters most.
 *
 * An upload routed by identity is clean only if its uploader is a guest of
 * the site's own Team. Those guests come from `--site-guests` or a
 * `directory-bindings.mjs propose` plan (`--bindings-plan`); without either,
 * every identity-routed item is suspect (`uploader_guest_unverified`).
 * Sharing links are not read here: IR-2 checks them per item.
 *
 * Output: a JSON register (with parameters, input hashes and a summary) and a
 * CSV of the same rows, both in tools/out/ with their sha256 printed.
 *
 * ## Safety
 *
 * GET requests only, and the token (GRAPH_TOKEN) is never printed. The
 * register holds file names and ids of client documents: it is written
 * owner-only (0600) under tools/out/, which git ignores, and belongs in the
 * IR-0 evidence store, not in a chat or a ticket.
 */

import {
  CliError,
  bad,
  bold,
  csvList,
  dim,
  isMain,
  ok,
  outPath,
  parseCli,
  readJsonFile,
  runMain,
  stamp,
  toCsv,
  warn,
  writeJsonFile,
  writePrivateFile,
} from './lib/cli.mjs';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { GraphError, createGraph, describeToken, encodePath, mapLimit } from './lib/graph.mjs';
import { normalizeGuid, normalizeSitePath } from './lib/bindings.mjs';
import {
  REGISTER_COLUMNS,
  REGISTER_KIND,
  buildRegister,
  dedupeTraces,
  indexIr0,
  isCandidate,
  parseIr0Export,
  parseSiteGuests,
  parseSiteSpec,
  siteGuestsFromPlan,
  summarizeRegister,
} from './lib/misfiled.mjs';

const USAGE = `
Usage:
  node tools/inventory-misfiled.mjs --site <[label=]host:/sites/Path> [--site ...]
       --ingest-app-ids <appId[,appId]> [--drive-name Dokumenty]... [--all-drives]
       [--ir0 <export.json|dir>]... [--fallback-site <label|/sites/Path>]...
       [--site-guests <label>=<oid,oid,...>]... [--bindings-plan <plan.json>]
       [--all-items] [--no-versions] [--window-ms 10000] [--concurrency 4] [--out-dir <dir>]

  --site            a site to walk; repeat for each (BCR GROUP, PESKOVOI, TEST)
  --ingest-app-ids  app (client) id(s) the ingestion wrote as (createdBy.application.id)
  --drive-name      document library to walk, exact Graph drive name (default "Dokumenty")
  --all-drives      walk every document library of each site instead
  --ir0             IR-0 App Insights export(s) (tools/ir0/export-appinsights.sh output);
                    a directory means every *.json in it
  --fallback-site   which walked site was the fallback bucket (BCR GROUP)
  --site-guests     the guests of a site's own Team (object ids); repeat per site
  --bindings-plan   a directory-bindings.mjs propose plan: the guests of each row's Team
                    Without either, every upload routed by identity is suspect.
  --all-items       register every file, not only the ingestion's
  --no-versions     skip the per-file versions call (every row then reads versions_unreadable)

Environment: GRAPH_TOKEN (delegated; Sites.Read.All or Files.Read.All). Read-only.
`.trim();

const OPTIONS = {
  help: { type: 'boolean', short: 'h' },
  site: { type: 'string', multiple: true },
  'ingest-app-ids': { type: 'string', multiple: true },
  'drive-name': { type: 'string', multiple: true },
  'all-drives': { type: 'boolean' },
  ir0: { type: 'string', multiple: true },
  'fallback-site': { type: 'string', multiple: true },
  'site-guests': { type: 'string', multiple: true },
  'bindings-plan': { type: 'string' },
  'all-items': { type: 'boolean' },
  'no-versions': { type: 'boolean' },
  'window-ms': { type: 'string' },
  concurrency: { type: 'string' },
  'out-dir': { type: 'string' },
};

const ITEM_SELECT =
  'id,name,size,file,folder,package,parentReference,createdDateTime,lastModifiedDateTime,' +
  'createdBy,lastModifiedBy,webUrl';

function ir0Files(specs) {
  const files = [];
  for (const spec of specs) {
    let st;
    try {
      st = statSync(spec);
    } catch {
      throw new CliError(`--ir0 ${spec}: no such file or directory`);
    }
    if (st.isDirectory()) {
      const inDir = readdirSync(spec)
        .filter((n) => n.endsWith('.json'))
        .sort()
        .map((n) => join(spec, n));
      if (!inDir.length) throw new CliError(`--ir0 ${spec}: no *.json files in it`);
      files.push(...inDir);
    } else {
      files.push(spec);
    }
  }
  return files;
}

/** Breadth-first walk of a drive. Folders are listed `concurrency` at a time. */
export async function walkDrive(graph, driveId, { concurrency = 4, onLevel = () => {} } = {}) {
  const drive = encodeURIComponent(driveId);
  const files = [];
  let folders = 0;
  let other = 0;
  let level = [{ id: null, path: '' }];
  let depth = 0;
  while (level.length) {
    const next = [];
    await mapLimit(level, concurrency, async (folder) => {
      const base = folder.id
        ? `/drives/${drive}/items/${encodeURIComponent(folder.id)}/children`
        : `/drives/${drive}/root/children`;
      const children = await graph.all(`${base}?$select=${ITEM_SELECT}&$top=200`);
      for (const c of children) {
        const path = `${folder.path}/${c.name}`;
        if (c.folder) {
          folders += 1;
          next.push({ id: c.id, path });
        } else if (c.file) {
          files.push({ ...c, path, parentPath: folder.path });
        } else {
          other += 1;
        }
      }
    });
    depth += 1;
    onLevel({ depth, folders, files: files.length });
    level = next;
  }
  return { files, folders, other };
}

export async function main(argv, deps = {}) {
  const { values, positionals } = parseCli(argv, OPTIONS);
  const print = deps.print ?? ((line = '') => process.stdout.write(`${line}\n`));
  if (values.help) {
    print(USAGE);
    return 0;
  }
  if (positionals.length) throw new CliError(`unexpected argument "${positionals[0]}"`);
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => new Date());

  // --- inputs -------------------------------------------------------------
  const siteSpecs = values.site ?? [];
  if (!siteSpecs.length) throw new CliError('pass at least one --site');
  let sites;
  try {
    sites = siteSpecs.map(parseSiteSpec);
  } catch (err) {
    throw new CliError(err.message);
  }
  const labels = sites.map((s) => s.label.toLowerCase());
  if (new Set(labels).size !== labels.length) throw new CliError('two --site values share a label');

  const ingestAppIds = csvList(values['ingest-app-ids'] ?? env.INGEST_APP_IDS);
  if (!ingestAppIds.length) {
    throw new CliError(
      '--ingest-app-ids is required: the register is "what the ingestion wrote". ' +
        'Run once with --all-items to see which application ids created files.',
    );
  }
  const badIds = ingestAppIds.filter((id) => !normalizeGuid(id));
  if (badIds.length) throw new CliError(`--ingest-app-ids: not GUIDs: ${badIds.join(', ')}`);
  const ingestSet = new Set(ingestAppIds.map(normalizeGuid));

  const fallbackSitePaths = new Set();
  for (const f of csvList(values['fallback-site'])) {
    const match = sites.find(
      (s) => s.label.toLowerCase() === f.toLowerCase() || normalizeSitePath(s.sitePath) === normalizeSitePath(f),
    );
    if (!match) throw new CliError(`--fallback-site ${f}: not one of the --site values`);
    fallbackSitePaths.add(normalizeSitePath(match.sitePath));
  }

  // Guests of each site's own Team: an identity-routed upload by anyone else
  // (staff, most of all) is suspect. With no list, all of them are.
  let siteGuests = null;
  let bindingsPlanInput = null;
  let sharedPlanSites = [];
  if (values['bindings-plan'] || values['site-guests']?.length) {
    siteGuests = new Map();
    if (values['bindings-plan']) {
      const { data, sha256 } = readJsonFile(values['bindings-plan']);
      let fromPlan;
      try {
        fromPlan = siteGuestsFromPlan(data);
      } catch (err) {
        throw new CliError(`--bindings-plan ${values['bindings-plan']}: ${err.message}`);
      }
      bindingsPlanInput = { path: values['bindings-plan'], sha256, createdAt: data.createdAt ?? '' };
      sharedPlanSites = fromPlan.sharedSites;
      for (const [site, ids] of fromPlan.guests) siteGuests.set(site, new Set(ids));
    }
    let explicit;
    try {
      explicit = parseSiteGuests(values['site-guests'], sites);
    } catch (err) {
      throw new CliError(err.message);
    }
    for (const [site, ids] of explicit) {
      if (!siteGuests.has(site)) siteGuests.set(site, new Set());
      for (const id of ids) siteGuests.get(site).add(id);
    }
  }

  const driveNames = values['all-drives'] ? [] : csvList(values['drive-name'] ?? ['Dokumenty']);
  if (values['all-drives'] && values['drive-name']) {
    throw new CliError('--all-drives and --drive-name are exclusive');
  }
  const windowMs = Number(values['window-ms'] ?? 10_000);
  if (!Number.isFinite(windowMs) || windowMs < 0) throw new CliError('--window-ms must be >= 0');
  const concurrency = Number(values.concurrency ?? 4);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) {
    throw new CliError('--concurrency must be 1..16');
  }
  if (!env.GRAPH_TOKEN) {
    throw new CliError('no GRAPH_TOKEN in the environment. See tools/README.md, "Authentication".');
  }

  print('');
  print(bold('IR-1 inventory of ingestion-written files (read-only)'));
  const claims = describeToken(env.GRAPH_TOKEN);
  if (claims?.expiresAt && claims.expiresAt.getTime() <= now().getTime()) {
    throw new CliError(`GRAPH_TOKEN expired at ${claims.expiresAt.toISOString()}`);
  }
  print(`  token      ${claims?.who ?? dim('(claims unreadable)')}`);
  print(`  sites      ${sites.map((s) => `${s.label}=${s.sitePath}`).join(', ')}`);
  print(`  drives     ${driveNames.length ? driveNames.join(', ') : 'all document libraries'}`);
  print(`  ingest     ${ingestAppIds.join(', ')}`);
  if (!fallbackSitePaths.size) {
    print(warn('  no --fallback-site: files in the fallback bucket are not flagged as such'));
  }
  if (!siteGuests) {
    print(
      warn(
        '  no --site-guests or --bindings-plan: every upload routed by identity is suspect ' +
          '(uploader_guest_unverified)',
      ),
    );
  } else {
    for (const s of sites) {
      const ids = siteGuests.get(normalizeSitePath(s.sitePath));
      print(`  guests     ${s.label}: ${ids ? `${ids.size} guest id(s)` : warn('none given (unverified)')}`);
    }
    if (bindingsPlanInput) print(dim(`             from plan ${bindingsPlanInput.path} made ${bindingsPlanInput.createdAt}`));
    for (const shared of sharedPlanSites) {
      print(warn(`             ${shared}: several plan rows name this site; its guests are not used`));
    }
  }

  // --- IR-0 ---------------------------------------------------------------
  const ir0Inputs = [];
  let ir0 = null;
  let ir0Stats = null;
  if (values.ir0?.length) {
    const records = [];
    for (const file of ir0Files(values.ir0)) {
      const { data, sha256 } = readJsonFile(file);
      let parsed;
      try {
        parsed = parseIr0Export(data);
      } catch (err) {
        throw new CliError(`${file}: ${err.message}`);
      }
      records.push(...parsed);
      ir0Inputs.push({ path: file, sha256, traces: parsed.length });
    }
    const unique = dedupeTraces(records);
    const indexed = indexIr0(unique, { windowMs });
    ir0 = indexed.byDriveItemId;
    ir0Stats = indexed.stats;
    print(
      `  IR-0       ${ir0Inputs.length} file(s), ${unique.length} traces ` +
        `(${records.length - unique.length} repeats dropped), ` +
        `${ir0Stats.uploads} uploads of ${ir0Stats.uniqueDriveItems} items ` +
        `(${ir0Stats.fallback} fallback, ${ir0Stats.promoted} promoted)`,
    );
    if (ir0Stats.uploadsWithoutBatch) {
      print(warn(`             ${ir0Stats.uploadsWithoutBatch} upload(s) with no "client resolved" line`));
    }
  } else {
    print(warn('  no --ir0: rows carry no routing evidence and no uploader id'));
  }

  // --- walk ---------------------------------------------------------------
  const graph = createGraph({
    token: env.GRAPH_TOKEN,
    ...(deps.graphFetch ? { fetch: deps.graphFetch } : {}),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
    onRetry: ({ attempt, status, waitMs, path }) =>
      print(dim(`  … Graph ${status || 'network error'} on ${path}; retry ${attempt} in ${waitMs} ms`)),
  });

  const walked = [];
  const siteReport = [];
  const creatorApps = new Map();
  for (const site of sites) {
    print('');
    print(bold(`${site.label} · ${site.hostname}:${site.sitePath}`));
    const resolved = await graph.get(
      `/sites/${site.hostname}:/${encodePath(site.sitePath.replace(/^\/+/, ''))}?$select=id,webUrl,displayName`,
    );
    const drives = await graph.all(`/sites/${resolved.id}/drives?$select=id,name,driveType,webUrl`);
    const chosen = driveNames.length
      ? driveNames.map((name) => {
          const d = drives.find((x) => x.name === name);
          if (!d) {
            throw new CliError(
              `${site.label}: no drive named "${name}"; drives: ${drives.map((x) => x.name).join(', ')}`,
            );
          }
          return d;
        })
      : drives.filter((d) => d.driveType === 'documentLibrary');
    const report = { ...site, siteId: resolved.id, webUrl: resolved.webUrl, drives: [] };
    siteReport.push(report);
    for (const drive of chosen) {
      const result = await walkDrive(graph, drive.id, {
        concurrency,
        onLevel: ({ depth, folders, files }) =>
          print(dim(`  ${drive.name}: depth ${depth}, ${folders} folders, ${files} files`)),
      });
      for (const f of result.files) {
        const app = f.createdBy?.application;
        if (app?.id) {
          const key = normalizeGuid(app.id) || app.id;
          const e = creatorApps.get(key) ?? { appId: key, displayName: app.displayName ?? '', files: 0 };
          e.files += 1;
          creatorApps.set(key, e);
        }
      }
      report.drives.push({
        id: drive.id,
        name: drive.name,
        files: result.files.length,
        folders: result.folders,
        otherItems: result.other,
      });
      walked.push({ site, drive: { id: drive.id, name: drive.name }, items: result.files });
      print(`  ${drive.name}: ${ok(`${result.files.length} files`)} in ${result.folders} folders`);
    }
  }

  // --- versions -------------------------------------------------------------
  const candidates = walked.flatMap((w) =>
    w.items
      .filter((item) => isCandidate(item, { ingestAppIds: ingestSet, ir0, includeAll: values['all-items'] }))
      .map((item) => ({ item, drive: w.drive })),
  );
  if (values['no-versions']) {
    // An unknown version count may hide an earlier document: fail closed.
    for (const { item } of candidates) item.versionsError = 'not read (--no-versions)';
  } else {
    print('');
    print(dim(`reading versions of ${candidates.length} file(s)…`));
    await mapLimit(candidates, concurrency, async ({ item, drive }) => {
      try {
        item.versions = await graph.all(
          `/drives/${encodeURIComponent(drive.id)}/items/${encodeURIComponent(item.id)}/versions`,
        );
      } catch (err) {
        item.versionsError = err instanceof GraphError ? `${err.status} ${err.code}` : String(err.message);
      }
    });
  }

  // --- register -------------------------------------------------------------
  const rows = buildRegister({
    walked,
    ir0,
    ingestAppIds: ingestSet,
    fallbackSitePaths,
    siteGuests,
    includeAll: Boolean(values['all-items']),
  });
  const summary = summarizeRegister(rows);
  const createdAt = now();
  const base = `ir1-inventory-${stamp(createdAt)}`;
  const outDir = values['out-dir'] ?? deps.outDir;
  const register = {
    kind: REGISTER_KIND,
    version: 1,
    createdAt: createdAt.toISOString(),
    operator: claims?.who ?? '',
    parameters: {
      sites: siteSpecs,
      driveNames,
      allDrives: Boolean(values['all-drives']),
      ingestAppIds,
      fallbackSites: [...fallbackSitePaths],
      siteGuests: siteGuests
        ? Object.fromEntries([...siteGuests].map(([site, ids]) => [site, [...ids].sort()]))
        : null,
      bindingsPlan: bindingsPlanInput,
      sharedPlanSites,
      allItems: Boolean(values['all-items']),
      versions: !values['no-versions'],
      windowMs,
    },
    ir0Inputs,
    ir0Stats,
    sites: siteReport,
    creatorApps: [...creatorApps.values()].sort((a, b) => b.files - a.files),
    summary,
    rows,
  };
  const json = writeJsonFile(outPath(outDir, `${base}.json`), register);
  const csv = writePrivateFile(outPath(outDir, `${base}.csv`), toCsv(rows, REGISTER_COLUMNS));

  print('');
  print(bold('Applications that created files (check --ingest-app-ids against this)'));
  for (const a of register.creatorApps) {
    const mark = ingestSet.has(a.appId) ? ok('ingest') : dim('other ');
    print(`  ${mark} ${a.appId} ${a.displayName} · ${a.files} file(s)`);
  }
  print('');
  print(bold('Register'));
  print(`  ${summary.rows} row(s), ${summary.suspect ? bad(`${summary.suspect} suspect`) : ok('0 suspect')}`);
  for (const [site, s] of Object.entries(summary.bySite)) {
    print(`  ${site.padEnd(24)} ${s.rows} row(s), ${s.suspect} suspect`);
  }
  for (const [flag, n] of Object.entries(summary.byFlag).sort((a, b) => b[1] - a[1])) {
    print(`    ${flag.padEnd(28)} ${n}`);
  }
  print('');
  print(`  json    ${json.path}`);
  print(`  sha256  ${json.sha256}`);
  print(`  csv     ${csv.path}`);
  print(`  sha256  ${csv.sha256}`);
  print('');
  print('Store both files, and their hashes, in the IR-0 evidence container');
  print('(infrastructure/ir/evidence-store.sh). Nothing was moved or deleted.');
  print('');
  return 0;
}

if (isMain(import.meta.url)) runMain(main);
