# BCR Ledger Agent — Project Overview

> **One-line summary:** A Microsoft Teams bot for Polish accounting clients
> that auto-files document attachments (faktury, paragony, umowy, wyciągi,
> raporty, deklaracje) into each client's SharePoint folder structure by
> analysing each document's **content with Claude** (Anthropic API), with
> per-upload routing driven by a Client Directory SharePoint list.

---

## What it does

A registered user DMs the bot in Teams (channels don't work — see below):

```
User → DM bot in Teams → attaches "Faktura_03_2026.pdf"
       ↓
       Bot downloads the attachment
       ↓
       Bot calls ingestion API (Bearer JWT for Documents.Ingest role)
       ↓
       Ingestion API:
         (1) Resolves the user's client via Client Directory (byUserAadObjectId)
         (2) Calls Claude with the document content + client identity primed
         (3) Claude returns category + confidence + parties[] (seller/buyer/NIP)
         (4) Post-classification: promotes fallback → client on party NIP match,
             flips invoice sales⇄purchase when client role in parties disagrees
         (5) Uploads to the resolved client's SharePoint via Microsoft Graph
       ↓
       Bot replies with Polish Adaptive Card:
         "✅ Zarchiwizowano Faktura_03_2026.pdf"
         + Otwórz w SharePoint button → file in resolved client's site
```

Documents Claude classifies with low confidence (or whose type it cannot
determine) fall back to `98_Nieposortowane/RRRR/MM/` on the resolved
client's site (or on the BCR Group fallback bucket if no user match).

**Personal Tab “Moje dokumenty”** — the Teams app manifest ships a
personal tab that deep-links each user directly to their client's
SharePoint document library. Uses the Teams SDK to open SharePoint from
inside Teams.

---

## Architecture

```
Microsoft Teams (client — 1:1 DM only for file uploads;
                          personal tab "Moje dokumenty")
        │
        ▼  POST /api/messages (BotFramework auth)
┌────────────────────────────┐     ┌────────────────────────────┐
│  func-bcr-bot-dev-…        │     │  Key Vault                 │
│  (Node 22 Functions v4)    │◀────│  kv-bcr-dev-…              │
│  @bcr/teams-bot            │     │  (bot-app-password ref)    │
│  ┝ /api/messages           │     └────────────────────────────┘
│  ┕ /api/mydocs (tab HTML)  │
└──────────┬─────────────────┘
           │  POST /api/ingest(/batch) or GET /api/user-target (Bearer JWT)
           │  client_credentials → audience api://b8b90018-…
           │  role: Documents.Ingest
           ▼
┌────────────────────────────┐
│  func-bcr-ingest-dev-…     │
│  (Node 22 Functions v4)    │
│  @bcr/document-ingestion   │      Two-phase resolver:
│  ┝ /api/health             │      1. resolve(source) → byUserAadObjectId
│  ┝ /api/ingest             │      2. classify() w/ primed client identity
│  ┝ /api/ingest/batch       │      3. resolvePostClassification() → promote
│  ┝ /api/user-target        │         fallback, flip invoice direction
│  ┕ system-assigned MI      │      4. sharePointFactory.forTarget()
│    d5226274-… / 7984e56c-… │         .uploadDocument()
│    role: Sites.Selected    │
└──────────┬─────────────────┘
           │                        Claude (Anthropic Messages API)
           ├───▶  content + tool schema → category + parties[]
           │
           ▼
┌───────────────────────────────────────────────────────────────┐
│  Microsoft Graph → SharePoint Online (bcrgroupeu.sharepoint.com)│
│                                                                │
│  Client Directory (BCR GROUP site, list 2a5613f1-…)            │
│    rows: ClientId · NIP · Aliases · UserAadObjectIds ·         │
│          SiteHostname/SitePath/DriveName · IsAdmin · Status    │
│                                                                │
│  Per-client sites (dev):                                       │
│    ┝ /sites/BCRGROUPSp.zo.o          — fallback bucket         │
│    ┝ /sites/0002PESKOVOISp.zo.o.-…   — PESKOVOI (0002)         │
│    ┕ /sites/0000TESTSp.zo.o.-…       — TEST (dev only)         │
│  Drive: "Dokumenty" on all (Polish locale)                     │
└───────────────────────────────────────────────────────────────┘
```

### Identities & permissions

| Principal | App ID | Object ID | Role / scope |
|---|---|---|---|
| Bot app reg | `3ee1ba6c-2501-4e2d-9971-ab156a9a6f9a` | (SP-side) | Holds bot client secret; requests `Documents.Ingest` app role on ingestion API |
| Ingestion API app reg | `b8b90018-9af0-4d7a-ada2-71559952ebbe` | — | Audience identity (`api://b8b90018-…`); defines `Documents.Ingest` app role |
| Ingestion func **managed identity** | `d5226274-a2c0-4ae9-9c3b-34158c43f2fc` | `7984e56c-e264-427d-8e90-ff57dea6b0fa` | Calls Microsoft Graph with `Sites.Selected` + per-site `write` |

Two-step SharePoint grant required (see Lessons Learned):
1. `Sites.Selected` app role on Microsoft Graph → MI (role id `883ea226-0bf2-4a8f-9f9d-92c9162a727d`)
2. `write` permission on the site → MI app id `d5226274-…` (via `POST /sites/{id}/permissions`)

---

## Azure environment (dev)

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
| Storage | `stbcrdevvyyintffz6ehq` |
| SharePoint sites (in use) | `/sites/BCRGROUPSp.zo.o` (fallback + hosts Client Directory list), `/sites/0002PESKOVOISp.zo.o.-Ksigowo` (PESKOVOI), `/sites/0000TESTSp.zo.o.-Ksigowo` (dev-only sandbox). All on `bcrgroupeu.sharepoint.com`. |
| SharePoint drive | **Dokumenty** (Polish locale — NOT "Documents"). Per-client `DriveName` set on Client Directory rows; fallback via `FALLBACK_DRIVE_NAME`. |
| Client Directory list | `2a5613f1-6193-4c04-8a3d-d606617fb411` on BCR GROUP site |

Endpoints:
- Bot: `POST https://func-bcr-bot-dev-vyyintffz6ehq.azurewebsites.net/api/messages`
- Bot Personal Tab HTML: `GET https://func-bcr-bot-dev-vyyintffz6ehq.azurewebsites.net/api/mydocs?userObjectId=<guid>&theme=<theme>` (anonymous, called by Teams)
- Ingestion health: `GET https://func-bcr-ingest-dev-vyyintffz6ehq.azurewebsites.net/api/health`
- Ingestion (single doc): `POST https://func-bcr-ingest-dev-vyyintffz6ehq.azurewebsites.net/api/ingest` (Bearer JWT)
- Ingestion (batch): `POST https://func-bcr-ingest-dev-vyyintffz6ehq.azurewebsites.net/api/ingest/batch` (Bearer JWT)
- Ingestion user-target: `GET https://func-bcr-ingest-dev-vyyintffz6ehq.azurewebsites.net/api/user-target?userAadObjectId=<guid>` (Bearer JWT, called by bot for the Personal Tab)

---

## Repo layout

Yarn 4 + Workspaces monorepo (`nodeLinker: node-modules`):

```
bcr-ledger-agent/
├── packages/
│   ├── shared/                  # @bcr/shared — types, errors, logger, folder taxonomy
│   │   └── src/parsers/folderTaxonomy.ts   ⭐ single source of truth for SharePoint paths
│   ├── teams-bot/               # @bcr/teams-bot — Functions v4 app, BotFramework
│   │   └── src/bot/responseBuilder.ts       ⭐ Polish Adaptive Cards
│   └── document-ingestion/      # @bcr/document-ingestion — Functions v4 app, Graph client
│       └── src/services/sharePointService.ts ⭐ resolves drive + uploads via Graph
├── infrastructure/
│   ├── main.bicep                       # All 11 Azure resources
│   ├── main.dev.parameters.json         # Real values for dev (site path, app ids)
│   ├── deploy.sh                        # Bicep + zip-deploy wrapper
│   └── grant-sharepoint-permission.sh   # (legacy) only works in tenants without strict pre-auth
├── teams-app/
│   ├── manifest.json                    # Teams app manifest (Polish strings)
│   ├── _make_icons.py                   # stdlib placeholder icon generator
│   ├── color.png / outline.png          # generated
│   └── README.md
├── docs/
│   ├── setup-guide.md                   # Full first-time setup walkthrough
│   ├── admin-sharepoint-grant.md        # Graph Explorer steps for Sites.Selected grant
│   ├── deployment.md
│   ├── local-development.md
│   └── security.md
├── artifacts/                           # Built zips (teams-bot, document-ingestion, teams-app)
├── .env.example                         # Documented env var template
├── .env                                 # Real dev values (gitignored)
└── PROJECT_OVERVIEW.md                  # ← this file
```

---

## Content classification (Claude)

The ingestion API sends each document's **content** (PDF / image / text) to
Claude (Anthropic Messages API) together with a tool schema generated from the
folder taxonomy. The model returns a category id, an optional `year`/`month`,
a confidence score, and an optional `parties[]` array (seller/buyer/issuer/
recipient with NIP + company name). The category id maps to a literal
SharePoint path via [`buildFolderPath`](packages/shared/src/parsers/folderTaxonomy.ts);
`dated` categories get a nested `YYYY/MM` leaf. If confidence is below
`ANTHROPIC_CONFIDENCE_THRESHOLD` (default `0.6`), or no AI is configured, the
deterministic fallback routes the file to `98_Nieposortowane/RRRR/MM/`.

**Client identity is injected per request** via `ClassifierContext.client`
(populated from the pre-resolved routing decision). When present, Claude
knows the client's NIP/name and can decide invoice direction (sales vs
purchase) directly. When absent (fallback routing), Claude extracts
`parties[]` without deciding direction and
[`ClientResolver.resolvePostClassification`](packages/document-ingestion/src/services/clientResolver.ts)
derives direction from party role vs client NIP — flipping
`faktury_sprzedazy`/`faktury_zakupu`/`nieposortowane` categories when the
resolved client's NIP matches a party's role in the document.

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

Edit the taxonomy (categories, folder segments, model guidance) in
[`packages/shared/src/parsers/folderTaxonomy.ts`](packages/shared/src/parsers/folderTaxonomy.ts).
The Claude prompt + tool schema and the deterministic fallback are both driven
by that single catalog, so they can never drift apart.

---

## Bot UX (all Polish)

Three Adaptive Cards (see [`packages/teams-bot/src/bot/responseBuilder.ts`](packages/teams-bot/src/bot/responseBuilder.ts)):

- **Help / welcome** — "📂 Asystent Archiwizacji Dokumentów" + short
  description of content-based classification (no more filename patterns).
- **Batch result table** — one card per Teams activity, one row per
  attachment: **Dokument · Folder · Pewność · Uzasadnienie**, plus an
  "Otwórz" action per uploaded file.
- **Failure** — rejected items in the same table get an error reason
  instead of a folder.

**Personal Tab “Moje dokumenty”** ([`packages/teams-bot/src/functions/mydocs.ts`](packages/teams-bot/src/functions/mydocs.ts)):
calls the ingest function's `/api/user-target` endpoint to resolve the
user → client, then renders a themed HTML page (Teams SDK, light/dark/
contrast) with an "Otwórz w SharePoint" button that deep-links via
`microsoftTeams.app.openLink`. SharePoint can't be iframed cross-origin,
so we deep-link out instead of embedding.

Teams app metadata (Polish, see [`teams-app/manifest.json`](teams-app/manifest.json)):
- App name: **Asystent BCR** / **Asystent Archiwizacji Dokumentów BCR**
- Static tab: **Moje dokumenty** (`scopes: ["personal"]`)
- Command list: `/pomoc`

---

## Tooling & versions

| Tool | Version |
|---|---|
| Node.js | 22 LTS |
| Yarn | 4.3.1 (via Corepack) |
| Azure CLI | ≥ 2.65 |
| Azure Functions runtime | v4 programming model (Node) |
| Bicep | (latest, bundled with `az`) |
| Jest | 29.x |
| TypeScript | 5.5.x |
| Botbuilder | 4.23.x |
| @azure/identity, @azure/keyvault-secrets | 4.x / 4.x |
| @microsoft/microsoft-graph-client | latest |

---

## Build / deploy (one-shot from clean repo)

```bash
corepack enable && corepack prepare yarn@4.3.1 --activate
cd bcr-ledger-agent
corepack yarn install --immutable
corepack yarn workspaces foreach -At --include '@bcr/*' run build
corepack yarn workspaces foreach -At --include '@bcr/*' run test:coverage   # 59 tests, ≥85% coverage
```

For deploy (assumes Bicep + RBAC already in place — see `docs/setup-guide.md`):

```bash
# 1. Infra
./infrastructure/deploy.sh dev

# 2. Function code (zip-deploy both apps; retry once on transient blob PUT errors)
corepack yarn workspaces focus --production @bcr/teams-bot @bcr/document-ingestion
# mirror root node_modules into each package, then:
(cd packages/teams-bot         && zip -rq ../../artifacts/teams-bot.zip         dist host.json package.json node_modules)
(cd packages/document-ingestion && zip -rq ../../artifacts/document-ingestion.zip dist host.json package.json node_modules)
az functionapp deployment source config-zip -g rg-bcr-ledger-dev -n func-bcr-bot-dev-vyyintffz6ehq    --src artifacts/teams-bot.zip          --build-remote false
az functionapp deployment source config-zip -g rg-bcr-ledger-dev -n func-bcr-ingest-dev-vyyintffz6ehq --src artifacts/document-ingestion.zip --build-remote false

# 3. Teams app
cd teams-app && python3 _make_icons.py        # one-time
# (build script substitutes Bot App ID + zips manifest + icons → artifacts/teams-app.zip)
```

---

## Current state (2026-07-16)

- ✅ All Azure resources deployed to `dev`
- ✅ Bot + ingestion functions running, all Polish localization deployed
- ✅ Key Vault references resolve
- ✅ SharePoint grants complete on **TEST**, **BCR GROUP**, and **PESKOVOI** sites (Sites.Selected app role + per-site write to the MI)
- ✅ Multi-tenant Client Directory list live on BCR GROUP site (id `2a5613f1-6193-4c04-8a3d-d606617fb411`) with the PESKOVOI (0002) row populated — NIP `9571185285`, 5 company aliases, Yahor's AAD id in `UserAadObjectIds`
- ✅ Two-phase resolver in production: pre-classification (by `userAadObjectId`) + post-classification (fallback → client promotion via party NIP, invoice-direction flip via party role)
- ✅ Personal Tab `/api/mydocs` deployed — verified rendering PESKOVOI info for Yahor's AAD id
- ✅ End-to-end smoke test passing: KSeF purchase invoice `8652567240-20260217-6672A3400000-FD 5.pdf` → resolved as PESKOVOI via user id → Claude classified `faktury_zakupu` → filed at `01_Faktury/02_Faktury_zakupu/2026/02/` in PESKOVOI's site
- ✅ Teams app package rebuilt at [`artifacts/teams-app.zip`](artifacts/teams-app.zip) (manifest v0.1.5 with `staticTabs`, Bot App ID injected)
- ⏳ **Pending:** re-sideload the v0.1.5 app package via Teams Admin Center to enable the Personal Tab for existing users; onboarding of additional client rows in the Client Directory as clients come on board.

---

## Lessons learned (must-know gotchas for next dev)

1. **Function MI ≠ API app registration.** The ingestion function calls Graph using its system-assigned **managed identity** (app id `d5226274-…`), not the API app reg (`b8b90018-…`). Grant `Sites.Selected` to the MI.

2. **Sites.Selected needs TWO grants** to actually work:
   - App role assignment on Microsoft Graph (tenant-wide): `POST /servicePrincipals/{miOid}/appRoleAssignments`
   - Per-site permission: `POST /sites/{siteId}/permissions`
   Granting only one returns 401 `generalException` on Graph calls. Per-site grants are cached for ~5 min, so wait + retry after creating them.

3. **Azure CLI cannot do the `Sites.FullControl.All` flow** in this tenant — returns `AADSTS65002` (Microsoft Graph requires pre-authorization the CLI doesn't have). Use **Microsoft Graph Explorer** instead (it's pre-authorized). See [`docs/admin-sharepoint-grant.md`](docs/admin-sharepoint-grant.md).

4. **Assigning Microsoft Graph app roles requires Global Administrator** (or Privileged Role Administrator) directory role. SharePoint Admin + Graph permissions are not enough — Azure AD enforces this hard. Returns `403 Authorization_RequestDenied`.

5. **`resourceId` in `appRoleAssignments` POST body** must be the **Microsoft Graph SP's object id in this tenant** (`d36dca77-…` for BCR Group EU), NOT the Graph app id `00000003-…` and NOT a user object id.

6. **SharePoint drive name is locale-dependent.** Polish tenants use `Dokumenty`, not `Documents`. Always look up via `GET /sites/{id}/drives`. Per-client drive names live on Client Directory rows (`DriveName` column); the fallback bucket's is `FALLBACK_DRIVE_NAME`.

7. **`config-zip` flake.** Single-shot 24 MB blob PUT to storage can hit "Bad Request" / connection timeout on slow networks. Just retry once; succeeds.

8. **OneDeploy (`az webapp deploy`) does NOT work** on Linux Consumption Y1 — returns "This API isn't available in this environment yet!" Must use `config-zip`.

9. **`package.json` `main` field** must be `dist/index.js` (not `dist/src/index.js`) for Functions v4 to find the entry point. `tsc -b` with `rootDir: ./src, outDir: ./dist` writes to `dist/index.js`.

10. **Yarn `workspaces focus --production`** hoists deps to the root `node_modules` (because `nodeLinker: node-modules`). Have to `cp -R node_modules packages/<pkg>/node_modules` and then resolve the `@bcr/shared` workspace symlink manually before zipping.

11. **Teams manifest v1.17 schema** rejects `packageName` field — remove it before uploading.

12. **Bot app type** must be `MICROSOFT_APP_TYPE=SingleTenant` since the app reg was created with `AzureADMyOrg`. Wrong value → 401 on BotFramework auth.

13. **Claude classifier API key** lives in Key Vault (`anthropic-api-key`) and is injected as `ANTHROPIC_API_KEY` via a Key Vault reference. The classifier **never throws** — any API/size/parse failure returns `null` so the deterministic fallback (`98_Nieposortowane/RRRR/MM/`) still runs. Set `ANTHROPIC_ENABLED=false` to run fallback-only (no AI).

14. **`@anthropic-ai/sdk` must be ≥ 0.40** for typed PDF `document` content blocks. The pinned `0.32.1` lacked `DocumentBlockParam`/`ContentBlockParam`; upgraded to `^0.104.2`. Content blocks are typed as `Anthropic.Messages.ContentBlockParam`.

15. **Stale nested workspace copy.** Yarn left a physical (non-symlink) copy of `@bcr/shared` at `packages/document-ingestion/node_modules/@bcr/shared` that shadowed the live package, so `tsc -b` kept seeing old types after editing shared. Fix: `rm -rf packages/document-ingestion/node_modules/@bcr/shared` (resolution then falls back to the root symlink) — or re-run `yarn install`.

16. **Teams channels are a footgun for bot file uploads.** Files dropped into a Teams channel (drag-drop OR paperclip on channel composer) go straight into `Shared Documents/<ChannelName>/` on the Team's own SharePoint site and **never reach the bot** — `activity.attachments` only contains the `@mention` HTML (`contentType: text/html`). Bot delivery of file bytes only works in **1:1 DMs**. Channel-based routing was designed, briefly implemented, and removed after live testing; user-identity routing (`UserAadObjectIds`) is the only functional path.

17. **Two-phase resolution.** The ingestion pipeline resolves the target client **twice** — once from the envelope before calling Claude (so client identity can be primed into the prompt), and once after (using extracted `parties[]` to promote fallback uploads or flip invoice direction). Keeping these separate is important: any refinement failure degrades to the pre-resolved routing so uploads never block on the second phase.

18. **Client Directory list dedup is fail-closed.** If the same NIP or AAD id appears on two different Directory rows, the reader removes the ambiguous key from the lookup maps and logs a warning. Better to fall back than to mis-file into the wrong client's SharePoint site. Onboarding admins should watch for duplicate-warning traces in App Insights.

19. **`config-zip` → blob workaround.** When Kudu upload keeps timing out ("Bad Request" or "Connection aborted"), the fix is to upload the zip directly to the storage account (`stbcrdev...`, container `function-releases`) with `az storage blob upload --auth-mode login`, generate a long-lived SAS with the account key (user-delegation SAS is capped at 7 days), and set `WEBSITE_RUN_FROM_PACKAGE=<sas url>` on the function app + restart. Bypasses Kudu entirely.

---

## Where to read more

- [docs/setup-guide.md](docs/setup-guide.md) — full first-time setup
- [docs/admin-sharepoint-grant.md](docs/admin-sharepoint-grant.md) — Graph Explorer steps for Sites.Selected
- [docs/deployment.md](docs/deployment.md) — Bicep + zip-deploy details
- [docs/local-development.md](docs/local-development.md) — emulator + curl recipes
- [docs/security.md](docs/security.md) — threat model + secrets inventory
- [packages/shared/src/parsers/folderTaxonomy.ts](packages/shared/src/parsers/folderTaxonomy.ts) — folder taxonomy (categories + SharePoint paths)
- [packages/document-ingestion/src/services/claudeClassifier.ts](packages/document-ingestion/src/services/claudeClassifier.ts) — Claude content classifier
- [packages/teams-bot/src/bot/responseBuilder.ts](packages/teams-bot/src/bot/responseBuilder.ts) — Polish bot strings
- [packages/document-ingestion/src/services/sharePointService.ts](packages/document-ingestion/src/services/sharePointService.ts) — Graph upload logic
- [infrastructure/main.bicep](infrastructure/main.bicep) — Azure resources
- [teams-app/manifest.json](teams-app/manifest.json) — Teams app metadata (placeholder Bot App ID; real one injected at build time)
