/**
 * Pure logic behind `tools/inventory-misfiled.mjs` (IR-1). No I/O: the CLI
 * walks the drives and reads the IR-0 export, and these functions decide what
 * the evidence says about each file.
 *
 * ## The join, and why it is this shape
 *
 * Before Phase 0 the ingestion logged with two kinds of logger:
 *
 * - `ingestion/ingestDocument` binds `invocationId` (and, per batch,
 *   `conversationId`; per document, `filename`) on child loggers. So
 *   `client resolved`, `classified`, `client refined post-classification` and
 *   `uploaded` of one upload share an `invocationId`, and `uploaded` carries
 *   the `driveItemId`.
 * - `ingestion/clientResolver` is a module logger with **no** `invocationId`.
 *   Its lines carry the uploader's `userAadObjectId`: with `conversationId`
 *   for the fallback line, with `clientId` for the directory line.
 *
 * So the uploader of a `driveItemId` is found by: `uploaded` → its batch's
 * `client resolved` (same `invocationId`) → the resolver line logged just
 * before it (same `conversationId` or `clientId`, within a short window). Two
 * candidates with different ids make the uploader ambiguous, and it is
 * reported as such, never picked.
 *
 * An item can have several `uploaded` lines: the legacy upload replaced a
 * file of the same name, so two uploads could land on one `driveItemId`, the
 * earlier content surviving only as a prior version. Every upload is kept,
 * and the uploaders of all of them are the item's candidates.
 *
 * ## Whose site it is
 *
 * An identity-routed upload went to the client row that held the uploader's
 * id. Before Phase 0 the only id on a client row was staff, so "routed by
 * identity" does not mean "uploaded by that client". The uploader is checked
 * against the guests of the site's own Team (`--site-guests`, or a
 * `directory-bindings` plan); without that list, the item is suspect.
 */

import { PLAN_KIND, normalizeGuid, normalizeSitePath, sitePathSegments, splitLines } from './bindings.mjs';

export const REGISTER_KIND = 'bcr.ir1.inventory';

/** The pre-Phase-0 log messages (the contract's list), by role. */
export const LEGACY_MESSAGES = Object.freeze({
  clientResolved: 'client resolved',
  routedByUser: 'routed to client via userAadObjectId',
  noDirectoryMatch: 'no directory match on user id — routing to fallback',
  adminMatch: 'matched an admin user — deferring to content routing (falling back)',
  promoted: 'promoted fallback → directory client via content NIP match',
  refined: 'client refined post-classification',
  classified: 'classified',
  uploaded: 'uploaded',
  batchFailed: 'batch document failed',
});

/**
 * Flags that make a row suspect: the file may sit where its uploader's client
 * is not, or nobody can yet say whose it is. Everything else is context.
 *
 * `has_prior_versions` is suspect because an earlier version can hold another
 * document (the legacy upload replaced files of the same name), and
 * `versions_unreadable` because an unknown version count may hide one.
 */
export const SUSPECT_FLAGS = Object.freeze(
  new Set([
    'fallback_site',
    'ir0_fallback',
    'promoted_by_content',
    'admin_uploader',
    'uploader_ambiguous',
    'uploader_unknown',
    'uploader_not_site_guest',
    'uploader_guest_unverified',
    'ir0_site_mismatch',
    'ir0_batch_missing',
    'ir0_filename_repeated_in_batch',
    'no_ir0_record',
    'overwritten_by_ingest',
    'multiple_uploads_same_item',
    'has_prior_versions',
    'versions_unreadable',
    'not_found_in_walk',
    'site_not_walked',
  ]),
);

const TAXONOMY_FOLDER = /^\d{2}_/;

// ---------------------------------------------------------------------------
// Site specs
// ---------------------------------------------------------------------------

/**
 * `--site` value → `{ label, hostname, sitePath }`. Accepts
 * `[label=]host:/sites/Path` and `[label=]https://host/sites/Path`.
 */
export function parseSiteSpec(spec) {
  const text = String(spec ?? '').trim();
  const eq = text.indexOf('=');
  const hasLabel = eq > 0 && !text.slice(0, eq).includes('/') && !text.slice(0, eq).includes(':');
  const label = hasLabel ? text.slice(0, eq).trim() : '';
  const rest = hasLabel ? text.slice(eq + 1).trim() : text;
  let hostname;
  let sitePath;
  if (/^https:\/\//i.test(rest)) {
    const u = new URL(rest);
    hostname = u.hostname;
    sitePath = decodeURIComponent(u.pathname);
  } else {
    const colon = rest.indexOf(':/');
    if (colon <= 0) throw new Error(`site "${spec}" is not host:/sites/path or an https URL`);
    hostname = rest.slice(0, colon);
    sitePath = rest.slice(colon + 1);
  }
  // The same rule the ingestion and directory-bindings apply (contract C1):
  // a path that is not canonical could be walked as one site and compared
  // as another.
  const segments = sitePathSegments(sitePath);
  if (!segments) {
    throw new Error(`site "${spec}": path must be /sites/<name> or /teams/<name> with a plain name`);
  }
  if (!/^[a-z0-9.-]+$/i.test(hostname)) throw new Error(`site "${spec}": bad hostname`);
  return { label: label || segments[1], hostname: hostname.toLowerCase(), sitePath: `/${segments.join('/')}` };
}

/** `/sites/foo` from a SharePoint web URL, lower-cased; `''` when it has none. */
export function sitePathFromWebUrl(webUrl) {
  try {
    const u = new URL(String(webUrl ?? ''));
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length < 2 || !['sites', 'teams'].includes(parts[0].toLowerCase())) return '';
    return normalizeSitePath(`/${parts[0]}/${decodeURIComponent(parts[1])}`) ?? '';
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// IR-0 export
// ---------------------------------------------------------------------------

function rowsOf(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.tables)) {
    return data.tables.flatMap((t) => {
      const cols = (t.columns ?? []).map((c) => c.name ?? c.ColumnName);
      return (t.rows ?? []).map((r) => Object.fromEntries(cols.map((c, i) => [c, r[i]])));
    });
  }
  if (Array.isArray(data?.value)) return data.value;
  throw new Error('unrecognised IR-0 export: expected az query output ({tables}) or an array');
}

const present = (v) => (v === undefined || v === null || v === '' ? undefined : v);
const asBool = (v) => v === true || v === 'true' || v === 'True';

const TRACE_FIELDS = [
  'area',
  'invocationId',
  'conversationId',
  'activityId',
  'userAadObjectId',
  'clientId',
  'title',
  'resolution',
  'matchedBy',
  'siteHostname',
  'sitePath',
  'folderPath',
  'documentType',
  'driveItemId',
  'webUrl',
  'filename',
];

/**
 * One trace in the shape the join uses, or `null` if it carries no pino
 * `msg`. A projected column wins over the same key inside the raw JSON
 * `message`, and an empty column (KQL `tostring(null)`) falls through to it,
 * so both the focused export and a raw `--all-traces` export parse.
 */
export function normalizeTrace(row) {
  const raw = row?.message ?? row?.Message;
  let j = {};
  if (typeof raw === 'string' && raw.trimStart().startsWith('{')) {
    try {
      j = JSON.parse(raw);
    } catch {
      j = {};
    }
  } else if (raw && typeof raw === 'object') {
    j = raw;
  }
  const pick = (k) => present(row?.[k]) ?? present(j?.[k]);
  const msg = pick('msg');
  if (!msg) return null;
  const time = present(row?.timestamp) ?? present(row?.TimeGenerated) ?? present(j?.time);
  const t = Date.parse(time);
  const out = {
    time: time ?? '',
    t: Number.isFinite(t) ? t : NaN,
    msg: String(msg),
    itemId: String(present(row?.itemId) ?? present(row?._ItemId) ?? ''),
    raw: typeof raw === 'string' ? raw : JSON.stringify(raw ?? row),
    operationId: String(present(row?.operation_Id) ?? present(row?.OperationId) ?? ''),
    promotedFromFallback: asBool(pick('promotedFromFallback')),
    directionCorrection: pick('directionCorrection'),
  };
  for (const k of TRACE_FIELDS) {
    const v = pick(k);
    out[k] = v === undefined ? '' : String(v);
  }
  out.userAadObjectId = normalizeGuid(out.userAadObjectId) || out.userAadObjectId;
  return out;
}

export function parseIr0Export(data) {
  return rowsOf(data).map(normalizeTrace).filter(Boolean);
}

/**
 * Drop repeats of the same trace. The same line reaches the input twice when
 * both the routing export and the `--all-traces` export are read, or when
 * chunks overlap; counted twice, one upload would look like two writes to the
 * same item. App Insights' `itemId` identifies a trace; without it, the time
 * and the raw line do.
 */
export function dedupeTraces(records) {
  const seen = new Set();
  return records.filter((r) => {
    const key = r.itemId || `${r.time}|${r.raw}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Join the traces into one record per uploaded `driveItemId`.
 *
 * @param {ReturnType<typeof normalizeTrace>[]} records
 * @param {object} [opts]
 * @param {number} [opts.windowMs]  How far before `client resolved` a
 *   resolver line may be and still belong to it. The resolver logs, returns,
 *   and the batch logs; milliseconds apart in practice.
 */
export function indexIr0(records, { windowMs = 10_000 } = {}) {
  const m = LEGACY_MESSAGES;
  const sorted = records.filter((r) => Number.isFinite(r.t)).sort((a, b) => a.t - b.t);
  const batches = [];
  const batchesByInvocation = new Map();
  const refined = new Map();
  const classified = new Map();
  const routed = [];
  const noMatch = [];
  const admin = [];
  const uploads = [];

  for (const r of sorted) {
    switch (r.msg) {
      case m.clientResolved: {
        batches.push(r);
        if (r.invocationId) {
          if (!batchesByInvocation.has(r.invocationId)) batchesByInvocation.set(r.invocationId, []);
          batchesByInvocation.get(r.invocationId).push(r);
        }
        break;
      }
      case m.refined:
        refined.set(`${r.invocationId}|${r.filename}`, r);
        break;
      case m.classified:
        classified.set(`${r.invocationId}|${r.filename}`, r);
        break;
      case m.routedByUser:
        routed.push(r);
        break;
      case m.noDirectoryMatch:
        noMatch.push(r);
        break;
      case m.adminMatch:
        admin.push(r);
        break;
      case m.uploaded:
        if (r.driveItemId) uploads.push(r);
        break;
      default:
        break;
    }
  }

  const within = (line, batch) => line.t <= batch.t && line.t >= batch.t - windowMs;

  function batchFor(upload) {
    if (upload.invocationId && batchesByInvocation.has(upload.invocationId)) {
      const list = batchesByInvocation.get(upload.invocationId).filter((b) => b.t <= upload.t);
      return list[list.length - 1] ?? batchesByInvocation.get(upload.invocationId)[0];
    }
    if (!upload.conversationId) return undefined;
    const candidates = batches.filter(
      (b) =>
        b.conversationId === upload.conversationId && b.t <= upload.t && upload.t - b.t <= 600_000,
    );
    return candidates[candidates.length - 1];
  }

  function uploaderFor(batch) {
    if (!batch) return { oids: [], source: '' };
    let lines = [];
    let source = '';
    if (batch.resolution === 'fallback' && batch.conversationId) {
      lines = noMatch.filter((l) => l.conversationId === batch.conversationId && within(l, batch));
      source = 'conversationId+time';
    } else if (batch.resolution === 'directory' && batch.clientId) {
      lines = routed.filter((l) => l.clientId === batch.clientId && within(l, batch));
      source = 'clientId+time';
    }
    const oids = [...new Set(lines.map((l) => l.userAadObjectId).filter(Boolean))];
    return { oids, source };
  }

  // `classified` and `refined` lines are found by invocationId + filename.
  // Two uploads of one name in one batch (the legacy bot named every unnamed
  // attachment "attachment.bin") make that lookup pick a sibling's line, so
  // neither upload takes one, and both are flagged.
  const perNameInBatch = new Map();
  for (const u of uploads) {
    const key = `${u.invocationId}|${u.filename}`;
    perNameInBatch.set(key, (perNameInBatch.get(key) ?? 0) + 1);
  }

  const byItem = new Map();
  let withoutBatch = 0;
  let ambiguous = 0;
  for (const u of uploads) {
    const batch = batchFor(u);
    if (!batch) withoutBatch += 1;
    const key = `${u.invocationId}|${u.filename}`;
    const repeated = Boolean(u.invocationId) && perNameInBatch.get(key) > 1;
    const ref = repeated ? undefined : refined.get(key);
    const cls = repeated ? undefined : classified.get(key);
    const { oids, source } = uploaderFor(batch);
    if (oids.length > 1) ambiguous += 1;
    const uploaderOid = oids.length === 1 ? oids[0] : '';
    const adminLine =
      batch &&
      admin.find((l) => within(l, batch) && (uploaderOid ? l.userAadObjectId === uploaderOid : false));
    const finalSitePath = ref?.sitePath || batch?.sitePath || '';
    const record = {
      driveItemId: u.driveItemId,
      uploadedAt: u.time,
      invocationId: u.invocationId,
      conversationId: u.conversationId || batch?.conversationId || '',
      filename: u.filename,
      webUrl: u.webUrl,
      webUrlSitePath: sitePathFromWebUrl(u.webUrl),
      batchFound: Boolean(batch),
      filenameRepeatedInBatch: repeated,
      resolution: batch?.resolution ?? '',
      resolvedClientId: batch?.clientId ?? '',
      matchedBy: batch?.matchedBy ?? '',
      resolvedSitePath: batch?.sitePath ?? '',
      refined: Boolean(ref),
      promotedFromFallback: Boolean(ref?.promotedFromFallback),
      directionCorrection: ref?.directionCorrection ?? '',
      refinedClientId: ref?.clientId ?? '',
      finalClientId: ref?.clientId || batch?.clientId || '',
      finalSitePath,
      folderPath: ref?.folderPath || cls?.folderPath || '',
      documentType: cls?.documentType ?? '',
      uploaderOid,
      uploaderOidCandidates: oids,
      uploaderOidAmbiguous: oids.length > 1,
      uploaderOidSource: oids.length ? source : '',
      adminUploader: Boolean(adminLine),
      adminClientId: adminLine?.clientId ?? '',
    };
    if (!byItem.has(u.driveItemId)) byItem.set(u.driveItemId, []);
    byItem.get(u.driveItemId).push(record);
  }

  const index = new Map();
  for (const [driveItemId, list] of byItem) index.set(driveItemId, mergeUploads(list));

  return {
    byDriveItemId: index,
    stats: {
      traces: records.length,
      batches: batches.length,
      uploads: uploads.length,
      uniqueDriveItems: index.size,
      itemsWithSeveralUploads: [...index.values()].filter((v) => v.uploadCount > 1).length,
      uploadsWithoutBatch: withoutBatch,
      uploadsWithAmbiguousUploader: ambiguous,
      promoted: [...index.values()].filter((v) => v.promotedFromFallback).length,
      fallback: [...index.values()].filter((v) => v.uploads.some((x) => x.resolution === 'fallback')).length,
    },
  };
}

/** The fields of one upload that the register keeps for each of an item's uploads. */
const UPLOAD_FIELDS = [
  'uploadedAt',
  'invocationId',
  'conversationId',
  'filename',
  'webUrlSitePath',
  'batchFound',
  'filenameRepeatedInBatch',
  'resolution',
  'resolvedClientId',
  'promotedFromFallback',
  'finalClientId',
  'finalSitePath',
  'uploaderOid',
  'uploaderOidCandidates',
  'uploaderOidAmbiguous',
  'adminUploader',
];

/**
 * One index entry for every upload of an item, in time order. The latest
 * upload describes the current content; the uploader is certain only when
 * every upload names the same one person.
 */
function mergeUploads(list) {
  const latest = list[list.length - 1];
  const candidates = [...new Set(list.flatMap((r) => r.uploaderOidCandidates))];
  const everyUploadResolved = list.every((r) => r.uploaderOid);
  const severalPeople = candidates.length > 1;
  return {
    ...latest,
    uploaderOid: !severalPeople && everyUploadResolved ? candidates[0] ?? '' : '',
    uploaderOidCandidates: candidates,
    uploaderOidAmbiguous: severalPeople,
    batchFound: list.every((r) => r.batchFound),
    promotedFromFallback: list.some((r) => r.promotedFromFallback),
    adminUploader: list.some((r) => r.adminUploader),
    uploadCount: list.length,
    uploads: list.map((r) => Object.fromEntries(UPLOAD_FIELDS.map((k) => [k, r[k]]))),
  };
}

// ---------------------------------------------------------------------------
// The register
// ---------------------------------------------------------------------------

/**
 * Whether a walked file belongs in the register: created or last modified
 * by the ingestion identity, or named in IR-0. `includeAll` registers every
 * file (for a full inventory of a site).
 */
export function isCandidate(item, { ingestAppIds, ir0, includeAll = false }) {
  if (includeAll) return true;
  const created = normalizeGuid(item?.createdBy?.application?.id);
  const modified = normalizeGuid(item?.lastModifiedBy?.application?.id);
  return ingestAppIds.has(created) || ingestAppIds.has(modified) || Boolean(ir0?.has(item?.id));
}

/**
 * `time uploader | …`, every upload of an item, for the CSV; the JSON keeps
 * the structured list. An upload with several candidates lists them all.
 */
function uploadsText(uploads) {
  if (!Array.isArray(uploads)) return '';
  return uploads
    .map((u) => `${u.uploadedAt || '?'} ${(u.uploaderOidCandidates ?? []).join('+') || 'unknown'}`)
    .join(' | ');
}

/** `id:size@time | …` for the CSV; the JSON keeps the structured list. */
function versionsText(versions) {
  if (!Array.isArray(versions)) return '';
  return versions.map((v) => `${v.id || '?'}:${v.size ?? '?'}@${v.modifiedAt || '?'}`).join(' | ');
}

/**
 * The site the log says an upload went to, canonical; `null` when the log
 * names a path that cannot be canonicalised (it then matches no site).
 */
function loggedSitePath(upload) {
  if (upload.webUrlSitePath) return upload.webUrlSitePath;
  if (!upload.finalSitePath) return '';
  return normalizeSitePath(upload.finalSitePath);
}

/**
 * @param {object} ir0             an index entry (see `mergeUploads`)
 * @param {string} walkedSitePath  where the file is now; `''` when not found in the walk
 * @param {Map<string, Set<string>> | null} [siteGuests]  guests of each site's own
 *   Team, by canonical site path; `null` when no guest list was given at all
 */
function ir0Flags(ir0, walkedSitePath, siteGuests = null) {
  const flags = new Set();
  const uploads = ir0.uploads?.length ? ir0.uploads : [ir0];
  const walked = walkedSitePath ? normalizeSitePath(walkedSitePath) : '';
  for (const u of uploads) {
    if (!u.batchFound) flags.add('ir0_batch_missing');
    if (u.filenameRepeatedInBatch) flags.add('ir0_filename_repeated_in_batch');
    if (u.resolution === 'fallback' && !u.promotedFromFallback) flags.add('ir0_fallback');
    if (u.promotedFromFallback) flags.add('promoted_by_content');
    if (u.adminUploader) flags.add('admin_uploader');
    const logged = loggedSitePath(u);
    if (walked && (logged === null || (logged && logged !== walked))) flags.add('ir0_site_mismatch');
    // Routed by identity: to the row that held the uploader's id. Whether
    // that uploader is the client (a guest of the site's own Team) is a
    // separate question, and staff ids sat on client rows before Phase 0.
    if (u.resolution === 'directory' && !u.promotedFromFallback) {
      const site = walked || logged;
      const guests = site ? siteGuests?.get(site) : undefined;
      if (!guests) flags.add('uploader_guest_unverified');
      else if ((u.uploaderOidCandidates ?? []).some((oid) => !guests.has(oid))) {
        flags.add('uploader_not_site_guest');
      }
    }
  }
  if (ir0.uploaderOidAmbiguous) flags.add('uploader_ambiguous');
  else if (!ir0.uploaderOid) flags.add('uploader_unknown');
  if (ir0.uploadCount > 1) flags.add('multiple_uploads_same_item');
  return [...flags];
}

/**
 * Guests of each site's own Team, from `--site-guests <site>=<oid,oid,...>`
 * values. `<site>` is a `--site` label or its path.
 *
 * @param {string[]} specs
 * @param {Array<{label:string, sitePath:string}>} sites  the walked sites
 * @returns {Map<string, Set<string>>} by canonical site path
 */
export function parseSiteGuests(specs, sites) {
  const out = new Map();
  for (const spec of specs ?? []) {
    const text = String(spec);
    const eq = text.indexOf('=');
    if (eq <= 0) throw new Error(`--site-guests "${text}": expected <site label>=<oid,oid,...>`);
    const name = text.slice(0, eq).trim();
    const site = sites.find(
      (s) => s.label.toLowerCase() === name.toLowerCase() || normalizeSitePath(s.sitePath) === normalizeSitePath(name),
    );
    if (!site) throw new Error(`--site-guests ${name}: not one of the --site values`);
    const ids = text
      .slice(eq + 1)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const bad = ids.filter((id) => !normalizeGuid(id));
    if (bad.length) throw new Error(`--site-guests ${name}: not GUIDs: ${bad.join(', ')}`);
    const key = normalizeSitePath(site.sitePath);
    if (!out.has(key)) out.set(key, new Set());
    for (const id of ids) out.get(key).add(normalizeGuid(id));
  }
  return out;
}

/**
 * Guests of each site's own Team, from a `directory-bindings.mjs propose`
 * plan: the guests who belong to that Team and to no other. A site that two
 * plan rows share is left out (it has no single client), so its items stay
 * `uploader_guest_unverified`. The plan shows membership when it was made,
 * not when a file was uploaded.
 *
 * @returns {{ guests: Map<string, Set<string>>, sharedSites: string[] }}
 */
export function siteGuestsFromPlan(plan) {
  if (plan?.kind !== PLAN_KIND || !Array.isArray(plan?.rows)) {
    throw new Error(`not a directory-bindings plan (kind ${PLAN_KIND})`);
  }
  const guests = new Map();
  const shared = new Set();
  const rowsPerSite = new Map();
  for (const row of plan.rows) {
    const key = normalizeSitePath(row?.sitePath);
    if (key) rowsPerSite.set(key, (rowsPerSite.get(key) ?? 0) + 1);
  }
  for (const row of plan.rows) {
    const key = normalizeSitePath(row?.sitePath);
    if (!key) continue;
    if (rowsPerSite.get(key) > 1) {
      shared.add(key);
      continue;
    }
    // `eligibleGuests` is present only where the Team's people were read; an
    // older plan has only the proposal, which may also drop ids that sit on
    // other rows (so it can only flag more, never fewer).
    let ids;
    if (Array.isArray(row.eligibleGuests)) ids = row.eligibleGuests.map((g) => normalizeGuid(g?.id));
    else if (row.proposed) ids = splitLines(row.proposed.UserAadObjectIds).map(normalizeGuid);
    else continue;
    guests.set(key, new Set(ids.filter(Boolean)));
  }
  return { guests, sharedSites: [...shared] };
}

/**
 * One register row for a walked file.
 *
 * @param {object} item  driveItem + `path`, `parentPath`, optional `versions`/`versionsError`
 * @param {object} where `{ site: {label, hostname, sitePath}, drive: {id, name} }`
 * @param {object} ctx   `{ ingestAppIds:Set, ir0: Map|null, fallbackSitePaths:Set,
 *                          siteGuests: Map|null }`
 */
export function classifyItem(item, where, ctx) {
  const createdByAppId = normalizeGuid(item?.createdBy?.application?.id);
  const modifiedByAppId = normalizeGuid(item?.lastModifiedBy?.application?.id);
  const ingestCreated = ctx.ingestAppIds.has(createdByAppId);
  const ingestModified = ctx.ingestAppIds.has(modifiedByAppId);
  const ir0 = ctx.ir0?.get(item.id);
  const sitePath = normalizeSitePath(where.site.sitePath);

  const flags = [];
  if (ingestCreated) flags.push('ingest_created');
  if (!ingestCreated && ingestModified) flags.push('overwritten_by_ingest');
  if (ctx.fallbackSitePaths?.has(sitePath) && (ingestCreated || ingestModified || ir0)) {
    flags.push('fallback_site');
  }
  const parentPath = item.parentPath ?? '';
  if (!parentPath) flags.push('library_root');
  const top = parentPath.split('/').filter(Boolean)[0] ?? '';
  if (TAXONOMY_FOLDER.test(top)) flags.push('taxonomy_folder');
  const versionCount = Array.isArray(item.versions) ? item.versions.length : null;
  if (versionCount !== null && versionCount > 1) flags.push('has_prior_versions');
  if (item.versionsError) flags.push('versions_unreadable');
  if (ctx.ir0 && (ingestCreated || ingestModified) && !ir0) flags.push('no_ir0_record');
  if (ir0) flags.push(...ir0Flags(ir0, where.site.sitePath, ctx.siteGuests ?? null));

  return {
    suspect: flags.some((f) => SUSPECT_FLAGS.has(f)),
    flags,
    site: where.site.label,
    sitePath: where.site.sitePath,
    driveName: where.drive.name,
    driveId: where.drive.id,
    driveItemId: item.id,
    path: item.path ?? '',
    name: item.name ?? '',
    size: item.size ?? null,
    createdAt: item.createdDateTime ?? '',
    modifiedAt: item.lastModifiedDateTime ?? '',
    createdByAppId,
    createdByAppName: item?.createdBy?.application?.displayName ?? '',
    createdByUser: item?.createdBy?.user?.email ?? item?.createdBy?.user?.displayName ?? '',
    lastModifiedByAppId: modifiedByAppId,
    versionCount,
    versions: Array.isArray(item.versions)
      ? item.versions.map((v) => ({
          id: v.id ?? '',
          size: v.size ?? null,
          modifiedAt: v.lastModifiedDateTime ?? '',
          modifiedByAppId: normalizeGuid(v?.lastModifiedBy?.application?.id),
        }))
      : null,
    versionsError: item.versionsError ?? '',
    webUrl: item.webUrl ?? '',
    ir0: ir0 ?? null,
  };
}

/**
 * The whole register: every candidate file walked, plus every IR-0 upload
 * that the walk did not find (moved, deleted, or on a site not walked, which
 * is exactly where a content promotion into another client would be).
 */
export function buildRegister({
  walked,
  ir0,
  ingestAppIds,
  fallbackSitePaths,
  siteGuests = null,
  includeAll = false,
}) {
  const ctx = { ingestAppIds, ir0, fallbackSitePaths, siteGuests };
  const rows = [];
  const seen = new Set();
  const walkedSites = new Set();
  for (const w of walked) {
    walkedSites.add(normalizeSitePath(w.site.sitePath));
    for (const item of w.items) {
      seen.add(item.id);
      if (!isCandidate(item, { ingestAppIds, ir0, includeAll })) continue;
      rows.push(classifyItem(item, w, ctx));
    }
  }
  for (const [driveItemId, rec] of ir0 ?? []) {
    if (seen.has(driveItemId)) continue;
    const logged = loggedSitePath(rec);
    const flags = [logged && walkedSites.has(logged) ? 'not_found_in_walk' : 'site_not_walked'];
    flags.push(...ir0Flags(rec, '', siteGuests));
    rows.push({
      suspect: true,
      flags,
      site: '',
      sitePath: logged ?? rec.finalSitePath,
      driveName: '',
      driveId: '',
      driveItemId,
      path: '',
      name: rec.filename,
      size: null,
      createdAt: '',
      modifiedAt: '',
      createdByAppId: '',
      createdByAppName: '',
      createdByUser: '',
      lastModifiedByAppId: '',
      versionCount: null,
      versions: null,
      versionsError: '',
      webUrl: rec.webUrl,
      ir0: rec,
    });
  }
  rows.sort(
    (a, b) =>
      Number(b.suspect) - Number(a.suspect) ||
      a.site.localeCompare(b.site) ||
      a.path.localeCompare(b.path) ||
      a.driveItemId.localeCompare(b.driveItemId),
  );
  return rows;
}

export function summarizeRegister(rows) {
  const byFlag = {};
  const bySite = {};
  for (const r of rows) {
    for (const f of r.flags) byFlag[f] = (byFlag[f] ?? 0) + 1;
    const key = r.site || r.sitePath || '(unknown)';
    bySite[key] ??= { rows: 0, suspect: 0 };
    bySite[key].rows += 1;
    if (r.suspect) bySite[key].suspect += 1;
  }
  return { rows: rows.length, suspect: rows.filter((r) => r.suspect).length, byFlag, bySite };
}

const ir0Col = (key) => ({ header: `ir0_${key}`, get: (r) => r.ir0?.[key] ?? '' });

/** CSV columns, in the order a reviewer reads them. */
export const REGISTER_COLUMNS = Object.freeze([
  { key: 'suspect' },
  { header: 'flags', get: (r) => r.flags.join(';') },
  { key: 'site' },
  { key: 'sitePath' },
  { key: 'path' },
  { key: 'name' },
  { key: 'driveItemId' },
  { key: 'driveName' },
  { key: 'driveId' },
  { key: 'size' },
  { key: 'createdAt' },
  { key: 'modifiedAt' },
  { key: 'createdByAppId' },
  { key: 'createdByAppName' },
  { key: 'createdByUser' },
  { key: 'lastModifiedByAppId' },
  { key: 'versionCount' },
  { header: 'versions', get: (r) => versionsText(r.versions) },
  { key: 'versionsError' },
  { key: 'webUrl' },
  ir0Col('uploadedAt'),
  ir0Col('resolution'),
  ir0Col('resolvedClientId'),
  ir0Col('matchedBy'),
  ir0Col('promotedFromFallback'),
  ir0Col('refinedClientId'),
  ir0Col('finalClientId'),
  ir0Col('finalSitePath'),
  ir0Col('folderPath'),
  ir0Col('uploaderOid'),
  { header: 'ir0_uploaderOidCandidates', get: (r) => (r.ir0?.uploaderOidCandidates ?? []).join(';') },
  ir0Col('uploaderOidSource'),
  ir0Col('uploadCount'),
  { header: 'ir0_allUploads', get: (r) => uploadsText(r.ir0?.uploads) },
  ir0Col('adminUploader'),
  ir0Col('invocationId'),
  ir0Col('conversationId'),
  ir0Col('filename'),
  ir0Col('webUrl'),
]);
