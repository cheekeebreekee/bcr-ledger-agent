#!/usr/bin/env node
/**
 * Binds each client row of the Client Directory to its own Team's
 * "Dokumenty księgowe" channel folder and to that Team's guests.
 *
 * ## Why
 *
 * Onboarding writes client rows with `RootFolder = ''` and no
 * `UserAadObjectIds`. The first sends every upload to the library root, where
 * the channel's Shared tab never shows it (R5). The second makes every
 * client's upload "unknown", which Phase 0 now sends to quarantine (R1). This
 * tool fills both from Graph, per row, with a reviewed plan in between:
 *
 *   check     report what each Active row is bound to and what is wrong
 *   propose   compute the binding and write a plan file for review
 *   apply     apply a reviewed plan (PATCH list item fields), with a log
 *   rollback  restore the before-state from an apply log
 *   --add-columns   create the DriveId and TeamId text columns if missing
 *
 * ## Safety model
 *
 * - Read-only unless `--apply`. `apply`, `rollback` and `--add-columns`
 *   without `--apply` print what they would do and write nothing.
 * - Only four columns are ever written: RootFolder, UserAadObjectIds, DriveId
 *   and TeamId. Nothing else on a row, and never a Team, channel, group,
 *   permission or visibility. BCR GROUP's visibility is read, never changed.
 * - Ambiguity skips the row: a guest in several BCR teams, a duplicate key,
 *   a Public team, a missing or non-standard channel, a drive mismatch, an
 *   unknown write grant. Staff (Member) ids are removed from a client row only
 *   with `--confirm-remove-staff <listItemId>` for that row.
 * - `apply` refuses a plan that was edited after `propose` (digest), is older
 *   than `--max-plan-age-hours`, or whose row changed since (stale guard). It
 *   refuses to run unless the ingestion `/api/health` shows the P0 build.
 * - Every applied row is logged before and after, written after each row, so
 *   `rollback` works even after an interrupted run.
 * - The token is read from `GRAPH_TOKEN` and never printed.
 *
 * See tools/README.md for scopes and the full procedure.
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
  warn,
  writeJsonFile,
} from './lib/cli.mjs';
import { GraphError, createGraph, describeToken, encodePath, mapLimit } from './lib/graph.mjs';
import {
  BINDING_FIELDS,
  CHANNEL_NAME,
  GUARD_FIELDS,
  LOG_KIND,
  NEW_COLUMNS,
  ROLLBACK_KIND,
  assessRow,
  buildPlan,
  changedSinceApply,
  fieldString,
  findDuplicates,
  findTeamForSite,
  healthSatisfies,
  mapSitesToTeams,
  normalizeGuid,
  normalizeSitePath,
  parseDirectoryRow,
  pickAccountingChannel,
  pickFields,
  rollbackPatch,
  splitLines,
  staleFields,
  validatePlan,
} from './lib/bindings.mjs';

const USAGE = `
Usage:
  node tools/directory-bindings.mjs check    [common] [--out <report.json>]
  node tools/directory-bindings.mjs propose  [common] [--out <plan.json>]
            [--write-verified <sitePath|listItemId>]... [--confirm-remove-staff <listItemId>]...
  node tools/directory-bindings.mjs apply    --plan <plan.json> --health-url <url>
            --expect-health <key=value>... [--only <listItemId>]... [--max-plan-age-hours 24] [--apply]
  node tools/directory-bindings.mjs rollback --log <apply-log.json> [--apply]
  node tools/directory-bindings.mjs --add-columns [--site-id ..] [--list-id ..] [--apply]

Common:
  --site-id <id>              Graph site id of the Client Directory site
                              (env DIRECTORY_SITE_ID or CLIENT_DIRECTORY_SITE_ID)
  --list-id <id>              Client Directory list id
                              (env DIRECTORY_LIST_ID or CLIENT_DIRECTORY_LIST_ID)
  --ingest-app-ids <a,b>      app (client) ids of the ingestion identity (env INGEST_APP_IDS)
  --forbidden-site-paths <a,b>  rows targeting these are skipped (env FORBIDDEN_TARGET_SITE_PATHS)
  --channel-name <name>       default "${CHANNEL_NAME}"
  --concurrency <n>           parallel Graph requests, default 4

Environment: GRAPH_TOKEN (delegated Graph token; see tools/README.md).
Nothing is written without --apply.
`.trim();

const OPTIONS = {
  help: { type: 'boolean', short: 'h' },
  apply: { type: 'boolean' },
  'add-columns': { type: 'boolean' },
  'site-id': { type: 'string' },
  'list-id': { type: 'string' },
  'ingest-app-ids': { type: 'string', multiple: true },
  'forbidden-site-paths': { type: 'string', multiple: true },
  'write-verified': { type: 'string', multiple: true },
  'confirm-remove-staff': { type: 'string', multiple: true },
  'channel-name': { type: 'string' },
  concurrency: { type: 'string' },
  out: { type: 'string' },
  plan: { type: 'string' },
  log: { type: 'string' },
  only: { type: 'string', multiple: true },
  'health-url': { type: 'string' },
  'expect-health': { type: 'string', multiple: true },
  'max-plan-age-hours': { type: 'string' },
};

/** Which flags each command accepts. A flag outside its command is refused, not ignored. */
const ALLOWED = {
  check: ['site-id', 'list-id', 'ingest-app-ids', 'forbidden-site-paths', 'write-verified',
    'confirm-remove-staff', 'channel-name', 'concurrency', 'out'],
  propose: ['site-id', 'list-id', 'ingest-app-ids', 'forbidden-site-paths', 'write-verified',
    'confirm-remove-staff', 'channel-name', 'concurrency', 'out'],
  apply: ['plan', 'apply', 'only', 'health-url', 'expect-health', 'max-plan-age-hours', 'site-id',
    'list-id', 'out'],
  rollback: ['log', 'apply', 'out'],
  'add-columns': ['add-columns', 'apply', 'site-id', 'list-id'],
};

const SITE_ID = /^[a-z0-9.-]+,[0-9a-f-]{36},[0-9a-f-]{36}$/i;

/**
 * @param {string[]} argv
 * @param {object} [deps]  Injected for tests: `env`, `print`, `graphFetch`,
 *   `healthFetch`, `sleep`, `now`, `outDir`.
 * @returns {Promise<number>} exit code
 */
export async function main(argv, deps = {}) {
  const { values, positionals } = parseCli(argv, OPTIONS);
  const print = deps.print ?? ((line = '') => process.stdout.write(`${line}\n`));
  if (values.help) {
    print(USAGE);
    return 0;
  }
  let command = positionals[0];
  if (values['add-columns']) {
    if (command && command !== 'add-columns') {
      throw new CliError(`--add-columns cannot be combined with "${command}"`);
    }
    command = 'add-columns';
  }
  if (!command || !ALLOWED[command]) {
    print(USAGE);
    throw new CliError(command ? `unknown command "${command}"` : 'no command given');
  }
  if (positionals.length > 1) throw new CliError(`unexpected argument "${positionals[1]}"`);
  const stray = Object.keys(values).filter((k) => k !== 'help' && !ALLOWED[command].includes(k));
  if (stray.length) {
    throw new CliError(`${stray.map((s) => `--${s}`).join(', ')} not valid for "${command}"`);
  }

  const env = deps.env ?? process.env;
  const ctx = {
    print,
    env,
    values,
    now: deps.now ?? (() => new Date()),
    outDir: deps.outDir,
    healthFetch: deps.healthFetch ?? globalThis.fetch,
    graph: () =>
      createGraph({
        token: env.GRAPH_TOKEN,
        ...(deps.graphFetch ? { fetch: deps.graphFetch } : {}),
        ...(deps.sleep ? { sleep: deps.sleep } : {}),
        onRetry: ({ attempt, status, waitMs, path }) =>
          print(dim(`  … Graph ${status || 'network error'} on ${path}; retry ${attempt} in ${waitMs} ms`)),
      }),
  };

  switch (command) {
    case 'check':
      return runCheck(ctx);
    case 'propose':
      return runPropose(ctx);
    case 'apply':
      return runApply(ctx);
    case 'rollback':
      return runRollback(ctx);
    default:
      return runAddColumns(ctx);
  }
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

function directoryIds(values, env, { required = true } = {}) {
  const siteId = values['site-id'] ?? env.DIRECTORY_SITE_ID ?? env.CLIENT_DIRECTORY_SITE_ID;
  const listId = values['list-id'] ?? env.DIRECTORY_LIST_ID ?? env.CLIENT_DIRECTORY_LIST_ID;
  if (required && (!siteId || !listId)) {
    throw new CliError(
      'the Client Directory is not named: pass --site-id and --list-id, or set ' +
        'DIRECTORY_SITE_ID and DIRECTORY_LIST_ID',
    );
  }
  if (siteId && !SITE_ID.test(siteId)) {
    throw new CliError('--site-id must be a Graph site id: <hostname>,<siteGuid>,<webGuid>');
  }
  return { siteId, listId };
}

function listPath({ siteId, listId }) {
  return `/sites/${siteId}/lists/${encodeURIComponent(listId)}`;
}

function concurrencyOf(values) {
  const n = Number(values.concurrency ?? 4);
  if (!Number.isInteger(n) || n < 1 || n > 16) throw new CliError('--concurrency must be 1..16');
  return n;
}

function assessOptions(values, env) {
  const ingestAppIds = csvList(values['ingest-app-ids'] ?? env.INGEST_APP_IDS);
  const badIds = ingestAppIds.filter((id) => !normalizeGuid(id));
  if (badIds.length) throw new CliError(`--ingest-app-ids: not GUIDs: ${badIds.join(', ')}`);
  const forbidden = csvList(values['forbidden-site-paths'] ?? env.FORBIDDEN_TARGET_SITE_PATHS);
  const writeVerified = new Set();
  for (const v of csvList(values['write-verified'])) {
    writeVerified.add(v);
    writeVerified.add(normalizeSitePath(v));
  }
  return {
    ingestAppIds,
    forbidden,
    ctx: {
      forbiddenSitePaths: new Set(forbidden.map(normalizeSitePath)),
      ingestAppIds: new Set(ingestAppIds.map(normalizeGuid)),
      writeVerified,
      confirmRemoveStaff: new Set(csvList(values['confirm-remove-staff'])),
      channelName: values['channel-name'] ?? CHANNEL_NAME,
    },
  };
}

function tokenBanner(ctx) {
  if (!ctx.env.GRAPH_TOKEN) {
    throw new CliError('no GRAPH_TOKEN in the environment. See tools/README.md, "Authentication".');
  }
  const claims = describeToken(ctx.env.GRAPH_TOKEN);
  if (!claims) {
    ctx.print(`  token      ${dim('(claims unreadable)')}`);
    return;
  }
  if (claims.expiresAt && claims.expiresAt.getTime() <= ctx.now().getTime()) {
    throw new CliError(`GRAPH_TOKEN expired at ${claims.expiresAt.toISOString()}; get a new one`);
  }
  const scopes = claims.scopes || (claims.roles.length ? claims.roles.join(' ') : '(none)');
  ctx.print(`  token      ${claims.who ?? '?'} · expires ${claims.expiresAt?.toISOString() ?? '?'}`);
  ctx.print(`  scopes     ${dim(scopes)}`);
}

// ---------------------------------------------------------------------------
// Graph facts
// ---------------------------------------------------------------------------

const TEAMS_QUERY =
  "/groups?$filter=resourceProvisioningOptions/Any(x:x eq 'Team')" +
  '&$select=id,displayName,description,visibility,resourceProvisioningOptions&$top=999';

const isUser = (o) => !o?.['@odata.type'] || o['@odata.type'] === '#microsoft.graph.user';
const isGroup = (o) => !o?.['@odata.type'] || o['@odata.type'] === '#microsoft.graph.group';
const isErr = (v) => Boolean(v && typeof v === 'object' && 'error' in v);

/** The value, or `{ error, status }`. A failed lookup is a fact, and it skips the row. */
async function safe(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof GraphError) return { error: err.message, status: err.status };
    return { error: String(err?.message ?? err), status: 0 };
  }
}

async function lookupUser(graph, id) {
  try {
    return await graph.get(
      `/users/${id}?$select=id,displayName,userPrincipalName,userType,accountEnabled`,
    );
  } catch (err) {
    if (err instanceof GraphError && err.status === 404) return null;
    return { error: err instanceof GraphError ? `${err.status} ${err.code}` : String(err) };
  }
}

async function readFilesFolder(graph, teamId, channelId) {
  const ff = await safe(() =>
    graph.get(`/teams/${teamId}/channels/${encodeURIComponent(channelId)}/filesFolder`),
  );
  if (isErr(ff)) {
    return ff.status === 404
      ? { error: 'filesFolder not provisioned yet (open the channel Files tab once)', status: 404 }
      : ff;
  }
  const driveId = ff.parentReference?.driveId;
  if (!driveId || !ff.id) return { error: 'filesFolder has no id or parentReference.driveId' };
  const drive = encodeURIComponent(driveId);
  const [item, root] = await Promise.all([
    safe(() => graph.get(`/drives/${drive}/items/${ff.id}?$select=id,name,parentReference,webUrl`)),
    safe(() => graph.get(`/drives/${drive}/root?$select=id`)),
  ]);
  if (isErr(item)) return item;
  if (isErr(root)) return root;
  return {
    id: item.id,
    name: item.name,
    webUrl: item.webUrl ?? ff.webUrl,
    parentReference: { ...ff.parentReference, ...item.parentReference },
    driveRootId: root.id,
  };
}

/** `/sites/{id}/permissions`, or `null` with a note when the caller cannot read it. */
async function readPermissions(graph, siteId) {
  try {
    return { permissions: await graph.all(`/sites/${siteId}/permissions`) };
  } catch (err) {
    const status = err instanceof GraphError ? err.status : 0;
    const note =
      status === 401 || status === 403
        ? 'caller cannot read site permissions (needs Sites.FullControl.All)'
        : `site permissions unreadable: ${err.message}`;
    return { permissions: null, note };
  }
}

/**
 * Everything `check` and `propose` need, read once. Nothing here decides; the
 * decisions are `assessRow` and `buildPlan` in lib/bindings.mjs.
 */
export async function gather(graph, { siteId, listId, channelName, concurrency, print }) {
  const items = await graph.all(`${listPath({ siteId, listId })}/items?expand=fields&$top=200`);
  const rows = items.map(parseDirectoryRow);
  const active = rows.filter((r) => r.active);
  const duplicates = findDuplicates(rows);
  print(dim(`  read ${rows.length} rows (${active.length} Active)`));

  const teams = await graph.all(TEAMS_QUERY);
  const teamSites = await mapLimit(teams, concurrency, async (team) => ({
    team,
    site: await safe(() => graph.get(`/groups/${team.id}/sites/root?$select=id,webUrl,name`)),
  }));
  const teamIndex = mapSitesToTeams(teamSites);
  print(dim(`  read ${teams.length} Teams (${teamIndex.unreadable.length} site(s) unreadable)`));

  const userIds = [...new Set(active.flatMap((r) => r.userIds))];
  const usersById = new Map(
    await mapLimit(userIds, concurrency, async (id) => [id, await lookupUser(graph, id)]),
  );

  const memberOfCache = new Map();
  const memberOf = (id) => {
    if (!memberOfCache.has(id)) {
      memberOfCache.set(
        id,
        safe(() => graph.all(`/users/${id}/memberOf?$select=id,displayName,description&$top=999`))
          .then((r) => (Array.isArray(r) ? r.filter(isGroup) : r)),
      );
    }
    return memberOfCache.get(id);
  };

  const factsByRow = new Map();
  await mapLimit(active, concurrency, async (row) => {
    const facts = { usersById };
    factsByRow.set(row.listItemId, facts);
    if (row.isAdmin || !row.siteHostname || !row.sitePath) return;

    const sitePath = encodePath(row.sitePath.replace(/^\/+/, ''));
    facts.site = await safe(() =>
      graph.get(`/sites/${row.siteHostname}:/${sitePath}?$select=id,webUrl,displayName`),
    );
    if (isErr(facts.site)) return;
    const site = facts.site.id;

    const [drives, perms] = await Promise.all([
      safe(() => graph.all(`/sites/${site}/drives?$select=id,name,driveType,webUrl`)),
      readPermissions(graph, site),
    ]);
    facts.drives = drives;
    facts.permissions = perms.permissions;
    if (perms.note) facts.permissionsNote = perms.note;

    const team = findTeamForSite(teamIndex, facts.site);
    facts.team = team;
    if (!team || isErr(team)) return;

    const [channels, members, owners] = await Promise.all([
      safe(() => graph.all(`/teams/${team.id}/channels?$select=id,displayName,membershipType`)),
      safe(() =>
        graph.all(`/groups/${team.id}/members?$select=id,displayName,userPrincipalName,userType&$top=999`),
      ),
      safe(() =>
        graph.all(`/groups/${team.id}/owners?$select=id,displayName,userPrincipalName,userType&$top=999`),
      ),
    ]);
    facts.channels = channels;
    facts.members = Array.isArray(members) ? members.filter(isUser) : members;
    facts.owners = owners;

    if (Array.isArray(channels)) {
      const pick = pickAccountingChannel(channels, channelName);
      if (pick.status === 'ok') facts.filesFolder = await readFilesFolder(graph, team.id, pick.channel.id);
    }

    if (Array.isArray(facts.members) && Array.isArray(owners)) {
      const ownerIds = new Set(owners.map((o) => normalizeGuid(o.id)));
      const guests = facts.members.filter(
        (m) => m.userType === 'Guest' && !ownerIds.has(normalizeGuid(m.id)),
      );
      // A failed read stays `{ error }`; classifyTeamPeople excludes that
      // guest as "memberships_unreadable" rather than guessing.
      facts.memberOfByUser = new Map(
        await Promise.all(guests.map(async (g) => [normalizeGuid(g.id), await memberOf(g.id)])),
      );
    }
  });

  return { rows, active, duplicates, teams, teamIndex, usersById, factsByRow };
}

function assessAll(gathered, assessCtx) {
  const ctx = {
    ...assessCtx,
    duplicates: gathered.duplicates,
    unreadableTeamSites: gathered.teamIndex.unreadable.length,
  };
  return gathered.active.map((row) =>
    assessRow(row, gathered.factsByRow.get(row.listItemId) ?? { usersById: gathered.usersById }, ctx),
  );
}

// ---------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------

const q = (s) => `'${String(s ?? '')}'`;

function describeRowIds(row, usersById, eligible) {
  const eligibleIds = new Set(eligible.map((g) => g.id));
  const parts = [...row.userIds].map((id) => {
    const u = usersById.get(id);
    if (u === null) return `${id} ${warn('not found')}`;
    if (!u) return `${id} ${dim('(not looked up)')}`;
    if (isErr(u)) return `${id} ${bad('lookup failed')}`;
    const who = u.userPrincipalName || u.displayName || '';
    if (u.userType === 'Member') return `${id} ${bad('STAFF (Member)')} ${who}`;
    const tag = eligibleIds.has(id) ? ok('guest of this team') : warn(`${u.userType ?? '?'}, not eligible`);
    return `${id} ${tag} ${who}`;
  });
  for (const raw of row.invalidUserIds) parts.push(`${q(raw)} ${bad('not a GUID')}`);
  return parts;
}

function printProblems(print, problems) {
  for (const p of problems) {
    const tag = p.severity === 'skip' ? bad('SKIP') : warn('WARN');
    print(`    ${tag} ${p.code} — ${p.detail}`);
  }
}

function printRowCheck(print, row, a, facts, usersById) {
  const e = a.evidence;
  print('');
  print(bold(`Row ${row.listItemId} · ClientId ${row.clientId || '?'} · ${q(row.title)} · ${row.sitePath || '(no site)'}`));
  if (row.isAdmin) print(`    ${dim('admin row (IsAdmin = true)')}`);
  if (facts?.site && !isErr(facts.site)) print(`    site       ${facts.site.webUrl ?? facts.site.id}`);
  if (e.teamId) print(`    team       ${q(e.teamDisplayName)} · ${e.visibility === 'Public' ? bad('Public') : e.visibility} · ${e.teamId}`);
  if (e.channelId) {
    const ch = (Array.isArray(facts?.channels) ? facts.channels : []).find((c) => c.id === e.channelId);
    print(`    channel    ${q(ch?.displayName)} · ${ch?.membershipType ?? '?'} · ${e.channelId}`);
  }
  if (e.filesFolderId) {
    const ff = facts.filesFolder;
    print(`    folder     ${q(e.filesFolderName)} · item ${e.filesFolderId} · drive ${ff?.parentReference?.driveId ?? '?'}`);
  }
  if (e.driveId) {
    const match = facts?.filesFolder?.parentReference?.driveId === e.driveId;
    print(`    drive      ${q(e.driveName)} → ${e.driveId}${e.filesFolderId ? (match ? ok(' (channel folder is in it)') : bad(' (channel folder is NOT in it)')) : ''}`);
  }
  const ids = describeRowIds(row, usersById, a.eligibleGuests);
  print(`    row ids    ${ids.length ? ids.join('\n               ') : dim('(none)')}`);
  if (a.eligibleGuests.length || a.excludedPeople.length) {
    const el = a.eligibleGuests.map((g) => `${g.userPrincipalName || g.displayName} ${dim(g.id)}`);
    print(`    guests     ${el.length ? el.join(', ') : warn('none eligible')}`);
    const ex = a.excludedPeople.filter((p) => p.reason !== 'not_a_guest' && p.reason !== 'owner');
    for (const p of ex) print(`               ${warn('excluded')} ${p.userPrincipalName || p.id} (${p.reason})`);
    const staffCount = a.excludedPeople.filter((p) => p.reason === 'not_a_guest').length;
    const ownerCount = a.excludedPeople.filter((p) => p.reason === 'owner').length;
    print(`               ${dim(`${staffCount} Member(s) and ${ownerCount} owner(s) of the team are never bound`)}`);
  }
  if (!row.isAdmin) {
    const w = e.writeGrant;
    const text =
      w === 'granted' ? ok('granted') :
      w === 'operator-verified' ? ok('verified by operator (--write-verified)') :
      w === 'missing' ? bad('missing') :
      w === 'n/a' ? dim('not checked (site not resolved)') : warn('unknown, verify via runbook');
    print(`    write      ${text}${facts?.permissionsNote ? dim(` (${facts.permissionsNote})`) : ''}`);
    print(`    bound now  RootFolder ${q(row.rootFolder)} · DriveId ${q(row.driveId)} · TeamId ${q(row.teamId)}`);
  }
  printProblems(print, a.problems);
  const skips = a.problems.filter((p) => p.severity === 'skip').length;
  print(`    → ${skips ? bad(`SKIP (${skips} reason${skips > 1 ? 's' : ''})`) : ok('ready for propose')}`);
}

function printDuplicates(print, duplicates) {
  print('');
  print(bold('Duplicates across Active rows'));
  if (!duplicates.length) print(`  ${ok('none')}`);
  for (const d of duplicates) {
    const effect = d.kind === 'userId' ? 'dropped for both by ingestion' : 'rows skipped';
    print(`  ${bad(d.kind)} ${d.key} → rows ${d.listItemIds.join(', ')} ${dim(`(${effect})`)}`);
  }
}

async function gatherAndAssess(ctx, heading) {
  const { values, env, print } = ctx;
  const ids = directoryIds(values, env);
  const opts = assessOptions(values, env);
  print('');
  print(bold(heading));
  print(`  directory  site ${ids.siteId} · list ${ids.listId}`);
  tokenBanner(ctx);
  const graph = ctx.graph();
  if (!opts.ingestAppIds.length) {
    print(warn('  no --ingest-app-ids: every write grant reads "unknown" and those rows are skipped'));
  }
  const gathered = await gather(graph, {
    ...ids,
    channelName: opts.ctx.channelName,
    concurrency: concurrencyOf(values),
    print,
  });
  const assessments = assessAll(gathered, opts.ctx);
  return { ids, opts, gathered, assessments };
}

async function runCheck(ctx) {
  const { print, values } = ctx;
  const { ids, opts, gathered, assessments } = await gatherAndAssess(
    ctx,
    'Client Directory binding check (read-only)',
  );
  printDuplicates(print, gathered.duplicates);
  if (gathered.teamIndex.unreadable.length) {
    print('');
    print(warn(`${gathered.teamIndex.unreadable.length} Team site(s) could not be read:`));
    for (const u of gathered.teamIndex.unreadable) print(`  ${u.displayName} ${dim(u.teamId)} — ${u.error}`);
  }
  const rowById = new Map(gathered.rows.map((r) => [r.listItemId, r]));
  for (const a of assessments) {
    const row = rowById.get(a.listItemId);
    printRowCheck(print, row, a, gathered.factsByRow.get(a.listItemId), gathered.usersById);
  }
  const ready = assessments.filter((a) => !a.problems.some((p) => p.severity === 'skip'));
  print('');
  print(bold('Summary'));
  print(`  ${assessments.length} Active row(s): ${ok(`${ready.length} ready`)}, ${bad(`${assessments.length - ready.length} skipped`)}`);
  print(`  ${gathered.rows.length - gathered.active.length} inactive row(s) not examined`);

  if (values.out) {
    const report = {
      kind: 'bcr.directory-bindings.check',
      createdAt: ctx.now().toISOString(),
      directory: ids,
      ingestAppIds: opts.ingestAppIds,
      duplicates: gathered.duplicates,
      unreadableTeamSites: gathered.teamIndex.unreadable,
      rows: assessments,
    };
    const written = writeJsonFile(values.out, report);
    print(`  report     ${written.path}  sha256 ${written.sha256}`);
  }
  print('');
  return 0;
}

// ---------------------------------------------------------------------------
// propose
// ---------------------------------------------------------------------------

function idList(text) {
  return splitLines(text);
}

function printPlanRow(print, r) {
  print('');
  const head = `Row ${r.listItemId} · ClientId ${r.clientId || '?'} · ${q(r.title)} · ${r.sitePath || ''}`;
  const tag = r.action === 'PATCH' ? ok('PATCH') : r.action === 'NOOP' ? dim('NOOP (already bound)') : bad('SKIP');
  print(`${bold(head)} → ${tag}`);
  for (const reason of r.reasons) print(`    ${bad('skip')} ${reason.code} — ${reason.detail}`);
  for (const w of r.warnings) print(`    ${warn('warn')} ${w.code} — ${w.detail}`);
  const show = r.action === 'PATCH' ? r.patch : r.proposed ?? {};
  const label = r.action === 'PATCH' ? '' : dim(' (not applied)');
  for (const field of BINDING_FIELDS) {
    if (!(field in show)) continue;
    if (r.action !== 'PATCH' && fieldString(r.before[field]) === fieldString(show[field])) continue;
    if (field === 'UserAadObjectIds') {
      print(`    ${field.padEnd(17)} [${idList(r.before[field]).join(', ')}] → [${idList(show[field]).join(', ')}]${label}`);
    } else {
      print(`    ${field.padEnd(17)} ${q(r.before[field])} → ${q(show[field])}${label}`);
    }
  }
  if (r.action === 'PATCH') {
    for (const u of r.removedUserIds) print(`      ${bad('-')} ${u.id} ${u.userPrincipalName ?? ''} (${u.reason})`);
    for (const u of r.addedUserIds) print(`      ${ok('+')} ${u.id} ${u.userPrincipalName ?? ''}`);
  }
}

async function runPropose(ctx) {
  const { print, values } = ctx;
  const { ids, opts, gathered, assessments } = await gatherAndAssess(
    ctx,
    'Client Directory binding proposal (read-only)',
  );
  printDuplicates(print, gathered.duplicates);
  const plan = buildPlan({
    rows: gathered.rows,
    assessments,
    directory: ids,
    ingestAppIds: opts.ingestAppIds,
    createdAt: ctx.now().toISOString(),
  });
  for (const r of plan.rows) printPlanRow(print, r);

  const count = (action) => plan.rows.filter((r) => r.action === action).length;
  const file = values.out ?? outPath(ctx.outDir, `directory-bindings-plan-${stamp(ctx.now())}.json`);
  const written = writeJsonFile(file, plan);
  print('');
  print(bold('Plan'));
  print(`  ${ok(`${count('PATCH')} PATCH`)} · ${dim(`${count('NOOP')} NOOP`)} · ${bad(`${count('SKIP')} SKIP`)}`);
  print(`  file    ${written.path}`);
  print(`  sha256  ${written.sha256}`);
  print('');
  print('Review the file, then dry-run the apply (nothing is written without --apply):');
  print(`  node tools/directory-bindings.mjs apply --plan ${written.path} \\`);
  print('    --health-url https://<ingestion-host>/api/health --expect-health <key=value>');
  print('');
  return 0;
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

async function checkHealth(ctx, url, expectations) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, missing: [`--health-url is not a URL: ${url}`] };
  }
  const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  if (parsed.protocol !== 'https:' && !local) {
    return { ok: false, missing: ['--health-url must be https'] };
  }
  try {
    // No Authorization header: the health route is anonymous, and the Graph
    // token must never be sent anywhere but Graph.
    const res = await ctx.healthFetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return { ok: false, missing: [`health answered HTTP ${res.status}`] };
    const body = await res.json();
    return healthSatisfies(body, expectations);
  } catch (err) {
    return { ok: false, missing: [`health unreachable: ${err.message}`] };
  }
}

function sameValue(field, a, b) {
  if (field === 'UserAadObjectIds') {
    const x = splitLines(a).map((s) => s.toLowerCase()).sort();
    const y = splitLines(b).map((s) => s.toLowerCase()).sort();
    return x.length === y.length && x.every((v, i) => v === y[i]);
  }
  return fieldString(a) === fieldString(b);
}

const snapshotFields = (fields) => ({
  ...pickFields(fields, BINDING_FIELDS),
  ...pickFields(fields, GUARD_FIELDS),
});

async function readItemFields(graph, directory, listItemId) {
  return graph.get(`${listPath(directory)}/items/${encodeURIComponent(listItemId)}/fields`);
}

async function requireColumns(graph, directory, fields) {
  const needed = fields.filter((f) => NEW_COLUMNS.includes(f));
  if (!needed.length) return;
  const cols = await graph.all(`${listPath(directory)}/columns?$select=name`);
  const have = new Set(cols.map((c) => c.name));
  const missing = needed.filter((f) => !have.has(f));
  if (missing.length) {
    throw new CliError(
      `the list has no ${missing.join(', ')} column(s). Create them first:\n` +
        '  node tools/directory-bindings.mjs --add-columns --apply',
    );
  }
}

async function runApply(ctx) {
  const { print, values } = ctx;
  const APPLY = Boolean(values.apply);
  if (!values.plan) throw new CliError('apply needs --plan <file> (written by propose)');
  const { data: plan, sha256: planSha256 } = readJsonFile(values.plan);
  const errors = validatePlan(plan);
  if (errors.length) throw new CliError(`the plan is not applicable:\n  - ${errors.join('\n  - ')}`);

  const maxAgeHours = Number(values['max-plan-age-hours'] ?? 24);
  if (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0) throw new CliError('--max-plan-age-hours must be > 0');
  const ageHours = (ctx.now().getTime() - Date.parse(plan.createdAt)) / 3_600_000;
  if (!Number.isFinite(ageHours) || ageHours > maxAgeHours || ageHours < -0.1) {
    throw new CliError(
      `the plan was made ${Number.isFinite(ageHours) ? ageHours.toFixed(1) : '?'} h ago; ` +
        `the limit is ${maxAgeHours} h. Team membership may have changed since. Re-run propose.`,
    );
  }

  const directory = plan.directory;
  const given = directoryIds(values, {}, { required: false });
  if ((given.siteId && given.siteId !== directory.siteId) || (given.listId && given.listId !== directory.listId)) {
    throw new CliError('--site-id/--list-id differ from the directory the plan was made for');
  }

  const only = new Set(csvList(values.only));
  const byId = new Map(plan.rows.map((r) => [r.listItemId, r]));
  for (const id of only) {
    if (!byId.has(id)) throw new CliError(`--only ${id}: no such row in the plan`);
    if (byId.get(id).action === 'SKIP') {
      throw new CliError(`--only ${id}: that row is SKIP in the plan and is never applied`);
    }
  }
  const selected = plan.rows.filter((r) => r.action === 'PATCH' && (!only.size || only.has(r.listItemId)));

  print('');
  print(bold(`Apply directory bindings — ${APPLY ? bad('APPLY') : 'DRY RUN (nothing is written)'}`));
  print(`  plan       ${values.plan}  sha256 ${planSha256}`);
  print(`  made       ${plan.createdAt} (${ageHours.toFixed(1)} h ago)`);
  print(`  directory  site ${directory.siteId} · list ${directory.listId}`);
  tokenBanner(ctx);
  print(`  rows       ${selected.length} PATCH selected · ${plan.rows.filter((r) => r.action === 'SKIP').length} SKIP refused · ${plan.rows.filter((r) => r.action === 'NOOP').length} NOOP`);

  // The P0 gate: bindings take effect through the P0 ingestion build (DriveId
  // check, quarantine, no promotion). Applying them to an older build would
  // route by them without those guards.
  const expectations = values['expect-health'] ?? [];
  if (!values['health-url'] || !expectations.length) {
    const msg =
      'apply needs --health-url https://<ingestion-host>/api/health and at least one ' +
      '--expect-health key=value that only the P0 build reports';
    if (APPLY) throw new CliError(msg);
    print(warn(`  health     not checked: ${msg}`));
  } else {
    const health = await checkHealth(ctx, values['health-url'], expectations);
    if (!health.ok) {
      const msg = `ingestion health does not show the P0 build: ${health.missing.join('; ')}`;
      if (APPLY) throw new CliError(msg);
      print(warn(`  health     ${msg} (apply would refuse)`));
    } else {
      print(`  health     ${ok('P0 build confirmed')} (${expectations.join(', ')})`);
    }
  }

  const graph = ctx.graph();
  const patchedFields = [...new Set(selected.flatMap((r) => Object.keys(r.patch)))];
  await requireColumns(graph, directory, patchedFields);

  const logFile = values.out ?? outPath(ctx.outDir, `directory-bindings-apply-${stamp(ctx.now())}.json`);
  const log = {
    kind: LOG_KIND,
    version: 1,
    mode: APPLY ? 'apply' : 'dry-run',
    planFile: values.plan,
    planSha256,
    planDigest: plan.digest,
    directory,
    operator: describeToken(ctx.env.GRAPH_TOKEN ?? '')?.who ?? '',
    startedAt: ctx.now().toISOString(),
    finishedAt: null,
    rows: [],
  };
  const flush = () => (APPLY ? writeJsonFile(logFile, log) : null);
  flush();

  let failures = 0;
  for (const r of selected) {
    const entry = {
      listItemId: r.listItemId,
      clientId: r.clientId,
      title: r.title,
      patch: r.patch,
      result: 'pending',
    };
    log.rows.push(entry);
    print('');
    print(bold(`Row ${r.listItemId} · ClientId ${r.clientId} · ${q(r.title)}`));
    try {
      const current = await readItemFields(graph, directory, r.listItemId);
      entry.before = snapshotFields(current);
      const stale = staleFields(r, current);
      if (stale.length) {
        entry.result = 'stale';
        entry.staleFields = stale;
        failures += 1;
        print(`    ${bad('refused')} the row changed since propose: ${stale.join(', ')}. Re-run propose.`);
        flush();
        continue;
      }
      for (const [field, value] of Object.entries(r.patch)) {
        print(`    ${field.padEnd(17)} ${q(entry.before[field])} → ${q(value)}`);
      }
      if (!APPLY) {
        entry.result = 'dry_run';
        print(`    ${dim('dry run: not written')}`);
        continue;
      }
      await graph.patch(`${listPath(directory)}/items/${encodeURIComponent(r.listItemId)}/fields`, r.patch);
      entry.result = 'patched';
      const after = await readItemFields(graph, directory, r.listItemId);
      entry.after = snapshotFields(after);
      const mismatched = Object.keys(r.patch).filter((f) => !sameValue(f, after[f], r.patch[f]));
      if (mismatched.length) {
        entry.result = 'patched_mismatch';
        entry.mismatchedFields = mismatched;
        failures += 1;
        print(`    ${bad('written, but reads back different')}: ${mismatched.join(', ')}`);
      } else {
        print(`    ${ok('written and read back')}`);
      }
    } catch (err) {
      entry.result = entry.result === 'patched' ? 'patched_unverified' : 'failed';
      entry.error = err.message;
      failures += 1;
      print(`    ${bad(entry.result)} ${err.message}`);
    }
    flush();
  }

  log.finishedAt = ctx.now().toISOString();
  const written = flush();
  print('');
  if (!APPLY) {
    print('Dry run. Re-run with --apply to write.');
  } else {
    print(bold('Result'));
    for (const e of log.rows) print(`  row ${e.listItemId}: ${e.result === 'patched' ? ok(e.result) : bad(e.result)}`);
    print(`  log     ${written.path}`);
    print(`  sha256  ${written.sha256}`);
    print(`  undo    node tools/directory-bindings.mjs rollback --log ${written.path}`);
    print('');
    print('Next: one canary upload per bound client, then `check` again.');
  }
  print('');
  return failures ? 2 : 0;
}

// ---------------------------------------------------------------------------
// rollback
// ---------------------------------------------------------------------------

async function runRollback(ctx) {
  const { print, values } = ctx;
  const APPLY = Boolean(values.apply);
  if (!values.log) throw new CliError('rollback needs --log <file> (written by apply --apply)');
  const { data: log, sha256: logSha256 } = readJsonFile(values.log);
  if (log?.kind !== LOG_KIND || log?.mode !== 'apply' || !Array.isArray(log?.rows)) {
    throw new CliError(`${values.log} is not an apply log written with --apply`);
  }
  const directory = log.directory;
  if (!directory?.siteId || !directory?.listId) throw new CliError('the log names no directory');

  const candidates = log.rows.filter((r) =>
    ['patched', 'patched_mismatch', 'patched_unverified'].includes(r.result),
  );
  print('');
  print(bold(`Rollback directory bindings — ${APPLY ? bad('APPLY') : 'DRY RUN (nothing is written)'}`));
  print(`  log        ${values.log}  sha256 ${logSha256}`);
  print(`  directory  site ${directory.siteId} · list ${directory.listId}`);
  tokenBanner(ctx);
  const graph = ctx.graph();
  print(`  rows       ${candidates.length} written by that apply`);

  const outFile = values.out ?? outPath(ctx.outDir, `directory-bindings-rollback-${stamp(ctx.now())}.json`);
  const out = {
    kind: ROLLBACK_KIND,
    version: 1,
    mode: APPLY ? 'apply' : 'dry-run',
    applyLog: values.log,
    applyLogSha256: logSha256,
    directory,
    operator: describeToken(ctx.env.GRAPH_TOKEN ?? '')?.who ?? '',
    startedAt: ctx.now().toISOString(),
    finishedAt: null,
    rows: [],
  };
  const flush = () => (APPLY ? writeJsonFile(outFile, out) : null);
  flush();

  let failures = 0;
  for (const r of candidates) {
    const patch = rollbackPatch(r);
    const entry = { listItemId: r.listItemId, clientId: r.clientId, patch, result: 'pending' };
    out.rows.push(entry);
    print('');
    print(bold(`Row ${r.listItemId} · ClientId ${r.clientId}`));
    try {
      const current = await readItemFields(graph, directory, r.listItemId);
      entry.before = snapshotFields(current);
      // A row the apply wrote but could not read back is compared with what it
      // wrote: the patch is the after-state it asked for.
      const changed = changedSinceApply({ ...r, after: r.after ?? r.patch }, current);
      if (changed.length) {
        entry.result = 'changed_since_apply';
        entry.changedFields = changed;
        failures += 1;
        print(
          `    ${bad('refused')} changed since the apply: ${changed.join(', ')}. ` +
            'Restore by hand from the log if still wanted.',
        );
        flush();
        continue;
      }
      for (const [field, value] of Object.entries(patch)) {
        print(`    ${field.padEnd(17)} ${q(entry.before[field])} → ${q(value)}`);
      }
      if (!APPLY) {
        entry.result = 'dry_run';
        print(`    ${dim('dry run: not written')}`);
        continue;
      }
      await graph.patch(`${listPath(directory)}/items/${encodeURIComponent(r.listItemId)}/fields`, patch);
      const after = await readItemFields(graph, directory, r.listItemId);
      entry.after = snapshotFields(after);
      const mismatched = Object.keys(patch).filter((f) => !sameValue(f, after[f], patch[f]));
      entry.result = mismatched.length ? 'restored_mismatch' : 'restored';
      if (mismatched.length) {
        failures += 1;
        entry.mismatchedFields = mismatched;
      }
      print(`    ${mismatched.length ? bad(entry.result) : ok(entry.result)}`);
    } catch (err) {
      entry.result = 'failed';
      entry.error = err.message;
      failures += 1;
      print(`    ${bad('failed')} ${err.message}`);
    }
    flush();
  }
  out.finishedAt = ctx.now().toISOString();
  const written = flush();
  print('');
  if (!APPLY) print('Dry run. Re-run with --apply to write.');
  else print(`  log     ${written.path}  sha256 ${written.sha256}`);
  print('');
  return failures ? 2 : 0;
}

// ---------------------------------------------------------------------------
// --add-columns
// ---------------------------------------------------------------------------

async function runAddColumns(ctx) {
  const { print, values, env } = ctx;
  const APPLY = Boolean(values.apply);
  const directory = directoryIds(values, env);

  print('');
  print(bold(`Client Directory columns — ${APPLY ? bad('APPLY') : 'DRY RUN (nothing is written)'}`));
  print(`  directory  site ${directory.siteId} · list ${directory.listId}`);
  tokenBanner(ctx);
  const graph = ctx.graph();
  const read = () => graph.all(`${listPath(directory)}/columns?$select=id,name,displayName,text`);

  const before = await read();
  const toCreate = [];
  for (const name of NEW_COLUMNS) {
    const exact = before.find((c) => c.name === name);
    const lookalike = before.find((c) => c.name !== name && c.displayName === name);
    if (exact) {
      print(`  ${name.padEnd(8)} ${ok('exists')} ${dim(exact.text ? 'text' : '(not a text column!)')}`);
      if (!exact.text) throw new CliError(`${name} exists but is not a text column; fix it by hand`);
    } else if (lookalike) {
      throw new CliError(
        `a column displayed as "${name}" exists with internal name "${lookalike.name}"; ` +
          'the ingestion reads the internal name. Rename or remove it by hand first.',
      );
    } else {
      toCreate.push(name);
      print(`  ${name.padEnd(8)} ${warn(APPLY ? 'creating' : 'would create')} (single line of text)`);
    }
  }
  if (APPLY) {
    for (const name of toCreate) {
      await graph.post(`${listPath(directory)}/columns`, {
        name,
        displayName: name,
        description: 'Written by tools/directory-bindings.mjs; read by ledger ingestion (P0-4).',
        required: false,
        text: { allowMultipleLines: false, maxLength: 255 },
      });
    }
    const after = await read();
    print('');
    print(bold('Resulting state'));
    for (const name of NEW_COLUMNS) {
      const c = after.find((x) => x.name === name);
      print(`  ${name.padEnd(8)} ${c ? ok('present') : bad('MISSING')}`);
      if (!c) throw new CliError(`${name} is still missing after the create`);
    }
  } else if (toCreate.length) {
    print('');
    print('Dry run. Re-run with --apply to create.');
  }
  print('');
  return 0;
}

if (isMain(import.meta.url)) runMain(main);
