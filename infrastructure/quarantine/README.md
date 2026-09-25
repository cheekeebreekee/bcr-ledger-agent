# Quarantine site: "BCR Ledger – Kwarantanna"

Phase 0 (P0-2) replaces the fallback bucket with a staff-only quarantine.

Before Phase 0, an upload that the Client Directory could not tie to exactly one
client went to the root of the **BCR GROUP team library**, which every member of
that team can read. Content promotion could then move it into whichever client's
site a NIP in the document pointed to. Now, every upload that cannot be tied to
one client goes to this site, and nowhere else. That covers uploads that are
unmapped, from staff, conflicting, from a stale directory, aimed at a forbidden
target, or aimed at an unwritable one:

```
<library>/Kwarantanna/YYYY/MM/<batchId>/<sanitised original filename>
```

After each upload, ingestion sets four columns on the item: `UploaderOid`,
`QuarantineReason`, `OriginalFilename` and `DocumentId`. The user sees
"Dokument przekazano do weryfikacji przez zespół BCR." with no link.

## What the site is

| Property | Value | Why |
|---|---|---|
| Type | Communication site, **no Microsoft 365 group** | No Team, no group to join, no group membership to drift. |
| Sharing | `SharingCapability = Disabled`, sharing for non-owners disabled | Nothing leaves by link. |
| Library | Unique permissions: site owners Full Control, `Kwarantanna – weryfikujący` Contribute | Only reviewers open documents. |
| Everyone / EEEU | Removed from the site, the library and the site's groups | "Everyone except external users" is every licensed account, including the `{NIP}@` client addresses. |
| Columns | `UploaderOid`, `QuarantineReason`, `OriginalFilename`, `DocumentId` (single line of text) | Written by ingestion. |
| Writer | The ingestion managed identity, via a per-site `Sites.Selected` grant | See "Write grant" below. |

Reviewers are BCR staff only. The script refuses a guest UPN (`#EXT#`).

## Create it

Prerequisites:
- PowerShell 7.2 or later with `PnP.PowerShell` (`Install-Module PnP.PowerShell -Scope CurrentUser`).
- An Entra app registration for PnP interactive login. PnP has required your own since September 2024; `Register-PnPEntraIDAppForInteractiveLogin` creates one.
- The SharePoint Administrator role for whoever signs in.

```powershell
# 1. Dry run: reads the state and prints every change it would make.
./infrastructure/quarantine/New-QuarantineSite.ps1 `
    -SiteUrl https://contoso.sharepoint.com/sites/BCRLedgerKwarantanna `
    -Owner admin@contoso.example `
    -ReviewerUpn reviewer1@contoso.example, reviewer2@contoso.example `
    -ClientId <pnp-app-client-id>

# 2. The same with -Apply. Re-running is safe: it checks, then reuses.
./infrastructure/quarantine/New-QuarantineSite.ps1 ... -Apply
```

The script ends by printing the resulting state, the site's **Graph site id**
(`<host>,<siteGuid>,<webGuid>`), and the ingestion settings:

```
QUARANTINE_SITE_HOSTNAME=contoso.sharepoint.com
QUARANTINE_SITE_PATH=/sites/BCRLedgerKwarantanna
QUARANTINE_DRIVE_NAME=Dokumenty          # the library title; "Dokumenty" on a Polish (1045) site
QUARANTINE_ROOT_FOLDER=Kwarantanna
```

`QUARANTINE_DRIVE_NAME` defaults to `Documents` in the ingestion config. The
tenant is Polish, so set it explicitly to the title the script prints. A wrong
name fails every quarantine upload with "drive not found", and the user gets
"spróbuj ponownie". Ingestion adds the quarantine path to
`FORBIDDEN_TARGET_SITE_PATHS` itself, so no Directory row can ever target it.

What it does not do:
- **Change a reviewer group it did not create.** It reports extra members in `Kwarantanna – weryfikujący` and extra grants on the library, and removes neither.
- **Delete anything.**
- **Grant the ingestion identity write access.** That needs `Sites.FullControl.All`, which this script's identity should not hold. It is the separate step below.

## Write grant for the ingestion managed identity

The ingestion Function App writes with its **system-assigned managed identity**.
That identity holds the Graph application role `Sites.Selected`, which grants
nothing until a per-site permission names it. Today it has one on TEST, BCR GROUP
and PESKOVOI, and it needs one on this site.

**Use the identity's application (client) id, not its object id.** The site
permissions API takes the app id. Swapping them creates a grant that silently
protects nothing.

```bash
PRINCIPAL=$(az functionapp identity show -g rg-bcr-ledger-dev -n <ingestion-function-app> --query principalId -o tsv)
az ad sp show --id "$PRINCIPAL" --query appId -o tsv      # → <ingestion-mi-app-id>
```

### Option A: the onboarding Automation runbook (preferred)

`Grant-TeamSiteAccess.ps1` lives in the onboarding repo
(`bcr-onboarding-agent/infrastructure/automation/`). It runs as the Automation
account's own identity, which is the one identity holding
`Sites.FullControl.All`. It is idempotent: it answers `granted` or `exists`, and
never adds a duplicate.

```bash
az automation runbook start \
  --automation-account-name <automation-account> --resource-group <automation-rg> \
  --name Grant-TeamSiteAccess \
  --parameters SiteId="<graph-site-id-printed-above>" \
               AppId="<ingestion-mi-app-id>" \
               AppDisplayName="BCR ledger ingestion"
# then read the job output: {"outcome":"granted"|"exists","siteId":"…","permissionId":"…"}
```

Pass `AppDisplayName`. The runbook's default is the onboarding agent's name, and
an audit of "who can write here" should not have to resolve a GUID.

### Option B: Graph, by a SharePoint administrator

With a token that carries `Sites.FullControl.All`, for example Graph Explorer
after consenting it (see `docs/admin-sharepoint-grant.md`):

```http
POST https://graph.microsoft.com/v1.0/sites/<graph-site-id>/permissions
Content-Type: application/json

{
  "roles": ["write"],
  "grantedToIdentities": [
    { "application": { "id": "<ingestion-mi-app-id>", "displayName": "BCR ledger ingestion" } }
  ]
}
```

Check first with `GET` on the same URL, so you don't add a second, identical
grant. PnP users can do the same with
`Grant-PnPAzureADAppSitePermission -AppId <ingestion-mi-app-id> -DisplayName 'BCR ledger ingestion' -Permissions Write -Site <SiteUrl>`.

Per-site grants take about **5 minutes** to apply. A managed identity's token is
also cached for up to 24 hours per resource. So if the Function App was never
granted `Sites.Selected`, restart it after that role is granted.

## Verify

1. **The grant exists, once, as write.** Needs `Sites.FullControl.All`. Expect one entry with `roles: ["write"]` and `application.id` equal to the ingestion app id.
   ```http
   GET https://graph.microsoft.com/v1.0/sites/<graph-site-id>/permissions
   ```
   Or: `Get-PnPAzureADAppSitePermission -Site <SiteUrl>`.
2. **The site is closed.**
   - Re-run the script without `-Apply`. It should report 0 changes planned.
   - A client guest opening the site URL gets "access denied".
   - `Get-PnPTenantSite -Identity <SiteUrl> | Select SharingCapability` shows `Disabled`.
3. **Ingestion writes here, and only here.** After the P0 deploy, upload a document as a test user that no Directory row maps. Expect:
   - the bot shows the 📨 row and the Polish message, with no link;
   - the file appears under `Kwarantanna/YYYY/MM/<batchId>/`, with the four columns set;
   - App Insights shows `document.quarantined` with `quarantineReason: "unmapped"`.
4. **Nothing reaches BCR GROUP any more.** After the P0 change window, `tools/inventory-misfiled.mjs` shows no new ingestion-created files on BCR GROUP. Then downgrade the ingestion grant on BCR GROUP to `read` (plan, Phase 0).
