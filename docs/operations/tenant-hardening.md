# Tenant hardening, Phase 0

Written for whoever holds the admin roles in the BCR tenant, and for whoever checks the tenant
later and wants to know why it is set up this way.

These are the tenant-side steps of the containment for incident
[`IR-2026-09`](incident-2026-09.md). None of them needs a code deploy, and most can run today.
Each step gives the role that can run it, why it exists, the command to read the current state,
the command that changes it, how to verify it, and how to undo it. The order of these steps
relative to the deploys is in [`human-steps.md`](human-steps.md#phase-0).

**Run every command in bash** (`bash -l`). In zsh, the macOS default, run
`setopt interactivecomments` first. Without it, an interactive zsh does not treat `#` as the start
of a comment: a pasted comment becomes a command, or an apostrophe in it opens a quote that
swallows the lines after it. For the same reason every comment in the blocks below sits on its
own line.

⚠️ **Three rules for every step on this page.**

- **BCR GROUP stays Private, and its visibility, membership and channels never change.**
  [T-3](#t-3-confirm-bcr-group-is-private-read-only) only reads them.
  [T-4](#t-4-lock-the-ledger-folders-at-the-bcr-group-library-root) and
  [T-5](#t-5-lock-and-version-the-client-directory-list) change permissions on two things *inside*
  its site: the ledger's own folders, and the routing list. T-4 may also create one of the
  ledger's own folders, `98_Nieposortowane`, empty, so that it is locked before anything is filed
  in it. [T-7](#t-7-explain-authoriseme-or-block-its-sign-in) at most blocks the sign-in of
  `AuthoriseMe@`, which leaves the team's membership as it is. Nothing else on this page, T-4b
  included, touches BCR GROUP.
- **Nothing here deletes or moves a client document.** Documents stay where IR-1 finds them, and
  IR-2 moves them later, with two people signing off.
- **Save every "before" output.** The rollback needs it. Save it in the IR evidence store with the
  IR-0 exports, not on a laptop. It can contain user names and group ids.

## Tokens

```bash
# Reads of users, groups and policies: a token of the Azure CLI is enough.
az login --tenant <tenant-id>
export GRAPH_TOKEN=$(az account get-access-token --resource https://graph.microsoft.com --query accessToken -o tsv)

# Writes to the directory, and anything in SharePoint: use a delegated token from an app
# registration BCR owns. The first-party app of the Azure CLI is not pre-authorised for those
# scopes (AADSTS65002), and Microsoft will not change that per tenant. The helper lives in the
# onboarding repo; its header says how to set it up once.
export GRAPH_TOKEN=$(node ../bcr-onboarding-agent/tools/graph-login.mjs)
export SHAREPOINT_TOKEN=$(node ../bcr-onboarding-agent/tools/graph-login.mjs --sharepoint <tenant>.sharepoint.com)

g()  { curl -sS -H "Authorization: Bearer $GRAPH_TOKEN" -H 'Content-Type: application/json' "$@"; }
# With -f an HTTP error fails the call and names its status, instead of printing an error body.
sp() { curl -sSf -H "Authorization: Bearer $SHAREPOINT_TOKEN" -H 'Accept: application/json;odata=nometadata' "$@"; }
G=https://graph.microsoft.com/v1.0
```

`<tenant>` is the SharePoint tenant name and `<tenant-id>` the Entra tenant id. Both are in
`PROJECT_OVERVIEW.md`. Tokens expire after about an hour, and they never go in a file.

**Permissions.** The Graph permissions this page and the tools need are added and consented once
on that app registration, by the Global Admin, in
[`human-steps.md` H-4a](human-steps.md#h-4a-consent-the-permissions-the-operator-tools-need). Its
SharePoint token carries `AllSites.Read`, enough for every SharePoint **read** on this page.
The **scripted** SharePoint changes (in T-4, T-4b and T-5) need `AllSites.FullControl`, which
H-4a deliberately does not add: use the browser path those steps give. A `403` from `g`, `sp` or
a tool means a missing permission on the registration, or a right the signed-in person lacks;
`sp` stops on it (`curl: (22) … 403`) rather than printing an error that reads like a result.

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
# Needs User.ReadWrite.All on the sign-in app, see human-steps H-4a. A 403 means it is missing.
GRAPH_TOKEN=$(node tools/graph-login.mjs) node tools/audit-client-access.mjs --apply
```

**Verify.** Run the read-only command again. No account is marked `RESTRICT` for sign-in. For
one account:

```bash
# Must read "accountEnabled": false
az rest --url "$G/users/<nip>@bcr-group.pl?\$select=accountEnabled"
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
# Note the skuId.
az rest --url "$G/users/<nip>@bcr-group.pl/licenseDetails?\$select=skuId,skuPartNumber"
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
member of the team can read them: `AuthoriseMe@` today, and anyone who becomes a member later.
Stopping inheritance and leaving only the Owners closes that. The documents stay exactly where
IR-1 finds them.

**When.** Day 0, the day of [H-3](human-steps.md#h-3-stop-promotion-now-without-a-deploy), and
before H-12. **Then again after
[H-6b](human-steps.md#h-6b-point-the-running-builds-fallback-at-the-quarantine).** The lock covers
only the folders that exist when it runs. Until H-6b re-points the running build's fallback at
the quarantine, that build keeps filing unrouted uploads at this library root (after H-3, only
under `98_Nieposortowane/YYYY/MM/`, because without the Claude classifier every upload is
unsorted), and a taxonomy folder it creates after the lock inherits the library's permissions.
Two things close that:

- **Before the lock,** if `98_Nieposortowane` is not in *Read first*'s list, create it, empty,
  at the library root (**New → Folder**, the exact name), and lock it with the others. Its
  `YYYY/MM` subfolders then inherit the lock as the build creates them. Nothing is filed by
  doing this; it is an empty folder.
- **Once H-6b is verified,** run *Read first* again and lock every taxonomy folder that was not
  there before (there should be none).

Record the time of both runs: for items in a folder locked by the second run, W1 ends at that
later time.

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
# The URL of the library.
g "$G/sites/$SITE_ID/drive?\$select=name,webUrl"
g "$G/sites/$SITE_ID/drive/root/children?\$select=name,folder" | jq -r '.value[].name'
g "$G/teams/<bcr-group-id>/channels?\$select=displayName,membershipType" | jq -r '.value[].displayName'
```

Save the list of root folders, and mark which are taxonomy folders and which are channel folders.
The taxonomy folders on it, plus `98_Nieposortowane` if you create it (see **When**), are IR-1's
`--expect-root-folders` for this site.

**Change: in the browser.** This is the clearest way, there are at most 14 folders, and it needs
no extra permission, so it is the path to use. On the BCR GROUP site, open the document library.
For each taxonomy folder: **⋯ → Manage access → Advanced settings → Stop Inheriting
Permissions**. Then tick the site's **Members** and **Visitors** groups and click **Remove User
Permissions**. The site's **Owners** group stays.

**Helpers, for Verify and for the scripted change.** These only read, so set them whichever path
made the change. `LIB` is the library path from `webUrl` above, decoded, for example
`/sites/BCRGROUPSp.zo.o/Shared Documents`.

```bash
WEB=https://<tenant>.sharepoint.com/sites/BCRGROUPSp.zo.o
LIB='/sites/BCRGROUPSp.zo.o/Shared Documents'
MEMBERS=$(sp "$WEB/_api/web/AssociatedMemberGroup?\$select=Id" | jq .Id)
VISITORS=$(sp "$WEB/_api/web/AssociatedVisitorGroup?\$select=Id" | jq .Id)

# The list item of a folder, with the path percent-encoded.
item() {
  local p; p=$(jq -rn --arg p "$LIB/$1" '$p|@uri')
  echo "$WEB/_api/web/GetFolderByServerRelativePath(decodedurl='$p')/ListItemAllFields"
}
```

**Change: scripted,** with the same effect. ⚠️ **It needs SharePoint `AllSites.FullControl`** on
the sign-in app, which [H-4a](human-steps.md#h-4a-consent-the-permissions-the-operator-tools-need)
deliberately leaves out. With only `AllSites.Read`, every POST below fails with 403 and nothing
changes. Prefer the browser.

```bash
# Name only the taxonomy folders that exist on this site.
for F in 01_Faktury 02_Wyciągi_bankowe 98_Nieposortowane; do
  I=$(item "$F")
  sp -X POST "$I/breakroleinheritance(copyRoleAssignments=true,clearSubscopes=true)"
  sp -X POST "$I/roleassignments/getbyprincipalid($MEMBERS)/deleteobject()"
  sp -X POST "$I/roleassignments/getbyprincipalid($VISITORS)/deleteobject()"
done
```

**Verify,** for each folder:

```bash
I=$(item 01_Faktury)
# Must read true.
sp "$I?\$select=HasUniqueRoleAssignments"
sp "$I/roleassignments?\$expand=Member&\$select=Member/Title" | jq -r '.value[].Member.Title'
```

Only the site's Owners group is listed. In the browser, **Manage access → Check permissions**
for `AuthoriseMe@` returns *None* on each locked folder. The ingestion identity reads and writes
through a site-level app grant, so it is not affected. IR-1 is, unless it runs as an owner: it
walks with a delegated token, and SharePoint hides a locked folder from anyone outside the
Owners group. So IR-1 runs with the token of an Owner or site collection admin of every site it
walks, and with `--expect-root-folders` naming the folders locked here (the list saved in *Read
first*); it exits non-zero, naming the folder, when the walk does not see one
([incident → IR-1](incident-2026-09.md#ir-1-inventory)).

⚠️ `clearSubscopes=true` also resets every item inside the folder to inherit, which removes the
item's sharing links and direct grants. The live permissions of an item therefore no longer
show a link that existed before the lock; IR-2 takes that history from the IR-0 Purview export
(`purview-sharing-events.csv`) instead.

**Rollback.** In the browser, the folder's **⋯ → Manage access → Advanced settings → Delete
unique permissions**; scripted (needs `AllSites.FullControl`),
`sp -X POST "$(item <folder>)/resetroleinheritance()"`. This exposes the folder to every member
again, so only do it if the lock broke something essential, and record why.

**Out of scope for Phase 0: new members or channels in BCR GROUP.** Adding accountants to BCR
GROUP, and creating the planned "Weryfikacja dokumentów" channel, would change its membership
and its channels, which no Phase-0 step does. Both are later decisions, and even then not before
this step and [T-7](#t-7-explain-authoriseme-or-block-its-sign-in) are done.

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

**When.** Day 0 or day 1, with T-4, **after H-3 is verified**
([`human-steps.md` H-3](human-steps.md#h-3-stop-promotion-now-without-a-deploy)), and **before
IR-2 starts** on that site. It must be done before H-12
([`human-steps.md` H-4](human-steps.md#h-4-tenant-hardening)). The lock covers only the folders
that exist when it runs, and until H-3 is in effect the running build can still promote a
document into a client's site and create a taxonomy folder at its library root. If T-4b ran
before H-3 was verified, run *Read first* again on each site once it is, and lock every taxonomy
folder that has appeared since. Once H-3 is in effect, only an upload by an id on a client row
could still file there before H-12. As far as the records go the only such id is Yahor's (IR-0 C
confirms or corrects this), and he does not upload through the bot.

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
# The URL of the library.
g "$G/sites/$SITE_ID/drive?\$select=name,webUrl"
g "$G/sites/$SITE_ID/drive/root/children?\$select=name,folder" | jq -r '.value[].name'
g "$G/teams/<client-team-id>/channels?\$select=displayName" | jq -r '.value[].displayName'
g "$G/groups/<client-team-id>/owners?\$select=userPrincipalName,userType" \
  | jq -r '.value[] | "\(.userType)\t\(.userPrincipalName)"'
```

Save the lists, and mark which root folders are taxonomy folders and which are channel folders.
The taxonomy folders are IR-1's `--expect-root-folders` for this site. The Team's owners become
the site's Owners group, which keeps access: every owner must read `Member`. **If a guest is an
owner, stop and tell Roman**; locking would leave that guest with access.

**Change.** Exactly as in T-4: in the browser (the path to use), or scripted only if
`AllSites.FullControl` is consented (H-4a leaves it out). Either way, set T-4's helpers again for
this client site, because Verify reads through them: `WEB` and `LIB` pointing at it, for example
`WEB=https://<tenant>.sharepoint.com/sites/<client-site>` and
`LIB='/sites/<client-site>/Shared Documents'`, and `MEMBERS` and `VISITORS` read again from that
`WEB` (they are this site's groups, not BCR GROUP's). Scripted, pass only the taxonomy folders
that exist on this site to the `for` loop: `breakroleinheritance(copyRoleAssignments=true,clearSubscopes=true)`,
then remove the site's Members and Visitors groups. The Owners group stays. Nothing is created
on a client site.

The ingestion identity writes through its site-level app grant, so its writes are not affected.
After H-12 it no longer writes to these folders anyway: `RootFolder` then names the channel
folder.

**Verify,** for each locked folder: `HasUniqueRoleAssignments` is `true` and only the site's
Owners group is listed (the T-4 commands). In the browser, **Manage access → Check permissions**
for the client's guest returns *None*. As in T-4, IR-1 must still see the locked folders: it
runs with an Owner's or site collection admin's token and with `--expect-root-folders` naming
the folders locked here. Record each site and the time of the lock in the status table.

**Then, once IR-1 has run for this site: the items outside the locked folders.** Before the lock
the client's guest could move a promoted document out of a taxonomy folder (into
`Dokumenty księgowe`, say), or copy it. Such an item stays readable after the lock. From IR-1's
register and the IR-0 Purview export (`purview-file-operations.csv`, or the manual fallback's
`ir0-purview-<site>.csv`), list:

- every item on this site that IR-1 flags as promoted (W4) or `uploader_not_site_guest` and
  whose current path is not under a folder locked here;
- every `FileMoved`, `FileCopied` or `FileRenamed` event on such an item by anyone other than
  staff and the ingestion identity, and where the item or its copy went.

Lock each of them on its own: save its `GET /drives/{driveId}/items/{itemId}/permissions` to the
evidence store first, then stop inheritance and leave only the site's Owners group. A file
inside a channel folder is locked this way too; the channel folder itself never is. In the
browser, as for a folder: the file's **⋯ → Manage access → Advanced settings → Stop Inheriting
Permissions**, then remove **Members** and **Visitors**. The helper and the check below only
read; the three POSTs are the scripted change, and need `AllSites.FullControl` (see T-4).

```bash
# The list item of a file, with the path percent-encoded.
file_item() {
  local p; p=$(jq -rn --arg p "$LIB/$1" '$p|@uri')
  echo "$WEB/_api/web/GetFileByServerRelativePath(decodedurl='$p')/ListItemAllFields"
}
I=$(file_item '<path under the library>')
# The scripted change only. Skip these three when the browser made it.
sp -X POST "$I/breakroleinheritance(copyRoleAssignments=true,clearSubscopes=true)"
sp -X POST "$I/roleassignments/getbyprincipalid($MEMBERS)/deleteobject()"
sp -X POST "$I/roleassignments/getbyprincipalid($VISITORS)/deleteobject()"
# The check.
sp "$I/roleassignments?\$expand=Member&\$select=Member/Title" | jq -r '.value[].Member.Title'
```

The last command must list only the Owners group. An item that already had its own permissions
(a sharing link, a person added by hand) keeps them through the first command: remove those in
the browser (**Manage access**), after saving them. Record each item and its lock time in the
evidence store, not here: for that item, W4 ends at that time. The processor notice and the
breach register say that the receiving team's members can no longer open the moved documents
only once this check is done for the site and leaves nothing unlocked.

**Rollback.** As in T-4: **Delete unique permissions** in the browser, or scripted (needs
`AllSites.FullControl`) `sp -X POST "$(item <folder>)/resetroleinheritance()"`. This gives the
client's guest access to another client's documents again, so only with Roman's decision, and
recorded.

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

**Change.** In the browser, the path to use: **List settings → Permissions for this list → Stop
Inheriting Permissions**, then remove Members and Visitors. Then **List settings → Versioning
settings → Create a version each time you edit an item: Yes**, and keep 500 versions.
Scripted, only if `AllSites.FullControl` is consented (H-4a leaves it out; see T-4):

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

**Rollback.** In the browser, **List settings → Permissions for this list → Delete unique
permissions**; scripted (needs `AllSites.FullControl`), `sp -X POST "$L/resetroleinheritance()"`.
Leave versioning on; it costs nothing.

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

## T-7: Explain AuthoriseMe@, or block its sign-in

| Runs it | Decides | Closes |
|---|---|---|
| User Administrator or Global Admin | **Roman** explains what the account is for | Part of W1's audience |

**Why.** `AuthoriseMe@bcr-group.pl` is the third member of BCR GROUP, beside Roman and Yahor,
and nobody has written down what it is for. It could read the fallback bucket (W1), so the
incident has to account for it.

**Read.**

```bash
az rest --url "$G/users/AuthoriseMe@bcr-group.pl?\$select=id,displayName,userType,accountEnabled,createdDateTime,assignedLicenses"
az rest --url "$G/users/AuthoriseMe@bcr-group.pl/memberOf?\$select=displayName"
```

In the IR-0 Purview export, filter on this user: its file operations and its sign-in events.
Any file access by it in the fallback bucket is evidence for IR-3.

**Decide.**

- **Explained and needed:** record the reason in the incident's status table. Check that it is
  in no client Team.
- **Not needed:** block its sign-in, and nothing more: **Block sign-in** on the account in the
  Entra admin centre, or `g -X PATCH "$G/users/<id>" -d '{"accountEnabled":false}'`
  (`User.ReadWrite.All`, H-4a). A blocked account can no longer read the fallback bucket, and
  BCR GROUP's membership, visibility and channels stay exactly as they are.

**Blocking sign-in is the whole of the Phase-0 action.** Taking `AuthoriseMe@` out of BCR GROUP,
or any other change to who is in the team, is not part of Phase 0. If it is wanted, it is a
separate, explicit decision by Roman and the team's owner, made and recorded outside this
runbook.

**Verify.** Read the account again: `accountEnabled` is `false` if it was blocked, and `memberOf`
still lists BCR GROUP. **Rollback.** Enable it again:
`g -X PATCH "$G/users/<id>" -d '{"accountEnabled":true}'`.

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

The same change with Graph, using a token that holds `Policy.ReadWrite.Authorization` (H-4a
does not consent it; prefer the admin centre above):

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
| Teams Administrator | *Everyone* in Phase 0; a restricted group only later, with the sub-steps below | Who can install the bot at all |

**Why.** Client guests need the app in BCR's org catalog, and the app has to be allowed for them.
Nobody else needs it. The real control is the bot's own gate, which refuses anything that is not
a 1:1 chat from the BCR tenant with a valid user id. Availability narrows who can install the app
in the first place.

**When.** Right after the Phase-0 bot deploy, and after [T-1](#t-1-block-sign-in-on-the-nip-client-addresses),
with manifest 0.2.0 (see
[`human-steps.md`](human-steps.md#h-10-upload-manifest-020-and-set-availability)). Step 2's case
for *Everyone* relies on T-1 being done.

**Build the package first** (Yahor, from the repo root; the Teams Administrator only uploads
it). There is no ready-made zip in the repo: the `artifacts/teams-app.zip` that used to be
committed was manifest 0.1.5, with team and group-chat scopes and the "Moje dokumenty" tab, and
must never be uploaded. `teams-app/manifest.json` holds `REPLACE-WITH-BOT-APP-ID` in `id` and
`bots[0].botId`. Both become the bot's app id, which is also the id of the "Asystent BCR" app
already in the catalog. **[verify]** in the admin centre that the existing app's *App ID* is
that value before uploading; if it differs, stop, because the upload would create a second
app. The build works on a copy, so the tracked manifest keeps its placeholders.

```bash
# RG and BOT as in human-steps.md → Variables
BOT_APP_ID=$(az functionapp config appsettings list -g $RG -n $BOT \
  --query "[?name=='MICROSOFT_APP_ID'].value | [0]" -o tsv)
# Must print nothing.
[[ $BOT_APP_ID =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]] \
  || echo 'STOP: BOT_APP_ID is not a GUID. Check RG and BOT, and do not upload what follows.'
T=$(mktemp -d)
sed "s/REPLACE-WITH-BOT-APP-ID/$BOT_APP_ID/g" teams-app/manifest.json > "$T/manifest.json"
cp teams-app/color.png teams-app/outline.png "$T/"
# Must print 0.
grep -c REPLACE-WITH "$T/manifest.json"
OUT="$PWD/artifacts/teams-app.zip"; mkdir -p artifacts; rm -f "$OUT"
(cd "$T" && zip -X "$OUT" manifest.json color.png outline.png)
unzip -p "$OUT" manifest.json | jq -r \
  '.version, (.bots[0].scopes | join(",")), (.staticTabs // [] | length),
   (.id == .bots[0].botId and (.id | test("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"; "i")))'
```

The last command must print `0.2.0`, `personal`, `0` and `true`, one per line: `true` only when
`id` and `botId` are the same GUID. Anything else: do not upload it.

**Change.** In the Teams admin centre:

1. **Teams apps → Manage apps → Asystent BCR → Upload file**, and select the
   `artifacts/teams-app.zip` just built and checked. That version has personal scope only and no
   tab. If the app is not in the catalog yet, use **Upload new app** instead.
2. **Asystent BCR → Users and groups → Available to**: choose **Everyone**. This is the
   Phase-0 choice. The gate is the control: it refuses anything that is not a 1:1 chat from the
   BCR tenant with a valid user id, and T-1 has already blocked the `{NIP}@` accounts.
   Do **not** restrict it to a group of client guests in Phase 0. Nothing fills such a group:
   neither onboarding nor `directory-bindings.mjs` adds anyone to one, so PESKOVOI's guest and
   the TEST guest would lose the bot on day 1, and H-11 and H-12 could not run.

   If Roman later wants the restricted option, do these first, in this order, and only then
   change *Available to*:
   - create a security group for client guests;
   - add the staff group, the TEST guest, every bound client guest and the canary guest to it:
     `az ad group member add --group <group-id> --member-id <user-object-id>`;
   - check the members with `az ad group member list --group <group-id> -o table`;
   - from then on, add each newly bound guest by hand, before telling the client to use the bot
     ([admin guide, Onboarding](../client-directory-admin-guide.md#onboarding-a-client-phase-0)).
3. Optional: pin the app for guests in the global app setup policy, so they find it without
   searching.
4. Remove any team or group-chat installations. Version 0.2.0 cannot be added to a team, but
   older installs may remain. **[verify]** On each client team: **Manage team → Apps → Asystent
   BCR → Uninstall**. The gate already refuses those installs.

**Verify.** The admin centre shows version **0.2.0** for Asystent BCR. The TEST guest finds
"Asystent BCR", opens the chat and gets the help card, and so does PESKOVOI's guest when they
next use it. Only if availability was later restricted: a staff account outside the groups
cannot install the app.

**Rollback.** Set availability back to what it was. Do not upload an older package: 0.1.5
brings back team and group-chat installs and the "Moje dokumenty" tab. If 0.2.0 itself is
broken, fix `teams-app/manifest.json`, raise its `version` (0.2.1), and build, check (for the
new version, still `personal` and `0`) and upload that the same way.

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
| T-4 | | | | Folders locked, and the time; whether `98_Nieposortowane` was created first; the check after H-6b, its time, and any folder it locked |
| T-4b | | | | Per client site: folders locked and the time of the lock; H-3's time; any re-check after H-3; the check after IR-1 of the items outside the locked folders, done or not, and how many it locked (each item and its lock time are in the evidence store). W4 ends, for items already moved, at the latest of these that applies to the item |
| T-5 | | | | |
| T-6 | Roman decides | | | Private / deleted |
| T-7 | Roman decides | | | Explained / sign-in blocked (membership unchanged) |
| T-8 | | | | TEST invite checked |
| T-9 | Roman confirms tenant level | | | TEST guest checked |
| T-10 | | | | Everyone (Phase 0); version 0.2.0 shown; sha256 of the uploaded zip |
