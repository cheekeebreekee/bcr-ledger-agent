# Admin guide: the "Client Directory" SharePoint list

> **Status: implemented and live in dev** (Phases 2 + 2.5 + 3, verified end-to-end).
> Keep this guide up to date as onboarding conventions evolve.

## What it's for

The Client Directory is the single source of truth the ingestion function
uses to decide **whose** SharePoint space a document belongs in. Every
client the agent files documents for needs exactly one row here, and every
BCR staff user who should be able to upload documents needs their AAD id
registered against that client's row.

Routing priority (see [`ClientResolver`](../packages/document-ingestion/src/services/clientResolver.ts)):

1. **User identity** (`UserAadObjectIds`) — the primary path. If the
   uploader's AAD object id appears on a client row, the upload files into
   that client's SharePoint site.
2. **Content-based promotion** — if user routing falls through to the
   fallback bucket **and** the document's extracted NIP matches exactly
   one Directory client (via Claude's `parties[]` extraction), the upload
   is retroactively promoted to that client. This covers admin/agency
   users who don't have a fixed home client.
3. **Fallback bucket** — everything else lands in the configured fallback
   site (BCR Group), under the same folder taxonomy.

**Note on Teams channels.** Earlier designs used a `TeamsChannelId` column
for channel-based routing. That was removed after live testing found that
Teams channel messages don't reliably deliver file attachments to bots
(channel drag-drop bypasses Bot Framework entirely, and `@mention` messages
carry only the mention HTML). **The bot is DM-only** — the Client
Directory keys on `UserAadObjectIds`, not channels.

## Where it lives

A SharePoint list named **`Client Directory`** on the **BCR Group** site
(`https://bcrgroupeu.sharepoint.com/sites/BCRGROUPSp.zo.o`). The ingestion
function's managed identity has `Sites.Selected` + per-site `write` on
this site, so it can read the list without any additional grant.

- **Dev list id:** `2a5613f1-6193-4c04-8a3d-d606617fb411`
- **Dev site id:** `bcrgroupeu.sharepoint.com,c2b2fedb-12e3-47f1-93f4-c22b2e361a68,fa306584-d50a-4e44-89c0-baa5bf265c69`

Both ids are wired into the ingest function via `CLIENT_DIRECTORY_SITE_ID`
and `CLIENT_DIRECTORY_LIST_ID` app settings.

## List schema

| Column | Type | Purpose |
|---|---|---|
| `Title` | Single line of text | Canonical display name, e.g. `[0002] PESKOVOI Sp. z o. o. - Księgowość`. Shown on the Personal Tab. |
| `ClientId` | Single line of text | Short stable business key, e.g. `0002`. Appears in logs and result cards. Never reuse a retired id. |
| `NIP` | Single line of text | Digits-only tax id. Used for content-based promotion + invoice direction detection. |
| `CompanyNameAliases` | Multiple lines of text (plain) | One alias per line — legal name, trading name, common abbreviations, previous names. Used by Claude for identity priming and (in future) alias-based content matching. |
| `PersonNames` | Multiple lines of text (plain) | One full name per line (e.g. company owner/signatory). Reserved for last-resort content matching. |
| `UserAadObjectIds` | Multiple lines of text (plain) | One AAD object id (GUID) per line. **This is what routes uploads.** Every user who should be able to upload on this client's behalf must have their AAD id here. |
| `SiteHostname` | Single line of text | e.g. `bcrgroupeu.sharepoint.com`. |
| `SitePath` | Single line of text | e.g. `/sites/0002PESKOVOISp.zo.o.-Ksigowo` (must start with `/`). |
| `DriveName` | Single line of text | Usually `Dokumenty` on Polish-locale tenants — verify per site, don't assume `Documents`. |
| `RootFolder` | Single line of text | Optional sub-folder prefix under the drive root. Leave blank for uploads at drive root. |
| `IsAdmin` | Yes/No | Set `Yes` for BCR staff / admin rows. Admin rows are matched on user id but their upload then falls through to content-based routing (they don't have a fixed home client). |
| `Status` | Choice: `Active` / `Inactive` | Set `Inactive` to offboard a client without deleting the row (keeps audit history). |

Indexing the `NIP` and (once populated) `UserAadObjectIds` columns via
list settings → Indexed columns is worth doing once the list grows past a
few hundred rows.

## Onboarding a new client

1. **Gather the client's SharePoint site details.** Note the site
   hostname, site path (starts with `/sites/…`), and drive display name.
   Polish tenants use `Dokumenty`; other locales use `Documents`.
2. **Collect the AAD object ids** of every user at the client's
   organisation who should be able to upload documents. Get these from
   Entra ID → *Users* → click each user → *Object ID*, or run
   `Get-MgUser -Filter "userPrincipalName eq 'user@example.com'"` in
   PowerShell.
3. **Add a row** to the Client Directory list with:
   - `Title`, `ClientId`, `NIP`, `CompanyNameAliases` for the client.
   - `UserAadObjectIds` — one AAD id per line for each authorised user.
   - `SiteHostname`, `SitePath`, `DriveName`, and (optionally) `RootFolder`.
   - `Status = Active`.
4. **Grant the ingest function's managed identity `write` on the client's
   SharePoint site.** This is a separate step from adding the row — the
   MI needs Graph-side permission to actually write into that site.
   Follow [`admin-sharepoint-grant.md`](./admin-sharepoint-grant.md)
   (step 2 only; the tenant-wide `Sites.Selected` app role in step 1 is a
   one-time grant across all clients).
5. Changes take effect within the ingest function's directory cache TTL
   (default 5 min, configurable via `CLIENT_DIRECTORY_CACHE_TTL_MS`). No
   redeploy needed.
6. **Tell the client to use the bot via DM** — Teams left rail → chat →
   search *"Asystent BCR"* → drop files. They can also add the
   *"Moje dokumenty"* Personal Tab from the bot's app page to get a
   deep link to their SharePoint document library.

## Registering an admin

Admins are BCR staff who file documents on behalf of many clients (a
bookkeeper, agency owner, etc.) — they don't have a fixed home client.

1. Add a row with `IsAdmin = Yes` and the admin's AAD object id in
   `UserAadObjectIds`. `Title` and `ClientId` are still required for
   logging; `SiteHostname`/`SitePath` can be blank (admin rows never
   themselves become a file target).
2. When the admin uploads via DM:
   - User-based routing matches their AAD id → the resolver sees
     `IsAdmin=true` and defers.
   - Post-classification routing kicks in: the document's NIP is looked
     up against Directory clients. If exactly one matches, the file goes
     to that client's site. If none match (or multiple match), it lands
     in the fallback bucket for manual review.

## Updating or correcting a client

- **Renamed company / new trading name** → add a new line to
  `CompanyNameAliases` rather than replacing the existing ones (old
  documents may still reference the old name).
- **New employee joins** → add their AAD id to `UserAadObjectIds`. Effect
  is picked up within the cache TTL.
- **Employee leaves** → remove their AAD id. Their next upload will fall
  through to fallback / content-based routing.
- **Changed NIP** → update `NIP` directly. Affects future direction
  detection and content-based promotion; already-uploaded files are
  untouched.
- **Client moved to a different SharePoint site** → update
  `SiteHostname`/`SitePath`/`DriveName` and re-grant the managed identity
  `write` on the new site (the old grant is not automatically transferred
  — clean it up separately if the client is fully offboarding).

## Offboarding a client

Set `Status = Inactive` rather than deleting the row. Inactive rows are
excluded from lookups but preserve the audit trail. Deleting a row would
also work but breaks any retry that references the old `ClientId`.

## Data-handling notes

- Only store identifiers needed for routing/matching (NIP, name aliases,
  person names, AAD ids, SharePoint target). Don't use this list to store
  other client-sensitive business data.
- `CompanyNameAliases`/`PersonNames` matching is **exact, normalized**
  (case/diacritics/whitespace-insensitive) — deliberately **not** fuzzy —
  to avoid ever mis-filing a document into the wrong client's SharePoint
  space. When adding aliases, include every real variant you expect to
  see on documents rather than relying on partial matching to catch typos.
- `UserAadObjectIds` matching is exact after case/whitespace
  normalisation, and only accepts inputs that look like AAD GUIDs — junk
  entries (e.g. UPNs, employee ids) are silently dropped by the reader.
- **Duplicate keys across rows are fail-closed:** if the same NIP or the
  same AAD id appears on two different clients, the reader removes it
  from both lookup maps and logs a warning. Uploads matched only by the
  ambiguous key then fall back rather than risk mis-routing.

## Creating the list from scratch

The list itself was created via Microsoft Graph Explorer (Azure CLI
cannot POST to `/sites/{id}/lists` in this tenant due to strict
pre-authorisation). To recreate it on a new site, use:

```
POST https://graph.microsoft.com/v1.0/sites/<siteId>/lists
```

```json
{
  "displayName": "Client Directory",
  "description": "Multi-tenant routing directory for the BCR Ledger ingestion agent.",
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
    { "name": "IsAdmin",            "boolean": {} },
    { "name": "Status",             "choice":  { "choices": ["Active", "Inactive"], "displayAs": "dropDown" } }
  ]
}
```

Then update `CLIENT_DIRECTORY_SITE_ID` and `CLIENT_DIRECTORY_LIST_ID` on
the ingest function app settings and restart it.
