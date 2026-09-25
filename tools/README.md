# Operator tools (Phase 0 containment and incident response)

These tools support Phase 0. They are not part of either Function App: nothing
in `packages/` imports them, and nothing deploys them. They need Node 22 and
nothing else. There are no npm dependencies, so they run from a clean checkout
without `yarn install`.

| Tool | What it is for | Writes to the tenant? |
|---|---|---|
| `directory-bindings.mjs` | Binds each Client Directory row to its Team's "Dokumenty księgowe" folder and its guests (`RootFolder`, `UserAadObjectIds`, `DriveId`, `TeamId`) | Only with `--apply`, and only those four columns (plus two new columns with `--add-columns --apply`) |
| `inventory-misfiled.mjs` | IR-1: a register of every file the ingestion wrote, joined with the IR-0 log evidence | Never |
| `ir0/export-appinsights.sh` | IR-0: exports the routing and upload traces before the 30-day retention deletes them | Never |
| `ir0/export-purview.ps1` | IR-0: exports the Purview unified audit log (file access, group and sharing events) | Never |
| `../infrastructure/ir/evidence-store.sh` | An immutable blob container for the IR-0 and IR-1 evidence, with reader RBAC | Only with `--apply` |
| `../infrastructure/quarantine/New-QuarantineSite.ps1` | The staff-only quarantine site (P0-2). See [its README](../infrastructure/quarantine/README.md) | Only with `-Apply` |

## Safety model (every tool)

- **Read-only by default.** A change needs `--apply` (`-Apply` in PowerShell). Without it, a tool prints the change it would make, as the exact request or command.
- **Before and after.** Every tool that writes prints the state it found and the state it left. `directory-bindings.mjs apply` also writes a log of both, which `rollback` restores from.
- **Ambiguity is skipped, never guessed.** A duplicate key, a guest in two BCR teams, a Public team, a non-standard or missing channel, a drive mismatch, an unknown write grant, a fact that could not be read: each one makes the row **SKIP**, with the reason. This follows invariant I3 of the plan.
- **No real data leaves the tenant or reaches git.**
  - Outputs go to `tools/out/`. Git ignores it, and files there are owner-only (0600).
  - IR evidence goes to the immutable evidence container.
  - Examples in this repo use placeholders only: `contoso.sharepoint.com`, `00000000-…` GUIDs, NIPs such as `0000000000`.
- **The token is never printed.** It is read from `GRAPH_TOKEN` and sent only in the `Authorization` header. It goes only to `graph.microsoft.com`: a paging link to any other host is refused. If Graph echoes the token in an error, it is redacted. The ingestion health check sends no token at all.
- **Nothing changes visibility, membership or permissions of a Team.** BCR GROUP is Private on purpose. The tools only read it.
- **Throttling is honoured.** On 429, 503 and 504, the tools wait for `Retry-After` and retry, a bounded number of times (5 by default, 120 s maximum per wait). Other errors are not retried. A network error is retried only for a GET.
- **A flag in the wrong place is an error.** A misspelt flag is refused rather than ignored, because `--aply` must not quietly run as a dry run. So is a flag the command does not take, such as `check --apply`.

## Authentication

The tools read a **delegated** Microsoft Graph token from `GRAPH_TOKEN`. It
acts as the signed-in person, so they also need access to the sites involved:
the Directory site, each client team site, and the sites IR-1 walks.

The Azure CLI token (`az account get-access-token --resource https://graph.microsoft.com`)
covers users and groups, but carries no SharePoint scopes (`Sites.*`). Microsoft
will not pre-authorise the CLI's first-party app for them (`AADSTS65002`). For
SharePoint, use a device-code token from an app registration you own. The
onboarding repo's `tools/graph-login.mjs` does exactly this. Its tokens carry
every delegated permission admin-consented on that registration, so add the
permissions below to it once:

```bash
# in bcr-onboarding-agent (its node_modules provide @azure/identity)
export GRAPH_CLIENT_ID=<your app registration> GRAPH_TENANT_ID=<tenant id>
export GRAPH_TOKEN=$(node tools/graph-login.mjs)
```

| Command | Delegated permissions |
|---|---|
| `directory-bindings.mjs check` / `propose` | `Sites.Read.All`, `Group.Read.All`, `GroupMember.Read.All`, `User.Read.All`, `Channel.ReadBasic.All`. Optional: `Sites.FullControl.All`, to read site permissions. Without it the write grant is "unknown, verify via runbook". |
| `directory-bindings.mjs apply` / `rollback` | `Sites.ReadWrite.All`, plus edit rights on the Client Directory list (it has unique permissions) |
| `directory-bindings.mjs --add-columns --apply` | `Sites.Manage.All` |
| `inventory-misfiled.mjs` | `Sites.Read.All` (or `Files.Read.All`), plus read access to every site walked |

`GRAPH_TOKEN` expires in about an hour. The tools print who the token belongs
to and when it expires, and they refuse an expired token.

## `directory-bindings.mjs`

Onboarding writes client rows with `RootFolder = ''` and no guest id. The first
sends uploads to the library root, where the channel never shows them (R5). The
second makes every client upload "unknown", so it goes to quarantine (R1). This
tool fills both from Graph.

```bash
export DIRECTORY_SITE_ID='contoso.sharepoint.com,<siteGuid>,<webGuid>'   # or CLIENT_DIRECTORY_SITE_ID
export DIRECTORY_LIST_ID='<list guid>'                                    # or CLIENT_DIRECTORY_LIST_ID
export INGEST_APP_IDS='<ingestion managed identity app id>'
export FORBIDDEN_TARGET_SITE_PATHS='/sites/BCRGROUP'                      # rows targeting these are skipped

node tools/directory-bindings.mjs check
node tools/directory-bindings.mjs propose [--confirm-remove-staff <listItemId>] [--write-verified <sitePath|listItemId>]
node tools/directory-bindings.mjs apply --plan <plan.json> --health-url https://<ingestion-host>/api/health --expect-health <key=value> [--apply]
node tools/directory-bindings.mjs rollback --log <apply-log.json> [--apply]
node tools/directory-bindings.mjs --add-columns [--apply]
```

### `check`

Reports on each **Active** row:
- **Staff on a client row.** Ids in `UserAadObjectIds` whose user is `userType = Member`.
- **Duplicates across rows.**
  - A shared ClientId, NIP, site or target (`host|path|drive|rootFolder`) skips every row involved.
  - A shared user id is reported. Ingestion drops that key for both rows.
- **The Team.** The Team whose root site is the row's site, found by listing every Team and its `sites/root`. The check reads its visibility, flags a Public team, and never changes it.
- **The channel.** There must be exactly one "Dokumenty księgowe" channel, and its `membershipType` must be `standard`.
- **The channel folder.** Its `filesFolder` name, id and `parentReference.driveId`, and whether its parent is the drive root. The drive id is compared with the drive the row's `DriveName` resolves to (`GET /sites/{id}/drives`, exact name, as ingestion matches it).
- **The Team's guests.** For each guest, whether they are in exactly one `BCR Group —` team (`/users/{id}/memberOf`, by description). Members and owners are never bound.
- **The write grant.** Whether the ingestion identity (`--ingest-app-ids`) can write to the site, from `/sites/{id}/permissions`. If the caller cannot read that, the grant is reported as **"unknown, verify via runbook"**.

`--out <file>` also writes the report as JSON.

### `propose`

Writes a plan: one row per Active row, with an action.
- **PATCH** carries only the fields that change:
  - `RootFolder`: the channel folder name exactly as Graph returns it. Proposed only when the folder is in the row's drive, directly under the drive root, in a standard channel, and the ingestion path sanitiser would not rename it.
  - `UserAadObjectIds`: the guests who are in exactly this one BCR team. Never Members or owners, and never an id already on another row.
  - `DriveId` and `TeamId`.
- **NOOP** means the row is already bound.
- **SKIP** gives every reason, and still shows the values the row would have had, marked "(not applied)".

Two decisions stay with a person:
- **Staff ids.** A row with staff ids is skipped until you pass `--confirm-remove-staff <listItemId>` for that row. Then those ids are removed.
- **Unknown write grant.** When the grant is unknown, the row is skipped until you check it. Run the runbook: `Grant-TeamSiteAccess.ps1` answers `exists`. Then pass `--write-verified <sitePath or listItemId>`.

An existing, different `RootFolder`, `DriveId` or `TeamId` is never overwritten.
The row is skipped for a person to decide (I10).

The plan is written to `tools/out/directory-bindings-plan-<UTC>.json`, or to
`--out`, and its sha256 is printed. It carries a digest of its rows.

### `apply`

Before it writes anything, `apply` refuses a plan in any of these cases:
- the plan's digest no longer matches: it was **edited** after `propose`;
- the plan is **older** than `--max-plan-age-hours` (default 24), because Team membership may have changed;
- `--only` asks for a **SKIP** row;
- the **ingestion health** check fails: `--health-url` must answer 200, and its JSON must satisfy every `--expect-health key=value`. Dotted keys reach into nested objects, so pass values that only the P0 build reports — the Phase-0 ingestion build answers `"build":{"phase":"p0","routing":"identity-only"}`, so use `--expect-health build.routing=identity-only`;
- the plan patches `DriveId` or `TeamId` and those **columns are missing**. Run `--add-columns --apply` first.

For each PATCH row, `apply`:
1. reads the row again;
2. refuses it if any binding field or guard field (`ClientId`, `SiteHostname`, `SitePath`, `DriveName`, `Status`, `IsAdmin`) changed since `propose` (**stale**);
3. PATCHes `/sites/{s}/lists/{l}/items/{id}/fields` with only the planned fields;
4. reads the row back and compares.

Without `--apply`, `apply` does all the checks and reads, and writes nothing.
With `--apply`, it writes `tools/out/directory-bindings-apply-<UTC>.json`, which
holds the before-state and after-state of every row. The log is flushed after
each row, so an interrupted run can still be rolled back.

Exit codes:
- `0`: done.
- `1`: refused before any write.
- `2`: some rows were stale, failed, or read back differently. See the log.

### `rollback`

Restores the before-state of every row that an apply log says it wrote. A row
someone has changed since the apply is refused, not overwritten. Without
`--apply` it is a dry run. With `--apply` it writes its own log.

### `--add-columns`

Creates the single-line text columns `DriveId` and `TeamId` on the list, if they
are missing. It refuses when a column with that display name exists under a
different internal name, because ingestion reads internal names.

### Procedure (the P0 change window)

1. `--add-columns --apply`.
2. `check`. Fix what only a person can fix: DriveName, a Public client team, the channel.
3. `propose`, and review the plan file. Confirm staff removals and verified grants by re-running `propose` with the flags.
4. `apply --plan …` as a dry run, then with `--apply`, in the same change window as the P0 ingestion deploy.
5. One canary upload per bound client. Then run `check` again.
6. After the window, downgrade the ingestion grant on BCR GROUP to `read`.

## `inventory-misfiled.mjs` (IR-1)

```bash
node tools/inventory-misfiled.mjs \
  --site 'BCRGROUP=contoso.sharepoint.com:/sites/BCRGROUP' \
  --site 'PESKOVOI=contoso.sharepoint.com:/sites/<client site>' \
  --site 'TEST=contoso.sharepoint.com:/sites/<test site>' \
  --ingest-app-ids <ingestion app id> \
  --fallback-site BCRGROUP \
  --ir0 tools/out/ir0-appinsights-<UTC>/
```

It walks every folder of each site's drive (`--drive-name`, default `Dokumenty`,
or `--all-drives`). It registers every file the ingestion identity created or
last modified (by `createdBy.application.id`), and every file IR-0 names. With
`--all-items`, it registers every file.

Each register row records:
- the `driveItemId`, the path, the created and modified times, `createdBy.application.id` and the size;
- every version, with its size and time;
- the IR-0 evidence, joined on `driveItemId`: routing (fallback or directory), whether content promotion moved the file, the uploader's AAD object id, and the site the log says the file went to.

It also lists the applications that created files. Check `--ingest-app-ids`
against that list.

**How the uploader is joined.** `uploaded` carries the `driveItemId` and the
`invocationId`, and `client resolved` shares that `invocationId`. The
resolver's line, which holds the `userAadObjectId`, has no `invocationId`. It is
matched by `conversationId` (fallback) or `clientId` (directory), within
`--window-ms` (default 10 s) before `client resolved`. If two different ids
match, the uploader is **ambiguous**: both are listed, and neither is picked.

Flags that make a row suspect:

| Flag | Meaning |
|---|---|
| `fallback_site` | On the site named by `--fallback-site`, and written by the ingestion |
| `ir0_fallback` | Routed to the fallback bucket and not promoted |
| `promoted_by_content` | Moved into a client by a NIP found in the document (R3) |
| `admin_uploader` | The uploader matched an admin row |
| `uploader_ambiguous` / `uploader_unknown` | The uploader cannot be told from the log |
| `ir0_site_mismatch` | The log says a different site than the one the file is on |
| `ir0_batch_missing` | An `uploaded` line with no `client resolved` line for it |
| `no_ir0_record` | Written by the ingestion, but absent from IR-0 (older than the logs) |
| `overwritten_by_ingest` | Created by someone else, last modified by the ingestion |
| `multiple_uploads_same_item` | Two `uploaded` lines for one item |
| `not_found_in_walk` | In IR-0 on a walked site, but not found there (moved or deleted) |
| `site_not_walked` | In IR-0 on a site that was not walked. **Add that site and re-run.** |

Context flags, which don't make a row suspect on their own:
- `ingest_created`
- `library_root`: not in the channel folder (R5)
- `taxonomy_folder`
- `has_prior_versions`: IR-2 deletes non-current versions before any move
- `versions_unreadable`

The tool writes `tools/out/ir1-inventory-<UTC>.json` and `.csv`, and prints
their sha256. The JSON holds the parameters, input hashes, per-site counts, the
summary and the rows. In the CSV, a cell that starts with `=`, `+`, `-` or `@`
is prefixed with `'`, because the file names come from uploaders.

## `ir0/export-appinsights.sh`

```bash
tools/ir0/export-appinsights.sh --app <component name> --resource-group rg-bcr-ledger-dev [--all-traces]
```

- Runs `ir0/routing-traces.kql`, which parses the pino JSON in `traces.message`. It selects the pre-Phase-0 routing and upload messages.
- Uses 24-hour chunks over the last 30 days, or `--start`/`--end` in UTC.
- Always passes **both** `--start-time` and `--end-time`: with only a start, the CLI's window is one hour.
- Stops if a chunk reaches the API row limit, because a truncated export looks complete.
- `--all-traces` also exports every trace, unfiltered.
- Writes owner-only files, the query, `export-meta.txt` (window, operator, subscription, tool commit) and `SHA256SUMS`, and prints every hash.

It needs the `application-insights` az extension and read access to the
component.

## `ir0/export-purview.ps1`

```powershell
Connect-ExchangeOnline -UserPrincipalName <auditor>
./tools/ir0/export-purview.ps1 -SiteUrl https://contoso.sharepoint.com/sites/BCRGROUP, … -StartDate 2026-06-01T00:00:00Z
```

It runs `Search-UnifiedAuditLog`, paged with `ReturnLargeSet` sessions. It
splits a window that reaches the 50,000-record session cap, and retries a
session that reports `ResultIndex -1`. It writes three CSVs, each keeping the
raw `AuditData`:
- **File operations** on the sites: FileUploaded, FileAccessed, FilePreviewed, FileDownloaded, FileSyncDownloadedFull.
- **Group and Teams membership and settings events.** These are tenant-wide in the window.
- **Sharing events** on the sites.

It also writes metadata and `SHA256SUMS`. It needs PowerShell 7,
ExchangeOnlineManagement, and the "View-Only Audit Logs" role.

## `infrastructure/ir/evidence-store.sh`

```bash
ROMAN_UPN=<roman> IOD_UPN=<iod> infrastructure/ir/evidence-store.sh \
  --resource-group rg-bcr-ir-evidence --account <storage account name> \
  --upload-dir tools/out/ir0-appinsights-<UTC> --grant-uploader [--apply]
```

It creates, or reuses, a StorageV2 account with these settings: no public
access, no shared keys, TLS 1.2, blob versioning, and a CanNotDelete lock. It
creates a container with **version-level immutability** and a time-based
retention (`--retention-days`, default 400).

The policy is left **unlocked**. The script prints the lock command, which is
irreversible, for a person to run once the evidence is in and checked.

"Storage Blob Data Reader" on the container goes to Roman, the IOD and the CTO
(`yahor.simak@bcr-group.pl`). `--apply` refuses while `ROMAN_UPN` or `IOD_UPN` is
unset. A reader who is outside the tenant must be invited as a guest first.

Uploads carry their sha256 as metadata. A blob that already exists with another
hash stops the run: evidence is never overwritten.

## Tests

```bash
node --test 'tools/test/*.test.mjs'
```

Node 22's `--test` takes files or glob patterns, not a directory. `node --test tools/`
fails with "Cannot find module …/tools", so quote the glob.

The tests use synthetic fixtures only:
- `test/tenant-fixture.mjs`: a fake tenant behind a fake `fetch`;
- `test/ir0-fixture.mjs`: fake pino traces.

They drive the CLIs end to end, and assert that read-only commands issue only
GET requests and that the token never reaches the output.
