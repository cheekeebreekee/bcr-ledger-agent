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
 * - **Ambiguity is skipped, never guessed (I3).** A guest in several
 *   `BCR Group —` teams is not bound. A duplicate ClientId, NIP, site or
 *   target skips every row that shares it. An unreadable fact skips the row
 *   rather than being read as "absent".
 * - **A binding already set is not changed here (I10).** A row whose RootFolder,
 *   DriveId or TeamId is set to something else is skipped for a person to look
 *   at.
 */

import { sha256 } from './cli.mjs';

export const CHANNEL_NAME = 'Dokumenty księgowe';

/**
 * The client-team description convention is `BCR Group — {recordNumber}`.
 * Any dash is accepted. Over-matching can only raise a guest's count of BCR
 * teams, which excludes the guest; that is the safe direction.
 */
export const BCR_TEAM_DESCRIPTION = /^\s*BCR\s+Group\s*[—–-]/i;

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

/** `/Sites/Foo/` → `/sites/foo`. SharePoint URLs are case-insensitive. */
export function normalizeSitePath(path) {
  const t = String(path ?? '')
    .trim()
    .toLowerCase()
    .replace(/\/+$/, '');
  if (!t) return '';
  return t.startsWith('/') ? t : `/${t}`;
}

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

export function siteKey(hostname, sitePath) {
  return `${String(hostname ?? '')
    .trim()
    .toLowerCase()}|${normalizeSitePath(sitePath)}`;
}

/** `https://Host/sites/Foo%20Bar/` → `host|/sites/foo bar`, or `''` if not a URL. */
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
 * The key the ingestion snapshot excludes duplicates by (contract P0-4):
 * host|path|drive|rootFolder. Case-folded, which can only make more rows
 * collide, never fewer.
 */
export function targetKey(row, rootFolder = row.rootFolder) {
  return [
    siteKey(row.siteHostname, row.sitePath),
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
 * `clientId`, `nip`, `site` and `target` make every row involved ambiguous.
 * `userId` is what the ingestion drops key by key; here it is reported.
 * Admin rows take part in the clientId, NIP and user-id checks but have no
 * target.
 */
export function findDuplicates(rows) {
  const groups = {
    clientId: new Map(),
    nip: new Map(),
    site: new Map(),
    target: new Map(),
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
 * @param {object} p
 * @param {string} p.teamId
 * @param {Array<{id:string,userType?:string,displayName?:string,userPrincipalName?:string}>} p.members
 * @param {Array<{id:string}>} p.owners
 * @param {Map<string, Array<{id:string,description?:string}> | {error:string}>} p.memberOfByUser
 */
export function classifyTeamPeople({ teamId, members, owners, memberOfByUser }) {
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
    const bcrTeamIds = groups.filter(isBcrTeamGroup).map((g) => normalizeGuid(g.id));
    if (bcrTeamIds.length > 1) {
      excluded.push({ ...who, reason: 'guest_in_several_bcr_teams', bcrTeamIds });
      continue;
    }
    if (bcrTeamIds.length === 0 || bcrTeamIds[0] !== team) {
      excluded.push({ ...who, reason: 'guest_not_in_this_bcr_team', bcrTeamIds });
      continue;
    }
    eligible.push(who);
  }
  eligible.sort((a, b) => a.id.localeCompare(b.id));
  return { eligible, excluded };
}

/**
 * Whether the ingestion identity may write to a site, from
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
 * @param {Set<string>} [ctx.forbiddenSitePaths]  normalised site paths
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
  if (ctx.forbiddenSitePaths?.has(normalizeSitePath(row.sitePath))) {
    add('forbidden_target', 'skip', 'SitePath is a forbidden target (FORBIDDEN_TARGET_SITE_PATHS)');
  }

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
      add('team_not_bcr', 'skip', 'the Team description does not follow "BCR Group — {recordNumber}"');
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
      });
      const unreadable = people.excluded.filter((e) => e.reason === 'memberships_unreadable');
      if (unreadable.length) {
        add('guest_memberships_unreadable', 'skip', `${unreadable.length} guest(s) whose memberships could not be read`);
      }
      const several = people.excluded.filter((e) => e.reason === 'guest_in_several_bcr_teams');
      if (several.length) {
        add('guest_in_several_bcr_teams', 'warn', `${several.length} guest(s) not bound: in several BCR teams`);
      }
      if (people.eligible.length === 0) {
        add('no_eligible_guest', 'warn', "no guest belongs to exactly this BCR team; the client's uploads go to quarantine");
      }
    }
  }

  // --- write grant ---------------------------------------------------------
  // Only for a client row whose site resolved: an admin row files nowhere,
  // and an unresolved site is already a skip with a better reason.
  const siteResolved = Boolean(site && !isError(site));
  const grant = row.isAdmin || !siteResolved ? 'n/a' : evaluateWriteGrant(facts.permissions, ctx.ingestAppIds);
  evidence.writeGrant = grant;
  if (grant === 'missing') {
    add('write_grant_missing', 'skip', 'the ingestion identity has no write permission on this site');
  } else if (grant === 'unknown') {
    const verified =
      ctx.writeVerified?.has(normalizeSitePath(row.sitePath)) || ctx.writeVerified?.has(row.listItemId);
    if (verified) {
      evidence.writeGrant = 'operator-verified';
    } else {
      add(
        'write_grant_unknown',
        'skip',
        'unknown, verify via runbook (Grant-TeamSiteAccess.ps1 reports "exists"), then pass ' +
          `--write-verified ${row.sitePath || row.listItemId}`,
      );
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
      removedUserIds.push({
        id,
        reason,
        userPrincipalName: (user && !isError(user) && user.userPrincipalName) || '',
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
 * - two rows whose targets (host|path|drive|rootFolder) would collide after
 *   the plan are both skipped.
 *
 * Repeats until nothing changes, since a skip reverts a row to its current
 * values and can create a new collision.
 */
export function buildPlan({ rows, assessments, directory, ingestAppIds = [], createdAt }) {
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
  const finalRootFolder = (e) =>
    e.action === 'PATCH' && 'RootFolder' in e.patch ? e.patch.RootFolder : e.before.RootFolder;

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

    // targets
    const byTarget = new Map();
    for (const e of entries) {
      const row = rowById.get(e.listItemId);
      if (!row.active || row.isAdmin || !row.siteHostname || !row.sitePath) continue;
      const key = targetKey(row, finalRootFolder(e));
      if (!byTarget.has(key)) byTarget.set(key, []);
      byTarget.get(key).push(e);
    }
    for (const group of byTarget.values()) {
      if (group.length < 2) continue;
      for (const e of group) {
        if (e.action !== 'PATCH') continue;
        const others = group.filter((o) => o !== e).map((o) => o.listItemId).join(', ');
        e.reasons.push({ code: 'target_conflict', detail: `target would equal row(s) ${others}` });
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
