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
 *   check     report what each Active row is bound to and what is wrong;
 *             exit 3 on drift on a bound row, 4 when a bound row could not
 *             be fully assessed
 *   propose   compute the binding and write a plan file for review
 *   apply     apply a reviewed plan (PATCH list item fields), with a log
 *   rollback  restore the before-state from an apply log, re-checking every
 *             id it would put back
 *   --add-columns   create the DriveId and TeamId text columns if missing
 *
 * ## Safety model
 *
 * - Read-only unless `--apply`. `apply`, `rollback` and `--add-columns`
 *   without `--apply` print what they would do and write nothing.
 * - Only four columns are ever written: RootFolder, UserAadObjectIds, DriveId
 *   and TeamId. Nothing else on a row, and never a Team, channel, group,
 *   permission or visibility. BCR GROUP's visibility is read, never changed.
 * - Ambiguity skips the row: a duplicate key (a site, DriveId or TeamId shared
 *   with another row included), a non-canonical SitePath, a Public team, a
 *   missing or non-standard channel, a drive mismatch, an unknown write
 *   grant. A guest who is also in any other Team is never bound. Staff
 *   (Member) ids are removed from a client row only with
 *   `--confirm-remove-staff <listItemId>` for that row.
 * - Never BCR GROUP, never the quarantine (contract C8). The forbidden list is
 *   required, the quarantine path is always forbidden, a row on another host
 *   than `--tenant-host` is skipped, and a row whose site resolves to the
 *   Client Directory's own site collection is skipped whatever the flags say.
 * - `apply` refuses a plan that was edited after `propose` (the digest covers
 *   every field: rows, createdAt, directory, guards), is older than
 *   `--max-plan-age-hours` (at most 72), or whose row changed since (stale
 *   guard). Before each PATCH it checks the row again against the
 *   guards it is given, and re-reads every guest the row will route: each
 *   must still be a Guest in the row's Team and in no other Team. It refuses
 *   to run unless the ingestion `/api/health` reports
 *   `build.routing=identity-only`, the marker only the P0 build has.
 * - `rollback` puts ids back only after the same guest re-check: each id the
 *   restore would add to a row must be a Guest whose Teams are exactly the
 *   row's TeamId. Otherwise the row is refused (`guest_recheck_failed`):
 *   rolling back an apply that took a guest off must never route them to
 *   the old client again. `--only` limits it to named rows.
 * - Every applied row is logged before the PATCH is sent (`writing`) and again
 *   after it, and the log is on disk at both points, so `rollback` knows every
 *   row an interrupted run may have written. The log is created fresh (an
 *   existing file is refused) and every rewrite is atomic and fsynced. The
 *   check report and the plan are created fresh too.
 * - The token is read from `GRAPH_TOKEN` and never printed.
 *
 * See tools/README.md for scopes and the full procedure.
 */

import {
  CliError,
  assertNewFile,
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
  checkVerdict,
  DRIFT_UNASSESSED_CODES,
  fieldString,
  findDuplicates,
  findTeamForSite,
  forbiddenTargetReasons,
  healthExpectations,
  healthSatisfies,
  idsRollbackAdds,
  isSiteCollectionPath,
  isTeamGroup,
  mapSitesToTeams,
  normalizeGuid,
  normalizeSitePath,
  P0_HEALTH_EXPECTATION,
  ROUTING_DRIFT_CODES,
  TENANT_HOST,
  parseDirectoryRow,
  pickAccountingChannel,
  pickFields,
  rollbackPatch,
  siteCollectionId,
  sitePathSegments,
  splitLines,
  staleFields,
  validatePlan,
} from './lib/bindings.mjs';

/**
 * The oldest plan `apply` takes, in hours, and its default. A hard cap: the
 * guests are re-read at apply, but everything else the plan saw (the Team,
 * its channel folder, its drive) is not.
 */
const MAX_PLAN_AGE_HOURS = 72;

const USAGE = `
Usage:
  node tools/directory-bindings.mjs check    [common] [guards] [--out <report.json>]
  node tools/directory-bindings.mjs propose  [common] [guards] [--out <plan.json>]
            [--write-verified <sitePath|listItemId>]... [--confirm-remove-staff <listItemId>]...
  node tools/directory-bindings.mjs apply    --plan <plan.json> --health-url https://<ingestion-host>/api/health
            [guards] [--expect-health <key=value>]... [--only <listItemId>]...
            [--max-plan-age-hours ${MAX_PLAN_AGE_HOURS}] [--out <new log file>] [--apply]

  apply always requires the health body to report ${P0_HEALTH_EXPECTATION};
  --expect-health adds further checks, it never replaces that one.
  node tools/directory-bindings.mjs rollback --log <apply-log.json> [--only <listItemId>]...
            [--out <new log file>] [--apply]
  node tools/directory-bindings.mjs --add-columns [--site-id ..] [--list-id ..] [--apply]

  check exits 0 when every bound row with ids was assessed and none routes where it
  should not, 3 on drift on a bound row, 4 when a bound row could not be fully
  assessed (3 wins). rollback refuses a row whose restore would put back an id that
  is not a Guest of that row's Team alone. --out never replaces an existing file.

Common:
  --site-id <id>              Graph site id of the Client Directory site (BCR GROUP)
                              (env DIRECTORY_SITE_ID or CLIENT_DIRECTORY_SITE_ID)
  --list-id <id>              Client Directory list id
                              (env DIRECTORY_LIST_ID or CLIENT_DIRECTORY_LIST_ID)
  --ingest-app-ids <a,b>      app id of the ingestion Function App's managed identity,
                              INGEST_MI_APPID (env INGEST_APP_IDS)
  --channel-name <name>       default "${CHANNEL_NAME}"
  --concurrency <n>           parallel Graph requests, default 4

Guards (check, propose and apply):
  --forbidden-site-paths <a,b>  REQUIRED: rows on these sites are never bound
                              (env FORBIDDEN_TARGET_SITE_PATHS; BCR GROUP at least)
  --quarantine-site-path <p>  the quarantine site, always forbidden (env QUARANTINE_SITE_PATH)
  --tenant-host <host>        the only SharePoint host a row may name
                              (env QUARANTINE_SITE_HOSTNAME)
  A row whose site resolves to the Client Directory's own site collection is
  never bound, whatever the flags say.

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
  'quarantine-site-path': { type: 'string' },
  'tenant-host': { type: 'string' },
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

/** The guard flags: what a row may never be bound to. Required list, optional extras. */
const GUARD_FLAGS = ['forbidden-site-paths', 'quarantine-site-path', 'tenant-host'];

/** Which flags each command accepts. A flag outside its command is refused, not ignored. */
const ALLOWED = {
  check: ['site-id', 'list-id', 'ingest-app-ids', ...GUARD_FLAGS, 'write-verified',
    'confirm-remove-staff', 'channel-name', 'concurrency', 'out'],
  propose: ['site-id', 'list-id', 'ingest-app-ids', ...GUARD_FLAGS, 'write-verified',
    'confirm-remove-staff', 'channel-name', 'concurrency', 'out'],
  apply: ['plan', 'apply', 'only', 'health-url', 'expect-health', 'max-plan-age-hours', 'site-id',
    'list-id', ...GUARD_FLAGS, 'out'],
  rollback: ['log', 'apply', 'only', 'out'],
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

  const run = {
    check: runCheck,
    propose: runPropose,
    apply: runApply,
    rollback: runRollback,
    'add-columns': runAddColumns,
  }[command];
  try {
    return await run(ctx);
  } catch (err) {
    throw withConsentHint(err);
  }
}

/**
 * A 403 that stops a whole command (the Teams listing, the Directory list)
 * is most often a delegated permission the app registration behind
 * GRAPH_TOKEN was never admin-consented for. Say so, next to Graph's own words.
 */
function withConsentHint(err) {
  if (!(err instanceof GraphError) || err.status !== 403) return err;
  return new CliError(
    `${err.message}\n  Graph refused this request (403). Most often the app registration that ` +
      'issued GRAPH_TOKEN lacks admin consent for a delegated permission this command needs ' +
      '(tools/README.md, "Authentication"). For a site or the Directory list, the signed-in ' +
      'person may also lack access to it.',
  );
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

/**
 * What no row may be bound to, as the ingestion refuses it (contract C8):
 * the forbidden list (required, as the ingestion requires it), the quarantine
 * path, the tenant's one SharePoint host, and the Client Directory's own site
 * collection (BCR GROUP), which is checked against the resolved site id and
 * needs no flag.
 *
 * @param {object} values  parsed flags
 * @param {object} env
 * @param {string} directorySiteId  `<host>,<collection>,<web>`
 * @param {object} [recorded]  the plan's `guards`; they can only add to the flags
 */
function guardOptions(values, env, directorySiteId, recorded) {
  const forbidden = csvList(values['forbidden-site-paths'] ?? env.FORBIDDEN_TARGET_SITE_PATHS);
  if (!forbidden.length) {
    throw new CliError(
      'FORBIDDEN_TARGET_SITE_PATHS / --forbidden-site-paths is required (BCR GROUP at least, ' +
        'as /sites/<name>). The ingestion refuses to start without it, and so does this tool.',
    );
  }
  // A forbidden entry that is not a plain site path (a pasted URL, a `..`)
  // would match no row, and the guard would be off without anyone noticing.
  const badForbidden = forbidden.filter((p) => !isSiteCollectionPath(p));
  if (badForbidden.length) {
    throw new CliError(
      `--forbidden-site-paths / FORBIDDEN_TARGET_SITE_PATHS: not a /sites/<name> or /teams/<name> path: ` +
        badForbidden.join(', '),
    );
  }
  const quarantineGiven = String(values['quarantine-site-path'] ?? env.QUARANTINE_SITE_PATH ?? '').trim();
  if (quarantineGiven && !isSiteCollectionPath(quarantineGiven)) {
    throw new CliError(
      `--quarantine-site-path / QUARANTINE_SITE_PATH: not a /sites/<name> or /teams/<name> path: ${quarantineGiven}`,
    );
  }
  const hostGiven = String(values['tenant-host'] ?? env.QUARANTINE_SITE_HOSTNAME ?? '').trim();
  if (hostGiven && !TENANT_HOST.test(hostGiven)) {
    throw new CliError(`--tenant-host / QUARANTINE_SITE_HOSTNAME: not <tenant>.sharepoint.com: ${hostGiven}`);
  }
  const directorySiteCollectionId = siteCollectionId(directorySiteId);
  if (!directorySiteCollectionId) {
    throw new CliError(
      'the Client Directory site id has no site-collection GUID (<host>,<collection guid>,<web guid>); ' +
        'without it no row can be checked against BCR GROUP',
    );
  }

  // A value recorded in the plan and not given now still applies: each can
  // only exclude more rows, never fewer.
  const paths = new Set(forbidden.map(normalizeSitePath));
  const recordedPaths = Array.isArray(recorded?.forbiddenSitePaths) ? recorded.forbiddenSitePaths : [];
  for (const p of recordedPaths) {
    const canonical = normalizeSitePath(p);
    if (canonical) paths.add(canonical);
  }
  const quarantinePath = normalizeSitePath(quarantineGiven) ?? normalizeSitePath(recorded?.quarantineSitePath) ?? '';
  if (quarantinePath) paths.add(quarantinePath);
  const recordedHost = String(recorded?.tenantHost ?? '').trim();
  const tenantHost = (hostGiven || (TENANT_HOST.test(recordedHost) ? recordedHost : '')).toLowerCase();
  return {
    guards: {
      forbiddenSitePaths: [...paths].sort(),
      quarantineSitePath: quarantinePath,
      tenantHost,
      directorySiteCollectionId,
    },
    ctx: { forbiddenSitePaths: paths, tenantHost, directorySiteCollectionId },
  };
}

function printGuards(print, guards) {
  print(`  forbidden  ${guards.forbiddenSitePaths.join(', ')}`);
  print(
    `  guard      site collection ${guards.directorySiteCollectionId} (the Client Directory's) is never bound`,
  );
  if (!guards.quarantineSitePath) {
    print(warn('  no --quarantine-site-path (QUARANTINE_SITE_PATH): a row on the quarantine site is not caught here'));
  }
  if (guards.tenantHost) print(`  host       ${guards.tenantHost} only`);
  else print(warn('  no --tenant-host (QUARANTINE_SITE_HOSTNAME): a row on another host is not caught here'));
}

function assessOptions(values, env, directorySiteId) {
  const ingestAppIds = csvList(values['ingest-app-ids'] ?? env.INGEST_APP_IDS);
  const badIds = ingestAppIds.filter((id) => !normalizeGuid(id));
  if (badIds.length) throw new CliError(`--ingest-app-ids: not GUIDs: ${badIds.join(', ')}`);
  const { guards, ctx: guardCtx } = guardOptions(values, env, directorySiteId);
  const writeVerified = new Set();
  for (const v of csvList(values['write-verified'])) {
    writeVerified.add(v);
    const canonical = normalizeSitePath(v);
    if (canonical) writeVerified.add(canonical);
  }
  return {
    ingestAppIds,
    guards,
    ctx: {
      ...guardCtx,
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
        // resourceProvisioningOptions tells a Team from any other group. Every
        // Team counts, marked or not: a guest in any second Team is not bound.
        safe(() =>
          graph.all(
            `/users/${id}/memberOf?$select=id,displayName,description,resourceProvisioningOptions&$top=999`,
          ),
        ).then((r) => (Array.isArray(r) ? r.filter(isGroup) : r)),
      );
    }
    return memberOfCache.get(id);
  };

  const factsByRow = new Map();
  await mapLimit(active, concurrency, async (row) => {
    const facts = { usersById };
    factsByRow.set(row.listItemId, facts);
    if (row.isAdmin || !row.siteHostname || !row.sitePath) return;
    // Not canonical (contract C1): not looked up, the row is skipped as such.
    const segments = sitePathSegments(row.sitePath);
    if (!segments) return;

    const sitePath = encodePath(segments.join('/'));
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
    knownTeamIds: new Set(gathered.teams.map((t) => normalizeGuid(t.id)).filter(Boolean)),
  };
  return gathered.active.map((row) =>
    assessRow(row, gathered.factsByRow.get(row.listItemId) ?? { usersById: gathered.usersById }, ctx),
  );
}

// ---------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------

const q = (s) => `'${String(s ?? '')}'`;

/** An excluded guest, with the other Teams that excluded them. */
function describeExcluded(p) {
  const who = p.userPrincipalName || p.id;
  const teams = (p.otherTeams ?? []).map((t) => `${t.id}${t.displayName ? ` ${q(t.displayName)}` : ''}`);
  return `${who ? `${who} ` : ''}(${p.reason}${teams.length ? `: also in ${teams.join(', ')}` : ''})`;
}

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

function printRowCheck(print, row, a, facts, usersById, verdict) {
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
    for (const p of ex) print(`               ${warn('excluded')} ${describeExcluded(p)}`);
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
      w === 'n/a' ? dim('not checked (forbidden, not canonical or not resolved)') :
      warn('unknown: verify read-only (GET /sites/{id}/permissions), never with the grant runbook');
    print(`    write      ${text}${facts?.permissionsNote ? dim(` (${facts.permissionsNote})`) : ''}`);
    print(`    bound now  RootFolder ${q(row.rootFolder)} · DriveId ${q(row.driveId)} · TeamId ${q(row.teamId)}`);
  }
  printProblems(print, a.problems);
  if (verdict?.notRoutingUnbound.includes(row.listItemId)) {
    print(
      `    ${warn('not routing (unbound)')} the ingestion quarantines this row's users (unbound_target); ` +
        'the PATCH that binds it also takes these ids off',
    );
  }
  if (verdict?.incomplete.includes(row.listItemId)) {
    print(`    ${bad('incomplete')} bound and holding user ids, but its drift could not be assessed`);
  }
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
  const opts = assessOptions(values, env, ids.siteId);
  print('');
  print(bold(heading));
  print(`  directory  site ${ids.siteId} · list ${ids.listId}`);
  printGuards(print, opts.guards);
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
  if (values.out) assertNewFile(values.out);
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
  const verdict = checkVerdict(gathered.rows, assessments);
  const rowById = new Map(gathered.rows.map((r) => [r.listItemId, r]));
  for (const a of assessments) {
    const row = rowById.get(a.listItemId);
    printRowCheck(print, row, a, gathered.factsByRow.get(a.listItemId), gathered.usersById, verdict);
  }
  const ready = assessments.filter((a) => !a.problems.some((p) => p.severity === 'skip'));
  print('');
  print(bold('Summary'));
  print(`  ${assessments.length} Active row(s): ${ok(`${ready.length} ready`)}, ${bad(`${assessments.length - ready.length} skipped`)}`);
  print(`  ${gathered.rows.length - gathered.active.length} inactive row(s) not examined`);
  if (verdict.notRoutingUnbound.length) {
    print(
      warn(
        `  not routing (unbound): row(s) ${verdict.notRoutingUnbound.join(', ')} hold staff ids or ids that ` +
          "are not guests of that row's Team alone, but lack RootFolder, DriveId or TeamId, so the Phase-0 " +
          'ingestion routes nobody there (unbound_target). The PATCH that binds such a row takes them off.',
      ),
    );
  }
  if (verdict.routingDrift.length) {
    print(
      bad(
        `  ACTION: row(s) ${verdict.routingDrift.join(', ')} hold an id that routes there and ` +
          `should not (${ROUTING_DRIFT_CODES.join(' / ')}). Run propose and apply the whole plan.`,
      ),
    );
  }
  if (verdict.incomplete.length) {
    print(
      bad(
        `  ACTION: row(s) ${verdict.incomplete.join(', ')} are bound and hold user ids, but could not be ` +
          `fully assessed (${DRIFT_UNASSESSED_CODES.join(' / ')}): whether an id routes there and should ` +
          "not is unknown. Fix the read (each row's SKIP line says which; a 403 is missing consent or " +
          'site access), then run check again.',
      ),
    );
  }
  if (verdict.exitCode === 0) print(`  ${ok('every bound row with user ids was assessed; none routes where it should not')}`);

  if (values.out) {
    const report = {
      kind: 'bcr.directory-bindings.check',
      createdAt: ctx.now().toISOString(),
      directory: ids,
      ingestAppIds: opts.ingestAppIds,
      guards: opts.guards,
      duplicates: gathered.duplicates,
      unreadableTeamSites: gathered.teamIndex.unreadable,
      exitCode: verdict.exitCode,
      routingDrift: verdict.routingDrift,
      incomplete: verdict.incomplete,
      notRoutingUnbound: verdict.notRoutingUnbound,
      rows: assessments,
    };
    const written = writeJsonFile(values.out, report, { exclusive: true });
    print(`  report     ${written.path}  sha256 ${written.sha256}`);
  }
  print('');
  return verdict.exitCode;
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
    for (const u of r.removedUserIds) print(`      ${bad('-')} ${u.id} ${describeExcluded({ ...u, id: '' })}`);
    for (const u of r.addedUserIds) print(`      ${ok('+')} ${u.id} ${u.userPrincipalName ?? ''}`);
  }
  for (const g of r.excludedGuests ?? []) print(`    ${warn('not bound')} ${describeExcluded(g)}`);
}

async function runPropose(ctx) {
  const { print, values } = ctx;
  if (values.out) assertNewFile(values.out);
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
    guards: opts.guards,
    createdAt: ctx.now().toISOString(),
  });
  for (const r of plan.rows) printPlanRow(print, r);

  const count = (action) => plan.rows.filter((r) => r.action === action).length;
  const file = values.out ?? outPath(ctx.outDir, `directory-bindings-plan-${stamp(ctx.now())}.json`);
  const written = writeJsonFile(file, plan, { exclusive: true });
  print('');
  print(bold('Plan'));
  print(`  ${ok(`${count('PATCH')} PATCH`)} · ${dim(`${count('NOOP')} NOOP`)} · ${bad(`${count('SKIP')} SKIP`)}`);
  print(`  file    ${written.path}`);
  print(`  sha256  ${written.sha256}`);
  print('');
  print('Review the file, then dry-run the apply (nothing is written without --apply):');
  print(`  node tools/directory-bindings.mjs apply --plan ${written.path} \\`);
  print('    --health-url https://<ingestion-host>/api/health');
  print(dim(`  (apply always requires the health body to report ${P0_HEALTH_EXPECTATION},`));
  print(dim('   and the forbidden list: FORBIDDEN_TARGET_SITE_PATHS or --forbidden-site-paths)'));
  print(dim('  Apply the whole plan. --only is for a staged rollout, never after an onboarding.'));
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
  // https only, localhost included: the gate is about the deployed build,
  // and a local run of any build would answer whatever it was built with.
  if (parsed.protocol !== 'https:') {
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

/** Apply-log results for a PATCH that may or may not have landed. */
const UNCERTAIN_WRITES = Object.freeze(['writing', 'write_unknown']);

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

/**
 * The row's target as it stands now, checked again against the guards this
 * run was given (C8): propose may have run with other flags, or none. Also
 * whether SitePath still resolves to the site propose saw.
 *
 * @returns {Promise<{forbidden: string[], stale: string[]}>}
 */
async function recheckTarget(graph, planRow, current, guardCtx) {
  const row = parseDirectoryRow({ id: planRow.listItemId, fields: current });
  const segments = sitePathSegments(row.sitePath);
  if (!row.siteHostname || !segments) {
    return { forbidden: ['SiteHostname is empty, or SitePath is not /sites/<name> or /teams/<name>'], stale: [] };
  }
  const site = await graph.get(
    `/sites/${row.siteHostname}:/${encodePath(segments.join('/'))}?$select=id,webUrl`,
  );
  const forbidden = forbiddenTargetReasons(row, site, guardCtx);
  const stale = [];
  const seen = String(planRow.evidence?.siteId ?? '').toLowerCase();
  if (seen && String(site?.id ?? '').toLowerCase() !== seen) {
    stale.push(`SitePath now resolves to site ${site?.id ?? '?'}, not ${planRow.evidence.siteId} as at propose`);
  }
  return { forbidden, stale };
}

/** Every Team in the tenant, read once and only when first needed. */
function lazyTeamIds(graph) {
  let teamIds;
  return async () => {
    teamIds ??= graph.all(TEAMS_QUERY).then((ts) => new Set(ts.map((t) => normalizeGuid(t.id)).filter(Boolean)));
    return teamIds;
  };
}

/**
 * Whether each of `ids` is a Guest who belongs to the Team `teamId` and to no
 * other Team (C8, R19), so that it may route to a row with that TeamId.
 * Memberships change, and a guest added to a second client's Team would file
 * that client's documents here. Reads only; a read that fails throws, and the
 * row is not written. A Member (staff) never qualifies, and neither does any
 * id when the row has no TeamId to check it against.
 *
 * @param {string[]} ids  normalised GUIDs
 * @param {string} teamId  normalised GUID, or ''
 * @param {() => Promise<Set<string>>} knownTeamIds  every Team in the tenant, read once
 * @returns {Promise<string[]>} why not; empty when every id qualifies
 */
async function recheckIds(graph, ids, teamId, knownTeamIds) {
  const why = [];
  for (const id of ids) {
    const user = await lookupUser(graph, id);
    if (user === null) {
      why.push(`${id} no longer exists`);
      continue;
    }
    if (isErr(user)) throw new Error(`could not read user ${id}: ${user.error}`);
    if (user.userType !== 'Guest') {
      why.push(`${id} is ${user.userType ? `a ${user.userType}` : 'not a Guest'}`);
      continue;
    }
    const groups = (
      await graph.all(
        `/users/${id}/memberOf?$select=id,displayName,description,resourceProvisioningOptions&$top=999`,
      )
    ).filter(isGroup);
    const known = await knownTeamIds();
    const teams = new Set(groups.filter((g) => isTeamGroup(g, known)).map((g) => normalizeGuid(g.id) || String(g.id)));
    if (!teamId) why.push(`${id}: the row would have no TeamId, so it cannot be shown to be that Team's guest`);
    else if (!teams.has(teamId)) why.push(`${id} is no longer in the row's Team`);
    const others = [...teams].filter((t) => t !== teamId);
    if (others.length) why.push(`${id} is also in Team(s) ${others.join(', ')}`);
  }
  return why;
}

/**
 * Whether every id the row will route after the PATCH still qualifies
 * (`recheckIds` against the row's final TeamId). Propose checked it; apply
 * checks it again right before the write.
 */
async function recheckGuests(graph, planRow, knownTeamIds) {
  const final = (field) => fieldString(field in planRow.patch ? planRow.patch[field] : planRow.before?.[field]);
  const ids = splitLines(final('UserAadObjectIds')).map(normalizeGuid).filter(Boolean);
  return recheckIds(graph, ids, normalizeGuid(final('TeamId')), knownTeamIds);
}

async function runApply(ctx) {
  const { print, values } = ctx;
  const APPLY = Boolean(values.apply);
  if (!values.plan) throw new CliError('apply needs --plan <file> (written by propose)');
  const { data: plan, sha256: planSha256 } = readJsonFile(values.plan);
  const errors = validatePlan(plan);
  if (errors.length) throw new CliError(`the plan is not applicable:\n  - ${errors.join('\n  - ')}`);

  const maxAgeHours = Number(values['max-plan-age-hours'] ?? MAX_PLAN_AGE_HOURS);
  if (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0 || maxAgeHours > MAX_PLAN_AGE_HOURS) {
    throw new CliError(`--max-plan-age-hours must be more than 0 and at most ${MAX_PLAN_AGE_HOURS}`);
  }
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
  // Every row is checked again against these before it is written.
  const { guards, ctx: guardCtx } = guardOptions(values, ctx.env, directory.siteId, plan.guards);

  const only = new Set(csvList(values.only));
  const byId = new Map(plan.rows.map((r) => [r.listItemId, r]));
  for (const id of only) {
    if (!byId.has(id)) throw new CliError(`--only ${id}: no such row in the plan`);
    if (byId.get(id).action === 'SKIP') {
      throw new CliError(`--only ${id}: that row is SKIP in the plan and is never applied`);
    }
  }
  const selected = plan.rows.filter((r) => r.action === 'PATCH' && (!only.size || only.has(r.listItemId)));
  // A PATCH that takes an id off a row is what stops a guest now in two
  // Teams from routing to the old one (C12). --only can leave it out.
  const leftOut = plan.rows.filter(
    (r) => r.action === 'PATCH' && only.size && !only.has(r.listItemId) && (r.removedUserIds ?? []).length,
  );

  print('');
  print(bold(`Apply directory bindings — ${APPLY ? bad('APPLY') : 'DRY RUN (nothing is written)'}`));
  print(`  plan       ${values.plan}  sha256 ${planSha256}`);
  print(`  made       ${plan.createdAt} (${ageHours.toFixed(1)} h ago)`);
  print(`  directory  site ${directory.siteId} · list ${directory.listId}`);
  printGuards(print, guards);
  tokenBanner(ctx);
  print(`  rows       ${selected.length} PATCH selected · ${plan.rows.filter((r) => r.action === 'SKIP').length} SKIP refused · ${plan.rows.filter((r) => r.action === 'NOOP').length} NOOP`);
  if (leftOut.length) {
    print(
      warn(
        `  --only leaves out PATCH row(s) ${leftOut.map((r) => r.listItemId).join(', ')}, which take user ids ` +
          'off a row. After an onboarding, apply the whole plan: until those rows are applied, a guest ' +
          'who is now in two Teams still routes to the old one.',
      ),
    );
  }

  // The P0 gate: bindings take effect through the P0 ingestion build (DriveId
  // check, quarantine, no promotion). Applying them to an older build would
  // route by them without those guards. The routing marker is always
  // required; --expect-health can only add to it, so no value an operator
  // types (such as status=ok, which the old build also reports) opens it.
  const expectations = healthExpectations(values['expect-health'] ?? []);
  if (!values['health-url']) {
    const msg =
      'apply needs --health-url https://<ingestion-host>/api/health; ' +
      `it must report ${P0_HEALTH_EXPECTATION}`;
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
    guards,
    startedAt: ctx.now().toISOString(),
    finishedAt: null,
    rows: [],
  };
  // The first write creates the log and refuses an existing file; every
  // later one replaces it atomically (tmp, fsync, rename).
  let logCreated = false;
  const flush = () => {
    if (!APPLY) return null;
    const written = writeJsonFile(logFile, log, { exclusive: !logCreated });
    logCreated = true;
    return written;
  };
  flush();

  const knownTeamIds = lazyTeamIds(graph);

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
      const target = await recheckTarget(graph, r, current, guardCtx);
      if (target.forbidden.length) {
        entry.result = 'forbidden_target';
        entry.forbiddenReasons = target.forbidden;
        failures += 1;
        print(`    ${bad('refused')} forbidden target: ${target.forbidden.join('; ')}`);
        flush();
        continue;
      }
      const staleReasons = [...target.stale, ...(await recheckGuests(graph, r, knownTeamIds))];
      if (staleReasons.length) {
        entry.result = 'stale';
        entry.staleReasons = staleReasons;
        failures += 1;
        print(`    ${bad('refused')} changed since propose: ${staleReasons.join('; ')}. Re-run propose.`);
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
      // On disk before the request leaves: if the run dies from here on, the
      // log still names this row and its before-state, and rollback checks
      // whether the write landed.
      entry.result = 'writing';
      flush();
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
      // A PATCH that threw may still have landed (a lost response), so it is
      // `write_unknown`, which rollback checks against the row, not `failed`.
      entry.result =
        entry.result === 'patched'
          ? 'patched_unverified'
          : entry.result === 'writing'
            ? 'write_unknown'
            : 'failed';
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
    print(`  rollback node tools/directory-bindings.mjs rollback --log ${written.path} [--only <listItemId>]`);
    print(
      dim(
        '           A dry run first. It refuses to put back an id that is not a Guest of that row\'s ' +
          'Team alone; to undo an apply that took ids off, re-run propose and apply the whole plan.',
      ),
    );
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

  // `writing` (the run died with the PATCH in flight) and `write_unknown` (the
  // PATCH threw) may or may not have landed; each is checked against the row.
  const written = log.rows.filter((r) =>
    ['patched', 'patched_mismatch', 'patched_unverified', ...UNCERTAIN_WRITES].includes(r.result),
  );
  const only = new Set(csvList(values.only));
  for (const id of only) {
    if (!written.some((r) => r.listItemId === id)) {
      throw new CliError(`--only ${id}: the log records no write to that row`);
    }
  }
  const candidates = written.filter((r) => !only.size || only.has(r.listItemId));
  print('');
  print(bold(`Rollback directory bindings — ${APPLY ? bad('APPLY') : 'DRY RUN (nothing is written)'}`));
  print(`  log        ${values.log}  sha256 ${logSha256}`);
  print(`  directory  site ${directory.siteId} · list ${directory.listId}`);
  tokenBanner(ctx);
  const graph = ctx.graph();
  const knownTeamIds = lazyTeamIds(graph);
  print(
    `  rows       ${candidates.length} of the ${written.length} written by that apply` +
      (only.size ? ` (--only ${[...only].join(', ')})` : ''),
  );

  const outFile = values.out ?? outPath(ctx.outDir, `directory-bindings-rollback-${stamp(ctx.now())}.json`);
  const out = {
    kind: ROLLBACK_KIND,
    version: 1,
    mode: APPLY ? 'apply' : 'dry-run',
    applyLog: values.log,
    applyLogSha256: logSha256,
    ...(only.size ? { only: [...only] } : {}),
    directory,
    operator: describeToken(ctx.env.GRAPH_TOKEN ?? '')?.who ?? '',
    startedAt: ctx.now().toISOString(),
    finishedAt: null,
    rows: [],
  };
  let logCreated = false;
  const flush = () => {
    if (!APPLY) return null;
    const written = writeJsonFile(outFile, out, { exclusive: !logCreated });
    logCreated = true;
    return written;
  };
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
      if (UNCERTAIN_WRITES.includes(r.result)) {
        if (!r.before) {
          entry.result = 'no_before_state';
          failures += 1;
          print(`    ${bad('refused')} the log has no before-state for this row; restore it by hand from the plan`);
          flush();
          continue;
        }
        const fields = Object.keys(r.patch ?? {});
        if (fields.every((f) => sameValue(f, current[f], r.before[f]))) {
          entry.result = 'not_written';
          print(`    ${ok('not written')} the row still holds its before-state; nothing to restore`);
          flush();
          continue;
        }
      }
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
      // An id the restore puts back routes to this row again. The apply took
      // it off for a reason (a second Team, staff), so it is re-read as apply
      // re-reads the guests it binds, against the TeamId the row will have.
      const readded = idsRollbackAdds(patch, current);
      if (readded.length) {
        const teamId = normalizeGuid('TeamId' in patch ? patch.TeamId : fieldString(current.TeamId));
        const why = await recheckIds(graph, readded, teamId, knownTeamIds);
        entry.readdedUserIds = readded;
        if (why.length) {
          entry.result = 'guest_recheck_failed';
          entry.recheckReasons = why;
          failures += 1;
          print(`    ${bad('refused')} it would put back id(s) that must not route here: ${why.join('; ')}.`);
          const next =
            'Nothing written. Re-run propose and apply the whole plan instead (tools/README.md, ' +
            'rollback); never put these ids back by hand.';
          print(`    ${dim(next)}`);
          flush();
          continue;
        }
      }
      for (const [field, value] of Object.entries(patch)) {
        print(`    ${field.padEnd(17)} ${q(entry.before[field])} → ${q(value)}`);
      }
      if (!APPLY) {
        entry.result = 'dry_run';
        print(`    ${dim('dry run: not written')}`);
        continue;
      }
      entry.result = 'writing';
      flush();
      await graph.patch(`${listPath(directory)}/items/${encodeURIComponent(r.listItemId)}/fields`, patch);
      entry.result = 'restoring_readback';
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
      entry.result =
        entry.result === 'restoring_readback'
          ? 'restored_unverified'
          : entry.result === 'writing'
            ? 'write_unknown'
            : 'failed';
      entry.error = err.message;
      failures += 1;
      print(`    ${bad(entry.result)} ${err.message}`);
    }
    flush();
  }
  out.finishedAt = ctx.now().toISOString();
  const logWritten = flush();
  print('');
  if (!APPLY) print('Dry run. Re-run with --apply to write.');
  else print(`  log     ${logWritten.path}  sha256 ${logWritten.sha256}`);
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
