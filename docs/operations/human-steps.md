# Human steps

Written for the people who hold the roles the code cannot hold: Roman (business owner and
subscription Owner), the Global Admin, the SharePoint Administrator, the Teams Administrator,
and Yahor (developer and operator). Every step names who runs it, the exact command, how to see
that it worked, and how to undo it.

The steps are in the order they must happen. Some wait on the previous step for a reason, and
that reason is given. Skipping ahead is how an upload gets rejected, or filed in the wrong place.

**Run every command in bash** (`bash -l`). In zsh, the macOS default, run
`setopt interactivecomments` first. Without it, an interactive zsh does not treat `#` as the start
of a comment: a pasted comment becomes a command, the variable set on the same line stays empty,
or an apostrophe in the comment opens a quote that swallows the lines after it. For the same
reason every comment in the blocks below sits on its own line.

Today (25 September 2026) only Phase 0 is here. Later phases add their own sections.

---

## Phase 0

Phase 0 contains incident [`IR-2026-09`](incident-2026-09.md) on today's code, without the
database. The containment has three strands, and this checklist puts them in one timeline:

- the tenant steps in [`tenant-hardening.md`](tenant-hardening.md);
- the incident response (IR-0 to IR-3) in the incident doc;
- the code deploys.

### Standing rules for the whole phase

- ⚠️ **Deploy code only: never Bicep.** Do not run `infrastructure/deploy.sh`, `yarn deploy:*`,
  or the *Deploy* GitHub workflow. All three deploy `main.bicep` first. Its app settings have
  drifted from what is running, and a Bicep deploy replaces every setting, which takes
  ingestion down at cold start. Phase-0 deploys are zip deploys ([H-9](#h-9-deploy-the-bot-with-the-gate-in-log-mode),
  [H-12](#h-12-the-change-window-ingestion-deploy-bindings-canaries)), and settings are added with
  `az functionapp config appsettings set`, which merges rather than replaces.
- ⚠️ **Never roll ingestion back to a pre-Phase-0 build.** That build contains content promotion,
  the cross-client write path. A rollback reverts individual commits and is deployed as a new
  build. For an emergency there is a stop switch that files nothing anywhere
  ([H-12](#h-12-the-change-window-ingestion-deploy-bindings-canaries)).
- **Yahor does not upload through the bot** until the full implementation is done. His id stays
  on PESKOVOI's Directory row until the binding tool removes it in H-12.
- **Secret rotation is deferred** until Roman provides new credentials. It is an accepted risk
  ([`docs/security.md`](../security.md#accepted-risks)), and nothing in this phase rotates or
  scripts it.
- **Canaries are synthetic.** Every test upload is a generated document with no real data. Never
  use a real client document.
- **Commands print no secrets.** `az functionapp config appsettings set` prints every setting,
  including the storage account key, unless you pass `-o none`. Always pass it.
- **Change freeze.** The 1st–10th of the month is month-end closing. Aim to finish H-12 by
  **30 September**. If it slips into October, Roman decides whether to run it during the freeze.

### Variables used below

```bash
# "dev" is production: it serves PESKOVOI.
RG=rg-bcr-ledger-dev
# The names are in PROJECT_OVERVIEW.md → Azure environment.
BOT=func-bcr-bot-dev-<suffix>
INGEST=func-bcr-ingest-dev-<suffix>
APPI=appi-bcr-dev-<suffix>
SP_HOST=<tenant>.sharepoint.com
BOT_APP_ID=$(az functionapp config appsettings list -g $RG -n $BOT \
  --query "[?name=='MICROSOFT_APP_ID'].value | [0]" -o tsv)
# The managed identity of the ingestion Function App, as an application id. Ingestion calls
# Graph only as this identity, so every SharePoint grant and every grant check below uses it,
# never the client id of the ingestion API app registration (INGESTION_APP_ID in the setup guide).
INGEST_MI_APPID=$(az ad sp show --id "$(az functionapp identity show -g $RG -n $INGEST \
  --query principalId -o tsv)" --query appId -o tsv)

# App Insights: ALWAYS pass both times. With only a start, the CLI queries one hour.
aiq() { az monitor app-insights query -g $RG --app $APPI --analytics-query "$1" \
  --start-time "$2" --end-time "$(date -u +%Y-%m-%dT%H:%M:%SZ)" -o table; }
```

Graph and SharePoint tokens are set up as described in
[`tenant-hardening.md` → Tokens](tenant-hardening.md#tokens).

### At a glance

| # | Step | Owner | When | Waits for |
|---|---|---|---|---|
| H-0 | Automatic deploys stopped | Yahor | done, 25 Sep | — |
| H-1 | GDPR: processor notice and breach register | Roman + IOD | by 26–28 Sep | — |
| H-2 | IR-0: evidence export, stored immutably | Yahor, Global Admin, Roman | today | — |
| H-3 | **Mandatory:** stop promotion with a setting | Yahor | as soon as H-2 is stored; H-5, H-6 and H-6b follow **the same working day** ([the bound](#h-3-stop-promotion-now-without-a-deploy)) | H-2 |
| H-4 | Tenant hardening T-1 to T-9, T-4b included | per step | today–tomorrow | T-4, T-4b, T-5 before H-12; T-4 the day of H-3, checked again after H-6b; T-4b after H-3 is verified, before IR-2; T-1 before H-10 |
| H-5 | Quarantine site | SharePoint Admin | the working day of H-3 | — |
| H-6 | Ingestion identity write grant on quarantine | Global Admin | the working day of H-3 | H-5 |
| H-6b | Running build's fallback re-pointed at the quarantine | Yahor | the working day of H-3 | H-3, H-6 verified |
| H-7 | Directory check and new columns (no new site grants) | Yahor | day 1 | H-2 (IR-0 C stored), T-5 |
| H-8 | New app settings, added | Yahor | day 1 | H-5 |
| H-9 | Bot deploy, gate in `log` | Yahor | day 1 | H-2, H-8 |
| H-10 | Manifest 0.2.0, availability *Everyone* | Teams Admin | day 1 | H-9, T-1 |
| H-11 | Gate to `enforce` | Yahor | day 2 | 24 h of clean logs |
| H-12 | Change window: ingestion, further site grants, bindings, canaries | Yahor, Roman reviews | day 2–3 | H-6, H-6b, H-7, H-11, T-4, T-4b, T-5 |
| H-13 | Ingestion grant on BCR GROUP to `read` | Global Admin | after H-12 | H-12 verified |
| H-14 | `FALLBACK_*` settings and saved pre-Phase-0 packages removed | Yahor | ≥ 24 h after H-12 | H-12 verified |
| H-15 | Exit criteria checked | Yahor, Roman | end of phase | all |
| — | [Standing checks](#standing-checks): whole plan after each onboarding, weekly `check`, daily quarantine query | Yahor | from H-12 on | H-12 |

IR-1 (inventory) and IR-2 (relocation) run alongside, from the day H-2 is stored. They are
described in the incident doc. IR-1 takes the plan H-7 writes. Once T-4 and T-4b have locked
the folders, IR-1 runs with the token of an Owner or site collection admin of every site it
walks, and with `--expect-root-folders`, because a locked folder is invisible to anyone else
([incident → IR-1](incident-2026-09.md#ir-1-inventory)). IR-2 moves nothing on a site before
that site's folders are locked (T-4, T-4b).

---

### H-0: Automatic deploys stopped

**Owner:** Yahor. **Status:** done, commit `f5a2bd4` (gate G0).

A push to `main` used to deploy Bicep and both apps to "dev", which serves PESKOVOI. Because the
template has drifted from what is running, one merge would have taken ingestion down.

**Verify.** `grep -n 'push' .github/workflows/deploy.yml` shows only the comment explaining why
there is no push trigger. **Rollback.** None. The trigger comes back only after the Bicep drift
fix (gate G1).

### H-1: Start the GDPR notices (IR-3, day 0)

**Owner:** Roman, with the IOD or lawyer. **When:** now. Awareness arguably began with the 23–25
September audit, so the 72-hour window may close around **26–28 September**.

1. Send the phase-1 processor notice to PESKOVOI now, and to each further client as IR-1 finds
   them. Template: [`gdpr/processor-notice-2026-09.pl.md`](gdpr/processor-notice-2026-09.pl.md).
   The IOD or lawyer confirms the wording first. Check the *umowa powierzenia* for a shorter
   deadline or a required form.
2. Write the entry in BCR's breach register today. Template:
   [`gdpr/breach-register-entry-2026-09.md`](gdpr/breach-register-entry-2026-09.md).

**Verify.** The send date and recipient of each notice, and the register entry's id, are in the
incident's status table. **Rollback.** None. A later phase corrects or adds to a notice; it
never withdraws one.

### H-2: Preserve the evidence (IR-0), before anything changes the logs

**Owner:** Roman (creates the store, as subscription Owner), Yahor (trace and Directory
exports), Global Admin (Purview export and the Entra sign-in log). **When:** today. App Insights
keeps 30 days, and each day of delay deletes a day of evidence. This must also happen **before
H-9 and H-12**, because the Phase-0 code changes what is logged.

What to export, and why each join works, is in
[incident → IR-0](incident-2026-09.md#ir-0-preserve-the-evidence-first). Every script is
described, with all its flags, in [`tools/README.md`](../../tools/README.md).

**1. The trace export (Yahor).** 24-hour chunks over the last 30 days. It writes the files, the
query, `export-meta.txt` and `SHA256SUMS` under `tools/out/` (git-ignored). `--all-traces` also
keeps every trace unfiltered, from both apps (they share the component). The script always
exports the `requests` rows for `/api/mydocs` and `/api/user-target`: the only record of who
used the Personal Tab lookup (W5), which Purview cannot see.

```bash
tools/ir0/export-appinsights.sh --app <App Insights component> --resource-group rg-bcr-ledger-dev --all-traces
```

**2. The Purview export (Global Admin, PowerShell 7, "View-Only Audit Logs" role).** Sites: BCR
GROUP, PESKOVOI, TEST. The file operations include moves, copies, renames and deletions: the
ingestion never moved or copied a file, so every such event is a person's. `-SignInUpn` adds the
unified audit log's sign-in events (`UserLoggedIn`, `UserLoginFailed`, kept about 180 days
**[verify]**) for the three `{NIP}@` accounts and `AuthoriseMe@`. They are the evidence for W2 and
W3.

**Start date: `2026-03-01T00:00:00Z`, as below, not go-live and not the README's example.** W2
and W3 opened on dates nobody knows, and Audit Standard keeps only about 180 days, so the export
must reach back past the oldest event the log still holds. A start before that is harmless: the
service returns what it has. Anything left out now ages out for good.

```powershell
Connect-ExchangeOnline -UserPrincipalName <auditor>
./tools/ir0/export-purview.ps1 -SiteUrl <BCR GROUP url>, <PESKOVOI url>, <TEST url> -StartDate 2026-03-01T00:00:00Z `
  -FileOperations FileUploaded, FileAccessed, FilePreviewed, FileDownloaded, FileSyncDownloadedFull, `
    FileSyncDownloadedPartial, FileModified, FileMoved, FileCopied, FileRenamed, FileDeleted, `
    FileRecycled, FileDeletedFirstStageRecycleBin, FileDeletedSecondStageRecycleBin `
  -SignInUpn <nip-1>@bcr-group.pl, <nip-2>@bcr-group.pl, <nip-3>@bcr-group.pl, AuthoriseMe@bcr-group.pl
```

**3. The Entra sign-in log (Global Admin), today.** Without Entra ID P1 the portal keeps only
about 7 days of sign-ins **[verify]**, and Graph will not return them, so this is a manual
download before that window moves on. In the Entra admin centre: **Monitoring & health →
Sign-in logs**, date **Last 7 days**, filter **User** to each of the four accounts above. Download
**CSV** from both the *User sign-ins (interactive)* and *(non-interactive)* tabs into
`tools/out/ir0-entra-signins-<UTC>/`, then `shasum -a 256 *.csv > SHA256SUMS` in that folder.

**4. The Directory as it stood, IR-0 C (Yahor), before any Directory change** (the H-7 status
edit, `--add-columns`, H-12). Every row, Active or not, with all its fields and its version
history. `g` and `G` are set as in [`tenant-hardening.md` → Tokens](tenant-hardening.md#tokens);
the token needs `Sites.Read.All`, and after T-5 the reader must be a BCR GROUP site owner.

```bash
DIR_SITE=$(az functionapp config appsettings list -g $RG -n $INGEST \
  --query "[?name=='CLIENT_DIRECTORY_SITE_ID'].value | [0]" -o tsv)
DIR_LIST=$(az functionapp config appsettings list -g $RG -n $INGEST \
  --query "[?name=='CLIENT_DIRECTORY_LIST_ID'].value | [0]" -o tsv)
C=tools/out/ir0-directory-$(date -u +%Y%m%dT%H%M%SZ); mkdir -p -m 700 "$C"
url="$G/sites/$DIR_SITE/lists/$DIR_LIST/items?expand=fields&\$top=999"; n=0
# Follow @odata.nextLink until the last page.
while [ -n "$url" ]; do
  g "$url" > "$C/items-$n.json"
  url=$(jq -r '."@odata.nextLink" // empty' "$C/items-$n.json"); n=$((n+1))
done
for id in $(jq -r '.value[].id' "$C"/items-*.json); do
  g "$G/sites/$DIR_SITE/lists/$DIR_LIST/items/$id/versions?\$expand=fields" > "$C/versions-$id.json"
done
chmod 600 "$C"/*.json
# Must print nothing.
grep -l '"error"' "$C"/*.json
(cd "$C" && shasum -a 256 *.json > SHA256SUMS)
```

**[verify]** that the version files carry each version's `fields`. If they do not, fetch
`…/items/{id}/versions/{versionId}/fields` for each version into the same folder.

**5. The store (Roman):** an immutable container outside BCR GROUP, readable by Roman, the IOD
and yahor.simak@bcr-group.pl only. A dry run first; `--apply` refuses until both UPNs are set.
Run it once per export folder from steps 1–4 (`--upload-dir` takes one folder).

```bash
ROMAN_UPN=<roman> IOD_UPN=<iod> infrastructure/ir/evidence-store.sh \
  --resource-group rg-bcr-ir-evidence --account <storage account> \
  --upload-dir tools/out/<export folder> --grant-uploader
ROMAN_UPN=<roman> IOD_UPN=<iod> infrastructure/ir/evidence-store.sh \
  --resource-group rg-bcr-ir-evidence --account <storage account> \
  --upload-dir tools/out/<export folder> --grant-uploader --apply
```

**6. Take the uploader's write access away again (Roman),** once every upload is in and
checked. `--grant-uploader` gave the signed-in operator *Storage Blob Data Contributor* on the
container, which also reads; nothing in the script removes it. A later upload (H-6b, IR-1)
grants it again and ends with this step again.

```bash
SCOPE=$(az storage account show -g rg-bcr-ir-evidence -n <storage account> --query id -o tsv)/blobServices/default/containers/ir0-evidence
az role assignment delete --assignee "$(az ad signed-in-user show --query id -o tsv)" \
  --role "Storage Blob Data Contributor" --scope "$SCOPE"
```

If Azure refuses with `ScopeLocked`, the account's CanNotDelete lock is in the way **[verify]**.
Lift it, delete the assignment, and put the same lock back at once:

```bash
LOCK=(--name ir0-evidence-nodelete -g rg-bcr-ir-evidence --resource-name <storage account> \
  --resource-type Microsoft.Storage/storageAccounts)
az lock delete "${LOCK[@]}"
az role assignment delete --assignee "$(az ad signed-in-user show --query id -o tsv)" \
  --role "Storage Blob Data Contributor" --scope "$SCOPE"
az lock create "${LOCK[@]}" --lock-type CanNotDelete --notes "IR-0 evidence: do not delete"
```

**Verify.**

- The container lists every export (steps 1–4) plus each folder's `SHA256SUMS`.
- `az role assignment list --scope "$SCOPE" -o table` shows Storage Blob Data Reader for exactly
  three principals, and no Storage Blob Data Contributor: write access for nobody once the
  upload is done.
- The CanNotDelete lock is back: `az lock list -g rg-bcr-ir-evidence -o table`.
- The immutability policy shows the retention date the IOD set.
- The laptop copies are deleted, and their hashes are in the incident's status table. IR-1
  needs the trace export on disk: it downloads it back from the store first and deletes it again
  afterwards ([incident → IR-1](incident-2026-09.md#ir-1-inventory)). Do not run IR-1 without
  it.

**Rollback.** None, on purpose: the evidence is immutable. If the retention period is wrong,
the IOD sets the right one before the policy is locked.

### H-3: Stop promotion now, without a deploy

**Owner:** Yahor runs it; Roman is told. **When:** as soon as H-2 is stored, because IR-0 is
copied before anything changes what the running build logs. **Mandatory.**

Until H-12 the running ingestion is the pre-Phase-0 build, and it still has content promotion
(root cause R3): an upload it cannot route is filed into whichever client's NIP the document
names. Promotion needs the `parties[]` that only the Claude classifier extracts. With
`ANTHROPIC_ENABLED=false`, the running ingestion uses only the deterministic fallback classifier.
That classifier extracts no parties, so **nothing can be promoted into a client's site**, and no
document content leaves Azure.

The cost is real, and accepted: every new upload is filed under `98_Nieposortowane/YYYY/MM/` for
an accountant to sort, and uploads that promotion used to put in their own client's site (a
PESKOVOI invoice sent by PESKOVOI's guest, say) now stay in the fallback target. H-6b points that
target at the staff-only quarantine, so they wait there and not in BCR GROUP.

```bash
az functionapp config appsettings set -g $RG -n $INGEST --settings ANTHROPIC_ENABLED=false -o none
```

**The gap until H-6b has a bound.** From H-3 until H-6b, the fallback target is still the BCR
GROUP library root, so every upload the running build cannot route is written there, under
`98_Nieposortowane/YYYY/MM/`. Keep the order, because promotion is the cross-client path and
stopping it first is worth these interim writes. But H-5, H-6 and H-6b follow H-3 **the same
working day**, and T-4 runs that day too: it locks `98_Nieposortowane` at that root to Owners,
creating it empty first if it is missing, so the interim writes land in a folder only the
Owners can read. If they cannot all happen that day, Roman decides, and the decision goes in the
incident's status table:

- either accept the interim writes into BCR GROUP's `98_Nieposortowane`, locked by T-4 (T-4 is
  checked again after H-6b, in case the build created another folder after the lock);
- or stop ingestion until H-6b with the emergency stop,
  `az functionapp stop -g $RG -n $INGEST`. Nothing is filed anywhere, and users get the bot's
  generic error. `az functionapp start -g $RG -n $INGEST` once H-6b is verified.

**Verify.** `az functionapp config appsettings list -g $RG -n $INGEST --query "[?name=='ANTHROPIC_ENABLED']" -o table`
reads `false`. After the restart, `aiq 'traces | where tostring(parse_json(message).msg) == "promoted fallback → directory client via content NIP match"' <time of the change>`
stays empty.

**Rollback.** None while the pre-Phase-0 build runs. H-12 step 11 sets it back to `true` once
the Phase-0 build, which has no promotion, is live.

### H-4: Tenant hardening

**Owner:** per step. **When:** today and tomorrow. Run T-1 to T-9 from
[`tenant-hardening.md`](tenant-hardening.md), T-4b included. T-10 comes with H-10.

These must be done before H-12:

- **T-4** (lock the ledger folders at the BCR GROUP root), because IR-2 needs the fallback
  documents to stay put and unread until they are moved. Run it the day of H-3, creating
  `98_Nieposortowane` empty first if it is missing, and **check it again after H-6b**: until
  H-6b re-points the fallback, the running build can create a taxonomy folder at that root, and
  a folder created after the lock is not locked;
- **T-4b** (lock the same folders at the library root of PESKOVOI, TEST and any site IR-1
  lists), **after H-3 is verified, today or tomorrow, and before IR-2 starts**, for the same
  reason, and because there the audience is another client's guest. Until H-3 is in effect,
  promotion can still create a taxonomy folder at a client's library root that the lock did not
  cover. With the item-by-item locks its Verify adds once IR-1 has run for the site, it closes
  W4 for documents already promoted;
- **T-5** (lock and version the Client Directory), because H-7 and H-12 edit the list, and
  versioning is the record of those edits. So T-5 also comes **before H-7**.

**T-1** (block sign-in on the `{NIP}@` addresses) must be done before H-10: T-10 makes the bot
available to *Everyone* on the grounds that those accounts can no longer sign in.

Row edits other than the `0002` status change in H-7 wait for H-12.

### H-5: Create the quarantine site

**Owner:** SharePoint Administrator. **When:** the same working day as H-3 (see H-3's bound).

The quarantine replaces the fallback bucket. Uploads that cannot be tied to exactly one client
go there, and it is readable only by the people who triage it. It is a communication site: no
Microsoft 365 group, so no Team and no way to join it; unique permissions; and sharing Disabled.

**Use the script.** [`infrastructure/quarantine/New-QuarantineSite.ps1`](../../infrastructure/quarantine/README.md)
does everything in this step — site, sharing, reviewers group, broken inheritance, no Everyone
claims, and the four columns — prints its plan, and changes nothing without `-Apply`. It refuses
an existing site that is a Team site or not a communication site, so a mistyped URL cannot touch
a client Team or BCR GROUP.

```powershell
./infrastructure/quarantine/New-QuarantineSite.ps1 -SiteUrl https://<tenant>.sharepoint.com/sites/BCRLedgerKwarantanna `
  -Owner <admin-upn> -ReviewerUpn <roman-upn>, <yahor-upn> -ClientId <PnP app client id>
# review the plan, then the same command with -Apply
```

The manual commands below are the equivalent, kept for reference.

```powershell
Connect-SPOService -Url https://<tenant>-admin.sharepoint.com
New-SPOSite -Url https://<tenant>.sharepoint.com/sites/BCRLedgerKwarantanna `
  -Title 'BCR Ledger – Kwarantanna' -Owner <admin-upn> `
  -Template 'SITEPAGEPUBLISHING#0' -LocaleId 1045 -StorageQuota 5120
Set-SPOSite -Identity https://<tenant>.sharepoint.com/sites/BCRLedgerKwarantanna -SharingCapability Disabled
```

**People.** Put only the triage staff in the site's Owners group (Roman and Yahor, by the plan's
default). Remove everyone else from Members and Visitors:

```powershell
Get-SPOSiteGroup -Site https://<tenant>.sharepoint.com/sites/BCRLedgerKwarantanna | Select Title, Users
Add-SPOUser -Site https://<tenant>.sharepoint.com/sites/BCRLedgerKwarantanna -LoginName <upn> -Group '<Owners group title>'
```

**The site's ids,** read-only, once the site exists (by either route). The manual columns
below, H-5's Verify and H-6 use them, so set them in every shell that runs those steps. The
script prints the site id too, but never paste an id by hand:

```bash
Q_SITE=$(g "$G/sites/$SP_HOST:/sites/BCRLedgerKwarantanna?\$select=id" | jq -r .id)
Q_LIST=$(g "$G/sites/$Q_SITE/drive/list?\$select=id" | jq -r .id)
# The library name. On this tenant: Dokumenty.
g "$G/sites/$Q_SITE/drive?\$select=name"
```

**Library columns.** After each upload, ingestion writes four columns on the quarantined item, so
triage can decide from the uploader's identity rather than from content. They must exist, with
exactly these names, as single lines of text:

```bash
for C in UploaderOid QuarantineReason OriginalFilename DocumentId; do
  g -X POST "$G/sites/$Q_SITE/lists/$Q_LIST/columns" -d "{\"name\":\"$C\",\"text\":{}}"
done
```

The script above creates these columns; the commands are the manual equivalent.

**Verify.**

- `Get-SPOSite -Identity … | Select SharingCapability` reads `Disabled`.
- `g "$G/sites/$Q_SITE/lists/$Q_LIST/columns?\$select=name" | jq -r '.value[].name'` includes
  all four columns.
- The drive name matches what you will set as `QUARANTINE_DRIVE_NAME` in H-8.

**Rollback.** `Remove-SPOSite` while it is still empty. After the first upload, it holds client
documents and is not deleted.

**Retention.** Quarantined items are kept 90 days after triage. That is the plan's default, for
Roman and the lawyer to confirm.

### H-6: Grant the ingestion identity write on the quarantine site

**Owner:** Global Admin (or anyone who may start jobs on the onboarding Automation account).
**When:** the same working day as H-3, after H-5.

The onboarding repo's runbook `Grant-TeamSiteAccess.ps1` makes the grant. It runs in the
onboarding Automation account, whose identity holds `Sites.FullControl.All`. A person starts the
job; no ledger identity gets any role on that account. It is the only grant path:
`infrastructure/grant-sharepoint-permission.sh` has been deleted, because it wrote a grant on
every run, with no dry run, to the API app registration by default.

**First, the site id,** in this shell: set `Q_SITE` as in H-5 (*The site's ids*), never by
pasting one. The runbook writes to whatever site the id names, so check that it is the
quarantine site and not BCR GROUP:

```bash
# Must end in /sites/BCRLedgerKwarantanna.
g "$G/sites/$Q_SITE?\$select=webUrl" | jq -r .webUrl
DIR_SITE=$(az functionapp config appsettings list -g $RG -n $INGEST \
  --query "[?name=='CLIENT_DIRECTORY_SITE_ID'].value | [0]" -o tsv)
[ "$(cut -d, -f2 <<<"$Q_SITE")" != "$(cut -d, -f2 <<<"$DIR_SITE")" ] \
  && echo 'not BCR GROUP: go on' || echo 'STOP: that is BCR GROUP'
```

```bash
az automation runbook start -g rg-bcr-onboarding-dev --automation-account-name aa-bcr-onboarding-dev \
  -n Grant-TeamSiteAccess --parameters SiteId="$Q_SITE" AppId="$INGEST_MI_APPID" \
  AppDisplayName="BCR ledger ingestion"
```

`AppId` is the ingestion managed identity's *application* id (`$INGEST_MI_APPID`), not its
object id, and never the ingestion API app registration's client id: ingestion calls Graph only
as its managed identity, so a grant to the app registration does nothing for it. The variables
above derive it, so nobody types a GUID.

**Verify.** The job output is one JSON line with `"outcome": "granted"` (or `"exists"`). Per-site
grants take about 5 minutes to take effect. The functional proof is the quarantine canary in
H-12.

**Rollback.** In Graph Explorer, with `Sites.FullControl.All` consented (see
[`admin-sharepoint-grant.md`](../admin-sharepoint-grant.md)):
`DELETE /sites/{Q_SITE}/permissions/{permissionId}`.

### H-6b: Point the running build's fallback at the quarantine

**Owner:** Yahor. **When:** the same working day as H-3, after it, and as soon as H-6's grant is
verified (the job reported `granted` or `exists`, and about 5 minutes have passed). Then check
T-4 again ([H-4](#h-4-tenant-hardening)).

Until H-12, the running ingestion is the pre-Phase-0 build. Every onboarded guest is unmapped
(R1), so their uploads go to its fallback target, which is the BCR GROUP library root. T-4 locks
the folders already there, but not the ingestion identity's write, so new files would keep
landing in BCR GROUP. The old build reads its fallback target from the `FALLBACK_SITE_*`
settings, so pointing them at the quarantine site from H-5 sends every unrouted upload to the
staff-only quarantine instead, with no deploy. H-3 must already be in effect: promotion keys on
"this upload fell back", not on where the fallback is, so the re-point alone does not stop it.

**1. Record the current values.** The names go in the status table; the values hold site paths,
so they go to the evidence store, not into the table or a chat.

```bash
H6B=tools/out/h6b-fallback-$(date -u +%Y%m%dT%H%M%SZ); mkdir -p -m 700 "$H6B"
az functionapp config appsettings list -g $RG -n $INGEST -o json \
  --query "[?starts_with(name,'FALLBACK_')].{name:name,value:value}" > "$H6B/fallback-before.json"
chmod 600 "$H6B/fallback-before.json"
# The names only.
jq -r '.[].name' "$H6B/fallback-before.json"
```

Upload `$H6B` to the evidence store as in H-2 steps 5 and 6 (`--upload-dir "$H6B"`, then take
the write access away again), and delete the local copy.

**2. Re-point.** The same site, library and folder as `QUARANTINE_*` in H-8. `FALLBACK_CLIENT_ID`
is only a label and stays as it is. `appsettings set` merges, so nothing else changes.

```bash
az functionapp config appsettings set -g $RG -n $INGEST -o none --settings \
  "FALLBACK_SITE_HOSTNAME=$SP_HOST" \
  "FALLBACK_SITE_PATH=/sites/BCRLedgerKwarantanna" \
  "FALLBACK_DRIVE_NAME=Dokumenty" \
  "FALLBACK_ROOT_FOLDER=Kwarantanna"
```

**Verify.** The canary guest from H-12 step 4 (a BCR-controlled outside account, bound to no
row, in no client Team) uploads a synthetic PDF. It lands on the quarantine site under
`Kwarantanna/`, and nothing new appears at the BCR GROUP library root.

**Note for triage.** Until H-12 these files come from the old build, so they use its layout,
`Kwarantanna/<category>/YYYY/MM/`, and have none of the four quarantine columns. Take the
uploader from the IR-0-style log lines (`no directory match on user id…` carries the user id and
the conversation), not from the content.

**Rollback.** Prefer fixing the quarantine grant (H-6). Restoring the saved values sends
unrouted uploads to BCR GROUP again; do it only if the quarantine cannot be written, and record
why. H-14 deletes all `FALLBACK_*` settings once the Phase-0 build is live.

### H-7: Check the Directory before the deploy, and add the new columns

**Owner:** Yahor, with Roman for the decisions. **When:** day 1, after IR-0 C is in the evidence
store (H-2 step 4) and T-5's Verify shows versioning on (`EnableVersioning` is `true`).
Read-only, except for the two new columns and the one `Status` edit on the duplicate `0002` row
below. Both change the Directory, so both wait for that export and that versioning.

`tools/directory-bindings.mjs` runs with a delegated Graph token. By default it reads and
changes nothing. The flags below match [`tools/README.md`](../../tools/README.md);
`node tools/directory-bindings.mjs --help` is authoritative. For the token, see that README's
"Authentication" section: the `az` token has no SharePoint scopes.

The tool needs the Directory's ids, the ingestion managed identity's app id, the forbidden
sites, the quarantine site and the tenant's SharePoint host: the same values ingestion is given
in H-8. Without the Directory's ids or the forbidden sites it stops (`check`, `propose` and
`apply` all refuse to run without `FORBIDDEN_TARGET_SITE_PATHS`); without the app id every
write grant reads "unknown" and every client row is skipped. Set them in every new shell before
running it:

```bash
export GRAPH_TOKEN=$(node ../bcr-onboarding-agent/tools/graph-login.mjs)
export DIRECTORY_SITE_ID=$(az functionapp config appsettings list -g $RG -n $INGEST \
  --query "[?name=='CLIENT_DIRECTORY_SITE_ID'].value | [0]" -o tsv)
export DIRECTORY_LIST_ID=$(az functionapp config appsettings list -g $RG -n $INGEST \
  --query "[?name=='CLIENT_DIRECTORY_LIST_ID'].value | [0]" -o tsv)
export INGEST_APP_IDS=$INGEST_MI_APPID
export FORBIDDEN_TARGET_SITE_PATHS=/sites/BCRGROUPSp.zo.o
# Always forbidden to a client row.
export QUARANTINE_SITE_PATH=/sites/BCRLedgerKwarantanna
# The only host a row may name.
export QUARANTINE_SITE_HOSTNAME=$SP_HOST
node tools/directory-bindings.mjs check
```

For every row, `check` reports:

- a row it will never bind, as `forbidden_target`: its `SitePath` is BCR GROUP or the
  quarantine, its `SiteHostname` is not `$SP_HOST`, or its site resolves in Graph to the
  Directory's own site collection (BCR GROUP) however the path is spelled. A `SitePath` that is
  not exactly `/sites/<name>` or `/teams/<name>` is skipped as `site_path_not_canonical`.
  Ingestion excludes the same rows;
- staff ids on client rows;
- duplicate ClientIds and NIPs, and rows sharing a site, a `DriveId` or a `TeamId` (ingestion
  excludes every such row as a conflict);
- whether the client's Team is Private and its channel is standard;
- whether the Team carries onboarding's `BCR Group — …` description. The five Teams
  `[0000]`–`[0004]`, TEST and PESKOVOI among them, predate onboarding and have none. That is a
  warning, not a skip: the Team is found from the row's own site;
- whether the ingestion identity has write on the row's site;
- whether each guest is in this client's Team and **in no other Team**. A guest who is also in
  any other Team, marked or not, is excluded (`guest_in_other_team`) and is never bound; their
  uploads go to quarantine.

**Write grants read "unknown" with this token,** because reading site permissions needs
`Sites.FullControl.All`. Verify each one **read-only**: in Graph Explorer, with
`Sites.FullControl.All` consented (see [`admin-sharepoint-grant.md`](../admin-sharepoint-grant.md)),
`GET /sites/{site-id}/permissions` must show a `write` role for `$INGEST_MI_APPID`, the
ingestion managed identity's app id. A `write` entry for any other app, the ingestion API app
registration included, does not count: ingestion never calls Graph as it.
Then pass that site to `propose` with `--write-verified` (H-12 step 5). Do **not** "verify" by
running `Grant-TeamSiteAccess.ps1`: when it finds no write grant it **creates** one. Never point
it at BCR GROUP, where it would undo H-13.

**A plan for IR-1, now.** `propose` is read-only apart from the plan file it writes under
`tools/out/`. Run it once here: the plan lists each site's guests, and IR-1 takes it with
`--bindings-plan` to flag uploads by anyone who is not a guest of that site's client
(`uploader_not_site_guest`; see
[incident → IR-1](incident-2026-09.md#ir-1-inventory)).

```bash
# Writes tools/out/directory-bindings-plan-<UTC>.json
node tools/directory-bindings.mjs propose
```

Decide what happens to each finding **before** H-12, and write the decisions in the incident's
status table:

- **The duplicate `0002`.** Two live rows carry PESKOVOI's ClientId. The tool refuses to change
  rows with a duplicate ClientId. Roman decides which row is PESKOVOI's: it is the one whose
  `SitePath` is PESKOVOI's site. Set the other row to `Status = Inactive` by hand, only once IR-0
  C is stored and T-5 has turned versioning on; versioning then records the edit. Then run
  `check` again.
- **Onboarded clients whose site has no ingestion grant.** Today the ingestion identity can write
  only to TEST, BCR GROUP and PESKOVOI. For each other onboarded client, record either that it
  gets a grant in H-12 so it can be bound there, or that it stays quarantined, and why. **Do not
  grant it now.** While the pre-Phase-0 build runs, every new write grant is one more site that
  content promotion can write into; the incident's three-site bound depends on it. The grants
  are made in H-12 step 3, once step 2 has shown the Phase-0 build is live.
- **Anything else the check skips** (a non-standard channel, a Public Team, a drive mismatch):
  that row is not bound in Phase 0, and its uploads go to quarantine. Record the reason. A guest
  excluded as `guest_in_other_team` is recorded the same way; the row itself can still be bound
  for its other guests.

Then add the two new columns, `DriveId` and `TeamId`. The code running today does not read
them.

```bash
# A dry run: says what it would create.
node tools/directory-bindings.mjs --add-columns
node tools/directory-bindings.mjs --add-columns --apply
```

**Verify.** The list has `DriveId` and `TeamId`, and `check` has no unresolved finding without a
recorded decision. **Rollback.** Delete the two columns; they are empty until H-12.

### H-8: Add the new app settings

**Owner:** Yahor. **When:** day 1, after H-5, and **before any deploy**.

The Phase-0 build refuses to start without these settings, or with one in the wrong shape (see
the table), and the bot's gate defaults to `enforce`. So they go in first. The running ingestion
ignores settings it does not know, so adding its settings early is harmless. `appsettings set`
merges; it never removes a setting.

The running bot is different for one setting: the pre-Phase-0 bot already reads
`MICROSOFT_APP_TYPE`, with a `MultiTenant` default. Read it before changing it, and note the
value:

```bash
# Empty means not set.
az functionapp config appsettings list -g $RG -n $BOT -o tsv \
  --query "[?name=='MICROSOFT_APP_TYPE'].value | [0]"
```

If it reads `SingleTenant`, setting it below changes nothing. Anything else, or nothing, makes
the set below a live change to the running bot's Bot Framework authentication: right after it,
the TEST guest sends `pomoc` and the help card must come back. If it does not, restore the noted
value (or delete the setting, if it was not set) and stop.

```bash
az functionapp config appsettings set -g $RG -n $INGEST -o none --settings \
  "BOT_CALLER_APP_IDS=$BOT_APP_ID" \
  "QUARANTINE_SITE_HOSTNAME=$SP_HOST" \
  "QUARANTINE_SITE_PATH=/sites/BCRLedgerKwarantanna" \
  "QUARANTINE_DRIVE_NAME=Dokumenty" \
  "QUARANTINE_ROOT_FOLDER=Kwarantanna" \
  "FORBIDDEN_TARGET_SITE_PATHS=/sites/BCRGROUPSp.zo.o" \
  "CLIENT_DIRECTORY_MAX_STALE_MS=900000"

az functionapp config appsettings set -g $RG -n $BOT -o none --settings \
  "BOT_GATE_MODE=log" \
  "MICROSOFT_APP_TYPE=SingleTenant"
```

| Setting | Why this value |
|---|---|
| `BOT_CALLER_APP_IDS` | The bot's app id, read from the bot's own settings. Only this app may call ingestion. Each entry must be a GUID. |
| `QUARANTINE_SITE_HOSTNAME` | The tenant's SharePoint host, `<tenant>.sharepoint.com`: lower case, no `https://`, no path. It is **also the only host a Directory row may name**: a row whose `SiteHostname` differs is excluded (`forbidden_target`) and its users are quarantined. A wrong value therefore quarantines every client, as well as breaking the quarantine itself. |
| `QUARANTINE_SITE_PATH`, `QUARANTINE_DRIVE_NAME`, `QUARANTINE_ROOT_FOLDER` | The site from H-5. The path must be exactly `/sites/<name>`. `Dokumenty` because the site was created with the Polish locale; use what H-5's drive read returned. |
| `FORBIDDEN_TARGET_SITE_PATHS` | BCR GROUP. No Directory row may ever route there. Each entry must be exactly `/sites/<name>` or `/teams/<name>`. The code adds the quarantine path itself, and also refuses any row whose site resolves in Graph to BCR GROUP's or the quarantine's site collection (`sharepoint.forbidden_site`, quarantined as `forbidden_target`). |
| `CLIENT_DIRECTORY_MAX_STALE_MS` | 15 minutes. After that, a directory that cannot be refreshed routes nothing. |
| `CLIENT_DIRECTORY_SITE_ID` (already set, not changed here) | Must be the three-part Graph id, `<host>,<guid>,<guid>`. The Phase-0 build refuses any other form at cold start, because its BCR GROUP guard compares site-collection GUIDs taken from it. |
| `BOT_GATE_MODE=log` | For the first 24 hours the gate records refusals but lets turns through (H-11). |
| `MICROSOFT_APP_TYPE` | Now required. `SingleTenant`, because the bot's app registration is single-tenant. |

**Verify.**

```bash
az functionapp config appsettings list -g $RG -n $INGEST -o table --query \
  "[?starts_with(name,'QUARANTINE_') || name=='BOT_CALLER_APP_IDS' || name=='FORBIDDEN_TARGET_SITE_PATHS' || name=='CLIENT_DIRECTORY_MAX_STALE_MS'].{name:name,value:value}"
az functionapp config appsettings list -g $RG -n $BOT -o table --query \
  "[?name=='BOT_GATE_MODE' || name=='MICROSOFT_APP_TYPE'].{name:name,value:value}"
```

The shapes the Phase-0 build checks at cold start, checked now, while a wrong value costs
nothing. This must print nothing:

```bash
az functionapp config appsettings list -g $RG -n $INGEST -o json --query \
  "[?name=='CLIENT_DIRECTORY_SITE_ID' || name=='QUARANTINE_SITE_HOSTNAME' || name=='BOT_CALLER_APP_IDS'].{name:name,value:value}" \
  | jq -r '.[] | select(
      (.name == "CLIENT_DIRECTORY_SITE_ID"
        and (.value | test("^[a-z0-9.-]+,[0-9a-f-]{36},[0-9a-f-]{36}$"; "i") | not))
      or (.name == "QUARANTINE_SITE_HOSTNAME"
        and (.value | test("^[a-z0-9-]+\\.sharepoint\\.com$"; "i") | not))
      or (.name == "BOT_CALLER_APP_IDS"
        and (.value | split(",") | map(gsub("^\\s+|\\s+$"; ""))
             | all(test("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"; "i")) | not))
    ) | "wrong shape: \(.name)"'
```

If you changed `MICROSOFT_APP_TYPE`, the TEST guest's `pomoc` came back.

**Rollback.** `az functionapp config appsettings delete -g $RG -n <app> --setting-names <names> -o none`.
Only needed if a value was wrong. The running ingestion does not read its new settings. The
running bot does read `MICROSOFT_APP_TYPE`: restore the value noted above, or delete the
setting if it was not set.

### H-9: Deploy the bot with the gate in log mode

**Owner:** Yahor. **When:** day 1, after H-2 and H-8.

The bot goes first because the Phase-0 ingestion rejects any batch without
`conversationType: 'personal'`, and only the new bot sends it. The new bot also stops calling
`/api/user-target`, removes the tab's data, and shows no model text on cards.

**1. Save the package that is running now, before you build.** It is the bot's rollback until
H-12. `WEBSITE_RUN_FROM_PACKAGE` usually holds a blob URL with a SAS token, which is a
credential: it goes into a variable and is never printed, pasted or logged (lesson 19 in
`PROJECT_OVERVIEW.md`). Do not run this with `set -x`.

```bash
# tools/out is git-ignored.
mkdir -p tools/out/rollback && chmod 700 tools/out/rollback
# $1 = app name, $2 = file name. Prints neither the URL nor its token.
save_running() {
  local url
  url=$(az functionapp config appsettings list -g $RG -n "$1" \
    --query "[?name=='WEBSITE_RUN_FROM_PACKAGE'].value | [0]" -o tsv)
  case "$url" in
    https://*) curl -sSf -o "tools/out/rollback/$2" "$url" && chmod 600 "tools/out/rollback/$2" \
                 && shasum -a 256 "tools/out/rollback/$2" ;;
    *) echo "WEBSITE_RUN_FROM_PACKAGE is not a URL ('${url:0:1}'): see below" ;;
  esac
}
save_running $BOT teams-bot-before-p0.zip
```

Write the sha256 in the incident's status table. If the setting is `1` or empty, there is no
URL to fetch: download the running content from Kudu
(`https://<app>.scm.azurewebsites.net/api/zip/site/wwwroot/`, signed in as a subscription
Owner) **[verify]** into the same folder. Do not deploy without a saved copy.

**2. Build a fresh package.** The `package` script (`tools/package-function.mjs`) builds a new
zip every time:

- it deletes `artifacts/<pkg>.zip` before anything else, so a run that fails leaves no zip at
  the deploy path rather than an old one;
- it cleans `dist` and the `tsbuildinfo` files and builds again, and refuses any `dist/**/*.js`
  (the app's or `@bcr/shared`'s) that has no `src/**/*.ts` behind it, so the output of a deleted
  source file cannot ship. The zip carries no source maps, type files or build info;
- it installs production dependencies at the exact versions in `yarn.lock`, with install
  scripts disabled, and checks each top-level version against the tested `node_modules`;
- it vendors `@bcr/shared` from the `packages/shared/dist` just built, and fails if that copy
  lacks the Phase-0 config.

The zips are not in git (`artifacts/*.zip` is ignored), so a `git checkout`, `git restore` or
`git stash` cannot bring a pre-Phase-0 zip back to that path. Never take a zip from git history.

```bash
corepack yarn install --immutable
# Lesson 15.
rm -rf packages/*/node_modules/@bcr/shared
corepack yarn build && corepack yarn test
# Writes artifacts/teams-bot.zip
corepack yarn build && corepack yarn workspace @bcr/teams-bot package
```

**3. Check the zip before deploying it.** The count must be greater than 0:

```bash
unzip -p artifacts/teams-bot.zip node_modules/@bcr/shared/dist/config.js | grep -c botGateMode
```

`0`, or an unzip error, means the zip carries a pre-Phase-0 `@bcr/shared`. That bot silently
ignores `BOT_GATE_MODE` and enforces from the first minute, so the 24-hour log window never
happens. Do not deploy it; rebuild.

**4. Deploy the zip,** code only. How is the app running its code? Print only the scheme, never
the value:

```bash
az functionapp config appsettings list -g $RG -n $BOT \
  --query "[?name=='WEBSITE_RUN_FROM_PACKAGE'].value | [0]" -o tsv | cut -c1-8
```

- **`1`, or nothing:** deploy the zip.
  `az functionapp deployment source config-zip -g $RG -n $BOT --src artifacts/teams-bot.zip`.
  Retry once if the upload flakes (lesson 7 in `PROJECT_OVERVIEW.md`).
- **`https://`:** the app runs from a blob URL (lesson 19). Either use `config-zip` as above, or
  upload the zip as a **new** blob, make a SAS for it, and set `WEBSITE_RUN_FROM_PACKAGE` to the
  new URL with `-o none`. The rollback is the file saved in step 1, not the old URL.

**Verify.**

1. The TEST guest opens the bot DM and sends `pomoc`. The help card comes back.
2. The new bot started with the gate in `log` mode. `botGateMode` must read `log`; an empty value
   means the zip's `@bcr/shared` is stale (step 3):

```bash
aiq 'traces | where cloud_RoleName startswith "func-bcr-bot"
  | extend m = parse_json(message) | where tostring(m.msg) == "bot runtime initialised"
  | project timestamp, botGateMode = tostring(m.botGateMode)' <time of the deploy>
```

3. The message from step 1 produced no gate refusal:

```bash
aiq 'traces | where cloud_RoleName startswith "func-bcr-bot"
  | extend m = parse_json(message) | where tostring(m.msg) == "bot.gate.rejected"
  | project timestamp, itemCount, reason = tostring(m.reason), mode = tostring(m.mode),
      activityType = tostring(m.activityType), conversationType = tostring(m.conversationType)' \
  <time of the deploy>
```

The message from the TEST guest must not appear. Seeing it pass proves that a guest's activity
carries the BCR tenant id. The design assumes this but has not verified it yet, and in `enforce`
mode a wrong assumption would refuse every guest.

**Rollback, only until H-12.** Deploy the zip saved in step 1, the same way as in step 4. The
previous bot and the current ingestion work together, because ingestion has not changed yet.

Once the Phase-0 ingestion is live (H-12), this rollback is gone. The Phase-0 ingestion rejects
every batch from the pre-Phase-0 bot, which sends no `conversationType`, and `/api/user-target`
no longer exists, so every client's upload would fail. From then on the bot only rolls forward:
revert the offending commit, rebuild, check and deploy a new package (steps 1–4). For a problem
with the gate itself, use H-11's rollback (`BOT_GATE_MODE=log`).

### H-10: Upload manifest 0.2.0 and set availability

**Owner:** Teams Administrator. **When:** after H-9, and after T-1 has blocked sign-in on the
`{NIP}@` accounts ([H-4](#h-4-tenant-hardening)).

Follow [T-10 in tenant-hardening](tenant-hardening.md#t-10-teams-app-availability-for-the-bot),
with availability set to **Everyone**: in Phase 0 nothing adds client guests to a group, so a
restricted list would lock PESKOVOI's and the TEST guest out. The case for *Everyone* relies on
T-1 being done. Version 0.2.0 has personal scope only and no "Moje dokumenty" tab.

The package is built fresh from `teams-app/manifest.json`, with the bot's app id put in for the
placeholders, and checked before upload: T-10's *Build the package first* has the commands.
Yahor runs them and hands the zip to the Teams Administrator. There is no ready-made
`artifacts/teams-app.zip` in the repo any more; the one that used to be there was manifest
0.1.5, with team and group-chat scopes and the tab, and must never be uploaded.

Tell the clients before they see the change: the tab disappears, and a document the bot cannot
place now says "Dokument przekazano do weryfikacji przez zespół BCR" instead of showing a link.

**Verify and rollback:** as in T-10.

### H-11: After 24 clean hours, enforce the gate

**Owner:** Yahor. **When:** at least 24 hours after H-9.

Run the query from H-9 over the whole 24 hours. It is clean when:

- no row has `reason` = `tenant` or `aad_object_id` for a 1:1 chat. Either would mean real guests
  are about to be refused;
- `conversation_type` rows, if any, come only from team or group-chat installs, which should be
  refused;
- at least one message from the TEST guest passed, and ideally one from PESKOVOI's guest as well.

At this volume sampling does not drop traces, but check that `itemCount` is 1.

```bash
az functionapp config appsettings set -g $RG -n $BOT --settings BOT_GATE_MODE=enforce -o none
```

**Verify.** A DM from the TEST guest still works. A message to the bot in a group chat gets no
reply, and a `bot.gate.rejected` line with `mode: enforce` appears. **Rollback.** Set `log`
again.

### H-12: The change window: ingestion deploy, bindings, canaries

**Owner:** Yahor. Roman reviews the binding plan before it is applied. **When:** day 2–3, in one
window of about two hours, during working hours.

These steps go in **one** window because each fixes a failure the others would cause:

- once the Phase-0 ingestion is live, every onboarded guest goes to quarantine until their row
  is bound (see *The window* below);
- binding a row, or granting the ingestion identity another client site, is only safe once the
  code that encodes `Dokumenty księgowe` and never follows content is live;
- a canary proves each binding before real uploads use it.

**Preconditions, all true:**

- IR-0 is stored (H-2). This deploy changes the logs.
- `ANTHROPIC_ENABLED=false` (H-3) and the fallback points at the quarantine (H-6b).
- H-6's grant is in place.
- H-8's settings are present.
- The gate is in `enforce` (H-11).
- T-4 (and its check after H-6b), T-4b and T-5 are done.
- Every H-7 finding has a decision.

**Emergency stop,** at any point: `az functionapp stop -g $RG -n $INGEST`. Nothing is filed
anywhere; users get the bot's generic error. `az functionapp start` resumes.

1. **Deploy ingestion,** code only, as in H-9 steps 1–4, with the `document-ingestion` package:

   ```bash
   # save_running is the function from H-9 step 1; define it again in a new shell.
   # It prints no URL.
   save_running $INGEST document-ingestion-before-p0.zip
   corepack yarn build && corepack yarn workspace @bcr/document-ingestion package
   # Must print a count greater than 0.
   unzip -p artifacts/document-ingestion.zip node_modules/@bcr/shared/dist/config.js \
     | grep -c forbiddenTargetSitePaths
   ```

   A count of `0` means a pre-Phase-0 `@bcr/shared`: that build fails at cold start, because the
   old schema requires `FALLBACK_SITE_*`. Do not deploy it. The `package` script cleans `dist`,
   deletes the old zip first and builds a new one (H-9 step 2), so after a failed run there is
   no zip at all: build again, and never take a zip from git. The package saved first is the
   pre-Phase-0 build: it is a record of what ran, and **never** a rollback (standing rules).
2. **Check that it is the Phase-0 build.**
   `curl -s https://$INGEST.azurewebsites.net/api/health` reports the Phase-0 build:
   `"build":{"phase":"p0","routing":"identity-only"}`. `directory-bindings.mjs apply` checks
   this itself: it refuses to write unless the `--health-url` it is given reports
   `build.routing=identity-only`. `--expect-health` only adds further checks.

   **The window, from here until each row's apply.** A client row routes nobody until it holds
   `RootFolder`, `DriveId` and `TeamId`, and only `apply` writes those, all three together. So
   until a row is applied, an upload by an id already on it (Yahor's, on PESKOVOI's row, until
   step 8) is quarantined as `unbound_target`, and an upload by an onboarded guest whose id is on
   no row as `unmapped`. Both are expected here, not faults; the quarantine columns record the
   uploader for triage.
3. **Grant the further client sites.** Only now, with the Phase-0 build live and content
   promotion gone, grant the ingestion identity write on each client site that H-7 recorded for
   binding: H-6's runbook, with `AppId="$INGEST_MI_APPID"` and that client's site id. Derive the
   id from the row's `SitePath` (`g "$G/sites/$SP_HOST:<SitePath>?\$select=id" | jq -r .id`),
   never paste one, and check it as H-6 checks the quarantine's: it must not be BCR GROUP's. Then
   confirm each grant read-only, as in H-7 (`GET /sites/{site-id}/permissions` shows `write` for
   `$INGEST_MI_APPID`). Per-site grants take about 5 minutes to take effect, so make them before
   step 5 and wait before that client's apply.
4. **Negative canary: quarantine.** A canary guest bound to no row uploads a synthetic PDF. The
   canary guest is a BCR-controlled outside account, invited as a guest and in no client Team.
   Before this and **every later negative canary**, confirm that with the tool (H-7's variables
   set): `node tools/directory-bindings.mjs check | grep -ci <canary guest's object id>` prints
   `0`, so the id is on no row and in no Team's guest list. Otherwise stop: the upload would be
   filed into a client's channel instead of quarantined. Expect:
   - the card says "Dokument przekazano do weryfikacji przez zespół BCR", with no link;
   - the file is on the quarantine site under `Kwarantanna/YYYY/MM/<batchId>/`, with
     `UploaderOid`, `QuarantineReason = unmapped`, `OriginalFilename` and `DocumentId` filled in;
   - a `document.quarantined` log line appears.
5. **Propose, and have it reviewed.** Set the variables from H-7 again in this shell. Two
   decisions are passed as flags: PESKOVOI's row holds Yahor's staff id, which is removed only
   with `--confirm-remove-staff` for that row, and each site whose write grant was confirmed
   read-only (in H-7, or in step 3 here) is passed with `--write-verified`. Without them the
   tool skips those rows, and step 8 cannot run.

   ```bash
   # Add --write-verified <sitePath> for each further site granted in step 3.
   node tools/directory-bindings.mjs propose --confirm-remove-staff <PESKOVOI listItemId> \
     --write-verified <TEST sitePath> --write-verified <PESKOVOI sitePath>
   ```

   `propose` refuses to run without `FORBIDDEN_TARGET_SITE_PATHS`, and skips as
   `forbidden_target` any row on BCR GROUP, on the quarantine, on another host, or whose site
   resolves to BCR GROUP's site collection.

   It writes a plan under `tools/out/`. The plan holds client data and never leaves that folder.
   Roman and Yahor read it row by row:
   - `UserAadObjectIds` holds only that Team's guests, and no staff;
   - PESKOVOI's row shows Yahor's id removed as staff under PATCH;
   - no guest excluded as `guest_in_other_team` appears on any row;
   - `RootFolder` is the channel folder's name as Graph returns it;
   - `DriveId` and `TeamId` are set;
   - host, path and drive are unchanged.

   This plan is also IR-1's `--bindings-plan` input from now on. If a site's guests differ from
   the H-7 plan, run IR-1 again for that site with this one.
6. **Apply TEST first.** A dry run, then the same with `--apply`:

   ```bash
   # The dry run. Then run the same command again with --apply added.
   node tools/directory-bindings.mjs apply --plan tools/out/<plan>.json --only <TEST listItemId> \
     --health-url https://$INGEST.azurewebsites.net/api/health
   ```

   The tool prints each row before and after, and writes a rollback log. It refuses a plan older
   than 72 hours (`--max-plan-age-hours` can lower that, never raise it), a row changed since
   `propose`, and a health endpoint that does not report `build.routing=identity-only`. Before
   each PATCH it reads every guest it is about to bind again: the user must still be a `Guest`,
   and the Teams in their `memberOf` must be exactly the row's Team. Otherwise the row is
   `stale` and skipped: run `propose` again. The apply log is a new file every run (an `--out`
   that exists is refused), written safely before each PATCH; keep every one until H-15.
7. **Canary on TEST.** The TEST guest uploads a synthetic PDF. Expect:
   - it lands in TEST's `Dokumenty księgowe/…`, visible in the channel's files tab;
   - the card's link opens it there;
   - a `document.filed` line appears.

   Then delete the canary file.
8. **Apply PESKOVOI, then canary.** The same `apply` with `--only <PESKOVOI listItemId>`. It
   takes Yahor's id off the row because step 5 ran `propose` with `--confirm-remove-staff` for
   that row; check that the printed after-state no longer holds it. For a real client, the
   canary must come from an identity bound to that client, and there are two ways:
   - by arrangement, the client's contact sends the synthetic canary file BCR gives them; or
   - BCR's canary guest joins that one client Team for the canary only. At that moment it is in
     no other Team at all, or the tool excludes it (`guest_in_other_team`). Afterwards it
     leaves the Team, and its id comes off the row the same way it went on. A plain `propose`
     is not enough: without `--write-verified` the row is SKIP `write_grant_unknown`, and
     `apply` refuses a SKIP row. So:

     ```bash
     node tools/directory-bindings.mjs propose --write-verified <PESKOVOI sitePath>
     # The dry run. Then run the same command again with --apply added.
     node tools/directory-bindings.mjs apply --plan tools/out/<new plan>.json --only <PESKOVOI listItemId> \
       --health-url https://$INGEST.azurewebsites.net/api/health
     ```

     The printed after-state must no longer hold the canary's id, and step 4's `check | grep`
     prints `0` again. Until then, an upload by the canary guest is filed into PESKOVOI's
     channel, where the client sees it.

   Never use a real client document, and never a staff account, because staff go to quarantine
   by design.
9. **Each further client** granted in step 3: apply, then canary, one at a time.
10. **Staff.** If you want staff uploads recorded as `staff` rather than `unmapped`, add one
    `IsAdmin = Yes` row with the staff ids and no target, a `ClientId` such as `staff` and
    `Status` Active (or empty). A row without a `ClientId` is ignored, and staff uploads then stay
    `unmapped`. Staff ids never go on a client row.
11. **Undo H-3.** The Phase-0 build has no promotion, so the classifier can run again, unless
    Roman has decided otherwise on the Anthropic transfer ([`security.md` T16](../security.md#t16-transfer-of-document-content-to-anthropic)):
    `az functionapp config appsettings set -g $RG -n $INGEST --settings ANTHROPIC_ENABLED=true -o none`.
12. **Close with the whole plan.** Steps 6–9 applied one row at a time, so run `propose` once
    more with the same flags as step 5 and apply that plan **without `--only`** (a dry run, then
    `--apply`). Every PATCH in it is applied, including one that takes an id off another row. The
    dry run should show no PATCH at all; any it shows is reviewed as in step 5 before it is
    applied, never skipped. Then run `check`. From now on the
    [standing checks](#standing-checks) apply.
13. **Watch for an hour:**

```bash
aiq 'traces | where cloud_RoleName startswith "func-bcr-ingest"
  | extend m = parse_json(message), msg = tostring(parse_json(message).msg)
  | where msg in ("document.filed", "document.quarantined", "document.quarantine_failed",
      "directory.conflict", "ingestion.caller.rejected",
      "sharepoint.forbidden_site", "sharepoint.possible_duplicate")
  | summarize count() by msg, reason = tostring(m.quarantineReason), kind = tostring(m.kind)' \
  <start of the window>
```

`directory.conflict` should be empty, or explained by a decision from H-7.
`ingestion.caller.rejected` and `document.quarantine_failed` should be empty.
**`sharepoint.forbidden_site` must be empty.** It means a Directory row whose site resolved in
Graph to BCR GROUP's or the quarantine's site collection, however its path was spelled; the
document was kept out and quarantined as `forbidden_target`. Treat any row as an incident
indicator: find the Directory row by its `listItemId` and tell Roman.
`sharepoint.possible_duplicate` means an upload was retried after a network failure and then
found its name taken, so the client's own folder may hold the same document twice (`name` and
`name_n`). It never crosses clients; staff compare the two items by `driveItemId` and delete the
copy.

What each `quarantineReason` means, and what to do:

| Reason | Meaning | Action |
|---|---|---|
| `unmapped` | The uploader's id is on no row | Expected for a guest not yet bound; otherwise check the H-7 decision for that client |
| `unbound_target` | The uploader's one row lacks `RootFolder`, `DriveId` or `TeamId`: the tool has not bound it | Expected until that row's apply; afterwards, run `propose` and apply |
| `staff` | The uploader is on the `IsAdmin` row | Expected; staff do not upload through the bot in Phase 0 |
| `conflict` | The id is on two rows, or the row shares a site, `DriveId` or `TeamId` with another row | A person fixes the Directory; `directory.conflict` names the rows |
| `stale_directory` | The Directory could not be read recently enough, or the row's drive no longer matches its `DriveId` | Check T-5's `directory refresh failed` query and the row |
| `forbidden_target` | The row names BCR GROUP, the quarantine, another host or a path that is not exactly `/sites/<name>`, or its site resolved to BCR GROUP's or the quarantine's collection (`sharepoint.forbidden_site`) | Never "fix" it by pointing the row elsewhere by hand; tell Roman, run `check` |
| `target_unwritable` | The client's site could not be written: no grant, or the site or drive is gone | Check that client's grant for `$INGEST_MI_APPID` (step 3) |

A batch that runs longer than 150 seconds returns the documents it had not started as rejected,
with the generic "spróbuj ponownie" code, rather than uploading them late. The user resends
those.

**After the window.** Phase 0 has **no alert rule**: alerting comes with the monitoring work in
Phase 1. Until then the [standing checks](#standing-checks) stand in for it.

**Rollback.**

- A binding: `node tools/directory-bindings.mjs rollback --log tools/out/<apply-log>.json --apply`
  (a dry run without `--apply`) restores the before-state it printed. That row's guests then go to quarantine, which is safe.
- The ingestion build: stop the app, revert the offending commit, rebuild, check the zip as in
  step 1 and deploy it. **Never redeploy a pre-Phase-0 ingestion zip**, including the one saved
  in step 1.
- The bot keeps running either way. Never restore the pre-Phase-0 bot package saved in H-9: the
  Phase-0 ingestion rejects everything it sends.

### H-13: Downgrade the ingestion grant on BCR GROUP to read

**Owner:** Global Admin, in Graph Explorer with `Sites.FullControl.All` consented. **When:**
after H-12 is verified.

Ingestion still has to read the Client Directory on the BCR GROUP site, and must never write
there again. `FORBIDDEN_TARGET_SITE_PATHS` already stops it in code. This step removes the
ability as well.

```
GET   https://graph.microsoft.com/v1.0/sites/<bcr-group-site-id>/permissions
      → the entry whose grantedToIdentitiesV2.application.id is $INGEST_MI_APPID,
        the ingestion managed identity's app id
PATCH https://graph.microsoft.com/v1.0/sites/<bcr-group-site-id>/permissions/<permissionId>
      {"roles":["read"]}
```

**Verify.** The GET shows `"roles": ["read"]` for `$INGEST_MI_APPID`. For the next 30 minutes,
the query from T-5 (`directory refresh failed`) returns nothing, and an upload by the TEST guest
still files correctly.

Read the rest of that GET too. Any other `write` or `owner` entry for an application, such as
an old grant to the ingestion API app registration (which the setup guide once told people to
make), is not a credential ingestion uses, but it is write access to BCR GROUP. Record each one
(its application id and roles, no more) in the incident's status table for Roman to decide on
its removal. This step changes only the ingestion managed identity's entry.

If Graph Explorer refuses the PATCH, leave the grant as it is. The code-level forbidden target
still holds. Record the refusal in the status table, and do not delete the grant as a
workaround: ingestion would then lose its read access to the Directory.

**Rollback.** PATCH `{"roles":["write"]}`.

### H-14: Remove the FALLBACK_* settings

**Owner:** Yahor. **When:** at least 24 hours after H-12, with no rollback in that time.

The Phase-0 build does not read these settings. Leaving them in place would invite someone to
redeploy an old build that does.

```bash
az functionapp config appsettings delete -g $RG -n $INGEST -o none --setting-names \
  FALLBACK_CLIENT_ID FALLBACK_SITE_HOSTNAME FALLBACK_SITE_PATH FALLBACK_DRIVE_NAME FALLBACK_ROOT_FOLDER
```

Retire the pre-Phase-0 packages saved in H-9 and H-12 in the same step, so neither can be
restored by mistake. Their sha256 is already in the status table.

```bash
rm tools/out/rollback/teams-bot-before-p0.zip tools/out/rollback/document-ingestion-before-p0.zip
```

If a pre-Phase-0 package was running from a blob uploaded by hand (lesson 19), delete that blob
from `function-releases` too. Its SAS cannot be revoked without rotating the storage key, and
rotation is deferred.

The July packages that used to be committed under `artifacts/` are no longer tracked:
`artifacts/*.zip` is ignored, and those builds remain only in git history (`cbf1630`), for
forensics. Never deploy anything extracted from there with `git show`: a package is always
built fresh by the `package` script and checked as in H-9 step 3 and H-12 step 1.

**Verify.** `az functionapp config appsettings list -g $RG -n $INGEST --query "[?starts_with(name,'FALLBACK_')]" -o table`
is empty, and `/api/health` answers. **Rollback.** Not needed: the settings and the packages are
only used by builds that must not come back.

The stale `SHAREPOINT_*`, `CLIENT_NIP` and `CLIENT_COMPANY_NAME` settings are removed with the
Bicep drift fix (gate G1), not here.

### H-15: Exit criteria

**Owner:** Yahor, signed off by Roman. Phase 0 is done when every row holds:

| Criterion | How it is shown |
|---|---|
| No promote or by-NIP routing path is left | The source-scan test in the ingestion package passes in CI |
| Group-chat, foreign-tenant and missing-oid activities produce no download | The bot's gate tests; the H-11 group-chat check |
| The tab IDOR is gone | Manifest 0.2.0 live; `/api/user-target` returns 404 |
| `conflictBehavior=fail` everywhere | Unit tests; a second canary upload with the same name gets `_1` |
| App-id pinning is live | `BOT_CALLER_APP_IDS` set (H-8 verify); the `authMiddleware` unit test "rejects the right role held by an app that is not on the allow-list" passes in CI; a live token from another app registration is refused with 403. Such a token lacks `Documents.Ingest`, so the role check refuses it first and logs no `ingestion.caller.rejected`. Do not grant `Documents.Ingest` to a test app to produce one. |
| Every onboarded client's guest is bound, or quarantined with a known reason | H-7 and H-12 records in the incident's status table |
| The IR-0 export is stored | H-2 verification |
| The taxonomy folders at the library root of every client site the ingestion identity could write to are Owners-only | T-4b's status row lists every such site (PESKOVOI, TEST and each site IR-1 added); **Check permissions** for each client's guest returns *None*; T-4b's check of the items outside those folders, after IR-1, is recorded for each site |
| The BCR GROUP root folders are Owners-only, including any created after the first lock | T-4's status row records the lock and the check after H-6b |
| The canary guest is bound to no row | `check \| grep -ci <canary guest's object id>` prints `0` (H-12 step 4), after the last canary |
| The whole binding plan is applied, and the standing checks run | A `propose` at exit shows no PATCH row (every row NOOP, or SKIP with a recorded decision); the first weekly `check` is recorded in the incident's status table ([standing checks](#standing-checks)) |
| `CLAUDE.md` is updated | Merged with the promotion removal |
| CI runs coverage, green | The CI run on `main` |

### Standing checks

**Owner:** Yahor. **From:** H-12, until Phase 2 replaces the Directory.

Phase 0 checks a guest's Team membership only when `propose` and `apply` bind a row, and it has
no alert rule. Ingestion routes on the Directory row alone. So a bound guest who is later added
to a second client's Team keeps routing everything, the second company's documents included,
into the first client's channel, and nothing notices. That is an ordinary business event: one
person running two companies. Onboarding invites the same email, gets the same guest back, adds
it to the new Team, and writes the new row with no user ids, so no conflict is raised either.
These checks close that gap by schedule until the robust fix, a runtime `memberOf` check (or a
membership registry kept in sync), lands in Phase 2. Onboarding writing the guest's id into the
new row itself (R1) waits on Roman's re-ruling of Q21.

| When | What | Why |
|---|---|---|
| After **any** onboarding | `propose` with H-12 step 5's flags, reviewed, then `apply` of the **whole** plan (a dry run, then `--apply`): never `--only <new row>` | The whole plan carries the PATCH that takes a reused guest's id off the first client's row. A guest in two Teams is then bound to neither, and their uploads go to quarantine until a person decides |
| **Weekly**, and after any onboarding that reuses an existing guest | `check`. A row id marked *not eligible* (now in another Team, or no longer in the row's Team), or a guest reported as `guest_in_other_team`, means: `propose` and apply the whole plan the same day | Catches Team changes made outside onboarding, and a guest who left their client's Team but can still file into its channel |
| Before any negative canary | H-12 step 4's `check \| grep -ci <canary guest's object id>` prints `0` | A canary guest left on a row files into that client's channel |
| Every working day | The query below. A `document.quarantine_failed` row means: check H-6's grant and the quarantine library name first. A `sharepoint.forbidden_site` row is an incident indicator (H-12 step 13) | A failed quarantine write is fail-closed (the user gets "spróbuj ponownie", nothing is written anywhere else), but if the quarantine grant or `QUARANTINE_DRIVE_NAME` breaks, every unbound, staff and stale upload is refused and nobody is told |

```bash
aiq 'traces | where cloud_RoleName startswith "func-bcr-ingest"
  | extend m = parse_json(message), msg = tostring(parse_json(message).msg)
  | where msg in ("document.quarantine_failed", "sharepoint.forbidden_site")
  | project timestamp, itemCount, msg, quarantineReason = tostring(m.quarantineReason)' \
  <24 hours ago, UTC>
```

Record the date of each weekly `check` and each post-onboarding apply, with the apply log's
hash, in the incident's status table.
