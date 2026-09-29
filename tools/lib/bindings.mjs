/**
 * Pure logic behind `tools/directory-bindings.mjs`. There is no I/O here: the
 * CLI gathers facts from Graph and these functions decide what they mean. That
 * split is what lets the decisions be unit-tested on synthetic fixtures.
 *
 * The decisions follow the Phase 0 isolation invariants, restated for the
 * client accounts (the owner's decision of 28 Sep 2026):
 *
 * - **A client is its `{NIP}@<domain>` account; guests have no capability.**
 *   The one id a client row may route is its client account: the Entra
 *   `Member` whose `userPrincipalName` is `<the row's 10-digit NIP>@<domain>`
 *   (`clientAccountVerdict`, the rule `@bcr/shared` applies at runtime; one
 *   case table tests both), a member (never an owner) of the row's Team, and
 *   in no other Team. It is found by that UPN for the row already chosen,
 *   never the other way round. A Guest id on a client row is removed without
 *   a flag (`guest_ids`), and a guest is never proposed.
 * - **Staff are never client users (I9).** A `Member` id on a client row that
 *   is not its client account (staff, or another client's account) is
 *   reported, and removed only when the operator confirms it for that row.
 * - **An account's sign-in state is reported, never acted on.** A disabled
 *   client account stays bound (`client_account_disabled`; `check` exits 5
 *   for a bound one): the ledger never locks a client out, and no tool
 *   writes to `/users/*`.
 * - **Ambiguity is skipped, never guessed (I3).** A client account that
 *   belongs to any Team besides the row's own (a client Team with or without
 *   the `BCR Group —` marker, or BCR GROUP) is not bound. A duplicate
 *   ClientId, NIP, site or target skips every row that shares it. An
 *   unreadable fact skips the row rather than being read as "absent".
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
 * decides which Teams an account belongs to: every Team-provisioned group counts.
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
/**
 * 2 since the client-account rule (28 Sep 2026): a plan binds a row's
 * `{NIP}@<domain>` account and records `clientDomain`. A version-1 plan bound
 * guests, and `apply` refuses it.
 */
export const PLAN_VERSION = 2;

/** The columns this tool writes. Nothing else on a row is ever patched. */
export const BINDING_FIELDS = Object.freeze(['RootFolder', 'UserAadObjectIds', 'DriveId', 'TeamId']);

/**
 * Columns a stale plan is detected by, besides the binding itself. `NIP`
 * names the row's client account, so a plan made before a NIP edit is stale.
 */
export const GUARD_FIELDS = Object.freeze([
  'ClientId',
  'NIP',
  'SiteHostname',
  'SitePath',
  'DriveName',
  'Status',
  'IsAdmin',
]);

/**
 * Problems that mean an id on an Active client row routes where it should
 * not, or would under an older ingestion build: staff on a client row, a
 * guest on it, or its client account when it no longer qualifies. `check`
 * exits 3 when a **bound** row has one, so a scheduled run can raise it
 * (C12). On an unbound row the ingestion routes nobody (`unbound_target`), so
 * there it is reported as not routing.
 */
export const ROUTING_DRIFT_CODES = Object.freeze([
  'staff_ids',
  'staff_ids_removed',
  'guest_ids',
  'client_account_ineligible',
]);

/**
 * Problems that leave a row's ids unassessed for drift: the site, its Team,
 * the Team's people, the client account or its own memberships, or an id on
 * the row could not be read, so no drift code could be raised either way. On
 * a bound row that holds user ids `check` exits 4 (incomplete) rather than 0:
 * nothing found is not nothing there.
 */
export const DRIFT_UNASSESSED_CODES = Object.freeze([
  'user_lookup_failed',
  'site_unresolved',
  'no_team',
  'team_lookup_failed',
  'membership_lookup_failed',
  'client_account_lookup_failed',
  'client_account_memberships_unreadable',
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

// ---------------------------------------------------------------------------
// Client accounts
// ---------------------------------------------------------------------------

/**
 * The client accounts' domain: `{NIP}@bcr-group.pl` (owner's decision, 28 Sep
 * 2026). The same constant as `CLIENT_ACCOUNT_DOMAIN` in `@bcr/shared`; both
 * sides test it against `test/client-account-cases.json`.
 */
export const CLIENT_ACCOUNT_DOMAIN = 'bcr-group.pl';

/**
 * Whether `account` is the client account of a Directory row whose NIP is
 * `rowNip` (digits only, as the Directory readers normalise it). Pure; no I/O.
 * It confirms a row already chosen, and is never used to find one. Order: the
 * type (Guest, then anything but Member), then the row's NIP, then the UPN.
 *
 * Character for character the rule of `clientAccountVerdict` in
 * `packages/shared/src/clientAccount.ts` (these tools are `.mjs` and cannot
 * import TypeScript). Both test `test/client-account-cases.json`: change both
 * or neither.
 *
 * @param {{ userType?: string | null, userPrincipalName?: string | null }} account
 * @param {string} rowNip
 * @param {string} [domain]
 * @returns {'client' | 'guest' | 'not_member' | 'row_nip_invalid' | 'upn_mismatch'}
 */
export function clientAccountVerdict(account, rowNip, domain = CLIENT_ACCOUNT_DOMAIN) {
  const type = (account.userType ?? '').trim().toLowerCase();
  if (type === 'guest') return 'guest';
  if (type !== 'member') return 'not_member';
  if (!/^[0-9]{10}$/.test(rowNip)) return 'row_nip_invalid';
  const upn = (account.userPrincipalName ?? '').trim().toLowerCase();
  return upn === `${rowNip}@${domain.trim().toLowerCase()}` ? 'client' : 'upn_mismatch';
}

/** The UPN a row's client account has: `<nip>@<domain>`. */
export function clientAccountUpn(nip, domain = CLIENT_ACCOUNT_DOMAIN) {
  return `${nip}@${domain}`;
}

/**
 * The NIP in a UPN shaped like a client account (`<10 ASCII digits>@<domain>`,
 * trimmed, case folded), or `''`. It only labels an id already on a row
 * (another client's account, or this row's after a NIP edit); it never finds
 * a row.
 */
export function clientAccountNipOf(userPrincipalName, domain = CLIENT_ACCOUNT_DOMAIN) {
  const upn = String(userPrincipalName ?? '').trim().toLowerCase();
  const at = upn.indexOf('@');
  if (at !== 10 || upn.slice(at + 1) !== String(domain).trim().toLowerCase()) return '';
  const local = upn.slice(0, at);
  return /^[0-9]{10}$/.test(local) ? local : '';
}

const HOST_LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const CLIENT_DOMAIN = new RegExp(`^(?=.{1,253}$)${HOST_LABEL}(?:\\.${HOST_LABEL})+$`);

/**
 * Whether `value` may be a client-account domain: a lower-case host name with
 * at least two labels (`bcr-group.pl`, `contoso.example`). No `@`, no port, no
 * trailing dot, no upper case.
 */
export function isClientDomain(value) {
  return typeof value === 'string' && CLIENT_DOMAIN.test(value);
}

const NIP_WEIGHTS = [6, 5, 7, 2, 3, 4, 5, 6, 7];

/**
 * Whether a 10-digit NIP passes the Polish checksum. Only ever a warning
 * (`client_nip_checksum`): the rule needs 10 digits and nothing more, so a
 * typo C4 already catches can never lock a client out, and the canary row may
 * carry a NIP no company can hold (9000000000).
 */
export function nipChecksumOk(nip) {
  if (!/^[0-9]{10}$/.test(String(nip ?? ''))) return false;
  const digits = [...nip].map(Number);
  const sum = NIP_WEIGHTS.reduce((acc, w, i) => acc + w * digits[i], 0) % 11;
  return sum !== 10 && sum === digits[9];
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

/**
 * The NIPs of the Active client rows, each with the rows that carry it. Only
 * used to tell another client's account on a row (its NIP is another row's)
 * from this row's own account after a NIP edit or a rename; never to bind.
 *
 * @returns {Map<string, string[]>}
 */
export function clientNipsOf(rows) {
  const out = new Map();
  for (const row of rows ?? []) {
    if (!row.active || row.isAdmin || !row.nip) continue;
    if (!out.has(row.nip)) out.set(row.nip, []);
    out.get(row.nip).push(row.listItemId);
  }
  return out;
}

/**
 * Whether the ingestion can route to this row at all: an Active client row
 * with RootFolder, DriveId and TeamId all set (C3). Any other row's users are
 * quarantined (`unbound_target`), whatever ids it holds.
 */
export function isBoundRow(row) {
  return Boolean(row?.active && !row.isAdmin && row.rootFolder && row.driveId && row.teamId);
}

/**
 * What `check` concludes from its assessments, and its exit code:
 *
 * - `routingDrift`: bound rows holding an id that routes there and should not
 *   (a ROUTING_DRIFT_CODES problem). Exit 3.
 * - `incomplete`: bound rows holding user ids whose drift could not be
 *   assessed (a DRIFT_UNASSESSED_CODES problem). Exit 4 when there is no
 *   drift: "nothing found" is not "nothing there".
 * - `notRoutingUnbound`: unbound rows with a drift problem. Reported only:
 *   the Phase-0 ingestion routes nobody to them, and the PATCH that binds
 *   such a row also takes those ids off.
 * - `lockedOut`: bound rows whose bound client account is disabled
 *   (`assessRow`'s `lockedOut`): the client cannot sign in. Exit 5. The row
 *   is never unbound for it; the account is re-enabled in Entra.
 *
 * 3 wins over 4, and 4 over 5. 0 means every bound row with ids was assessed,
 * none routes where it should not, and no bound client account is disabled.
 *
 * @param {ReturnType<typeof parseDirectoryRow>[]} rows
 * @param {ReturnType<typeof assessRow>[]} assessments
 */
export function checkVerdict(rows, assessments) {
  const rowById = new Map(rows.map((r) => [r.listItemId, r]));
  const routingDrift = [];
  const incomplete = [];
  const notRoutingUnbound = [];
  const lockedOut = [];
  for (const a of assessments) {
    const row = rowById.get(a.listItemId);
    if (!row?.active || row.isAdmin) continue;
    const codes = new Set(a.problems.map((p) => p.code));
    const bound = isBoundRow(row);
    if (ROUTING_DRIFT_CODES.some((c) => codes.has(c))) {
      (bound ? routingDrift : notRoutingUnbound).push(a.listItemId);
    }
    if (bound && row.userIds.length && DRIFT_UNASSESSED_CODES.some((c) => codes.has(c))) {
      incomplete.push(a.listItemId);
    }
    if (bound && a.lockedOut === true) lockedOut.push(a.listItemId);
  }
  const exitCode = routingDrift.length ? 3 : incomplete.length ? 4 : lockedOut.length ? 5 : 0;
  return { routingDrift, incomplete, notRoutingUnbound, lockedOut, exitCode };
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
 * so it counts as a Team: an unknown may only exclude an account, never bind one.
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
 * The row's client account, and why each other person of its Team is not
 * bound.
 *
 * The account is the one `propose` read by its UPN, `<rowNip>@<clientDomain>`
 * (`GET /users/{upn}`), for this row: the row is already chosen, and the NIP
 * only names who may route to it. It is eligible only when all of these hold:
 * its verdict is `client` (a Member with exactly that UPN), it is on this
 * Team's roster and not an owner (an owner can change the channel folder's
 * permissions, and BCR never makes a client one), its own memberships could
 * be read, and its Teams are exactly this Team. Every Team counts, marked or
 * not (see `isTeamGroup`): a client account belongs to one company, so a
 * second Team is always an anomaly, never a reused email.
 *
 * `accountEnabled` is reported (`client_account_disabled`), never a reason not
 * to bind: the ledger must never act as a lock on a client.
 *
 * Everyone else on the roster is in `notBound`, with the reason: `owner`,
 * `guest` (every Guest, a guest of this Team alone included: guests have no
 * capability in the ledger), `client_account_ineligible` (the row's own
 * account when it does not qualify), `other_client_account` (a Member whose
 * UPN is shaped like another NIP's client account) or `staff`.
 *
 * @param {object} p
 * @param {string} p.teamId
 * @param {string} p.rowNip        digits only, as parseDirectoryRow normalises it
 * @param {string} [p.clientDomain]
 * @param {object | null | {error:string}} [p.account]  the `GET /users/{upn}` answer: `null` is 404,
 *   `undefined` means not read (a skip, like an error)
 * @param {Array<object> | {error:string}} [p.accountMemberOf]  the account's `memberOf`
 * @param {Array<{id:string,userType?:string,displayName?:string,userPrincipalName?:string}>} p.members
 * @param {Array<{id:string}>} p.owners
 * @param {Set<string>} [p.knownTeamIds]  normalised ids of every Team in the tenant
 * @returns {{ eligible: object[], problems: object[], notBound: object[], assessed: boolean, account: object | null }}
 *   `eligible` has at most one entry. `assessed` is false when a read left the
 *   question open (then a skip problem says which). `account` is the row's
 *   client account as read (verdict `client`), eligible or not.
 */
export function classifyClientAccount({
  teamId,
  rowNip,
  clientDomain = CLIENT_ACCOUNT_DOMAIN,
  account,
  accountMemberOf,
  members,
  owners,
  knownTeamIds,
}) {
  const team = normalizeGuid(teamId);
  const ownerIds = new Set((owners ?? []).map((o) => normalizeGuid(o.id)).filter(Boolean));
  const rosterIds = new Set((members ?? []).map((m) => normalizeGuid(m.id)).filter(Boolean));
  const problems = [];
  const add = (code, severity, detail) => problems.push({ code, severity, detail });
  const upn = clientAccountUpn(rowNip, clientDomain);
  let found = null;
  let assessed = true;
  const why = [];
  let otherTeams = [];

  if (!/^[0-9]{10}$/.test(String(rowNip ?? ''))) {
    // No valid NIP, no client account: nothing to read. assessRow reports
    // `client_nip_invalid`; the row may still be bound, and routes nobody.
  } else if (account === undefined || isError(account)) {
    assessed = false;
    add(
      'client_account_lookup_failed',
      'skip',
      account === undefined ? `${upn} was not read` : `could not read ${upn}: ${account.error}`,
    );
  } else if (account === null) {
    add(
      'client_account_missing',
      'warn',
      `no account ${upn}: nobody routes to this row until BCR creates it (a Member, licensed, a member ` +
        'of this Team only), then propose and apply again',
    );
  } else {
    const verdict = clientAccountVerdict(account, rowNip, clientDomain);
    const id = normalizeGuid(account.id);
    if (verdict !== 'client' || !id) {
      add(
        'client_account_not_member',
        'warn',
        `${upn} is not a client account (${verdict === 'client' ? 'no object id' : verdict}` +
          `${account.userType ? `, userType ${account.userType}` : ''}); not bound`,
      );
    } else {
      found = {
        id,
        displayName: account.displayName ?? '',
        userPrincipalName: account.userPrincipalName ?? '',
        accountEnabled: typeof account.accountEnabled === 'boolean' ? account.accountEnabled : null,
      };
      if (account.accountEnabled === false) {
        add(
          'client_account_disabled',
          'warn',
          `${upn} is disabled: the client cannot sign in to Teams. It is bound all the same: the ` +
            'ledger never unbinds or blocks a client for this. Tell Roman; re-enabling it in Entra is his',
        );
      }
      if (!rosterIds.has(id)) {
        why.push('client_account_not_in_team');
        add('client_account_not_in_team', 'warn', `${upn} is not a member of this Team; not bound`);
      }
      if (ownerIds.has(id)) {
        why.push('client_account_owner');
        add(
          'client_account_owner',
          'warn',
          `${upn} is an owner of this Team, and an owner can change the channel folder's permissions. ` +
            'Not bound: make it a member, never an owner, then propose again',
        );
      }
      if (!Array.isArray(accountMemberOf)) {
        assessed = false;
        why.push('client_account_memberships_unreadable');
        add(
          'client_account_memberships_unreadable',
          'skip',
          `${upn}'s memberships could not be read${isError(accountMemberOf) ? ` (${accountMemberOf.error})` : ''}, ` +
            'so it cannot be shown to be in this Team alone',
        );
      } else {
        const teams = accountMemberOf.filter((g) => isTeamGroup(g, knownTeamIds));
        otherTeams = teams
          .filter((g) => normalizeGuid(g.id) !== team)
          .map((g) => ({ id: normalizeGuid(g.id) || String(g.id ?? ''), displayName: g.displayName ?? '' }));
        if (otherTeams.length) {
          why.push('client_account_in_other_team');
          add(
            'client_account_in_other_team',
            'warn',
            `${upn} is also in ${otherTeams.map(describeTeam).join(', ')}; not bound. A client account ` +
              'belongs to one company, so this is an anomaly: its uploads are quarantined ' +
              '(membership_mismatch) and its channel posts wait (other_teams) until it is taken out ' +
              'of the other Team(s)',
          );
        }
        if (rosterIds.has(id) && !teams.some((g) => normalizeGuid(g.id) === team)) {
          // The roster says it is a member; its own memberships do not. Two
          // reads disagree, so nothing is inferred from either.
          why.push('client_account_not_in_this_team');
          add(
            'client_account_not_in_this_team',
            'warn',
            `${upn} is listed as a member of this Team, but its memberships do not include it; not bound`,
          );
        }
      }
    }
  }

  const eligible = found && !why.length ? [found] : [];
  const notBound = [];
  for (const m of members ?? []) {
    const id = normalizeGuid(m.id);
    if (!id || eligible.some((e) => e.id === id)) continue;
    const who = { id, displayName: m.displayName ?? '', userPrincipalName: m.userPrincipalName ?? '' };
    if (ownerIds.has(id)) notBound.push({ ...who, reason: 'owner' });
    else if (String(m.userType ?? '').trim().toLowerCase() === 'guest') notBound.push({ ...who, reason: 'guest' });
    else if (found && id === found.id) {
      notBound.push({
        ...who,
        reason: 'client_account_ineligible',
        why: why.join(', '),
        ...(otherTeams.length ? { otherTeams } : {}),
      });
    } else if (clientAccountNipOf(m.userPrincipalName, clientDomain)) {
      notBound.push({ ...who, reason: 'other_client_account' });
    } else notBound.push({ ...who, reason: 'staff', userType: m.userType ?? 'unknown' });
  }
  notBound.sort((a, b) => a.id.localeCompare(b.id));
  return { eligible, problems, notBound, assessed, account: found };
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

  // --- the row's NIP: it names the row's client account ---------------------
  const clientDomain = ctx.clientDomain ?? CLIENT_ACCOUNT_DOMAIN;
  const nipValid = /^[0-9]{10}$/.test(row.nip);
  if (!row.isAdmin && !nipValid) {
    add(
      'client_nip_invalid',
      'warn',
      `the row's NIP is ${row.nip ? `${row.nip.length} digits` : 'empty'}, not 10: it names no client ` +
        'account, so nobody routes to this row. The target may still be bound; nothing is guessed. ' +
        'Correct the NIP by hand, then propose again',
    );
  }
  if (!row.isAdmin && nipValid && !nipChecksumOk(row.nip)) {
    add(
      'client_nip_checksum',
      'warn',
      "the row's NIP fails the NIP checksum. The client account is still the one it names; check " +
        'the NIP for a typo (expected on the canary row)',
    );
  }

  // --- the ids already on the row ------------------------------------------
  // Each is judged by the client-account rule against this row's NIP: this
  // row's account, a Guest (removed, no flag), or any other Member (staff, or
  // another client's account: removed only when confirmed).
  const usersById = facts.usersById ?? new Map();
  const staff = [];
  const guests = [];
  const ownIds = [];
  const renamedAccounts = [];
  const notFound = [];
  const userOf = (id) => usersById.get(id);
  let lockedOut = false;
  for (const id of row.userIds) {
    const user = userOf(id);
    if (user === undefined) {
      add('user_lookup_failed', 'skip', `user ${id} was not read`);
      continue;
    }
    if (user === null) {
      notFound.push(id);
      continue;
    }
    if (isError(user)) {
      add('user_lookup_failed', 'skip', `could not read user ${id}: ${user.error}`);
      continue;
    }
    if (row.isAdmin) continue;
    const who = { id, userPrincipalName: user.userPrincipalName ?? '' };
    const verdict = clientAccountVerdict(user, row.nip, clientDomain);
    if (verdict === 'guest') {
      guests.push(who);
    } else if (verdict === 'client') {
      ownIds.push(id);
      if (user.accountEnabled === false) lockedOut = true;
    } else {
      // A Member (or an account of no type) that is not this row's account.
      // Shaped like a client account for another NIP: another client's
      // account when an Active row carries that NIP, otherwise most likely
      // this row's own after a NIP edit or a rename.
      const nip = clientAccountNipOf(user.userPrincipalName, clientDomain);
      const holders = nip ? (ctx.clientNips?.get(nip) ?? []).filter((r) => r !== row.listItemId) : [];
      if (nip && !holders.length) renamedAccounts.push({ ...who, nip, userType: user.userType ?? '' });
      else staff.push({ ...who, userType: user.userType ?? '', ...(holders.length ? { rows: holders } : {}) });
    }
  }
  if (staff.length) {
    const list = staff
      .map((s) => {
        const name = s.userPrincipalName || s.id;
        if (s.rows) return `${name} (another client's account: the NIP of row(s) ${s.rows.join(', ')})`;
        return String(s.userType).toLowerCase() === 'member' ? name : `${name} (userType ${s.userType || 'none'})`;
      })
      .join(', ');
    if (ctx.confirmRemoveStaff?.has(row.listItemId)) {
      add(
        'staff_ids_removed',
        'warn',
        `Member ids that are not this row's client account will be removed, as confirmed: ${list}`,
      );
    } else {
      add(
        'staff_ids',
        'skip',
        `Member ids on a client row that are not its client account (staff, or another client's): ${list}. ` +
          `Re-run propose with --confirm-remove-staff ${row.listItemId} to remove them`,
      );
    }
  }
  if (guests.length) {
    add(
      'guest_ids',
      'warn',
      `${guests.length} guest id(s) on a client row: ${guests.map((g) => g.userPrincipalName || g.id).join(', ')}. ` +
        'Guests have no capability in the ledger; the PATCH removes them (no flag needed). Apply the whole plan',
    );
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

  // --- people: the row's client account -----------------------------------
  const { members, owners } = facts;
  let people;
  if (teamOk) {
    if (isError(members) || isError(owners)) {
      add('membership_lookup_failed', 'skip', (isError(members) ? members : owners).error);
    } else if (Array.isArray(members) && Array.isArray(owners) && !row.isAdmin) {
      people = classifyClientAccount({
        teamId: team.id,
        rowNip: row.nip,
        clientDomain,
        account: facts.account,
        accountMemberOf: facts.accountMemberOf,
        members,
        owners,
        ...(ctx.knownTeamIds ? { knownTeamIds: ctx.knownTeamIds } : {}),
      });
      for (const p of people.problems) add(p.code, p.severity, p.detail);
    }
  }
  const qualified = new Set((people?.eligible ?? []).map((e) => e.id));
  // The account read by its UPN also says whether the client is locked out,
  // so a failed read by id cannot hide it (exit 5).
  const byUpn = facts.account;
  if (
    byUpn &&
    !isError(byUpn) &&
    byUpn.accountEnabled === false &&
    typeof byUpn.id === 'string' &&
    row.userIds.includes(normalizeGuid(byUpn.id))
  ) {
    lockedOut = true;
  }
  if (lockedOut && !problems.some((p) => p.code === 'client_account_disabled')) {
    add(
      'client_account_disabled',
      'warn',
      "the client account bound on this row is disabled: the client cannot sign in to Teams. It stays " +
        'bound: the ledger never unbinds or blocks a client for this. Tell Roman; re-enabling it in Entra is his',
    );
  }
  // This row's client account on the row, when it no longer qualifies (since
  // added to another Team, made an owner, taken out of this Team: R46), and
  // client-shaped ids for a NIP no Active row carries (this row's own account
  // after a NIP edit or a rename). Each routes here, or did on an older
  // build, until a PATCH takes it off.
  const ineligible = [
    ...(people?.assessed ? ownIds.filter((id) => !qualified.has(id)) : []).map((id) => {
      const name = userOf(id)?.userPrincipalName || id;
      if (people.account?.id !== id) {
        return `${name} (not the account ${clientAccountUpn(row.nip, clientDomain)} resolves to)`;
      }
      const nb = people.notBound.find((p) => p.id === id);
      const teams = nb?.otherTeams?.length ? `: also in ${nb.otherTeams.map(describeTeam).join(', ')}` : '';
      const why = nb?.why || (nb?.reason === 'owner' ? 'client_account_owner' : 'client_account_not_in_team');
      return `${name} (${why}${teams})`;
    }),
    ...renamedAccounts.map((a) =>
      a.nip === row.nip
        ? `${a.userPrincipalName || a.id} (this row's UPN, but userType ${a.userType || 'none'}, not Member)`
        : `${a.userPrincipalName || a.id} (a client account for NIP ${a.nip}, not this row's ` +
          `${row.nip || '(no NIP)'}: was the NIP edited, or the account renamed?)`,
    ),
  ];
  if (ineligible.length) {
    add(
      'client_account_ineligible',
      'warn',
      `${ineligible.length} client account id(s) on the row do not qualify for it, and route here (or did, ` +
        `on an older build) until the plan's PATCH takes them off. Run propose and apply the whole plan: ` +
        ineligible.join('; '),
    );
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
  // At most one id: the row's client account, if it qualifies. A NIP two
  // Active rows share names one account for both, so neither gets it (both
  // rows are SKIP as duplicate_nip anyway).
  const nipShared = (ctx.duplicates ?? []).some((d) => d.kind === 'nip' && d.listItemIds.includes(row.listItemId));
  const bindable = nipShared ? [] : (people?.eligible ?? []);
  let proposed = null;
  const removedUserIds = [];
  const addedUserIds = [];
  if (folderOk && drive && teamOk && people) {
    const eligibleIds = bindable.map((g) => g.id);
    proposed = {
      RootFolder: filesFolder.name,
      UserAadObjectIds: eligibleIds.join('\n'),
      DriveId: drive.id,
      TeamId: team.id,
    };
    const staffIds = new Map(staff.map((s) => [s.id, s]));
    for (const id of row.userIds) {
      if (eligibleIds.includes(id)) continue;
      const user = userOf(id);
      let reason = 'client_account_ineligible';
      if (user === null) reason = 'not_found';
      else if (user === undefined || isError(user)) reason = 'user_lookup_failed';
      else if (guests.some((g) => g.id === id)) reason = 'guest';
      else if (staffIds.has(id)) reason = staffIds.get(id).rows ? 'other_client_account' : 'staff';
      const otherTeams = people.notBound.find((p) => p.id === id)?.otherTeams;
      removedUserIds.push({
        id,
        reason,
        userPrincipalName: (user && !isError(user) && user.userPrincipalName) || '',
        ...(otherTeams ? { otherTeams } : {}),
      });
    }
    for (const raw of row.invalidUserIds) removedUserIds.push({ id: raw, reason: 'not_a_guid' });
    for (const g of bindable) {
      if (!row.userIds.includes(g.id)) addedUserIds.push({ id: g.id, userPrincipalName: g.userPrincipalName });
    }
  }

  const bound = bindable[0];
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
    // The row's client account where it could be assessed: the one id that
    // may route here, or null. IR-1 checks uploaders against it.
    clientAccount: bound
      ? { id: bound.id, userPrincipalName: bound.userPrincipalName, accountEnabled: bound.accountEnabled }
      : null,
    accountAssessed: Boolean(people?.assessed),
    // The account as read by its UPN, eligible or not, for `check` to show.
    account: people?.account ?? null,
    notBound: people?.notBound ?? [],
    // The client account bound on the row is disabled: the client is locked out.
    lockedOut,
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
 * Digest of the whole plan as propose wrote it: every field but `digest`
 * itself, so `clientDomain`, `createdAt` (the age cap), `directory` and
 * `guards` as well as the rows. `apply` recomputes it, so a plan edited by hand after review is
 * refused rather than applied; a plan too old to apply needs a new propose,
 * not a new date.
 */
export function planDigest(plan) {
  return sha256(
    JSON.stringify({
      kind: plan?.kind,
      version: plan?.version,
      clientDomain: plan?.clientDomain,
      createdAt: plan?.createdAt,
      directory: plan?.directory,
      ingestAppIds: plan?.ingestAppIds,
      guards: plan?.guards,
      rows: plan?.rows,
    }),
  );
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
export function buildPlan({
  rows,
  assessments,
  directory,
  ingestAppIds = [],
  guards,
  createdAt,
  clientDomain = CLIENT_ACCOUNT_DOMAIN,
}) {
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
      // The row's client account, where it could be assessed: the one id
      // that may route here, or null when none qualifies. IR-1
      // (`inventory-misfiled.mjs --bindings-plan`) checks uploaders against
      // it; it is not what gets written (that is `patch`).
      ...(a.accountAssessed
        ? {
            clientAccount: a.clientAccount
              ? {
                  id: a.clientAccount.id,
                  userPrincipalName: a.clientAccount.userPrincipalName,
                  accountEnabled: a.clientAccount.accountEnabled,
                }
              : null,
          }
        : {}),
      // Everyone else on the Team's roster, and why they are not bound
      // (guest, staff, other_client_account, owner, client_account_ineligible):
      // a reviewer must see a client account left out because it is also in
      // another Team, and which one.
      notBound: (a.notBound ?? []).map(({ id, userPrincipalName, reason, why, otherTeams }) => ({
        id,
        userPrincipalName,
        reason,
        ...(why ? { why } : {}),
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
  const plan = {
    kind: PLAN_KIND,
    version: PLAN_VERSION,
    // The domain every row's client account was read under: `<NIP>@<domain>`.
    // `apply` re-checks each account against it.
    clientDomain,
    createdAt: createdAt ?? new Date().toISOString(),
    directory,
    ingestAppIds: [...ingestAppIds],
    // What the rows were checked against (forbidden paths, quarantine path,
    // tenant host, the Directory's site collection). Covered by the digest;
    // `apply` also checks every row again, and a recorded value can only add
    // to what it is given, never remove from it.
    ...(guards ? { guards } : {}),
    digest: '',
    rows: entries,
  };
  plan.digest = planDigest(plan);
  return plan;
}

/** Shape errors in a plan file; empty when it may be applied. */
export function validatePlan(plan) {
  const errors = [];
  if (plan?.kind !== PLAN_KIND) errors.push(`kind is not ${PLAN_KIND}`);
  if (plan?.version !== PLAN_VERSION) {
    const why = plan?.version === 1 ? ' (a plan made before the client-account rule, which bound guests). Re-run propose' : '';
    errors.push(`version is not ${PLAN_VERSION}${why}`);
  }
  if (!isClientDomain(plan?.clientDomain)) errors.push('clientDomain is missing or not a lower-case host name');
  if (!plan?.directory?.siteId || !plan?.directory?.listId) errors.push('directory.siteId/listId missing');
  if (!Array.isArray(plan?.rows)) {
    errors.push('rows is not an array');
    return errors;
  }
  if (plan.digest !== planDigest(plan)) {
    errors.push(
      'digest does not match: the plan (its rows, clientDomain, createdAt, directory or guards) was edited after ' +
        'propose. Re-run propose.',
    );
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
      if ('UserAadObjectIds' in p) {
        const lines = splitLines(p.UserAadObjectIds);
        if (!lines.every((l) => normalizeGuid(l))) errors.push(`${at}: UserAadObjectIds has a non-GUID line`);
        // A row routes one client account, never a list.
        if (lines.length > 1) {
          errors.push(`${at}: UserAadObjectIds has ${lines.length} lines; a row binds one client account`);
        }
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

/**
 * The user ids a rollback patch would put back on a row: in the restored
 * `UserAadObjectIds`, not on the row now. GUIDs only, lower-cased, as the
 * ingestion reads them (anything else routes nobody). Each one would route
 * to that row again, so rollback re-checks it as apply does.
 */
export function idsRollbackAdds(patch, currentFields) {
  if (!('UserAadObjectIds' in (patch ?? {}))) return [];
  const guids = (text) => splitLines(fieldString(text)).map(normalizeGuid).filter(Boolean);
  const now = new Set(guids(currentFields?.UserAadObjectIds));
  return [...new Set(guids(patch.UserAadObjectIds))].filter((id) => !now.has(id));
}

/**
 * The user ids a rollback patch would take off a row: on the row now, not in
 * the restored `UserAadObjectIds`. Rollback warns when one of them is the
 * row's client account, whose uploads then go to quarantine until it is bound
 * again.
 */
export function idsRollbackRemoves(patch, currentFields) {
  if (!('UserAadObjectIds' in (patch ?? {}))) return [];
  const guids = (text) => splitLines(fieldString(text)).map(normalizeGuid).filter(Boolean);
  const restored = new Set(guids(patch.UserAadObjectIds));
  return [...new Set(guids(currentFields?.UserAadObjectIds))].filter((id) => !restored.has(id));
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
