# Tenant hardening, Phase 0

Written for whoever holds the admin roles in the BCR tenant, and for whoever checks the tenant
later and wants to know why it is set up this way.

These are the tenant-side steps of the containment for incident
[`IR-2026-09`](incident-2026-09.md). None of them needs a code deploy, and most can run today.
Each step gives the role that can run it, why it exists, the command to read the current state,
the command that changes it, how to verify it, and how to undo it. The order of these steps
relative to the deploys is in [`human-steps.md`](human-steps.md#phase-0).

⚠️ **Three rules for every step on this page.**

- **BCR GROUP stays Private, and this page does not change the team.** Its visibility, its
  membership and its channels are untouched. [T-3](#t-3-confirm-bcr-group-is-private-read-only) only
  reads. [T-4](#t-4-lock-the-ledger-folders-at-the-bcr-group-library-root) and
  [T-5](#t-5-lock-and-version-the-client-directory-list) change permissions on two things *inside*
  its site: the ledger's own folders, and the routing list.
- **Nothing here deletes or moves a client document.** Documents stay where IR-1 finds them, and
  IR-2 moves them later, with two people signing off.
- **Save every "before" output.** The rollback needs it. Save it in the IR evidence store with the
  IR-0 exports, not on a laptop. It can contain user names and group ids.

## Tokens

```bash
# Reads of users, groups and policies: the Azure CLI's token is enough.
az login --tenant <tenant-id>
export GRAPH_TOKEN=$(az account get-access-token --resource https://graph.microsoft.com --query accessToken -o tsv)

# Writes to the directory, and anything in SharePoint: use a delegated token from an app
# registration BCR owns. The Azure CLI's own app is not pre-authorised for those scopes
# (AADSTS65002), and Microsoft will not change that per tenant. The helper lives in the
# onboarding repo; its header says how to set it up once.
export GRAPH_TOKEN=$(node ../bcr-onboarding-agent/tools/graph-login.mjs)
export SHAREPOINT_TOKEN=$(node ../bcr-onboarding-agent/tools/graph-login.mjs --sharepoint <tenant>.sharepoint.com)

g()  { curl -sS -H "Authorization: Bearer $GRAPH_TOKEN" -H 'Content-Type: application/json' "$@"; }
sp() { curl -sS -H "Authorization: Bearer $SHAREPOINT_TOKEN" -H 'Accept: application/json;odata=nometadata' "$@"; }
G=https://graph.microsoft.com/v1.0
```

`<tenant>` is the SharePoint tenant name and `<tenant-id>` the Entra tenant id. Both are in
`PROJECT_OVERVIEW.md`. Tokens expire after about an hour, and they never go in a file.

---

## T-1: Block sign-in on the {NIP}@ client addresses

| Runs it | Decides | Closes |
|---|---|---|
| User Administrator or Global Admin | Agreed with Roman, 25 Sep | Window W3 in the incident |

**Why.** A client address `{NIP}@bcr-group.pl` is meant to be a shared mailbox that nobody signs
in as. On 23 September all three were enabled, licensed members. An enabled member is an
internal account: it can join any Public team, it reaches Viva Engage Communities, and it can
read the address list. Blocking sign-in is enough to stop all of that, and it is safe: the
mailbox keeps receiving mail, and the onboarding app still reads it with its own application
permission.

The onboarding repo's tool finds the addresses and blocks them. It does nothing else.

```bash
cd ../bcr-onboarding-agent

# Before: read-only. Lists every {NIP}@ account, its sign-in state, licences and groups.
GRAPH_TOKEN=$(az account get-access-token --resource https://graph.microsoft.com --query accessToken -o tsv) \
  node tools/audit-client-access.mjs > t1-before.txt

# Apply: blocks sign-in on the accounts it marked RESTRICT, and nothing else.
GRAPH_TOKEN=$(node tools/graph-login.mjs) node tools/audit-client-access.mjs --apply
```

**Verify.** Run the read-only command again. No account is marked `RESTRICT` for sign-in. For
one account:

```bash
az rest --url "$G/users/<nip>@bcr-group.pl?\$select=accountEnabled"     # "accountEnabled": false
```

**Rollback.** `g -X PATCH "$G/users/<nip>@bcr-group.pl" -d '{"accountEnabled":true}'`. You should
not need it: a blocked shared mailbox still receives mail.

**Afterwards, optional.** Take each address out of its client Team:
`g -X DELETE "$G/groups/<team-id>/members/<user-id>/\$ref"`. A mailbox has no reason to be a
member of anything. Once sign-in is blocked this is tidying, not a fix. Undo it with
`g -X POST "$G/groups/<team-id>/members/\$ref" -d '{"@odata.id":"https://graph.microsoft.com/v1.0/directoryObjects/<user-id>"}'`.

## T-2: Convert the mailboxes to shared, then remove the licences

| Runs it | Decides | Closes |
|---|---|---|
| Exchange Administrator (convert), then License or User Administrator (unlicense) | Agreed with Roman | W3, and gives back three paid seats |

⚠️ **The order matters.** If you remove the licence from an account whose mailbox is still a
*user* mailbox, Microsoft starts a 30-day clock that deletes the mailbox, and the client's
documents in it. Convert first, confirm the conversion, and only then remove the licence.

```powershell
Connect-ExchangeOnline
Get-Mailbox -Identity <nip>@bcr-group.pl | Format-List RecipientTypeDetails   # before: UserMailbox
Set-Mailbox -Identity <nip>@bcr-group.pl -Type Shared
Get-Mailbox -Identity <nip>@bcr-group.pl | Format-List RecipientTypeDetails   # must read SharedMailbox
```

Only when all three read `SharedMailbox`, remove the licence. In the Microsoft 365 admin
centre: **Users → Active users → the account → Licenses and apps**, untick, then **Save**. With
Graph:

```bash
az rest --url "$G/users/<nip>@bcr-group.pl/licenseDetails?\$select=skuId,skuPartNumber"   # note the skuId
g -X POST "$G/users/<nip>@bcr-group.pl/assignLicense" -d '{"addLicenses":[],"removeLicenses":["<skuId>"]}'
```

**Verify.** `az rest --url "$G/users/<nip>@bcr-group.pl?\$select=accountEnabled,assignedLicenses"`
returns `false` and `[]`. Send a test mail from a staff account to each address and check that
it arrives. A shared mailbox holds up to 50 GB without a licence.

**Rollback.** Assign the licence again, then `Set-Mailbox -Identity … -Type Regular`. Only do
this if an address was converted by mistake.

## T-3: Confirm BCR GROUP is Private (read-only)

| Runs it | Decides | Closes |
|---|---|---|
| Anyone with directory read | Nothing to decide; this is a check | Records the end of window W2 |

**Why.** BCR GROUP was Public on 23 September, so any internal account could join it and read
the fallback bucket. It was made Private between 23 and 25 September. It is intentionally
Private and stays that way. This step only proves it, and records who is in the team, because
the members are the audience of window W1.

```bash
az rest --url "$G/groups?\$filter=displayName eq 'BCR GROUP'&\$select=id,displayName,visibility"
az rest --url "$G/groups/<bcr-group-id>/members?\$select=displayName,userPrincipalName,userType"
az rest --url "$G/groups/<bcr-group-id>/owners?\$select=displayName,userPrincipalName"
```

**Verify.** `"visibility": "Private"`. If it reads anything else, stop and tell Roman at once.
Do not change it from here. Take the exact time it became Private from the Purview
`Update group.` event in the IR-0 export, and write it in the incident's status table.

**Rollback.** None. Nothing changes.

## T-4: Lock the ledger folders at the BCR GROUP library root

| Runs it | Decides | Closes |
|---|---|---|
| A BCR GROUP site owner, or SharePoint Administrator | Agreed with Roman | W1 for documents already in the fallback bucket |

**Why.** Every upload the ledger could not route went to the root of the BCR GROUP team library,
in the ledger's own taxonomy folders. Those folders hold documents from every client, and every
member of the team can read them: `AuthoriseMe@` today, and any accountant added to BCR GROUP
later. Stopping inheritance and leaving only the Owners closes that. The documents stay exactly
where IR-1 finds them.

**What gets locked: only the ledger's taxonomy folders at the library root.** They are the
top-level folders from [`folderTaxonomy.ts`](../../packages/shared/src/parsers/folderTaxonomy.ts),
where they exist:

```
01_Faktury  02_Wyciągi_bankowe  03_Raporty_marketplace  04_Umowy  05_Dokumenty_firmowe_ustawowe
06_Kadry_i_płace  07_Deklaracje_i_JPK  08_Korespondencja  09_Raporty  10_Środki_trwałe
11_Ewidencja_VAT  12_Onboarding_i_reguły  13_Inne  98_Nieposortowane
```

⚠️ **Never a channel folder.** The library root also holds one folder per channel of the team
(the general channel, `Onboarding klientów`, and any others). Those belong to the team's channels
and are not touched. If a channel folder ever has the same name as a taxonomy folder, stop and
ask; do not lock it.

**Read first.**

```bash
SITE_ID=$(g "$G/sites/<tenant>.sharepoint.com:/sites/BCRGROUPSp.zo.o?\$select=id" | jq -r .id)
g "$G/sites/$SITE_ID/drive?\$select=name,webUrl"                          # the library's URL
g "$G/sites/$SITE_ID/drive/root/children?\$select=name,folder" | jq -r '.value[].name'
g "$G/teams/<bcr-group-id>/channels?\$select=displayName,membershipType" | jq -r '.value[].displayName'
```

Save the list of root folders, and mark which are taxonomy folders and which are channel folders.

**Change: in the browser.** This is the clearest way, and there are at most 14 folders. On the
BCR GROUP site, open the document library. For each taxonomy folder: **⋯ → Manage access →
Advanced settings → Stop Inheriting Permissions**. Then tick the site's **Members** and
**Visitors** groups and click **Remove User Permissions**. The site's **Owners** group stays.

**Change: scripted,** with the same effect. `LIB` is the library path from `webUrl` above,
decoded, for example `/sites/BCRGROUPSp.zo.o/Shared Documents`.

```bash
WEB=https://<tenant>.sharepoint.com/sites/BCRGROUPSp.zo.o
LIB='/sites/BCRGROUPSp.zo.o/Shared Documents'
MEMBERS=$(sp "$WEB/_api/web/AssociatedMemberGroup?\$select=Id" | jq .Id)
VISITORS=$(sp "$WEB/_api/web/AssociatedVisitorGroup?\$select=Id" | jq .Id)

item() {  # the folder's list item, with the path percent-encoded
  local p; p=$(jq -rn --arg p "$LIB/$1" '$p|@uri')
  echo "$WEB/_api/web/GetFolderByServerRelativePath(decodedurl='$p')/ListItemAllFields"
}

for F in 01_Faktury 02_Wyciągi_bankowe 98_Nieposortowane; do   # the taxonomy folders that exist
  I=$(item "$F")
  sp -X POST "$I/breakroleinheritance(copyRoleAssignments=true,clearSubscopes=true)"
  sp -X POST "$I/roleassignments/getbyprincipalid($MEMBERS)/deleteobject()"
  sp -X POST "$I/roleassignments/getbyprincipalid($VISITORS)/deleteobject()"
done
```

**Verify,** for each folder:

```bash
I=$(item 01_Faktury)
sp "$I?\$select=HasUniqueRoleAssignments"                                 # true
sp "$I/roleassignments?\$expand=Member&\$select=Member/Title" | jq -r '.value[].Member.Title'
```

Only the site's Owners group is listed. In the browser, **Manage access → Check permissions**
for `AuthoriseMe@` returns *None* on each locked folder. The ingestion identity and the IR-1 tool
read through a site-level app grant and through an owner's token respectively, so they are not
affected. **[verify]** that IR-1 still lists the locked folders.

**Rollback.** `sp -X POST "$(item <folder>)/resetroleinheritance()"`. This exposes the folder to
every member again, so only do it if the lock broke something essential, and record why.

**Before anyone joins BCR GROUP.** No accountant is added to BCR GROUP, and the planned
"Weryfikacja dokumentów" channel is not created, until this step and
[T-7](#t-7-explain-or-remove-authoriseme) are done.

## T-4b: Lock the ledger folders at the library root of the client sites

| Runs it | Decides | Closes |
|---|---|---|
| A site owner of each client site, or SharePoint Administrator | Agreed with Roman | W4 for documents already promoted into a client's site |

**Why.** Content promotion (W4) filed documents in the ledger's taxonomy folders at the **library
root** of the receiving client's site, because `RootFolder` was empty (R5). So did every upload
made under Yahor's id, which sat on PESKOVOI's row (R4). The client's guest is a member of the
client's Team, so they have Edit on the whole default library, root included: they can open,
change, move or delete another client's document there, through "Open in SharePoint", the
breadcrumb or search. T-4 covers only BCR GROUP, and IR-2 moves items one by one, possibly over
weeks. Locking these folders ends the exposure now, and keeps the items in place for IR-2.

The client barely notices. They are told to look in the "Dokumenty księgowe" channel folder, and
these root folders are not it. The client's own documents that sit there are released into the
channel folder by IR-2, through the allow-list.

**When.** Day 0 or day 1, with T-4, and **before IR-2 starts** on that site. It must be done
before H-12 ([`human-steps.md` H-4](human-steps.md#h-4-tenant-hardening)).

**Which sites.** PESKOVOI and TEST, the client sites the ingestion identity could write to, and
any further site that IR-1 lists (a `site_not_walked` flag, or a further site where
`directory-bindings.mjs check` shows a write grant). **Never BCR GROUP:** its folders are T-4, and
this step changes nothing else there.

**What gets locked: only the same 14 taxonomy folders as T-4** (the top-level folders from
[`folderTaxonomy.ts`](../../packages/shared/src/parsers/folderTaxonomy.ts),
`98_Nieposortowane` included), at the library root, where they exist.

⚠️ **Never a channel folder.** The library root of a client site also holds one folder per
channel: `Dokumenty księgowe`, `Ogólny` or `General`, and any others. They belong to the client's
channels and are never touched. If a channel folder has the same name as a taxonomy folder, stop
and ask; do not lock it.

**Read first,** for each site. `<client-team-id>` is the site's Team (`check` reports it).

```bash
SITE_ID=$(g "$G/sites/<tenant>.sharepoint.com:/sites/<client-site>?\$select=id" | jq -r .id)
g "$G/sites/$SITE_ID/drive?\$select=name,webUrl"                          # the library's URL
g "$G/sites/$SITE_ID/drive/root/children?\$select=name,folder" | jq -r '.value[].name'
g "$G/teams/<client-team-id>/channels?\$select=displayName" | jq -r '.value[].displayName'
g "$G/groups/<client-team-id>/owners?\$select=userPrincipalName,userType" \
  | jq -r '.value[] | "\(.userType)\t\(.userPrincipalName)"'
```

Save the lists, and mark which root folders are taxonomy folders and which are channel folders.
The Team's owners become the site's Owners group, which keeps access: every owner must read
`Member`. **If a guest is an owner, stop and tell Roman**; locking would leave that guest with
access.

**Change.** Exactly as in T-4, in the browser or scripted, with `WEB` and `LIB` pointing at this
client site, for example `WEB=https://<tenant>.sharepoint.com/sites/<client-site>` and
`LIB='/sites/<client-site>/Shared Documents'`. Pass only the taxonomy folders that exist on this
site to the `for` loop: `breakroleinheritance(copyRoleAssignments=true,clearSubscopes=true)`,
then remove the site's Members and Visitors groups. The Owners group stays.

The ingestion identity writes through its site-level app grant, so its writes are not affected.
After H-12 it no longer writes to these folders anyway: `RootFolder` then names the channel
folder.

**Verify,** for each locked folder: `HasUniqueRoleAssignments` is `true` and only the site's
Owners group is listed (the T-4 commands). In the browser, **Manage access → Check permissions**
for the client's guest returns *None*. As in T-4, **[verify]** that IR-1, run with a site
owner's token, still lists the locked folders. Record each site and the time of the lock in the
status table: it is the end date of W4 for documents already moved.

**Rollback.** `sp -X POST "$(item <folder>)/resetroleinheritance()"`. This gives the client's
guest access to another client's documents again, so only with Roman's decision, and recorded.

## T-5: Lock and version the Client Directory list

| Runs it | Decides | Closes |
|---|---|---|
| A BCR GROUP site owner, or SharePoint Administrator | Agreed with Roman | Threat T10 (directory tampering) in `docs/security.md`, in part |

**Why.** Until the database replaces it, this list *is* the routing. Anyone who can edit a row
can decide where a client's documents go, for example by adding their own id to a client's row.
It also holds every client's NIP and names. Today any member of BCR GROUP can edit it, and
nothing records who changed what. Unique permissions limit who can edit it. Versioning records
every change, which is also the only evidence of who changed a row by hand.

**Who keeps access:** the site's Owners group. The ingestion identity reads the list, and the
onboarding app writes rows at step 13. Both use a site-level app grant, not list permissions,
so neither should be affected. **[verify]** this in the ingestion logs after the change (the
query is below).

**Read first.** `WEB`, `MEMBERS` and `VISITORS` are set as in T-4.

```bash
L="$WEB/_api/web/lists/GetByTitle('Client%20Directory')"
sp "$L?\$select=HasUniqueRoleAssignments,EnableVersioning,MajorVersionLimit"
sp "$L/roleassignments?\$expand=Member&\$select=Member/Title" | jq -r '.value[].Member.Title'
```

**Change.** In the browser: **List settings → Permissions for this list → Stop Inheriting
Permissions**, then remove Members and Visitors. Then **List settings → Versioning settings →
Create a version each time you edit an item: Yes**, and keep 500 versions. Scripted:

```bash
sp -X POST "$L/breakroleinheritance(copyRoleAssignments=true,clearSubscopes=true)"
sp -X POST "$L/roleassignments/getbyprincipalid($MEMBERS)/deleteobject()"
sp -X POST "$L/roleassignments/getbyprincipalid($VISITORS)/deleteobject()"
sp -X POST "$L" -H 'Content-Type: application/json;odata=nometadata' \
  -H 'X-HTTP-Method: MERGE' -H 'IF-MATCH: *' -d '{"EnableVersioning":true,"MajorVersionLimit":500}'
```

**Verify.** The read commands return `true`, `true`, `500`, and only the Owners group. Then
confirm that ingestion still reads the list: over the next 15 minutes this query returns nothing.

```kusto
traces
| where timestamp > ago(30m) and cloud_RoleName startswith "func-bcr-ingest"
| where tostring(parse_json(message).msg) startswith "directory refresh failed"
```

**Rollback.** `sp -X POST "$L/resetroleinheritance()"`. Leave versioning on; it costs nothing.

⚠️ **The row edits themselves do not happen here.** Taking Yahor's id off PESKOVOI's row, adding
guest ids and setting `RootFolder` all happen with `tools/directory-bindings.mjs`, in the same
change window as the Phase-0 ingestion deploy. The reason is that under the code running today,
an id on an `IsAdmin` row sends that person's uploads to the fallback and then to content
promotion. Editing rows before the new code is live would make things worse.

## T-6: The Bricore team

| Runs it | Decides | Closes |
|---|---|---|
| Groups Administrator or Global Admin | **Roman**: make it Private, or delete it | W7 |

**Why.** `Bricore Sp z o o - accounting` was Public on 23 September, with a
`Dokumenty księgowe` channel. Any internal account could join it and read that channel.

```bash
az rest --url "$G/groups?\$filter=startswith(displayName,'Bricore')&\$select=id,displayName,visibility,createdDateTime"
az rest --url "$G/groups/<bricore-id>/members?\$select=displayName,userPrincipalName,userType"
```

**Change, if Roman chooses Private:** `g -X PATCH "$G/groups/<bricore-id>" -d '{"visibility":"Private"}'`.
In Teams: **⋯ → Edit team → Privacy → Private**. Current members stay.

**Change, if Roman chooses delete:** first confirm with him that nothing in its library is
needed. The ledger never wrote there, because it has no grant on that site. Then
`g -X DELETE "$G/groups/<bricore-id>"`. The group is soft-deleted for 30 days.

**Verify.** The read returns `"visibility": "Private"`, or no group.

**Rollback.** Private: PATCH back to `Public`, which reopens the window. Deleted:
`g -X POST "$G/directory/deletedItems/<bricore-id>/restore"` within 30 days.

## T-7: Explain or remove AuthoriseMe@

| Runs it | Decides | Closes |
|---|---|---|
| User Administrator or Global Admin | **Roman** explains what the account is for | Part of W1's audience |

**Why.** `AuthoriseMe@bcr-group.pl` is the third member of BCR GROUP, beside Roman and Yahor,
and nobody has written down what it is for. It could read the fallback bucket (W1), so the
incident has to account for it. It also has to be settled before any accountant is added to
BCR GROUP.

**Read.**

```bash
az rest --url "$G/users/AuthoriseMe@bcr-group.pl?\$select=id,displayName,userType,accountEnabled,createdDateTime,assignedLicenses"
az rest --url "$G/users/AuthoriseMe@bcr-group.pl/memberOf?\$select=displayName"
```

In the IR-0 Purview export, filter on this user. Any file access by it in the fallback bucket is
evidence for IR-3.

**Decide.**

- **Explained and needed:** record the reason in the incident's status table. Check that it is
  in no client Team.
- **Not needed:** block sign-in (`g -X PATCH "$G/users/<id>" -d '{"accountEnabled":false}'`) and
  take it out of BCR GROUP (`g -X DELETE "$G/groups/<bcr-group-id>/members/<id>/\$ref"`). This
  changes who is in the team. It does not change the team's visibility or its channels.

**Verify.** Read the account again. **Rollback.** Enable it, and add it back with
`POST /groups/<bcr-group-id>/members/$ref`.

## T-8: Entra external collaboration

| Runs it | Decides | Closes |
|---|---|---|
| Global Admin | Agreed in the plan | Guests reading metadata beyond their own team; guests added around onboarding |

**Why.** Two defaults matter here.

- **Guest access.** With the default level, a client's guest can look up users and groups
  beyond their own team. Team names carry client company names, so one client can list who
  else BCR serves. The most restrictive level limits a guest to their own directory objects.
- **Who can invite guests.** With the default setting, any member, and even a guest, can invite
  a guest straight into a client team. That bypasses onboarding, so the new guest is bound to
  nothing. In Phase 0 their uploads go to quarantine, but they can still read that team's files.

**Read.**

```bash
az rest --url "$G/policies/authorizationPolicy" --query "{guestUserRoleId:guestUserRoleId, allowInvitesFrom:allowInvitesFrom}"
```

**Change.** In the Entra admin centre: **External Identities → External collaboration
settings**.

- Guest user access: **"Guest user access is restricted to properties and memberships of their
  own directory objects (most restrictive)"**.
- Guest invite settings: **"Only users assigned to specific admin roles can invite guest
  users"**.

The same change with Graph, using a token that holds `Policy.ReadWrite.Authorization`:

```bash
g -X PATCH "$G/policies/authorizationPolicy" \
  -d '{"guestUserRoleId":"2af84b1e-32c8-42b7-82bc-daa82404023b","allowInvitesFrom":"adminsAndGuestInviters"}'
```

The role id is Microsoft's fixed id for *Restricted Guest User*. It is the same in every tenant.

**Verify.** The read returns `2af84b1e-…` and `adminsAndGuestInviters`. Then run two checks on
TEST:

- onboarding step 13 can still invite a guest. It uses the app permission `User.Invite.All`,
  which this setting should not affect. **[verify]**
- the TEST guest can still open the team, its files and the bot DM.

**Rollback.** PATCH back to the values from the read. The defaults are
`10dae51f-b6af-4016-8d66-8c2a99b929b3` and `everyone`.

Stopping ordinary users from creating teams (which is how the Public Bricore team came about)
needs Entra ID P1 **[verify]**. That is Roman's decision 5 in the plan.

## T-9: SharePoint sharing defaults

| Runs it | Decides | Closes |
|---|---|---|
| SharePoint Administrator | **Roman** confirms the tenant level (see the note) | Files leaving a client's space through links |

**Why.** Client guests have Edit rights in their own team. With the defaults, a guest or a staff
member can create an *Anyone* link to a client file, or share it with a new outside person.
Setting links to *Specific people* by default means a share names its recipients. *Existing
guests* on client sites means nobody new can be added by sharing: people arrive only through
onboarding. The quarantine site allows no sharing at all.

**Read.**

```powershell
Connect-SPOService -Url https://<tenant>-admin.sharepoint.com
Get-SPOTenant | Select SharingCapability, DefaultSharingLinkType, DefaultLinkPermission
Get-SPOSite -Limit All | Where-Object Url -like '*Ksigowo*' | Select Url, SharingCapability
```

**Change.**

```powershell
Set-SPOTenant -DefaultSharingLinkType Direct -DefaultLinkPermission View
Set-SPOTenant -SharingCapability ExistingExternalUserSharingOnly
Get-SPOSite -Limit All | Where-Object Url -like '*Ksigowo*' |
  ForEach-Object { Set-SPOSite -Identity $_.Url -SharingCapability ExistingExternalUserSharingOnly }
Set-SPOSite -Identity https://<tenant>.sharepoint.com/sites/BCRLedgerKwarantanna -SharingCapability Disabled
```

⚠️ **The tenant level is also a ceiling for staff OneDrive.** Setting the tenant to *Existing
guests* means staff can no longer share a OneDrive file with an outside person who is not yet a
guest. If Roman does not want that, set the tenant to `ExternalUserSharingOnly` (new and
existing guests, still no Anyone links) and keep the client sites at *Existing guests*.

**Verify.** Read again. Then check on TEST that a guest added through onboarding can open the
team's files. Guests reach those files through team membership, not through sharing, so this
should still work. **[verify]** Lowering the capability also disables existing Anyone links.

**Rollback.** Set each value back to what the read returned.

## T-10: Teams app availability for the bot

| Runs it | Decides | Closes |
|---|---|---|
| Teams Administrator | **Roman**: staff plus client guests, or everyone | Who can install the bot at all |

**Why.** Client guests need the app in BCR's org catalog, and the app has to be allowed for them.
Nobody else needs it. The real control is the bot's own gate, which refuses anything that is not
a 1:1 chat from the BCR tenant with a valid user id. Availability narrows who can install the app
in the first place.

**When.** Right after the Phase-0 bot deploy, with manifest 0.2.0 (see
[`human-steps.md`](human-steps.md#h-10-upload-manifest-020-and-set-availability)).

**Change.** In the Teams admin centre:

1. **Teams apps → Manage apps → Asystent BCR → Upload file**, and select `artifacts/teams-app.zip`
   built from manifest 0.2.0. That version has personal scope only and no tab. If the app is not
   in the catalog yet, use **Upload new app** instead.
2. **Asystent BCR → Users and groups → Available to**. Choose **specific users or groups**: a
   staff group plus a security group of client guests, for example `BCR Ledger – goście
   klientów`. Each guest is added to that group when `directory-bindings.mjs` binds them. If Roman
   does not want to maintain that group, choose *Everyone*. That is acceptable once T-1 is done,
   because the gate is the control.
3. Optional: pin the app for guests in the global app setup policy, so they find it without
   searching.
4. Remove any team or group-chat installations. Version 0.2.0 cannot be added to a team, but
   older installs may remain. **[verify]** On each client team: **Manage team → Apps → Asystent
   BCR → Uninstall**. The gate already refuses those installs.

**Verify.** The TEST guest finds "Asystent BCR", opens the chat and gets the help card. If
availability is restricted, a staff account outside the groups cannot install the app.

**Rollback.** Upload the previous package, and set availability back to what it was. ⚠️ The
previous package brings back the "Moje dokumenty" tab. After the Phase-0 bot deploy that tab only
shows a static page, but use it only in an emergency.

---

## Deferred: secret rotation

The bot's client secret and the Anthropic API key are **not** rotated in Phase 0. They will be
rotated when Roman provides new credentials. Until then, the plaintext copies on developer
laptops (`.env`) are an accepted risk, recorded in
[`docs/security.md`](../security.md#accepted-risks), and nothing here scripts a rotation.

## Status

| Step | Owner | Done | Before-state saved as | Notes |
|---|---|---|---|---|
| T-1 | | | | |
| T-2 | | | | |
| T-3 | | | | Time made Private, from Purview |
| T-4 | | | | Folders locked |
| T-4b | | | | Per client site: folders locked, time of the lock (end of W4) |
| T-5 | | | | |
| T-6 | Roman decides | | | Private / deleted |
| T-7 | Roman decides | | | Explained / removed |
| T-8 | | | | TEST invite checked |
| T-9 | Roman confirms tenant level | | | TEST guest checked |
| T-10 | | | | Everyone / groups |
