# Security and compliance

Written for whoever reviews the ledger's security, and for anyone about to change how
documents are routed, stored or logged.

This page was corrected on 25 September 2026, after incident
[`IR-2026-09`](operations/incident-2026-09.md) showed that it described protections the system
did not have. In particular, it claimed that `Sites.Selected` limited the ingestion identity to
one SharePoint site. Each threat now has a status:

| Status | Meaning |
|---|---|
| **Mitigated** | In place before Phase 0 and still valid. |
| **P0** | Fixed by the Phase-0 code or a Phase-0 tenant step. Live once the steps in [`human-steps.md`](operations/human-steps.md#phase-0) are done. |
| **Client identity** | The client-account rule (below). Live since 29 September 2026: rows re-bound 10:58Z, ingestion deployed 11:02Z, the bot 11:08Z. |
| **Phase N** | Planned in the v2 plan, phase N. Until then the threat is open. |
| **Accepted** | Recorded as an accepted risk, with an owner, in [Accepted risks](#accepted-risks). |

**Corrected again on 29 September 2026: who the client is.** This page described the clients as
Teams guests. On 28 September the owner decided that a client's identity is its
`{NIP}@bcr-group.pl` account: an Entra **Member**, licensed, created by BCR and handed to the
client, who uses it for channel posts, the bot's 1:1 chat and search. Guests have **no**
capability in the ledger. The entries below describe the code that implements this
(`build.clientIdentity: 'nip-member'` in ingestion's `/api/health`); see T22.

That code went live on 29 September: rows 2 (PESKOVOI) and 10 (the canary) were re-bound to
their client accounts at 10:58Z, ingestion was deployed at 11:02Z and the bot at 11:08Z, and the
canary client account proved the chat and channel paths
([incident record](operations/incident-2026-09.md)).

The decision followed a lockout. On 26 September at 12:18Z, tenant step T-1 blocked sign-in on
the three `{NIP}@` accounts (0002 PESKOVOI, 0003, 0004). The premise, taken from the onboarding
repo's `audit-client-access.mjs` and `client-access.md` (23 September), was that they were
shared mailboxes nobody signs in with. They are the clients' Teams sign-ins, so the three
clients could not sign in to Teams until Roman re-enabled the accounts on 28 September at about
17:34Z. No document was lost ([incident](operations/incident-2026-09.md)). T-1 and T-2 are
withdrawn: nothing may ever block, disable, unlicense or convert a `{NIP}@` account.

## 1. Identity model

| Trust boundary | Principal | Credential | Checked by |
|---|---|---|---|
| Client → Teams (and through it the bot and the channel) | The client's `{NIP}@bcr-group.pl` account: an Entra Member, licensed, created by hand by BCR (Roman) and handed to the client, a member (never an owner) of its own client Team only. Guests have no capability (T22) | A password BCR hands over (see T22 on the handover). No Conditional Access (no P1, T14); MFA follows the tenant's security defaults **[verify]** whether they are on | Entra at sign-in. Then the bot's gate (T1) and, in ingestion, the resolver: the account read first (a Guest, a non-Member or a deleted user is refused with nothing stored), bound on exactly one row, its UPN exactly `{row NIP}@bcr-group.pl`, its Teams exactly the row's `TeamId`. The channel inbox applies the same rule to a file's creator (T18). **Client identity** |
| Teams client → bot | Bot Framework | JWT signed by `login.botframework.com` | `CloudAdapter`, then the bot's gate on **every** activity type: a 1:1 chat, from the BCR tenant, with a GUID user object id (P0) |
| Bot → ingestion (`/api/ingest/batch`) | The bot's app registration | Client secret (Key Vault, and laptop copies: see T15) → token for `api://<ingestion-app-id>` | `AuthMiddleware`: issuer, audience, the `Documents.Ingest` role, and **the caller's app id** (`appid`, else `azp`) in `BOT_CALLER_APP_IDS` (P0). Then the request body: `conversationType` must be `personal`, the user id must be a UUID, and the tenant must be BCR's (P0). |
| Bot → ingestion (`/api/search`) | The bot Function App's system-assigned managed identity | Managed identity token for `api://<ingestion-app-id>`; no secret exists | `AuthMiddleware`, before the body is read: issuer, audience, the `Documents.Search` role, and the caller's app id in `SEARCH_CALLER_APP_IDS` (that identity only; never an id of `BOT_CALLER_APP_IDS`). Then a strict body, and the asker resolved like an uploader, so required to be the row's `{NIP}@` client account (see T21). |
| Ingestion → Microsoft Graph | The ingestion Function App's system-assigned managed identity | Managed identity token | Graph. `Sites.Selected`, plus a per-site grant on every site it files into (see T3). `Directory.Read.All` (read-only), to read the uploader's account (`userType`, `userPrincipalName`) and Team memberships at request time (see T10, T22), and, for the channel inbox, a file creator's account and Teams (see T18). |
| Channel inbox timer → ingestion logic | None: a timer trigger | None | Not a route. It takes no input, so nothing outside can name a user, a row or a target to it (T18). |
| Bot, ingestion → Key Vault | Each app's managed identity | *Key Vault Secrets User*, assigned at **resource-group** scope | Key Vault (see T11) |
| Ingestion → Claude | Anthropic API key (Key Vault) | TLS and bearer key | `api.anthropic.com`: document content (see T16), and client search's questions (see T21) |
| Ingestion → document index (PostgreSQL) | The ingestion Function App's managed identity, as a login named after the app (`pgaadauth_create_principal`) | An Entra token per connection; the server has password authentication disabled | The server (Entra only, TLS 1.2+); then `SET LOCAL ROLE ledger_app` and row-level security per client transaction (see T19) |
| Operator → document index | The server's Entra administrator (a person) | A token from `az login` | The server; a firewall rule for the operator's IP, for one session (see T19) |

**The ingestion identity's site grants.** Before Phase 0, it had `write` on TEST, PESKOVOI and
BCR GROUP. Phase 0 adds `write` on the quarantine site, and on each client site bound in the
Phase-0 change window. It downgrades BCR GROUP to `read`, because the Client Directory is read
there and nothing may be written there. Every grant names the managed identity's app id. A grant
to the Ingestion API app registration gives ingestion nothing, because ingestion never
authenticates as it, but it makes a permissions list look as if ingestion can write. Such
entries are recorded for deletion.

## 2. Secrets inventory

| Secret | Where it lives | Used by | Note |
|---|---|---|---|
| `bot-app-password` | Key Vault; **also plaintext in developers' `.env` files** | The bot, as `MICROSOFT_APP_PASSWORD` | Rotation deferred ([accepted](#accepted-risks)). Phase 3 replaces it with a federated credential. |
| `anthropic-api-key` | Key Vault; **also plaintext in developers' `.env` files** | Ingestion, as `ANTHROPIC_API_KEY` | Rotation deferred ([accepted](#accepted-risks)). |
| Review channel webhook URL (`review-webhook-url`) | Key Vault, read by the ingestion identity as `REVIEW_WEBHOOK_URL` (a Key Vault reference) | The review notifier | The whole URL is the credential: anyone holding it can post into the staff chat. Entered by `tools/ops/set-review-webhook.sh` without echo; never logged. Rotate by deleting the flow, creating a new one, storing its URL, then refreshing the app's Key Vault references and restarting ingestion (the versionless reference is cached). |
| Storage account key | **In plain text in the `AzureWebJobsStorage` app setting** of both apps (`functionApp.bicep` reads it with `listKeys()`) | The Functions runtime | `az functionapp config appsettings set` prints it unless you pass `-o none`. The fix is identity-based storage access, or at least a Key Vault reference: [follow-up F1](#follow-ups-from-the-g1-review). The Bicep drift fix (G1) only records what runs, so it is a change of its own. |
| Function keys | Azure platform | Not used | Functions are `authLevel: 'anonymous'`; each handler checks the JWT itself. |
| Document index database | — | — | **No secret exists.** Password authentication is disabled; the ingestion and the operator log in with Entra tokens (T19). `LEDGER_DB_*` settings are configuration. |

Everything else in the app settings is configuration, not a secret. Key Vault values reach the
apps as `@Microsoft.KeyVault(SecretUri=...)` references. A rotation is `az keyvault secret set`
followed by a restart. When rotation happens, the laptop copies are deleted at the same time.

## 3. Threat model

### T1. A forged or out-of-scope Teams activity

**Before:** the bot checked the Bot Framework JWT and nothing else. It accepted messages from any
conversation type (team, group chat) and any tenant, so a document posted in a shared chat could
be filed, and the reply shown to everyone in that chat.
**Now:** the JWT, plus a gate middleware on every activity type: messages, invokes, updates and
reactions. It runs before any download. It starts in `log` mode for 24 hours, then `enforce`.
Manifest 0.2.0 has personal scope only. **Status: Mitigated (JWT); P0 (gate).**

### T2. A replayed or duplicated upload

**Before:** the JWT's 5-minute lifetime, HTTPS, and a filename de-collision that probed for a
free name and then wrote. The probe and the write were separate, so two uploads could take the
same name, and the second overwrote the first. One SharePoint item could then hold two different
documents, possibly from two clients, in its version history.
**Now:** uploads use `@microsoft.graph.conflictBehavior=fail` with a suffix retry, `_1` to `_10`,
and there is no probe. **Status: P0.** A replay within the token's lifetime still files a second
copy in the same client's space. So can a PUT that failed on the network but had landed: its
retry takes a suffixed name, and that case is logged as `sharepoint.possible_duplicate` for staff
to check. The service itself retries only network failures, 500 and 502, and leaves 429, 503
and 504 to the Graph SDK, so retries do not stack; a batch starts no document after 150 s.
De-duplication comes with the document index (Phase 2).

### T3. The ingestion identity writes to the wrong site (corrected)

**What this page used to say:** "mitigated by `Sites.Selected`, scoped to a single SharePoint
site". **That is wrong.** `Sites.Selected` is a per-site allow-list. One identity writes every
client's documents, so it holds `write` on every client site it files into, by design.

Anything that controls what that identity writes can write into every one of those sites:

- a routing bug, such as content promotion (T8);
- a crafted document that steers the code;
- a stolen token.

**Phase 0 narrows what decides the target:**

- identity only (T8);
- a row routes only once the binding tool has set its `RootFolder`, `DriveId` and `TeamId`
  (`unbound_target` otherwise);
- one client per Team: rows sharing a site, a `DriveId` or a `TeamId` are all excluded;
- the uploader must be the row's `{NIP}@bcr-group.pl` client account: a Guest is refused with
  nothing stored, and any other Member bound on the row is quarantined as `not_client_account`
  (next build; T22);
- the uploader's Teams, read from Entra at upload time, must be exactly the row's `TeamId`
  (`membership_mismatch`, or `membership_unverified` if they cannot be read; see T10);
- a `SitePath` must be exactly `/sites/<name>` or `/teams/<name>` on the tenant's one host, so
  a sub-site or a look-alike spelling of another site is refused, not normalised;
- no BCR GROUP or quarantine target, checked twice: by path in the Directory, and by the
  resolved site-collection id before each write (`sharepoint.forbidden_site`);
- the row's `DriveId` must match;
- only the bot's app may call (T15).

**Status: Accepted by design until Phase 2.** Phase 2 then:

- uploads only by drive and folder item id, through one `storageBinding` module;
- attests each target before writing;
- runs a nightly isolation audit that can block a target.

Parsing untrusted files inside this identity is its own risk: a parser bug is a write to every
client. Splitting it out is in the plan.

The membership check adds one read permission to the same identity: `Directory.Read.All`, the
least privileged application permission Microsoft Learn lists for reading another user's
`memberOf`. It lets the identity read the whole directory (users, groups, their members), not
only memberships. Code that controls the identity could therefore enumerate the tenant's users
and groups, and read their profiles; it could not change anything with it. Ingestion reads only
`id`, `description` and `resourceProvisioningOptions` of the uploader's own groups, and the
uploader's own `userType` and `userPrincipalName` (the client-account rule, T22), and logs none
of them: the root logger redacts a UPN, which for a client account carries its NIP. Granted by
`infrastructure/identity/grant-ingestion-membership-read.sh` and nothing else. Narrower options
were weighed: `/users/{id}/joinedTeams` needs only `Team.ReadBasic.All`, but
reads Teams, which can lag a membership added through the group by up to 24 hours, the window the
check exists to close (T10).

### T4. A malicious file name or path

`sanitizeFolderPath` and `sanitizeFilename` strip separators, refuse `..` and reserved names, and
remove SharePoint's forbidden characters. Phase 0 also encodes each path segment with
`encodeURIComponent` before it goes into a Graph URL. That fixes names with `#` or `%`, and the
space in "Dokumenty księgowe". **Status: Mitigated; P0 (encoding).**

### T5. An oversized payload

At most 25 documents and 100 MiB decoded per batch, checked in validation, plus the platform's
request-size cap. **Status: Mitigated.**

### T6. A malware upload

SharePoint scans every upload and refuses infected files with HTTP 423. The card now shows a
generic Polish error, never the raw error text. **Status: Mitigated.**

### T7. Anonymous Personal Tab IDOR

**Before:** the "Moje dokumenty" tab loaded `/api/mydocs?userObjectId=…` anonymously. The bot
then asked ingestion's `/api/user-target` which client that id belonged to, and the page showed
the client's name and SharePoint URL. So anyone on the internet who knew or guessed a user id
could learn which BCR client that person belongs to, and where their files are.
**Now:** the tab is gone from manifest 0.2.0, `/api/mydocs` is a static page with no data, and
`/api/user-target` is deleted. **Status: Removed in P0.**

### T8. Content-based cross-client write

**Before:** an upload the Directory could not route was "promoted" to whichever client's NIP
appeared anywhere in the document, in any role. A supplier's invoice naming client A was filed
in A's space, whoever sent it. A crafted PDF, or a prompt injection that made the model report a
chosen NIP, could plant a file in any client's space. This was root cause R3 of the incident.
**Now:** promotion is deleted. The client comes only from the uploader's identity. Content can
only flip an invoice's direction inside that client. A source-scan test fails if a
promote-by-NIP path comes back. Until that build is live, promotion is switched off on the
running build with `ANTHROPIC_ENABLED=false` (human steps H-3), and no further client site is
granted to the ingestion identity. Documents already promoted sit in the taxonomy folders at
the receiving client's library root; those folders are locked to the site's Owners (tenant step
T-4b) until IR-2 moves each item. **Status: Removed in P0.** It is a permanent invariant (I2) and
a `CLAUDE.md` rule.

### T9. Fallback commingling

**Before:** every upload that could not be routed, from every client, went into one folder tree
at the root of the BCR GROUP team library. Every member of that team could read it, and while
the team was Public, so could any internal account.
**Now:** a staff-only quarantine site replaces the fallback. It has no group, unique
permissions and sharing disabled. Until the Phase-0 build is live, the running build's
`FALLBACK_SITE_*` settings point at that site (human steps H-6b). The documents already in BCR
GROUP are locked to its Owners (tenant step T-4) and are being moved one by one, with two people
signing off (IR-2).
**Status: Replaced by quarantine in P0.**

### T10. Directory tampering

Routing lives in an editable SharePoint list. Anyone who can edit a row can send a client's
uploads elsewhere: by adding an id to the row, or by pointing it at another site. The list also
holds every client's NIP. **Before:** every member of BCR GROUP could edit it, there was no
version history, and the duplicate check failed open once three rows shared a key.

**Phase 0:**

- unique permissions and versioning on the list (T-5);
- a two-pass, order-independent snapshot;
- forbidden targets and the `DriveId` check;
- a stale cap, after which nothing routes;
- routing fields written by `tools/directory-bindings.mjs` from Graph, with a before/after log,
  not typed by hand;
- the client-account rule (next build, T22): an id added to a client row by hand routes nothing
  unless it is that row's `{NIP}@bcr-group.pl` Member account with the row's Team as its only
  Team. A staff id is quarantined as `not_client_account`, a guest is refused. Editing the row's
  `NIP` alone unroutes its account (`not_client_account`); it routes nobody else.

**A binding going stale (R46): closed at runtime in P0.** The tool checks the Team memberships
of the account it binds when it binds it. When clients were taken to be guests, a guest bound to
client A and later added to client B's Team, for example because B's onboarding invited the same
email, used to keep routing everything into A's space, B's documents included, until the tool
ran again and the whole plan was applied. The tool now binds only a row's `{NIP}@` client
account (T22), which belongs to one company, so a second Team is always an anomaly. Ingestion
reads the uploader's Teams from Entra at upload time (`GET /users/{id}/memberOf`, the tool's
Team rule) and routes only while they are exactly the row's `TeamId`:

- a client account also in another Team, or no longer in the row's Team, is quarantined as
  `membership_mismatch` (`membership.mismatch`, ids and counts only);
- if the Teams cannot be read (no grant, the grant not yet in the token, the user gone, Graph
  down after retries), the upload is quarantined as `membership_unverified` — fail closed;
- a successful read is cached for 5 minutes per user, so a Team joined since shows up by the
  upload after that; a failure is never cached.

`MEMBERSHIP_CHECK_MODE=off` removes the check on the bot path (search does not run at all while
it is off). It is an emergency escape only, reopens R46, and is visible: `membership.check_off`
at every cold start and `build.membershipCheck: "off"` in `/api/health`. It never switches off
the client-account rule, which has no mode, and the channel inbox checks the Teams whatever it
says. The whole plan is still applied after every onboarding, and `check` still runs at least
weekly, as defence in depth
([admin guide](client-directory-admin-guide.md#keeping-the-bindings-current)). One gap remains in
both layers: Microsoft notes that "certain unused old teams" have no `resourceProvisioningOptions`;
such a Team without the onboarding marker is not counted.

**Status: P0** for stale bindings (the runtime check). **Phase 2** replaces the list with a
registry whose bindings cannot change without two approvals.

### T11. Key Vault readable at resource-group scope

Both managed identities hold *Key Vault Secrets User* at resource-group scope (`main.bicep`). So
each can read every secret: the ingestion identity can read the bot's secret, and the bot can
read the Anthropic key. **Status: Phase 1**, after the Bicep drift fix (gate G1, which only
records what runs): assignments per secret, and an audit check that no Key Vault assignment
exists at resource-group scope. Recorded as [follow-up F2](#follow-ups-from-the-g1-review).

### T12. Public data planes

Key Vault, the storage account, Application Insights (ingestion and query) and the Bot Service
all have public network access enabled. The Function Apps are public by necessity, because Bot
Service must reach `/api/messages`. **Status: Phase 1–2**, with the move to Flex Consumption,
VNet integration and private endpoints.

### T13. Personal data in logs

**Before:** every upload logged its file name, the client's title, the site path, the SharePoint
URL and the uploader's id. The duplicate warning logged the duplicated NIP or user id itself.
App Insights keeps 90 days on this component and is readable by anyone with read on the resource. That made it a
register of which client sent what.
**Now:** ids only:

- a server-minted `documentId` per document, and the ids of the row it routed to
  (`clientId`, `listItemId`, `teamId`);
- events `document.filed`, `document.quarantined`, `directory.conflict`,
  `ingestion.caller.rejected`, `sharepoint.forbidden_site` and `sharepoint.possible_duplicate`,
  and with the client-account rule (next build) `identity.refused`, `identity.unverified`,
  `client_account.mismatch` and `batch.refused`, with ids and reason codes only, never a UPN;
- for the channel inbox (T18), `inbox.filed`, `inbox.sorted_to_review`, `inbox.would_move`,
  `inbox.retry_later`, `inbox.failed`, `inbox.skipped`, `inbox.row_failed` and one `inbox.tick`
  of counts per tick, with the row's ids and the `driveItemId`, never a file name, title or NIP;
- on the filing lines (`document.filed`, `inbox.filed`, `inbox.sorted_to_review`,
  `inbox.would_move`) the classification's codes: category, suggested category, confidence,
  classifier, model, month, review reasons and the **taxonomy** folder (e.g.
  `01_Faktury/02_Faktury_zakupu/2026/09`), never the client's channel folder;
- one redaction list covering file names, titles, URLs, paths, parties and NIPs, and a user's
  UPN (`userPrincipalName`, `upn`), because a client account's UPN is its NIP.

**Status: P0**, deployed only after IR-0 copied the old lines into the evidence store. Old lines
age out within 90 days of the deploy.

### T14. No Entra ID P1

Without P1, the Entra sign-in log keeps only about 7 days and cannot be read through Graph
**[verify]**. There is no Conditional Access, and no way to stop ordinary users creating teams,
which is how a Public client-named team came to exist. The Purview unified audit log is the
longer record, kept about 180 days on Audit Standard: file operations, and interactive sign-ins
(`UserLoggedIn`, `UserLoginFailed`) **[verify]**. IR-0 exports both, and the 7 days of Entra
sign-ins, so whether an account was actually used is answered from those exports for the period
they cover. Before that period it cannot be known. **Status: Accepted**, pending Roman's
decision 5 in the plan. P1 is recommended, at about $6 per user per month.

### T15. The bot's client secret

The bot authenticates with a long-lived client secret. It is in Key Vault, and in plain text in
developers' `.env` files. Whoever holds it can get a token as the bot.

- **Before Phase 0,** that token plus any user id in the request body could file a document
  into any client's space.
- **After Phase 0,** ingestion accepts only the bot's app id. But a holder of the secret *is* the
  bot. They can still call ingestion with any client account's id and have the upload filed as
  that account, into its own client's space, and they can message users as "Asystent BCR". (Before
  the client-account build is deployed, the same holds for the guests still bound on rows 2 and
  10.)
- **The bot's own endpoint accepts only Bot Framework channel tokens** (`bot/channelAuth.ts`),
  from the Client search release's bot build (its step 5). The Phase 0 bot still running before
  that build takes the SDK default, which allows no more than the bullet above: uploading as a
  bound user.
  The SDK's default also accepted an "emulator" token: any AAD token for the bot's app id, which
  the secret alone can mint, with no audience check, and the bot then replied to whatever
  `serviceUrl` the activity named. Since the gate reads only body fields, such an activity could
  name any client's `aadObjectId` and act as them: upload as them, and, once search is on, read
  their client's search results. `validateClaims` now refuses every token whose issuer is not
  `https://api.botframework.com`, on every path (channel, emulator, skill, ASE), and the SDK binds
  a channel token to the activity's `serviceUrl`. So an activity that reaches the bot comes from
  the Bot Framework channel, with the sender Teams set.
- **Client search does not widen it.** `/api/search` accepts only the bot Function App's managed
  identity, with its own role (T21); the bot's app registration holds neither, and the secret
  cannot pose as a client in the chat, so the secret still cannot read a document.

**Status: Accepted** until Roman provides new credentials; rotation is deferred. **Phase 3**
fixes it for good:

- a federated credential with no secret;
- a queue transport, so that no user id crosses the network (invariant I6).

### T16. Transfer of document content to Anthropic

Document content is sent to Anthropic's API for classification. BCR processes client documents
as a processor, so Anthropic is a sub-processor. That needs the clients' authorisation, and a
transfer impact assessment for a US recipient. There is no EU data residency: `inference_geo` is
`us` or `global`. Default API retention is 30 days, and zero data retention (ZDR) is not in
place. **Status: open decision** for Roman and the lawyer (plan decision 3: pin `us` and request
ZDR). `ANTHROPIC_ENABLED=false` keeps all content inside Azure, at the cost of every document
going to manual review.

### T17. Deployment drift

A push to `main` ran the Bicep template and replaced every app setting. The template had drifted
from what was running: the routing settings were set by hand and missing from it, so one merge
would have taken ingestion down.
**Now:** there is no push trigger (`f5a2bd4`, gate G0). Phase-0 deploys are code-only, and
settings are added with a merge. The template and `main.dev.parameters.json` record every
setting dev runs with (gate G1). CI fails when the code reads a setting Bicep does not set, or
Bicep sets one no code reads (`tools/check-app-settings.mjs`); `--live` compares the template
with the running apps, which what-if cannot (it masks app settings), and `deploy.sh` and the
Deploy workflow run it before any Bicep deploy to existing apps, stopping on any difference
not named in `EXPECTED_SETTING_CHANGES`, and on any `az` failure. **Status: Mitigated (G0, G1
in review).** Bicep deploys to dev stay refused until
[Lifting gate G1](operations/human-steps.md#lifting-gate-g1) is done: the
`WEBSITE_RUN_FROM_PACKAGE` carry-over is rehearsed on a throwaway resource group first, and the
refusal goes in a reviewed commit of its own. Environment approval is still open; that commit
adds it.

### T18. Channel-inbox intake

A client posts files in their Team's "Dokumenty księgowe" channel as well as in the bot's 1:1
chat. So each client's channel folder is also an inbox: a timer lists it and moves each client
upload into its taxonomy folder inside the same channel folder
([`ARCHITECTURE.md` §4.4](../ARCHITECTURE.md#44-channel-inbox-intake-clients)). (The inbox was
built when clients were taken to be guests, whom Teams lets attach files only to channel posts;
since 28 September the client is its `{NIP}@` Member account, T22.) It does this with the
identity that can write every client site (T3), so what decides where a file goes is the whole
defence:

- **The client is where the file is.** The sweep lists one bound row's channel folder at a time
  (a routed row: bound, not excluded; T10) and moves a file only within that folder. Nothing in
  the file, its name or the model's output can name another row. Content chooses only the
  taxonomy folder, built with `buildFolderPath` from the category enum; the model's own path is
  never used (T8).
- **Only the row's client account's files are processed.** A file is processed only if its
  creator is the row's client account (the id the Directory routes to this row, `userType`
  `Member`, UPN exactly `{row NIP}@bcr-group.pl`, Teams exactly the row's `TeamId`) **and** its
  last modifier is that same id. Staff are Members too, so `userType` no longer tells staff from
  clients; the UPN does, and at most one account in the tenant can hold a row's `{NIP}@` UPN.
  Everything else is left exactly where it is, with a reason in `inbox.skipped`: `guest` (any
  guest, this Team's included: guests have no capability), `not_member`, `unknown_user`,
  `not_bound` (a Member the Directory does not route to this row: staff, another client's
  account), `not_client_account` (bound on this row, but not its `{NIP}@` account, or the row has
  no valid NIP), `not_in_team`, `other_teams`, `modified_by_other`, and `unverified` for a read
  that failed. So a document a staff member drops into a client's channel by mistake is not
  filed, not classified and not sent to Anthropic; it stays where they put it, for them to
  remove. (The client can already see it there: that exposure is the mistake, not the sweep's.)
  A copy a staff member makes into the channel is created by them, and is left alone the same
  way. So is a client's file that anyone else **replaced** with other content ("Replace" on an
  upload of the same name): `createdBy` stays the client, but `lastModifiedBy` is someone else,
  and the file is skipped as `modified_by_other`, with no read of the modifier. A row with no
  valid NIP, or no bound client account, files nothing.
- **A staff decision about a file is never undone.** The sweep lists a channel once and then
  works for minutes, and a file's id survives a move within its library. Before it reads a file
  and again before it moves it, the file must still be at the top of the channel folder at the
  `eTag` it was listed with, and the move carries `If-Match` with that `eTag` (Graph answers 412
  when it no longer matches). So a file staff moved out of the channel meanwhile (for example a
  document of client B posted in A's channel, moved to an Owners-only folder), one filed by hand
  into a subfolder, a renamed one, or one whose content was replaced is left where it now is. It
  is never pulled back into A's channel, never renamed back, and never filed by the old
  content's classification.
- **A client account in two Teams waits.** The inbox requires the creator's Teams to be exactly
  the row's, as the bot path does (`other_teams`), and in the inbox this check has no mode. A
  `{NIP}@` account belongs to one company, so a second Team is always an anomaly: the file stays
  untouched until the membership is fixed, and the binding tool's `check` exits 3 for it. (Under
  the guest rule, a guest also in B's Team was filed within A, because a reused guest email
  was an ordinary event; that no longer applies.)
- **Anyone else who reaches A's channel folder**, for example a guest or another client's
  account through a sharing link with edit rights, is not A's client account, and their file is
  left alone.
- **A file can never leave its drive.** Only the channel folder's direct children are candidates,
  and a listed child whose parent or drive is not that folder is dropped. The target folder chain
  is created under the channel folder, never at the drive root. The move is a `PATCH` by id with
  `If-Match`, `conflictBehavior=fail` and the `_n` rule (T2), which Graph does not perform
  across drives; afterwards the item must be the same item, in the row's drive, under the target
  folder, or it is refused and logged (`sharepoint.drive_mismatch`). Nothing is copied or
  deleted.
- **No overwrite on a move rests on observed behaviour.** Microsoft documents
  `conflictBehavior` for actions that create an item, and `if-match` for a move, but not
  `conflictBehavior` for a move. That a move onto a taken name fails with 409 (and takes `_1`)
  rather than replacing the file there is Graph's observed default in this tenant, proved by
  the H-12 canary's same-name move in the dedicated canary Team before any real client's channel
  is written, and to be proved again the same way after any change to the move.
- **BCR GROUP and the quarantine are never swept.** The sweep uses the client SharePoint factory,
  so a row whose site resolves to either is refused before anything is listed
  (`sharepoint.forbidden_site`, T3); a channel folder in another drive than the row's `DriveId`
  is refused too.
- **Fail closed.** An uploader who cannot be read is left for the next tick; an unavailable
  Directory sweeps nothing; `shadow` writes nothing; `off`, the default, does nothing.
- **A rollout starts in a channel with no client data.** `INBOX_SWEEP_MODE` is one switch for
  every row, so `INBOX_SWEEP_ROWS` limits the first `shadow` and `enforce` to a dedicated,
  synthetic canary Team's row; a real client's row is added only after the canary's moves,
  its same-name `_1` included, have been seen, and after that client's own `shadow` lines have
  been reviewed. BCR's canary accounts (the canary guest, and the canary client account created
  on 29 September) never join a real client's Team.

**Residual risk.** Anyone in the Team, the client account and any guest onboarding invited, can
already rename, move or delete files in the channel; the sweep adds no capability to anyone. The
sweep reads the metadata of every file at the top of each client's channel folder, staff files
included, but reads the content only of files it processes. That `createdBy.user.id` and
`lastModifiedBy.user.id` are the uploader's Entra object id for a file attached to a channel
post was verified for a guest by the H-12 shadow canary, not by documentation; for a Member it
is to be verified by the canary client account's first post after the client-account build is
deployed. If they were not, the sweep would leave the file untouched (`skippedNotClient`), not
misfile it. Between the re-check and the move there remains a window of one request in
which a person's move could race the sweep's; `If-Match` closes it on Graph's side. Moving a
file may leave the channel post that carried it pointing at its old place; the owner decides,
before each client's channel is swept, whether older attachments move (`INBOX_CREATED_AFTER`
keeps them in place) and what the client is told.

**Status: Mitigated by design; off until H-12's channel-inbox step** sets
`INBOX_SWEEP_MODE=shadow`, then `enforce`, first for the canary Team's row only. (Update,
29 September 2026: `enforce` runs for the canary row since 28 September 11:10Z and for PESKOVOI,
row 2, since 11:58Z, new uploads only. The running build applies the guest rule this entry
replaced; the client-account rule above is **Client identity**.)

### T19. The document index database

The index (`packages/ledger-db`, `infrastructure/db.bicep`) holds one row per document filed into
a client's space: ids, the category and review reasons, the month, and for invoices the number,
dates, currency, amounts, seller and buyer NIPs and names, and the KSeF number. That is client
data, some of it personal (a sole trader's name is a person's name), so it gets the same
isolation as the documents themselves. Quarantined documents are never in it.

**A client reading or writing another client's rows.** The boundary is the database, not the
application code:

- every table in schema `ledger` has `ENABLE` + `FORCE ROW LEVEL SECURITY` and one permissive
  policy, `client_id = ledger.current_client_id()` for `USING` and `WITH CHECK`. The function
  is `NULL` unless the transaction set its scope, so a statement without one reads 0 rows and
  cannot insert; `FORCE` holds the tables' owner to the same rule;
- the scope is set in exactly one place, `LedgerDb.withClientTx` (`SET LOCAL ROLE ledger_app`,
  then the transaction-local setting): a source scan over every package and `tools/` fails the
  build if anything else names it. Both are transaction-local, so a pooled connection goes back
  to the pool holding no role and no scope (tested);
- the ingestion derives the scope from the bound Directory row it filed the document for (a
  UUIDv5 of the list id and the row id), never from the document; the channel inbox, from the
  row whose channel folder holds the file. Content never picks the scope, as it never picks the
  client;
- the app's role `ledger_app` owns nothing, cannot create anything, has no `BYPASSRLS`, and has
  only `SELECT`, `INSERT`, `UPDATE` (no `DELETE`) on its tables (`clients`, `documents`, and
  `search_queries` for client search, T21). The app's login (the
  ingestion managed identity) is granted it `WITH INHERIT FALSE, SET TRUE`: outside a client
  transaction it can read nothing at all;
- `client_id` is immutable (a trigger, even for a superuser); a document row is unique per
  client and drive item;
- every statement is an `sql`-tagged template whose values are bind parameters, and a client
  transaction runs nothing else (checked at run time, not only by the compiler);
- `packages/ledger-db/sql/verify.sql` reports any table without forced RLS, with another policy
  or without the `client_id` guard trigger, a privileged or owning app role or one that can
  delete, and any login that could use the app role while privileged or inheriting it. It runs after every migration, in CI (`test:db`, with the RLS
  matrix for every table read from the catalog), and daily by hand.

**Credentials.** None stored. Password authentication is disabled on the server: the only
logins are Microsoft Entra principals. The ingestion connects as its managed identity with an
access token fetched per connection (TLS verified); the operator, as the server's Entra
administrator, with a token from `az login`. A token for the database is only obtainable by
those principals. The administrator is a person (Yahor), passed at deploy time; see the
dual-role risk under [Accepted risks](#accepted-risks).

**The public endpoint: the one network trade-off.** The Function Apps are on a Y1 Consumption
plan, which has no VNet integration and no fixed outbound IP. So the server keeps public network
access, with one firewall rule, `AllowAllAzureServicesAndResourcesWithinAzureIps`
(`0.0.0.0`–`0.0.0.0`), which admits **every Azure address, other tenants' included**. Nothing
there can log in: Entra-only authentication (no password to guess or leak), a token issued by
BCR's tenant for a principal created on this server, TLS 1.2 or later required, and RLS inside.
What is left: exposure to a flaw in the server or Azure's gateway before authentication, and
connection slots (about 50 on B1ms) that a flood from Azure could exhaust — the index then
fails, and filing goes on (`index.write_failed`, `unavailable`). The operator's own access is a
firewall rule for one IP, named with the date, added for a session and deleted after it. The
fix is a private endpoint once the apps move to Flex Consumption with VNet integration (T12,
Phase 1–2).

**Availability.** An index failure never blocks or undoes a filing: it is logged with ids, a
reason code and the SQLSTATE only (a PostgreSQL message quotes the values it refused), and the
missing rows can be backfilled. After a connection failure, writes are skipped for a minute. A
connection that dies while a write holds it (a server restart or maintenance, a network reset,
a terminated backend) fails that one write and nothing else: node-postgres reports it as an
`error` event on the connection, which `withClientTx` listens for as long as it holds it
(`index.connection_error`, name and SQLSTATE); unheard, that event would end the worker and
every upload on it. `itest/connection.itest.ts` terminates a backend mid-statement and while
idle in a transaction.

**Status: Mitigated by design; off until the
[Document index release](operations/human-steps.md#document-index-release)** sets
`LEDGER_INDEX_MODE=write`. The public endpoint is an [accepted risk](#accepted-risks).

### T20. Review notices in a staff channel

The notifier posts which documents wait for review into the shared channel `Weryfikacja
dokumentów` in BCR GROUP (Roman, later the accountants), through a Workflows webhook. The
channel's membership decides who sees a notice, and it is managed by hand in Teams: no client
account and no guest may ever be added to it, and it is never shared outside BCR. The
`{NIP}@bcr-group.pl` client accounts are internal Members (T22), so Teams offers them in the
channel's member picker next to staff: check every name before adding it. A notice's
text carries the Directory row's title, the suggested category's Polish label, the review reasons
in Polish and the month; never an amount, a NIP or model output. Its link, "Otwórz plik",
targets the file's SharePoint `webUrl`, which contains the site, the channel folder and the file
name: whatever the file name says (a counterparty, an invoice or KSeF number) is visible on hover
to the chat's members, and to the flow's owners in its run history (about 28 days). The link
opens only for someone with access to that client's Team. Rows are read and
marked in each client's own RLS scope, one client per transaction; the card is built from the
bound Directory rows, never from a document.

### T21. Client search

A client's `{NIP}@bcr-group.pl` account can search its own client's documents from the bot's 1:1
chat ([`ARCHITECTURE.md` §4.6](../ARCHITECTURE.md#46-client-search)). (Until 28 September this
entry said a client's guest; guests have no capability now, T22.) Search reads the document index
(T19): invoice numbers, amounts, counterparties. So the questions are which client's rows a
search can read, and who can make ingestion believe that a given client account is asking.

- **Who asks** is the Bot-Framework-authenticated `from.aadObjectId` that passed the bot's gate
  (T1), as for uploads. The bot accepts only Bot Framework channel tokens (T15), so that sender
  is the one Teams set, never one a caller with the bot's secret wrote.
- **Who may name that account to ingestion.** `POST /api/search`, like `/api/ingest/batch`,
  takes the asker's id from its body, so it is pinned to one caller: a token with the role
  `Documents.Search` whose app id is in `SEARCH_CALLER_APP_IDS`, the bot Function App's
  system-assigned managed identity. That identity's credential cannot be exported; only code
  running in the bot app gets its token. The role is assigned by
  `infrastructure/identity/grant-bot-search-caller.sh` and nothing else, which refuses any other
  principal. The bot's app registration holds neither the role nor a place in
  `SEARCH_CALLER_APP_IDS`, and ingestion keeps search off if that list shares an id with
  `BOT_CALLER_APP_IDS`. So **T15's rationale is unchanged**: the secret can file as a client
  account, but it cannot search, neither directly nor through the bot's chat (channel tokens
  only), and it still cannot read a document. The other way round, the managed identity's token
  is refused (403) on `/api/ingest/batch`. The token is checked before the body
  is read.
- **Which client.** Ingestion runs the same `ClientResolver` as for uploads: the asker's account
  read first (a Guest, a non-Member or a deleted user is refused), exactly one bound row, the
  asker is that row's client account (`userType` `Member`, UPN exactly
  `{row NIP}@bcr-group.pl`), and the asker's Teams, read at request time, exactly the row's
  `TeamId` (R46). So a staff id on a client row can never search, and neither can any guest.
  (This replaces the earlier rule, which required the asker to be a `Guest`.) Search does not run
  at all while `MEMBERSHIP_CHECK_MODE` is off. A refusal or any quarantine reason is one fixed
  no-access answer; an account or membership that could not be read is `unavailable`; neither
  reads the index or calls the model. `SEARCH_ROWS` narrows it further, for a rollout.
- **What can be read.** The scope is `clientIdForDirectoryRow` of the resolved row, computed
  before any read and again for every page: no cursor or card carries it, and the request body
  can name no client, row, scope or limit (every schema is strict; an unknown key is a 400). The
  read runs in `withClientTx(scope, …, { readOnly: true })` (`BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`), under forced RLS
  with an explicit `client_id = <scope>` on top, and selects only the client-view columns: never
  who uploaded, the hash, drive ids, the confidence, the model or its suggestion. A link is kept
  only if it is https on the row's own site.
- **The model** turns the question into a typed filter. It sees a static system prompt with no
  client data (the same bytes for every client) and the question wrapped in a random tag; never
  a row. Its answer is a closed schema, and a free string (a name, an invoice number, NIP digits)
  is kept only if it occurs in the question. No field can name a client, a column, SQL or a limit,
  so an injected instruction can at worst produce another filter over the asker's own rows. Its
  text is never shown: the card is fixed Polish sentences and the filter spelled with taxonomy
  labels. The question goes to Anthropic, as document content does (T16).
- **Abuse and cost.** Auth, strict validation and resolution run before anything is paid for.
  Durable limits in `ledger.search_queries`, counted under a per-client advisory lock across every
  worker: questions 10 per 5 minutes and 60 per 24 hours per user (the client account), typed and
  page requests 30 per 5 minutes per user, questions 300 per 24 hours per client. Per worker: 20
  messages a minute per user in the bot; at most 2 concurrent searches and 300 model calls an
  hour in ingestion.
  `SEARCH_MODE=off` on either app switches it off.
- **Records.** Logs carry ids, codes and counts, never the question. `ledger.search_queries` keeps
  the kind, the outcome, the SHA-256 of the filter and the names of its fields, the result count,
  the model, token counts and latency, in the client's own scope under forced RLS: never the
  question and never a filter value. The hash is not keyed: for a filter with little in it (a NIP
  alone) it can be reversed by trying every NIP, but only by someone who can already read that
  client's scope. The rows are kept 13 months and then deleted by the operator
  ([the runbook](operations/human-steps.md#client-search-release)); `ledger_app` cannot delete.

**Residual risk.** The trust boundary is the bot app. Anyone who can deploy code to it or change
its configuration can get the identity's token and search as any client account that currently
resolves, within the limits and recorded per search. That is the same person who could already
change what the bot sends, and it is narrower than the bot's secret, which works from anywhere. It
amends invariant I6 (no user id from a request body) with a second route, until search moves
into the bot or behind user sign-in (Phase 3). If the bot app is recreated its identity changes,
and search fails closed (403) until the grant and `SEARCH_CALLER_APP_IDS` follow. A link can go
stale after staff move a file: it then opens nothing, and never another client's site. The index
holds only documents filed since 28 September 2026.

**Status: Mitigated by design; off until the
[Client search release](operations/human-steps.md#client-search-release)** turns it on for the
canary row, then client by client. The I6 amendment is an [accepted risk](#accepted-risks).

### T22. Client accounts are tenant Members

The owner's decision of 28 September 2026 makes a client's identity its `{NIP}@bcr-group.pl`
account: an Entra **Member**, licensed (Business Basic), created by hand by BCR (Roman) and
handed to the client, a member (never an owner) of its own client Team and of no other. Guests
have no capability in the ledger. Onboarding still invites the client's contact person as a
guest, which gives them the client Team's files in Teams, as any Team member has, and nothing in
the ledger.

**The rule** (next build; `clientAccountVerdict` in `@bcr/shared`, and the same rule in
`tools/lib/bindings.mjs`, both tested against one case table). A row's client account is the one
id bound on it (`UserAadObjectIds`, written only by `tools/directory-bindings.mjs`) whose
`userType` is `Member`, whose `userPrincipalName` is exactly
`<the row's 10-digit NIP>@bcr-group.pl`, and whose Teams are exactly the row's `TeamId`. The row
is chosen by the id (bot, search) or by the file's location (channel inbox), never by a NIP or a
UPN: the rule only confirms it, so content still cannot pick a client (T8).

- **Guests** are refused on every path before anything is stored, classified, indexed or
  searched, and are never quarantined: the bot path answers `ClientAccountRequired` (a fixed
  Polish text naming the `NIP@bcr-group.pl` login), the channel inbox leaves the file where it is
  (`guest`), search answers no access. An account that cannot be read is `RetryLater`,
  `unverified` or `unavailable`, with nothing stored.
- **Staff are Members too**, so `userType` no longer tells staff from clients: the UPN does. A UPN
  is unique in the tenant, so at most one account can match a row. A staff id bound on a client
  row by mistake is quarantined as `not_client_account` before its Teams are read, its channel
  posts are left alone, and it cannot search.
- **The rule has no mode.** `MEMBERSHIP_CHECK_MODE=off` never skips it.

**What a Member can reach.** As internal accounts, the client accounts can, beyond their own
Team:

- read the directory and people search, and chat with any member. Other clients' `{NIP}@` UPNs
  reveal their NIPs, and display names reveal company names;
- see Viva Engage "All Company" and Communities;
- open any "People in your organization" link and anything granted to "Everyone except external
  users" (EEEU). An organisation-wide link on one client's file is readable by every other
  client;
- join a Public Team. There are none today: BCR GROUP (T-3) and Bricore (T-6) are Private. Keep
  a standing check on it;
- create Teams and groups (restricting that needs P1, T14);
- invite guests, unless T-8 restricts it;
- share from OneDrive within T-9's settings.

**What bounds it:**

- private client Teams, and one Team per client account, checked at every request by ingestion
  (`membership_mismatch`, `other_teams`) and at every binding by the binding tool
  (`client_account_in_other_team`);
- the ledger's row-level security (T19) and the client-account rule: a Member who is not the
  row's `{NIP}@` account files nothing and searches nothing;
- [tenant-hardening](operations/tenant-hardening.md) T-8 (external collaboration) and T-9 (the
  default sharing link type Direct; company-wide links turned off on client sites is
  recommended);
- no EEEU grant on any client or quarantine site;
- the staff channel of T20, to which no client account is ever added.

**Never by blocking sign-in.** Blocking a `{NIP}@` account locks the client out of Teams: T-1 did
exactly that from 26 September 12:18Z until Roman re-enabled the accounts on 28 September. T-1
and T-2 are withdrawn. Nothing in either repo may block, disable, unlicense or convert a `{NIP}@`
account. With the changes for this decision (not yet committed or deployed), no tool in either
repo writes to `/users/*` (the onboarding audit tool's `--apply` is removed), ingestion never
reads `accountEnabled` or a licence, and the binding tool reports a bound client account that is
disabled as a client locked out (`check` exits 5) and binds it all the same. `AuthoriseMe@`,
which T-7 blocked on 26 September 14:05Z and Roman re-enabled on 28 September, is not changed in
any way from now on. `BCROnboarding@`, the onboarding shared mailbox Roman reads, had been
disabled since before 22 September (not by this work); Roman enabled it with the others on
28 September, and it stays enabled. Neither is a client account.

**The first credential and its handover.** The client account's password is set by BCR and
handed to the client. On 28 September at 07:34Z the password of one client account (0002) was
reset while the account was still blocked, so the reset could not restore access, and the new
password was sent to the client over Telegram in plain text. Whoever can read that chat holds
the password until it is changed. That client should change it; **[verify]** that they have,
or that the account is set to change it at next sign-in. The fix: the password is generated by
the person who creates the account, never by the agent or a model and never in a case log or
chat, handed over out of band (by phone or in person, never over Telegram or plain email),
changed at first sign-in, with MFA registration as the tenant's security defaults require.

**Status: Client identity** (live since 29 September) for the rule; the credential handover is **open**. The Member exposure
is an [accepted risk](#accepted-risks).

### Also fixed in Phase 0

- **Model text on cards.** The classifier's free-text reasoning was rendered as Markdown on the
  result card. A document could steer it into a phishing message shown by "Asystent BCR". Cards
  now show fixed Polish labels, and every inserted value is escaped.
- **Quarantine cards leak nothing.** A quarantined document's card carries no link, folder or
  client name.
- **The single-document route is deleted.** `/api/ingest` was an unused second entry point.
- **Deploy packages are built, not kept.** The committed `artifacts/*.zip` were pre-Phase-0
  builds, and packaging updated an archive in place, so a new `dist` could ship next to an old
  `@bcr/shared`, or next to the compiled output of a deleted function. The zips are now
  git-ignored and built fresh for each deploy from a cleaned `dist`, with production
  dependencies at the `yarn.lock` versions and install scripts disabled; packaging fails on a
  compiled file with no source behind it.

### Follow-ups from the G1 review

Recorded, **not implemented**. G1 makes the template record what runs; each item below changes
what runs, so each is a change of its own, rehearsed on a throwaway resource group first as in
[Lifting gate G1](operations/human-steps.md#lifting-gate-g1) (G1-a), and never tried on dev
first.

- **F1. `AzureWebJobsStorage` without the account key.** `modules/functionApp.bicep` builds the
  connection string from `storage.listKeys().keys[0]`. So the storage account key sits in plain
  text in both apps' settings (see the secrets inventory), every template deploy writes key 1
  back, and rotating key 1 breaks both apps until the next deploy. The fix is identity-based
  host storage (`AzureWebJobsStorage__accountName`, with blob, queue and table data roles for
  each app's managed identity on the account); a Key Vault reference to a secret holding the
  connection string is the smaller first step. **[verify]** how the zip deploy works without
  the key: on Linux Consumption `config-zip` uploads the package with the storage connection
  string and points `WEBSITE_RUN_FROM_PACKAGE` at it with a SAS. `tools/check-app-settings.mjs`
  changes with it: `AzureWebJobsStorage__accountName` joins its `PLATFORM_SETTINGS`. The
  ingestion code reads the connection string too, since 27 September 2026: the channel inbox's
  shadow memo (`services/shadowMemo.ts`, table `inboxshadow`). With identity-based storage it
  moves to `new TableClient(<table endpoint>, 'inboxshadow', <managed identity credential>)`,
  and the ingestion identity needs *Storage Table Data Contributor* on the account.
- **F2. Key Vault access per secret (T11).** Replace the two resource-group-scope *Key Vault
  Secrets User* assignments in `main.bicep` with one per secret, scoped to it: the bot's
  identity on `bot-app-password`, the ingestion identity on `anthropic-api-key`. A secret must
  exist before an assignment on it can be created, so the secrets are seeded before the deploy
  that adds them. A Bicep deploy (incremental mode) never deletes the old assignments: once the
  new ones are verified (both apps resolve their references), delete those two with
  `az role assignment delete`, as a recorded step. Then the audit check T11 asks for: no Key
  Vault role assignment at resource-group scope.

## Accepted risks

| Risk | Why it is accepted | Owner | Until | What limits it meanwhile |
|---|---|---|---|---|
| **Secret rotation deferred** (T15, and the Anthropic key). Plaintext copies of both secrets are on developer laptops. | New credentials come from Roman, who will provide them soon. Rotating twice gains nothing. | Roman | New credentials arrive. Then rotate and delete the laptop copies the same day. | Caller pinning: only the bot's app id is accepted. A forged upload needs a real client account's id (a bound guest's, until the client-account build is deployed), lands only in that account's own client, and is logged under that id. The secret cannot read documents, because the bot holds no SharePoint permission; it cannot call `/api/search` (T21), and, from the Client search release's bot build, the bot's endpoint accepts only Bot Framework channel tokens, so it cannot pose as a client in the chat (T15). |
| **Yahor's dual role.** He is the developer, the operator who deploys, and a Global Administrator. One person can change the code, ship it and change tenant permissions. That is also a bus factor of one. | BCR has one technical person today. | Roman | A second admin or a formal approval path exists. | Roman reviews every binding plan before it is applied. IR-2 moves need two people. Every tenant and Azure change is a recorded command with its before and after state. The IR evidence is immutable and readable by Roman and the IOD. Yahor does not upload through the bot. Planned: Roman approves production deploys through GitHub environment protection, and a `HANDOVER.md`. |
| **One identity writes every client site** (T3). | Inherent to the current design. | Yahor | Phase 2 (upload by id, attestation, nightly audit). | Identity-only routing, only bound rows route, the uploader's Teams checked at upload time against the row's Team, one client per site, drive and Team, canonical site paths, forbidden targets checked by path and by resolved site id, `DriveId` check, `conflictBehavior=fail`. The channel inbox moves only within the channel folder it is sweeping, by id, and checks where each move ended (T18). |
| **The index database has a public endpoint** (T19): the Azure-services rule admits every Azure address, other tenants' too. | A Y1 Consumption app has no VNet integration and no fixed outbound IP; a VNet, NAT gateway and private endpoint cost more than the whole index. | Yahor | The move to Flex Consumption with VNet integration (T12, Phase 1–2): then a private endpoint, and public access off. | Entra-only authentication (no password exists), TLS 1.2+, the login's token issued by BCR's tenant for a principal created on the server, row-level security with the scope set in one place, `verify.sql` daily. An outage of the index never stops filing. |
| **A managed identity names the asking user to `/api/search`** (T21): invariant I6 amended, a second route that takes a user id from its body. | Only the bot knows who is asking; search inside the bot, or behind user sign-in (on-behalf-of), waits for Phase 3. | Yahor | Search moves into the bot or behind user sign-in (Phase 3). | One caller, a managed identity whose credential cannot leave the bot app, with a role of its own that the bot's secret lacks; every request resolved like an upload and limited to the row's `{NIP}@` client account (a `Guest` before 28 September); read-only, RLS-scoped reads of client-view columns; durable limits; every search recorded. |
| **No P1: 7-day Entra sign-in log, no Conditional Access** (T14). | Needs a licence purchase. | Roman | Decision 5. | Purview audit log: file operations and sign-in events, about 180 days. (Corrected 29 September 2026: this row also named "`{NIP}@` accounts blocked (T-1)". That block locked the clients out, was reversed on 28 September and is withdrawn; it limits nothing, see T22.) |
| **Client accounts are tenant Members** (T22). They can read the directory, Viva Engage "All Company" and organisation-wide links, and see other clients' `{NIP}@` UPNs, and so their NIPs. | The owner's decision of 28 September 2026: the `{NIP}@bcr-group.pl` Member account is the client's identity, and blocking its sign-in locks the client out (26–28 September). | Roman, 28 Sep 2026 | The next security review, or before the tenth client, whichever comes first. | Private client Teams and one Team per client account (checked by ingestion at every request and by the binding tool); the client-account rule and row-level security in the ledger; T-8 and T-9; no EEEU on client or quarantine sites. **Never** by blocking sign-in. |

## 4. Data residency and retention

- **Application Insights** keeps telemetry for 90 days on the running component (`retentionInDays`,
  checked 26 September; `appInsights.bicep` now pins 90, and the Log Analytics workspace's own
  30 days is a separate setting). From Phase 0 it
  holds ids and codes, not names, file names or URLs.
- **IR evidence store:** the pre-Phase-0 logs, the Purview export, the sign-in exports and the
  Directory export for the incident. It is immutable, readable by Roman, the IOD and
  `yahor.simak@bcr-group.pl` only, and kept until the date the IOD sets.
- **Quarantine site:** items are kept 90 days after triage. That is the plan's default, for Roman
  and the lawyer to confirm.
- **Client documents** live in each client's Team, in the "Dokumenty księgowe" channel folder.
  The client account and any guest in the Team have Edit rights there, so a Purview retention
  policy is planned to stop client documents being lost by deletion.
- **Anthropic:** see T16. Document content is never logged by the ledger.
- **Document index** (T19): PostgreSQL in West Europe; backups kept 7 days (point-in-time
  restore), geo-redundant to the paired region (North Europe), both in the EU. Rows stay as long
  as the documents they describe; deleting a client's rows at offboarding is part of the
  offboarding runbook (v2 plan, Operations), not yet built. The index holds no file content.
- **Search records** (`ledger.search_queries`, T21): one row per search, with no question and no
  filter value; kept **13 months**, then deleted monthly by the operator as the database's
  administrator, client scope by client scope
  ([Client search release](operations/human-steps.md#client-search-release), *Retention*).

## 5. Compliance checklist

- [x] HTTPS only (`httpsOnly: true` on both Function Apps)
- [x] TLS ≥ 1.2 (`minTlsVersion: '1.2'`)
- [x] FTP disabled (`ftpsState: 'Disabled'`)
- [ ] No stored credentials: **not yet**. The bot uses a client secret (T15), and the storage key
      is in an app setting (follow-up F1).
- [x] Key Vault soft-delete and purge protection
- [ ] Key Vault access per secret (T11, Phase 1; follow-up F2)
- [x] App role `Documents.Ingest` required on every batch call, `Documents.Search` on every
      search call
- [x] Caller app id pinned to the bot (P0); the search caller to the bot's managed identity (T21)
- [x] Uploads never overwrite (`conflictBehavior=fail`, P0)
- [x] Routing by uploader identity only; content never picks the client (P0)
- [x] Channel inbox: the file's location picks the client; moves by id inside the channel folder,
      only on the version listed (`If-Match`), never across drives, never overwriting (T18)
- [ ] Only the row's `{NIP}@` client account files, is swept and searches; guests are refused on
      every path with nothing stored; nothing blocks, disables, unlicenses or converts a client
      account (T22): **next build**, not yet deployed. The running build processes only files
      the row's Team's guests created and last changed.
- [x] Structured logging with secrets redacted, and from Phase 0 also file names, titles, URLs,
      paths, parties and NIPs (and invoice fields)
- [x] Document index: Entra-only authentication, TLS required, `FORCE ROW LEVEL SECURITY` on
      every table with the scope set in one place, an app role that owns nothing and cannot
      bypass RLS, `verify.sql` in CI and daily (T19)
- [x] Client search: the client from the verified asker only (`ClientResolver`; in the next build
      it requires the row's client account, where the running build required a `Guest`),
      read-only RLS-scoped reads of client-view columns, a model that sees no rows and whose text
      is never shown, durable limits, no question stored or logged (T21)
- [x] No secrets in source: `.env` and `local.settings.json` are git-ignored, and the `*.example`
      files are the templates. The laptop copies are an accepted risk.
