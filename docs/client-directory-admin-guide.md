# Admin guide: the "Client Directory" SharePoint list

Written for whoever maintains the list, and for the next person who changes how documents are
routed.

> **Status: Phase 0 routing, September 2026.** Routing uses the uploader's identity only. The
> document's content never chooses the client. This guide replaces the earlier one, which
> described content-based promotion; that path was the cross-client write in incident
> [`IR-2026-09`](operations/incident-2026-09.md) and has been deleted. The list is an interim
> routing source. The database-backed registry replaces it in Phase 2 of the v2 plan.

## What it's for

The ingestion function uses the list to answer one question: **which one client is this
uploader bound to?** If the answer is exactly one client, the document is filed in that
client's space. In every other case it goes to the staff-only quarantine, and an accountant
decides.

Two rules follow from that, and they are the ones that were broken:

- **A client row names only that client's own guests.** Anyone whose id is on a client's row
  has every upload filed into that client's space, whatever the document is. A staff id on a
  client row therefore files other clients' papers into that client's folder. That happened:
  Yahor's id was on PESKOVOI's row.
- **Nothing is typed by hand that a tool can read from Graph.** Guest ids, the channel folder
  name, the drive id and the team id all come from `tools/directory-bindings.mjs`. A typo in a
  folder name creates a look-alike folder the client never sees. A wrong id sends documents to
  the wrong client.

## How an upload is routed (Phase 0)

1. **The bot's gate.** Only a 1:1 chat, from the BCR tenant, with a valid user object id,
   reaches ingestion at all. Ingestion checks the same three things again.
2. **The uploader's id** is looked up in `UserAadObjectIds` across the `Active` rows.
3. **Exactly one client row matches.** The document goes to that row's target:
   `SiteHostname`, `SitePath`, `DriveName` and `RootFolder`. If the row has a `DriveId`, the
   drive the path resolves to must have that id.
4. **Anything else goes to quarantine**, with a reason:

| Reason | When |
|---|---|
| `unmapped` | The id is on no `Active` row. |
| `staff` | The id is on an `IsAdmin` row. Staff are never routed to a client. |
| `conflict` | The id is on two rows (a client row and an `IsAdmin` row count too), or its only row was excluded because its target is shared with another row (see [Duplicates and conflicts](#duplicates-and-conflicts)). |
| `stale_directory` | The list could not be refreshed for longer than the stale cap, or the row's `DriveId` does not match. |
| `forbidden_target` | The id's only row was excluded because it points at a forbidden site: BCR GROUP, the quarantine site, or a SharePoint host other than the tenant's. |
| `target_unwritable` | The client's site refused the write after retries, usually because the ingestion identity has no grant there. |

5. **Content never changes the client.** After classification, the only thing content can change
   is the direction of an invoice (sales ⇄ purchase), and only inside the client the uploader is
   bound to. It is decided by comparing the parties on the invoice with that client's `NIP`.

## What quarantine means

Quarantine is a SharePoint communication site, "BCR Ledger – Kwarantanna". It has no Team and no
Microsoft 365 group, so nobody can join it. It has unique permissions (triage staff only) and
sharing is disabled. No client can reach it.

- **Where a file goes:** `Kwarantanna/YYYY/MM/<batchId>/<original file name>`.
- **What is recorded on it:** four columns, so triage can decide from identity rather than from
  content: `UploaderOid`, `QuarantineReason`, `OriginalFilename` and `DocumentId`.
- **What the uploader sees:** "📨 {file name}" and "Dokument przekazano do weryfikacji przez
  zespół BCR." No link, no folder and no client name, because the uploader may not be who they
  claim, and a link would say where documents are kept.

**Triage rule.** Decide the owner from the uploader: take `UploaderOid`, then every Team that
person belongs to (`GET /users/{id}/memberOf`, groups whose `resourceProvisioningOptions`
contains `Team`). Count every Team, not only those whose description starts `BCR Group —`: the
five Teams `[0000]`–`[0004]` predate onboarding and carry no such description.

- If they belong to several clients, ask them.
- The content may break a tie between clients the identity already produced. It never decides on
  its own.
- A second person checks before anything is moved into a client's folder.

## Where it lives

A SharePoint list named **`Client Directory`** on the BCR GROUP site
(`https://bcrgroupeu.sharepoint.com/sites/BCRGROUPSp.zo.o`).

- **List id:** `2a5613f1-6193-4c04-8a3d-d606617fb411`
- **Site id:** `bcrgroupeu.sharepoint.com,c2b2fedb-12e3-47f1-93f4-c22b2e361a68,fa306584-d50a-4e44-89c0-baa5bf265c69`

Both ids reach the ingestion function as `CLIENT_DIRECTORY_SITE_ID` and
`CLIENT_DIRECTORY_LIST_ID`.

**Who can edit it.** Since the Phase-0 hardening the list has unique permissions: only the
site's Owners can edit it, and versioning records every change
([tenant-hardening T-5](operations/tenant-hardening.md#t-5-lock-and-version-the-client-directory-list)).
The ingestion identity reads it through its site grant. After the Phase-0 change window that
grant is read-only, and ingestion can never write to BCR GROUP again.

## Columns

| Column | Type | Set by | What it does |
|---|---|---|---|
| `Title` | Single line | Onboarding | Display name, e.g. `[0002] PESKOVOI Sp. z o. o. - Księgowość`. Redacted from logs, and never shown on a card. |
| `ClientId` | Single line | Onboarding | BCR record number, e.g. `0002`. Never reused, even after offboarding. |
| `NIP` | Single line | Onboarding | Digits only. Used **only** to decide invoice direction inside this client. It never picks a client. |
| `CompanyNameAliases` | Multi-line, plain | Onboarding | The first line is the name given to the classifier for this client. Nothing routes on it. |
| `PersonNames` | Multi-line, plain | — | Not read any more. Leave it empty. |
| `UserAadObjectIds` | Multi-line, plain | **The tool** | One id per line. **The client's guests only**, each a guest in this client's Team and in no other Team (the tool excludes anyone else as `guest_in_other_team`). **Never staff.** This is what routes uploads. |
| `SiteHostname` | Single line | Onboarding | The tenant's SharePoint host. |
| `SitePath` | Single line | Onboarding | e.g. `/sites/0002PESKOVOISp.zo.o.-Ksigowo`. Must start with `/`. Must not be BCR GROUP or the quarantine site. |
| `DriveName` | Single line | Onboarding | The library name. `Dokumenty` on this Polish tenant. |
| `RootFolder` | Single line | **The tool** | The channel folder's name, exactly as Graph returns it for the "Dokumenty księgowe" channel (`GET /teams/{id}/channels/{id}/filesFolder`). Documents then appear in the channel's files tab. Empty means the library root, which is where the incident's documents went and where clients never look. |
| `DriveId` | Single line | **The tool** | New. The id of the drive holding the channel folder. If set, ingestion checks that the path still resolves to this drive; if not, the upload goes to quarantine as `stale_directory`. This protects against a deleted Team whose site URL is later reused by a new Team. |
| `TeamId` | Single line | **The tool** | New. The client's Team id. Logged and used by the tools and audits; routing does not read it. |
| `IsAdmin` | Yes/No | By hand | `Yes` only on the staff row. See [Staff](#staff). |
| `Status` | `Active` / `Inactive` | By hand | Only `Active` rows route. |
| `TeamsChannelId` | Single line | Onboarding | Written by onboarding, read by nothing. Channel uploads never reach a bot, so channels do not route. |

## Duplicates and conflicts

The list is read in two passes, so the result does not depend on row order. The rules are
fail-closed: when in doubt, the upload goes to quarantine, never to a guess.

| What is duplicated | Effect | Why |
|---|---|---|
| A user id on two rows (including an `IsAdmin` row and a client row) | That id is dropped from routing. The rows stay usable for everyone else. | One person cannot be bound to two clients by accident. |
| A target (`SiteHostname`, `SitePath`, `DriveName` and `RootFolder` together) on two rows | **Both rows** are excluded. Their uploads go to quarantine as `conflict`. | Two rows claiming one folder means one of them is wrong, and nothing says which. |
| A `ClientId` or a `NIP` on two rows | An alert only (`directory.conflict`). Routing is not affected. `directory-bindings.mjs` refuses to change those rows until a person fixes them. | Neither routes anything any more, so excluding the rows would only quarantine a real client for no gain. |

A `directory.conflict` log line names the kind of conflict and the list item ids. It never logs
the duplicated value itself. Look the items up in the list.

**The live duplicate.** Two rows carry `0002`. Before PESKOVOI is bound, Roman decides which is
the real one (the row whose `SitePath` is PESKOVOI's site), and the other is set to `Inactive`
([human-steps H-7](operations/human-steps.md#h-7-check-the-directory-before-the-deploy-and-add-the-new-columns)).

## The stale cap and the forbidden targets

- **Refresh.** The list is re-read every `CLIENT_DIRECTORY_CACHE_TTL_MS` (default 5 minutes).
  An edit takes effect within that time, without a redeploy.
- **Stale cap.** If refreshes keep failing, the last good snapshot is used for at most
  `CLIENT_DIRECTORY_MAX_STALE_MS` (default 15 minutes). After that the snapshot counts as empty,
  and every upload goes to quarantine as `stale_directory`. Before Phase 0, a failed refresh kept
  an old snapshot forever, so a corrected row (a wrong id removed, say) might never take effect.
- **Forbidden targets.** `FORBIDDEN_TARGET_SITE_PATHS` lists sites no row may ever route to: at
  least BCR GROUP. The quarantine site is added automatically. A row pointing at one, or at
  another SharePoint host, is excluded, and its users' uploads go to quarantine as
  `forbidden_target`.

## Onboarding a client (Phase 0)

Onboarding step 13 writes the row with an empty `RootFolder` and no user ids. Until the row is
bound, the client's uploads go to quarantine as `unmapped`. That is safe but slow, so bind soon
after onboarding:

1. **Grant the ingestion identity write on the client's site.** Use the onboarding repo's
   `Grant-TeamSiteAccess.ps1` runbook with the ingestion identity's app id. The runbook call is
   in [human-steps H-6](operations/human-steps.md#h-6-grant-the-ingestion-identity-write-on-the-quarantine-site).
   Without this grant the tool skips the row. Only once the Phase-0 ingestion is live: under the
   old build, every new grant was one more site content promotion could write into. Confirm the
   grant **read-only** afterwards (`GET /sites/{site-id}/permissions` in Graph Explorer shows
   `write` for the ingestion app id). The runbook is not a check: when it finds no grant it
   creates one, so never run it against BCR GROUP or any other forbidden site.
2. `node tools/directory-bindings.mjs check`, with the variables from
   [human-steps H-7](operations/human-steps.md#h-7-check-the-directory-before-the-deploy-and-add-the-new-columns):
   review what it reports for the row.
3. `node tools/directory-bindings.mjs propose --write-verified <that site's path>`: read the
   proposed `UserAadObjectIds`, `RootFolder`, `DriveId` and `TeamId`.
4. A second person reviews the proposal. Then apply it (`--help` gives the command). The tool
   prints the row before and after, and writes a rollback log.
5. **Canary:** a synthetic document, never a real one, uploaded by an identity bound to that
   client, lands in the client's `Dokumenty księgowe` channel folder. Then delete the canary
   file.
6. Tell the client to use the bot in a 1:1 chat. In Teams, they switch to the BCR organisation,
   open chat and search for "Asystent BCR". Their files are in their team → "Dokumenty
   księgowe" → Files. In Phase 0 the app is available to everyone in the org
   ([tenant-hardening T-10](operations/tenant-hardening.md#t-10-teams-app-availability-for-the-bot)).
   If availability is ever restricted to groups, add the guest to that group first; nothing
   does it automatically.

## Staff

Staff never go on a client row. Staff ids go on one row with `IsAdmin = Yes`, no target, and a
`Title`/`ClientId` for the logs. A staff upload goes to quarantine as `staff`, and staff file
documents into client folders by hand in SharePoint. There is no staff routing in Phase 0: the
old "admin → route by the document's NIP" path is what the incident was.

Until the full implementation is done, staff do not upload through the bot at all.

## Changing a client

- **A guest joins or leaves the client's Team:** run the tool again (`check`, `propose`, apply).
  Do not edit `UserAadObjectIds` by hand.
- **The company is renamed:** add a line to `CompanyNameAliases`, keeping the old ones.
- **The NIP changes:** update `NIP`. It only affects invoice direction for future uploads.
- **The client's Team, site or drive changes:** this is a rebind, not an edit. Two people agree
  it, the tool writes the new values, and a canary proves them. Never edit `SitePath` or
  `DriveName` by hand on an active row.

## Offboarding a client

1. Set `Status = Inactive`. Do not delete the row: it keeps the history, and retries and audits
   refer to the `ClientId`.
2. Remove the guests from the Team. On the next run, the tool clears `UserAadObjectIds`.
3. Never reuse the `ClientId`.

If the Team is later deleted and a new Team takes the same site URL, the old row's `DriveId` no
longer matches. Uploads then go to quarantine instead of into the new Team.

## Data-handling notes

- Store only what routing and direction need: ids, NIP, a name for the classifier, and the
  SharePoint target. No other client business data.
- User ids are matched exactly, after lower-casing. Anything that is not a GUID (a UPN, an
  employee number) is ignored.
- Log lines about the list carry list item ids and ClientIds, never NIPs, names or user ids.

## Creating the list from scratch

The list was created with Microsoft Graph Explorer. The Azure CLI cannot `POST /sites/{id}/lists`
in this tenant because of pre-authorisation. To recreate it:

```
POST https://graph.microsoft.com/v1.0/sites/<siteId>/lists
```

```json
{
  "displayName": "Client Directory",
  "description": "Routing directory for the BCR Ledger ingestion agent (Phase 0).",
  "list": { "template": "genericList" },
  "columns": [
    { "name": "ClientId",           "text": {} },
    { "name": "NIP",                "text": {} },
    { "name": "CompanyNameAliases", "text": { "allowMultipleLines": true, "textType": "plain" } },
    { "name": "PersonNames",        "text": { "allowMultipleLines": true, "textType": "plain" } },
    { "name": "UserAadObjectIds",   "text": { "allowMultipleLines": true, "textType": "plain" } },
    { "name": "SiteHostname",       "text": {} },
    { "name": "SitePath",           "text": {} },
    { "name": "DriveName",          "text": {} },
    { "name": "RootFolder",         "text": {} },
    { "name": "DriveId",            "text": {} },
    { "name": "TeamId",             "text": {} },
    { "name": "TeamsChannelId",     "text": {} },
    { "name": "IsAdmin",            "boolean": {} },
    { "name": "Status",             "choice":  { "choices": ["Active", "Inactive"], "displayAs": "dropDown" } }
  ]
}
```

Then give it unique permissions (Owners only) and turn on versioning
([T-5](operations/tenant-hardening.md#t-5-lock-and-version-the-client-directory-list)). Finally,
set `CLIENT_DIRECTORY_SITE_ID` and `CLIENT_DIRECTORY_LIST_ID` on the ingestion app with
`az functionapp config appsettings set … -o none`, which restarts it.
