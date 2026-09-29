# Incident 2026-09: client documents filed outside their client's space

Written for Roman, the IOD, and whoever runs the incident response after us. It records what
went wrong, what could be reached and by whom, what was done to stop it, and how the
documents already filed in the wrong place are found and moved back.

| | |
|---|---|
| Incident id | `IR-2026-09` |
| Found | 23–25 September 2026 (tenant audit, then the code audit of both repos) |
| Decision owner | Roman (business), with the IOD or lawyer for GDPR wording |
| Technical owner | Yahor (CTO) |
| Status | Containment in progress. See [Status](#status) at the end |

⚠️ **This file holds no evidence and no client data.** The trace export, the audit-log
export, the inventory and the relocation register contain file names, client names and user
ids. They live in the IR evidence store (see [IR-0](#ir-0-preserve-the-evidence-first)), readable by
Roman, the IOD and `yahor.simak@bcr-group.pl` only. Nothing from them is pasted here, and no
NIP, object id or file name should ever be added to this page. The exceptions are BCR's two
canary accounts, BCR-controlled test accounts, not a client's or a person's: the canary guest's
object id ([H-5b](human-steps.md#h-5b-invite-the-canary-guest)), and, since 29 September, the
canary client account's object id and its synthetic NIP `9000000000`, which fails the NIP
checksum, so no company can hold it
([Client identity release](human-steps.md#client-identity-release)). Both are recorded in the
status table because the canaries check against them.

---

## What happened, in one paragraph

The ledger bot decided whose SharePoint space a document belonged in by looking the uploader
up in the Client Directory list. Onboarding never wrote a client's guest id into that list,
so **every onboarded client's upload counted as "unknown"**. Unknown uploads went to one shared
bucket, the root of the **BCR GROUP team library**, which every member of that team can read,
and which on 23 September was a Public team that any internal account could join. From there,
a second step read the document with Claude and **moved it into whichever client's NIP
appeared anywhere in it**, in any role: a client's bank statement could land in its
supplier's team. Nothing checked the result. Roman reported that isolation between clients was
broken; the audit confirmed it and found the mechanism.

*Corrected 28 September:* the paragraph takes the guest for the client, as everyone did then. A
client's identity is its `{NIP}@bcr-group.pl` account, a Member created by BCR; guests have no
capability in the ledger (the owner's decision; [R1's correction](#root-causes) and
[Client lockout](#client-lockout-2628-september-t-1-reversed)).

## How it was found

| When | What |
|---|---|
| 23 Sep | Roman asked whether onboarded clients could reach the `Onboarding klientów` channel. The tenant audit (`bcr-onboarding-agent/docs/operations/client-access.md`) found the three `{NIP}@` client addresses enabled and licensed, and the BCR GROUP and Bricore teams Public. *Corrected 28 Sep:* the audit took the enabled, licensed `{NIP}@` accounts for a finding; they are the clients' own Teams sign-ins, and acting on that premise locked the clients out ([Client lockout](#client-lockout-2628-september-t-1-reversed)). |
| 23–25 Sep | A read-only audit of both repos: 33 security findings, each re-checked by an independent reviewer, all 33 held. They reduce to the six root causes below. |
| between 23 and 25 Sep | BCR GROUP was made Private. **Record the exact time here from the Purview `Update group` event** once IR-0 is exported. It stays Private; this response never changes its visibility, its membership or its channels. |
| 25 Sep | Automatic deploys to "dev" (which is production: it serves PESKOVOI, `0002`) were stopped, commit `f5a2bd4` (gate G0). The Phase-0 contract was committed, `21b0883`. Roman agreed the GDPR option in [IR-3](#ir-3-gdpr). |

**Awareness**, for the GDPR clock, arguably began with the 23–25 September audit. The 72-hour
window of Art. 33 may therefore close around **26–28 September**. That is why the processor
notice goes out before the inventory is finished, and is phased.

---

## Root causes

Line numbers refer to ledger commit `cbf1630` (the code that was running before Phase 0) and
to `bcr-onboarding-agent` as of 25 September 2026.

| # | Root cause | Evidence |
|---|---|---|
| **R1** | Onboarding step 13 never writes the guest's AAD id, so every onboarded client's upload counts as unknown. | `bcr-onboarding-agent/…/provisioning/clientDirectory.ts:85-104` writes the row with `RootFolder: ''` and no `UserAadObjectIds`. The id is available at `graphProvisioner.ts:361` (the invitation's `invitedUser.id`) and thrown away. |
| **R2** | Unknown uploads go to one fallback bucket: the root of the BCR GROUP team library, readable by every member of that team. The team was Public on 23 Sep, and three `{NIP}@` accounts that should have been sign-in-blocked mailboxes could sign in. | `document-ingestion/src/runtime.ts:34-45` (the fallback target), `PROJECT_OVERVIEW.md` at `cbf1630` ("fallback bucket" on `/sites/BCRGROUPSp.zo.o`), and `bcr-onboarding-agent/docs/operations/client-access.md`. |
| **R3** | **Content-based promotion.** A fallback upload moves to whichever client's NIP appears anywhere in the document, in any role. A crafted PDF or a prompt injection can plant files in any client's space. | `document-ingestion/src/services/clientResolver.ts:146-156` (the promotion branch) and `:186-224` (`promoteFromContent`, which ignores the party's role and whether the uploader has any link to that client). |
| **R4** | The "fail-closed" de-duplication fails open once three rows share a key: the third row wins. A duplicate `ClientId` makes a lookup return the wrong row. A staff id sits on a client row: Yahor's id is on PESKOVOI's row, so every upload of his is filed there whatever it is. | `clientDirectoryReader.ts:275-292` (`putUnique` deletes on the second row and re-adds on the third); `clientResolver.ts:211-212` (`entries.find` by ClientId); `bcr-onboarding-agent/…/caseRepository.ts:471` records that two live rows carry `0002`. |
| **R5** | Files land at the **library root**, because `RootFolder` is `''`. They never appear in the channel's Shared tab, which is where the client is told to look. | `clientDirectory.ts:92-94` (onboarding); `sharePointService.ts:48` (ledger joins the path onto the drive root). |
| **R6** | Other gaps: routing lives in an editable SharePoint list; an anonymous Personal Tab maps any user id to their client (IDOR); the ingestion API trusts a user id sent in the body; the bot accepts any conversation type and any tenant; model text is rendered as Markdown in the result card. | `teams-bot/src/functions/mydocs.ts:33-51`; `document-ingestion/src/functions/validation.ts:21-28`; `teams-app/manifest.json:28`; `teams-bot/src/bot/responseBuilder.ts:140`. |

**Corrections of 28 September 2026** (the owner's decision on the client identity; the rows
above stay as first written):

- **R1.** The id onboarding threw away was the guest's, and at the time the guest was taken for
  the client. The client identity is the client's `{NIP}@bcr-group.pl` account, a Member created
  by BCR; guests have no capability in the ledger. Onboarding still writes no user id (Q21 stays
  open): `tools/directory-bindings.mjs` binds each row's `{NIP}@` account, and the ingestion
  build of the [Client identity release](human-steps.md#client-identity-release) refuses guests.
- **R2.** The exposure was that **BCR GROUP was Public** (W2), so any internal account could join
  it and read the fallback bucket. It was not that the three `{NIP}@` accounts could sign in:
  they are the clients' sign-ins, and should.

### How they combined

R1 made every real client an unknown uploader. R2 put all their documents in one place that
staff, and for a while anyone in the tenant, could read. R3 then took the ones carrying a
known NIP and moved them into a client's space by content alone, which is also the path an
attacker would use. R4 meant the one safety net, the duplicate check, did not hold. R5 hid the
result: even correctly filed documents were not where the client looks, so nobody saw the
wrong ones either.

Only three sites could receive a write at all, because the ingestion identity holds a site
grant on exactly three: TEST (`/sites/0000TESTSp.zo.o.-Ksigowo`), BCR GROUP and PESKOVOI
(`/sites/0002PESKOVOISp.zo.o.-Ksigowo`). A promoted document for any other client would have
been refused with 403 and not stored. That bounds the inventory, and it is why the rollout
grants the ingestion identity no further client site while the old build still runs (H-7).

---

## What could be reached, and by whom

Each exposure window has an opening, an event that closes it, and the evidence that settles
whether anyone used it. Dates marked *record* are filled in from the IR-0 exports.

| # | Window | Exposed | To whom | Opened | Closed by |
|---|---|---|---|---|---|
| W1 | **Fallback bucket** at the BCR GROUP library root | Every unrouted upload, from every client, plus staff uploads | Members of BCR GROUP: Roman, Yahor and `AuthoriseMe@` | Multi-tenant routing go-live, on or before 16 Jul 2026 (*record* the deploy date) | New uploads: the fallback re-pointed at the quarantine ([H-6b](human-steps.md#h-6b-point-the-running-builds-fallback-at-the-quarantine)), then the Phase-0 ingestion deploy. Existing items: the folder lock in [tenant hardening T-4](tenant-hardening.md#t-4-lock-the-ledger-folders-at-the-bcr-group-library-root), checked again after H-6b, then IR-2 moves them out. |
| W2 | **BCR GROUP was Public** | Everything in W1, and the `Onboarding klientów` channel | Any internal account, including the three `{NIP}@` accounts, which could sign in | Unknown (*record* from the group's history) | Made Private between 23 and 25 Sep (*record*) |
| W3 | **Client accounts are tenant Members** (redefined 28 Sep; first recorded as "`{NIP}@` accounts could sign in") | Beyond their own client Team: any Public team, Viva Engage "All Company" and Communities, the directory and people search, any *People in your organization* link | The client holding the account | Account creation, by hand | Not closed: signing in is how a client works. Bounded by T-3 and T-6 (no Public team), T-8, T-9 and `docs/security.md` T22, never by blocking sign-in. First recorded as closed by [T-1](tenant-hardening.md#t-1-withdrawn-never-block-sign-in-on-the-nip-client-accounts), which blocked sign-in on 26 Sep and was reversed on 28 Sep ([Client lockout](#client-lockout-2628-september-t-1-reversed)) |
| W4 | **Content promotion** | A document moved into the site of whichever client's NIP it named, at that site's library root | Members of that client's Team, including the client's guest (*28 Sep:* and its `{NIP}@` account, also a member) | Go-live (as W1) | New moves: `ANTHROPIC_ENABLED=false` ([H-3](human-steps.md#h-3-stop-promotion-now-without-a-deploy)), then the Phase-0 ingestion deploy (P0-1). Items already moved: the client-site folder lock ([tenant hardening T-4b](tenant-hardening.md#t-4b-lock-the-ledger-folders-at-the-library-root-of-the-client-sites), after H-3), and a lock of its own on each such item found outside those folders (T-4b's Verify), then IR-2 moves them. For an item, W4 ends at the later of its lock and H-3. |
| W5 | **Personal Tab IDOR** | The client name, ClientId and SharePoint URL of any user whose object id is known | Anyone on the internet with the URL | Manifest 0.1.5 and `/api/mydocs` (about 16 Jul) | The Phase-0 bot deploy (the page becomes static), manifest 0.2.0, and the Phase-0 ingestion deploy (`/api/user-target` deleted) |
| W6 | **The upload register in App Insights** | File names, client titles, site paths, user ids | Anyone with read on the App Insights resource | First deploy | P0-9 logs ids only. Old lines age out after 30 days, except the copy IR-0 takes deliberately. |
| W7 | **Bricore team Public** | Its `Dokumenty księgowe` channel | Any internal account | Unknown | [Tenant hardening T-6](tenant-hardening.md#t-6-the-bricore-team) |

⚠️ **What the accounts *did* reach is only partly knowable.** The tenant has no Entra ID P1, so
the Entra sign-in log keeps only about 7 days and cannot be read through Graph **[verify]**. The
Purview unified audit log is the longer record: it holds file-level events and the
`UserLoggedIn` / `UserLoginFailed` sign-in events for about 180 days on Audit Standard
**[verify]**. IR-0 exports both, and the 7 days of Entra sign-ins, first. Whether the `{NIP}@`
accounts and `AuthoriseMe@` signed in (W2, W3) is answered from those exports, not assumed.
(*28 Sep:* a `{NIP}@` sign-in is the client's own. What matters for W2 is whether one of them
joined BCR GROUP, or opened its files, while it was Public.)

---

## Containment: Phase 0

Phase 0 is containment on today's code, without the database the full design needs. Every
item closes a named root cause. The human-run steps and their order are in
[`human-steps.md`](human-steps.md#phase-0); the tenant steps are in
[`tenant-hardening.md`](tenant-hardening.md).

| Step | What it does | Closes |
|---|---|---|
| G0 | No deploy on push to `main` (done, `f5a2bd4`). A full appSettings deploy would have wiped the hand-set routing settings. | deploy risk |
| P0-1 | Content-based promotion deleted. Routing uses the uploader's identity only; the invoice-direction flip stays inside the bound client. | R3 |
| P0-2 | A staff-only quarantine site replaces the fallback bucket. Unmapped, unbound (a row the binding tool has not bound), staff, conflicting, stale, forbidden-target and unwritable-target uploads go there, never to BCR GROUP. A row whose site resolves in Graph to BCR GROUP's or the quarantine's site collection, however its path is spelled, is refused (`sharepoint.forbidden_site`) and its upload quarantined as forbidden-target. The reasons are listed in [`human-steps.md` H-12](human-steps.md#h-12-the-change-window-ingestion-deploy-bindings-canaries). | R2 |
| P0-3 | The bot refuses anything that is not a 1:1 chat from the BCR tenant with a valid user id; ingestion re-checks the same three things. Manifest 0.2.0 is personal scope only. | R6 |
| P0-4 | The Directory snapshot is built in two passes and is order-independent. The alias and person-name maps are gone. A snapshot older than 15 minutes routes nothing. | R4 |
| P0-5 | Personal Tab removed; `/api/user-target` deleted. | R6 (IDOR) |
| P0-6 | Cards show no model text, escape every value, and give quarantined files no link. | R6 |
| P0-7 | Uploads never overwrite (`conflictBehavior=fail`); path segments are encoded. | R4 (overwrite race) |
| P0-8 | Ingestion accepts only the bot's app id; the single-document route is deleted. | R6 |
| P0-9 | Logs carry ids only (after IR-0 has copied the old ones). | W6 |
| Bindings | `tools/directory-bindings.mjs` writes each row's guest ids, channel folder, `DriveId` and `TeamId` from Graph, and removes staff ids from client rows. *Since 28 Sep:* the one user id it writes is the row's `{NIP}@` account, and it removes guest ids ([Client identity release](human-steps.md#client-identity-release)). | R1, R4, R5 |
| Tenant | ~~`{NIP}@` sign-in blocked and mailboxes unlicensed~~ (T-1 done 26 Sep and reversed 28 Sep, T-2 never run; both withdrawn: [Client lockout](#client-lockout-2628-september-t-1-reversed)); ledger folders on BCR GROUP locked to Owners (T-4); the same folders at the library root of every client site the ingestion identity could write to locked to Owners (T-4b); the Directory list locked and versioned; guest and sharing defaults tightened. | R2, W2, W4 (items already moved), W7; W3 bounded, not closed (redefined) |

**Until the Phase-0 build is live, without a deploy** (mandatory, from day 0; promotion is stopped
at once, without waiting for IR-0, because stopping it deletes no past log data):

- **Promotion off.** Promotion needs the parties that only the Claude classifier extracts, so
  `ANTHROPIC_ENABLED=false` on the running ingestion stops R3 at once, at the cost of every new
  upload going to `98_Nieposortowane` for an accountant
  ([`human-steps.md` H-3](human-steps.md#h-3-stop-promotion-now-without-a-deploy)).
- **The fallback re-pointed.** The running build's `FALLBACK_SITE_*` settings are pointed at the
  staff-only quarantine site, so unrouted uploads stop landing in BCR GROUP
  ([H-6b](human-steps.md#h-6b-point-the-running-builds-fallback-at-the-quarantine)).
- **No new site grants.** The ingestion identity gets no write on a further client site until the
  Phase-0 build is live (H-7, H-12), because each grant would be one more site promotion could
  reach.

Two things are **not** done in Phase 0, deliberately:

- **Secret rotation** waits until Roman provides new credentials. It is an accepted risk,
  recorded in [`docs/security.md`](../security.md#accepted-risks).
- **Yahor does not upload through the bot** until the full implementation is done. His id
  stays on the PESKOVOI row until the Phase-0 code and `directory-bindings.mjs` remove it,
  because editing the row earlier, under the old code, would send his uploads down the
  promotion path.

---

## IR-0: preserve the evidence first

App Insights keeps **90 days** on this component (`retentionInDays`), and the window moves every
day. The uploads of this incident reached ingestion on 7–16 July, so they age out from about
5 October. Each day's delay deletes a day
of evidence. The export also has to happen **before** the Phase-0 deploy, because P0-9 changes
what the logs contain, and before any change to logging configuration.

### What to export

**A. The routing and upload traces.** The ingestion app logs pino JSON on stdout, so App
Insights `traces` holds each line's JSON in `message`. These are the messages that matter
(before Phase 0). The fields were read from the code at `cbf1630`.

| Message | Logged by | Carries |
|---|---|---|
| `client resolved` | the request | `invocationId`, `conversationId`, `activityId`, `clientId`, `title`, `resolution` (`directory` or `fallback`), `matchedBy`, `siteHostname`, `sitePath` |
| `routed to client via userAadObjectId` | the resolver | `userAadObjectId`, `clientId`, `title`. **No** `invocationId`, **no** `conversationId` |
| `no directory match on user id — routing to fallback` | the resolver | `conversationId`, `userAadObjectId`. No `invocationId` |
| `matched an admin user — deferring to content routing (falling back)` | the resolver | `userAadObjectId`, `clientId`. No `invocationId` |
| `promoted fallback → directory client via content NIP match` | the resolver | `clientId`, `title` only |
| `client refined post-classification` | the document | `invocationId`, `conversationId`, `filename`, `clientId`, `title`, `resolution`, `sitePath`, `promotedFromFallback`, `directionCorrection`, `folderPath` |
| `classified` | the document | `invocationId`, `conversationId`, `filename`, `documentType`, `folderPath`, `partyCount` |
| `uploaded` | the document | `invocationId`, `conversationId`, `filename`, `driveItemId`, `webUrl` |
| `batch document failed` | the document | `invocationId`, `conversationId`, `filename`, the error |

"The request" and "the document" are request-scoped loggers, so every line they write carries
`invocationId` and `conversationId`. "The resolver" is a module logger with no request context.

```kusto
traces
| where cloud_RoleName startswith "func-bcr-ingest"
| extend m = parse_json(message)
| extend msg = tostring(m.msg)
| where msg in (
    "client resolved",
    "routed to client via userAadObjectId",
    "no directory match on user id — routing to fallback",
    "matched an admin user — deferring to content routing (falling back)",
    "promoted fallback → directory client via content NIP match",
    "client refined post-classification",
    "classified",
    "uploaded",
    "batch document failed")
| project timestamp, itemCount, operation_Id, msg,
    invocationId = tostring(m.invocationId), conversationId = tostring(m.conversationId),
    activityId = tostring(m.activityId), userAadObjectId = tostring(m.userAadObjectId),
    clientId = tostring(m.clientId), title = tostring(m['title']),
    resolution = tostring(m.resolution), matchedBy = tostring(m.matchedBy),
    sitePath = tostring(m.sitePath), promotedFromFallback = tobool(m.promotedFromFallback),
    directionCorrection = tostring(m.directionCorrection),
    documentType = tostring(m.documentType), folderPath = tostring(m.folderPath),
    driveItemId = tostring(m.driveItemId), webUrl = tostring(m.webUrl),
    filename = tostring(m.filename), raw = message
| order by timestamp asc
```

```bash
az monitor app-insights query -g rg-bcr-ledger-dev --app <app-insights-name> \
  --analytics-query @ir0-traces.kql \
  --start-time 2026-08-01T00:00:00Z --end-time <now, UTC> -o json > traces.json
```

⚠️ **Always pass both `--start-time` and `--end-time`.** With only a start, the CLI queries a
one-hour window and returns a result that looks complete. Pass a start older than the retention
(90 days here); the service simply returns what it still holds.

`tools/ir0/` holds the scripted version of these exports; the query above is the reference for
what it must return. Run it with `--all-traces`
([`human-steps.md` H-2](human-steps.md#h-2-preserve-the-evidence-ir-0-before-anything-changes-the-logs)),
so the bot's own traces are kept too.

**W5, the Personal Tab lookup.** Purview cannot see an anonymous Function call, so App Insights is
the only record of W5. Before Phase 0 the bot logged `personal tab resolved` (`userObjectId`,
`clientId`, `source`) and ingestion logged `user target resolved`. Both are in the
`--all-traces` export. The script also always exports the `requests` rows for `/api/mydocs` and
`/api/user-target`, which are not sampled, so they give the full count of calls, with time,
result code and the looked-up id in the URL. `client_IP` is masked by default, so only the
country and city columns say where a call came from **[verify]**.

**How the lines join, and where they don't:**

1. **`driveItemId` is the key**, and only the `uploaded` line carries it. Join each `uploaded`
   line to the other lines of the same document on `invocationId` + `filename`. That gives
   `classified` and, when routing changed, `client refined post-classification`, whose
   `promotedFromFallback` marks a promotion. Join to the batch's `client resolved` line on
   `invocationId` alone; its `resolution` says whether the upload started as `directory` or
   `fallback`. **Never join on filename alone.** The same name was uploaded more than once, and
   the overwrite race means one item can hold several uploads.
2. **The uploader comes from `conversationId`.** A 1:1 Teams conversation belongs to one user and
   the bot, so once any line ties a `conversationId` to a `userAadObjectId`, that holds for every
   upload in that conversation.
   - For a `fallback` upload, the resolver wrote `no directory match…` with both fields, a moment
     before `client resolved`.
   - For a `directory` upload, the resolver wrote `routed to client via userAadObjectId`, which
     carries the user id but no conversation. Match it by `clientId` and the nearest preceding
     timestamp. As far as the docs record, the only id on any client row before Phase 0 was
     Yahor's, on PESKOVOI. Export C, the Directory with its history, confirms or corrects that.
   - `matched an admin user…` before `no directory match…` means the uploader was on an
     `IsAdmin` row.
3. **Traces are sampled.** `host.json` samples every telemetry type except requests. A row with
   `itemCount` greater than 1 stands for lines that were dropped, so the export can be incomplete
   by construction. An item with no log line is treated as *uploader unknown*, not as *no upload
   happened*.
4. **Uploads older than the retention (90 days) have no trace at all.** The same rule applies to them.

`operation_Id` may also group the lines of one invocation **[verify]**. The JSON fields above do
not depend on it, so prefer them.

**B. The Purview unified audit log.** Confirm it is on, then export file operations on the
three sites the ingestion identity could write to, the group events for BCR GROUP, and the
sign-in events of the `{NIP}@` accounts and `AuthoriseMe@`.

**Use the script:** `tools/ir0/export-purview.ps1`, exactly as in
[`human-steps.md` H-2](human-steps.md#h-2-preserve-the-evidence-ir-0-before-anything-changes-the-logs)
(with `-FileOperations`, `-SignInUpn` and `-StartDate 2026-03-01T00:00:00Z`). It gathers every
page, starts a new session for every window, and splits a window that reaches the 50,000-record
session cap. It also exports the sharing events (`purview-sharing-events.csv`), which IR-2 needs
because the T-4/T-4b locks erase item-level links.

**The manual commands below are a fallback only,** for when the script cannot run. They are
**not equivalent** to it: one session per search cannot split a window, so each search stops
with an error when it reaches the session cap, and must then be run again per month (change
`StartDate` and `EndDate`) until none does. They collect **all** pages into one variable and
export once: `Export-Csv` overwrites its file, so exporting page by page keeps only the last
page, and an empty final page leaves an empty file.

```powershell
Connect-ExchangeOnline
Get-AdminAuditLogConfig | Format-List UnifiedAuditLogIngestionEnabled   # must be True

# Collect every page of one ReturnLargeSet session. A new SessionId per search, always:
# re-using one continues the old session instead of starting a new result set.
function Get-AllPages([hashtable] $Search) {
  $sid = [guid]::NewGuid().ToString(); $all = @(); $total = 0
  do {
    $page = @(Search-UnifiedAuditLog @Search -SessionId $sid -SessionCommand ReturnLargeSet -ResultSize 5000)
    if ($page.Count -gt 0) { $total = $page[0].ResultCount }
    $all += $page
  } while ($page.Count -gt 0 -and $all.Count -lt $total)
  # A session stops at 50,000 records and then returns an empty page, which looks complete.
  if ($all.Count -ge 50000 -or $all.Count -lt $total) {
    throw "Got $($all.Count) of $total records: the session cap was reached. Split the date range."
  }
  $all
}

$files = Get-AllPages @{ StartDate = '2026-03-01'; EndDate = (Get-Date).ToUniversalTime()
  RecordType = 'SharePointFileOperation'
  Operations = 'FileUploaded','FileAccessed','FilePreviewed','FileDownloaded','FileSyncDownloadedFull',
    'FileSyncDownloadedPartial','FileModified','FileMoved','FileCopied','FileRenamed','FileDeleted',
    'FileRecycled','FileDeletedFirstStageRecycleBin','FileDeletedSecondStageRecycleBin' }
foreach ($site in 'BCRGROUPSp.zo.o', '<PESKOVOI site>', '<TEST site>') {
  $files | Where-Object { ($_.AuditData | ConvertFrom-Json).SiteUrl -like "*/sites/$site*" } |
    Export-Csv "ir0-purview-$site.csv" -NoTypeInformation -Encoding UTF8
}

# Sharing: links created, used or removed. The T-4/T-4b locks clear item-level links, so this is
# the only record of them afterwards (IR-2).
$sharing = Get-AllPages @{ StartDate = '2026-03-01'; EndDate = (Get-Date).ToUniversalTime()
  RecordType = 'SharePointSharingOperation' }
foreach ($site in 'BCRGROUPSp.zo.o', '<PESKOVOI site>', '<TEST site>') {
  $sharing | Where-Object { ($_.AuditData | ConvertFrom-Json).SiteUrl -like "*/sites/$site*" } |
    Export-Csv "ir0-purview-sharing-$site.csv" -NoTypeInformation -Encoding UTF8
}

# Group events: who joined, who was added or made owner, when visibility changed.
Get-AllPages @{ StartDate = '2026-03-01'; EndDate = (Get-Date).ToUniversalTime()
  Operations = 'Add member to group.','Remove member from group.','Add owner to group.',
    'Remove owner from group.','Update group.','MemberAdded','MemberRemoved','MemberRoleChanged',
    'TeamSettingChanged' } |
  Export-Csv ir0-purview-groups.csv -NoTypeInformation -Encoding UTF8

# Sign-ins of the accounts in W2/W3 [verify that the tenant records them].
Get-AllPages @{ StartDate = '2026-03-01'; EndDate = (Get-Date).ToUniversalTime()
  RecordType = 'AzureActiveDirectoryStsLogon'; Operations = 'UserLoggedIn','UserLoginFailed'
  UserIds = '<nip-1>@bcr-group.pl','<nip-2>@bcr-group.pl','<nip-3>@bcr-group.pl','AuthoriseMe@bcr-group.pl' } |
  Export-Csv ir0-purview-signins.csv -NoTypeInformation -Encoding UTF8
```

Add Bricore's site to the loop if it held client documents. The role needed is Audit Reader or
View-Only Audit Logs (Global Admin has it). Audit Standard keeps about 180 days, *verify in the
tenant*; anything older than that is gone. The Entra admin centre's own sign-in log keeps only
about 7 days without P1; H-2 step 3 downloads it.

**C. The Client Directory as it stood.** Export the list, every row with all its fields and
each item's version history, so that "which ids were on which row, when" can be answered later.
It must happen before any Directory change: the H-7 status edit, `--add-columns`, and the H-12
bindings. The commands are
[`human-steps.md` H-2 step 4](human-steps.md#h-2-preserve-the-evidence-ir-0-before-anything-changes-the-logs).

### Where it goes

`infrastructure/ir/evidence-store.sh` creates a storage container **outside BCR GROUP and
outside the ledger resource group's shared storage**, with:

- a **time-based immutability policy**, so nothing can be altered or deleted before the
  retention date. The IOD confirms the period; leave the policy unlocked until then, and lock it
  as soon as it is confirmed, because an unlocked policy can still be removed by an Owner;
- **Storage Blob Data Reader** for Roman, the IOD and `yahor.simak@bcr-group.pl`, and nobody
  else. Write access is held only for the upload, and removed afterwards by hand: the script
  grants it but never removes it
  ([`human-steps.md` H-2 step 6](human-steps.md#h-2-preserve-the-evidence-ir-0-before-anything-changes-the-logs));
- a `SHA256SUMS` file listing every export, so a later reader can prove nothing changed.

The laptop copies are personal data. Delete them once the upload is verified, and record the
hashes, not the files, in the [status table](#status). IR-1 needs the trace export on disk: it
downloads it back from the store for the run and deletes it again afterwards
([IR-1](#ir-1-inventory)).

---

## IR-1: inventory

`tools/inventory-misfiled.mjs` is read-only. It walks the default library of BCR GROUP,
PESKOVOI and TEST, the only sites the ingestion identity could write to. It registers every item
the ingestion identity created or last modified (`createdBy` or `lastModifiedBy`
`application.id` is the ingestion managed identity), and every item IR-0 names. It does **not**
register every item under a ledger taxonomy folder: pass `--all-items` for that. At the end it
prints the applications that created files. Check that list against `--ingest-app-ids`: any
application id that wrote under a root taxonomy folder and is not in `--ingest-app-ids` (an
earlier or recreated ingestion identity, say) is added to it, and the run repeated.

Confirm the three-site bound before trusting it. `tools/directory-bindings.mjs check` reports,
for each Directory row, whether the ingestion identity holds a grant on that site. Any further
site where it holds `write` is added to the walk.

**Whose token.** IR-1 walks with a delegated token, and SharePoint trims every listing to what
that user may see. After T-4 and T-4b, the locked taxonomy folders are visible only to the
site's Owners, so a member's token silently skips them, and every item in them is missing from
the register, from IR-2 and from the list of affected clients. So IR-1 runs with the token of
someone who is an **Owner or a site collection admin of every site it walks**. If Yahor is not,
someone who is runs it; on BCR GROUP that is one of its existing site Owners, and nobody is
added to BCR GROUP for this. On a client site, the SharePoint Administrator may instead make him
a site collection admin for the run and remove that afterwards, recorded in the status table.

**The expected folders.** For each walked site, pass `--expect-root-folders <label>=<folders>`
with the taxonomy folders saved in T-4's or T-4b's *Read first* (and any added by a re-check).
The tool exits non-zero, naming the folder, when the walk does not see one, which is what a
token without Owner rights produces. It always prints, per site, the taxonomy folders it found at
the library root: compare them with the saved lists before trusting the run.

**The IR-0 trace export, back from the store.** H-2 deletes the laptop copies. Download the
export again with an account that holds Storage Blob Data Reader on the store (Roman, the IOD or
`yahor.simak@bcr-group.pl`), check it against its `SHA256SUMS`, and delete it again once IR-1 has
run. The blob path is `ir0/<upload date>/<export folder>/`, as `evidence-store.sh` printed it.

```bash
R=tools/out/ir0-restore; mkdir -p -m 700 "$R"
az storage blob download-batch --auth-mode login --account-name <storage account> \
  -s ir0-evidence -d "$R" --pattern 'ir0/<upload date>/ir0-appinsights-<UTC>/*'
# Every line must read OK.
(cd "$R/ir0/<upload date>/ir0-appinsights-<UTC>" && shasum -a 256 -c SHA256SUMS)
```

Never drop `--ir0` to get a run through. Without it the tool cannot tell a fallback or a
promoted upload from any other, so it flags every item the ingestion created or modified as
`no_ir0_given` (suspect): the run is then complete but says nothing, and every such item goes to
IR-2.

Run it with the `directory-bindings.mjs propose` plan from
[`human-steps.md` H-7](human-steps.md#h-7-check-the-directory-before-the-deploy-and-add-the-new-columns)
(H-12's plan, once it exists). The plan gives the ids that may upload for each site's own
client, and without it the tool cannot tell the client's upload from anyone else's. A
**version-2** plan (the client-account rule, from 29 September) records each row's
`clientAccount`, its `{NIP}@` account in that Team alone. A **version-1** plan (every plan made
before 29 September, H-12's included) records each site's guests (`eligibleGuests`) and is still
read that way, so a run made with one is reproducible. `--site-accounts <label>=<oid,…>` is the
manual alternative (its older name, `--site-guests`, still works). The flags are described in
[`tools/README.md`](../../tools/README.md).

```bash
node tools/inventory-misfiled.mjs \
  --site 'BCRGROUP=<tenant>.sharepoint.com:/sites/BCRGROUPSp.zo.o' \
  --site 'PESKOVOI=<tenant>.sharepoint.com:/sites/<PESKOVOI site>' \
  --site 'TEST=<tenant>.sharepoint.com:/sites/<TEST site>' \
  --expect-root-folders 'BCRGROUP=<taxonomy folders from T-4 Read first>' \
  --expect-root-folders 'PESKOVOI=<taxonomy folders from T-4b Read first>' \
  --expect-root-folders 'TEST=<taxonomy folders from T-4b Read first>' \
  --ingest-app-ids "$INGEST_MI_APPID" --fallback-site BCRGROUP \
  --ir0 tools/out/ir0-restore/ir0/<upload date>/ir0-appinsights-<UTC>/ \
  --bindings-plan tools/out/directory-bindings-plan-<UTC>.json
# Once the run is checked:
rm -rf tools/out/ir0-restore
```

For each item it records:

- `driveItemId`, the site, the path at the time of inventory, created and modified times;
- **every version**: how many, and each version's size and modified time. The overwrite race
  and repeated uploads under the same name mean an item's older versions can hold a
  *different* document, possibly another client's;
- **every IR-0 log line for that `driveItemId`**, and the uploader id that the join above
  yields, or `unknown`;
- whether the logs show it as promoted, fallback, or routed by identity;
- whether the uploader may upload for that site's own client: its `{NIP}@` account (version-2
  plan) or a guest of its Team alone (version-1 plan). `uploader_not_site_guest` when not; the
  flag keeps its name, because registers already in the evidence store carry it.
  Before Phase 0 the only id on a client row was staff, so every upload routed "by identity"
  into PESKOVOI was a staff upload, whatever its content. This flag is what brings those items
  into IR-2.

It does **not** read an item's sharing links or join the Purview export. Both are checked by
hand, per item, in [IR-2](#checks-per-item-by-hand). Once IR-1 has run for a client site,
T-4b's Verify uses the register to lock, one by one, the flagged items that sit outside the
locked folders
([tenant hardening T-4b](tenant-hardening.md#t-4b-lock-the-ledger-folders-at-the-library-root-of-the-client-sites)).

The output is a register of client documents, so it goes to the evidence store and nowhere
else. Items it flags as *suspect* (promoted, fallback, uploader unknown or ambiguous, uploader
not on the site's list, and the other flags in `tools/README.md`) are the input to
IR-2. An item with more than one version goes through IR-2's version rule whether or not it is
flagged. Later jobs process only what IR-2 has cleared ([the allow-list](#the-allow-list)).

The inventory also answers the GDPR question "which clients are affected": every client with
an item in W1 or W4.

---

## IR-2: relocation

Nothing moves before IR-0 is stored, IR-1 is complete for that site, that site's folders are
locked ([T-4](tenant-hardening.md#t-4-lock-the-ledger-folders-at-the-bcr-group-library-root) for
BCR GROUP, [T-4b](tenant-hardening.md#t-4b-lock-the-ledger-folders-at-the-library-root-of-the-client-sites)
for a client site), and the quarantine site exists. Moves are done by staff, by hand, with a
second person checking each one.

### Who owns an item: the rules, in order

The rule that caused this incident was "the content names the client". So content never
decides on its own here; it can only break a tie between candidates that identity already
produced.

1. **Take the uploader from IR-0.** The uploader's `userAadObjectId`, joined on `driveItemId`
   as described above.
2. **Map the uploader to candidate clients by Team membership.** Read the uploader's
   `memberOf` and count every Team (groups whose `resourceProvisioningOptions` contains `Team`),
   not only those whose description starts `BCR Group — `: the five Teams `[0000]`–`[0004]`,
   PESKOVOI's among them, predate onboarding and carry no such description.
   - A **guest of exactly one** client Team: that client is the candidate owner.
   - A guest of **several** client Teams: those clients are the candidates.
   - A client's **`{NIP}@` account** (a `Member` whose UPN is ten digits at `bcr-group.pl`, the
     client identity since the owner's decision of 28 September): the client of its one Team is
     the candidate; in several Teams, those clients are. IR-0 found no upload by one (IR-0 A).
   - **Staff** (any other `Member` of the tenant): membership does not narrow it, because staff
     belong to many Teams. The staff member who uploaded states in writing which client the
     document was for; that client is the candidate.
   - **Unknown uploader** (no log line, older than the 90-day retention, or sampled away): there is no
     candidate. The item goes to quarantine.
3. **Use the content only as a tie-breaker, and as a check.**
   - Several candidates: if the content points to exactly one of them, that one is the owner;
     otherwise quarantine.
   - One candidate: if the content plainly belongs to someone else (for example, another
     client's own bank statement), the evidence conflicts. Quarantine.
4. **Conflicting evidence always goes to quarantine**, never to a client. A document in
   quarantine is safe and can be moved later; a document in the wrong client's folder is the
   incident again.
5. **Belongs to no client** (a test file, BCR's own paper): it stays locked where it is and is
   deleted after BCR's retention decision.

### Checks per item, by hand

IR-1 does not do these, so the person deciding does, before signing:

- **Sharing links.** Filter IR-0's `purview-sharing-events.csv` (or the fallback's
  `ir0-purview-sharing-<site>.csv`) for the item's URL or `ObjectId`: every link created, used or
  removed. This is the record that counts. T-4 and T-4b stopped inheritance with
  `clearSubscopes=true`, which reset every item in a locked folder and removed its links and
  direct grants, so the live permissions no longer show them. For an item T-4b locked on its own,
  also read the permissions it saved before the lock. Then, in Graph Explorer,
  `GET /drives/{driveId}/items/{itemId}/permissions` for what is there now. Any link, or any
  grant that is not inherited from the site, past or present, goes in the register row's
  `Reason`, and a live link is removed before the item is moved.
- **Access events.** Filter the IR-0 Purview file-operations export for the item (its URL or
  `ObjectId`). Count the events by anyone other than staff and the ingestion identity into
  `NonStaffAccess`. For an item in W4 that includes the receiving client's members: its guest
  and its `{NIP}@` account.

### Versions before any move

A move across sites keeps version history. An item with more than one version therefore moves
its older versions too, and they may be another client's document. So, **before** moving:

- If an older version is the same document (same size and upload lines, or an edit by the
  client), delete the non-current versions.
- If an older version is a different document, copy that version's content to the quarantine
  site as a new item with its own register row, then delete it from the version history.
- Only then move the current version.

### Two people, every time

Every decision and every move has two names on it: the person who decided and the person who
checked. Neither can be the same for one item. The register is readable by the IOD.

### The register

The working register is a list on the quarantine site (staff-only, sharing disabled), not on
BCR GROUP. A snapshot of it goes to the evidence store at each milestone.

| Column | Meaning |
|---|---|
| `Ref` | `IR-0001`, … |
| `SourceSite`, `SourceDriveItemId`, `SourcePath` | Where IR-1 found it |
| `CreatedAt`, `VersionCount`, `VersionsHandled` | And how the older versions were dealt with: `deleted` or `copied-to-quarantine:IR-nnnn` |
| `UploaderOid`, `UploaderKind` | From IR-0: `guest`, `staff`, `nip-account`, `unknown` |
| `IdentityCandidates` | ClientIds from Team membership (or the staff statement) |
| `ContentIndicates` | ClientId or `none`. A tie-breaker only |
| `Decision` | `client:<ClientId>`, `quarantine`, or `delete-after-retention` |
| `Reason` | One line, in words |
| `DataCategories`, `NaturalPersons` | e.g. invoice, bank statement, payroll, PESEL present. For IR-3 |
| `NonStaffAccess` | Count of Purview access events by anyone other than staff and the ingestion identity |
| `DecidedBy`, `CheckedBy`, `DecidedAt` | The two people |
| `MovedAt`, `TargetDriveItemId`, `TargetPath` | After the move |
| `AllowListed` | `yes` once both signatures are there and the move is verified |

### The allow-list

The register produces, per client drive, the list of `driveItemId`s (at their final location)
cleared as belonging to that client, with both signatures:

```json
{
  "incident": "IR-2026-09",
  "clientId": "<ClientId>",
  "driveId": "<driveId>",
  "generatedAt": "<ISO time>",
  "registerSnapshotSha256": "<sha256 of the register snapshot it came from>",
  "signedOffBy": ["<first person>", "<second person>"],
  "items": [{ "driveItemId": "<id>", "ref": "IR-0001" }]
}
```

**Every later job that touches ledger items at a library root must take this file and use
nothing else**: the root-to-channel-folder migration, the index backfill and the
review-task backfill. Each of them refuses to run on a drive while the register still has open
items for it, **processes only the `driveItemId`s on the list and skips every other item**,
suspect or not, and shows included and excluded counts per client in its dry run before anyone
approves `--apply`. Without this, those
jobs would take the misfiled documents and make them searchable, billable and permanent in the
wrong client's space.

---

## IR-3: GDPR

### The agreed option (Roman, 25 Sep 2026)

1. **Processor notice to the controllers, now.** BCR processes client documents under an
   entrustment agreement (*umowa powierzenia*), so it is the **processor** and each client is
   the **controller**. Under Art. 33(2) BCR notifies each affected client without undue delay:
   PESKOVOI now, and each onboarded client that IR-1 finds with items in W1 or W4. The notice is
   **phased** as findings are established, so that each controller can meet its own Art. 33(4)
   duty: what happened, which data categories, what was done, and that the investigation
   continues. Each client, as controller, decides whether to notify UODO.
   Template: [`gdpr/processor-notice-2026-09.pl.md`](gdpr/processor-notice-2026-09.pl.md)
   (English mirror: [`.en.md`](gdpr/processor-notice-2026-09.en.md)).
2. **BCR's own breach register**, today: under Art. 33(5) for the data BCR controls, and as the
   processor's record under Art. 28(3)(f) for client documents. It holds the incident, the
   exposure windows, the containment steps, and the reasoning for each notification decision.
   Template: [`gdpr/breach-register-entry-2026-09.md`](gdpr/breach-register-entry-2026-09.md).
3. **UODO directly, only where BCR is the controller**, which is BCR's own data (its staff,
   its own records, the routing list and the telemetry about uploads), and only if the Purview
   export shows that a **non-staff identity accessed personal data**. Otherwise BCR records in
   the register why it did not notify.
4. **Art. 34, through the controller.** Where individuals face a high risk (a PESEL together
   with salary data, bank data), the data subjects must be told. BCR does that through, and at
   the decision of, the controller, and supplies what the controller needs.

The IOD or lawyer confirms the wording of every notice before it is sent. The umowa
powierzenia may set a shorter deadline or a required form for the processor notice; check it
first.

### What each notice may contain

**One notice per client, about that client only.** A notice never names another client, never
lists another client's documents, and never says which client's space a document landed in.
The per-client list of affected documents is sent separately, over a secure channel.

### The decision guide

| Situation found by IR-0/IR-1 | Action |
|---|---|
| Items in W1 only, and no access event by anyone other than staff | Processor notice (phase 1) and breach-register entry. The controller will likely record rather than notify; that is their decision. |
| A non-staff identity (a `{NIP}@` account, or another client's guest) could reach the item and **did** (an access event), and it holds personal data | Processor notice with that fact; the controller's 72 hours run from it. If the data is BCR's own: BCR notifies UODO. |
| An item was promoted into another client's site (W4) | Processor notice to the **owning** client; the receiving client's members (its guest, its `{NIP}@` account) are third parties who had access. |
| High risk to individuals | Art. 34 through the controller. |

---

## IR-0 A findings (26 September)

From the 90-day trace export (read by counts and account types only; ids stay in the evidence).

- **Every ingestion request in the retained window was on 7–16 July 2026:** 30 documents
  classified and uploaded (19 single-document requests, 11 batches), plus one Personal Tab lookup
  (W5).
- **Every routing line names one uploader: Yahor's staff account.** No client guest and no
  `{NIP}@` account ever reached ingestion through the bot. This matches a Teams limit found the
  same day: a guest cannot attach a file in a 1:1 chat at all ("Attach files: channel posts only").
- **Resolutions:** 3 to BCR GROUP (the fallback), 3 to PESKOVOI's row (Yahor's id sits on it).
  **No content promotion was ever logged** (`promoted fallback → …`: 0).
- **Not covered:** 12–27 June. The App Insights component exists since 12 June, and those days
  aged out before the incident was found. The first request of any kind in the retained window is
  on 7 July.
- **What it means for IR-1/IR-3:** the ledger's own write path put Yahor's July test uploads into
  BCR GROUP's and PESKOVOI's library roots. Which of those files, if any, carry client personal
  data, and who opened them (Purview, H-2 step 2), decides the notice scope. The `{NIP}@` and
  Public-team exposures (W2, W3, W7) are separate from the ledger and stay in scope.

## IR-1 findings (26 September)

Read-only inventory of BCR GROUP, PESKOVOI and TEST (every library), joined to the 90-day IR-0
export. Counts only here; the register is in the evidence.

- **45 files written by the ingestion identity:** TEST 39 (15 in June, 24 in July), PESKOVOI 3
  (July, in its own `01_Faktury/02_Faktury_zakupu`), and 3 IR-0 records for BCR GROUP.
- **BCR GROUP holds none of them now.** The three fallback uploads the logs record are not in any
  of its libraries: someone moved or deleted them after July. With the audit log off (below),
  there is no record of who. Ask Yahor and Roman.
- **Several PESKOVOI documents sit in TEST's library.** TEST's Team is staff only (Yahor and two
  staff members), so no client could open them there. IR-2 decides whether they move to PESKOVOI
  (two-person sign-off).
- **Who can read where:** PESKOVOI's Team holds its own guest, its own `{NIP}@` mailbox (sign-in
  blocked in T-1) and staff. (*Corrected 28 Sep:* the `{NIP}@` account is not a mailbox nobody
  signs in with but PESKOVOI's own Teams sign-in; T-1 was reversed that day.) BCR GROUP holds
  Roman, Yahor and `AuthoriseMe@` (T-7); it was Public until 23 September, so while the fallback
  files were there any internal account could have joined. None of the other clients' `{NIP}@`
  accounts is a member now.
- **The Microsoft 365 unified audit log was off** until 26 September (Purview showed "Start
  recording user and admin activity"). There is no Purview record of who opened, moved or deleted
  any file before that date, so H-2 step 2 has nothing to export for the past. Yahor and Roman
  opened the July documents themselves (Yahor, 26 September); nobody can show from the logs that
  nobody else did. Roman and the IOD weigh that in IR-3.

## Client lockout, 26–28 September (T-1 reversed)

A tenant step of this response locked three clients out of Teams for about two days. Times are
UTC, from the Entra audit log, read-only. Clients are named by their record number.

| When | What |
|---|---|
| 25 Sep | Tenant step T-1, "block sign-in on the `{NIP}@` client addresses", agreed with Roman. |
| 26 Sep 12:18:09 | `yahor.simak` disabled the three `{NIP}@bcr-group.pl` client accounts, of 0002 (PESKOVOI), 0003 and 0004: T-1, run by Claude with Yahor's approval. |
| 26 Sep 14:05:08 | `yahor.simak` disabled `AuthoriseMe@` (T-7 as then written). |
| 28 Sep 07:34 | Roman reset 0002's password. The account was still disabled, so the reset could not help. The new password went to the client over Telegram, in plain text. |
| 28 Sep 11:58 | The channel inbox began filing for row 2 (PESKOVOI, `enforce`). |
| 28 Sep 17:33:38–17:34:32 | Roman re-enabled all four accounts, and also `BCROnboarding@`, the onboarding shared mailbox, which had been disabled since before 22 September, not by this response. |

**The premise.** The `{NIP}@` accounts were taken for shared mailboxes nobody signs in with. The
sources were the onboarding repo's `tools/audit-client-access.mjs` and
`docs/operations/client-access.md`, both of 23 September: the audit reported an enabled,
licensed `{NIP}@` account as a finding and offered `--apply` to block it. In fact these accounts
are how the clients sign in to Teams.

**The impact.** The three clients could not sign in to Teams from 26 September 12:18Z until
about 17:34Z on 28 September: no Team, no channel, no files, no bot. The channel inbox shows no
PESKOVOI upload since it began filing for row 2 (28 September 11:58Z). No document was lost:
nothing was moved or deleted. 0003 and 0004 have no Directory row, so the ledger routed nothing
for them either way. The password sent over Telegram is a credential-handover risk of its own:
the client should change it (or the account is set to change it at next sign-in).

**The cause.** How clients sign in was never confirmed with the owner before a tenant change that
depended on it. The 23 September audit inferred it, the plan of 25 September adopted it, and T-1
acted on it, with no step in between that asked the owner.

**The owner's decision** (Yahor, 28 September):

- the `{NIP}@bcr-group.pl` Member account is the client identity: for classification in both
  intakes, for search and for the bot;
- guests have **no** ledger capability: they are not onboarded as clients and do not pay.
  Onboarding keeps inviting the client's contact as a guest, for Team access only;
- Roman keeps creating, enabling and licensing the `{NIP}@` login by hand;
- `BCROnboarding@` stays enabled (Roman reads it); `AuthoriseMe@` is not changed in any way;
- nothing may ever block, disable, unlicense or convert a `{NIP}@` account.

**Done.**

- The accounts re-enabled by Roman (28 September, 17:33–17:34Z).
- [Tenant hardening](tenant-hardening.md): T-1 and T-2 withdrawn, never to be run; T-7 a
  read-only record; a note that `BCROnboarding@` stays enabled; T-10 no longer depends on T-1.
- On this page: W3 redefined and R2 corrected (dated corrections above).
- The canary client account `9000000000@bcr-group.pl`, created by Roman on 29 September: a
  Member with Business Basic, usage location PL, a member (not an owner) of BCR Kanarek only.
  Row 10's NIP was set to `9000000000` on 29 September at 09:44:54Z (the old value, BCR GROUP's
  NIP used for the classifier re-tests, is saved off-repo). The canary guest stays, as the
  negative canary. Its object id is in the status table.

**Done, 29 September** (the [Client identity release](human-steps.md#client-identity-release)):

- The ledger change was committed as `5beb0b9` and the onboarding change as `226828c`. All
  checks passed in both repos before the commits, including the real-Postgres tests.
- **Rows 2 and 10 re-bound at 10:58:42Z** by `directory-bindings.mjs apply`, whole plan. Row 2
  now holds 0002's `{NIP}@` account and row 10 the canary client account; each guest id was
  removed. Nothing else on either row changed. The apply log's sha256 is `9aa53da1…`, and
  `check` afterwards exits 0.
- **Ingestion deployed at 11:02:13Z.** The previous package was saved as
  `document-ingestion-p7-20260929T105902Z.zip` (`10bf0709…`) and the deployed zip is `fc83c0bc…`;
  the running hash matches. `/api/health` reports `clientIdentity: nip-member`, and the other
  fields are unchanged. The `identity.config` line says `nip-member`, and every inbox tick since
  shows `failed 0` and `rowsFailed 0`.
- **The bot deployed at 11:08:06Z.** The previous package was saved as
  `teams-bot-p2-20260929T105902Z.zip` (`0e008e53…`) and the deployed zip is `05f5ebbd…`; the
  running hash matches.
- **Canaries, with the canary client account:**
  - `pomoc` got the new help card (11:32:40Z).
  - **A PDF sent in the 1:1 chat** was routed to row 10 with `account: verified` and
    `membership: verified`, classified as `faktury_zakupu`, filed to
    `01_Faktury/02_Faktury_zakupu/2026/09`, and indexed as `FILED` (11:33Z). These are the
    bot-path proofs that H-12/H-15 had to drop.
  - **A PDF posted in the channel** was sorted by the inbox to `98_Nieposortowane/2026/09`
    (`MODEL_UNSORTED`) and indexed as `NEEDS_REVIEW` (11:36Z). The review notice was posted at
    11:40Z.
  - A staff post in the canary channel is left untouched (`inbox.skipped` `not_bound`).
- **Not run live:** the canary guest's own negative proof, because the guest can no longer sign
  in. The refusal is proven by `clientAccountRegression.test.ts`, which runs the real resolver,
  batch, search and inbox against fakes and was checked by mutation. Graph reads the old canary
  guest as `Guest`, and the rule refuses it before any Directory lookup.
- **Still open:**
  - the Teams admin uploads manifest 0.2.2;
  - the onboarding change is deployed once it is pushed;
  - Vitali and the canary account change the passwords that were exposed.

**Redefined** (28 September; the rows above keep their first wording beside the correction):

- **W3** is now "client accounts are Members and reach tenant-wide surfaces": the directory,
  Viva Engage, organisation-wide links, any Public team. It is bounded by T-3 and T-6 (no Public
  team), T-8, T-9 and `docs/security.md` T22, and never by blocking sign-in.
- **R2**: the exposure was BCR GROUP being Public, not the `{NIP}@` accounts being able to sign in.

**GDPR.** Each template in [`gdpr/`](gdpr/) carries a dated correction at its top: the
"sign-in blocked (T-1, T-2)" measure is withdrawn, and the processor notice drops "which should
not have been able to sign in". The lockout itself is an availability event for three clients
(0002, 0003, 0004). Whether it needs its own view in the breach register is the IOD's call: an
open question, recorded in the status table.

## Status

Update this table as steps complete. Evidence columns hold hashes, commit ids and dates only,
plus the object ids of BCR's two canary accounts (H-5b; the canary client account).

The `H-` references are the steps in [`human-steps.md`](human-steps.md#phase-0).

| Step | Owner | Status | Date | Reference |
|---|---|---|---|---|
| H-0: G0, deploy trigger removed | Yahor | done | 2026-09-25 | `f5a2bd4` |
| G1: Bicep deploys to dev ([Lifting gate G1](human-steps.md#lifting-gate-g1)): rehearsal, clean `--live`, what-if reviewed, refusal lifted in its own commit | Yahor; Roman creates the rehearsal group and reviews the lift | todo: the template records every running setting (G1 branch); dev still refused | | per step: `SAME` for both apps' package hash, functions listed and `200` before and after, both `--live` runs clean, the rehearsal's commit and teardown; the dev `--live` result; who reviewed the what-if; the lifting commit |
| Phase-0 contract committed | Yahor | done | 2026-09-25 | `21b0883` |
| H-1: IR-3 (1), processor notice phase 1 to PESKOVOI | Yahor (CTO) | not sent: decided no notification | 2026-09-26 | Yahor's decision: the July documents were used for testing by BCR staff (Yahor, Roman) only; IR-0/IR-1 show no client-side access path used. Recorded here as the Art. 33(5) documentation; the IOD may review |
| H-1: IR-3 (2), breach-register entry | Yahor (CTO) | this table is the record | 2026-09-26 | assessed as not notifiable (see H-1 row); no UODO notification |
| H-2: IR-0 A, trace export | Yahor | done (local; not yet in the store) | 2026-09-26 | 90 days, 2026-06-28 → 09-26: `ir0-appinsights-2026-09-26T13-34-08Z/SHA256SUMS` sha256 `1ac442f02f8478b3…`, 5,103 rows (72 routing). The first 30-day run (`…12-04-00Z`) held no application log and is superseded. Findings: [IR-0 A findings](#ir-0-a-findings-26-september) |
| H-2: IR-0 B, Purview export (file operations, group events, sign-in events) and audit-log state | Global Admin | not possible: unified audit log was off; turned on 2026-09-26 | 2026-09-26 | no past records exist; recording from 26 Sep |
| H-2: Entra sign-in log, last 7 days, for the `{NIP}@` accounts and `AuthoriseMe@` | Global Admin | todo | | `SHA256SUMS` |
| H-2: IR-0 C, Directory export | Yahor | done (local; not yet in the store) | 2026-09-26 13:23Z | `ir0-directory-20260926T132344Z/SHA256SUMS` sha256 `73c91c57e1624de8…`; 1 row (0002, Active) with 2 versions, fields included |
| H-2: evidence store created, readers verified, uploader write removed, laptop copies deleted | Roman, Yahor | todo | | |
| H-3: `ANTHROPIC_ENABLED=false` (mandatory) | Yahor | done | 2026-09-26 11:58:09Z | H-5/H-6/H-6b not done the same day (Saturday): interim writes to BCR GROUP's `98_Nieposortowane` accepted until H-6b, pending Roman's confirmation |
| BCR GROUP made Private (time from Purview) | — | done | *record* | T-3 |
| H-4: tenant hardening T-1 … T-9 | per step | T-1 done 26 Sep 12:18:09Z, then **reversed** 28 Sep 17:33Z (Roman) and **withdrawn**; T-2 **withdrawn**, never run; T-6 done; T-7 done 26 Sep 14:05:08Z, reversed 28 Sep, now a **read-only** record; the rest todo | 2026-09-28 | [`tenant-hardening.md`](tenant-hardening.md#status); [Client lockout](#client-lockout-2628-september-t-1-reversed) |
| T-4 checked again after H-6b | BCR GROUP site owner | todo | | time, and any folder locked, in [`tenant-hardening.md`](tenant-hardening.md#status) |
| T-4b: client-site root folders locked after H-3 (end of W4 for the items in them: the later of the lock and H-3) | SharePoint Admin | todo | | sites, lock times and H-3's time in [`tenant-hardening.md`](tenant-hardening.md#status) |
| IR-1 inventory: run with an Owner's or site collection admin's token and `--expect-root-folders` for every site; `--ir0` restored from the store; exit 0 | Yahor | done before T-4/T-4b (so nothing was hidden), `--all-drives`, `--ir0` = the 90-day export; exit 0 | 2026-09-26 13:50Z | `ir1-inventory-2026-09-26T13-50-09Z.json` sha256 `b79b2cdc91d3a614…`; see [IR-1 findings](#ir-1-findings-26-september) |
| T-4b: items outside the locked folders checked after IR-1, and locked one by one | SharePoint Admin | todo | | per site: done, and the number of items locked (the items themselves in the evidence store) |
| H-5, H-6: quarantine site and ingestion write grant | Yahor (Global Admin) | done | 2026-09-26 | communication site, Polish, sharing off, owners Yahor + Roman; four columns; Grant-TeamSiteAccess job `eced5ff6` → `granted` to the ingestion managed identity |
| H-5b: canary guest invited, in no Team; whether it reached the bot before H-10 | Global Admin | superseded: the guest was invited and posted in BCR Kanarek as the channel-inbox canary from 26 Sep (row "Channel inbox"); the pre-H-10 question no longer matters, because guests have no capability since 29 Sep. As the negative canary it has not been run: nobody has its sign-in (29 Sep) | 2026-09-26 | the canary guest's object id (one of the two object ids this page holds; see the top). Since 28 Sep it is the **negative** canary: guests have no ledger capability |
| Canary client account `9000000000@bcr-group.pl`: Member, Business Basic, usage location PL, a member (not an owner) of BCR Kanarek only; row 10's NIP set to `9000000000` ([Client identity release](human-steps.md#client-identity-release)) | Roman (the account), Yahor (the row) | done: created, row 10's NIP set, bound to row 10 at 10:58:42Z (the client identity release's apply) | 2026-09-29 | object id `d7367154-a2e7-4246-8cda-4cf7b47639da`; row 10's NIP set 09:44:54Z (the old value, BCR GROUP's NIP used for the classifier re-tests, saved off-repo); the positive canary from the client identity release on |
| H-6b: running build's fallback re-pointed at the quarantine | Yahor | done 13:12:17Z; superseded by H-12 (the Phase-0 build uses QUARANTINE_* and was proven by the 14:11Z canary) | 2026-09-26 | names `FALLBACK_CLIENT_ID`, `FALLBACK_SITE_HOSTNAME`, `FALLBACK_SITE_PATH`, `FALLBACK_DRIVE_NAME` saved locally (mode 600) until the store exists; no ingestion traffic between H-3 and H-6b |
| H-7: Directory check; duplicate `0002` resolved; per-row decisions, incl. which sites get a grant in H-12 | Yahor, Roman | check done (exit 0); decisions pending | 2026-09-26 | one Active row (0002), no duplicate; unbound (`not routing`); staff id to remove at H-12; PESKOVOI write grant `unknown` (verify at H-12 step 3); new columns not yet added |
| H-8: app settings added | Yahor | done | 2026-09-26 | shape check clean; `MICROSOFT_APP_TYPE` was already `SingleTenant` (no live change) |
| H-8b: ingestion identity `Directory.Read.All` (runtime Team check) | Yahor (Global Admin) | done | 2026-09-26 12:34:35Z | app role assignment verified on the ingestion managed identity; H-12 not before 2026-09-27 12:35Z (token cache) |
| H-9: bot deploy, gate in `log` | Yahor | deployed 12:16:59Z; TEST guest `pomoc` pending | 2026-09-26 | pre-Phase-0 bot `b1c74ec5…29cfa`, ingestion `19e4f769…1dc14a` (saved); deployed zip `56963ff9…a5278` from `b742acc`; `bot runtime initialised` with `botGateMode=log` |
| H-10: manifest 0.2.0 and availability (T-10) | Yahor (Teams admin) | done as 0.2.1 | 2026-09-26 | uploaded `teams-app-0.2.1.zip` (personal scope only, no tab, channel-inbox description), availability Everyone |
| H-11: gate `enforce` after 24 h clean | Yahor | done early, by Yahor's decision (no real clients use the agent) | 2026-09-26 13:59:20Z | 1 refusal in log mode, a channel `conversationUpdate` (correct); a real guest's personal chat passed |
| H-12: ingestion deploy, further site grants, bindings, canaries | Yahor | done; negative canary passed 14:11Z (staff upload → quarantine `unmapped`, Directory read after H-13 OK); a positive canary through the bot is impossible (guests cannot attach in a 1:1 chat), so it moves to the channel-inbox rollout | 2026-09-26 14:00:17Z | zip `038b69ab…` from `9951450`; health `p0/identity-only/membershipCheck=enforce`; old `/api/ingest` and `/api/user-target` 404; Directory columns added; apply log `c92c663d…` (row 0002: staff id removed, guest bound, `Dokumenty księgowe`); no TEST row exists; `ANTHROPIC_ENABLED=true` 14:06:03Z |
| Channel inbox: build deployed (sweep off), canary Team BCR Kanarek, shadow → enforce for the canary row | Yahor | done | 2026-09-26 | deployed 15:14Z (ingestion, `inboxSweep` timer) and 15:15Z (bot, new help card); canary Team private, canary guest in it alone, write grant `granted`, Directory row 10 bound; shadow 17:01Z → `inbox.would_move` for the guest's post (createdBy is the guest: confirmed); enforce 17:11Z → moved 17:14Z to `98_Nieposortowane` (`nameSuffix` 0); same file posted again → moved 17:26Z as `_1` (`nameSuffix` 1): a move never overwrites. PESKOVOI in `shadow` from 17:42:04Z (Yahor's choice: enforce at launch), `INBOX_CREATED_AFTER` = that time so its older files stay put; first two-row tick 17:46Z clean (`rowsFailed` 0). The canary row is in `shadow` too (one switch for all rows) |
| Classification release (point 1): claude-opus-5, threshold 0.70, retry-later, long-PDF trimming, per-file logs | Yahor | done; re-test passed | 2026-09-26 | deployed 20:16Z, model + threshold set 20:17:46Z (live drift check clean). Re-test on the 43 test documents, canary row with BCR GROUP's identity: 41 filed, all correct; 2 sent to review correctly (direction unknown; low confidence); months 31/31; invoice direction all correct; 0 retry-later. First test (old model, no identity): 36/43. Reports local in `tools/out/evaluations/` |
| Document index release (point 2): database, migrations, ingestion login, settings with the index `off` | Yahor | steps 2–7 done; step 1 (evaluation), step 8 (`write`) and step 9 (canary) wait for Anthropic credit | 2026-09-27 | The point-2 build was deployed 09:49:47Z for its re-test, which classified nothing: BCR's Anthropic credit balance is exhausted (API 400 on every call, whichever build). Rolled back 09:56:26Z to `document-ingestion-p1-20260927T094915Z.zip`, then `a915670` deployed 10:05:57Z: a credit refusal is now retry-later, so documents wait and none is sorted to `98_`. Both sweep rows are in `shadow`, so nothing is filed with the new prompt before its evaluation. Key Vault is back on BCR's key. Server `psql-bcr-dev-vyyintffz6ehq` created 2026-09-27 (B1ms, PostgreSQL 16, Entra only, password off, 7 days, geo `Enabled`, one rule `0.0.0.0`); `0001_ledger_core` applied; the ingestion identity's login (not admin) holds `ledger_app` with INHERIT FALSE; `verify.sql` 0 rows; settings recorded in `6f99ced` and set 10:46Z with `LEDGER_INDEX_MODE=off` (drift check clean, `index.config` `off`); operator firewall rule removed |
| BCR's Anthropic credit used up by the shadow sweep: cause, containment, fix | Yahor | contained; fix `7a6dadd` deployed 16:15:35Z | 2026-09-27 | Cause: shadow remembered its reports per worker only, so every worker restart (1–5 an hour) classified the canary's 43 test documents again, and before the point-1 build (20:16Z) every tick did: about 2,700 `inbox.would_move` 18:00–24:00Z on 26 September against the 86 the two re-tests needed; first credit refusal 00:01:15Z. Our defect, not usage. Containment 10:52:40Z: canary row out of `INBOX_SWEEP_ROWS` (`1e8ffca`, drift check clean); PESKOVOI stays in `shadow` (no files after its cutoff). Fix: shadow memo in the ingestion storage account (a version is classified once per classifier release, across restarts; unreadable memo = wait, never a paid call) and a 15-minute pause after a credit or 401–404 refusal. Deployed from `61aa7be`: zip `41780c20…` (the running package's hash matches), triggers synced; previous build saved as `document-ingestion-p2-20260927T161438Z.zip` (`e3b1d68e…`). Cold start: `inbox.sweep_mode` `shadow`, `shadowMemo` `table`, rows `["2"]`; `classification.config` release `a9b9731f2a8bbe91|0.7`; first tick clean. The memo table is first used at the next re-test (PESKOVOI has no files after its cutoff). Top-up: auto-reload off, so the balance is the cap |
| Classifier cost release: cached prompt, 5-page PDF excerpts, no `reasoning`, token logging, `ANTHROPIC_EFFORT`/`ANTHROPIC_THINKING`; Sonnet 5 test | Yahor | done; `claude-sonnet-5` live | 2026-09-27 | `73cfbb7` deployed 17:06:36Z (zip `e3e43ac7…`, running hash matches; previous build saved as `document-ingestion-p3-20260927T170554Z.zip`, `41780c20…`). Settings `ANTHROPIC_EFFORT=low`, `ANTHROPIC_THINKING=adaptive`, `ANTHROPIC_MODEL=claude-sonnet-5`, canary row in, set 17:09:17Z (`8fcdecf`, drift check clean); canary row out 17:15:52Z (`6dc3b90`). Sonnet 5 on the 43 test documents, production key in Key Vault, shadow: 43 calls, one per document, no retry; category 41/43 (95.3%, bar 95%), months 31/31, direction right on every invoice where the client is a party; 1 to review with the right suggestion (the hotel bill made out to a person, as Opus); 2 filed in a neighbouring category (a GDPR notice as `korespondencja` at 0.70, which Opus sent to review; an accounting-services contract as `onboarding_reguly` at 0.90, which Opus filed as `umowy`). Cost $0.61, $0.014 per document (the same tokens at Opus 5 prices: $1.53); 42 of 43 calls read the cached prompt (about 4,700 tokens); output median 250 tokens |
| Rule: the client's contract with the accounting office is `onboarding_reguly` (Yahor's decision) | Yahor | done | 2026-09-27 | `d1d3906` deployed 17:48:04Z (zip `f107344d…`, running hash matches; previous saved as `document-ingestion-p4-20260927T174726Z.zip`). Re-test, Sonnet 5, canary row in 17:49:00Z, out after: 43 calls; 41 filed right (the accounting contract now `onboarding_reguly` at 0.97; the two registration contracts stay `umowy`), 2 to review (the hotel bill; the GDPR notice at 0.60, no longer filed), 0 in a wrong category, months 31/31; cost $0.61 (42 of 43 calls read the cached prompt) |
| Document index release steps 8–9: index `write`, canary | Yahor | done | 2026-09-28 | `LEDGER_INDEX_MODE=write`, sweep `enforce` on the canary row only and `INBOX_CREATED_AFTER=2026-09-28T11:10:29Z` (new uploads only), set 11:10:58Z (`8e0632d`, drift check clean). A staff member's post in the canary channel: `inbox.skipped` `not_guest`, left in place. The canary guest's synthetic invoice: `inbox.filed` 11:38:07Z `faktury_zakupu` 2026-09, 0.90, Sonnet 5; `index.written` `created` `true`, 10 invoice fields, FILED. Admin check (rolled back): 0 rows without a scope; one client row (10, active); the document `inbox`/`FILED` with number, gross, seller NIP and issue date. Operator rules removed |
| Paid-classification bound (enforce) and review notices; CI repaired | Yahor | deployed; notices off until the chat's webhook exists | 2026-09-28 | `8043d88`: CI had failed at `setup-node` since 26 September (runner yarn 1.22 vs `packageManager` yarn@4.3.1); Corepack now first. `d898a84`: migration `0002_review_notices` applied first (11:48Z, `verify.sql: no problems`; the first attempt timed out on connect right after the firewall rule), then deployed 11:52:44Z (zip `f3ef7894…`, running hash matches; previous saved as `document-ingestion-p5-20260928T115119Z.zip`, `f107344d…`); `reviewNotify` found and scheduled; `review_notice.config` `off` `no_webhook` |
| PESKOVOI in `enforce`, new uploads only (Yahor's decision; Roman tells the client) | Yahor | done | 2026-09-28 | `INBOX_SWEEP_ROWS=10,2` 11:58:09Z (`9f1cba9`, drift check clean). First two-row tick 12:02Z: 131 older files untouched (the cutoff), 1 staff file skipped, `rowsFailed` 0 |
| Client search release step 1: `Documents.Search` for the bot Function App's managed identity | Yahor (Global Admin) | done | 2026-09-28 15:42Z | `grant-bot-search-caller.sh --apply` with the operator's `az` Graph token: the role added to the Ingestion API registration (Applications only, `Documents.Ingest` kept) and assigned to the bot's system-assigned identity (app id `28157eb1-…`, the value `SEARCH_CALLER_APP_IDS` takes at step 6; both parameter files still hold `""`). Checked at 15:42Z with `az ad app show` and the API's `appRoleAssignedTo` (`Documents.Search` held only by the bot's identity); step 1's Verify dry run at 17:53Z: already assigned, nothing to do, `SEARCH_CALLER_APP_IDS=28157eb1-…`. The bot's search goes on no earlier than 15:42Z on 29 September (the identity's token cache) |
| Client search release step 2: the question reader's evaluation | Yahor | GO | 2026-09-28 18:37Z | `eval:search` with BCR's key from ingestion's `local.settings.json` (hash-equal to Key Vault's; `.env` holds another key and was not used). First run 18:31Z: every call refused (400, the output schema had 18 union-typed parameters, the API's limit is 16), nothing billed: search would have been `unavailable` for good. Fixed (groups always present, `structuredOutput.test.ts` counts every schema) and two prompt rules (invoice direction for „od”/„dla”; an example that taught dropping categories): 42/42 exact, 0 invented on the 12 injection cases, 0 keys outside the schema, prompt 4,147 tokens (`tools/out/search-eval-20260928T183747Z.md`, `45b40f26…`). About $0.30 of credit for three runs |
| Client search release step 3: migration `0003_search_queries` | Yahor (Entra admin) | done | 2026-09-28 18:42:34Z | Applied from `7069856` with a dated operator rule (`operator-20260928T1840`, deleted right after; one rule left, the Azure-services one): `applied 1, already applied 2`, `verify.sql: no problems` (its first run with `guard_trigger_missing` and `app_role_can_delete`) |
| Client search release steps 4–5: ingestion and bot builds, search off | Yahor | done | 2026-09-28 18:46:43Z / 18:50:53Z | Ingestion: previous package saved as `document-ingestion-p6-20260928T184416Z.zip` (`f3ef7894…`), deployed zip `10bf0709…` (running hash matches), triggers synced: five functions incl. `clientSearch`; `/api/health` `search: off`, everything else unchanged; `POST /api/search` without a token 401; `search.config` `off` `mode_off`; inbox ticks after it `failed 0`, `rowsFailed 0`; notices `on`. Bot: previous package saved as `teams-bot-p1-20260928T184416Z.zip` (`19662ceb…`), deployed zip `0e008e53…` (running hash matches): channel tokens only (`bot/channelAuth.ts`), gate `enforce`, `search.config` `off`. `SEARCH_MODE=off` set on both (matches the parameter file); `--live` shows only `SEARCH_ROWS` and `SEARCH_CALLER_APP_IDS` still to add (step 6). Verified 19:18:44Z: the canary guest's `pomoc` from Teams passed the channel-token check (`messages` 200) and got the help card without „Wyszukiwanie”; the only refusal logged (18:52:08Z, 500) was the operator's own unauthenticated probe |
| Client search release steps 6–8: search on for the canary row, then in the bot; canary | Yahor | done (PESKOVOI, step 9, waits for the owner's go) | 2026-09-29 11:44:39Z / 11:54:33Z / 12:07–12:08Z | Ingestion `SEARCH_MODE=on`, `SEARCH_ROWS=10`, `SEARCH_CALLER_APP_IDS` = the bot identity's app id (`15d3475`); `/api/health` `search: listed`, `search.config` `on`, rows `["10"]`, prompt `9e6d5555c9ed4b2c`. The bot's `SEARCH_MODE=on` (`62a1b6e`) about 20 h after the grant: the bot identity had never asked for an ingestion token, so its first one carried the role (no 403, no `ingestion.caller.rejected`). Canary, as the canary client account (the guest has no capability since the client identity release): „faktury z września” → categories + September, 2 results; „dokumenty do weryfikacji” → `status`, 2 results; „Zmień filtr” with a category and in review → the categories dropped with the `categories_in_review` note, 2 results. `--live` clean after each setting |
| Client lockout: T-1 reversed, the three `{NIP}@` accounts, `AuthoriseMe@` and `BCROnboarding@` enabled ([Client lockout](#client-lockout-2628-september-t-1-reversed)) | Roman | done | 2026-09-28 17:33:38Z–17:34:32Z | Entra audit log (read-only). Clients locked out 26 Sep 12:18:09Z → 28 Sep about 17:34Z; no PESKOVOI upload in the channel inbox since row 2's filing began (28 Sep 11:58Z); no document lost |
| Owner's decision: the `{NIP}@bcr-group.pl` Member account is the client identity; guests have no ledger capability; never block, disable, unlicense or convert a `{NIP}@` account | Yahor (owner) | decided; T-1, T-2 withdrawn and T-7 made a read-only record in [`tenant-hardening.md`](tenant-hardening.md) | 2026-09-28 | [Client lockout](#client-lockout-2628-september-t-1-reversed) |
| 0002's new password, sent over Telegram in plain text on 28 Sep 07:34Z: the client changes it | Roman | todo: not changed at 29 Sep 18:10Z (Entra's last password change is still 28 Sep 07:34:26Z; the account is enabled). Only the canary account's password was changed, 29 Sep 10:41:10Z | | the date it was changed (no password, no address) |
| IR-3: the lockout as an availability event for 0002, 0003 and 0004: does it need its own view in the breach register? | IOD | todo: open question | | the IOD's answer |
| Client identity release: ledger code committed, CI green; onboarding change merged; rows 2 and 10 re-bound; ingestion, then the bot, deployed; manifest 0.2.2; canaries ([`human-steps.md`](human-steps.md#client-identity-release)) | Yahor; the Teams admin for the manifest | done 29 Sep (manifest 0.2.2 upload and the onboarding deploy open) | 2026-09-29 10:58–11:40Z | the commit; the apply log's hash; the saved `document-ingestion-p7-*` and `teams-bot-p2-*` packages' sha256 and the deployed zips'; `/api/health` `clientIdentity` `nip-member`; each canary's times |
| Alerts: the ingestion build that logs the watched states on every run, then the action group and eight rules ([`human-steps.md`](human-steps.md#alerts)) | Yahor | deployed; the address's one-time code and the step 6 *Fired* email: waiting for Yahor to confirm | 2026-09-29 17:46:37Z / 17:52:54Z | `7515332`. Ingestion: previous package saved as `document-ingestion-p8-20260929T174556Z.zip` (`fc83c0bc…`), deployed zip `01fea602…` (running hash equal), markers `skippedMembership` and `review_notice.off` present, `/api/health` `build` unchanged, first tick with `membershipCheck` `enforce` 17:50:01Z (`skippedNotClientAccount` 0, `skippedMembership` 0). Alerts: what-if nine `Create`, clean; `--apply` 17:51:59–17:52:54Z; eight rules enabled (15 min); the email receiver `Enabled`. Step 6: the bot answered a no-token POST with `500` at 17:53:17Z, `adapter.processActivityDirect threw` (level 50) at 17:53:24Z |
| H-13: ingestion grant on BCR GROUP downgraded to `read` | Yahor (Global Admin) | done | 2026-09-26 | Graph Explorer PATCH → `roles: ["read"]` for the ingestion managed identity. The only other application entry is the onboarding Function App (`write`), which writes the Client Directory rows: kept |
| H-14: `FALLBACK_*` settings removed, pre-Phase-0 packages deleted | Yahor | done (early, by Yahor's decision) | 2026-09-26 18:10:32Z | all five `FALLBACK_*` deleted; `*-before-p0.zip` removed; health OK |
| IR-2 relocation complete, allow-lists issued | Roman + second person | todo | | |
| IR-3: phase-2 notices to every affected client | Roman + IOD | todo | | |
| IR-3 (3): UODO decision for BCR-controlled data recorded | Roman + IOD | todo | | |
| H-12 channel-inbox step: build deployed; canary Team and row; canary `shadow`, then `enforce`; same-name `_1`; what the moved attachment's post showed | Yahor | done 26 Sep: recorded in the row "Channel inbox: build deployed …" (this row duplicated it); open: one click on the canary's moved post, to see whether its attachment still opens | 2026-09-26 | sha256 of the `*-p0-<stamp>.zip` packages saved; the canary row's list item id; times of the canary's `inbox.filed` and of its `nameSuffix` `1`; whether the post's attachment still opened; `check \| grep -ci <canary id>` `0` after clean-up |
| H-12 channel-inbox step: PESKOVOI's older channel attachments (all moved, or kept with `INBOX_CREATED_AFTER`), and what the client was told | Yahor, on the owner's instruction | done: kept in place with `INBOX_CREATED_AFTER=2026-09-28T11:10:29Z` ("do not touch existing documents and their location in SharePoint, only new uploads"); nothing is written to the client, Roman tells him. `INBOX_SWEEP_ROWS` stays `10,2`: it lists the swept rows | 2026-09-28 | the decision; the cutoff time, if any; PESKOVOI's `shadow` count and first `inbox.filed` time; `INBOX_SWEEP_ROWS` removed |
| H-12/H-15: bot-path proofs dropped, because no guest can send a file through the bot: (1) a TEST canary routed with `membership: verified` (H-12 step 7; the R46 exit criterion), (2) a same-name bot upload stored as `_1`. Replaced by the channel-inbox canary: its guest and Team read (H-8b's grant in the token) and its same-name move `_1` | Roman accepts; from 29 Sep Yahor (the proofs) | done 29 Sep, by the canary client account in the 1:1 chat: (1) `routed to client via userAadObjectId`, `account` and `membership` `verified`, 11:33:01Z, filed `faktury_zakupu` 11:33:07Z; (2) the same synthetic invoice sent again, `uploaded to SharePoint` with `nameSuffix` `1` at 12:18:41Z | 2026-09-29 | the times of the canary account's `routed to client via userAadObjectId` (`account: verified`, `membership: verified`) and of its same-name upload's `nameSuffix` `1` ([Client identity release](human-steps.md#client-identity-release), the canaries) |
| H-15: Phase-0 exit criteria signed off | Yahor, Roman | todo | | |
| Standing checks: whole plan applied after each onboarding; weekly `check` (exit `5`: a client is locked out, call Roman at once); a read-only look at the `{NIP}@` accounts (enabled, licensed, one Team) | Yahor | from H-12; the `5` and the account look from 29 Sep | | date of each run; apply-log hash ([`human-steps.md`](human-steps.md#standing-checks)) |

## What this changes permanently

The Phase-0 code carries regression tests for the rules this incident broke, and the plan's
isolation invariants make them permanent: content never changes the client (I2), ambiguity goes
to quarantine and never to a guess (I3), nothing identifies the user from a request body (I6),
nothing shows another client's URL, name or file name (I7), and uploads never overwrite (I8).
The ledger's `CLAUDE.md` is rewritten in the same change as the promotion removal, so that no
future change restores it.

The client lockout adds one more (28 September): nothing in either repo acts on whether an
account may sign in, or changes it (a disabled client account is reported, never acted on), and
nobody blocks, disables, unlicenses or converts a client's `{NIP}@` account. How clients sign in
is confirmed with the owner before any tenant change that depends on it.
