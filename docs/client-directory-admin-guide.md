# Admin guide: the "Client Directory" SharePoint list

> **Status: design, not yet implemented.** This guide describes how the
> Client Directory will be created and managed once the multi-tenant
> routing feature (see [`ARCHITECTURE.md §4.2`](../ARCHITECTURE.md#42-multi-tenant-client-routing-planned-not-yet-implemented))
> is built. Keep it up to date as that work lands.

## What it's for

The Client Directory is the single source of truth the ingestion function
uses to decide **whose** SharePoint space a document belongs in. Every
client the agent files documents for needs exactly one row here.

- **Non-admin uploads** are routed purely by which Teams channel the file
  was posted in (`TeamsChannelId` column).
- **Admin uploads** are routed by matching the document's extracted NIP,
  company name, or person name against the same rows.

## Where it lives

A SharePoint list named **`Client Directory`** on the **BCR Group** site
(the same site used as the fallback/admin bucket — `/sites/0000TESTSp.zo.o.-Ksigowo`
in dev, but for BCR Group's own production tenant this will be the actual
BCR Group site). Keeping it on that site means the ingestion function's
managed identity only needs its existing `Sites.Selected` grant on that one
site to read the list — no extra permission needed for this specific list.

## 1. Create the list

1. Go to the BCR Group SharePoint site → **New** → **List** → **Blank list**.
2. Name it `Client Directory`.
3. Add the following columns (all **Single line of text** unless noted):

   | Column name | Type | Notes |
   |---|---|---|
   | `Title` | Single line of text | Canonical display name, e.g. `[0000] TEST Sp. z o. o. - Księgowość` |
   | `ClientId` | Single line of text | Short stable key, e.g. `0000`. Never reuse a retired `ClientId`. |
   | `NIP` | Single line of text | Digits only, e.g. `0000000000`. No spaces or dashes. |
   | `CompanyNameAliases` | Multiple lines of text (plain text, not enhanced) | One alias per line — legal name, trading name, common abbreviations, previous names. |
   | `PersonNames` | Multiple lines of text (plain text) | One full name per line (e.g. company owner/signatory) — used as a last-resort match signal. |
   | `TeamsChannelId` | Single line of text | The client's dedicated Teams channel conversation id (see step 3 below). |
   | `SiteHostname` | Single line of text | e.g. `bcrgroupeu.sharepoint.com` |
   | `SitePath` | Single line of text | e.g. `/sites/ClientSiteName` (must start with `/`) |
   | `DriveName` | Single line of text | Usually `Dokumenty` on Polish-locale tenants — verify per site, don't assume `Documents`. |
   | `RootFolder` | Single line of text | Optional sub-folder prefix under the drive root. |
   | `IsAdmin` | Yes/No | Set `Yes` only for rows representing BCR staff/admin identities (see step 5). |
   | `Status` | Choice: `Active` / `Inactive` | Set `Inactive` instead of deleting a row when a client offboards. |

4. (Optional but recommended) Add an index on `NIP` and `TeamsChannelId`
   columns (list settings → Indexed columns) once the list grows past a
   few hundred rows, to keep Graph queries fast.

## 2. Onboard a new client

1. **Create the client's dedicated Teams channel** in the appropriate
   Team, add the client's users as members (this is what actually
   restricts them to only their own channel), and add the SharePoint
   **Shared** tab pointing at their document library.
2. **Get that channel's conversation id.** Either:
   - Have any member post one message in the new channel, then check the
     ingestion function's Application Insights `traces` for that
     `conversationId` (the bot logs it on every turn), **or**
   - Query Microsoft Graph: `GET /teams/{team-id}/channels` and copy the
     `id` field of the new channel.
3. **Add a row** to the Client Directory list with:
   - `ClientId`, `NIP`, `CompanyNameAliases`, `PersonNames` for that client.
   - `TeamsChannelId` = the id from step 2.
   - `SiteHostname`/`SitePath`/`DriveName`/`RootFolder` pointing at the
     client's SharePoint site.
   - `Status = Active`.
4. **Grant the ingestion function's managed identity `write` permission**
   on the client's SharePoint site, if it doesn't already have it — this
   is a separate step from adding the row, and is **not** covered by the
   list entry itself. Follow
   [`admin-sharepoint-grant.md`](./admin-sharepoint-grant.md) (step 2 only;
   step 1's tenant-wide `Sites.Selected` app role only needs to be granted
   once, ever).
5. Changes typically take effect within the ingestion function's directory
   cache TTL (a few minutes) — no redeploy needed.

## 3. Register an admin

Admins are BCR staff who need to file documents into *any* client's space
regardless of which channel they post in.

1. Add (or edit) a row with `IsAdmin = Yes`.
2. This row doesn't need `TeamsChannelId`, `NIP`, or company/person aliases
   — only the admin's identity needs to be resolvable. Exactly how admin
   identity is matched (by `userAadObjectId`, an AAD group, etc.) is an
   implementation detail to confirm when this feature is built — check
   [`ARCHITECTURE.md §4.2`](../ARCHITECTURE.md#42-multi-tenant-client-routing-planned-not-yet-implemented)
   for the current design before assuming a specific mechanism.

## 4. Update or correct an existing client

- **Renamed company / new trading name** → add a new line to
  `CompanyNameAliases` rather than replacing the existing ones (old
  documents may still reference the old name).
- **Changed NIP** → update `NIP` directly; this only affects future
  admin-uploaded documents and invoice-direction labeling, not files
  already uploaded.
- **Client moved to a different SharePoint site** → update
  `SiteHostname`/`SitePath`/`DriveName` and re-grant the managed identity's
  `write` permission on the *new* site (the old grant is not automatically
  transferred or revoked — clean it up separately if the client is fully
  offboarding).

## 5. Offboard a client

Set `Status = Inactive` rather than deleting the row. Deleting a row
immediately breaks routing for that client if any historical reference or
retry uses it; `Inactive` lets you keep the audit trail while excluding the
row from lookups.

## Data-handling notes

- Only store identifiers needed for routing/matching (NIP, name aliases,
  person names, channel id). Do not use this list to store other
  client-sensitive business data.
- `CompanyNameAliases`/`PersonNames` matching is **exact, normalized**
  (case/diacritics/whitespace-insensitive) — deliberately **not** fuzzy —
  to avoid ever mis-filing a document into the wrong client's SharePoint
  space. When adding aliases, include every real variant you expect to see
  on documents rather than relying on partial matching to catch typos.
