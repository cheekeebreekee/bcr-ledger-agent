# Operator tools (Phase 0 containment and incident response)

These tools support Phase 0. They are not part of either Function App: nothing
in `packages/` imports them, and nothing deploys them. They need Node 22 and
nothing else. There are no npm dependencies, so they run from a clean checkout
without `yarn install`.

| Tool | What it is for | Writes to the tenant? |
|---|---|---|
| `directory-bindings.mjs` | Binds each Client Directory row to its Team's "Dokumenty księgowe" folder and its guests (`RootFolder`, `UserAadObjectIds`, `DriveId`, `TeamId`) | Only with `--apply`, and only those four columns (plus two new columns with `--add-columns --apply`) |
| `inventory-misfiled.mjs` | IR-1: a register of every file the ingestion wrote, joined with the IR-0 log evidence | Never |
| `ir0/export-appinsights.sh` | IR-0: exports the routing and upload traces, and the Personal Tab lookup requests (W5), before the component's retention (90 days here) deletes them | Never |
| `ir0/export-purview.ps1` | IR-0: exports the Purview unified audit log (file reads, writes, moves, copies and deletions; group and sharing events; sign-ins of named accounts) | Never |
| `../infrastructure/ir/evidence-store.sh` | An immutable blob container for the IR-0 and IR-1 evidence, with reader RBAC | Only with `--apply` |
| `../infrastructure/quarantine/New-QuarantineSite.ps1` | The staff-only quarantine site (P0-2). See [its README](../infrastructure/quarantine/README.md) | Only with `-Apply` |

## Safety model (every tool)

- **Read-only by default.** A change needs `--apply` (`-Apply` in PowerShell). Without it, a tool prints the change it would make, as the exact request or command.
- **Before and after.** Every tool that writes prints the state it found and the state it left. `directory-bindings.mjs apply` also writes a log of both, which `rollback` restores from, after re-checking every id it would put back on a row.
- **Ambiguity is skipped, never guessed.** A duplicate key (a site, `DriveId` or `TeamId` shared with another row included), a SitePath that is not canonical, a Public team, a non-standard or missing channel, a drive mismatch, an unknown write grant, a fact that could not be read: each one makes the row **SKIP**, with the reason. A guest who is also in any other Team is never bound. This follows invariant I3 of the plan.
- **Never BCR GROUP, never the quarantine.** `directory-bindings.mjs` requires the forbidden list, as the ingestion does, and skips a row on BCR GROUP's site collection whatever the list says. No tool here creates a site permission. A grant goes to the ingestion Function App's managed identity through [H-6/H-12](../docs/operations/human-steps.md), and checking one is a read.
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
| `directory-bindings.mjs check` / `propose` | `User.Read.All` (each id's `userType`), `GroupMember.Read.All` (a Team's members and owners, each guest's `memberOf`), `Group.Read.All` (the list of Teams), `Channel.ReadBasic.All` (the channels), `Sites.Read.All` (the Directory list, each Team's root site, the rows' sites, drives and channel folders). Optional: `Sites.FullControl.All`, to read site permissions. Without it the write grant is "unknown" until you verify it read-only (see [Unknown write grant](#propose)). |
| `directory-bindings.mjs apply` | `Sites.ReadWrite.All` or `Sites.Manage.All`, plus edit rights on the Client Directory list (it has unique permissions). Also `User.Read.All`, `GroupMember.Read.All` and `Group.Read.All`: apply re-reads every guest it binds |
| `directory-bindings.mjs rollback` | `Sites.ReadWrite.All` or `Sites.Manage.All`, plus edit rights on the Client Directory list. Also `User.Read.All`, `GroupMember.Read.All` and `Group.Read.All`: rollback re-reads every id it would put back |
| `directory-bindings.mjs --add-columns --apply` | `Sites.Manage.All` (it creates the columns) |
| `inventory-misfiled.mjs` | `Sites.Read.All` (or `Files.Read.All`), and the signed-in person must be an **Owner or site collection admin of every site walked**. After T-4/T-4b only the site Owners can open the root taxonomy folders, and SharePoint leaves a folder the caller cannot open out of a listing without an error: with a member's token the locked folders, and every file in them, are silently missing. See [IR-1](#inventory-misfiledmjs-ir-1) |

For `directory-bindings.mjs`, the registration therefore needs these delegated
Graph permissions, each **admin-consented** by a Global Admin once:
`User.Read.All`, `GroupMember.Read.All`, `Group.Read.All`,
`Channel.ReadBasic.All`, `Sites.Read.All`, and `Sites.Manage.All` (which also
covers the list writes of `apply`, `rollback` and `--add-columns`). The tool
prints the token's scopes (`scopes`) at the start of every run: compare them
with this list before you start.

**A 403 from the tool means missing consent on that app registration.** A
permission that was added but not admin-consented, or never added, is refused
by Graph with 403 on the first request that needs it. When that request is one
the whole command depends on (the list of Teams, the Directory list),
`directory-bindings.mjs` stops and says so. When it is one row's read (a site,
a Team's members), that row shows it on its SKIP line, and `check` exits 4 if
the row is bound and holds user ids (see [Exit codes](#check)). The fix is the same: consent the permission on the
registration, then get a new token. A 403 on one site only can also mean the
signed-in person cannot open that site.

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
export INGEST_APP_IDS=$INGEST_MI_APPID     # the ingestion Function App's managed identity, not the API app registration
export FORBIDDEN_TARGET_SITE_PATHS='/sites/BCRGROUP'                      # REQUIRED: rows on these are never bound
export QUARANTINE_SITE_PATH='/sites/<quarantine site>'                    # always forbidden
export QUARANTINE_SITE_HOSTNAME='contoso.sharepoint.com'                  # the only host a row may name

node tools/directory-bindings.mjs check [--out <new report.json>]
node tools/directory-bindings.mjs propose [--confirm-remove-staff <listItemId>] [--write-verified <sitePath|listItemId>] [--out <new plan.json>]
node tools/directory-bindings.mjs apply --plan <plan.json> --health-url https://<ingestion-host>/api/health [--expect-health <key=value>]... [--only <listItemId>]... [--apply]
node tools/directory-bindings.mjs rollback --log <apply-log.json> [--only <listItemId>]... [--apply]
node tools/directory-bindings.mjs --add-columns [--apply]
```

Every `--out` names a **new** file: `check`, `propose`, `apply` and `rollback`
all refuse a path that exists, so a path reused from shell history can never
replace an apply log that `rollback` needs, or a reviewed plan.

Use the values the ingestion runs with (its app settings of the same names),
so the tool refuses exactly what the ingestion refuses.

**Guards.** `check`, `propose` and `apply` take the same guard flags, each
with an environment variable. A flag wins over the variable.

| Flag | Environment | What it does |
|---|---|---|
| `--forbidden-site-paths <a,b>` | `FORBIDDEN_TARGET_SITE_PATHS` | **Required**, as the ingestion requires it: BCR GROUP's path at least. A row on one of these sites is skipped as `forbidden_target`. Each entry must be a canonical `/sites/<name>` or `/teams/<name>` path. Anything else (a pasted URL, a `..`) is refused, because it would match no row and switch the check off unnoticed |
| `--quarantine-site-path <path>` | `QUARANTINE_SITE_PATH` | The quarantine site. Always forbidden, as the ingestion forbids it. Optional; without it the tool warns |
| `--tenant-host <host>` | `QUARANTINE_SITE_HOSTNAME` | The tenant's one SharePoint host (`<tenant>.sharepoint.com`). A row whose `SiteHostname` differs, or whose site resolves to another host, is skipped as `forbidden_target`. Optional; without it the tool warns |

Whatever the flags say, a row whose site **resolves** to the Client
Directory's own site collection (BCR GROUP; the collection GUID of
`--site-id`) is skipped as `forbidden_target`. So is a row whose resolved web
URL lands on a forbidden site under another spelling. `apply` checks every
row again against the guards it is given. The plan records the guards it was
made with (`guards`), and `apply` adds them to its own: a recorded value can
only exclude more.

**Site paths: the same rule as the ingestion** (contract C1, one edge-case
table in `test/site-path-cases.mjs` and in the ingestion's tests). The whole
value is trimmed, split on `/`, and empty segments are dropped. It is
canonical only as exactly two segments: `sites` or `teams`, then a name of
letters, digits, `_`, `-` and `.` that does not start or end with `.`. So
`/sites//Foo/`, `sites/Foo` and ` /Sites/foo ` are one site, `/sites/foo`.
Everything else is skipped as `site_path_not_canonical`: a `.` or `..`
segment, `%`, `\`, a space or zero-width character inside the name, a
sub-site (`/sites/A/x`), `/sites` alone, or a first segment that is not
`sites` or `teams`. Graph could resolve such a path to a site other than the
one compared, and the ingestion excludes the row anyway. Correct it by hand
to the path of the Team's root site.

### `check`

Reports on each **Active** row:
- **Staff on a client row.** Ids in `UserAadObjectIds` whose user is `userType = Member`.
- **Drift.** An id on the row that is no longer a guest of this row's Team alone, because the guest has since joined another Team or left this one (`bound_guest_ineligible`). It still routes to this row until a PATCH takes it off.
- **Duplicates across rows.**
  - A shared ClientId, NIP, site, target (`host|path|drive|rootFolder`), `DriveId` or `TeamId` skips every row involved. The ingestion excludes every client row that shares a site, a `DriveId` or a `TeamId`, and quarantines their users as `conflict`.
  - A shared user id is reported. Ingestion drops that key for both rows.
- **Unbound rows.** A client row without all of `RootFolder`, `DriveId` and `TeamId` routes nobody: the ingestion quarantines its users as `unbound_target` until an apply binds all three (`unbound_target`, a warning).
- **The Team.** The Team whose root site is the row's site, found by listing every Team and its `sites/root`. Exactly one Team may claim the site. The check reads its visibility, flags a Public team, and never changes it.
  - A Team whose description does not follow `BCR Group — {recordNumber}` gets the **warning** `team_not_bcr`, not a skip. The Teams that predate onboarding (`[0000]`–`[0004]`, TEST and PESKOVOI among them) never had that description. The Team is already pinned down by the row's own site, so the marker adds nothing.
- **The channel.** There must be exactly one "Dokumenty księgowe" channel, and its `membershipType` must be `standard`.
- **The channel folder.** Its `filesFolder` name, id and `parentReference.driveId`, and whether its parent is the drive root. The drive id is compared with the drive the row's `DriveName` resolves to (`GET /sites/{id}/drives`, exact name, as ingestion matches it).
- **The Team's guests.** A guest is eligible only if this Team is the **only** Team they belong to. `/users/{id}/memberOf` is read with `resourceProvisioningOptions`, and every group that is a Team counts, with or without the `BCR Group —` description. That includes the legacy client Teams and BCR GROUP. A group whose kind cannot be read counts as a Team. A guest who is also in another Team is excluded as `guest_in_other_team`, and the other Team is named. Binding them would file every upload of theirs into this client's channel, including another company's documents. Members and owners are never bound.
- **The write grant.** Whether the ingestion's managed identity (`--ingest-app-ids`, its app id `INGEST_MI_APPID`) can write to the site, from `/sites/{id}/permissions`. If the caller cannot read that, the grant is reported as **"unknown"**, to be verified read-only (see below). A forbidden or non-canonical site gets no grant advice at all.

**Bound rows, unbound rows.** A row is **bound** when it is an Active client
row (not `IsAdmin`) with `RootFolder`, `DriveId` and `TeamId` all set. Only a
bound row routes anyone: the Phase-0 ingestion quarantines the users of any
other row as `unbound_target`. So drift counts only on a bound row:
- **Drift on a bound row** (`staff_ids`, `staff_ids_removed`, `bound_guest_ineligible`) routes an upload where it should not, today. `check` prints an ACTION line and exits 3.
- **The same codes on an unbound row** are printed as **not routing (unbound)**, on the row and in the summary, and do not make `check` exit 3. The PATCH that binds such a row also takes those ids off (staff ids only with `--confirm-remove-staff`). So at H-7, before any row is bound, a staff id on a client row is reported and recorded, not raised as an action. This holds for the Phase-0 ingestion build: the pre-Phase-0 build routes by `UserAadObjectIds` alone, so until H-12 those ids still route, which is why H-7 records them and H-12 removes them.

**Incomplete rows.** "No drift found" only counts where drift could be looked
for. A bound row that holds user ids is **incomplete** when one of these left
its ids unassessed: `site_unresolved`, `no_team` (an unreadable Team site
included), `team_lookup_failed`, `membership_lookup_failed` or
`guest_memberships_unreadable`. `check` marks the row `incomplete`, names it on
an ACTION line, and exits 4 unless there is drift elsewhere. Fix the read (the
row's SKIP line says which; a 403 is missing consent, see
[Authentication](#authentication)) and run `check` again. A bound row with no
user ids routes nobody and is never incomplete.

`--out <file>` also writes the report as JSON (a new file: an existing one is
refused before anything is read). Next to every row's problems it holds:
- `exitCode`: 0, 3 or 4, as below;
- `routingDrift`: the bound rows behind exit code 3;
- `incomplete`: the bound rows behind exit code 4;
- `notRoutingUnbound`: the unbound rows with a drift code, reported only.

Exit codes:
- `0`: every bound row that holds user ids was assessed, and none routes where it should not.
- `1`: refused (a missing or malformed input, an expired token, an `--out` file that exists, a 403 that stops the whole run).
- `3`: **action needed**. A bound client row holds an id that routes there and should not: staff (`staff_ids`, `staff_ids_removed`) or a guest who is no longer a guest of that row's Team alone (`bound_guest_ineligible`). Run `propose` and apply the whole plan, the same day. A scheduled run alerts on this.
- `4`: **action needed**. No drift was found, but at least one bound row that holds user ids could not be fully assessed (`incomplete`, above). Fix the read and run `check` again; until then, drift on that row is unknown. A scheduled run alerts on this too.

3 wins over 4: a run with drift on one row and an incomplete other row exits
3, and the report lists both.

### Codes

Every code `check` and `propose` print, with what it means and what a person
does. A **skip** keeps the row as it is (SKIP in the plan); a **warn** does
not stop a PATCH. Each line also carries a detail with the ids involved.

| Code | Severity | Meaning | What to do |
|---|---|---|---|
| `admin_row` | skip | `IsAdmin = true`: a staff row. Bindings are for client rows only | Nothing |
| `no_client_id` | skip | The row has no `ClientId` | Fill it in by hand, or set the row Inactive |
| `no_site` | skip | `SiteHostname` or `SitePath` is empty | Fill in the client's Team site |
| `site_path_not_canonical` | skip | `SitePath` is not exactly `/sites/<name>` or `/teams/<name>` (see above). The ingestion excludes the row | Correct it by hand to the Team's root site path |
| `forbidden_target` | skip | The row's site is forbidden: on the forbidden list or the quarantine path, on another host, or it resolves to BCR GROUP's site collection or to a forbidden site. The ingestion never files there | A client row never points there. Find the client's own site and correct the row, or set it Inactive. Never widen a guard to let it through |
| `duplicate_clientId` / `duplicate_nip` | skip | Another Active row has the same ClientId or NIP | Decide which row is the client's; set the other Inactive (with Roman) |
| `duplicate_site` / `duplicate_target` | skip | Another Active client row names the same site (or the same host, path, drive and folder). The ingestion excludes both | As above: one site, one client row |
| `duplicate_driveId` / `duplicate_teamId` | skip | Another Active client row already has this `DriveId` or `TeamId`. The ingestion excludes both | As above. A wrong binding on the other row is corrected by hand |
| `duplicate_user_id` | warn | A user id is also on another row. The ingestion drops it for both, so that person's uploads go to quarantine | Decide whose it is; `propose` never adds an id that is on another row |
| `invalid_user_ids` | warn | A `UserAadObjectIds` line is not a GUID | The PATCH rewrites the list without it |
| `unknown_user_ids` | warn | An id on the row matches no user | The PATCH drops it |
| `user_lookup_failed` | skip | An id on the row could not be read | Re-run; check the token's `User.Read.All` |
| `staff_ids` | skip | A staff (Member) id on a client row: once the row is bound, it files that person's uploads into this client (exit 3 on a bound row; "not routing (unbound)" otherwise) | Re-run `propose` with `--confirm-remove-staff <listItemId>` |
| `staff_ids_removed` | warn | Staff ids will be removed, as confirmed | Apply the plan |
| `bound_guest_ineligible` | warn | An id on the row is not a guest of this Team alone any more: also in another Team, or no longer in this one. On a bound row it routes here until the PATCH removes it (exit 3); on an unbound row it routes nobody ("not routing (unbound)") | Run `propose` and apply the **whole** plan now |
| `unbound_target` | warn | `RootFolder`, `DriveId` or `TeamId` is empty: the row routes nobody (the ingestion quarantines as `unbound_target`) | Apply the plan's PATCH, which sets all three |
| `site_unresolved` | skip | Graph could not resolve `SiteHostname` + `SitePath`. On a bound row with ids: `incomplete` (exit 4) | Correct the row, or check the token's site access |
| `team_lookup_failed` | skip | More than one Team claims the site. On a bound row with ids: `incomplete` (exit 4) | Report it; Teams should never allow this |
| `no_team` | skip | The site is not the root site of any Team (the detail says if some Team sites could not be read). On a bound row with ids: `incomplete` (exit 4) | The row must name the client Team's root site; if Team sites could not be read, check `Group.Read.All` and `Sites.Read.All` |
| `public_team` | skip | The client's Team is Public. This tool never changes visibility | The Teams admin makes it Private; then re-run |
| `team_not_bcr` | warn | The Team's description is not `BCR Group — {recordNumber}`. Expected for the Teams that predate onboarding (TEST, PESKOVOI) | Nothing, for those |
| `team_id_conflict` | skip | The row already has a different `TeamId` (I10) | A person decides; change bindings by hand |
| `channel_lookup_failed` | skip | The Team's channels could not be read | Re-run; check `Channel.ReadBasic.All` |
| `channel_missing` | skip | No "Dokumenty księgowe" channel | Create the standard channel (or pass `--channel-name`) |
| `channel_ambiguous` | skip | More than one channel of that name | Rename or remove the extra one |
| `channel_not_standard` | skip | The channel is private or shared: its files live in another site | Use a standard channel |
| `files_folder_unavailable` | skip | The channel's folder is not provisioned or not readable | Open the channel's Files tab once, then re-run |
| `folder_not_at_root` | skip | The channel folder is not directly under the drive root | Report it; do not move folders by hand |
| `folder_name_unsafe` | skip | The ingestion's path sanitiser would rename the folder, so uploads would land in a sibling | Rename the channel |
| `drive_lookup_failed` | skip | The site's drives could not be read | Re-run |
| `drive_not_found` | skip | No drive named exactly `DriveName` (the detail suggests a near match) | Correct `DriveName` (Polish tenants: `Dokumenty`) |
| `drive_mismatch` | skip | The channel folder is in another drive than `DriveName` | Correct `DriveName` |
| `drive_id_conflict` | skip | The row already has a different `DriveId` (I10) | A person decides; change bindings by hand |
| `root_folder_conflict` | skip | The row already has a different `RootFolder` (I10) | A person decides; change bindings by hand |
| `membership_lookup_failed` | skip | The Team's members or owners could not be read. On a bound row with ids: `incomplete` (exit 4) | Re-run; check `GroupMember.Read.All` |
| `guest_memberships_unreadable` | skip | A guest's own memberships could not be read, so they cannot be shown to be in this Team alone. On a bound row with ids: `incomplete` (exit 4) | Re-run; check `GroupMember.Read.All` |
| `guest_in_other_team` | warn | A guest of this Team is also in another Team (named) and is not bound; their uploads go to quarantine | Record it (H-7). Binding them would file another company's documents here |
| `guest_not_in_this_team` | warn | Listed as a member, but their memberships do not include this Team; not bound | Re-run later; the two reads disagree |
| `no_eligible_guest` | warn | No guest belongs to this Team alone; the client's uploads go to quarantine | Record it; invite the client's contact to this Team only |
| `write_grant_missing` | skip | The ingestion's managed identity has no write on the site | Grant it through H-6/H-12 (this client's own site only), then re-run |
| `write_grant_unknown` | skip | The caller cannot read site permissions | Verify read-only (below), then `--write-verified` |
| `incomplete_facts` | skip | (propose) Not enough facts to propose values, with no other reason | Read `check` for that row |
| `target_conflict` | skip | (propose) After the plan, this row would share a site, `DriveId` or `TeamId` with another row, which the ingestion would exclude | Resolve the other row first |
| `user_id_conflict` | warn | (propose) A guest is already on another row, so is not added here | Decide whose guest it is |

The plan also lists, per row, the guests left out (`excludedGuests`) and the
ids a PATCH takes off (`removedUserIds`), each with a reason: `owner`,
`not_a_guest`, `memberships_unreadable`, `guest_in_other_team` (with
`otherTeams`), `guest_not_in_this_team`, `not_a_member_of_this_team`,
`not_found`, `staff`, `not_a_guid`.

### `propose`

Writes a plan: one row per Active row, with an action.
- **PATCH** carries only the fields that change:
  - `RootFolder`: the channel folder name exactly as Graph returns it. Proposed only when the folder is in the row's drive, directly under the drive root, in a standard channel, and the ingestion path sanitiser would not rename it.
  - `UserAadObjectIds`: the guests of this Team and of no other Team. Never Members or owners, and never an id already on another row.
  - `DriveId` and `TeamId`.
- **NOOP** means the row is already bound.
- **SKIP** gives every reason, and still shows the values the row would have had, marked "(not applied)".

Every row also lists `excludedGuests`: the Team's guests who are not bound, with the reason and, for `guest_in_other_team`, the other Teams (`otherTeams`). Read these before applying. `eligibleGuests` is also in the plan: the guests of that Team alone, where the Team's people were read. IR-1 uses it (`inventory-misfiled.mjs --bindings-plan`). It is not what gets written; `patch` is.

Two decisions stay with a person:
- **Staff ids.** A row with staff ids is skipped until you pass `--confirm-remove-staff <listItemId>` for that row. Then those ids are removed.
- **Unknown write grant.** When the grant is unknown, the row is skipped until you check it. **Check it read-only**:
  1. In Graph Explorer, signed in with `Sites.FullControl.All`, run `GET https://graph.microsoft.com/v1.0/sites/{site-id}/permissions`.
  2. It must list a `write` role for the app id of the ingestion Function App's **system-assigned managed identity** (`INGEST_MI_APPID`). A grant to the ingestion API app registration does not count: the ingestion calls Graph only as its managed identity.
  3. Then pass `--write-verified <sitePath or listItemId>`.

  Do not run `Grant-TeamSiteAccess.ps1` to "verify". It is a write: if it finds no write grant, it **creates** one. Run it only to grant write on this client's own site, to the managed identity, never on a forbidden site such as BCR GROUP. After H-13 there it would undo the downgrade to read.

An existing, different `RootFolder`, `DriveId` or `TeamId` is never overwritten.
The row is skipped for a person to decide (I10).

The plan is written to `tools/out/directory-bindings-plan-<UTC>.json`, or to
`--out` (a new file: an existing one is refused before anything is read), and
its sha256 is printed. It records the guards it was made with (`guards`), and
carries a `digest` of **every other field**: `kind`, `version`, `createdAt`,
`directory`, `ingestAppIds`, `guards` and `rows`. So a plan whose date, target
list or guards were edited is refused as surely as one whose rows were.

### `apply`

Before it writes anything, `apply` refuses a plan in any of these cases:
- the plan's digest no longer matches: it was **edited** after `propose`, in its rows, its `createdAt`, its `directory` or its `guards`;
- the plan is **older** than `--max-plan-age-hours`. The default is 72, and 72 is also the most it accepts: no flag widens it. Changing `createdAt` breaks the digest: an old plan needs a new `propose`;
- the forbidden list is not given (`FORBIDDEN_TARGET_SITE_PATHS` or `--forbidden-site-paths`), or a guard value is malformed;
- `--only` asks for a **SKIP** row;
- the **ingestion health** check fails. `--health-url` must be `https` and answer 200, and its JSON must report `build.routing=identity-only`. Only the Phase-0 build does (`"build":{"phase":"p0","routing":"identity-only"}`). This is always required. `--expect-health key=value` adds further checks, with dotted keys reaching into nested objects; it can never replace this one. A value such as `status=ok`, which the old build also reports, does not open the gate;
- the plan patches `DriveId` or `TeamId` and those **columns are missing**. Run `--add-columns --apply` first;
- the log file (`--out`) already exists. A log never replaces another file, such as an earlier log or the plan itself.

For each PATCH row, `apply`:
1. reads the row again;
2. refuses it if any binding field or guard field (`ClientId`, `SiteHostname`, `SitePath`, `DriveName`, `Status`, `IsAdmin`) changed since `propose` (**stale**);
3. resolves the row's site again and refuses it as **`forbidden_target`** if the guards it was given forbid it (see [Guards](#directory-bindingsmjs)), or as **stale** if `SitePath` now resolves to another site than at `propose`;
4. re-reads every guest the row will route after the PATCH: each must still be a `Guest`, and the Teams in its `memberOf` must be exactly the row's `TeamId`. A guest who has since joined another Team, left this one, become a Member or been deleted makes the row **stale**; nothing is written for it;
5. logs the row as `writing`, with its before-state, and writes the log to disk;
6. PATCHes `/sites/{s}/lists/{l}/items/{id}/fields` with only the planned fields;
7. reads the row back and compares.

Without `--apply`, `apply` does all the checks and reads, and writes nothing.
With `--apply`, it writes `tools/out/directory-bindings-apply-<UTC>.json` (or
`--out`, a file that must not exist yet), which holds the before-state and
after-state of every row. The log is on disk before each PATCH is sent and
again after it. Every rewrite goes to a temporary file that is fsynced and
renamed over the log, so a crash leaves the previous version whole, never a
truncated file. If a run is interrupted, the log still names every row it may
have written:
- `writing`: the run stopped with the PATCH in flight;
- `write_unknown`: the PATCH threw, so it may or may not have landed.

Other results in the log: `patched` (written and read back), `patched_mismatch`,
`patched_unverified`, `stale` (with `staleFields` or `staleReasons`),
`forbidden_target` (with `forbiddenReasons`), `failed` (a read failed before
any write), `dry_run`.

`--only <listItemId>` applies some PATCH rows and not others. It exists for
the staged Phase-0 rollout (TEST, then PESKOVOI). **After an onboarding, never
use it**: apply the whole plan (see [the standing rule](#after-every-onboarding-and-weekly)). When
`--only` leaves out a PATCH row that takes ids off a row, `apply` says so.

Exit codes:
- `0`: done.
- `1`: refused before any write.
- `2`: some rows were stale, forbidden, failed, read back differently, or ended `write_unknown`. See the log.

### `rollback`

Restores the before-state of the rows that an apply log says it wrote: every
one, or with `--only <listItemId>` (repeatable) only those. `--only` naming a
row the log records no write to is refused.

**Rolling back is not safe by default.** It is safe when the apply only bound
rows that were unbound: the restore unbinds them, and they route nobody. It is
not when the apply took ids **off** a row (a guest now in a second Team, staff
removed with `--confirm-remove-staff`, a canary guest): the restore would put
them back, and a guest in two Teams would route the second company's
documents into the first client's channel again. So rollback re-checks every
id the restore would **add** to `UserAadObjectIds` (the restored list minus
the ids on the row now), as `apply` re-checks the guests it binds, against the
`TeamId` the row will have after the restore: each must still be a `Guest`,
and the Teams in its `memberOf` must be exactly that `TeamId`. A Member (staff)
never passes, and neither does any id when the restore leaves the row without
a `TeamId`. If one fails, the row is refused as **`guest_recheck_failed`**
(with `readdedUserIds` and `recheckReasons` in the rollback log), nothing is
written to it, and the run exits 2. A row whose restore adds no id is
restored as before.

To undo an apply that took ids off a row, **prefer re-running `propose` and
applying the whole plan** over a rollback: the new plan binds exactly the
guests of each Team alone. Never put a refused id back by hand.

For each row, rollback also refuses:
- a row someone has changed since the apply (`changed_since_apply`), rather than overwrite it;
- a `writing` or `write_unknown` row with no before-state in the log (`no_before_state`).

A `writing` or `write_unknown` row is checked against the live row:
- if the live row still holds its before-state, the PATCH never landed. It is recorded as `not_written` and left alone;
- if the live row holds the planned values, it is restored (after the re-check above);
- anything else is refused.

Without `--apply` it is a dry run: it does every read and check, the guest
re-check included, and writes nothing. With `--apply` it writes its own log
(`--out` must not exist yet), also flushed before each PATCH, in the same
crash-safe way.

Exit codes:
- `0`: every selected row was restored or found `not_written`.
- `1`: refused before any write (not an apply log, `--only` naming a row the log did not write, an `--out` file that exists).
- `2`: some rows were refused (`guest_recheck_failed`, `changed_since_apply`, `no_before_state`), failed, read back differently, or ended `write_unknown`. See the log.

### `--add-columns`

Creates the single-line text columns `DriveId` and `TeamId` on the list, if they
are missing. It refuses when a column with that display name exists under a
different internal name, because ingestion reads internal names.

### Procedure (the P0 change window)

1. `--add-columns --apply`.
2. `check`. Fix what only a person can fix: DriveName, a Public client team, the channel, a non-canonical SitePath. `team_not_bcr` on a legacy Team is expected and does not block.
3. `propose`, and review the plan file, including `excludedGuests`. Confirm staff removals and verified grants by re-running `propose` with the flags.
4. `apply --plan …` as a dry run, then with `--apply`, in the same change window as the P0 ingestion deploy.
5. One canary upload per bound client. Then run `check` again.
6. After the window, downgrade the ingestion grant on BCR GROUP to `read`.

### After every onboarding, and weekly

A guest's binding is checked when it is proposed and again when it is
applied. Onboarding a second company whose contact person is already a
guest reuses that guest and adds them to the new Team; their row stays
bound to the first client until someone applies a new plan. Ingestion's
upload-time check (below) now quarantines their uploads meanwhile, instead
of filing the second company's documents into the first client's channel,
but the Directory still says otherwise. So, as a standing rule:

- **After any onboarding**, run `propose` and apply the **whole** plan, never
  `--only <new row>`. The PATCH that matters may be on another row: the one
  that takes the reused guest off the first client. Once applied, a guest in
  two Teams is on no row, and the ingestion quarantines their uploads.
- **Run `check` at least weekly**, and after any onboarding that reuses an
  existing guest. Exit code 3 (`bound_guest_ineligible` or `staff_ids` on a
  bound row) means an id routes where it should not: propose and apply the
  whole plan the same day. Exit code 4 means a bound row could not be
  assessed (`incomplete`): fix the read and run `check` again the same day,
  because 0 is the only "all clear".
- **Do not undo an onboarding with `rollback`.** Re-run `propose` and apply
  the whole plan instead (see [rollback](#rollback)).

Ingestion now also checks membership at upload time (R46): a bound uploader
whose Teams are not exactly the row's `TeamId` is quarantined as
`membership_mismatch`. It counts Teams by the same rule as this tool
(`isTeamGroup`, minus the tenant Team listing; the `BCR Group —` marker is
kept identical by a test in the ingestion package), so change both or
neither. The rules above stay as defence in depth: they keep the Directory
true, and catch drift on rows whose guests have not uploaded since.
Onboarding writing the guest's id to the new row waits on Roman's re-ruling
of Q21.

## `inventory-misfiled.mjs` (IR-1)

```bash
node tools/inventory-misfiled.mjs \
  --site 'BCRGROUP=contoso.sharepoint.com:/sites/BCRGROUP' \
  --site 'PESKOVOI=contoso.sharepoint.com:/sites/<client site>' \
  --site 'TEST=contoso.sharepoint.com:/sites/<test site>' \
  --ingest-app-ids $INGEST_MI_APPID \
  --fallback-site BCRGROUP \
  --ir0 tools/out/ir0-appinsights-<UTC>/ \
  --bindings-plan tools/out/directory-bindings-plan-<UTC>.json \
  --expect-root-folders 'BCRGROUP=<the folders T-4 saved, comma-separated>' \
  --expect-root-folders 'PESKOVOI=<the folders T-4b saved>' \
  --expect-root-folders 'TEST=<the folders T-4b saved>'
```

**Run it with the token of an Owner or site collection admin of every site
walked.** After T-4/T-4b only the site Owners can open the root taxonomy
folders. SharePoint leaves a folder the caller cannot open out of a listing,
with no error, so with a member's token the locked folders and every file in
them are silently missing from the register, from IR-2, and from the list of
affected clients. Two things make that visible:
- For each site and drive, the tool always prints the taxonomy folders
  (`NN_…`) it found at the library root, and the register keeps every root
  folder name (`sites[].drives[].rootFolders`).
- `--expect-root-folders <site>=<name,name,...>` (repeat per site; `<site>` is
  a `--site` label or path) names the folders that must be there: the list
  saved in T-4/T-4b "Read first". Names compare case-insensitively. If one is
  not seen, the register is still written, marked `"complete": false` with
  `missingRootFolders`, and the tool prints **INCOMPLETE** and exits **3**.
  Re-run with an Owner's token; if a folder really is gone, record that in
  the incident and drop it from the list.

**Give it the IR-0 export.** Without `--ir0`, nothing says who uploaded a
file or where it was routed, so every file the ingestion created or modified
is suspect (`no_ir0_given`). If the laptop copy was deleted after H-2, restore
the export from the evidence store first (a named reader, read-only):

```bash
az storage blob download-batch --auth-mode login --account-name <evidence account> \
  --source ir0-evidence --pattern 'ir0/<date>/ir0-appinsights-<UTC>/*' --destination tools/out/
chmod -R go-rwx tools/out     # client data: owner-only, as the tools write it
# then: --ir0 tools/out/ir0/<date>/ir0-appinsights-<UTC>/
```

Check the downloaded files against the `SHA256SUMS` stored with them, and
delete the local copy again once IR-1 and IR-2 are done.

It walks every folder of each site's drive (`--drive-name`, default `Dokumenty`,
or `--all-drives`). It registers every file the ingestion identity created or
last modified (by `createdBy.application.id`; the ingestion wrote as its
managed identity, `INGEST_MI_APPID`), and every file IR-0 names. With
`--all-items`, it registers every file. Check the printed "Applications that
created files" list: an application that wrote under a root taxonomy folder
and is not in `--ingest-app-ids` is added and the run repeated.

Each register row records:
- the `driveItemId`, the path, the created and modified times, `createdBy.application.id` and the size;
- every version, with its size and time;
- the IR-0 evidence, joined on `driveItemId`: routing (fallback or directory), whether content promotion moved the file, the uploader's AAD object id, and the site the log says the file went to. **Every** `uploaded` line of the item is kept (`ir0.uploads`, and `ir0_uploadCount` and `ir0_allUploads` in the CSV).

It also lists the applications that created files. Check `--ingest-app-ids`
against that list.

**How the uploader is joined.** `uploaded` carries the `driveItemId` and the
`invocationId`, and `client resolved` shares that `invocationId`. The
resolver's line, which holds the `userAadObjectId`, has no `invocationId`. It is
matched by `conversationId` (fallback) or `clientId` (directory), within
`--window-ms` (default 10 s) before `client resolved`. If two different ids
match, the uploader is **ambiguous**: both are listed, and neither is picked.
The same holds across uploads: if one item was uploaded more than once
(the legacy upload replaced a file of the same name), the uploaders of all its
uploads are candidates, and two different people make it ambiguous.

**Whose site it is.** "Routed by identity" (resolution `directory`) means the
upload went to the row that held the uploader's id. Before Phase 0 the only id
on any client row was staff, so it does not mean "uploaded by that client". An
identity-routed upload is clean only if every candidate uploader is a guest of
the site's own Team. The guest lists come from:
- `--bindings-plan <plan.json>`: a `directory-bindings.mjs propose` plan, which records each row's `eligibleGuests`, the guests of that Team alone. A site that two plan rows share is not used. The plan shows membership when it was made, not at upload time;
- `--site-guests <label>=<oid,oid,...>`: the guests of one walked site, by `--site` label or path. Repeat it per site. It adds to the plan's list.

Without either, every identity-routed upload is suspect
(`uploader_guest_unverified`).

IR-1 does not read sharing links or join the Purview export: IR-2 checks those
per item, for the suspect rows.

Flags that make a row suspect:

| Flag | Meaning |
|---|---|
| `fallback_site` | On the site named by `--fallback-site`, and written by the ingestion |
| `ir0_fallback` | Routed to the fallback bucket and not promoted |
| `promoted_by_content` | Moved into a client by a NIP found in the document (R3) |
| `admin_uploader` | The uploader matched an admin row |
| `uploader_ambiguous` / `uploader_unknown` | The uploader cannot be told from the log |
| `uploader_not_site_guest` | Routed by identity, and an uploader is not a guest of the site's own Team (staff, most often) |
| `uploader_guest_unverified` | Routed by identity, and no guest list was given for that site |
| `ir0_site_mismatch` | The log says a different site than the one the file is on |
| `ir0_batch_missing` | An `uploaded` line with no `client resolved` line for it |
| `ir0_filename_repeated_in_batch` | Two documents of one name in one batch (the legacy bot named every unnamed attachment `attachment.bin`), uploaded or not: a sibling that was classified, even promoted, and then failed counts too. Their `classified`/`refined` lines cannot be told apart, so none takes one |
| `no_ir0_record` | Written by the ingestion, but absent from IR-0 (older than the logs) |
| `no_ir0_given` | Written by the ingestion, and IR-1 ran without `--ir0`: nothing says who uploaded it or where it was routed |
| `overwritten_by_ingest` | Created by someone else, last modified by the ingestion |
| `multiple_uploads_same_item` | More than one `uploaded` line for one item. Every upload and its uploader is listed |
| `has_prior_versions` | More than one version. An earlier version can hold another document: the legacy upload replaced files of the same name. IR-2 deletes non-current versions before any move |
| `versions_unreadable` | The version history could not be read, or was not read (`--no-versions`) |
| `not_found_in_walk` | In IR-0 on a walked site, but not found there (moved or deleted) |
| `site_not_walked` | In IR-0 on a site that was not walked. **Add that site and re-run.** |

Context flags, which don't make a row suspect on their own:
- `ingest_created`
- `library_root`: not in the channel folder (R5)
- `taxonomy_folder`

The tool writes `tools/out/ir1-inventory-<UTC>.json` and `.csv`, and prints
their sha256. The JSON holds the parameters, input hashes, per-site counts and
root folders, `complete` and `missingRootFolders`, the summary and the rows. In
the CSV, a cell that starts with `=`, `+`, `-` or `@` is prefixed with `'`,
because the file names come from uploaders.

Exit codes:
- `0`: done.
- `1`: refused (a missing or malformed input, an expired token, a site or drive not found).
- `3`: the register is written, but an `--expect-root-folders` folder was not seen: it may be short. See above.

## `ir0/export-appinsights.sh`

```bash
tools/ir0/export-appinsights.sh --app <component name> --resource-group rg-bcr-ledger-dev [--all-traces]
```

- Runs `ir0/routing-traces.kql`, which parses the pino JSON in `traces.message`. It selects the pre-Phase-0 routing and upload messages, and the Personal Tab lookup lines (W5): `personal tab resolved`, `user-target lookup failed` and `user target resolved`.
- Always also runs `ir0/personal-tab-requests.kql` into `requests-<chunk>.json`: the `requests` rows for `/api/mydocs` and `/api/user-target`, with `url` (the user id looked up), `resultCode`, `client_IP` and the geo columns. Requests are not sampled, so this is the full record of calls to the anonymous lookup, which Purview cannot see. App Insights masks `client_IP` by default; the geo columns survive.
- Keeps `itemCount` on every row. Traces are sampled; an `itemCount` above 1 means the row stands for that many, so the export is not complete.
- Uses 24-hour chunks over the last `--days` (default 90; match the component's `retentionInDays`), or `--start`/`--end` in UTC.
- Always passes **both** `--start-time` and `--end-time`: with only a start, the CLI's window is one hour.
- Stops if a chunk reaches the API row limit, because a truncated export looks complete.
- `--all-traces` also exports every trace, unfiltered.
- Writes owner-only files, both queries, `export-meta.txt` (window, operator, subscription, tool commit) and `SHA256SUMS`, and prints every hash.

It needs the `application-insights` az extension and read access to the
component.

## `ir0/export-purview.ps1`

```powershell
Connect-ExchangeOnline -UserPrincipalName <auditor>
./tools/ir0/export-purview.ps1 -SiteUrl https://contoso.sharepoint.com/sites/BCRGROUP, … -StartDate 2026-06-01T00:00:00Z `
    -SignInUpn <account@contoso.example>, …
```

It runs `Search-UnifiedAuditLog`, paged with `ReturnLargeSet` sessions. It
splits a window that reaches the 50,000-record session cap, and retries a
session that reports `ResultIndex -1`. It writes these CSVs, each keeping the
raw `AuditData`:
- **File operations** on the sites (`purview-file-operations.csv`). By default:
  - reads: FileAccessed, FilePreviewed, FileDownloaded, FileSyncDownloadedFull, FileSyncDownloadedPartial;
  - writes: FileUploaded, FileModified;
  - moves and copies: FileMoved, FileCopied, FileRenamed;
  - deletions: FileDeleted, FileRecycled, FileDeletedFirstStageRecycleBin, FileDeletedSecondStageRecycleBin.

  The old ingestion never moved, copied or deleted a file, so every such event is a person's. They are also the only record of an item leaving the walked libraries. `-FileOperations` narrows the list; don't narrow it for the incident export.
- **Group and Teams membership and settings events** (`purview-group-events.csv`). These are tenant-wide in the window.
- **Sharing events** on the sites (`purview-sharing-events.csv`).
- **Sign-ins** of the accounts named with `-SignInUpn` (`signins.csv`): UserLoggedIn and UserLoginFailed (RecordType `AzureActiveDirectoryStsLogon`). Without Entra ID P1, the Entra sign-in log keeps 7 days and Graph cannot read it. The unified audit log keeps these events for the Audit (Standard) period. Without `-SignInUpn`, there is no sign-in export.

It also writes metadata (including the operations and accounts exported) and
`SHA256SUMS`, which covers every file. It needs PowerShell 7,
ExchangeOnlineManagement, and the "View-Only Audit Logs" role.

## `infrastructure/ir/evidence-store.sh`

```bash
ROMAN_UPN=<roman> IOD_UPN=<iod> infrastructure/ir/evidence-store.sh \
  --resource-group rg-bcr-ir-evidence --account <storage account name> \
  --upload-dir tools/out/ir0-appinsights-<UTC> --grant-uploader [--apply]
```

It creates a StorageV2 account with these settings: no public access, no
shared keys, TLS 1.2, blob versioning, and a CanNotDelete lock. It reuses an
existing account only if it already has no public access, shared keys off
(`allowSharedKeyAccess=false`; unset counts as on) and TLS 1.2. Otherwise it
stops: it never changes an account it did not create. It creates a container
with **version-level immutability** and a time-based retention
(`--retention-days`, default 400).

The policy is left **unlocked**. The script prints the lock command, which is
irreversible, for a person to run once the evidence is in and checked.

"Storage Blob Data Reader" on the container goes to Roman, the IOD and the CTO
(`yahor.simak@bcr-group.pl`). `--apply` refuses while `ROMAN_UPN` or `IOD_UPN` is
unset. A reader who is outside the tenant must be invited as a guest first.

Before it creates or uploads anything, the script lists every role assignment
that reaches the container, including those inherited from the account,
resource group, subscription or above, and judges each by **what its role
definition permits**, not by its name: a role is a reader when a permission
block's `dataActions` match
`Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read`
(wildcards such as `*` or `Microsoft.Storage/*` included) and its
`notDataActions` do not. So a custom role, or a built-in under another name,
that can read blobs is caught. It stops, in a dry run too, unless each such
assignment is a named reader's built-in Storage Blob Data Reader or, with
`--grant-uploader`, the operator's built-in Storage Blob Data Contributor
(both matched by role definition id). Listing the definitions needs
`Microsoft.Authorization/roleDefinitions/read`, which any Reader has.

`--grant-uploader` gives the operator Contributor on the container, only for
the upload. That role can read too, so **the operator must be one of the
named readers** (Roman, the IOD or the CTO); `--apply` refuses anyone else.
The script does not remove the role: the account's CanNotDelete lock refuses
the delete, and lifting the lock is for a person. It prints the exact
`az role assignment delete` command and the lock procedure. An `--apply` run
with `--grant-uploader` then ends with **INCOMPLETE** and **exit code 3**:
the operator still holds write access. Remove it once the upload is checked
against `SHA256SUMS` (H-2 step 6), and confirm with a run without
`--grant-uploader`, which stops while the role is still there.

Exit codes: `0` done; `1` refused or failed; `3` applied, but the operator
still holds write access.

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
- `test/ir0-fixture.mjs`: fake pino traces;
- `test/site-path-cases.mjs`: the site-path edge cases of contract C1. The ingestion's tests hold the same table; change both together.

They drive the CLIs end to end, and assert that read-only commands issue only
GET requests and that the token never reaches the output.
