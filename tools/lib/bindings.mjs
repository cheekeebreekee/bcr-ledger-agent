/**
 * Pure logic behind `tools/directory-bindings.mjs`. There is no I/O here: the
 * CLI gathers facts from Graph and these functions decide what they mean. That
 * split is what lets the decisions be unit-tested on synthetic fixtures.
 *
 * The decisions follow the Phase 0 isolation invariants:
 *
 * - **Staff are never client users (I9).** A `Member` id on a client row is
 *   reported, and removed only when the operator confirms it for that row.
 *   Only Guests are proposed, and never a team owner.
 * - **Ambiguity is skipped, never guessed (I3).** A guest who belongs to any
 *   Team besides the row's own (a client Team with or without the
 *   `BCR Group —` marker, or BCR GROUP) is not bound. A duplicate ClientId,
 *   NIP, site or target skips every row that shares it. An unreadable fact
 *   skips the row rather than being read as "absent".
 * - **A site path means one site.** SitePath is canonicalised by the same
 *   rule as the ingestion (contract C1: exactly `/sites/<name>` or
 *   `/teams/<name>`, a plain name, empty segments dropped, case folded).
 *   Anything else makes the row invalid, because Graph could resolve it to a
 *   site other than the one compared.
 * - **Never BCR GROUP, never the quarantine.** A row is skipped as
 *   `forbidden_target` when its path is forbidden (the forbidden list, which
 *   is required, and the quarantine path), its host is not the tenant's, or
 *   its site resolves to the Client Directory's own site collection (BCR
 *   GROUP) or to a forbidden site, whatever the path says.
 * - **One place, one client (C4).** Rows that share a site, a DriveId or a
 *   TeamId are all skipped, as the ingestion excludes all of them.
 * - **A binding already set is not changed here (I10).** A row whose RootFolder,
 *   DriveId or TeamId is set to something else is skipped for a person to look
 *   at.
 */

import { sha256 } from './cli.mjs';

export const CHANNEL_NAME = 'Dokumenty księgowe';

/**
 * The client-team description convention is `BCR Group — {recordNumber}`.
 * Any dash is accepted. Onboarding writes it; the Teams that predate
 * onboarding (`[0000]`–`[0004]`, among them TEST and PESKOVOI) do not carry
 * it. So it is a sanity check on a row's own Team (a warning), and it never
 * decides which Teams a guest belongs to: every Team-provisioned group counts.
 */
export const BCR_TEAM_DESCRIPTION = /^\s*BCR\s+Group\s*[—–-]/i;

/**
 * What `apply` always requires of the ingestion `/api/health` body, whatever
 * else the operator asks for: only the Phase-0 build routes by identity alone.
 */
export const P0_HEALTH_EXPECTATION = 'build.routing=identity-only';

export const PLAN_KIND = 'bcr.directory-bindings.plan';
export const LOG_KIND = 'bcr.directory-bindings.apply-log';
export const ROLLBACK_KIND = 'bcr.directory-bindings.rollback-log';
export const PLAN_VERSION = 1;

/** The columns this tool writes. Nothing else on a row is ever patched. */
export const BINDING_FIELDS = Object.freeze(['RootFolder', 'UserAadObjectIds', 'DriveId', 'TeamId']);

/** Columns a stale plan is detected by, besides the binding itself. */
export const GUARD_FIELDS = Object.freeze([
  'ClientId',
  'SiteHostname',
  'SitePath',
  'DriveName',
  'Status',
  'IsAdmin',
]);

/**
 * Problems that mean an id on an Active client row routes where it should
 * not, today: staff on a client row, or a bound guest who is no longer a
 * guest of that row's Team alone. `check` exits 3 when any row has one, so a
 * scheduled run can raise it (C12).
 */
export const ROUTING_DRIFT_CODES = Object.freeze(['staff_ids', 'staff_ids_removed', 'bound_guest_ineligible']);

/** Columns `--add-columns` creates (single line of text). */
export const NEW_COLUMNS = Object.freeze(['DriveId', 'TeamId']);

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/** Lower-case GUID, or `''` if the input is not one. */
export function normalizeGuid(value) {
  const t = String(value ?? '')
    .trim()
    .toLowerCase();
  return GUID.test(t) ? t : '';
}

export function splitLines(raw) {
  return String(raw ?? '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function normalizeNip(value) {
  return String(value ?? '').replace(/\D+/g, '');
}

const SITE_KIND = /^(sites|teams)$/i;
const SITE_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

/**
 * The two segments of a client site path, or `null` when the path is not
 * canonical. This is the ingestion's `canonicalSitePath` rule (contract C1),
 * and the two must agree exactly: the tests hold the same table.
 *
 * The whole string is trimmed, split on `/`, and empty segments are dropped.
 * It is canonical only with exactly two segments: `sites` or `teams`, then a
 * name of letters, digits, `_`, `-` and `.`, not starting with `.` and not
 * ending with `.`. Everything else is refused, because Graph could resolve it
 * to a site other than the one compared: `.` and `..` (URL parsing resolves
 * them), `%` escapes, `\`, whitespace or zero-width characters inside a
 * segment, sub-sites and one or three-plus segments.
 */
export function sitePathSegments(path) {
  const segments = String(path ?? '')
    .trim()
    .split('/')
    .filter(Boolean);
  if (segments.length !== 2) return null;
  const [kind, name] = segments;
  if (!SITE_KIND.test(kind) || !SITE_NAME.test(name) || name.endsWith('.')) return null;
  return segments;
}

/**
 * `/Sites//Foo/` → `/sites/foo`, the canonical form every comparison uses.
 * SharePoint URLs are case-insensitive. `null` for a path that is not
 * canonical (see `sitePathSegments`), the empty path included; callers treat
 * `null` as "matches nothing" and refuse the row.
 */
export function normalizeSitePath(path) {
  const segments = sitePathSegments(path);
  return segments ? `/${segments[0]}/${segments[1]}`.toLowerCase() : null;
}

/** A site path as an operator names it on the command line: canonical, `/sites/<name>` or `/teams/<name>`. */
export function isSiteCollectionPath(path) {
  return normalizeSitePath(path) !== null;
}

/**
 * The site collection a resolved site's web URL belongs to, as
 * `/sites/<name>` lower-cased, or `''`. Only the first two segments count, so
 * a sub-site of a forbidden site still matches it.
 */
export function siteCollectionPathOfUrl(webUrl) {
  try {
    const u = new URL(String(webUrl ?? ''));
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length < 2 || !SITE_KIND.test(parts[0])) return '';
    let name = parts[1];
    try {
      name = decodeURIComponent(name);
    } catch {
      // Keep the encoded form; it can only fail to match, never match wrongly.
    }
    return `/${parts[0]}/${name}`.toLowerCase();
  } catch {
    return '';
  }
}

/** The host of a resolved site's web URL, lower-cased, or `''`. */
export function hostOfUrl(webUrl) {
  try {
    return new URL(String(webUrl ?? '')).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * The site-collection GUID of a Graph site id (`host,<collection>,<web>`),
 * lower-cased, or `''` when the id does not have three parts.
 */
export function siteCollectionId(siteId) {
  const parts = String(siteId ?? '').split(',');
  return parts.length === 3 ? normalizeGuid(parts[1]) : '';
}

/** The only shape a tenant's SharePoint host may have (contract C2). */
export const TENANT_HOST = /^[a-z0-9-]+\.sharepoint\.com$/i;

/** For display-name comparison only: NFC, trimmed, single spaces, lower case. */
export function normalizeName(value) {
  return String(value ?? '')
    .normalize('NFC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/** A list column value as the string it is compared by. */
export function fieldString(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  return String(value).replace(/\r\n/g, '\n').trim();
}

export function pickFields(fields, names) {
  const out = {};
  for (const name of names) out[name] = fieldString(fields?.[name]);
  return out;
}

/** `host|/sites/foo`, or `''` when the path is not canonical (it then matches nothing). */
export function siteKey(hostname, sitePath) {
  const path = normalizeSitePath(sitePath);
  if (path === null) return '';
  return `${String(hostname ?? '')
    .trim()
    .toLowerCase()}|${path}`;
}

/**
 * `https://Host/sites/Foo/` → `host|/sites/foo`, or `''` if it is not a URL
 * or its path is not canonical. Only used to find the Team whose root site
 * this is; the site id is the primary key for that.
 */
export function siteUrlKey(webUrl) {
  try {
    const u = new URL(String(webUrl ?? ''));
    let path = u.pathname;
    try {
      path = decodeURIComponent(path);
    } catch {
      // Keep the encoded form; it can only fail to match, never match wrongly.
    }
    return siteKey(u.hostname, path);
  } catch {
    return '';
  }
}

/**
 * `host|path|drive|rootFolder`: the exact place a row writes to, reported as
 * `duplicate_target` because it names that place for the reviewer. It is
 * finer than what the ingestion excludes by: every row sharing a site
 * (`siteKey`, `duplicate_site`), a DriveId or a TeamId (contract C4,
 * `duplicate_driveId` / `duplicate_teamId`, and `target_conflict` in the
 * plan). Case-folded, which can only make more rows collide, never fewer.
 */
export function targetKey(row, rootFolder = row.rootFolder) {
  const site = siteKey(row.siteHostname, row.sitePath);
  if (!site) return '';
  return [
    site,
    String(row.driveName ?? '').toLowerCase(),
    String(rootFolder ?? '').trim().toLowerCase(),
  ].join('|');
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/** A Client Directory list item (`items?expand=fields`) as the tool reads it. */
export function parseDirectoryRow(item) {
  const f = item?.fields ?? {};
  const str = (v) => (typeof v === 'string' ? v : '');
  const userIds = [];
  const invalidUserIds = [];
  for (const raw of splitLines(str(f.UserAadObjectIds))) {
    const id = normalizeGuid(raw);
    if (!id) invalidUserIds.push(raw);
    else if (!userIds.includes(id)) userIds.push(id);
  }
  const status = str(f.Status).trim() || 'Active';
  return {
    listItemId: String(item?.id ?? ''),
    title: str(f.Title).trim(),
    clientId: str(f.ClientId).trim(),
    nip: normalizeNip(str(f.NIP)),
    userIds,
    invalidUserIds,
    siteHostname: str(f.SiteHostname).trim().toLowerCase(),
    sitePath: str(f.SitePath).trim(),
    // Same default the ingestion reader applies to an empty DriveName.
    driveName: str(f.DriveName).trim() || 'Documents',
    rootFolder: str(f.RootFolder).trim(),
    driveId: str(f.DriveId).trim(),
    teamId: str(f.TeamId).trim(),
    isAdmin: f.IsAdmin === true,
    status,
    active: status.toLowerCase() === 'active',
    binding: pickFields(f, BINDING_FIELDS),
    guard: pickFields(f, GUARD_FIELDS),
  };
}

/**
 * Keys shared by more than one Active row.
 *
 * `clientId`, `nip`, `site`, `target`, `driveId` and `teamId` make every row
 * involved ambiguous. The ingestion excludes every client row that shares a
 * site, a DriveId or a TeamId (C4). `userId` is what the ingestion drops key
 * by key; here it is reported. Admin rows take part in the clientId, NIP and
 * user-id checks but have no target.
 */
export function findDuplicates(rows) {
  const groups = {
    clientId: new Map(),
    nip: new Map(),
    site: new Map(),
    target: new Map(),
    driveId: new Map(),
    teamId: new Map(),
    userId: new Map(),
  };
  const add = (kind, key, id) => {
    if (!key) return;
    const map = groups[kind];
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(id);
  };
  for (const row of rows) {
    if (!row.active) continue;
    add('clientId', row.clientId.toLowerCase(), row.listItemId);
    add('nip', row.nip, row.listItemId);
    if (!row.isAdmin && row.siteHostname && row.sitePath) {
      add('site', siteKey(row.siteHostname, row.sitePath), row.listItemId);
      add('target', targetKey(row), row.listItemId);
    }
    if (!row.isAdmin) {
      add('driveId', row.driveId.toLowerCase(), row.listItemId);
      add('teamId', row.teamId.toLowerCase(), row.listItemId);
    }
    for (const id of row.userIds) add('userId', id, row.listItemId);
  }
  const out = [];
  for (const [kind, map] of Object.entries(groups)) {
    for (const [key, ids] of map) {
      if (ids.size > 1) out.push({ kind, key, listItemIds: [...ids].sort(byNumericId) });
    }
  }
  return out;
}

function byNumericId(a, b) {
  return Number(a) - Number(b) || String(a).localeCompare(String(b));
}

// ---------------------------------------------------------------------------
// Team facts
// ---------------------------------------------------------------------------

export function isBcrTeamGroup(group) {
  return BCR_TEAM_DESCRIPTION.test(String(group?.description ?? ''));
}

/**
 * Whether a group from `/users/{id}/memberOf` is a Team: its
 * `resourceProvisioningOptions` contains `Team`, or it is one of the Teams the
 * tenant listing returned, or it carries the client-team marker. A group whose
 * `resourceProvisioningOptions` was not returned at all cannot be told apart,
 * so it counts as a Team: an unknown may only exclude a guest, never bind one.
 *
 * @param {{id?:string, description?:string, resourceProvisioningOptions?:string[]}} group
 * @param {Set<string>} [knownTeamIds]  normalised ids of every Team in the tenant
 */
export function isTeamGroup(group, knownTeamIds) {
  const options = group?.resourceProvisioningOptions;
  if (Array.isArray(options) && options.some((o) => String(o).toLowerCase() === 'team')) return true;
  if (knownTeamIds?.has(normalizeGuid(group?.id))) return true;
  if (isBcrTeamGroup(group)) return true;
  return !Array.isArray(options);
}

/**
 * Index Teams by their root site, from one `{ team, site }` per Team where
 * `site` is the `/groups/{id}/sites/root` response or `{ error }`.
 *
 * Both the site id and the web URL are keys: the id is what Graph returns for
 * the row's own site, the URL is what a person reads. A Team whose site could
 * not be read is listed in `unreadable`, so "no Team for this site" can say
 * that the answer may be hiding there.
 */
export function mapSitesToTeams(entries) {
  const bySiteId = new Map();
  const byUrl = new Map();
  const unreadable = [];
  const add = (map, key, team) => {
    if (!key) return;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(team);
  };
  for (const { team, site } of entries ?? []) {
    if (!site || isError(site)) {
      unreadable.push({
        teamId: team?.id ?? '',
        displayName: team?.displayName ?? '',
        error: site?.error ?? 'no root site',
      });
      continue;
    }
    add(bySiteId, String(site.id ?? '').toLowerCase(), team);
    add(byUrl, siteUrlKey(site.webUrl), team);
  }
  return { bySiteId, byUrl, unreadable };
}

/**
 * The Team whose root site is `site`: the team, `null` when none is, or
 * `{ error }` when more than one claims it (which Teams should never allow,
 * and which is therefore ambiguous rather than resolved by picking one).
 */
export function findTeamForSite(index, site) {
  const byId = index.bySiteId.get(String(site?.id ?? '').toLowerCase()) ?? [];
  const byUrl = index.byUrl.get(siteUrlKey(site?.webUrl)) ?? [];
  const ids = new Set([...byId, ...byUrl].map((t) => normalizeGuid(t.id)));
  if (ids.size > 1) return { error: `${ids.size} Teams claim this site as their root site` };
  return byId[0] ?? byUrl[0] ?? null;
}

/** The one `Dokumenty księgowe` channel, or why there is not exactly one standard one. */
export function pickAccountingChannel(channels, name = CHANNEL_NAME) {
  const wanted = normalizeName(name);
  const matches = (channels ?? []).filter((c) => normalizeName(c.displayName) === wanted);
  if (matches.length === 0) return { status: 'missing', candidates: [] };
  if (matches.length > 1) return { status: 'ambiguous', candidates: matches };
  const [channel] = matches;
  if (channel.membershipType !== 'standard') {
    return { status: 'not_standard', channel, candidates: matches };
  }
  return { status: 'ok', channel, candidates: matches };
}

/**
 * Split a team's people into the guests that may be bound to this client and
 * everyone else, with the reason.
 *
 * A guest is eligible only when this Team is the only Team they belong to.
 * Every Team counts, not only those carrying the `BCR Group —` marker: the
 * client Teams that predate onboarding have no marker, and neither has BCR
 * GROUP. A guest who is also in any other Team is excluded as
 * `guest_in_other_team`, with those Teams listed for the reviewer; binding
 * them here would file every upload of theirs, including another company's
 * documents, into this client's channel.
 *
 * @param {object} p
 * @param {string} p.teamId
 * @param {Array<{id:string,userType?:string,displayName?:string,userPrincipalName?:string}>} p.members
 * @param {Array<{id:string}>} p.owners
 * @param {Map<string, Array<{id:string,displayName?:string,description?:string,resourceProvisioningOptions?:string[]}> | {error:string}>} p.memberOfByUser
 * @param {Set<string>} [p.knownTeamIds]  normalised ids of every Team in the tenant
 */
export function classifyTeamPeople({ teamId, members, owners, memberOfByUser, knownTeamIds }) {
  const team = normalizeGuid(teamId);
  const ownerIds = new Set((owners ?? []).map((o) => normalizeGuid(o.id)).filter(Boolean));
  const eligible = [];
  const excluded = [];
  for (const m of members ?? []) {
    const id = normalizeGuid(m.id);
    if (!id) continue;
    const who = { id, displayName: m.displayName ?? '', userPrincipalName: m.userPrincipalName ?? '' };
    if (ownerIds.has(id)) {
      excluded.push({ ...who, reason: 'owner' });
      continue;
    }
    if (m.userType !== 'Guest') {
      excluded.push({ ...who, reason: 'not_a_guest', userType: m.userType ?? 'unknown' });
      continue;
    }
    const groups = memberOfByUser?.get(id);
    if (!Array.isArray(groups)) {
      excluded.push({ ...who, reason: 'memberships_unreadable' });
      continue;
    }
    const teams = groups.filter((g) => isTeamGroup(g, knownTeamIds));
    const otherTeams = teams
      .filter((g) => normalizeGuid(g.id) !== team)
      .map((g) => ({ id: normalizeGuid(g.id) || String(g.id ?? ''), displayName: g.displayName ?? '' }));
    if (otherTeams.length) {
      excluded.push({ ...who, reason: 'guest_in_other_team', otherTeams });
      continue;
    }
    if (!teams.length) {
      // The roster says they are a member; their own memberships do not.
      // Two reads disagree, so nothing is inferred from either.
      excluded.push({ ...who, reason: 'guest_not_in_this_team' });
      continue;
    }
    eligible.push(who);
  }
  eligible.sort((a, b) => a.id.localeCompare(b.id));
  return { eligible, excluded };
}

/**
 * Whether the ingestion's managed identity (its app id, INGEST_MI_APPID) may
 * write to a site, from
 * `GET /sites/{id}/permissions`. `null` means the caller could not read the
 * permissions, which is common: it needs Sites.FullControl.All.
 *
 * @returns {'granted'|'missing'|'unknown'}
 */
export function evaluateWriteGrant(permissions, ingestAppIds) {
  const wanted = new Set([...(ingestAppIds ?? [])].map(normalizeGuid).filter(Boolean));
  if (!Array.isArray(permissions) || wanted.size === 0) return 'unknown';
  for (const p of permissions) {
    const roles = (p.roles ?? []).map((r) => String(r).toLowerCase());
    if (!roles.some((r) => r === 'write' || r === 'owner' || r === 'fullcontrol')) continue;
    const identities = [
      ...(p.grantedToIdentitiesV2 ?? []),
      ...(p.grantedToIdentities ?? []),
      ...(p.grantedToV2 ? [p.grantedToV2] : []),
      ...(p.grantedTo ? [p.grantedTo] : []),
    ];
    if (identities.some((i) => wanted.has(normalizeGuid(i?.application?.id)))) return 'granted';
  }
  return 'missing';
}

/**
 * Whether a folder sits directly under its drive's root. The item's
 * `parentReference.id` is compared with the root's id when both are known;
 * otherwise the path must end at `root:`.
 */
export function folderAtDriveRoot(folder, driveRootId) {
  const parent = folder?.parentReference ?? {};
  if (parent.id && driveRootId) return parent.id === driveRootId;
  return /\/root:?$/.test(String(parent.path ?? ''));
}

const FORBIDDEN_CHARS = /["*:<>?/\\|]/g;
// prettier-ignore
const RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

/**
 * Whether the ingestion's path sanitiser (`utils/pathBuilder.ts`,
 * `sanitizeSegment`) would leave this folder name unchanged. If it would not,
 * the uploader creates a sibling folder with the altered name and the files
 * never appear in the channel.
 */
export function survivesIngestionSanitiser(name) {
  const s = String(name ?? '');
  if (!s || s.length > 255) return false;
  const cleaned = s
    .trim()
    .replace(FORBIDDEN_CHARS, '_')
    .replace(/\s+/g, ' ')
    .replace(/^\.+|\.+$/g, '');
  if (cleaned !== s) return false;
  return !RESERVED_NAMES.has(cleaned.toUpperCase().split('.')[0] ?? '');
}

// ---------------------------------------------------------------------------
// One row
// ---------------------------------------------------------------------------

const isError = (v) => Boolean(v && typeof v === 'object' && 'error' in v);

const describeTeam = (t) => `${t.id}${t.displayName ? ` "${t.displayName}"` : ''}`;

/**
 * Why a client row may never be bound, whatever else is true of it; empty
 * when nothing forbids it. The ingestion refuses the same places: by path
 * (FORBIDDEN_TARGET_SITE_PATHS and the quarantine path), by host (the tenant's
 * only SharePoint host, QUARANTINE_SITE_HOSTNAME), and by the site Graph
 * actually resolves (the Client Directory's own site collection, BCR GROUP,
 * and any forbidden site the web URL lands in), so that no spelling of a
 * path gets round the first check.
 *
 * @param {ReturnType<typeof parseDirectoryRow>} row
 * @param {object | {error:string} | undefined} site  the resolved site, if looked up
 * @param {object} ctx
 * @param {Set<string>} [ctx.forbiddenSitePaths]       canonical paths
 * @param {string} [ctx.tenantHost]                   lower-case host, or ''
 * @param {string} [ctx.directorySiteCollectionId]    lower-case GUID, or ''
 * @returns {string[]}
 */
export function forbiddenTargetReasons(row, site, ctx = {}) {
  if (row.isAdmin) return [];
  const why = [];
  const canonical = normalizeSitePath(row.sitePath);
  if (canonical && ctx.forbiddenSitePaths?.has(canonical)) {
    why.push('SitePath is a forbidden target (FORBIDDEN_TARGET_SITE_PATHS or the quarantine site)');
  }
  if (ctx.tenantHost && row.siteHostname && row.siteHostname !== ctx.tenantHost) {
    why.push(`SiteHostname is not ${ctx.tenantHost}, the only SharePoint host a row may name`);
  }
  if (site && !isError(site)) {
    const collection = siteCollectionId(site.id);
    if (ctx.directorySiteCollectionId) {
      if (!collection) {
        why.push('the resolved site id is not <host>,<collection>,<web>; it cannot be checked against BCR GROUP');
      } else if (collection === ctx.directorySiteCollectionId) {
        why.push("the site resolves to the Client Directory's own site collection (BCR GROUP)");
      }
    }
    const resolvedPath = siteCollectionPathOfUrl(site.webUrl);
    if (resolvedPath && resolvedPath !== canonical && ctx.forbiddenSitePaths?.has(resolvedPath)) {
      why.push(`the site resolves to ${resolvedPath}, a forbidden target`);
    }
    const host = hostOfUrl(site.webUrl);
    if (ctx.tenantHost && host && host !== ctx.tenantHost) {
      why.push(`the site resolves to host ${host}, not ${ctx.tenantHost}`);
    }
  }
  return why;
}

/**
 * What to do when the grant cannot be read. Verifying is a read. The grant
 * runbook is a write: it creates a write grant whenever it finds none, so it
 * is never the way to "check" one.
 */
export const WRITE_GRANT_UNKNOWN =
  'unknown: verify read-only with GET /sites/{site-id}/permissions (Graph Explorer, ' +
  'Sites.FullControl.All); it must list a "write" role for the app id of the ingestion ' +
  "Function App's system-assigned managed identity (INGEST_MI_APPID), not the API app registration. " +
  "Grant-TeamSiteAccess.ps1 CREATES a write grant: run it only to grant one on this client's own site, " +
  'never on a forbidden site such as BCR GROUP. Once verified, pass';

/**
 * Everything the tool can say about one row: the problems, and the values it
 * would propose. Used by `check` (problems only) and `propose`.
 *
 * `facts` fields may each be missing (not looked up) or `{ error }`
 * (looked up and failed). Both skip the row.
 *
 * @param {ReturnType<typeof parseDirectoryRow>} row
 * @param {object} facts
 * @param {object} ctx
 * @param {Set<string>} [ctx.forbiddenSitePaths]  normalised site paths, the quarantine path included
 * @param {string} [ctx.tenantHost]               the tenant's SharePoint host, lower-case
 * @param {string} [ctx.directorySiteCollectionId] site-collection GUID of the Client Directory site
 * @param {Set<string>} [ctx.knownTeamIds]       normalised ids of every Team in the tenant
 * @param {Set<string>} [ctx.ingestAppIds]
 * @param {Set<string>} [ctx.writeVerified]       normalised site paths or list item ids
 * @param {Set<string>} [ctx.confirmRemoveStaff]  list item ids
 * @param {ReturnType<typeof findDuplicates>} [ctx.duplicates]
 * @param {string} [ctx.channelName]
 * @param {number} [ctx.unreadableTeamSites]
 */
export function assessRow(row, facts = {}, ctx = {}) {
  const problems = [];
  const add = (code, severity, detail) => problems.push({ code, severity, detail });
  const evidence = {};

  if (row.isAdmin) add('admin_row', 'skip', 'staff/admin row; bindings are for client rows only');
  if (!row.clientId) add('no_client_id', 'skip', 'row has no ClientId');
  if (!row.isAdmin && (!row.siteHostname || !row.sitePath)) {
    add('no_site', 'skip', 'row has no SiteHostname/SitePath');
  }
  const canonicalPath = normalizeSitePath(row.sitePath);
  // An empty SitePath is `no_site`; only a path that is there can be malformed.
  const pathNotCanonical = Boolean(row.sitePath) && canonicalPath === null;
  if (pathNotCanonical) {
    add(
      'site_path_not_canonical',
      'skip',
      'SitePath is not exactly /sites/<name> or /teams/<name> with a plain name (letters, digits, ' +
        '"_", "-", "."; no "." or ".." segment, no "%", "\\" or spaces, no sub-site). Graph could ' +
        'resolve it to another site, and the ingestion excludes the row. Correct it by hand to ' +
        "the path of the Team's root site",
    );
  }
  const forbiddenWhy = forbiddenTargetReasons(row, facts.site, ctx);
  const forbidden = forbiddenWhy.length > 0;
  if (forbidden) add('forbidden_target', 'skip', forbiddenWhy.join('; '));

  for (const dup of ctx.duplicates ?? []) {
    if (!dup.listItemIds.includes(row.listItemId)) continue;
    const others = dup.listItemIds.filter((id) => id !== row.listItemId).join(', ');
    if (dup.kind === 'userId') {
      add('duplicate_user_id', 'warn', `user id ${dup.key} is also on row(s) ${others}`);
    } else {
      add(`duplicate_${dup.kind}`, 'skip', `${dup.kind} is shared with row(s) ${others}`);
    }
  }

  if (row.invalidUserIds.length) {
    add('invalid_user_ids', 'warn', `${row.invalidUserIds.length} UserAadObjectIds line(s) are not GUIDs`);
  }
  if (!row.isAdmin && (!row.rootFolder || !row.driveId || !row.teamId)) {
    add(
      'unbound_target',
      'warn',
      "RootFolder, DriveId or TeamId is empty: the ingestion quarantines this row's users " +
        '(unbound_target) until an apply binds all three',
    );
  }

  // --- the ids already on the row ------------------------------------------
  const usersById = facts.usersById ?? new Map();
  const staff = [];
  const notFound = [];
  for (const id of row.userIds) {
    const user = usersById.get(id);
    if (user === undefined) continue;
    if (user === null) notFound.push(id);
    else if (isError(user)) add('user_lookup_failed', 'skip', `could not read user ${id}: ${user.error}`);
    else if (user.userType === 'Member') staff.push({ id, userPrincipalName: user.userPrincipalName ?? '' });
  }
  if (!row.isAdmin && staff.length) {
    const list = staff.map((s) => s.userPrincipalName || s.id).join(', ');
    if (ctx.confirmRemoveStaff?.has(row.listItemId)) {
      add('staff_ids_removed', 'warn', `staff (Member) ids will be removed, as confirmed: ${list}`);
    } else {
      add(
        'staff_ids',
        'skip',
        `staff (Member) ids on a client row: ${list}. Re-run propose with ` +
          `--confirm-remove-staff ${row.listItemId} to remove them`,
      );
    }
  }
  if (notFound.length) add('unknown_user_ids', 'warn', `${notFound.length} id(s) match no user`);

  // --- site and team -------------------------------------------------------
  const { site, team } = facts;
  if (isError(site)) add('site_unresolved', 'skip', `site not readable: ${site.error}`);
  else if (site) evidence.siteId = site.id;

  if (site && !isError(site)) {
    if (isError(team)) add('team_lookup_failed', 'skip', team.error);
    else if (!team) {
      const hint = ctx.unreadableTeamSites
        ? ` (${ctx.unreadableTeamSites} team site(s) could not be read; it may be one of them)`
        : '';
      add('no_team', 'skip', `the row's site is not the root site of any Team${hint}`);
    }
  }
  const teamOk = team && !isError(team);
  if (teamOk) {
    evidence.teamId = team.id;
    evidence.teamDisplayName = team.displayName ?? '';
    evidence.visibility = team.visibility ?? 'unknown';
    if (String(team.visibility).toLowerCase() === 'public') {
      add('public_team', 'skip', 'the Team is Public; binding skipped (this tool never changes visibility)');
    }
    if (!isBcrTeamGroup(team)) {
      // The Team is the one whose root site is this row's own site, found
      // uniquely; the marker adds nothing to that. Teams that predate
      // onboarding never had it, so it is reported, not required.
      add(
        'team_not_bcr',
        'warn',
        'the Team description does not follow "BCR Group — {recordNumber}" (a Team that ' +
          "predates onboarding?). It is bound because it is the one Team whose root site is this row's site",
      );
    }
    const existingTeam = normalizeGuid(row.teamId);
    if (row.teamId && existingTeam !== normalizeGuid(team.id)) {
      add('team_id_conflict', 'skip', 'row already has a different TeamId; change bindings by hand');
    }
  }

  // --- channel and folder --------------------------------------------------
  const { channels, filesFolder } = facts;
  let channelOk = false;
  if (teamOk) {
    if (isError(channels)) add('channel_lookup_failed', 'skip', channels.error);
    else if (Array.isArray(channels)) {
      const pick = pickAccountingChannel(channels, ctx.channelName ?? CHANNEL_NAME);
      if (pick.status === 'missing') add('channel_missing', 'skip', `no "${ctx.channelName ?? CHANNEL_NAME}" channel`);
      if (pick.status === 'ambiguous') add('channel_ambiguous', 'skip', `${pick.candidates.length} channels match`);
      if (pick.status === 'not_standard') {
        add('channel_not_standard', 'skip', `membershipType is ${pick.channel.membershipType ?? 'missing'}`);
      }
      if (pick.channel) evidence.channelId = pick.channel.id;
      channelOk = pick.status === 'ok';
    }
  }
  let folderOk = false;
  if (channelOk) {
    if (isError(filesFolder)) add('files_folder_unavailable', 'skip', filesFolder.error);
    else if (filesFolder) {
      evidence.filesFolderId = filesFolder.id;
      evidence.filesFolderName = filesFolder.name;
      folderOk = true;
      if (!folderAtDriveRoot(filesFolder, filesFolder.driveRootId)) {
        add('folder_not_at_root', 'skip', 'the channel folder is not directly under the drive root');
        folderOk = false;
      }
      if (!survivesIngestionSanitiser(filesFolder.name)) {
        add('folder_name_unsafe', 'skip', 'the ingestion path sanitiser would alter this folder name');
        folderOk = false;
      }
    }
  }

  // --- drive ---------------------------------------------------------------
  const { drives } = facts;
  let drive;
  if (isError(drives)) add('drive_lookup_failed', 'skip', drives.error);
  else if (Array.isArray(drives)) {
    // Exact, as the ingestion matches it (sharePointService.resolveTarget).
    drive = drives.find((d) => d.name === row.driveName);
    if (!drive) {
      const near = drives.find((d) => normalizeName(d.name) === normalizeName(row.driveName));
      const names = drives.map((d) => d.name).join(', ');
      add(
        'drive_not_found',
        'skip',
        `no drive named "${row.driveName}"${near ? ` (did you mean "${near.name}"?)` : ''}; drives: ${names}`,
      );
    } else {
      evidence.driveId = drive.id;
      evidence.driveName = drive.name;
    }
  }
  const folderDriveId = filesFolder && !isError(filesFolder) ? filesFolder.parentReference?.driveId : undefined;
  if (drive && folderOk && folderDriveId !== drive.id) {
    add('drive_mismatch', 'skip', `the channel folder is in another drive than "${row.driveName}"`);
    folderOk = false;
  }
  if (drive && row.driveId && row.driveId !== drive.id) {
    add('drive_id_conflict', 'skip', 'row already has a different DriveId; change bindings by hand');
  }
  if (folderOk && row.rootFolder && row.rootFolder !== filesFolder.name) {
    add('root_folder_conflict', 'skip', `row already has RootFolder "${row.rootFolder}"; change bindings by hand`);
  }

  // --- people --------------------------------------------------------------
  const { members, owners } = facts;
  let people;
  if (teamOk) {
    if (isError(members) || isError(owners)) {
      add('membership_lookup_failed', 'skip', (isError(members) ? members : owners).error);
    } else if (Array.isArray(members) && Array.isArray(owners)) {
      people = classifyTeamPeople({
        teamId: team.id,
        members,
        owners,
        memberOfByUser: facts.memberOfByUser ?? new Map(),
        ...(ctx.knownTeamIds ? { knownTeamIds: ctx.knownTeamIds } : {}),
      });
      const unreadable = people.excluded.filter((e) => e.reason === 'memberships_unreadable');
      if (unreadable.length) {
        add('guest_memberships_unreadable', 'skip', `${unreadable.length} guest(s) whose memberships could not be read`);
      }
      const inOther = people.excluded.filter((e) => e.reason === 'guest_in_other_team');
      if (inOther.length) {
        const list = inOther
          .map((e) => `${e.userPrincipalName || e.id} also in ${e.otherTeams.map(describeTeam).join(', ')}`)
          .join('; ');
        add('guest_in_other_team', 'warn', `${inOther.length} guest(s) not bound: ${list}`);
      }
      const disagree = people.excluded.filter((e) => e.reason === 'guest_not_in_this_team');
      if (disagree.length) {
        add(
          'guest_not_in_this_team',
          'warn',
          `${disagree.length} guest(s) not bound: listed as members, but their memberships do not include this Team`,
        );
      }
      if (people.eligible.length === 0) {
        add(
          'no_eligible_guest',
          'warn',
          "no guest belongs to this Team alone; the client's uploads go to quarantine",
        );
      }
      // Ids already on the row that this Team no longer vouches for: a guest
      // since added to another Team, or dropped from this one (R46). They
      // route here until a PATCH takes them off. Staff and unknown ids have
      // their own codes.
      const eligibleIds = new Set(people.eligible.map((p) => p.id));
      const excludedById = new Map(people.excluded.map((e) => [e.id, e]));
      const drifted = row.isAdmin
        ? []
        : row.userIds.filter((id) => {
            const user = usersById.get(id);
            if (user === null || (user && !isError(user) && user.userType === 'Member')) return false;
            return !eligibleIds.has(id);
          });
      if (drifted.length) {
        const list = drifted
          .map((id) => {
            const e = excludedById.get(id);
            if (!e) return `${id} (not a member of this Team)`;
            const teams = e.otherTeams?.length ? `: also in ${e.otherTeams.map(describeTeam).join(', ')}` : '';
            return `${e.userPrincipalName || id} (${e.reason}${teams})`;
          })
          .join('; ');
        add(
          'bound_guest_ineligible',
          'warn',
          `${drifted.length} id(s) on the row are not guests of this Team alone, and route here until ` +
            `the plan's PATCH takes them off. Run propose and apply the whole plan: ${list}`,
        );
      }
    }
  }

  // --- write grant ---------------------------------------------------------
  // Only for a client row whose site resolved: an admin row files nowhere,
  // and an unresolved site is already a skip with a better reason. Never for
  // a forbidden or non-canonical site: that row is never bound, and advice
  // about the ingestion's grant there could only lead someone to widen it.
  const siteResolved = Boolean(site && !isError(site));
  const grant =
    row.isAdmin || forbidden || pathNotCanonical || !siteResolved
      ? 'n/a'
      : evaluateWriteGrant(facts.permissions, ctx.ingestAppIds);
  evidence.writeGrant = grant;
  if (grant === 'missing') {
    add(
      'write_grant_missing',
      'skip',
      "the ingestion Function App's managed identity (--ingest-app-ids) has no write permission on this site",
    );
  } else if (grant === 'unknown') {
    const verified = ctx.writeVerified?.has(canonicalPath) || ctx.writeVerified?.has(row.listItemId);
    if (verified) {
      evidence.writeGrant = 'operator-verified';
    } else {
      add('write_grant_unknown', 'skip', `${WRITE_GRANT_UNKNOWN} --write-verified ${row.sitePath || row.listItemId}`);
    }
  }

  // --- the proposal --------------------------------------------------------
  let proposed = null;
  const removedUserIds = [];
  const addedUserIds = [];
  if (folderOk && drive && teamOk && people) {
    const eligibleIds = people.eligible.map((g) => g.id);
    proposed = {
      RootFolder: filesFolder.name,
      UserAadObjectIds: eligibleIds.join('\n'),
      DriveId: drive.id,
      TeamId: team.id,
    };
    const excludedById = new Map(people.excluded.map((e) => [e.id, e]));
    for (const id of row.userIds) {
      if (eligibleIds.includes(id)) continue;
      const user = usersById.get(id);
      let reason = 'not_a_member_of_this_team';
      if (user === null) reason = 'not_found';
      else if (user && !isError(user) && user.userType === 'Member') reason = 'staff';
      else if (excludedById.has(id)) reason = excludedById.get(id).reason;
      const otherTeams = excludedById.get(id)?.otherTeams;
      removedUserIds.push({
        id,
        reason,
        userPrincipalName: (user && !isError(user) && user.userPrincipalName) || '',
        ...(otherTeams ? { otherTeams } : {}),
      });
    }
    for (const raw of row.invalidUserIds) removedUserIds.push({ id: raw, reason: 'not_a_guid' });
    for (const g of people.eligible) {
      if (!row.userIds.includes(g.id)) addedUserIds.push({ id: g.id, userPrincipalName: g.userPrincipalName });
    }
  }

  return {
    listItemId: row.listItemId,
    clientId: row.clientId,
    title: row.title,
    sitePath: row.sitePath,
    problems,
    evidence,
    proposed,
    removedUserIds,
    addedUserIds,
    eligibleGuests: people?.eligible ?? [],
    excludedPeople: people?.excluded ?? [],
    guestsRead: Boolean(people),
  };
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

function sameIdSet(a, b) {
  const x = splitLines(a).map((s) => s.toLowerCase()).sort();
  const y = splitLines(b).map((s) => s.toLowerCase()).sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/** Only the fields whose value would change. */
export function diffBinding(before, proposed) {
  const patch = {};
  for (const field of BINDING_FIELDS) {
    if (!(field in proposed)) continue;
    const next = proposed[field];
    const same =
      field === 'UserAadObjectIds'
        ? sameIdSet(before[field], next) && splitLines(before[field]).every((l) => normalizeGuid(l))
        : fieldString(before[field]) === fieldString(next);
    if (!same) patch[field] = next;
  }
  return patch;
}

/**
 * Digest of the rows exactly as propose wrote them. `apply` recomputes it, so
 * a plan edited by hand after review is refused rather than applied.
 */
export function planDigest(rows) {
  return sha256(JSON.stringify(rows));
}

/**
 * Turn row assessments into a plan, then settle what the rows mean together:
 *
 * - a proposed user id already on another row (as it will stand after the
 *   plan) is dropped from the proposal, so the plan never creates a
 *   duplicate that the ingestion would then drop for both clients;
 * - rows that would share a site, a DriveId or a TeamId after the plan are
 *   all skipped as `target_conflict`, since the ingestion excludes every one
 *   of them (C4).
 *
 * Repeats until nothing changes, since a skip reverts a row to its current
 * values and can create a new collision.
 */
export function buildPlan({ rows, assessments, directory, ingestAppIds = [], guards, createdAt }) {
  const rowById = new Map(rows.map((r) => [r.listItemId, r]));
  const entries = assessments.map((a) => {
    const row = rowById.get(a.listItemId);
    const skips = a.problems.filter((p) => p.severity === 'skip');
    const entry = {
      listItemId: a.listItemId,
      clientId: a.clientId,
      title: a.title,
      sitePath: a.sitePath,
      action: 'SKIP',
      reasons: skips.map(({ code, detail }) => ({ code, detail })),
      warnings: a.problems.filter((p) => p.severity !== 'skip').map(({ code, detail }) => ({ code, detail })),
      before: { ...row.binding },
      guard: { ...row.guard },
      patch: {},
      proposed: a.proposed ? { ...a.proposed } : null,
      removedUserIds: a.removedUserIds,
      addedUserIds: a.addedUserIds,
      // The guests of this Team alone, where the Team's people were read.
      // IR-1 (`inventory-misfiled.mjs --bindings-plan`) checks uploaders
      // against them; it is not what gets written (that is `patch`).
      ...(a.guestsRead
        ? { eligibleGuests: a.eligibleGuests.map(({ id, userPrincipalName }) => ({ id, userPrincipalName })) }
        : {}),
      // The Team's guests who are not bound, and why: a reviewer must see a
      // guest left out because they are also in another Team, and which one.
      excludedGuests: (a.excludedPeople ?? [])
        .filter((p) => p.reason !== 'owner' && p.reason !== 'not_a_guest')
        .map(({ id, userPrincipalName, reason, otherTeams }) => ({
          id,
          userPrincipalName,
          reason,
          ...(otherTeams ? { otherTeams } : {}),
        })),
      evidence: a.evidence,
    };
    if (skips.length === 0 && !a.proposed) {
      entry.reasons.push({ code: 'incomplete_facts', detail: 'not enough facts to propose values' });
    }
    return entry;
  });

  const settle = (entry) => {
    if (entry.reasons.length) {
      entry.action = 'SKIP';
      entry.patch = {};
      return;
    }
    entry.patch = diffBinding(entry.before, entry.proposed);
    entry.action = Object.keys(entry.patch).length ? 'PATCH' : 'NOOP';
  };
  entries.forEach(settle);

  const finalIds = (e) =>
    splitLines(e.action === 'PATCH' && 'UserAadObjectIds' in e.patch ? e.patch.UserAadObjectIds : e.before.UserAadObjectIds)
      .map(normalizeGuid)
      .filter(Boolean);
  const finalValue = (e, field) =>
    fieldString(e.action === 'PATCH' && field in e.patch ? e.patch[field] : e.before[field]);

  for (let pass = 0; pass < 10; pass += 1) {
    let changed = false;

    // user ids
    for (const e of entries) {
      if (e.action !== 'PATCH' || !e.proposed) continue;
      const mine = splitLines(e.proposed.UserAadObjectIds);
      const kept = mine.filter((id) => {
        const clash = entries.some((o) => o !== e && rowById.get(o.listItemId).active && finalIds(o).includes(id));
        if (clash) {
          e.warnings.push({ code: 'user_id_conflict', detail: `${id} is on another row; not added here` });
          e.addedUserIds = e.addedUserIds.filter((g) => g.id !== id);
        }
        return !clash;
      });
      if (kept.length !== mine.length) {
        e.proposed.UserAadObjectIds = kept.join('\n');
        settle(e);
        changed = true;
      }
    }

    // targets: the ingestion excludes every row that shares a site, a DriveId
    // or a TeamId (C4), as the rows will stand after the plan.
    const byTarget = new Map();
    const put = (key, e) => {
      if (!byTarget.has(key)) byTarget.set(key, []);
      byTarget.get(key).push(e);
    };
    for (const e of entries) {
      const row = rowById.get(e.listItemId);
      if (!row.active || row.isAdmin) continue;
      // A non-canonical SitePath is already a SKIP and has no site key.
      const site = row.siteHostname && row.sitePath ? siteKey(row.siteHostname, row.sitePath) : '';
      if (site) put(`site ${site}`, e);
      const drive = finalValue(e, 'DriveId').toLowerCase();
      if (drive) put(`DriveId ${drive}`, e);
      const teamValue = finalValue(e, 'TeamId').toLowerCase();
      if (teamValue) put(`TeamId ${teamValue}`, e);
    }
    for (const [key, group] of byTarget) {
      if (group.length < 2) continue;
      const kind = key.slice(0, key.indexOf(' '));
      for (const e of group) {
        if (e.action !== 'PATCH') continue;
        const others = group.filter((o) => o !== e).map((o) => o.listItemId).join(', ');
        e.reasons.push({ code: 'target_conflict', detail: `${kind} would equal that of row(s) ${others}` });
        settle(e);
        changed = true;
      }
    }

    if (!changed) break;
  }

  // `proposed` stays on every row, SKIP included: it is what a reviewer reads
  // to judge a skip. Only `patch` is ever applied, and only on PATCH rows.
  const planRows = entries;
  return {
    kind: PLAN_KIND,
    version: PLAN_VERSION,
    createdAt: createdAt ?? new Date().toISOString(),
    directory,
    ingestAppIds: [...ingestAppIds],
    // What the rows were checked against (forbidden paths, quarantine path,
    // tenant host, the Directory's site collection). Outside the digest:
    // `apply` checks every row again, and a recorded value can only add to
    // what it is given, never remove from it.
    ...(guards ? { guards } : {}),
    digest: planDigest(planRows),
    rows: planRows,
  };
}

/** Shape errors in a plan file; empty when it may be applied. */
export function validatePlan(plan) {
  const errors = [];
  if (plan?.kind !== PLAN_KIND) errors.push(`kind is not ${PLAN_KIND}`);
  if (plan?.version !== PLAN_VERSION) errors.push(`version is not ${PLAN_VERSION}`);
  if (!plan?.directory?.siteId || !plan?.directory?.listId) errors.push('directory.siteId/listId missing');
  if (!Array.isArray(plan?.rows)) {
    errors.push('rows is not an array');
    return errors;
  }
  if (plan.digest !== planDigest(plan.rows)) {
    errors.push('digest does not match the rows: the plan was edited after propose. Re-run propose.');
  }
  const seen = new Set();
  for (const row of plan.rows) {
    const at = `row ${row?.listItemId ?? '?'}`;
    if (!row || typeof row !== 'object') {
      errors.push(`${at}: not an object`);
      continue;
    }
    if (!row.listItemId) errors.push(`${at}: listItemId missing`);
    if (seen.has(row.listItemId)) errors.push(`${at}: appears twice`);
    seen.add(row.listItemId);
    if (!['PATCH', 'SKIP', 'NOOP'].includes(row.action)) errors.push(`${at}: unknown action ${row.action}`);
    if (row.action === 'SKIP' && !(row.reasons ?? []).length) errors.push(`${at}: SKIP without a reason`);
    if (row.action === 'PATCH') {
      if ((row.reasons ?? []).length) errors.push(`${at}: PATCH with skip reasons`);
      const keys = Object.keys(row.patch ?? {});
      if (!keys.length) errors.push(`${at}: PATCH with an empty patch`);
      for (const k of keys) if (!BINDING_FIELDS.includes(k)) errors.push(`${at}: patches ${k}, not a binding field`);
      const p = row.patch ?? {};
      if ('RootFolder' in p && !survivesIngestionSanitiser(p.RootFolder)) errors.push(`${at}: RootFolder unsafe`);
      if ('TeamId' in p && !normalizeGuid(p.TeamId)) errors.push(`${at}: TeamId is not a GUID`);
      if ('DriveId' in p && !String(p.DriveId).trim()) errors.push(`${at}: DriveId empty`);
      if ('UserAadObjectIds' in p && !splitLines(p.UserAadObjectIds).every((l) => normalizeGuid(l))) {
        errors.push(`${at}: UserAadObjectIds has a non-GUID line`);
      }
      for (const f of BINDING_FIELDS) if (typeof row.before?.[f] !== 'string') errors.push(`${at}: before.${f} missing`);
      // A row routes only once RootFolder, DriveId and TeamId are all set
      // (C3); a PATCH never leaves one of them empty.
      const unbound = ['RootFolder', 'DriveId', 'TeamId'].filter((f) => !fieldString(f in p ? p[f] : row.before?.[f]));
      if (unbound.length) errors.push(`${at}: PATCH leaves ${unbound.join(', ')} empty`);
    }
  }
  return errors;
}

/**
 * Differences between what the plan saw and the row as it is now. Any
 * difference in the binding or the guard columns makes the planned change
 * stale: it was reasoned from a row that no longer exists.
 */
export function staleFields(planRow, currentFields) {
  const now = { ...pickFields(currentFields, BINDING_FIELDS), ...pickFields(currentFields, GUARD_FIELDS) };
  const then = { ...(planRow.before ?? {}), ...(planRow.guard ?? {}) };
  return Object.keys(then).filter((k) => fieldString(then[k]) !== now[k]);
}

/** The patch that restores a logged row's before-state. Absent values become ''. */
export function rollbackPatch(logRow) {
  const patch = {};
  for (const field of Object.keys(logRow.patch ?? {})) patch[field] = fieldString(logRow.before?.[field]);
  return patch;
}

/** Fields of a logged row that changed since it was applied. */
export function changedSinceApply(logRow, currentFields) {
  return Object.keys(logRow.patch ?? {}).filter(
    (f) => fieldString(currentFields?.[f]) !== fieldString(logRow.after?.[f]),
  );
}

/**
 * The expectations `apply` checks: always the P0 routing marker, then any
 * the operator adds. Extra ones can only narrow the gate, never replace it.
 */
export function healthExpectations(extra = []) {
  return [P0_HEALTH_EXPECTATION, ...extra.filter((e) => e !== P0_HEALTH_EXPECTATION)];
}

/**
 * Whether a `/api/health` body satisfies every `key=value` expectation.
 * Dotted keys reach into nested objects. Values compare as strings.
 */
export function healthSatisfies(body, expectations) {
  const missing = [];
  for (const exp of expectations) {
    const at = exp.indexOf('=');
    if (at <= 0) {
      missing.push(`${exp} (not key=value)`);
      continue;
    }
    const key = exp.slice(0, at);
    const want = exp.slice(at + 1);
    const got = key.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), body);
    if (got === undefined || String(got) !== want) missing.push(`${key}=${want} (got ${got === undefined ? 'nothing' : String(got)})`);
  }
  return { ok: missing.length === 0, missing };
}
