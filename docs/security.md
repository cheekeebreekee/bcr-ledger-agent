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
| **Phase N** | Planned in the v2 plan, phase N. Until then the threat is open. |
| **Accepted** | Recorded as an accepted risk, with an owner, in [Accepted risks](#accepted-risks). |

## 1. Identity model

| Trust boundary | Principal | Credential | Checked by |
|---|---|---|---|
| Teams client → bot | Bot Framework | JWT signed by `login.botframework.com` | `CloudAdapter`, then the bot's gate on **every** activity type: a 1:1 chat, from the BCR tenant, with a GUID user object id (P0) |
| Bot → ingestion | The bot's app registration | Client secret (Key Vault, and laptop copies: see T15) → token for `api://<ingestion-app-id>` | `AuthMiddleware`: issuer, audience, the `Documents.Ingest` role, and **the caller's app id** (`appid`, else `azp`) in `BOT_CALLER_APP_IDS` (P0). Then the request body: `conversationType` must be `personal`, the user id must be a UUID, and the tenant must be BCR's (P0). |
| Ingestion → Microsoft Graph | The ingestion Function App's system-assigned managed identity | Managed identity token | Graph. `Sites.Selected`, plus a per-site grant on every site it files into (see T3). |
| Bot, ingestion → Key Vault | Each app's managed identity | *Key Vault Secrets User*, assigned at **resource-group** scope | Key Vault (see T11) |
| Ingestion → Claude | Anthropic API key (Key Vault) | TLS and bearer key | `api.anthropic.com` (see T16) |

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
| Storage account key | **In plain text in the `AzureWebJobsStorage` app setting** of both apps (`functionApp.bicep` reads it with `listKeys()`) | The Functions runtime | `az functionapp config appsettings set` prints it unless you pass `-o none`. The fix is identity-based storage access. It is not yet in the plan; raise it with the Bicep drift fix. |
| Function keys | Azure platform | Not used | Functions are `authLevel: 'anonymous'`; each handler checks the JWT itself. |

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
  not typed by hand.

**Not covered in Phase 0: a binding goes stale.** The tool checks each guest's Team memberships
when it runs; ingestion never re-checks them. A guest bound to client A and later added to client
B's Team, for example because B's onboarding invited the same email, keeps routing everything
into A's space, B's documents included, until the tool runs again and the whole plan is applied.
A guest removed from A's Team keeps writing into A's folder until then. Meanwhile the whole plan
is applied after every onboarding, never only the new row, and `check` runs at least weekly
([admin guide](client-directory-admin-guide.md#keeping-the-bindings-current)).

**Status: Partly mitigated in P0; Phase 2** replaces the list with a registry whose bindings
cannot change without two approvals, and checks Team membership when a document arrives.

### T11. Key Vault readable at resource-group scope

Both managed identities hold *Key Vault Secrets User* at resource-group scope (`main.bicep`). So
each can read every secret: the ingestion identity can read the bot's secret, and the bot can
read the Anthropic key. **Status: Phase 1**, with the Bicep drift fix (gate G1): assignments per
secret and at vault scope, and an audit check that no Key Vault assignment exists at
resource-group scope.

### T12. Public data planes

Key Vault, the storage account, Application Insights (ingestion and query) and the Bot Service
all have public network access enabled. The Function Apps are public by necessity, because Bot
Service must reach `/api/messages`. **Status: Phase 1–2**, with the move to Flex Consumption,
VNet integration and private endpoints.

### T13. Personal data in logs

**Before:** every upload logged its file name, the client's title, the site path, the SharePoint
URL and the uploader's id. The duplicate warning logged the duplicated NIP or user id itself.
App Insights keeps 30 days and is readable by anyone with read on the resource. That made it a
register of which client sent what.
**Now:** ids only:

- a server-minted `documentId` per document, and the ids of the row it routed to
  (`clientId`, `listItemId`, `teamId`);
- events `document.filed`, `document.quarantined`, `directory.conflict`,
  `ingestion.caller.rejected`, `sharepoint.forbidden_site` and `sharepoint.possible_duplicate`;
- one redaction list covering file names, titles, URLs, paths, parties and NIPs.

**Status: P0**, deployed only after IR-0 copied the old lines into the evidence store. Old lines
age out within 30 days of the deploy.

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
  bot. They can still call ingestion with any guest's id and have the upload filed as that guest,
  and they can message users as "Asystent BCR".

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
settings are added with a merge. **Status: Mitigated (G0); Phase 1** adds the drift fix, a CI
check that every setting the code reads exists in Bicep, `what-if`, and environment approval.

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

## Accepted risks

| Risk | Why it is accepted | Owner | Until | What limits it meanwhile |
|---|---|---|---|---|
| **Secret rotation deferred** (T15, and the Anthropic key). Plaintext copies of both secrets are on developer laptops. | New credentials come from Roman, who will provide them soon. Rotating twice gains nothing. | Roman | New credentials arrive. Then rotate and delete the laptop copies the same day. | Caller pinning: only the bot's app id is accepted. A forged upload needs a real guest's id, lands only in that guest's own client, and is logged under that id. The secret cannot read documents, because the bot holds no SharePoint permission. |
| **Yahor's dual role.** He is the developer, the operator who deploys, and a Global Administrator. One person can change the code, ship it and change tenant permissions. That is also a bus factor of one. | BCR has one technical person today. | Roman | A second admin or a formal approval path exists. | Roman reviews every binding plan before it is applied. IR-2 moves need two people. Every tenant and Azure change is a recorded command with its before and after state. The IR evidence is immutable and readable by Roman and the IOD. Yahor does not upload through the bot. Planned: Roman approves production deploys through GitHub environment protection, and a `HANDOVER.md`. |
| **One identity writes every client site** (T3). | Inherent to the current design. | Yahor | Phase 2 (upload by id, attestation, nightly audit). | Identity-only routing, only bound rows route, one client per site, drive and Team, canonical site paths, forbidden targets checked by path and by resolved site id, `DriveId` check, `conflictBehavior=fail`. |
| **No P1: 7-day Entra sign-in log, no Conditional Access** (T14). | Needs a licence purchase. | Roman | Decision 5. | Purview audit log: file operations and sign-in events, about 180 days. `{NIP}@` accounts blocked (T-1). |

## 4. Data residency and retention

- **Application Insights** keeps telemetry for 30 days (`logAnalytics.bicep`). From Phase 0 it
  holds ids and codes, not names, file names or URLs.
- **IR evidence store:** the pre-Phase-0 logs, the Purview export, the sign-in exports and the
  Directory export for the incident. It is immutable, readable by Roman, the IOD and
  `yahor.simak@bcr-group.pl` only, and kept until the date the IOD sets.
- **Quarantine site:** items are kept 90 days after triage. That is the plan's default, for Roman
  and the lawyer to confirm.
- **Client documents** live in each client's Team, in the "Dokumenty księgowe" channel folder.
  Guests have Edit rights there, so a Purview retention policy is planned to stop client
  documents being lost by deletion.
- **Anthropic:** see T16. Document content is never logged by the ledger.

## 5. Compliance checklist

- [x] HTTPS only (`httpsOnly: true` on both Function Apps)
- [x] TLS ≥ 1.2 (`minTlsVersion: '1.2'`)
- [x] FTP disabled (`ftpsState: 'Disabled'`)
- [ ] No stored credentials: **not yet**. The bot uses a client secret (T15), and the storage key
      is in an app setting.
- [x] Key Vault soft-delete and purge protection
- [ ] Key Vault access per secret, at vault scope (T11, Phase 1)
- [x] App role `Documents.Ingest` required on every call
- [x] Caller app id pinned to the bot (P0)
- [x] Uploads never overwrite (`conflictBehavior=fail`, P0)
- [x] Routing by uploader identity only; content never picks the client (P0)
- [x] Structured logging with secrets redacted, and from Phase 0 also file names, titles, URLs,
      paths, parties and NIPs
- [x] No secrets in source: `.env` and `local.settings.json` are git-ignored, and the `*.example`
      files are the templates. The laptop copies are an accepted risk.
