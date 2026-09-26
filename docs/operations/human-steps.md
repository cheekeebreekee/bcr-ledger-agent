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
- **BCR GROUP stays Private.** No step changes its visibility, its membership or its channels;
  T-3 only reads them, and T-7 at most blocks one account's sign-in. Inside its site, T-4 locks
  (and may create, empty) the ledger's own folders, T-5 locks the Client Directory list, and
  H-13 lowers the ingestion identity's own grant to `read`
  ([`tenant-hardening.md`](tenant-hardening.md)).
- **Yahor does not upload through the bot** until the full implementation is done. His id stays
  on PESKOVOI's Directory row until the binding tool removes it in H-12. The one exception is
  H-12 step 4's negative canary when no guest can attach in the 1:1 chat: one synthetic PDF from
  a staff account whose id is on no client row, which must end in the quarantine.
- **Guests cannot attach files in a 1:1 chat with the bot** ("Attach files: channel posts only",
  [guest capabilities](https://learn.microsoft.com/en-us/microsoftteams/guest-experience)), and
  every client is a guest. So no proof below may depend on a guest sending a file through the
  bot: a guest's file reaches ingestion only through the channel inbox (H-12, the channel-inbox
  step). Where an earlier version of this page asked for a guest's bot upload, the step says
  what replaces it, and the incident's status table records the proof that was dropped.
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

**Check the two ids, in every new shell, right after the variables.** An empty or malformed value
means `RG`, `BOT` or `INGEST` is wrong (or a comment was pasted into zsh), and the steps below
would write it into a setting or a grant: an empty `BOT_CALLER_APP_IDS` stops the Phase-0
ingestion at cold start. This must print nothing:

```bash
[[ $BOT_APP_ID =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]] \
  || echo 'STOP: BOT_APP_ID is not a GUID. Check RG and BOT, then set the variables again.'
[[ $INGEST_MI_APPID =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]] \
  || echo 'STOP: INGEST_MI_APPID is not a GUID. Check RG and INGEST, then set the variables again.'
```

Graph and SharePoint tokens are set up as described in
[`tenant-hardening.md` → Tokens](tenant-hardening.md#tokens).

### At a glance

| # | Step | Owner | When | Waits for |
|---|---|---|---|---|
| H-0 | Automatic deploys stopped | Yahor | done, 25 Sep | — |
| H-1 | GDPR: processor notice and breach register | Roman + IOD | by 26–28 Sep | — |
| H-2 | IR-0: evidence export, stored immutably | Yahor, Global Admin, Roman | today; step 1 starts in parallel with H-3 | — |
| H-3 | **Mandatory:** stop promotion with a setting | Yahor | **immediately, day 0**, without waiting for H-2; H-5, H-6 and H-6b follow **the same working day** ([the bound](#h-3-stop-promotion-now-without-a-deploy)) | — |
| H-4a | Graph permissions for the operator tools, admin-consented | Global Admin | day 0, before H-4 | — |
| H-4 | Tenant hardening T-1 to T-9, T-4b included | per step | today–tomorrow | H-4a; T-4, T-4b, T-5 before H-12; T-4 the day of H-3, checked again after H-6b; T-4b after H-3 is verified, before IR-2; T-1 before H-10 |
| H-5 | Quarantine site | SharePoint Admin | the working day of H-3 | — |
| H-5b | Canary guest invited, in no Team; its object id recorded | Global Admin | the working day of H-3 | H-4a; needed by H-6b and H-12 |
| H-6 | Ingestion identity write grant on quarantine | Global Admin | the working day of H-3 | H-5 |
| H-6b | Running build's fallback re-pointed at the quarantine | Yahor | the working day of H-3 | H-3, H-5b, H-6 verified |
| H-7 | Directory check and new columns (no new site grants) | Yahor | day 1 | H-2 (IR-0 C stored), H-4a, T-5 |
| H-8 | New app settings, added | Yahor | day 1 | H-5 |
| H-8b | Ingestion identity: Graph `Directory.Read.All` (the membership check), granted and verified | Global Admin; Yahor runs the dry run | day 1, **at least 24 h before H-12** | H-4a |
| H-9 | Bot deploy, gate in `log` | Yahor | day 1 | H-2, H-8 |
| H-10 | Manifest 0.2.0, availability *Everyone* | Teams Admin | day 1 | H-9, T-1 |
| H-11 | Gate to `enforce` | Yahor | day 2 | 24 h of clean logs |
| H-12 | Change window: ingestion, further site grants, bindings, canaries; then the channel inbox (its build, a canary Team, `shadow` and `enforce` for the canary row, then for PESKOVOI) | Yahor, Roman reviews and decides on PESKOVOI's older attachments | day 2–3; the channel-inbox step may follow on a later day | H-5b, H-6, H-6b, H-7, H-8b, H-11, T-4, T-4b, T-5 |
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
keeps **90 days** on this component (`retentionInDays`; checked 26 September, not the 30 the
design assumed), and each day of delay deletes a day of evidence. Every upload of the incident
reached ingestion between 7 and 16 July, so that evidence starts ageing out around 5 October. This must also happen **before
H-9 and H-12**, because the Phase-0 code changes what is logged. H-3 does not wait for it: it
deletes no past data, so it runs at once, and step 1 starts in parallel.

What to export, and why each join works, is in
[incident → IR-0](incident-2026-09.md#ir-0-preserve-the-evidence-first). Every script is
described, with all its flags, in [`tools/README.md`](../../tools/README.md).

**1. The trace export (Yahor).** 24-hour chunks over the component's whole retention: pass
`--days 90` (a 30-day run on 26 September found no application log at all, because every upload
was in July). It writes the files, the
query, `export-meta.txt` and `SHA256SUMS` under `tools/out/` (git-ignored). `--all-traces` also
keeps every trace unfiltered, from both apps (they share the component). The script always
exports the `requests` rows for `/api/mydocs` and `/api/user-target`: the only record of who
used the Personal Tab lookup (W5), which Purview cannot see.

```bash
tools/ir0/export-appinsights.sh --app <App Insights component> --resource-group rg-bcr-ledger-dev --days 90 --all-traces
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

**Owner:** Yahor runs it; Roman is told. **When:** immediately, on day 0, **without waiting for
H-2**. It changes one setting and restarts the app. It deletes no past App Insights, Purview,
Entra or Directory data, and every IR-0 export covers past data only, so it costs the evidence
nothing; start H-2 step 1 (the trace export) in parallel. Every hour it waits, the running build
can still file a document into another client's site. **Mandatory.**

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

### H-4a: Consent the permissions the operator tools need

**Owner:** Global Admin. **When:** day 0, before H-4, and before the reads in H-5b, H-6b and H-7.
It changes no data; it lets the operator's own token do what this runbook asks of it.

Every `g` and `sp` call and every `tools/*.mjs` run below uses a delegated token from one app
registration BCR owns: the one the onboarding repo's `tools/graph-login.mjs` signs in with (its
client id is `GRAPH_CLIENT_ID`; see [`tenant-hardening.md` → Tokens](tenant-hardening.md#tokens)).
The onboarding setup consented only `Sites.Manage.All` on it, plus SharePoint `AllSites.Read`.
A token from it carries every delegated permission admin-consented on the registration, so the
rest is added there, once. Without them `check` and `propose` stop with a 403 at their first read
of the Teams, and T-1's `--apply` cannot block a sign-in.

In the Entra admin centre: **App registrations → All applications →** that registration **→ API
permissions → Add a permission → Microsoft Graph → Delegated permissions**. Add these, then
**Grant admin consent for** the tenant:

| Delegated Graph permission | Needed by |
|---|---|
| `User.Read.All`, `GroupMember.Read.All`, `Group.Read.All`, `Channel.ReadBasic.All` | `directory-bindings.mjs` `check`, `propose` and `apply` (apply re-reads every guest it binds); H-5b's check |
| `Sites.Read.All` | H-2 step 4 (the Directory export), `check`, `propose`, IR-1 |
| `Sites.ReadWrite.All` | `directory-bindings.mjs apply` and `rollback`: they write the Directory rows |
| `Sites.Manage.All` (already there) | `--add-columns`; H-5's four columns |
| `User.ReadWrite.All`, `Directory.Read.All` | T-1's `audit-client-access.mjs --apply` (it blocks sign-in); T-2's licence removal; T-7's sign-in block; H-8b's dry run and verify |
| `AppRoleAssignment.ReadWrite.All` *(optional, only for H-8b's `--apply`)* | H-8b's grant of `Directory.Read.All` to the ingestion identity, by the Global Admin. Remove it again afterwards; Graph Explorer is the alternative (H-8b) |

Do **not** add SharePoint `AllSites.FullControl`. Only the scripted SharePoint changes in
tenant-hardening (T-4, T-4b, T-5) need it, and each of them has a browser path, which needs none
of this: use the browser. T-8's `Policy.ReadWrite.Authorization` is the same: its browser path
is the one to use.

The permissions are delegated, so a token never does more than the signed-in person could do in
the browser. A **403** from a tool, from `g` or from `sp` therefore means one of two things:
the permission is not consented here, or that person lacks the right on that site or object.
The `Scopes:` line below tells the two apart.

**Verify.** `node ../bcr-onboarding-agent/tools/graph-login.mjs > /dev/null` signs in and prints
`Scopes: …` on stderr, which lists every permission in the table. The token itself goes to
`/dev/null`, never to the screen.

**Rollback.** Remove the added permissions on the same page (**⋯ → Remove permission**) once
nothing needs them. The read permissions stay for the [standing checks](#standing-checks) until
Phase 2.

### H-4: Tenant hardening

**Owner:** per step. **When:** today and tomorrow, after H-4a (T-1's `--apply` needs its
permissions). Run T-1 to T-9 from [`tenant-hardening.md`](tenant-hardening.md), T-4b included,
using the browser path wherever a step offers one. T-10 comes with H-10.

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

### H-5b: Invite the canary guest

**Owner:** Global Admin. **When:** day 0, the working day of H-3, after H-4a and before H-6b.
H-6b's check, H-12 step 4 (if it can attach in the bot chat), H-12's channel-inbox canary (in
the dedicated canary Team, never a client's), the [standing checks](#standing-checks) and H-15
all use it.

The canary guest is BCR's test identity for uploads that must be quarantined: an account outside
the tenant that BCR controls and keeps for testing. Never a client's address, and never a staff
member's own. It is a guest in no Team, so it is bound to no row, and every upload it makes must
end in the quarantine. T-8 lets only admin roles invite guests, so the Global Admin invites it.

1. **Invite it.** Entra admin centre: **Users → All users → New user → Invite external user**,
   with the canary's address. Add it to no group and no Team.
2. **Record its object id**, and only the id (no address, no name), in the incident's
   [status table](incident-2026-09.md#status). It is BCR's own test account, the one object id
   that table holds, because every negative canary checks against it. Below it is `<canary id>`.
3. **Check that it reaches the bot today.** Sign in as the canary, accept the invitation, switch
   to the BCR organisation in Teams, find "Asystent BCR" and send `pomoc`: the help card comes
   back. Before H-10 makes the app available to *Everyone*, today's availability may keep a
   guest in no Team out. If it does, H-6b's Verify uses the TEST guest instead (see there), and
   the canary is first used in H-12.

**Verify.** It is a guest, in no group and no Team:

```bash
CANARY=<canary id>
# Must read Guest.
g "$G/users/$CANARY?\$select=userType" | jq -r .userType
# Must print 0.
g "$G/users/$CANARY/memberOf?\$select=id" | jq '.value | length'
```

**Rollback.** Delete the guest in the Entra admin centre, and record it. Only once no canary
needs it any more: the standing checks use it until Phase 2.

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
the write access away again), and delete the local copy. H-3 does not wait for H-2, so the store
may not exist yet. Then keep `$H6B` where it is, under the git-ignored `tools/out/` with the
folder at mode 700 and the file at 600 (as created above), and go on with step 2. Upload it once
H-2 step 5 has created the store, and only then delete the local copy.

**2. Re-point.** The same site, library and folder as `QUARANTINE_*` in H-8. `FALLBACK_CLIENT_ID`
is only a label and stays as it is. `appsettings set` merges, so nothing else changes.

```bash
az functionapp config appsettings set -g $RG -n $INGEST -o none --settings \
  "FALLBACK_SITE_HOSTNAME=$SP_HOST" \
  "FALLBACK_SITE_PATH=/sites/BCRLedgerKwarantanna" \
  "FALLBACK_DRIVE_NAME=Dokumenty" \
  "FALLBACK_ROOT_FOLDER=Kwarantanna"
```

**Verify.** The canary guest from [H-5b](#h-5b-invite-the-canary-guest) (bound to no row, in no
Team) uploads a synthetic PDF. It lands on the quarantine site under `Kwarantanna/`, and nothing
new appears at the BCR GROUP library root.

If H-5b found that the canary cannot reach the bot yet, the TEST guest uploads it instead, but
only once its id is shown to be on no Directory row. Before H-12 an onboarded guest is on no row
(R1), and with H-3 in effect its upload then takes the fallback like any other. On a row, the
running build would route it to that row's site instead, and the check would prove nothing.
With H-7's variables set (and, after T-5, as a BCR GROUP site owner, as in H-2 step 4), this
reads every row, Active or not, and must print `0`. A grep of `check` would not do here: `check`
also lists each Team's guests, the TEST guest among them.

```bash
g "$G/sites/$DIRECTORY_SITE_ID/lists/$DIRECTORY_LIST_ID/items?expand=fields(select=UserAadObjectIds)&\$top=999" \
  | jq -r '.value[].fields.UserAadObjectIds // empty' | grep -ci '<TEST guest id>'
```

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
"Authentication" section: the `az` token has no SharePoint scopes. H-4a consents what the token
needs; a **403** from the tool means a permission is still missing there, or the signed-in person
cannot read that site. It is never a reason to use another token or to skip the row by hand.

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
- staff ids on client rows. On a row that is not bound yet (see the exit codes below) they are
  reported as `not routing (unbound)`: ingestion quarantines those uploads as `unbound_target`;
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

**Its exit code.** A row is *bound* when it is Active, not `IsAdmin`, and has `RootFolder`,
`DriveId` and `TeamId` all set: the only rows ingestion routes to.

- `0`: every bound row was assessed, and nothing routes where it should not.
- `3`: **routing drift on a bound row.** It holds a staff id, or a guest who is no longer a guest
  of that row's Team alone. An `ACTION` line says to run `propose` and apply the whole plan.
- `4`: **incomplete.** No drift was found, but at least one bound row that holds user ids could
  not be fully assessed (`site_unresolved`, `no_team`, `team_lookup_failed`,
  `membership_lookup_failed` or `guest_memberships_unreadable`). Those rows are listed as
  `incomplete`, in the report and on an `ACTION` line. Act on each: usually a 403 (H-4a) or a
  site the signed-in person cannot read. Then run `check` again.
- `1`: refused (a missing or malformed input, an expired token).

3 wins over 4. **At H-7, expect `0`**, or `4` with the `incomplete` rows listed, to act on as
above. Nothing is bound yet (`DriveId` and `TeamId` stay empty until H-12), so Yahor's staff id
on PESKOVOI's row, and any staff id on TEST's, is `not routing (unbound)` and does not make it
exit 3. It is still a finding to decide on below; H-12 removes it (steps 5 and 8). An exit 3
at H-7 would mean a row is already bound and routes someone it should not: stop and tell Roman.

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

The set runs only if `BOT_APP_ID` is a GUID (the guard after the Variables), so a lost variable
cannot write an empty `BOT_CALLER_APP_IDS`:

```bash
if [[ $BOT_APP_ID =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]]; then
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
else
  echo 'STOP: BOT_APP_ID is not a GUID, so nothing was set. Set the variables again.'
fi
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

The settings the Phase-0 build requires at cold start, checked now, while a wrong value costs
nothing. Each must be present, not empty, and in the shape the table gives: the two paths exactly
`/sites/<name>` or `/teams/<name>`, every `BOT_CALLER_APP_IDS` entry a GUID. A setting that is
missing prints `missing or empty`, one in the wrong shape `wrong shape`. This must print nothing:

```bash
az functionapp config appsettings list -g $RG -n $INGEST -o json --query \
  "[?name=='CLIENT_DIRECTORY_SITE_ID' || name=='QUARANTINE_SITE_HOSTNAME' || name=='QUARANTINE_SITE_PATH' || name=='BOT_CALLER_APP_IDS' || name=='FORBIDDEN_TARGET_SITE_PATHS'].{name:name,value:value}" \
  | jq -r '
    def t: sub("^\\s+"; "") | sub("\\s+$"; "");
    def list: split(",") | map(t) | map(select(. != ""));
    def guid: test("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"; "i");
    def site_path: test("^/(sites|teams)/[A-Za-z0-9_-]([A-Za-z0-9._-]*[A-Za-z0-9_-])?$");
    def ok($n):
      if   $n == "CLIENT_DIRECTORY_SITE_ID" then test("^[a-z0-9.-]+,[0-9a-f-]{36},[0-9a-f-]{36}$"; "i")
      elif $n == "QUARANTINE_SITE_HOSTNAME" then test("^[a-z0-9-]+\\.sharepoint\\.com$"; "i")
      elif $n == "QUARANTINE_SITE_PATH"     then site_path
      elif $n == "BOT_CALLER_APP_IDS"       then list | length > 0 and all(guid)
      else                                       list | length > 0 and all(site_path) end;
    (map({(.name): (.value // "" | t)}) | add // {}) as $s
    | ("CLIENT_DIRECTORY_SITE_ID", "QUARANTINE_SITE_HOSTNAME", "QUARANTINE_SITE_PATH",
       "BOT_CALLER_APP_IDS", "FORBIDDEN_TARGET_SITE_PATHS") as $n
    | ($s[$n] // "") as $v
    | if $v == "" then "missing or empty: \($n)"
      elif ($v | ok($n)) then empty
      else "wrong shape: \($n)" end'
```

If it prints anything, correct that setting now with a merge-only
`az functionapp config appsettings set … -o none`, and run the check again. At H-12 the same
mistake would stop the new build at cold start. The running ingestion ignores the new settings,
so correcting them is harmless. It does read `CLIENT_DIRECTORY_SITE_ID`: if that one is reported,
set it to the same site's three-part id,
`g "$G/sites/$SP_HOST:/sites/BCRGROUPSp.zo.o?\$select=id" | jq -r .id`, and run T-5's
`directory refresh failed` query for the next 15 minutes.

If you changed `MICROSOFT_APP_TYPE`, the TEST guest's `pomoc` came back.

**Rollback.** `az functionapp config appsettings delete -g $RG -n <app> --setting-names <names> -o none`.
Only needed if a value was wrong. The running ingestion does not read its new settings. The
running bot does read `MICROSOFT_APP_TYPE`: restore the value noted above, or delete the
setting if it was not set.

### H-8b: Grant the ingestion identity Directory.Read.All, then verify

**Owner:** Global Admin (or a Privileged Role Administrator) for `--apply`; Yahor runs the dry
run. **When:** day 1, after H-8, and **at least 24 hours before H-12** if the timeline allows
(why: *The token* below).

The Phase-0 ingestion checks every bound upload against the uploader's Teams at upload time: it
routes only if they are exactly the row's `TeamId`, so a guest later added to a second client's
Team (R46) is quarantined instead of filing that client's documents into the first. It reads the
Teams as its managed identity, with `GET /users/{id}/memberOf`, and Microsoft Learn lists
**`Directory.Read.All`** as the least privileged application permission for that call. Without
it every bound upload is quarantined as `membership_unverified`: nothing is mis-filed, but no
client document is filed either. The running pre-Phase-0 ingestion does not use it, so granting
it now changes nothing that runs today.

This is an **application** permission on the ingestion's managed identity, unlike H-4a's
delegated permissions for the operator tools, and it is granted by
`infrastructure/identity/grant-ingestion-membership-read.sh` and nothing else. The script grants
exactly one app role, `Directory.Read.All` on Microsoft Graph, to exactly one principal, the
Function App's system-assigned managed identity. It refuses any principal that is not a managed
identity, and it removes nothing.

**The short route:** `tools/ops/phase0-admin.sh membership` runs the dry run, asks, then
`--apply`, with your own `az` login's Graph token as `GRAPH_TOKEN`. On 26 September that token's
`scp` carried `AppRoleAssignment.ReadWrite.All` and `Directory.AccessAsUser.All`, which is what
the script checks for **[verify]** on the first `--apply`. If Graph refuses it, use the
route below.

**Tokens.** `az`, signed in as for the Variables above, is used only to read the Function App's
identity. Every Graph call uses `GRAPH_TOKEN`: your `az` Graph token (the short route above), or
the delegated token from H-4a's registration. The Azure CLI app cannot be given new scopes in this
tenant (`AADSTS65002`), so if its token lacks `AppRoleAssignment.ReadWrite.All`, use H-4a's. The dry run needs only what H-4a consented (`Directory.Read.All`). `--apply` also needs
`AppRoleAssignment.ReadWrite.All` consented on that registration, and a token of the Global
Admin: the script refuses `--apply` without that scope. If you would rather not consent it, use
Graph Explorer as in [`admin-sharepoint-grant.md`](../admin-sharepoint-grant.md) Step 1, with the
exact URL and body the dry run prints, and verify with the dry run below.

The dry run changes nothing. It prints the identity, what it holds now, and the exact request
`--apply` would send:

```bash
export GRAPH_TOKEN=$(node ../bcr-onboarding-agent/tools/graph-login.mjs)
infrastructure/identity/grant-ingestion-membership-read.sh --resource-group "$RG" --function-app "$INGEST"
```

Check the output before applying: the managed identity's app id is `$INGEST_MI_APPID`, and the
only request is one `POST …/appRoleAssignedTo` for `Directory.Read.All`. Then the Global Admin,
signed in to the BCR tenant with `az login` and with their own `GRAPH_TOKEN`, runs the same
command with `--apply`:

```bash
export GRAPH_TOKEN=$(node ../bcr-onboarding-agent/tools/graph-login.mjs)
infrastructure/identity/grant-ingestion-membership-read.sh --resource-group "$RG" --function-app "$INGEST" --apply
```

It prints the identity's application permissions after the grant, which now include
`Directory.Read.All`, and the rollback commands. A `403 Authorization_RequestDenied` means the
signed-in person is not a Global Administrator or Privileged Role Administrator.

**Verify.** Run the dry run again, with any operator's `GRAPH_TOKEN`. It must print
`✔ Directory.Read.All is already assigned: nothing to do.` and list `Directory.Read.All` among the
identity's permissions:

```bash
infrastructure/identity/grant-ingestion-membership-read.sh --resource-group "$RG" --function-app "$INGEST"
```

If `AppRoleAssignment.ReadWrite.All` was consented only for this step, remove it from the
registration again (H-4a's **Rollback**); the dry run does not need it.

The functional proof comes in H-12: the first canary that files normally shows the running build
read the uploader's Teams. No guest can send a file through the bot, so that canary is the
channel-inbox step's (sub-step 3's `inbox.would_move` for the canary guest's file), not step 7's.

**The token.** A managed identity's token carries its roles. Microsoft documents that the
platform caches managed-identity tokens for around 24 hours, and that a refresh cannot be forced
([managed identity best practices](https://learn.microsoft.com/en-us/entra/identity/managed-identities-azure-resources/managed-identity-best-practice-recommendations#limitation-of-using-managed-identities-for-authorization)).
Restarting the app, as the H-12 deploy does, drops only its own in-process token. So the Phase-0
build may keep getting a token without the role for up to a day after this grant, and in that
time every bound upload is quarantined as `membership_unverified`. Granting a day ahead avoids
that. If H-12 has to run sooner, expect it, and see the troubleshooting row in H-12 step 13.

**Rollback.** The script prints the two Graph calls, for the Global Admin's `GRAPH_TOKEN`: find
the assignment's id, then `DELETE` it. After a rollback every bound upload goes to quarantine as `membership_unverified`
again. `MEMBERSHIP_CHECK_MODE=off` would file them without the check, and reopen R46: that is
Roman's decision, never a fix for a missing grant.

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
# A saved package is a record: an existing file is never replaced.
save_running() {
  local url out="tools/out/rollback/$2"
  if [[ -e "$out" ]]; then
    echo "STOP: $out already exists and is never overwritten. Use a new file name."
    return 1
  fi
  url=$(az functionapp config appsettings list -g $RG -n "$1" \
    --query "[?name=='WEBSITE_RUN_FROM_PACKAGE'].value | [0]" -o tsv)
  case "$url" in
    https://*) curl -sSf -o "$out" "$url" && chmod 600 "$out" && shasum -a 256 "$out" ;;
    *) echo "WEBSITE_RUN_FROM_PACKAGE is not a URL ('${url:0:1}'): see below" ;;
  esac
}
save_running $BOT teams-bot-before-p0.zip
```

Write the sha256 in the incident's status table. `save_running` refuses a file name that is
already taken, so running this step again can never replace the pre-Phase-0 package with a later
build: every later deploy saves under its own name (H-12, the channel-inbox step). If the setting is `1` or empty, there is no
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
- H-8's settings are present, and H-8's check of them, run again now, prints nothing.
- H-8b's grant is in place (its dry run prints `already assigned`), ideally made at least 24
  hours ago. `MEMBERSHIP_CHECK_MODE` is not set, or is `enforce`:
  `az functionapp config appsettings list -g $RG -n $INGEST --query "[?name=='MEMBERSHIP_CHECK_MODE'].value | [0]" -o tsv`
  prints nothing or `enforce`.
- The gate is in `enforce` (H-11).
- T-4 (and its check after H-6b), T-4b and T-5 are done.
- Every H-7 finding has a decision.
- `INBOX_SWEEP_MODE` is not set, or is `off`, so the new build starts with the channel-inbox
  sweep off; the channel-inbox step (after step 8) turns it on:
  `az functionapp config appsettings list -g $RG -n $INGEST --query "[?name=='INBOX_SWEEP_MODE'].value | [0]" -o tsv`
  prints nothing or `off`. `INBOX_SWEEP_ROWS` and `INBOX_CREATED_AFTER` are not set either (the
  same query with their names prints nothing).

**Emergency stop,** at any point: `az functionapp stop -g $RG -n $INGEST`. Nothing is filed
anywhere; users get the bot's generic error. `az functionapp start` resumes.

1. **Deploy ingestion,** code only, as in H-9 steps 1–4, with the `document-ingestion` package:

   ```bash
   # save_running is the function from H-9 step 1; define it again in a new shell.
   # It prints no URL, and it refuses a file that already exists.
   save_running $INGEST document-ingestion-before-p0.zip
   corepack yarn build && corepack yarn workspace @bcr/document-ingestion package
   # Must print a count greater than 0.
   unzip -p artifacts/document-ingestion.zip node_modules/@bcr/shared/dist/config.js \
     | grep -c forbiddenTargetSitePaths
   # Must print a count greater than 0 too: the shared config with the membership check.
   unzip -p artifacts/document-ingestion.zip node_modules/@bcr/shared/dist/config.js \
     | grep -c membershipCheckMode
   # And this one: the shared config with the channel-inbox settings.
   unzip -p artifacts/document-ingestion.zip node_modules/@bcr/shared/dist/config.js \
     | grep -c inboxSweepMode
   ```

   A count of `0` from the first means a pre-Phase-0 `@bcr/shared`: that build fails at cold
   start, because the old schema requires `FALLBACK_SITE_*`. A `0` from the second means a
   Phase-0 `@bcr/shared` from before the membership check, and from the third one from before the
   channel inbox. Do not deploy any of them. The `package` script cleans `dist`,
   deletes the old zip first and builds a new one (H-9 step 2), so after a failed run there is
   no zip at all: build again, and never take a zip from git. The package saved first is the
   pre-Phase-0 build: it is a record of what ran, and **never** a rollback (standing rules).
   Step 1 runs once. Every later ingestion deploy (the channel-inbox build included) is the
   channel-inbox step's sub-step 1, which saves the running package under a new name.
2. **Check that it is the Phase-0 build.**
   `curl -s https://$INGEST.azurewebsites.net/api/health` reports the Phase-0 build with the
   membership check on and the channel-inbox sweep off:
   `"build":{"phase":"p0","routing":"identity-only","membershipCheck":"enforce","inboxSweep":"off","inboxSweepRows":"all"}`.
   A build without `inboxSweep`, or without `inboxSweepRows`, is from before this channel-inbox
   build (the build H-12 deployed on 26 September has neither): the channel-inbox step deploys
   the current one first.
   `directory-bindings.mjs apply` checks the routing itself: it refuses to write unless the
   `--health-url` it is given reports `build.routing=identity-only`. `--expect-health` only adds
   further checks; `--expect-health build.membershipCheck=enforce` makes an apply refuse while
   the check is off. `"membershipCheck":"off"` here means `MEMBERSHIP_CHECK_MODE=off` is set:
   stop, and delete that setting unless Roman decided it.

   **If `/api/health` does not answer within a few minutes** of the deploy, the new build did not
   start. It checks its settings when it loads, and one missing or malformed setting stops every
   function, `/api/health` included. Never answer this with the pre-Phase-0 zip. Instead:
   1. run the emergency stop, `az functionapp stop -g $RG -n $INGEST`;
   2. find the setting it names. The message lists each failing setting by name, never its value:

      ```bash
      aiq 'union exceptions, traces | where cloud_RoleName startswith "func-bcr-ingest"
        | where outerMessage has "Invalid configuration" or message has "Invalid configuration"
        | project timestamp, text = coalesce(outerMessage, message)' <time of the deploy>
      ```

   3. fix that setting with a merge-only
      `az functionapp config appsettings set -g $RG -n $INGEST -o none --settings "<NAME>=<value>"`,
      and run H-8's check again until it prints nothing;
   4. `az functionapp start -g $RG -n $INGEST`, and check `/api/health` again.

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
4. **Negative canary: quarantine.** A synthetic PDF is sent through the bot by an identity bound
   to no row, and must end in the quarantine. Who sends it:
   - the canary guest from [H-5b](#h-5b-invite-the-canary-guest), a BCR-controlled outside
     account in no Team, **if** its 1:1 chat with the bot offers a way to attach. A guest's
     usually does not (standing rules);
   - otherwise, as production ran it on 26 September (incident, H-12 row), a **staff account
     whose id is on no client row**: the one staff upload this phase allows. Check it first:
     `node tools/directory-bindings.mjs check | grep -ci <staff id>` prints `0`. Before step 8
     removes it, Yahor's id is still on PESKOVOI's row, so his account is not that account until
     then (it would be quarantined as `unbound_target`, which proves less).

   Before this and **every later negative canary**, confirm with the tool (H-7's variables set)
   that the sender is on no row: for the canary guest,
   `node tools/directory-bindings.mjs check | grep -ci <canary id>` prints `0`, so the id is on
   no row and in no Team's guest list. Otherwise stop: the upload would be filed into a client's
   channel instead of quarantined. Expect:
   - the card says "Dokument przekazano do weryfikacji przez zespół BCR", with no link;
   - the file is on the quarantine site under `Kwarantanna/YYYY/MM/<batchId>/`, with
     `UploaderOid`, `QuarantineReason = unmapped` (or `staff`, if the `IsAdmin` row of step 10
     holds the staff id), `OriginalFilename` and `DocumentId` filled in;
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
6. **Apply TEST first**, if TEST has a Directory row (production has none: the incident's H-12
   row; then skip steps 6 and 7, and go to step 8). A dry run, then the same with `--apply`:

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
   `stale` and skipped: run `propose` again. A plan changed after `propose`, its `createdAt`
   included, is refused too: an old plan is never edited, it is proposed again. The apply log is
   a new file every run (an `--out` that exists is refused, as it is for `check` and `propose`,
   so no report can replace an apply log), written safely before each PATCH; keep every one until
   H-15. A 403 from `propose` or `apply` means a permission from H-4a is missing
   (`Sites.ReadWrite.All` for the write), or the signed-in person cannot edit the Client
   Directory list (Owners only, T-5).
7. **Canary on TEST, through the bot: only if a TEST guest can attach in the 1:1 chat.** A guest
   usually cannot (standing rules), and production has no TEST row (the incident's H-12 row), so
   this step did not run there: record it as *not applicable* in the status table. Where a TEST
   guest can attach, it uploads a synthetic PDF, and it lands in TEST's `Dokumenty księgowe/…`,
   after a `routed to client via userAadObjectId` line with `membership: verified`; then delete
   the canary file. If it is quarantined as `membership_unverified`, H-8b's grant is not in the
   token yet (step 13's table); as `membership_mismatch`, the TEST guest is in another Team as
   well, or not in TEST's.

   What this canary would prove, and where each proof comes from when it cannot run:

   | Proof | Instead |
   |---|---|
   | The row's site, drive and channel folder are bound right | The channel-inbox step: the canary Team's `shadow` and `enforce` (sub-steps 3–5), and each client row's `shadow` lines with no `inbox.row_failed` (sub-step 7) |
   | The ingestion identity can read a guest's Teams with `Directory.Read.All` (H-8b's grant is in the token) | The channel-inbox canary: a guest's file is only moved once the sweep has read that guest's `userType` and Teams. Without the grant it stays, as `inbox.skipped` `unverified` with `status` `403` |
   | Bot-path routing by identity, with `membership: verified` | Not provable with a guest, since no guest can send a file to the bot. The resolver's membership tests in CI stand in, and the incident's status table records the dropped proof and who accepted that |

8. **Apply PESKOVOI.** The same `apply` with `--only <PESKOVOI listItemId>`. It takes Yahor's id
   off the row because step 5 ran `propose` with `--confirm-remove-staff` for that row; check
   that the printed after-state no longer holds it.

   **No canary is sent through the bot for PESKOVOI**, and BCR's canary guest never joins its
   Team: PESKOVOI's guest cannot attach in the bot chat, and a BCR guest in a real client's Team
   could read that client's files. An earlier version of this step had the canary guest join
   PESKOVOI's Team and its row for a bot upload; that upload cannot be sent, so the rest of that
   procedure only exposed PESKOVOI's channel to a BCR test account. PESKOVOI's binding is proved
   by ids instead, in the channel-inbox step: its row swept in `shadow` with no
   `inbox.row_failed` (sub-step 7), then its first real `inbox.filed` (sub-step 8). If the client
   agrees, their contact may post a synthetic PDF BCR gives them in their own channel as a canary
   at sub-step 8; never a real document, and never one of another client.

   **The channel-inbox step: deploy the channel-inbox build, prove it in a canary Team, then turn
   it on client by client.** Clients are guests, and a guest can attach files only to channel
   posts, so each bound client's "Dokumenty księgowe" channel folder is their inbox: a timer
   files what the Team's guests put there into the taxonomy folders inside the same channel
   folder ([`ARCHITECTURE.md` §4.4](../../ARCHITECTURE.md#44-channel-inbox-intake-clients)).
   **Until the sweep is on, files posted in "Dokumenty księgowe" simply wait there.** That is
   safe: nothing moves them, and nothing is lost. So this step can also run on a later day.

   It is written for the state the incident's status table records after H-12 (26 September):
   the running ingestion is the Phase-0 build from before the channel inbox (its `/api/health`
   has no `inboxSweep`), PESKOVOI's row is the only bound row, there is no TEST row, TEST's Team is
   staff only and still holds PESKOVOI documents (IR-1), and `ANTHROPIC_ENABLED=true`.
   `INBOX_SWEEP_MODE` is one switch for every row, so `INBOX_SWEEP_ROWS` keeps each stage to the
   rows it names: first a dedicated canary Team's, then PESKOVOI's. The first real moves, and the
   only runtime check that a move never overwrites, happen in the canary Team.

   Never: post a canary in a real client's channel; add BCR's canary guest to a real client's
   Team; use TEST's Team for this while IR-2 has not moved PESKOVOI's documents out of it (a guest
   added there could open them); use a real client document.

   1. **Deploy the channel-inbox build** to the running Phase-0 apps, ingestion first, one app at
      a time. This is not step 1 again: the package that step saved is the pre-Phase-0 record,
      and `save_running` refuses to replace it. The packages running now are Phase-0 builds, so
      the ones saved here are this deploy's rollback.

      ```bash
      STAMP=$(date -u +%Y%m%dT%H%M%SZ)
      save_running $INGEST document-ingestion-p0-$STAMP.zip
      corepack yarn install --immutable
      rm -rf packages/*/node_modules/@bcr/shared
      corepack yarn build && corepack yarn test
      corepack yarn workspace @bcr/document-ingestion package
      # Each of the four counts must be greater than 0.
      unzip -p artifacts/document-ingestion.zip node_modules/@bcr/shared/dist/config.js \
        | grep -c forbiddenTargetSitePaths
      unzip -p artifacts/document-ingestion.zip node_modules/@bcr/shared/dist/config.js \
        | grep -c membershipCheckMode
      unzip -p artifacts/document-ingestion.zip node_modules/@bcr/shared/dist/config.js \
        | grep -c inboxSweepMode
      unzip -p artifacts/document-ingestion.zip node_modules/@bcr/shared/dist/config.js \
        | grep -c inboxSweepRows
      ```

      A `0` from any of them means a stale `@bcr/shared` in the zip: do not deploy it; rebuild.
      The preconditions still hold (`INBOX_SWEEP_MODE`, `INBOX_SWEEP_ROWS` and
      `INBOX_CREATED_AFTER` are not set), so the new build starts with the sweep off. Then deploy:

      ```bash
      az functionapp deployment source config-zip -g $RG -n $INGEST \
        --src artifacts/document-ingestion.zip
      ```

      If the app runs from a package URL instead (H-9 step 4, `https://`), upload the zip as a new
      blob, set the new URL, then sync the triggers, or the platform may never schedule the new
      timer on this plan:

      ```bash
      az rest --method post --url \
        "https://management.azure.com$(az functionapp show -g $RG -n $INGEST --query id -o tsv)/syncfunctiontriggers?api-version=2022-03-01"
      ```

      **Verify.** `/api/health` reports
      `"build":{"phase":"p0","routing":"identity-only","membershipCheck":"enforce","inboxSweep":"off","inboxSweepRows":"all"}`,
      and the timer is registered:
      `az functionapp function list -g $RG -n $INGEST --query "[].name" -o tsv` lists
      `inboxSweep` (possibly prefixed with the app's name).

      Then the bot, which carries the help card that sends clients to their channel:

      ```bash
      save_running $BOT teams-bot-p0-$STAMP.zip
      corepack yarn workspace @bcr/teams-bot package
      # Must print a count greater than 0; otherwise do not deploy it.
      unzip -p artifacts/teams-bot.zip node_modules/@bcr/shared/dist/config.js | grep -c botGateMode
      ```

      ```bash
      az functionapp deployment source config-zip -g $RG -n $BOT --src artifacts/teams-bot.zip
      ```

      **Verify.** `pomoc` in the bot chat returns the help card, and it now names the channel
      „Dokumenty księgowe” and its „Udostępnione” tab. The gate is unchanged (`enforce`, H-11).
      **Rollback.** Deploy the `*-p0-$STAMP.zip` saved here, the same way. Unlike the
      pre-Phase-0 packages, these are Phase-0 builds and may be restored; keep them until the next
      deploy is verified.
   2. **A canary Team, with no client data.** Create a Team used for canaries only, for example
      "BCR Kanarek": Private, owners BCR staff, and a standard channel named exactly
      "Dokumenty księgowe" whose Files tab you open once, so its folder exists. It never holds a
      client's document. Then set it up as a client, with step 3 and step 5's tools:
      - grant the ingestion identity `write` on its site (step 3: `AppId="$INGEST_MI_APPID"`, the
        site id derived from its `SitePath` and checked not to be BCR GROUP's), confirmed
        read-only;
      - add one Client Directory row for it by hand: a `Title` such as `[CANARY] Kanarek`, a
        `ClientId` no client will ever have (such as `canary`), no `NIP`, its `SiteHostname`,
        `SitePath` and `DriveName` (`Dokumenty`), `Status` Active, `IsAdmin` No. Its list item id
        is `<canary listItemId>` below;
      - add the canary guest (H-5b) to the canary Team, and to no other Team;
      - bind the row, reviewed as in step 5 (the plan binds the canary row with the canary guest
        on it, and changes no other row; if it shows a PATCH on another row, stop and review that
        first):

      ```bash
      node tools/directory-bindings.mjs propose \
        --write-verified <PESKOVOI sitePath> --write-verified <canary sitePath>
      # The dry run. Then run the same command again with --apply added.
      node tools/directory-bindings.mjs apply --plan tools/out/<plan>.json \
        --only <canary listItemId> --health-url https://$INGEST.azurewebsites.net/api/health
      ```

   3. **Shadow, canary row only.**

      ```bash
      az functionapp config appsettings set -g $RG -n $INGEST -o none \
        --settings "INBOX_SWEEP_ROWS=<canary listItemId>" "INBOX_SWEEP_MODE=shadow"
      ```

      The app restarts. `/api/health` must report `"inboxSweep":"shadow"` and
      `"inboxSweepRows":"listed"`, with `phase`, `routing` and `membershipCheck` unchanged. Only
      the canary Team's channel is read: PESKOVOI's is not even listed.

      The canary guest signs in (H-5b), switches to the BCR organisation, opens the canary Team,
      channel „Dokumenty księgowe”, and posts the synthetic canary PDF as an attachment to a
      post, the way a client will. A file is taken once it is 2 minutes old (`INBOX_MIN_AGE_MS`)
      and the timer runs every 2 minutes, so allow about 6 minutes, then read the sweep's lines:

      ```bash
      aiq 'traces | where cloud_RoleName startswith "func-bcr-ingest"
        | extend m = parse_json(message), msg = tostring(parse_json(message).msg)
        | where msg startswith "inbox."
        | project timestamp, msg, mode = tostring(m.mode), listItemId = tostring(m.listItemId),
            driveItemId = tostring(m.driveItemId), category = tostring(m.category),
            review = tostring(m.review), nameSuffix = tostring(m.nameSuffix),
            reason = tostring(m.reason), status = tostring(m.status), stage = tostring(m.stage),
            attempt = tostring(m.attempt), targetErrorKind = tostring(m.err.targetErrorKind),
            httpStatus = tostring(m.err.httpStatus), graphStatus = tostring(m.err.status),
            rows = tostring(m.rows), candidates = tostring(m.candidates),
            wouldMove = tostring(m.wouldMove), filed = tostring(m.filed),
            skippedNotClient = tostring(m.skippedNotClient),
            skippedUnverified = tostring(m.skippedUnverified),
            skippedChanged = tostring(m.skippedChanged), deferred = tostring(m.deferred),
            rowsFailed = tostring(m.rowsFailed)
        | order by timestamp asc' \
        <time you set shadow>
      ```

      Expect:
      - one `inbox.sweep_mode` at the restart, with `rows` naming only `<canary listItemId>`;
      - an `inbox.tick` about every 2 minutes, `mode` `shadow`, `rows` `1` (the number of ids in
        `INBOX_SWEEP_ROWS` that are bound), `rowsFailed` `0`;
      - one `inbox.would_move` with `<canary listItemId>` and the PDF's `driveItemId` (repeated
        each tick while in `shadow`), its `category` from the classifier;
      - no `inbox.skipped` for it. `not_guest`, `unknown_user` or `modified_by_other` means Graph
        does not record the guest as the creator, or the last modifier, of a channel attachment:
        stay in `shadow` and raise it, because the sweep then cannot tell a client's uploads
        apart. `unverified` with `status` `403` means H-8b's grant is not in the token;
      - the PDF still at the top of the channel's files: shadow moved nothing.

      The `would_move` is also the functional proof of H-8b's grant: it needs the ingestion
      identity to have read the guest's `userType` and Teams. Any other outcome: stay in `shadow`
      (or set `off`) and use the table below.
   4. **Enforce, canary row only.**

      ```bash
      az functionapp config appsettings set -g $RG -n $INGEST -o none --settings "INBOX_SWEEP_MODE=enforce"
      ```

      `/api/health` must report `"inboxSweep":"enforce"` and still `"inboxSweepRows":"listed"`.
      Within about 4 minutes: an `inbox.filed` (or `inbox.sorted_to_review`) with
      `<canary listItemId>`, the PDF's `driveItemId` and `nameSuffix` `0`, and the PDF inside the
      canary channel's taxonomy folder, visible on the „Udostępnione” tab. No `inbox.failed` with
      `stage` `move` and `targetErrorKind` `drive_mismatch` (that would mean Graph's move
      response did not show the new parent). Then open the channel post that carried the PDF and
      click its attachment. Record in the status table whether it still opens the file, now in
      its subfolder, or not: that is what every client will see after a move, and sub-step 7's
      decision rests on it.
   5. **The same name again: the no-overwrite proof.** The canary guest posts the same PDF,
      under the same file name, in a new post. Expect it filed into the same folder as
      `<name>_1`, with `nameSuffix` `1`, and both files there. Microsoft documents no
      `conflictBehavior` for a move, so this is the only proof that a move onto a taken name
      fails and takes `_1` rather than replacing the file. **If only one file is there, or the
      first one's content changed, set `INBOX_SWEEP_MODE=off` at once**, and go no further.
   6. **What it leaves alone, then clean up.** A staff member of the canary Team posts a second
      synthetic PDF: one `inbox.skipped` with its `driveItemId` and `reason` `not_guest`, and the
      file stays at the top of the channel. Optionally, while a guest's canary is still under 2
      minutes old, the staff member uploads a file of the same name there and chooses
      **Replace**: `modified_by_other`, and it stays.

      Then delete every canary file; the canary guest leaves the canary Team; `propose` again
      with `--write-verified` for PESKOVOI's and the canary Team's sites, reviewed as in step 5,
      and that plan applied **whole**, without `--only` (a dry run, then `--apply`): the canary
      row keeps its binding and loses the canary's id. Then
      `node tools/directory-bindings.mjs check | grep -ci <canary id>` prints `0`. The canary Team
      and its row stay, with no guest, for the next canary.
   7. **PESKOVOI in shadow, and the owner's decision.** Add PESKOVOI's row, in `shadow`:

      ```bash
      az functionapp config appsettings set -g $RG -n $INGEST -o none \
        --settings "INBOX_SWEEP_ROWS=<canary listItemId>,<PESKOVOI listItemId>" "INBOX_SWEEP_MODE=shadow"
      ```

      Shadow now lists PESKOVOI's channel and, with the classifier on, sends each of its guest's
      files at the top of the channel to Claude, as a bot upload would be sent; it moves
      nothing. After two ticks, count by row:

      ```bash
      aiq 'traces | where cloud_RoleName startswith "func-bcr-ingest"
        | extend m = parse_json(message), msg = tostring(parse_json(message).msg)
        | where msg in ("inbox.would_move", "inbox.skipped", "inbox.row_failed", "inbox.failed")
        | summarize files = dcount(tostring(m.driveItemId)), lines = count()
            by msg, listItemId = tostring(m.listItemId), reason = tostring(m.reason),
            review = tostring(m.review), targetErrorKind = tostring(m.err.targetErrorKind)' \
        <time you set shadow for PESKOVOI>
      ```

      Expect, for PESKOVOI's `listItemId`: no `inbox.row_failed` (its site, drive and channel
      folder resolve: this is PESKOVOI's binding proof, instead of a canary in its channel);
      `inbox.would_move` `files` equal to the number of files at the top of its channel's
      „Udostępnione” tab that its guest posted (count them there, top level only, without opening
      them); every `inbox.skipped` explained (a staff file is `not_guest`). A count that differs,
      or a reason you cannot explain: stay in `shadow`.

      Roman decides, before `enforce`, and the decision goes in the status table:
      - **move them all:** the older attachments move into the taxonomy folders as well. Tell the
        client first what sub-step 4 showed about a moved post attachment; or
      - **leave older ones where they are:** set `INBOX_CREATED_AFTER` to the time of the
        decision, in UTC. Only files created after it are swept; the next ticks count the older
        ones as `skippedBeforeCutoff`, and PESKOVOI's `would_move` stops for them:

      ```bash
      az functionapp config appsettings set -g $RG -n $INGEST -o none \
        --settings "INBOX_CREATED_AFTER=<YYYY-MM-DDTHH:MM:SSZ>"
      ```

      Either way, tell PESKOVOI how to send documents from now on
      ([admin guide → onboarding](../client-directory-admin-guide.md), step 6).
   8. **Enforce, both rows.** `INBOX_SWEEP_MODE=enforce`, as in sub-step 4. PESKOVOI's first
      real `inbox.filed` (or `inbox.sorted_to_review`) with its `listItemId` completes its proof,
      read by ids only, with no `inbox.failed` for its row. BCR posts nothing in its channel.
   9. **All rows.** Once PESKOVOI's first files are filed cleanly, remove the allow-list, so every
      row the Directory routes to is swept, clients bound later included:

      ```bash
      az functionapp config appsettings delete -g $RG -n $INGEST -o none --setting-names INBOX_SWEEP_ROWS
      ```

      `/api/health` must report `"inboxSweepRows":"all"`, and `inbox.tick` `rows` must equal the
      number of bound client rows `check` shows (the canary row included).

   **Rollback.** `az functionapp config appsettings set -g $RG -n $INGEST -o none --settings "INBOX_SWEEP_MODE=off"`,
   or set `INBOX_SWEEP_ROWS` back to fewer rows. The sweep stops at the next start; files it
   already moved stay where they are, inside their own channel folder, and files posted since
   simply wait. The emergency stop above stops it too.

   The bot's help card tells clients to post in the channel. Once sub-step 1 has deployed it,
   clients who follow it put files in the channel, where they wait until their row is swept:
   safe, just not filed yet.

   What the sweep's lines mean when something is off (the fields as the queries above project
   them; `targetErrorKind`, `httpStatus` and `graphStatus` are under `err` in the log line):

   | What you see | Why | Action |
   |---|---|---|
   | No `inbox.tick` at all | The mode is `off`; the app has not restarted with the setting; or the timer is not registered or not scheduled (a deploy by package URL without a trigger sync) | Check `/api/health` → `inboxSweep`. `az functionapp function list -g $RG -n $INGEST --query "[].name" -o tsv` must list `inboxSweep`; after any deploy by package URL, sync the triggers (sub-step 1). Then set the mode again |
   | `inbox.tick` with `rows` `0`, and `inbox.directory_unavailable` | The Client Directory could not be read recently enough, so nothing is swept (fail closed) | T-5's `directory refresh failed` query |
   | `inbox.tick` with `rows` lower than expected, no `inbox.directory_unavailable` | A row is not bound, or excluded (conflict, forbidden target); or `INBOX_SWEEP_ROWS` names a `ClientId` or a wrong id instead of the row's list item id | `node tools/directory-bindings.mjs check`; the `inbox.sweep_mode` line's `rows` |
   | `inbox.row_failed`, `targetErrorKind` `forbidden` (`httpStatus` `403`) | The ingestion identity has no `write` grant on that client's site | Step 3's grant for `$INGEST_MI_APPID` |
   | `inbox.row_failed`, `targetErrorKind` `inbox_unusable` | The row's `RootFolder` is not a folder at the root of its drive: the channel was renamed, or its folder is missing | `check`, then `propose` and apply the whole plan |
   | `inbox.row_failed`, `targetErrorKind` `drive_mismatch` | The site's drive is no longer the row's `DriveId` (a recreated Team) | A rebind (admin guide → Changing a client). Nothing is swept there meanwhile |
   | `inbox.row_failed`, `targetErrorKind` `forbidden_site` | The row's site resolved to BCR GROUP or the quarantine | Incident indicator, as `sharepoint.forbidden_site` in step 13: tell Roman |
   | `inbox.row_failed` with no `targetErrorKind`, `graphStatus` 429/5xx | Graph failed after the sweep's own retries | Nothing to fix if it clears within a few ticks; otherwise check Graph's service health |
   | The canary never counts in `candidates` | It is in a subfolder, not at the top of the channel's files; or it is still changing (`skippedYoung`); or it predates `INBOX_CREATED_AFTER` (`skippedBeforeCutoff`); or `inbox.unexpected_child` was logged (Graph listed it with another parent) | Post it at the top of the channel files and wait 6 minutes. An `inbox.unexpected_child` line: stop, stay in `shadow`, and raise it |
   | `inbox.skipped` for the canary, `reason` `not_guest` or `unknown_user` | Graph's `createdBy` for the file is not the canary guest's own account: it was posted by someone else, or `createdBy.user.id` is not the guest's object id for channel posts | Check who posted it. If the canary guest did, stay in `shadow` and raise it: the sweep cannot tell a client's uploads apart |
   | `inbox.skipped`, `reason` `modified_by_other` | The file was last changed by someone who is not a guest of this Team (staff replaced it), or by no user at all | For a staff replace: expected, sort it by hand. For the canary, which nobody changed: Teams records an application as the last modifier of channel attachments; stay in `shadow` and raise it |
   | `inbox.skipped` for the canary, `reason` `not_in_team` | The canary guest is not a member of the canary Team (the group), as Entra reads it | `check`; fix the Team membership |
   | `inbox.skipped`, `reason` `unverified`, `status` `403`; `skippedUnverified` on every tick | The identity's token does not carry `Directory.Read.All` | H-8b, as for `membership_unverified` in step 13. Nothing moves meanwhile |
   | `inbox.skipped`, `reason` `changed`; `skippedChanged` | Someone moved, renamed, replaced or deleted the file after the tick listed it; the sweep leaves it where it now is | Nothing, unless the same file shows it every tick: then something rewrites it constantly (a sync client, an app); find what |
   | `deferred` above 0 on every tick | More files than `INBOX_MAX_FILES_PER_TICK`, or files that do not fit in the tick's time (slow Claude or Graph) | A backlog clears by itself at 20 files per tick; if it never shrinks, read `durationMs` and the `inbox.failed` lines |
   | `inbox.failed`, `stage` `folder` or `move`, `httpStatus` `403` | No `write` on that site | Step 3's grant. The file is tried again each tick, and after three failures the sweep tries `98_Nieposortowane` |
   | `inbox.failed`, `stage` `review_fallback` on every tick | Even the move to `98_Nieposortowane` fails | The file stays where it is. Read its earlier `inbox.failed` lines for the cause, and file it by hand |
   | `inbox.failed`, `stage` `move`, `targetErrorKind` `drive_mismatch` | Graph reported the moved file somewhere other than the target folder in the row's drive | Set `INBOX_SWEEP_MODE=off`, find the item by its `driveItemId`, and tell Roman |
   | The same-name canary (sub-step 5) left one file, not two | A move replaced an existing file: Graph does not fail a move onto a taken name in this tenant | `INBOX_SWEEP_MODE=off` at once; tell Roman. Nothing more is moved until the move is changed and proved again |
9. **Each further client** granted in step 3: apply, one at a time. Its proof is as PESKOVOI's
   (step 8): while `INBOX_SWEEP_ROWS` is set, add its list item id in `shadow` and review its
   lines as in the channel-inbox step's sub-step 7, then `enforce`; once the allow-list is gone,
   its first `inbox.tick` lines with no `inbox.row_failed` for its row, then its first
   `inbox.filed`. Never a BCR canary in its channel.
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
    applied, never skipped. Then run `check`: it must exit `0` (a `3` or `4` is acted on as in
    the [standing checks](#standing-checks)). From now on the standing checks apply.
13. **Watch for an hour:**

```bash
aiq 'traces | where cloud_RoleName startswith "func-bcr-ingest"
  | extend m = parse_json(message), msg = tostring(parse_json(message).msg)
  | where msg in ("document.filed", "document.quarantined", "document.quarantine_failed",
      "directory.conflict", "ingestion.caller.rejected",
      "sharepoint.forbidden_site", "sharepoint.possible_duplicate", "sharepoint.drive_mismatch",
      "membership.mismatch", "membership.unverified", "membership.check_off",
      "inbox.filed", "inbox.sorted_to_review", "inbox.failed", "inbox.row_failed",
      "inbox.tick_failed", "inbox.unexpected_child", "inbox.listing_truncated")
  | summarize count() by msg, reason = tostring(m.quarantineReason),
      kind = coalesce(tostring(m.kind), tostring(m.err.targetErrorKind)),
      status = coalesce(tostring(m.status), tostring(m.err.status)),
      httpStatus = tostring(m.err.httpStatus), stage = tostring(m.stage)' \
  <start of the window>
```

The `inbox.*` lines carry the error under `err` (`targetErrorKind`, `httpStatus`, Graph's
`status`); `coalesce` puts them in the same `kind` and `status` columns as the other lines.
`inbox.row_failed` and `inbox.failed` should be empty, or explained by the channel-inbox step's
table. `inbox.tick_failed`, `inbox.unexpected_child` and `inbox.listing_truncated` must be
empty. `sharepoint.drive_mismatch` must be empty.

`membership.check_off` must be empty: it means `MEMBERSHIP_CHECK_MODE=off` at a cold start.
`membership.mismatch` and `membership.unverified` carry `clientId`, `listItemId` and `teamId`,
so the row is known without any name; `membership.unverified` also carries Graph's `status`.

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
| `membership_mismatch` | The uploader's row is bound, but their Teams, read at upload time, are not exactly its `TeamId`: they are also in another Team (R46: for example a guest bound to one client and since added to another client's Team), or no longer in the row's Team | The check did its job: nothing was filed. Run `check`, then `propose` and apply the **whole** plan the same day (standing checks); staff triage the held documents by `UploaderOid` |
| `membership_unverified` on **every** bound upload | The ingestion identity cannot read Teams: H-8b's `Directory.Read.All` is missing, or not yet in its token (`status` 403 in `membership.unverified`) | Run H-8b's dry run: if it would still `POST`, the grant is missing, so make it. If it prints `already assigned`, the token predates the grant: restart the app (`az functionapp restart -g $RG -n $INGEST`), then check the channel-inbox canary again (a `skippedUnverified` with `status` 403 is the same missing grant). If that still fails, wait: the platform can keep the old token for up to 24 hours, and a refresh cannot be forced. The documents are held, not lost. Do not set `MEMBERSHIP_CHECK_MODE=off` to get past it: that reopens R46, and it is Roman's decision |
| `membership_unverified` on **some** uploads | One uploader's Teams could not be read: `status` 404 (the user was deleted) or 5xx (Graph failed after retries) | Nothing to fix in the app. A failure is never cached, so the next upload reads again; staff triage the held ones |

A batch that runs longer than 150 seconds returns the documents it had not started as rejected,
with the generic "spróbuj ponownie" code, rather than uploading them late. The user resends
those.

**After the window.** Phase 0 has **no alert rule**: alerting comes with the monitoring work in
Phase 1. Until then the [standing checks](#standing-checks) stand in for it.

**Rollback.**

- A binding: `node tools/directory-bindings.mjs rollback --log tools/out/<apply-log>.json` is a
  dry run; the same with `--apply` restores the before-state that `apply` printed, for every row
  in the log, or only for the rows named with `--only <listItemId>` (repeatable). What that
  means depends on what the apply did:
  - **It only bound the row and took no id off it** (TEST's apply in step 6, if TEST's row held
    no staff id): the rollback unbinds it, and that row's guests go to quarantine again. Safe.
  - **It took ids off the row** (a staff id, a guest now in another Team, the canary): the
    rollback would put them back, so it is **not safe by default**. Prefer running `propose`
    again and applying the whole plan. Before each PATCH, `rollback` re-checks every id it
    would add back exactly as `apply` re-checks a guest (a `Guest` whose Teams are exactly the
    row's `TeamId`). If any fails it refuses that row (`guest_recheck_failed`) and exits 2, so
    it never re-creates cross-client routing and never puts a staff id back. Step 8 is such a
    case: PESKOVOI's before-state holds Yahor's staff id, so its rollback is refused.

  To make a bound row route nobody at once, when its rollback is refused, set its `Status` to
  `Inactive` by hand (T-5's versioning records it). Within the Directory refresh (5 minutes;
  the emergency stop covers that time if needed) its guests' uploads go to quarantine as
  `unmapped`. Roman and Yahor then decide, and `check` shows the row before it is set `Active`
  again.
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
the query from T-5 (`directory refresh failed`) returns nothing, and a staff negative canary
(H-12 step 4) still ends in the quarantine: the Directory is still read. Once the channel inbox
is on, its `inbox.tick` lines show no `inbox.directory_unavailable`.

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

Only these two. The `*-p0-<stamp>.zip` packages the channel-inbox step saved are Phase-0 builds,
the rollback of that deploy; they are retired once the deploy after it is verified.

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
| `conflictBehavior=fail` everywhere | Unit tests, for uploads and for moves. For moves, where Microsoft documents no `conflictBehavior` and no overwrite rests on Graph's observed behaviour: the channel-inbox canary's same-name post was filed as `_1` in the canary Team (`nameSuffix` `1`, both files there). A same-name upload through the bot is not shown live: no guest can attach there, and staff uploads go to per-batch quarantine folders. That dropped proof is recorded in the incident's status table |
| App-id pinning is live | `BOT_CALLER_APP_IDS` set (H-8 verify); the `authMiddleware` unit test "rejects the right role held by an app that is not on the allow-list" passes in CI; a live token from another app registration is refused with 403. Such a token lacks `Documents.Ingest`, so the role check refuses it first and logs no `ingestion.caller.rejected`. Do not grant `Documents.Ingest` to a test app to produce one. |
| Every onboarded client's guest is bound, or quarantined with a known reason | H-7 and H-12 records in the incident's status table |
| The runtime membership check is on (R46 closed) | `/api/health` reports `"membershipCheck":"enforce"`; H-8b's dry run prints `already assigned`; the channel-inbox canary's guest file reached `inbox.would_move` and `inbox.filed`, which needs the ingestion identity to have read that guest's `userType` and Teams with `Directory.Read.All` (the functional proof that H-8b's grant is in the token); the resolver's membership tests pass in CI. The bot-path proof (a guest canary routed with `membership: verified`) cannot be produced, because no guest can send a file through the bot: it is recorded as dropped in the incident's status table, with who accepted that |
| Clients can send documents through their channel | `/api/health` reports `"inboxSweep":"enforce"` and `"inboxSweepRows":"all"`; the channel-inbox canary was filed inside the canary Team's channel (`inbox.filed` or `inbox.sorted_to_review`), and its same-name second came back with `nameSuffix` `1`; PESKOVOI's row was swept in `shadow` with no `inbox.row_failed`, Roman's decision on its older attachments is recorded, and its first real document was filed; the channel-inbox tests pass in CI |
| The IR-0 export is stored | H-2 verification |
| The taxonomy folders at the library root of every client site the ingestion identity could write to are Owners-only | T-4b's status row lists every such site (PESKOVOI, TEST and each site IR-1 added); **Check permissions** for each client's guest returns *None*; T-4b's check of the items outside those folders, after IR-1, is recorded for each site |
| The BCR GROUP root folders are Owners-only, including any created after the first lock | T-4's status row records the lock and the check after H-6b |
| The canary guest (H-5b) is bound to no row, and in no Team | `check \| grep -ci <canary id>` prints `0` (H-12 step 4), after the last canary, the channel-inbox step's clean-up (sub-step 6) included |
| The whole binding plan is applied, and the standing checks run | A `propose` at exit shows no PATCH row (every row NOOP, or SKIP with a recorded decision); the first weekly `check` is recorded in the incident's status table ([standing checks](#standing-checks)) |
| `CLAUDE.md` is updated | Merged with the promotion removal |
| CI runs coverage, green | The CI run on `main` |

### Standing checks

**Owner:** Yahor. **From:** H-12, until Phase 2 replaces the Directory.

A bound guest who is later added to a second client's Team (R46) is an ordinary business event:
one person running two companies. Onboarding invites the same email, gets the same guest back,
adds it to the new Team, and writes the new row with no user ids, so no Directory conflict is
raised. Before the runtime check, that guest kept routing everything, the second company's
documents included, into the first client's channel until the next `check` and apply of the
whole plan took the id off.

**R46 is now closed at runtime.** Ingestion reads each bound uploader's Teams from Entra at
upload time and routes only if they are exactly the row's `TeamId` (`MEMBERSHIP_CHECK_MODE`,
`enforce` by default; H-8b's grant). From at most 5 minutes after the guest joins the second
Team (the read is cached that long), their uploads are quarantined as `membership_mismatch`.
If the Teams cannot be read, uploads are quarantined as `membership_unverified`.

**The schedule below stays, as defence in depth.** It keeps the Directory saying what routing
does, it catches drift on rows whose guests have not uploaded since, and it is the only check
left if `MEMBERSHIP_CHECK_MODE=off` is ever set in an emergency. So still: `check` and an apply of
the **whole** plan after **every** onboarding, a `check` at least weekly, and action the same day
whenever `check` exits `3` or `4`. Phase 0 still has no alert rule. Onboarding writing the
guest's id into the new row itself (R1) waits on Roman's re-ruling of Q21.

| When | What | Why |
|---|---|---|
| After **any** onboarding | `propose` with H-12 step 5's flags, reviewed, then `apply` of the **whole** plan (a dry run, then `--apply`): never `--only <new row>`. Then `check`, acted on as in the next row | The whole plan carries the PATCH that takes a reused guest's id off the first client's row. A guest in two Teams is then bound to neither, and their uploads go to quarantine until a person decides |
| **Weekly**, and after any onboarding that reuses an existing guest | `check`. **Exit `3` and exit `4` both need action, the same day.** `3` is drift on a bound row: a row id marked *not eligible* (now in another Team, or no longer in the row's Team) or a staff id; `propose` and apply the whole plan. `4` is incomplete: a bound row could not be fully assessed, and the `incomplete` rows are listed; fix what stopped the read (a 403 is a missing permission, H-4a; or a site the signed-in person cannot read) and run `check` again until it exits `0`, or `3` and is acted on. A guest reported as `guest_in_other_team` also means: `propose` and apply the whole plan the same day | Catches Team changes made outside onboarding, and a guest who left their client's Team but can still file into its channel. An exit `4` hides whether that happened on the rows it lists |
| Before any negative canary | H-12 step 4's `check \| grep -ci <canary id>` prints `0` | A canary guest left on a row files into that client's channel |
| Every working day | The query below. A `document.quarantine_failed` row means: check H-6's grant and the quarantine library name first. A `sharepoint.forbidden_site` row is an incident indicator (H-12 step 13). A `membership.mismatch` row names a bound row one of whose guests is now in another Team, or no longer in its own: run `check`, then `propose` and apply the whole plan that day. Many `membership.unverified` rows with `status` 403, or any `membership.check_off`, mean the check is not working: H-12 step 13's table. Once the channel inbox is on, also the inbox query after it: `ticks` `0`, or `skippedUnverified` on most ticks, means clients' files are not being filed | A failed quarantine write is fail-closed (the user gets "spróbuj ponownie", nothing is written anywhere else), but if the quarantine grant or `QUARANTINE_DRIVE_NAME` breaks, every unbound, staff and stale upload is refused and nobody is told. A lost membership grant holds every client's uploads just as quietly |

```bash
aiq 'traces | where cloud_RoleName startswith "func-bcr-ingest"
  | extend m = parse_json(message), msg = tostring(parse_json(message).msg)
  | where msg in ("document.quarantine_failed", "sharepoint.forbidden_site",
      "membership.mismatch", "membership.unverified", "membership.check_off",
      "inbox.row_failed", "inbox.failed", "sharepoint.drive_mismatch")
  | project timestamp, itemCount, msg, quarantineReason = tostring(m.quarantineReason),
      listItemId = tostring(m.listItemId),
      kind = coalesce(tostring(m.kind), tostring(m.err.targetErrorKind)),
      status = coalesce(tostring(m.status), tostring(m.err.status)),
      httpStatus = tostring(m.err.httpStatus), stage = tostring(m.stage),
      driveItemId = tostring(m.driveItemId)' \
  <24 hours ago, UTC>
```

Once the channel inbox is on (H-12's channel-inbox step), an `inbox.row_failed` row means one client's
channel is not being swept, and an `inbox.failed` row with `stage` `review_fallback` a file that
stays at the top of a client's channel: both are read with that step's table.

**The channel inbox is every client's only intake, and it can stop without a single failure
line:** the timer may not fire at all (a deploy by package URL without a trigger sync), or every
uploader read may fail for days (a lost `Directory.Read.All`), which counts files as
`skippedUnverified`, not as failures. So, every working day while `/api/health` reports
`"inboxSweep":"enforce"`, run this too:

```bash
aiq 'traces | where cloud_RoleName startswith "func-bcr-ingest"
  | extend m = parse_json(message), msg = tostring(parse_json(message).msg)
  | where msg startswith "inbox."
  | summarize ticks = countif(msg == "inbox.tick"),
      tickFailed = countif(msg == "inbox.tick_failed"),
      unexpectedChild = countif(msg == "inbox.unexpected_child"),
      listingTruncated = countif(msg == "inbox.listing_truncated"),
      unverifiedFiles = dcountif(tostring(m.driveItemId),
        msg == "inbox.skipped" and tostring(m.reason) == "unverified"),
      filed = sumif(toint(m.filed), msg == "inbox.tick"),
      sortedToReview = sumif(toint(m.sortedToReview), msg == "inbox.tick"),
      skippedUnverified = sumif(toint(m.skippedUnverified), msg == "inbox.tick"),
      skippedChanged = sumif(toint(m.skippedChanged), msg == "inbox.tick"),
      deferred = sumif(toint(m.deferred), msg == "inbox.tick"),
      rowsFailed = sumif(toint(m.rowsFailed), msg == "inbox.tick")' \
  <24 hours ago, UTC>
```

| Column | Expect | Otherwise |
|---|---|---|
| `ticks` | About 720 (one every 2 minutes), and never `0` | `0`: the timer is not running. `az functionapp function list -g $RG -n $INGEST --query "[].name" -o tsv` must list `inboxSweep`; sync the triggers (H-12, the channel-inbox step's sub-step 1); check `/api/health`. Far fewer than 720: ticks are overlapping or the app is restarting; read `durationMs` |
| `tickFailed`, `unexpectedChild`, `listingTruncated` | `0` | The channel-inbox step's table; an `inbox.unexpected_child` is raised with Roman |
| `skippedUnverified`, `unverifiedFiles` | `0`, or a few that clear the next day | On most ticks: uploader reads are failing (403: H-8b's grant; 5xx: Graph). No client file moves meanwhile |
| `deferred` | `0`, or falling | Above 0 every day: a backlog or slow ticks; the channel-inbox step's table |
| `rowsFailed` | `0` | One client's channel is not swept: the `inbox.row_failed` lines in the query above name it |

Record the date of each weekly `check` and each post-onboarding apply, with the apply log's
hash, in the incident's status table.
