# Admin guide: the "Client Directory" SharePoint list

Written for whoever maintains the list, and for the next person who changes how documents are
routed.

> **Status: Phase 0 routing, September 2026.** On the bot path, routing uses the uploader's
> identity only. In the channel inbox, the client is the bound row whose channel folder holds the
> file. The document's content never chooses the client. This guide replaces the earlier one, which
> described content-based promotion; that path was the cross-client write in incident
> [`IR-2026-09`](operations/incident-2026-09.md) and has been deleted. The list is an interim
> routing source. The database-backed registry replaces it in Phase 2 of the v2 plan.
>
> **Corrected 29 September 2026: the client is its `{NIP}@bcr-group.pl` account.** Until
> 28 September this guide treated the clients' Teams guests as the clients. The owner's
> decision of 28 September makes a client's identity its `{NIP}@bcr-group.pl` account, and guests
> have no capability in the ledger ([Who the client is](#who-the-client-is)). The ingestion build
> that enforces it is **not yet deployed**, and rows 2 and 10 are not yet re-bound to their
> client accounts: until both are done, the running build still routes the guest bound on each
> row, and the channel inbox files only posts by guests of the row's Team. Meanwhile a client
> account's channel posts wait (`inbox.skipped` `not_guest`), and its uploads in the bot's chat
> go to quarantine as `unmapped`, because no row holds its id yet.

## What it's for

The ingestion function uses the list to answer two questions, one per intake:

- **Bot chat: which one client is this uploader bound to?** If the answer is exactly one client,
  and the uploader is that client's `{NIP}@bcr-group.pl` account, the document is filed in that
  client's space. A guest is refused and nothing is stored. Every other Member goes to the
  staff-only quarantine, and an accountant decides.
- **Channel inbox: which bound client's channel folder is this file in?** Clients post files in
  their Team's "Dokumenty księgowe" channel as well as in the bot's chat. Each bound row's
  channel folder (its `RootFolder`, in its `DriveId`) is that client's inbox, and ingestion files
  what the client's account puts there into the taxonomy folders inside it
  ([below](#how-a-channel-inbox-file-is-filed)).

Two rules follow from that, and they are the ones that were broken:

- **A client row names only that client's own account.** Anyone whose id is on a client's row
  used to have every upload filed into that client's space, whatever the document was. A staff
  id on a client row therefore filed other clients' papers into that client's folder. That
  happened: Yahor's id was on PESKOVOI's row. With the client-account rule, an id on a row that
  is not its `{NIP}@` account routes nothing, but it still does not belong there.
- **Nothing is typed by hand that a tool can read from Graph.** The client account's id, the
  channel folder name, the drive id and the team id all come from
  `tools/directory-bindings.mjs`. A typo in a folder name creates a look-alike folder the client
  never sees. A wrong id sends documents to the wrong client.

## Who the client is

A client is its `{NIP}@bcr-group.pl` account (the owner's decision, 28 September 2026): an Entra
**Member**, licensed, created by hand by Roman (BCR) and handed to the client, a member, never an
owner, of the client's own Team and of no other Team. The client uses it for everything: channel
posts, the bot's 1:1 chat, and search once it is on.

A row's client account is the one id in its `UserAadObjectIds` that:

- is `userType` `Member`;
- has a `userPrincipalName` of exactly `<the row's NIP>@bcr-group.pl`, and the row's `NIP` is 10
  digits (no subdomain, no `+tag`, no other domain; the mail address is never read);
- is in the row's Team and in no other Team.

The row is chosen by the account's id (bot chat, search) or by the file's location (channel
inbox). The NIP and the UPN only confirm that row: they never find one, so content still cannot
pick a client. The binding tool writes the id; ingestion checks the rule again at every request.
The rule has no switch: `MEMBERSHIP_CHECK_MODE=off` never skips it.

**Guests have no capability in the ledger.** Onboarding still invites the client's contact
person as a guest, which gives them the Team's files in Teams and nothing else. A guest's upload
through the bot is refused with nothing stored, not even in quarantine; a guest's channel post is
left where it is; a guest cannot search. This holds for every guest: bound on a row or not, of
this Team or another.

**Never block, disable, unlicense or convert a `{NIP}@` account.** On 26 September tenant step
T-1 blocked sign-in on the three client accounts, taken for shared mailboxes nobody signs in
with, and the clients could not sign in to Teams until Roman re-enabled them on 28 September. T-1
and T-2 are withdrawn. The binding tool reports a bound client account that is disabled as a
client locked out (`check` exits 5); tell Roman at once, and never unbind the row for it.

## How an upload is routed (Phase 0)

This section is the bot chat. The channel inbox is [the next section](#how-a-channel-inbox-file-is-filed).

1. **The bot's gate.** Only a 1:1 chat, from the BCR tenant, with a valid user object id,
   reaches ingestion at all. Ingestion checks the same three things again.
2. **The uploader's account** is read from Entra (`userType`, `userPrincipalName`), before the
   list. Anything but a Member is **refused**: nothing is stored, classified or indexed, not even
   in quarantine, and the card's row says the file cannot be accepted from this account
   (`ClientAccountRequired`). The reasons, in the `identity.refused` log line: `guest`,
   `not_member` (another type, or none), `unknown_user` (deleted), `no_identity`. An account that
   cannot be read is refused as `identity_unverified`, and the card asks to send the file again
   (`RetryLater`).
3. **The uploader's id** is looked up in `UserAadObjectIds` across the `Active` rows.
4. **Exactly one client row matches, and it is bound.** Bound means `RootFolder`, `DriveId` and
   `TeamId` are all set, which only the binding tool does. The document goes to that row's
   target: `SiteHostname`, `SitePath`, `DriveName` and `RootFolder`. The drive the path resolves
   to must have the row's `DriveId`, and the site Graph resolves must not be BCR GROUP or the
   quarantine site.
5. **The uploader is the row's client account:** their UPN is exactly
   `<the row's NIP>@bcr-group.pl`. This is checked before the Teams are read.
6. **The row's Team is the uploader's only Team.** Ingestion reads the uploader's Teams from
   Entra at upload time (their direct memberships, counting a group as a Team the way the binding
   tool does) and routes only if they are exactly the row's `TeamId`. A successful read is reused
   for 5 minutes per user.
7. **Any other Member goes to quarantine**, with a reason:

| Reason | When |
|---|---|
| `unmapped` | The id is on no `Active` row. A newly onboarded client's account is here until its row is bound, because onboarding writes no user ids. So are the client accounts of 0003 and 0004, which have no row yet. |
| `staff` | The id is on an `IsAdmin` row. Staff are never routed to a client. |
| `conflict` | The id is on two rows (a client row and an `IsAdmin` row count too), or its only row was excluded because it shares its site, its `DriveId` or its `TeamId` with another `Active` client row (see [Duplicates and conflicts](#duplicates-and-conflicts)). |
| `stale_directory` | The list could not be refreshed for longer than the stale cap, or the row's `DriveId` does not match. |
| `forbidden_target` | The id's only row was excluded because it points at a forbidden site: BCR GROUP, the quarantine site, a host other than the tenant's (`QUARANTINE_SITE_HOSTNAME`), or a `SitePath` that is not exactly `/sites/<name>` or `/teams/<name>`. Or the row's site, as Graph resolved it at upload time, is BCR GROUP or the quarantine site. |
| `unbound_target` | The id's only row lacks `RootFolder`, `DriveId` or `TeamId`: the binding tool has not bound it. A row that is not bound routes nobody. |
| `not_client_account` | The id's row is bound, but the uploader is not its client account: their UPN is not `<the row's NIP>@bcr-group.pl` (a staff id or another client's account bound on the row by mistake, an account renamed, the row's `NIP` edited by hand), or the row's `NIP` is not 10 digits. The binding tool reports such an id as `staff_ids` or `client_account_ineligible`. |
| `membership_mismatch` | The id's row is bound, but the uploader's Teams, read at upload time, are not exactly its `TeamId`: they are no longer in that Team, or they are also in another Team (for example, client A's account later added to client B's Team). See [Keeping the bindings current](#keeping-the-bindings-current). |
| `membership_unverified` | The uploader's Teams could not be read: the ingestion identity lacks `Directory.Read.All` (or its token does not carry it yet), the user no longer exists, or Graph failed after retries. If every bound upload shows it, the grant is missing or not yet in the token ([human-steps H-8b](operations/human-steps.md#h-8b-grant-the-ingestion-identity-directoryreadall-then-verify)). |
| `target_unwritable` | The client's site refused the write after retries, usually because the ingestion managed identity has no `write` grant there (or the grant went to the Ingestion API app registration instead). |

8. **Content never changes the client.** After classification, the only thing content can change
   is the direction of an invoice (sales ⇄ purchase), and only inside the client the uploader is
   bound to. It is decided by comparing the parties on the invoice with that client's `NIP`.

## How a channel-inbox file is filed

A timer in the ingestion app sweeps every 2 minutes, when `INBOX_SWEEP_MODE` is `shadow` or
`enforce` (it is `off` until [human-steps H-12](operations/human-steps.md#h-12-the-change-window-ingestion-deploy-bindings-canaries)
turns it on). Until then, files in a client's "Dokumenty księgowe" channel simply wait there;
nothing is lost.

1. **Which rows.** Only the rows the list routes to: `Active`, not `IsAdmin`, bound (`RootFolder`,
   `DriveId`, `TeamId`), and not excluded as a conflict or a forbidden target. The client is
   where the file is, so the row's ids do not choose the row; they decide whose files are filed
   (step 4). If the list cannot be read recently enough, nothing is swept.
2. **Which folder.** The row's `RootFolder` at the root of the drive `DriveId`, through the same
   checks as an upload: never BCR GROUP or the quarantine site, never another drive.
3. **Which files.** Only files directly in that folder, not in its subfolders (the subfolders are
   where filed documents live). A file must be unchanged for `INBOX_MIN_AGE_MS` (2 minutes by
   default), between 1 byte and 100 MiB, and not an Office lock file (`~$…`) or a hidden one.
4. **Whose files.** Only files **created by the row's client account, and last changed by that
   same account**: the id the list routes to this row, a Member whose UPN is
   `<the row's NIP>@bcr-group.pl`, in this row's Team and no other. Everything else is left
   exactly where it is, with a reason in the `inbox.skipped` log line:
   - `guest`: any guest, this Team's included. Guests have no capability in the ledger;
   - `not_member`, `unknown_user`: another account type, or a deleted user;
   - `not_bound`: a Member the list does not route to this row, such as staff or another
     client's account;
   - `not_client_account`: bound on this row, but not its `{NIP}@` account, or the row's `NIP` is
     not 10 digits;
   - `not_in_team`, `other_teams`: the client account is not in the row's Team, or is also in
     another Team. It waits until the membership is fixed;
   - `modified_by_other`: someone else changed the file last, for example a staff member who
     overwrote a client's file with another file of the same name;
   - `unverified`: the account or its Teams could not be read. The file waits for a later tick.

   (Until 28 September the rule was: files created, and last changed, by guests who are members
   of this row's Team. The running build still applies it until the client-account build is
   deployed.)
5. **Where it goes.** The file is classified like a bot upload, as this row's client, and moved,
   by id and under its own name, into the taxonomy folder **inside the same channel folder**, for
   example `Dokumenty księgowe/01_Faktury/02_Faktury_zakupu/2026/09/`. A name already taken gets
   `_1`, `_2` and so on; nothing is overwritten, copied or deleted. What cannot be classified, and
   a file whose processing failed three times, goes to `98_Nieposortowane/YYYY/MM` inside the
   same channel folder, for an accountant.
6. **Your changes win.** If you move a waiting file out of the channel folder, file it by hand into
   a subfolder, rename it or replace it while the sweep is working, the sweep leaves it where you
   put it: it only moves a file that is still exactly as it listed it (`inbox.skipped` with
   `changed` in the logs).

So, for a row's channel posts to be filed, it must be bound by the tool exactly as for bot
routing, with its client account in `UserAadObjectIds`, and its `NIP` must be 10 digits. A row
with no valid NIP, or no bound client account, is still swept but files nothing. While the
ingestion setting
`INBOX_SWEEP_ROWS` is set (during a rollout, `/api/health` shows `"inboxSweepRows":"listed"`),
only the rows whose list item ids it names are swept: a newly bound client waits until its id is
added, or the setting is cleared.

## What quarantine means

Quarantine is a SharePoint communication site, "BCR Ledger – Kwarantanna". It has no Team and no
Microsoft 365 group, so nobody can join it. It has unique permissions (triage staff only) and
sharing is disabled. No client can reach it. Only Members' uploads reach it: a guest's upload is
refused and stored nowhere (see [How an upload is routed](#how-an-upload-is-routed-phase-0)).

- **Where a file goes:** `Kwarantanna/YYYY/MM/<batchId>/<original file name>`.
- **What is recorded on it:** four columns, so triage can decide from identity rather than from
  content: `UploaderOid`, `QuarantineReason`, `OriginalFilename` and `DocumentId`.
- **What the uploader sees:** "📨 {file name}" and "Dokument przekazano do weryfikacji przez
  zespół BCR." No link, no folder and no client name, because the uploader may not be who they
  claim, and a link would say where documents are kept.

**Triage rule.** Decide the owner from the uploader: take `UploaderOid`, then every Team that
person belongs to (`GET /users/{id}/memberOf`, groups whose `resourceProvisioningOptions`
contains `Team`). Count every Team, not only those whose description starts `BCR Group —`: the
five Teams `[0000]`–`[0004]` predate onboarding and carry no such description.

- If they belong to several clients, ask them.
- The content may break a tie between clients the identity already produced. It never decides on
  its own.
- A second person checks before anything is moved into a client's folder.

## Where it lives

A SharePoint list named **`Client Directory`** on the BCR GROUP site
(`https://bcrgroupeu.sharepoint.com/sites/BCRGROUPSp.zo.o`).

- **List id:** `2a5613f1-6193-4c04-8a3d-d606617fb411`
- **Site id:** `bcrgroupeu.sharepoint.com,c2b2fedb-12e3-47f1-93f4-c22b2e361a68,fa306584-d50a-4e44-89c0-baa5bf265c69`

Both ids reach the ingestion function as `CLIENT_DIRECTORY_SITE_ID` and
`CLIENT_DIRECTORY_LIST_ID`.

**Who can edit it.** Since the Phase-0 hardening the list has unique permissions: only the
site's Owners can edit it, and versioning records every change
([tenant-hardening T-5](operations/tenant-hardening.md#t-5-lock-and-version-the-client-directory-list)).
The ingestion identity reads it through its site grant. After the Phase-0 change window that
grant is read-only, and ingestion can never write to BCR GROUP again.

## Columns

| Column | Type | Set by | What it does |
|---|---|---|---|
| `Title` | Single line | Onboarding | Display name, e.g. `[0002] PESKOVOI Sp. z o. o. - Księgowość`. Redacted from logs, and never shown on a card. |
| `ClientId` | Single line | Onboarding | BCR record number, e.g. `0002`. Never reused, even after offboarding. |
| `NIP` | Single line | Onboarding | Digits only, exactly 10. It names the row's client account (`<NIP>@bcr-group.pl`), which ingestion checks at every request, and it decides invoice direction inside this client. It never picks a client: the row is chosen by the account's id or the file's location. Not 10 digits: nobody routes to the row. Edited by hand: the row's account stops routing (`not_client_account`) until its UPN matches again (see [Changing a client](#changing-a-client)). The canary row's `9000000000` fails the NIP checksum on purpose, so no real company can hold it. (Until 28 September this column said it was used only for invoice direction.) |
| `CompanyNameAliases` | Multi-line, plain | Onboarding | The first line is the name given to the classifier for this client. Nothing routes on it. |
| `PersonNames` | Multi-line, plain | — | Not read any more. Leave it empty. |
| `UserAadObjectIds` | Multi-line, plain | **The tool** | One id: **the client's `{NIP}@bcr-group.pl` account only**, a Member of this client's Team, never an owner, and in no other Team (the tool binds no one else, and reports an account also in another Team as `client_account_in_other_team`). **Never a guest, never staff.** It routes the bot chat and search, and decides whose channel posts are filed. The tool writes at most one id; any other id on the row routes nothing with the client-account build. (Until 28 September this column held the client's guests.) |
| `SiteHostname` | Single line | Onboarding | The tenant's SharePoint host. It must equal the ingestion setting `QUARANTINE_SITE_HOSTNAME`, the only host a row may name; a row on any other host routes nobody (`forbidden_target`). |
| `SitePath` | Single line | Onboarding | Exactly `/sites/<name>` or `/teams/<name>`, e.g. `/sites/0002PESKOVOISp.zo.o.-Ksigowo`. The Team's root site, never a sub-site. A leading or trailing `/`, doubled `/` and case do not matter; a third segment, a `.` or `..` segment, `%`, `\` or a space inside the name make the row `forbidden_target`. Must not be BCR GROUP or the quarantine site. |
| `DriveName` | Single line | Onboarding | The library name. `Dokumenty` on this Polish tenant. |
| `RootFolder` | Single line | **The tool** | The channel folder's name, exactly as Graph returns it for the "Dokumenty księgowe" channel (`GET /teams/{id}/channels/{id}/filesFolder`). Documents then appear in the channel's files tab. It is also the client's **inbox**: the folder the channel-inbox sweep reads, and the only one it files inside. **Required:** an empty `RootFolder` means the row is not bound, and it routes nobody (`unbound_target`) and is never swept. Before Phase 0, empty meant the library root, which is where the incident's documents went and where clients never look. |
| `DriveId` | Single line | **The tool** | New, **required** (`unbound_target` without it). The id of the drive holding the channel folder. Ingestion checks that the path still resolves to this drive; if not, the upload goes to quarantine as `stale_directory`. This protects against a deleted Team whose site URL is later reused by a new Team. No two `Active` client rows may share it. |
| `TeamId` | Single line | **The tool** | New, **required** (`unbound_target` without it). The client's Team id. No two `Active` client rows may share it. Logged as `teamId` when an upload is routed and filed, and used by the tools and audits. An upload routes only while this is the uploader's one and only Team, read at upload time (`membership_mismatch` otherwise); see [Keeping the bindings current](#keeping-the-bindings-current). |
| `IsAdmin` | Yes/No | By hand | `Yes` only on the staff row. See [Staff](#staff). |
| `Status` | `Active` / `Inactive` | By hand | Only `Active` rows route. |
| `TeamsChannelId` | Single line | Onboarding | Written by onboarding, read by nothing. Channel uploads never reach a bot; the channel inbox finds the channel folder through `RootFolder` and `DriveId`, not this column. |

## Duplicates and conflicts

The list is read in two passes, so the result does not depend on row order. The rules are
fail-closed: when in doubt, the upload goes to quarantine, never to a guess.

| What is duplicated | Effect | Why |
|---|---|---|
| A user id on two rows (including an `IsAdmin` row and a client row) | That id is dropped from routing. The rows stay usable for everyone else. | One person cannot be bound to two clients by accident. |
| Two `Active` client rows on the same site (`SiteHostname` + `SitePath`, compared as above), whatever `DriveName` or `RootFolder` each names | **Both rows** are excluded. Their users' uploads go to quarantine as `conflict`. | One Team site belongs to one client. Two rows on it means one of them is wrong, and nothing says which; two clients in one library is a leak by construction. |
| Two `Active` client rows with the same `DriveId`, or the same `TeamId` (in any case) | **Both rows** are excluded, as above. | One drive and one Team belong to one client, whatever the rows' paths say. |
| A `ClientId` or a `NIP` on two rows | An alert only (`directory.conflict`). Routing is not affected. `directory-bindings.mjs` refuses to change those rows until a person fixes them; a shared NIP names one client account for both rows, so it binds it to neither. | Neither picks a row any more (the NIP only confirms the row an id chose), so excluding the rows would only quarantine a real client for no gain. |

A `directory.conflict` log line names the kind of conflict and the list item ids. It never logs
the duplicated value itself. Look the items up in the list.

**The live duplicate.** Two rows carry `0002`. Before PESKOVOI is bound, Roman decides which is
the real one (the row whose `SitePath` is PESKOVOI's site), and the other is set to `Inactive`
([human-steps H-7](operations/human-steps.md#h-7-check-the-directory-before-the-deploy-and-add-the-new-columns)).

## The stale cap and the forbidden targets

- **Refresh.** The list is re-read every `CLIENT_DIRECTORY_CACHE_TTL_MS` (default 5 minutes).
  An edit takes effect within that time, without a redeploy.
- **Stale cap.** If refreshes keep failing, the last good snapshot is used for at most
  `CLIENT_DIRECTORY_MAX_STALE_MS` (default 15 minutes). After that the snapshot counts as empty,
  and every upload goes to quarantine as `stale_directory`. Before Phase 0, a failed refresh kept
  an old snapshot forever, so a corrected row (a wrong id removed, say) might never take effect.
- **Forbidden targets.** `FORBIDDEN_TARGET_SITE_PATHS` lists sites no row may ever route to: at
  least BCR GROUP. The quarantine site is added automatically. Each entry must be a plain
  `/sites/<name>` or `/teams/<name>`, or ingestion refuses to start. A row pointing at one, at a
  host other than `QUARANTINE_SITE_HOSTNAME`, or at a `SitePath` that is not of that form, is
  excluded, and its users' uploads go to quarantine as `forbidden_target`.
- **The resolved site.** Paths are compared as text, so ingestion also checks what Graph
  resolves: if a row's site turns out to be BCR GROUP or the quarantine site (another spelling,
  a renamed site), the write is refused, `sharepoint.forbidden_site` is logged with ids only, and
  the upload goes to quarantine as `forbidden_target`.

## Onboarding a client (Phase 0)

Onboarding step 13 writes the row with an empty `RootFolder` and no user ids, and invites the
client's contact person as a guest (Team access only; a guest has no capability in the ledger).
Until the row is bound, the client account's chat uploads go to quarantine as `unmapped` and its
channel posts wait. A row that somehow carries user ids but no `RootFolder`, `DriveId` or
`TeamId` routes nobody either (`unbound_target`). That is safe but slow, so bind soon after
onboarding:

0. **The client account exists.** Roman creates `<NIP>@bcr-group.pl` by hand, as for 0002 to
   0004: a Member, usage location PL, the licence the other client accounts hold (Business
   Basic), added to the client's Team as a **member**, never an owner, and to no other group.
   Its first password is set by whoever creates it and handed to the client out of band (by
   phone or in person, never over Telegram or plain email), to be changed at first sign-in.
   Until the account exists, `check` reports `client_account_missing` for the row; until it is
   in the Team, `client_account_not_in_team`.
1. **Grant the ingestion managed identity write on the client's site.** Use the onboarding
   repo's `Grant-TeamSiteAccess.ps1` runbook with `AppId` set to the **ingestion Function App's
   managed identity app id** (`INGEST_MI_APPID`, derived as in
   [human-steps → Variables](operations/human-steps.md#variables-used-below)). Never use the
   Ingestion API app registration's id: ingestion never authenticates as it, so a grant to it
   does nothing. The runbook call is in
   [human-steps H-6](operations/human-steps.md#h-6-grant-the-ingestion-identity-write-on-the-quarantine-site).
   Without this grant the tool skips the row. Only once the Phase-0 ingestion is live: under the
   old build, every new grant was one more site content promotion could write into. Confirm the
   grant **read-only** afterwards: `GET /sites/{site-id}/permissions` in Graph Explorer must
   show `write` for `INGEST_MI_APPID`. A `write` entry for the Ingestion API app registration
   does not count; record it for deletion. The runbook is not a check: when it finds no grant it
   creates one, so never run it against BCR GROUP or any other forbidden site.
2. `node tools/directory-bindings.mjs check`, with the variables from
   [human-steps H-7](operations/human-steps.md#h-7-check-the-directory-before-the-deploy-and-add-the-new-columns).
   `FORBIDDEN_TARGET_SITE_PATHS` is required. Set `QUARANTINE_SITE_PATH` and
   `QUARANTINE_SITE_HOSTNAME` as on the ingestion app too, so the tool skips exactly the rows
   ingestion excludes. Review what it reports for **every** row, not only the new one: a
   `guest_ids`, `staff_ids` or `client_account_ineligible` on another row is drift that the same
   plan removes.
3. `node tools/directory-bindings.mjs propose --write-verified <that site's path>`: read the
   proposed `UserAadObjectIds` (the new client's account, and nothing else), `RootFolder`,
   `DriveId` and `TeamId` for the new row, the row's `clientAccount` and `notBound` lists, **and
   every other PATCH in the plan**. The plan can also take ids off other rows: guest ids still on
   a row, or a client account that no longer qualifies.
4. A second person reviews the whole plan. Then apply **the whole plan**, first as a dry run and
   then with `--apply` (`--help` gives the full command):
   `node tools/directory-bindings.mjs apply --plan <plan.json> --health-url https://<ingestion-host>/api/health`.
   **Never `--only <the new row>` after an onboarding.** `--only` binds the new row and leaves the
   plan's other PATCHes unapplied, so an id the plan takes off another row (a guest, or a client
   account now in two Teams) stays there, and an older build would still route it. The tool
   re-reads the client account it binds before writing (still a Member whose UPN is the row's
   `{NIP}@`, not an owner, in this Team alone; whether it is enabled is never checked), prints
   every row before and after, and writes a rollback log.

   **That rollback is not a safe undo after an onboarding.** It restores each row's before-state,
   and the plan may have taken ids off other rows. Putting them back could route them again. So
   `rollback` re-checks every id it would add back, as `apply` does, and refuses a row unless the
   id it puts back is the row's client account (`client_account_recheck_failed`); it never puts
   a guest or staff back, but it cannot undo that row either. A restore that takes the row's
   client account off is allowed, and says so (`unbindsClientAccount`). If the apply went wrong,
   fix the cause, then run `propose` and apply the whole plan again. `--only <listItemId>` limits
   a rollback to named rows, for example the new client's own, which was unbound before
   ([human-steps H-12 → Rollback](operations/human-steps.md#h-12-the-change-window-ingestion-deploy-bindings-canaries)).
5. **Proof, by ids.** With the client-account build: once the channel inbox is on, the new row's
   first `inbox.tick` lines show it swept with `rowsFailed` `0` (its site, drive and channel
   folder resolve), and the client account's first document shows as `inbox.filed` (or
   `inbox.sorted_to_review`) with the row's `listItemId`. If `INBOX_SWEEP_ROWS` is set, add the
   row's list item id first
   ([human-steps H-12](operations/human-steps.md#h-12-the-change-window-ingestion-deploy-bindings-canaries),
   the channel-inbox step). A file the client account sends in the bot's chat shows
   `routed to client via userAadObjectId` with `account: verified` and `membership: verified`,
   then `document.filed`. A synthetic document the client posts by arrangement is a canary too;
   never a real document of another client. BCR's canary accounts (the canary client account and
   the canary guest) never join a real client's Team.
6. **Tell the client how to send documents.** Sign in to Teams with the `{NIP}@bcr-group.pl`
   account, not a guest account. Then either send the file as an attachment in the 1:1 chat with
   "Asystent BCR", or open the Team, channel "Dokumenty księgowe", and add it as an attachment to
   a post or on the „Udostępnione” tab. Filed documents appear in the same channel, in its
   taxonomy folders. `pomoc` in the chat shows the same. Files and messages sent from a guest
   account are not processed. In Phase 0 the app is available to everyone in the org
   ([tenant-hardening T-10](operations/tenant-hardening.md#t-10-teams-app-availability-for-the-bot)).
   If availability is ever restricted, it is restricted to the client Teams' own groups, never
   by adding client accounts to another group (T-10): a `{NIP}@` account stays in its client
   Team and no other group.

## Keeping the bindings current

The tool binds a client account only when it is a member (not an owner) of the row's Team and
the row's Team is the only Team it belongs to, and ingestion checks the Teams again **when each
document arrives** (R46, closed at runtime). A binding can still go stale in the Directory; what
changed is that a stale one no longer files anything:

- **A client account bound to client A that is later added to client B's Team**, or to any other
  Team. A `{NIP}@` account belongs to one company, so this is always a mistake to undo, never an
  ordinary event. From its first upload after it joins the other Team (at most 5 minutes later,
  the cache), everything it sends through the bot is quarantined as `membership_mismatch`, and
  staff triage it by identity; its channel posts wait (`other_teams`), and it cannot search.
  Take it out of the other Team (with Roman), then run `check`. (When clients were taken to be
  guests, this happened on an ordinary business event: one person runs two client companies, and
  B's onboarding invited the same email, which returned the same guest. Their uploads, B's
  documents included, kept filing into A's channel folder until the plan was applied again.)
- **A client account removed from A's Team** is quarantined as `membership_mismatch` in the
  same way, instead of writing into A's folder; its channel posts wait (`not_in_team`).
- **If the Teams cannot be read** (the grant is missing or not yet in the identity's token, Graph
  is down), every bound upload is quarantined as `membership_unverified`, and channel posts wait
  (`unverified`): nothing is filed on a guess. If the account itself cannot be read, the bot
  answers `RetryLater` and nothing is stored.

`MEMBERSHIP_CHECK_MODE=off` switches the check off on the bot path. It is an emergency escape
only, and it reopens the gap above; `/api/health` then reports `build.membershipCheck: "off"`. It
never switches off the client-account rule, and the channel inbox checks the Teams whatever it
says.

The Directory should still say what routing does, so:

1. After **any** onboarding, run `check` and `propose`, and apply the whole plan (steps 2 to 4
   above), even when the new client's own row is not ready to bind yet.
2. Run `check` at least **weekly**. Its exit code decides what to do that day
   ([human-steps → Standing checks](operations/human-steps.md#standing-checks)):
   - `3`: a bound row holds an id that is not its client account (`staff_ids`,
     `staff_ids_removed`, `guest_ids`), or its own account no longer qualifies
     (`client_account_ineligible`, for example after `client_account_in_other_team`). Run
     `propose` and apply the whole plan the same day;
   - `4`: a bound row could not be fully assessed (the `incomplete` rows are listed). Fix the
     read and run `check` again;
   - `5`: **a client is locked out**: a bound row's client account is disabled. Tell Roman at
     once; re-enabling it is his. Never unbind the row for it, and never block, disable,
     unlicense or convert a `{NIP}@` account.

These rules are now defence in depth, not the only control: they keep the Directory truthful,
they catch drift on rows whose client has not uploaded since, and the tool's `check` stays the
way to see it. A Team-membership registry kept in sync is Phase 2. Onboarding writes no user ids
onto the row; that waits on Roman's re-ruling of Q21, and until then the tool binds the client
account.

## Staff

Staff never go on a client row. Staff ids go on one row with `IsAdmin = Yes`, no target, and a
`Title` and a `ClientId` such as `staff` for the logs. A row without a `ClientId` is ignored, so
staff uploads would then show as `unmapped`. A staff upload goes to quarantine as `staff`, and
staff file documents into client folders by hand in SharePoint. There is no staff routing in
Phase 0: the old "admin → route by the document's NIP" path is what the incident was.

Staff are Members, as the client accounts are, so the account type no longer tells staff from
clients: the UPN does. A staff id on a client row by mistake is not the row's `{NIP}@` account:
with the client-account build its uploads are quarantined as `not_client_account`, its channel
posts are left alone, it cannot search, and the tool reports it as `staff_ids` until
`--confirm-remove-staff` takes it off. Never add a client account to BCR GROUP or the staff
channel `Weryfikacja dokumentów`: Teams offers it in the member picker like any staff member.

The channel inbox does not file staff files either. A file a staff member or a member puts at the
top of a client's "Dokumenty księgowe" channel folder stays exactly there: file it by hand into
the right subfolder, or remove it if it was put in the wrong client's channel. The same holds if
a staff member uploads a file with the same name as a client's waiting file and chooses
**Replace**: the file now holds staff's content, so the sweep leaves it, and it must be sorted by
hand. Whatever you do with a waiting file (move it away, file it, rename it) the sweep does not
undo.

Until the full implementation is done, staff do not upload through the bot at all.

## Changing a client

- **The client account joins or leaves a Team:** run the tool again (`check`, `propose`, apply
  the whole plan). Do not edit `UserAadObjectIds` by hand. A guest or a staff member joining or
  leaving the client's Team changes nothing in the ledger.
- **The company is renamed:** add a line to `CompanyNameAliases`, keeping the old ones.
- **The NIP changes:** the NIP names the client account, so the account's UPN and the row's
  `NIP` change together: Roman renames the account to the new `<NIP>@bcr-group.pl` in Entra,
  and the row is edited by hand at the same time. Then run `check`, which must exit 0. While only
  one of them has changed, the account fails the rule: its chat uploads go to quarantine as
  `not_client_account`, its channel posts wait, `check` reports `client_account_ineligible`, and
  a plan made before the edit is refused as stale. The NIP also decides invoice direction for
  future uploads. (Until 28 September this said a NIP change only affected invoice direction.)
- **The client's Team, site or drive changes:** this is a rebind, not an edit. Two people agree
  it, the tool writes the new values, and a canary proves them. Never edit `SitePath` or
  `DriveName` by hand on an active row.

## Offboarding a client

1. Set `Status = Inactive`. Do not delete the row: it keeps the history, and retries and audits
   refer to the `ClientId`. Within the Directory refresh (5 minutes) its channel folder is no
   longer swept either.
2. Whether the client account and any guests stay in the Team is Roman's decision with the
   client. An `Inactive` row routes nobody and is never swept, whatever `UserAadObjectIds` holds;
   the tool examines `Active` rows only, so it leaves them as they are. Nothing in the ledger
   blocks, disables, unlicenses or converts the account.
3. Never reuse the `ClientId`.

If the Team is later deleted and a new Team takes the same site URL, the old row's `DriveId` no
longer matches. Uploads then go to quarantine instead of into the new Team.

## Data-handling notes

- Store only what routing and direction need: ids, NIP, a name for the classifier, and the
  SharePoint target. No other client business data.
- User ids are matched exactly, after lower-casing. Anything that is not a GUID (a UPN, an
  employee number) is ignored.
- Log lines about the list carry list item ids, ClientIds and Team ids, never NIPs, names or user
  ids.
- A client account's UPN is its NIP, so no log line carries it: the root logger redacts
  `userPrincipalName` and `upn`, and the refusal and mismatch lines carry ids and codes only.

## Creating the list from scratch

The list was created with Microsoft Graph Explorer. The Azure CLI cannot `POST /sites/{id}/lists`
in this tenant because of pre-authorisation. To recreate it:

```
POST https://graph.microsoft.com/v1.0/sites/<siteId>/lists
```

```json
{
  "displayName": "Client Directory",
  "description": "Routing directory for the BCR Ledger ingestion agent (Phase 0).",
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
    { "name": "DriveId",            "text": {} },
    { "name": "TeamId",             "text": {} },
    { "name": "TeamsChannelId",     "text": {} },
    { "name": "IsAdmin",            "boolean": {} },
    { "name": "Status",             "choice":  { "choices": ["Active", "Inactive"], "displayAs": "dropDown" } }
  ]
}
```

Then give it unique permissions (Owners only) and turn on versioning
([T-5](operations/tenant-hardening.md#t-5-lock-and-version-the-client-directory-list)). Finally,
set `CLIENT_DIRECTORY_SITE_ID` and `CLIENT_DIRECTORY_LIST_ID` on the ingestion app with
`az functionapp config appsettings set … -o none`, which restarts it.
