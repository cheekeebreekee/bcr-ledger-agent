# Human steps

Written for the people who hold the roles the code cannot hold: Roman (business owner and
subscription Owner), the Global Admin, the SharePoint Administrator, the Teams Administrator,
and Yahor (developer and operator). Every step names who runs it, the exact command, how to see
that it worked, and how to undo it.

The steps are in the order they must happen. Some wait on the previous step for a reason, and
that reason is given. Skipping ahead is how an upload gets rejected, or filed in the wrong place.

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
RG=rg-bcr-ledger-dev                      # "dev" is production: it serves PESKOVOI
BOT=func-bcr-bot-dev-<suffix>             # names in PROJECT_OVERVIEW.md → Azure environment
INGEST=func-bcr-ingest-dev-<suffix>
APPI=appi-bcr-dev-<suffix>
SP_HOST=<tenant>.sharepoint.com
BOT_APP_ID=$(az functionapp config appsettings list -g $RG -n $BOT \
  --query "[?name=='MICROSOFT_APP_ID'].value | [0]" -o tsv)
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
| H-3 | Optional: stop promotion today with a setting | Roman decides, Yahor runs | today | H-2 |
| H-4 | Tenant hardening T-1 to T-9 | per step | today–tomorrow | T-4, T-5 before H-12 |
| H-5 | Quarantine site | SharePoint Admin | day 1 | — |
| H-6 | Ingestion identity write grant on quarantine | Global Admin | day 1 | H-5 |
| H-7 | Directory check and new columns | Yahor | day 1 | — |
| H-8 | New app settings, added | Yahor | day 1 | H-5 |
| H-9 | Bot deploy, gate in `log` | Yahor | day 1 | H-2, H-8 |
| H-10 | Manifest 0.2.0 and availability | Teams Admin | day 1 | H-9 |
| H-11 | Gate to `enforce` | Yahor | day 2 | 24 h of clean logs |
| H-12 | Change window: ingestion, bindings, canaries | Yahor, Roman reviews | day 2–3 | H-6, H-7, H-11, T-4, T-5 |
| H-13 | Ingestion grant on BCR GROUP to `read` | Global Admin | after H-12 | H-12 verified |
| H-14 | `FALLBACK_*` settings removed | Yahor | ≥ 24 h after H-12 | H-12 verified |
| H-15 | Exit criteria checked | Yahor, Roman | end of phase | all |

IR-1 (inventory) and IR-2 (relocation) run alongside, from the day H-2 is stored. They are
described in the incident doc.

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
exports), Global Admin (Purview export). **When:** today. App Insights keeps 30 days, and each
day of delay deletes a day of evidence. This must also happen **before H-9 and H-12**, because the
Phase-0 code changes what is logged.

What to export, and why each join works, is in
[incident → IR-0](incident-2026-09.md#ir-0-preserve-the-evidence-first). Every script is
described, with all its flags, in [`tools/README.md`](../../tools/README.md).

```bash
# 1. The trace export (Yahor). 24-hour chunks over the last 30 days; writes the files,
#    the query, export-meta.txt and SHA256SUMS under tools/out/ (git-ignored).
tools/ir0/export-appinsights.sh --app <App Insights component> --resource-group rg-bcr-ledger-dev

# 2. The Purview export (Global Admin, PowerShell 7, "View-Only Audit Logs" role).
#    Sites: BCR GROUP, PESKOVOI, TEST.
Connect-ExchangeOnline -UserPrincipalName <auditor>
./tools/ir0/export-purview.ps1 -SiteUrl <BCR GROUP url>, <PESKOVOI url>, <TEST url> -StartDate <UTC>

# 3. The store (Roman): an immutable container outside BCR GROUP, readable by Roman, the IOD
#    and yahor.simak@bcr-group.pl only. A dry run first; --apply refuses until both UPNs are set.
ROMAN_UPN=<roman> IOD_UPN=<iod> infrastructure/ir/evidence-store.sh \
  --resource-group rg-bcr-ir-evidence --account <storage account> \
  --upload-dir tools/out/<export folder> --grant-uploader
ROMAN_UPN=<roman> IOD_UPN=<iod> infrastructure/ir/evidence-store.sh \
  --resource-group rg-bcr-ir-evidence --account <storage account> \
  --upload-dir tools/out/<export folder> --grant-uploader --apply
```

**Verify.**

- The container lists every export plus `SHA256SUMS`.
- `az role assignment list --scope <container-scope> -o table` shows Storage Blob Data Reader for
  exactly three principals, and write access for nobody once the upload is done.
- The immutability policy shows the retention date the IOD set.
- The laptop copies are deleted, and their hashes are in the incident's status table.

**Rollback.** None, on purpose: the evidence is immutable. If the retention period is wrong,
the IOD sets the right one before the policy is locked.

### H-3: Optional: stop promotion today, without a deploy

**Owner:** Roman decides; Yahor runs it. **Not in the approved plan.** It is a proposal made
while writing this checklist, and it needs Roman's yes.

Content promotion (root cause R3) needs the `parties[]` that only the Claude classifier
extracts. With `ANTHROPIC_ENABLED=false`, the running ingestion uses only the deterministic
fallback classifier. That classifier extracts no parties, so **nothing can be promoted into a
client's site**, and no document content leaves Azure. The cost is that every new upload goes to
`98_Nieposortowane/YYYY/MM/` for an accountant to sort. Today, unrouted uploads already land in
the fallback bucket, so for real clients the loss is small.

```bash
az functionapp config appsettings set -g $RG -n $INGEST --settings ANTHROPIC_ENABLED=false -o none
```

**Verify.** `az functionapp config appsettings list -g $RG -n $INGEST --query "[?name=='ANTHROPIC_ENABLED']" -o table`
reads `false`. After the restart, `aiq 'traces | where tostring(parse_json(message).msg) == "promoted fallback → directory client via content NIP match"' <time of the change>`
stays empty.

**Rollback.** Set it back to `true`. H-12 does that anyway, because the Phase-0 build has no
promotion.

### H-4: Tenant hardening

**Owner:** per step. **When:** today and tomorrow. Run T-1 to T-9 from
[`tenant-hardening.md`](tenant-hardening.md). T-10 comes with H-10.

These must be done before H-12:

- **T-4** (lock the ledger folders at the BCR GROUP root), because IR-2 needs the fallback
  documents to stay put and unread until they are moved;
- **T-5** (lock and version the Client Directory), because H-12 edits the rows, and versioning
  is the record of that edit.

The Directory row edits themselves wait for H-12.

### H-5: Create the quarantine site

**Owner:** SharePoint Administrator. **When:** day 1.

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

**Library columns.** After each upload, ingestion writes four columns on the quarantined item, so
triage can decide from the uploader's identity rather than from content. They must exist, with
exactly these names, as single lines of text:

```bash
Q_SITE=$(g "$G/sites/$SP_HOST:/sites/BCRLedgerKwarantanna?\$select=id" | jq -r .id)
Q_LIST=$(g "$G/sites/$Q_SITE/drive/list?\$select=id" | jq -r .id)
g "$G/sites/$Q_SITE/drive?\$select=name"          # the library name; on this tenant, Dokumenty
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
**When:** day 1, after H-5.

The onboarding repo's runbook `Grant-TeamSiteAccess.ps1` makes the grant. It runs in the
onboarding Automation account, whose identity holds `Sites.FullControl.All`. A person starts the
job; no ledger identity gets any role on that account.

```bash
az automation runbook start -g rg-bcr-onboarding-dev --automation-account-name aa-bcr-onboarding-dev \
  -n Grant-TeamSiteAccess --parameters SiteId="$Q_SITE" AppId="$INGEST_MI_APPID" \
  AppDisplayName="BCR ledger ingestion"
```

`AppId` is the managed identity's *application* id, not its object id. The variables above
derive it, so nobody types a GUID.

**Verify.** The job output is one JSON line with `"outcome": "granted"` (or `"exists"`). Per-site
grants take about 5 minutes to take effect. The functional proof is the quarantine canary in
H-12.

**Rollback.** In Graph Explorer, with `Sites.FullControl.All` consented (see
[`admin-sharepoint-grant.md`](../admin-sharepoint-grant.md)):
`DELETE /sites/{Q_SITE}/permissions/{permissionId}`.

### H-7: Check the Directory before the deploy, and add the new columns

**Owner:** Yahor, with Roman for the decisions. **When:** day 1. Read-only, except for the two
new columns.

`tools/directory-bindings.mjs` runs with a delegated Graph token. By default it reads and
changes nothing. The flags below match [`tools/README.md`](../../tools/README.md);
`node tools/directory-bindings.mjs --help` is authoritative. For the token, see that README's
"Authentication" section: the `az` token has no SharePoint scopes.

```bash
export GRAPH_TOKEN=$(node ../bcr-onboarding-agent/tools/graph-login.mjs)
node tools/directory-bindings.mjs check
```

For every row, `check` reports:

- staff ids on client rows;
- duplicate ClientIds, NIPs and targets;
- whether the client's Team is Private and its channel is standard;
- whether the ingestion identity has write on the row's site;
- whether the guests are in exactly one client Team.

Decide what happens to each finding **before** H-12, and write the decisions in the incident's
status table:

- **The duplicate `0002`.** Two live rows carry PESKOVOI's ClientId. The tool refuses to change
  rows with a duplicate ClientId. Roman decides which row is PESKOVOI's: it is the one whose
  `SitePath` is PESKOVOI's site. Set the other row to `Status = Inactive` by hand. Versioning (T-5)
  records the edit. Then run `check` again.
- **Onboarded clients whose site has no ingestion grant.** Today the ingestion identity can write
  only to TEST, BCR GROUP and PESKOVOI. For each other onboarded client, either grant it now
  (H-6's runbook, with that client's site id) so the client can be bound in H-12, or record that
  it stays quarantined, and why.
- **Anything else the check flags** (a non-standard channel, a guest in several teams): that row
  is not bound in Phase 0, and its uploads go to quarantine. Record the reason.

Then add the two new columns, `DriveId` and `TeamId`. The code running today does not read
them.

```bash
node tools/directory-bindings.mjs --add-columns           # dry run: says what it would create
node tools/directory-bindings.mjs --add-columns --apply
```

**Verify.** The list has `DriveId` and `TeamId`, and `check` has no unresolved finding without a
recorded decision. **Rollback.** Delete the two columns; they are empty until H-12.

### H-8: Add the new app settings

**Owner:** Yahor. **When:** day 1, after H-5, and **before any deploy**.

The Phase-0 build refuses to start without these settings, and the bot's gate defaults to
`enforce`. So they go in first. The code running now ignores settings it does not know, so
adding them early is harmless. `appsettings set` merges; it never removes a setting.

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
| `BOT_CALLER_APP_IDS` | The bot's app id, read from the bot's own settings. Only this app may call ingestion. |
| `QUARANTINE_*` | The site from H-5. `Dokumenty` because the site was created with the Polish locale; use what H-5's drive read returned. |
| `FORBIDDEN_TARGET_SITE_PATHS` | BCR GROUP. No Directory row may ever route there. The code adds the quarantine path itself. |
| `CLIENT_DIRECTORY_MAX_STALE_MS` | 15 minutes. After that, a directory that cannot be refreshed routes nothing. |
| `BOT_GATE_MODE=log` | For the first 24 hours the gate records refusals but lets turns through (H-11). |
| `MICROSOFT_APP_TYPE` | Now required. `SingleTenant`, because the bot's app registration is single-tenant. |

**Verify.**

```bash
az functionapp config appsettings list -g $RG -n $INGEST -o table --query \
  "[?starts_with(name,'QUARANTINE_') || name=='BOT_CALLER_APP_IDS' || name=='FORBIDDEN_TARGET_SITE_PATHS' || name=='CLIENT_DIRECTORY_MAX_STALE_MS'].{name:name,value:value}"
az functionapp config appsettings list -g $RG -n $BOT -o table --query \
  "[?name=='BOT_GATE_MODE' || name=='MICROSOFT_APP_TYPE'].{name:name,value:value}"
```

**Rollback.** `az functionapp config appsettings delete -g $RG -n <app> --setting-names <names> -o none`.
Only needed if a value was wrong. The code running now does not read these settings.

### H-9: Deploy the bot with the gate in log mode

**Owner:** Yahor. **When:** day 1, after H-2 and H-8.

The bot goes first because the Phase-0 ingestion rejects any batch without
`conversationType: 'personal'`, and only the new bot sends it. The new bot also stops calling
`/api/user-target`, removes the tab's data, and shows no model text on cards.

```bash
corepack yarn install --immutable && corepack yarn build && corepack yarn test
corepack yarn workspace @bcr/teams-bot package                 # → artifacts/teams-bot.zip

# How is the app running its code? Print only the scheme, never the value (it can hold a SAS token).
az functionapp config appsettings list -g $RG -n $BOT \
  --query "[?name=='WEBSITE_RUN_FROM_PACKAGE'].value | [0]" -o tsv | cut -c1-8
```

- **`1`, or nothing:** deploy the zip.
  `az functionapp deployment source config-zip -g $RG -n $BOT --src artifacts/teams-bot.zip`.
  Retry once if the upload flakes (lesson 7 in `PROJECT_OVERVIEW.md`).
- **`https://`:** the app runs from a blob URL (lesson 19). Upload the zip as a **new** blob,
  make a SAS for it, and set `WEBSITE_RUN_FROM_PACKAGE` to the new URL with `-o none`. Keep the
  old URL. It is the rollback.

**Verify.**

1. The TEST guest opens the bot DM and sends `pomoc`. The help card comes back.
2. That message produced no gate refusal:

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

**Rollback.** Redeploy the previous bot build (or set the previous blob URL back). The previous
bot and the current ingestion work together, because ingestion has not changed yet.

### H-10: Upload manifest 0.2.0 and set availability

**Owner:** Teams Administrator. **When:** after H-9.

Follow [T-10 in tenant-hardening](tenant-hardening.md#t-10-teams-app-availability-for-the-bot).
Version 0.2.0 has personal scope only and no "Moje dokumenty" tab. Tell the clients before they
see the change: the tab disappears, and a document the bot cannot place now says "Dokument
przekazano do weryfikacji przez zespół BCR" instead of showing a link.

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

- once the Phase-0 ingestion is live, every onboarded guest is unmapped and goes to quarantine
  until their row is bound;
- binding a row is only safe once the code that encodes `Dokumenty księgowe` and never follows
  content is live;
- a canary proves each binding before real uploads use it.

**Preconditions, all true:**

- IR-0 is stored (H-2). This deploy changes the logs.
- H-6's grant is in place.
- H-8's settings are present.
- The gate is in `enforce` (H-11).
- T-4 and T-5 are done.
- Every H-7 finding has a decision.

**Emergency stop,** at any point: `az functionapp stop -g $RG -n $INGEST`. Nothing is filed
anywhere; users get the bot's generic error. `az functionapp start` resumes.

1. **Deploy ingestion,** code only, as in H-9, with the `document-ingestion` package.
2. **Check that it is the Phase-0 build.**
   `curl -s https://$INGEST.azurewebsites.net/api/health` reports the Phase-0 build:
   `"build":{"phase":"p0","routing":"identity-only"}`. The tool enforces this itself when you
   pass `--health-url https://$INGEST.azurewebsites.net/api/health --expect-health build.routing=identity-only`.
   `directory-bindings.mjs` refuses to apply until it does.
3. **Negative canary: quarantine.** A canary guest bound to no row uploads a synthetic PDF. The
   canary guest is a BCR-controlled outside account, invited as a guest and in no client Team.
   Expect:
   - the card says "Dokument przekazano do weryfikacji przez zespół BCR", with no link;
   - the file is on the quarantine site under `Kwarantanna/YYYY/MM/<batchId>/`, with
     `UploaderOid`, `QuarantineReason = unmapped`, `OriginalFilename` and `DocumentId` filled in;
   - a `document.quarantined` log line appears.
4. **Propose, and have it reviewed.** `node tools/directory-bindings.mjs propose` writes a plan
   under `tools/out/`. The plan holds client data and never leaves that folder. Roman and Yahor
   read it row by row:
   - `UserAadObjectIds` holds only that Team's guests, and no staff;
   - `RootFolder` is the channel folder's name as Graph returns it;
   - `DriveId` and `TeamId` are set;
   - host, path and drive are unchanged.
5. **Apply TEST first.** A dry run, then the same with `--apply`:

   ```bash
   node tools/directory-bindings.mjs apply --plan tools/out/<plan>.json --only <TEST listItemId> \
     --health-url https://$INGEST.azurewebsites.net/api/health \
     --expect-health build.routing=identity-only            # then again with --apply
   ```

   The tool prints each row before and after, and writes a rollback log. It refuses a plan older
   than 24 hours, a row changed since `propose`, and a health endpoint that is not the P0 build.
6. **Canary on TEST.** The TEST guest uploads a synthetic PDF. Expect:
   - it lands in TEST's `Dokumenty księgowe/…`, visible in the channel's files tab;
   - the card's link opens it there;
   - a `document.filed` line appears.

   Then delete the canary file.
7. **Apply PESKOVOI, then canary.** This apply also takes Yahor's id off the row. For a real
   client, the canary must come from an identity bound to that client, and there are two ways:
   - by arrangement, the client's contact sends the synthetic canary file BCR gives them; or
   - BCR's canary guest joins that one client Team for the canary only. At that moment it is in
     no other client Team. Afterwards it leaves, and the tool is run again to take its id off
     the row.

   Never use a real client document, and never a staff account, because staff go to quarantine
   by design.
8. **Each further client** with a grant (from H-7): apply, then canary, one at a time.
9. **Staff.** If you want staff uploads recorded as `staff` rather than `unmapped`, add one
   `IsAdmin = Yes` row with the staff ids and no target. Staff ids never go on a client row.
10. **If H-3 was used:** `az functionapp config appsettings set -g $RG -n $INGEST --settings ANTHROPIC_ENABLED=true -o none`.
11. **Watch for an hour:**

```bash
aiq 'traces | where cloud_RoleName startswith "func-bcr-ingest"
  | extend m = parse_json(message), msg = tostring(parse_json(message).msg)
  | where msg in ("document.filed", "document.quarantined", "directory.conflict", "ingestion.caller.rejected")
  | summarize count() by msg, reason = tostring(m.quarantineReason), kind = tostring(m.kind)' \
  <start of the window>
```

`directory.conflict` should be empty, or explained by a decision from H-7.
`ingestion.caller.rejected` should be empty.

**Rollback.**

- A binding: `node tools/directory-bindings.mjs rollback --log tools/out/<apply-log>.json --apply`
  (a dry run without `--apply`) restores the before-state it printed. That row's guests then go to quarantine, which is safe.
- The ingestion build: stop the app, revert the offending commit, rebuild and deploy. **Never
  redeploy a pre-Phase-0 ingestion zip.**
- The bot keeps running either way.

### H-13: Downgrade the ingestion grant on BCR GROUP to read

**Owner:** Global Admin, in Graph Explorer with `Sites.FullControl.All` consented. **When:**
after H-12 is verified.

Ingestion still has to read the Client Directory on the BCR GROUP site, and must never write
there again. `FORBIDDEN_TARGET_SITE_PATHS` already stops it in code. This step removes the
ability as well.

```
GET   https://graph.microsoft.com/v1.0/sites/<bcr-group-site-id>/permissions
      → the entry whose grantedToIdentitiesV2.application.id is the ingestion identity's app id
PATCH https://graph.microsoft.com/v1.0/sites/<bcr-group-site-id>/permissions/<permissionId>
      {"roles":["read"]}
```

**Verify.** The GET shows `"roles": ["read"]`. For the next 30 minutes, the query from T-5
(`directory refresh failed`) returns nothing, and an upload by the TEST guest still files
correctly.

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

**Verify.** `az functionapp config appsettings list -g $RG -n $INGEST --query "[?starts_with(name,'FALLBACK_')]" -o table`
is empty, and `/api/health` answers. **Rollback.** Not needed: the settings are only used by a
build that must not come back.

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
| App-id pinning is live | `BOT_CALLER_APP_IDS` set; `ingestion.caller.rejected` appears for a token from any other app |
| Every onboarded client's guest is bound, or quarantined with a known reason | H-7 and H-12 records in the incident's status table |
| The IR-0 export is stored | H-2 verification |
| `CLAUDE.md` is updated | Merged with the promotion removal |
| CI runs coverage, green | The CI run on `main` |
