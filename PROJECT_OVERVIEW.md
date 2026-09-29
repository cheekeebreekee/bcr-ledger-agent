# BCR Ledger Agent: project overview

> **One-line summary:** a Microsoft Teams bot for Polish accounting clients. It files document
> attachments (faktury, paragony, umowy, wyciągi, raporty, deklaracje) into each client's
> SharePoint folder structure. The folder comes from the document's **content, read by Claude**
> (Anthropic API). The client comes from **the uploader's identity only**, looked up in a Client
> Directory SharePoint list, and a client's identity is its `{NIP}@bcr-group.pl` account (owner's
> decision, 28 September 2026). Guests have no capability in the ledger.

> **Phase 0 of v2, September 2026.** Incident [`IR-2026-09`](docs/operations/incident-2026-09.md)
> found that documents were filed outside their client's space. Phase 0 removes the routing that
> allowed it, and replaces the shared fallback bucket with a staff-only quarantine. Parts of this
> page that describe the old behaviour are marked **as-is before v2 (Sep 2026)**.

---

## What it does

A client signs in to Teams with its `{NIP}@bcr-group.pl` account, an Entra Member that BCR
creates at onboarding and hands to the client. It sends a file in a 1:1 chat with the bot, or
posts it in its Team's "Dokumenty księgowe" channel, which a timer in ingestion sweeps (the
channel inbox, [`ARCHITECTURE.md` §4.4](ARCHITECTURE.md#44-channel-inbox-intake-clients); the bot
itself never sees channel files, lesson 16). Onboarding still invites the client's contact as a
guest, for access to the Team's files: a guest can neither file nor search. Until 28 September
2026 this page treated clients as Teams guests; that was wrong (lesson 25). The chat path:

```
Client account ({NIP}@) → 1:1 chat with "Asystent BCR" → attaches "Faktura_03_2026.pdf"
       ↓
       Bot gate: personal chat? BCR tenant? valid user id?   (otherwise: refused, nothing downloaded)
       ↓
       Bot downloads the attachment and calls ingestion (Bearer JWT, pinned to the bot's app id)
       ↓
       Ingestion:
         (0) Reads the uploader's account: a guest, a non-Member or an unreadable account
             is refused, and nothing is stored
         (1) Resolves the uploader's client from the Client Directory: exactly one bound
             client whose {NIP}@ account the uploader is, or quarantine with a reason
         (2) Calls Claude with the content, primed with that client's NIP and name
         (3) Claude returns category + confidence + parties[] (seller/buyer/NIP)
         (4) Inside the bound client only: flips sales ⇄ purchase from the parties
         (5) Uploads to the client's "Dokumenty księgowe" channel folder
             (conflictBehavior=fail), or to the quarantine site
       ↓
       Bot replies with one Polish card:
         uploaded     → Dokument · Kategoria · Folder, and an "Otwórz" link into the client's space
         quarantined  → "📨 Faktura_03_2026.pdf: Dokument przekazano do weryfikacji przez zespół BCR."
                        (no link)
         refused      → a fixed line: the assistant works only on the NIP@bcr-group.pl account
```

A document Claude cannot classify confidently goes to `98_Nieposortowane/RRRR/MM/` in the
client's own space. A Member's document that cannot be tied to exactly one client goes to the
quarantine site, where BCR staff decide; a guest's is refused and stored nowhere.

**Content never chooses the client.** Until Phase 0, a document nobody could route was moved to
whichever client's NIP it mentioned. That was the cross-client write in the incident, and it is
gone for good.

---

## Architecture

```
Microsoft Teams (1:1 chat only)
        │
        ▼  POST /api/messages (Bot Framework auth)
┌────────────────────────────┐     ┌────────────────────────────┐
│  func-bcr-bot-dev-…        │     │  Key Vault                 │
│  (Node 22 Functions v4)    │◀────│  kv-bcr-dev-…              │
│  @bcr/teams-bot            │     │  (bot-app-password ref)    │
│  ┝ gate on every activity  │     └────────────────────────────┘
│  ┝ /api/messages           │
│  ┕ /api/mydocs (static)    │
└──────────┬─────────────────┘
           │  POST /api/ingest/batch (Bearer JWT)
           │  client_credentials → audience api://b8b90018-…
           │  role Documents.Ingest + caller app id pinned (BOT_CALLER_APP_IDS)
           │  POST /api/search: the bot Function App's managed identity,
           │  role Documents.Search + app id pinned (SEARCH_CALLER_APP_IDS)
           ▼
┌────────────────────────────┐
│  func-bcr-ingest-dev-…     │      Identity-only routing:
│  (Node 22 Functions v4)    │      0. account: a guest or non-Member is refused, nothing stored
│  @bcr/document-ingestion   │      1. resolve(uploader) → its {NIP}@ row | quarantine(reason)
│  ┝ /api/health             │      2. classify() primed with the bound client
│  ┝ /api/ingest/batch       │      3. bound client only: flip invoice direction
│  ┝ /api/search             │      4. upload: client's channel folder, or quarantine
│  ┕ system-assigned MI      │      client search: the asker's own client, read only
│    d5226274-… / 7984e56c-… │
│    role: Sites.Selected    │
└──────────┬─────────────────┘
           │                        Claude (Anthropic Messages API)
           ├───▶  content + tool schema → category + parties[]
           │
           ▼
┌────────────────────────────────────────────────────────────────┐
│  Microsoft Graph → SharePoint Online                           │
│                                                                │
│  Client Directory (BCR GROUP site, list 2a5613f1-…)            │
│    ClientId · NIP · UserAadObjectIds (the {NIP}@ account) ·    │
│    SiteHostname/SitePath/DriveName/RootFolder · DriveId ·      │
│    TeamId · IsAdmin · Status                                   │
│                                                                │
│  Sites the ingestion identity writes to:                       │
│    ┝ /sites/0002PESKOVOISp.zo.o.-…   PESKOVOI (0002)           │
│    ┝ /sites/0000TESTSp.zo.o.-…       TEST                      │
│    ┝ /sites/BCRLedgerKwarantanna     quarantine (staff only)   │
│    ┕ each further bound client site                            │
│  BCR GROUP: read only (the Directory). Never a target.         │
│  Drive: "Dokumenty" on all (Polish locale)                     │
└────────────────────────────────────────────────────────────────┘
```

### Identities and permissions

| Principal | App ID | Object ID | Role / scope |
|---|---|---|---|
| Bot app reg | `3ee1ba6c-2501-4e2d-9971-ab156a9a6f9a` | (SP-side) | Holds the bot client secret; requests the `Documents.Ingest` app role on the ingestion API. The only app id in `BOT_CALLER_APP_IDS`. |
| Ingestion API app reg | `b8b90018-9af0-4d7a-ada2-71559952ebbe` | — | Audience identity (`api://b8b90018-…`); defines the `Documents.Ingest` app role, and `Documents.Search` (Applications only) from the client search release |
| Ingestion func **managed identity** | `d5226274-a2c0-4ae9-9c3b-34158c43f2fc` | `7984e56c-e264-427d-8e90-ff57dea6b0fa` | Calls Microsoft Graph with `Sites.Selected` and a per-site grant on each site it files into (see `docs/security.md` T3) |
| Bot func **managed identity** | printed by `grant-bot-search-caller.sh` | `az functionapp identity show` on the bot app | *Key Vault Secrets User* (resource group). From the client search release: `Documents.Search` on the ingestion API, the only app id in `SEARCH_CALLER_APP_IDS`; it calls `/api/search` and nothing else. Never in `BOT_CALLER_APP_IDS`. |

Two-step SharePoint grant (see lessons 1–5):

1. `Sites.Selected` app role on Microsoft Graph → MI (role id `883ea226-0bf2-4a8f-9f9d-92c9162a727d`)
2. `write` (or `read`) on each site → MI app id `d5226274-…`, via `POST /sites/{id}/permissions`

The Phase-0 membership check needs one more app role on the same MI: `Directory.Read.All`, to
read each bound uploader's `memberOf` (`docs/operations/human-steps.md` H-8b,
`infrastructure/identity/grant-ingestion-membership-read.sh`). Granted on 26 September 2026
(H-8b). The client-account rule reads every uploader's `userType` and `userPrincipalName` under
the same grant.

Client search adds one grant, to the **bot's** managed identity: the app role `Documents.Search`
on the ingestion API, which `infrastructure/identity/grant-bot-search-caller.sh` also creates on
the registration if it is missing ([Client search release](docs/operations/human-steps.md#client-search-release)
step 1). No Graph, SharePoint, Key Vault or database permission changes.

---

## Azure environment (dev, which is production)

| Resource | Name |
|---|---|
| Subscription | `db579864-260f-4e8b-bdb5-12e2b90a130d` ("Azure subscription 1") |
| Tenant | `379013e4-7d25-4668-b99f-3cfa2264dc71` (BCR Group EU) |
| Resource group | `rg-bcr-ledger-dev` |
| Region | `westeurope` |
| Plan | Linux Consumption (Y1), Node 22 |
| Bot Function App | `func-bcr-bot-dev-vyyintffz6ehq` |
| Ingestion Function App | `func-bcr-ingest-dev-vyyintffz6ehq` |
| Azure Bot resource | `bot-bcr-dev-vyyintffz6ehq` (Teams channel enabled) |
| Key Vault | `kv-bcr-dev-vyyintffz6ehq` (RBAC mode) |
| App Insights | `appi-bcr-dev-vyyintffz6ehq` |
| Alerts (deployed 29 Sep 2026) | Action group `ag-bcr-dev-vyyintffz6ehq` (email to `yahor.simak@bcr-group.pl`) and eight log alert rules `alert-bcr-<rule>-dev-vyyintffz6ehq` on App Insights, from `infrastructure/alerts.bicep`: USD 4.00 a month (`docs/operations/human-steps.md` → Alerts) |
| Storage | `stbcrdevvyyintffz6ehq` |
| SharePoint sites | `/sites/0002PESKOVOISp.zo.o.-Ksigowo` (PESKOVOI), `/sites/0000TESTSp.zo.o.-Ksigowo` (TEST), `/sites/BCRLedgerKwarantanna` (quarantine, created in Phase 0), `/sites/BCRGROUPSp.zo.o` (hosts the Client Directory list; never a target). All on `bcrgroupeu.sharepoint.com`. |
| SharePoint drive | **Dokumenty** (Polish locale, NOT "Documents"). Per client from the Directory's `DriveName`; the quarantine's from `QUARANTINE_DRIVE_NAME`. |
| Client Directory list | `2a5613f1-6193-4c04-8a3d-d606617fb411` on the BCR GROUP site |

Endpoints:

- Bot: `POST https://func-bcr-bot-dev-vyyintffz6ehq.azurewebsites.net/api/messages`
- Bot static page: `GET …/api/mydocs`. It shows no data; it only remains for old installs of the
  tab.
- Ingestion health: `GET https://func-bcr-ingest-dev-vyyintffz6ehq.azurewebsites.net/api/health`
- Ingestion (batch): `POST https://func-bcr-ingest-dev-vyyintffz6ehq.azurewebsites.net/api/ingest/batch`
  (Bearer JWT from the bot's app only)
- Ingestion (client search): `POST https://func-bcr-ingest-dev-vyyintffz6ehq.azurewebsites.net/api/search`
  (Bearer JWT from the bot Function App's managed identity only; answers `disabled` until the
  client search release)
- *Removed in Phase 0:* `POST /api/ingest` (single document) and `GET /api/user-target`, the
  Personal Tab's lookup and an IDOR.

---

## Configuration (app settings)

Both apps load their settings once at cold start, with a zod schema, and refuse to start if a
required one is missing. A setting's name is the env var; the schema is in
[`packages/shared/src/config.ts`](packages/shared/src/config.ts).

⚠️ A Bicep deploy replaces every app setting, so `main.bicep` with `main.<env>.parameters.json`
is the record of them all (lesson 20). A setting changed by hand with
`az functionapp config appsettings set … -o none` (which merges) must be recorded in the
parameters file in the same change; `node tools/check-app-settings.mjs --live` shows any
difference, and CI checks that Bicep sets every setting the code needs.

**Bot (`func-bcr-bot-…`)**

| Setting | Notes |
|---|---|
| `MICROSOFT_APP_ID`, `MICROSOFT_APP_TENANT_ID` | The bot's app registration and the BCR tenant |
| `MICROSOFT_APP_PASSWORD` | Key Vault reference, `bot-app-password` |
| `MICROSOFT_APP_TYPE` | **Required** since Phase 0. `SingleTenant` (lesson 12). |
| `BOT_GATE_MODE` | **New.** `log` or `enforce` (default). `log` only for the first 24 h of the Phase-0 rollout. |
| `INGESTION_BASE_URL`, `INGESTION_SCOPE` | Where ingestion is, and `api://<ingestion-app-id>/.default` |
| `SEARCH_MODE` | **New.** Client search: `off` (default; text gets the help card) or `on` (a user's text goes to ingestion's `/api/search` with the bot's managed identity; ingestion answers only a row's `{NIP}@` client account). Anything else stops the bot at cold start. `off` in the template and both parameter files until the [Client search release](docs/operations/human-steps.md#client-search-release). |
| `APPLICATIONINSIGHTS_CONNECTION_STRING`, `LOG_LEVEL` | |

**Ingestion (`func-bcr-ingest-…`)**

| Setting | Notes |
|---|---|
| `AZURE_TENANT_ID`, `INGESTION_APP_ID`, `EXPECTED_AUDIENCE`, `EXPECTED_ROLES` | Token validation. `EXPECTED_ROLES` defaults to `Documents.Ingest`. |
| `BOT_CALLER_APP_IDS` | **New, required.** Comma-separated app ids allowed to call; today the bot's only. Each must be a GUID. |
| `CLIENT_DIRECTORY_SITE_ID`, `CLIENT_DIRECTORY_LIST_ID` | Where the Client Directory is. The site id must be the three-part Graph id (`<host>,<guid>,<guid>`): it also names BCR GROUP for the resolved-site write guard. |
| `CLIENT_DIRECTORY_CACHE_TTL_MS` | Default 300000 (5 min) |
| `CLIENT_DIRECTORY_MAX_STALE_MS` | **New.** Default 900000 (15 min). An older snapshot routes nothing. |
| `QUARANTINE_SITE_HOSTNAME`, `QUARANTINE_SITE_PATH` | **New, required.** The staff-only quarantine site. The host must be `<tenant>.sharepoint.com`, and it is also the only host a Directory row may name. The path must be exactly `/sites/<name>` or `/teams/<name>`. |
| `QUARANTINE_DRIVE_NAME` | **New.** Default `Documents`; on this tenant, `Dokumenty` |
| `QUARANTINE_ROOT_FOLDER` | **New.** Default `Kwarantanna` |
| `FORBIDDEN_TARGET_SITE_PATHS` | **New, required.** Sites no row may route to: at least `/sites/BCRGROUPSp.zo.o`. Each entry exactly `/sites/<name>` or `/teams/<name>`. The quarantine path is added automatically. |
| `ANTHROPIC_ENABLED`, `ANTHROPIC_API_KEY` (Key Vault), `ANTHROPIC_MODEL`, `ANTHROPIC_MAX_CONTENT_BYTES` | Classification. The model defaults to `claude-opus-5`, in the code and in `main.bicep` and both parameter files; the running app was set to `claude-opus-4-5-20251101` and is switched at the classification release. |
| `ANTHROPIC_EFFORT`, `ANTHROPIC_THINKING` | **New.** `low` and `adaptive` by default, recorded in `main.bicep` and both parameter files; a value the code does not know, or `disabled` thinking on a model that rejects it, stops ingestion at cold start. |
| `CLASSIFICATION_ACCEPT_THRESHOLD` | **New.** The one acceptance threshold: default `0.70`, and anything outside 0.70–0.95 stops ingestion at cold start. Bicep sets it from `classificationAcceptThreshold` (`0.70`). It replaces `ANTHROPIC_CONFIDENCE_THRESHOLD`, which is no longer read (a set value only logs `config.retired_setting`; the classification release deletes it, and the template no longer sets it). |
| `LEDGER_INDEX_MODE` | **New.** The document index: `off` (default; no connection) or `write` (every filed document gets a client-scoped row). Anything else stops ingestion at cold start, and so does `write` without `LEDGER_DB_HOST` or `LEDGER_DB_USER`. The template and both parameter files record `off` until the [Document index release](docs/operations/human-steps.md#document-index-release). |
| `LEDGER_DB_HOST`, `LEDGER_DB_NAME`, `LEDGER_DB_USER` | **New.** The index server (`<server>.postgres.database.azure.com`), the database (default `ledger`) and the managed identity's PostgreSQL login, named after the Function App. No password: an Entra token per connection. |
| `SEARCH_MODE` | **New.** Client search: `off` (default; every search answers `disabled`) or `on`. Anything else stops ingestion at cold start. In `on`, search that cannot run safely (index or Claude off, no caller, a caller also in `BOT_CALLER_APP_IDS`, `MEMBERSHIP_CHECK_MODE` off) stays off with a `search.config` reason; it never stops ingestion. `/api/health` shows it as `build.search`. |
| `SEARCH_ROWS` | **New.** Empty (default): every bound row. Otherwise Client Directory list item ids (not `ClientId`), comma-separated, like `INBOX_SWEEP_ROWS`: the canary row first, then client by client. A malformed entry keeps search off (`bad_rows`) and never stops ingestion. |
| `SEARCH_CALLER_APP_IDS` | **New.** The app id of the bot Function App's managed identity (`grant-bot-search-caller.sh` prints it), the only caller of `/api/search`. Empty: search off. Never an id of `BOT_CALLER_APP_IDS`. |
| `APPLICATIONINSIGHTS_CONNECTION_STRING`, `LOG_LEVEL` | |

**Removed in Phase 0:** `FALLBACK_CLIENT_ID`, `FALLBACK_SITE_HOSTNAME`, `FALLBACK_SITE_PATH`,
`FALLBACK_DRIVE_NAME` and `FALLBACK_ROOT_FOLDER`. The fallback bucket they described is replaced
by the quarantine. Until the Phase-0 ingestion is deployed, the old build still reads them, so
they are first pointed at the quarantine site
([human-steps H-6b](docs/operations/human-steps.md#h-6b-point-the-running-builds-fallback-at-the-quarantine)),
and deleted from the app once the Phase-0 build is verified
([human-steps H-14](docs/operations/human-steps.md#h-14-remove-the-fallback_-settings)).

**Removed with the Bicep drift fix (G1):** `SHAREPOINT_SITE_HOSTNAME`, `SHAREPOINT_SITE_PATH`,
`SHAREPOINT_DRIVE_NAME`, `SHAREPOINT_ROOT_FOLDER`, `CLIENT_NIP` and `CLIENT_COMPANY_NAME`, read by
nothing. Neither they nor the `FALLBACK_*` settings were still set on dev when it was read on
26 September.

---

## Repo layout

Yarn 4 + workspaces monorepo (`nodeLinker: node-modules`):

```
bcr-ledger-agent/
├── packages/
│   ├── shared/                  # @bcr/shared: types, config, errors, logger, folder taxonomy
│   │   └── src/parsers/folderTaxonomy.ts   ⭐ single source of truth for SharePoint paths
│   ├── teams-bot/               # @bcr/teams-bot: Functions v4 app, Bot Framework, the gate
│   │   └── src/bot/responseBuilder.ts       ⭐ Polish Adaptive Cards (cardText.ts escapes)
│   ├── document-ingestion/      # @bcr/document-ingestion: Functions v4 app, Graph client
│   │   └── src/services/clientResolver.ts   ⭐ identity-only routing and quarantine
│   └── ledger-db/               # @bcr/ledger-db: the document index (PostgreSQL, RLS per client)
│       └── src/tx.ts                        ⭐ withClientTx: the one place the scope is set
├── infrastructure/
│   ├── main.bicep                       # Azure resources and every app setting (lesson 20)
│   ├── main.dev.parameters.json
│   ├── db.bicep, db-deploy.sh           # the index database: a separate template, never main.bicep
│   ├── alerts.bicep, alerts-deploy.sh   # the email alerts: a separate template, never main.bicep
│   ├── deploy.sh                        # Bicep + zip-deploy wrapper. New environments only; refuses dev.
│   ├── app-settings-gate.sh             # before any Bicep deploy: template vs running app settings
│   ├── quarantine/                      # quarantine site script, and the managed identity's site grant
│   └── ir/                              # IR evidence store
├── tools/                               # operator tools: directory-bindings, inventory-misfiled, ir0/
├── teams-app/
│   ├── manifest.json                    # Teams app manifest 0.2.2 (personal scope only, no tab)
│   └── …
├── docs/
│   ├── operations/                      # incident, human steps, tenant hardening, GDPR drafts
│   ├── client-directory-admin-guide.md  # the routing list and its rules
│   ├── security.md                      # threat model T1–T19 and accepted risks
│   ├── setup-guide.md, admin-sharepoint-grant.md, deployment.md, local-development.md
├── artifacts/                           # build output, git-ignored: fresh zips per deploy
├── .env.example                         # Documented env var template
└── PROJECT_OVERVIEW.md                  # ← this file
```

---

## Content classification (Claude)

Ingestion sends each document's **content** (PDF, image or text) to Claude, with a tool schema
generated from the folder taxonomy. The model returns:

- a category id;
- an optional `year` and `month`;
- a confidence score;
- an optional `parties[]` (seller, buyer, issuer or recipient, with NIP and company name).

The category id maps to a literal SharePoint path through
[`buildFolderPath`](packages/shared/src/parsers/folderTaxonomy.ts); `dated` categories get a
`YYYY/MM` leaf. The model only suggests: the
[acceptance policy](packages/document-ingestion/src/services/acceptancePolicy.ts) files the
suggestion under its category only at or above `CLASSIFICATION_ACCEPT_THRESHOLD` (default
`0.70`), with a usable date for a dated category and a settled direction for an invoice;
anything else, and a document no model answered for, goes to `98_Nieposortowane/RRRR/MM/` with
the reasons logged. A 429, 529, 5xx or timeout from the API is "retry later", never review;
only a document that keeps timing out or getting a 5xx is, at a bound, filed for review with
`RETRY_EXHAUSTED` ([`ARCHITECTURE.md` §4](ARCHITECTURE.md#4-classification-pipeline)).

**Client identity is injected per request** through `ClassifierContext.client`, but only when
the uploader is bound to a client. The invoice direction is then settled from that identity only
([`invoiceDirection.ts`](packages/document-ingestion/src/services/invoiceDirection.ts)): the
client's NIP on one side of the parties, or the model's match of the primed NIP or name. Without
it, the invoice goes to review (`DIRECTION_UNRESOLVED`). **It never changes the client.**

| Kategoria (id) | Folder docelowy | Datowany |
|---|---|---|
| `faktury_sprzedazy` | `01_Faktury/01_Faktury_sprzedaży/<RRRR>/<MM>` | ✅ |
| `faktury_zakupu` | `01_Faktury/02_Faktury_zakupu/<RRRR>/<MM>` | ✅ |
| `faktury_korekty` | `01_Faktury/03_Korekty_i_anulowania/<RRRR>/<MM>` | ✅ |
| `faktury_noty` | `01_Faktury/04_Noty_i_dowody_księgowe/<RRRR>/<MM>` | ✅ |
| `wyciagi_bankowe` | `02_Wyciągi_bankowe/<RRRR>/<MM>` | ✅ |
| `raporty_marketplace` | `03_Raporty_marketplace/<RRRR>/<MM>` | ✅ |
| `umowy` | `04_Umowy` | — |
| `dokumenty_firmowe` | `05_Dokumenty_firmowe_ustawowe` | — |
| `kadry_place` | `06_Kadry_i_płace` | — |
| `deklaracje_jpk` | `07_Deklaracje_i_JPK` | — |
| `korespondencja` | `08_Korespondencja` | — |
| `raporty` | `09_Raporty` | — |
| `srodki_trwale` | `10_Środki_trwałe` | — |
| `ewidencja_vat` | `11_Ewidencja_VAT` | — |
| `onboarding_reguly` | `12_Onboarding_i_reguły` | — |
| `inne` | `13_Inne` | — |
| `nieposortowane` | `98_Nieposortowane/<RRRR>/<MM>` | ✅ |

For a bound client, these paths sit under the client's `RootFolder`: the "Dokumenty księgowe"
channel folder. That is why they show in the channel's files tab.

Edit the taxonomy (categories, folder segments, model guidance) in
[`packages/shared/src/parsers/folderTaxonomy.ts`](packages/shared/src/parsers/folderTaxonomy.ts).
The Claude prompt, the tool schema and the deterministic fallback are all driven by that one
catalogue, so they cannot drift apart.

---

## Bot UX (all Polish)

The cards are built in [`responseBuilder.ts`](packages/teams-bot/src/bot/responseBuilder.ts), and
their fixed strings live in [`cardText.ts`](packages/teams-bot/src/bot/cardText.ts):

- **Help / welcome.** "📂 Asystent Archiwizacji Dokumentów" and a short description: send files
  in this chat, or add them in the Team's „Dokumenty księgowe” channel, and the assistant works
  only on the account BCR created for the company (`NIP@bcr-group.pl`); files and messages from
  a guest account are not processed.
- **Batch result.** One card per Teams activity, one row per attachment:
  - uploaded rows show **Dokument · Kategoria · Folder**, with an "Otwórz" action per file into
    the client's own space;
  - quarantined rows show "📨 {nazwa}: Dokument przekazano do weryfikacji przez zespół BCR.",
    with no link;
  - rejected rows show a fixed Polish message by error code (`ClientAccountRequired`: ingestion
    refused the account, e.g. a guest, and stored nothing).

  Every inserted value is escaped. The model's reasoning is never shown.
- **Gate refusal.** One fixed line in a 1:1 chat; silence in any other conversation.

Teams app metadata ([`teams-app/manifest.json`](teams-app/manifest.json), version 0.2.2; its
descriptions name the chat and the channel, and the `NIP@bcr-group.pl` account):

- App name: **Asystent BCR** / **Asystent Archiwizacji Dokumentów BCR**
- Scopes: `personal` only. No static tab.
- Command list: `/pomoc`

*As-is before v2 (Sep 2026):* the card showed **Pewność** (confidence) and **Uzasadnienie** (the
model's reasoning). The manifest (0.1.5) shipped a "Moje dokumenty" personal tab that
deep-linked each user to their client's library through the anonymous `/api/mydocs` →
`/api/user-target` chain. Phase 0 removed both (see `docs/security.md` T7).

---

## Tooling and versions

| Tool | Version |
|---|---|
| Node.js | 22 LTS |
| Yarn | 4.3.1 (via Corepack) |
| Azure CLI | ≥ 2.65 |
| Azure Functions runtime | v4 programming model (Node) |
| Bicep | latest, bundled with `az` |
| Jest | 29.x |
| TypeScript | 5.5.x |
| Botbuilder | 4.23.x (out of support since 31 Dec 2025; migration planned) |
| @azure/identity, @azure/keyvault-secrets | 4.x / 4.x |
| @microsoft/microsoft-graph-client | latest |

---

## Build and deploy

```bash
corepack enable && corepack prepare yarn@4.3.1 --activate
cd bcr-ledger-agent
corepack yarn install --immutable
rm -rf packages/*/node_modules/@bcr/shared        # lesson 15
corepack yarn build && corepack yarn test && corepack yarn type-check
```

⚠️ **During Phase 0, deploy code only**, one app at a time, in the order in
[`docs/operations/human-steps.md`](docs/operations/human-steps.md#phase-0): the bot first, the
gate in `log` mode, then `enforce`, then ingestion. Do **not** run `./infrastructure/deploy.sh`,
`yarn deploy:*` or the Deploy workflow. They deploy Bicep first, which replaces the hand-set app
settings (lesson 20).

**1. Save what is running, before you build.** The package the app runs now is the rollback for
this deploy. Download it without printing its URL, which can carry a SAS token (lesson 19):
[`human-steps.md` H-9, step 1](docs/operations/human-steps.md#h-9-deploy-the-bot-with-the-gate-in-log-mode)
has the command. One exception: a pre-Phase-0 ingestion package is never a rollback.

**2. Package.** `yarn workspace @bcr/<pkg> package` cleans `dist` and the `tsbuildinfo`,
rebuilds, and runs `tools/package-function.mjs`, which builds a **new** zip every time, in a fresh
staging folder:

- it deletes the old zip before anything else, so a failed run leaves no zip rather than a stale
  one;
- it fails if any compiled `dist/**/*.js`, the app's or `@bcr/shared`'s, has no `src/**/*.ts`
  behind it, so the output of a deleted source (such as the old `functions/userTarget.js`) is
  never shipped;
- it ships no `*.map`, `*.d.ts` or `*.tsbuildinfo`;
- it installs production dependencies at the exact versions in `yarn.lock`, with install scripts
  disabled, and checks every top-level dependency's version against the root `node_modules`;
- it vendors `@bcr/shared` from the `packages/shared/dist` just built, and fails if that copy
  lacks the Phase-0 config, `searchMode` or `clientAccountVerdict` (the client-account rule).

`artifacts/*.zip` are git-ignored and no longer tracked: the zips that used to be committed were
pre-Phase-0 builds. Never commit a zip, and deploy only one built for this deploy.

```bash
corepack yarn workspace @bcr/teams-bot package            # → artifacts/teams-bot.zip
corepack yarn workspace @bcr/document-ingestion package   # → artifacts/document-ingestion.zip
```

**3. Check the vendored `@bcr/shared` before deploying** (lesson 10). Every count must be
greater than 0:

```bash
unzip -p artifacts/teams-bot.zip          node_modules/@bcr/shared/dist/config.js | grep -c botGateMode
unzip -p artifacts/document-ingestion.zip node_modules/@bcr/shared/dist/config.js | grep -c forbiddenTargetSitePaths
unzip -p artifacts/teams-bot.zip          node_modules/@bcr/shared/dist/config.js | grep -c searchMode
unzip -p artifacts/document-ingestion.zip node_modules/@bcr/shared/dist/config.js | grep -c searchMode
unzip -p artifacts/document-ingestion.zip node_modules/@bcr/shared/dist/clientAccount.js | grep -c clientAccountVerdict
```

**4. Deploy,** one app at a time. `$RG`, `$BOT` and `$INGEST` are set as in
[`human-steps.md` → Variables](docs/operations/human-steps.md#variables-used-below).

```bash
az functionapp deployment source config-zip -g $RG -n $BOT    --src artifacts/teams-bot.zip          --build-remote false
az functionapp deployment source config-zip -g $RG -n $INGEST --src artifacts/document-ingestion.zip --build-remote false
```

If the Kudu upload keeps failing, upload a new blob and point `WEBSITE_RUN_FROM_PACKAGE` at it
(lesson 19), with `-o none`.

---

## Current state (2026-09-25)

**Update, 2026-09-29.**

- ⚠️ **Client lockout, 26–28 September.** Tenant step T-1 blocked sign-in on the three
  `{NIP}@bcr-group.pl` client accounts (0002 PESKOVOI, 0003, 0004) on 26 September at 12:18Z, on
  the premise that they were shared mailboxes nobody signs in with; they are the clients' Teams
  sign-ins. The clients could not sign in to Teams until Roman re-enabled the accounts on
  28 September at 17:33–17:34Z. No document was lost. T-1 and T-2 are withdrawn, T-7 is a
  read-only record ([`tenant-hardening.md`](docs/operations/tenant-hardening.md),
  [`incident-2026-09.md`](docs/operations/incident-2026-09.md)); lesson 25.
- ✅ **The client-account rule** (owner's decision, 28 September): a client is its `{NIP}@`
  Member account, and guests have no capability. Live since 29 September: rows 2 and 10
  re-bound to the `{NIP}@` accounts at 10:58Z, ingestion deployed at 11:02Z and the bot at
  11:08Z, proven with the canary client account; the onboarding change deploys with that repo's
  next push. The canary client account for row 10 (a Member of BCR Kanarek only)
  was created on 29 September, and row 10's NIP was set to the canary's `9000000000`; the canary
  guest stays as the negative canary.

**As of 2026-09-25.**

- ⛔ **Incident IR-2026-09 open.** Containment is Phase 0. See
  [`docs/operations/incident-2026-09.md`](docs/operations/incident-2026-09.md) and
  [`docs/operations/human-steps.md`](docs/operations/human-steps.md).
- ✅ Automatic deploy on push to `main` removed (`f5a2bd4`, gate G0).
- ✅ Phase-0 shared contract committed (`21b0883`): quarantine, caller pinning, the bot gate and
  the new result statuses.
- ⏳ Phase-0 code: identity-only routing, quarantine, two-pass directory, bot gate, cards,
  `conflictBehavior=fail`, caller pinning and ids-only logs. Being integrated; not deployed.
- ⏳ Tenant hardening, quarantine site, directory bindings and the IR-0 evidence export: see
  human steps.
- ⏳ Yahor does not upload through the bot until the full v2 implementation is done.

<details>
<summary>As-is before v2 (Sep 2026): state on 2026-07-16</summary>

- All Azure resources deployed to `dev`. Bot and ingestion running with Polish UI. Key Vault
  references resolving.
- SharePoint grants on **TEST**, **BCR GROUP** and **PESKOVOI** (the `Sites.Selected` app role,
  plus per-site write to the MI).
- The Client Directory list was live on the BCR GROUP site with the PESKOVOI (0002) row: its NIP,
  five company aliases, and **Yahor's AAD id in `UserAadObjectIds`**. A staff id on a client row
  is root cause R4 of the incident.
- The two-phase resolver was in production. The second phase promoted fallback uploads to a
  client by a party's NIP: root cause R3.
- The Personal Tab `/api/mydocs` was deployed: threat T7.
- End-to-end smoke test: a KSeF purchase invoice resolved as PESKOVOI via the user id, was
  classified `faktury_zakupu`, and was filed at `01_Faktury/02_Faktury_zakupu/2026/02/` at
  PESKOVOI's library root.
- Teams app package v0.1.5 with `staticTabs`.

</details>

---

## Lessons learned (must-know gotchas for the next developer)

1. **Function MI ≠ API app registration.** The ingestion function calls Graph as its
   system-assigned **managed identity** (app id `d5226274-…`), not as the API app registration
   (`b8b90018-…`). Grant `Sites.Selected` and every per-site permission to the MI. The legacy
   `infrastructure/grant-sharepoint-permission.sh` granted to the app registration by default,
   wrote without a dry run and hard-coded this tenant's ids; it is deleted. Grants follow
   [`docs/setup-guide.md` §5](docs/setup-guide.md#5-grant-sharepoint-site-permission-sitesselected).

2. **Sites.Selected needs TWO grants** to work:
   - an app role assignment on Microsoft Graph (tenant-wide):
     `POST /servicePrincipals/{miOid}/appRoleAssignments`;
   - a per-site permission: `POST /sites/{siteId}/permissions`.

   With only one of them, Graph returns 401 `generalException`. Per-site grants are cached for
   about 5 minutes, so wait and retry after creating one.

3. **The Azure CLI cannot do the `Sites.FullControl.All` flow** in this tenant: it returns
   `AADSTS65002`, because Microsoft Graph requires a pre-authorization the CLI does not have. Use
   **Microsoft Graph Explorer** (see [`docs/admin-sharepoint-grant.md`](docs/admin-sharepoint-grant.md)),
   or the onboarding repo's `tools/graph-login.mjs` for a delegated token.

4. **Assigning Microsoft Graph app roles requires Global Administrator** (or Privileged Role
   Administrator). SharePoint Admin plus Graph permissions is not enough; the call returns
   `403 Authorization_RequestDenied`.

5. **`resourceId` in an `appRoleAssignments` POST body** must be the object id of **the Microsoft
   Graph service principal in this tenant** (`d36dca77-…` for BCR Group EU). It is not the Graph
   app id `00000003-…`, and not a user's object id.

6. **SharePoint drive names depend on the locale.** Polish tenants use `Dokumenty`, not
   `Documents`. Always look them up with `GET /sites/{id}/drives`. Client drive names are on the
   Directory rows (`DriveName`); the quarantine's is `QUARANTINE_DRIVE_NAME`.

7. **`config-zip` flake.** A single 24 MB blob PUT to storage can fail with "Bad Request" or a
   connection timeout on a slow network. Retry once; it succeeds.

8. **OneDeploy (`az webapp deploy`) does NOT work** on Linux Consumption Y1. It returns "This API
   isn't available in this environment yet!". Use `config-zip`.

9. **`package.json` `main`** must be `dist/index.js` (not `dist/src/index.js`) for Functions v4
   to find the entry point.

10. **A function zip can carry a stale `@bcr/shared`.** With `nodeLinker: node-modules`, Yarn
    hoists dependencies to the root `node_modules`, and `@bcr/shared` is only a workspace
    symlink there. The old `package` script ran `zip -r` inside the package folder: it found no
    fresh `@bcr/shared`, exited 0 anyway, and updated the existing archive in place, so the new
    `dist` shipped next to a July copy of `@bcr/shared`. A bot built that way ignores
    `BOT_GATE_MODE`; an ingestion built that way fails at cold start. The `package` script now
    runs `tools/package-function.mjs`, which stages a fresh folder and copies `@bcr/shared` from
    `packages/shared/dist`. It also deletes the old zip first, refuses a compiled file with no
    source behind it, and installs dependencies at the `yarn.lock` versions; and the zips are no
    longer committed, so there is no old archive to update. Still check the zip before every
    deploy ([Build and deploy](#build-and-deploy), step 3).

11. **The Teams manifest v1.17 schema** rejects the `packageName` field. Remove it before
    uploading.

12. **The bot app type** must be `MICROSOFT_APP_TYPE=SingleTenant`, because the app registration
    was created as `AzureADMyOrg`. A wrong value is a 401 on Bot Framework auth. The setting has
    been required since Phase 0.

13. **The Claude classifier's API key** lives in Key Vault (`anthropic-api-key`), and reaches the
    app as `ANTHROPIC_API_KEY` through a Key Vault reference. The classifier **never throws**: any
    API, size or parse failure returns `null`, and the deterministic fallback
    (`98_Nieposortowane/RRRR/MM/`) runs. `ANTHROPIC_ENABLED=false` runs fallback only, with no AI.

14. **`@anthropic-ai/sdk` must be ≥ 0.40** for typed PDF `document` content blocks
    (`Anthropic.Messages.ContentBlockParam`).

15. **Stale physical copy of `@bcr/shared`.** Yarn sometimes leaves a real directory, not a
    symlink, at `packages/<pkg>/node_modules/@bcr/shared`. It shadows the live package, so
    `tsc -b` keeps seeing old types after `shared` changes. It happens in fresh worktrees too.
    Fix: `rm -rf packages/*/node_modules/@bcr/shared`; resolution then falls back to the root
    symlink. `CLAUDE.md` says the same.

16. **Teams channels do not deliver files to a bot.** Files dropped into a channel (drag-drop, or
    the paperclip in the channel composer) go straight into the Team's own SharePoint and
    **never reach the bot**. `activity.attachments` holds only the `@mention` HTML. Only **1:1
    chats** deliver file bytes. Channel-based routing was built and removed after live testing.
    Manifest 0.2.0 is personal scope only, and the gate refuses everything else.

17. **Content must never choose the client.** Before Phase 0, the pipeline resolved the client
    twice: once from the uploader, and again after classification, when a fallback upload was
    "promoted" to any client whose NIP appeared in the document. That second step was the
    incident's cross-client write (R3). Routing is now identity-only. The only thing content may
    change is invoice direction, inside the bound client. Do not bring a second resolution back
    for convenience.

18. **Duplicate checks must not depend on row order.** The old single-pass dedupe deleted a key
    on the second duplicate and re-added it on the third, and merged rows sharing a ClientId. The
    Directory is now read in two passes: collect every key's rows first, then decide. A target
    conflict is keyed on the site, the `DriveId` and the `TeamId`, not on the folder: two rows in
    one library with different `RootFolder` spellings are still two clients in one library. See
    the [admin guide](docs/client-directory-admin-guide.md#duplicates-and-conflicts).

19. **`config-zip` → blob workaround.** When the Kudu upload keeps timing out:
    - upload the zip directly to the storage account (`stbcrdev...`, container
      `function-releases`) with `az storage blob upload --auth-mode login`;
    - generate a long-lived SAS with the account key (a user-delegation SAS is capped at 7 days);
    - set `WEBSITE_RUN_FROM_PACKAGE=<sas url>` on the function app, and restart.

    This bypasses Kudu entirely. The SAS URL is a credential: never print, paste or log it,
    and pass `-o none` to `appsettings set`. An account-key SAS cannot be revoked without
    rotating the key. Before switching, download the previous package from the old URL into a
    file (human-steps H-9, step 1): that file is the rollback, not the URL.

20. **A Bicep deploy replaces every app setting, and what-if does not show it.** What-if masks
    `siteConfig.appSettings` and cannot read the `appsettings` config values, so it reports no
    change whatever they hold. During Phase 0 the routing settings were set by hand and missing
    from the template, and one deploy would have taken ingestion down; the push-to-`main` deploy
    was removed for this reason (`f5a2bd4`). The template now records them (gate G1), CI checks
    that Bicep sets every setting the code reads (`yarn check:app-settings`), and
    `node tools/check-app-settings.mjs --live` compares the template with the running apps
    (`--expect` for the changes a deploy is meant to make). Bicep deploys to "dev" stay refused
    until [Lifting gate G1](docs/operations/human-steps.md#lifting-gate-g1) is done: the
    `WEBSITE_RUN_FROM_PACKAGE` carry-over has never run against a real app, so it is rehearsed
    on a throwaway resource group first. Any setting changed by hand must go into the parameters
    file too.

21. **`az functionapp config appsettings set` prints every setting**, including the storage
    account key in `AzureWebJobsStorage` and any SAS URL. Always pass `-o none`, and list
    settings with a `--query` filter.

22. **`az monitor app-insights query` needs both `--start-time` and `--end-time`.** With only a
    start, it silently queries a one-hour window, and the result looks complete.

23. **`Sites.Selected` is not a single-site scope.** It is an allow-list of per-site grants. An
    identity that files for many clients holds write on all of their sites. Design as if the
    ingestion identity can reach every client, because it can (`docs/security.md` T3).

24. **A guest binding checked only when the tool runs goes stale (R46).** When an onboarding
    invites someone who is already a guest of another client (one owner, two companies), Entra
    returns the same user, onboarding adds them to the new Team, and their existing row used to
    keep routing everything, the new company's documents included, into the first client's
    space until a fresh `directory-bindings.mjs propose` and an apply of the whole plan. Ingestion
    now reads the uploader's Teams at upload time and quarantines them as `membership_mismatch`
    unless they are exactly the row's `TeamId` (`MEMBERSHIP_CHECK_MODE`, needs Graph
    `Directory.Read.All` on the ingestion identity). Still apply the whole plan after every
    onboarding, never `--only` the new row, and run `check` at least weekly
    ([admin guide](docs/client-directory-admin-guide.md#keeping-the-bindings-current)).
    *Since 28 September 2026* a row binds its `{NIP}@` client account, not guests; the same rule
    holds for it, and a `{NIP}@` account in a second Team is always an anomaly.

25. **The `{NIP}@bcr-group.pl` accounts are the clients' Teams sign-ins, not shared mailboxes.**
    Blocking them (T-1, 26 Sep) locked clients out until 28 Sep. Never block, unlicense or
    convert them, and confirm with the owner how clients sign in before any tenant change that
    depends on it.
