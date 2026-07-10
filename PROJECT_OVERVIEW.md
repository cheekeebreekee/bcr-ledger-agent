# BCR Ledger Agent — Project Overview

> **One-line summary:** A Microsoft Teams bot for Polish accounting clients
> that auto-files document attachments (faktury, paragony, umowy, wyciągi,
> raporty, deklaracje) into the correct SharePoint folder structure by
> analysing each document's **content with Claude** (Anthropic API).

---

## What it does

User drops a file into a Teams chat with the bot:

```
User → DM bot in Teams → attaches "Faktura_03_2026.pdf"
       ↓
       Bot downloads the attachment
       ↓
       Bot calls ingestion API (with bearer JWT for Documents.Ingest role)
       ↓
       Ingestion API calls Claude with the document content + the folder
       taxonomy as a tool schema:
         invoice where client is the buyer → 01_Faktury/02_Faktury_zakupu/2026/03
       ↓
       Ingestion API uploads to SharePoint via Microsoft Graph (managed identity)
       ↓
       Bot replies with Polish Adaptive Card:
         "✅ Zarchiwizowano Faktura_03_2026.pdf"
         + Otwórz w SharePoint button → file in 01_Faktury/02_Faktury_zakupu/2026/03/
```

Documents Claude classifies with low confidence (or whose type it cannot
determine) fall back to `98_Nieposortowane/RRRR/MM/` for manual review.

---

## Architecture

```
Microsoft Teams (client)
        │
        ▼  POST /api/messages (BotFramework auth)
┌────────────────────────────┐     ┌────────────────────────────┐
│  func-bcr-bot-dev-…        │     │  Key Vault                 │
│  (Node 22 Functions v4)    │◀────│  kv-bcr-dev-…              │
│  @bcr/teams-bot            │     │  (bot-app-password ref)    │
└──────────┬─────────────────┘     └────────────────────────────┘
           │  POST /api/ingest (Bearer JWT)
           │  client_credentials grant → audience api://b8b90018-…
           │  role: Documents.Ingest
           ▼
┌────────────────────────────┐     ┌────────────────────────────┐
│  func-bcr-ingest-dev-…     │────▶│  SharePoint Online         │
│  (Node 22 Functions v4)    │     │  bcrgroupeu.sharepoint.com │
│  @bcr/document-ingestion   │     │  /sites/0000TESTSp.zo.o.-  │
│  ↳ system-assigned MI      │     │   Ksigowo                  │
│    d5226274-… / 7984e56c-… │     │  Drive: "Dokumenty"        │
│    role: Sites.Selected    │     │                            │
└────────────────────────────┘     └────────────────────────────┘
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
| SharePoint site | `https://bcrgroupeu.sharepoint.com/sites/0000TESTSp.zo.o.-Ksigowo` |
| SharePoint drive | **Dokumenty** (Polish locale — NOT "Documents") |

Endpoints:
- Bot: `POST https://func-bcr-bot-dev-vyyintffz6ehq.azurewebsites.net/api/messages`
- Ingestion health: `GET https://func-bcr-ingest-dev-vyyintffz6ehq.azurewebsites.net/api/health`
- Ingestion: `POST https://func-bcr-ingest-dev-vyyintffz6ehq.azurewebsites.net/api/ingest`

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
and a confidence score. The category id maps to a literal SharePoint path via
[`buildFolderPath`](packages/shared/src/parsers/folderTaxonomy.ts); `dated`
categories get a nested `YYYY/MM` leaf. If confidence is below
`ANTHROPIC_CONFIDENCE_THRESHOLD` (default `0.6`), or no AI is configured, the
deterministic fallback routes the file to `98_Nieposortowane/RRRR/MM/`.

Invoice direction (sales vs. purchase) is resolved by giving the model the
client's identity (`CLIENT_COMPANY_NAME` + `CLIENT_NIP`): if the client is the
seller it is `Faktura sprzedaży`, if the buyer it is `Faktura zakupu`.

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

- **Help / welcome** — "📂 Asystent Archiwizacji Dokumentów" + Polish pattern list
- **Success** — "✅ Zarchiwizowano **<plik>**" + Typ / Pewność / Folder / "Otwórz w SharePoint" button
- **Failure** — "⚠️ Nie udało się zarchiwizować pliku **<plik>**" + error reason

Teams app metadata (Polish, see [`teams-app/manifest.json`](teams-app/manifest.json)):
- App name: **Asystent BCR** / **Asystent Archiwizacji Dokumentów BCR**
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

## Current state (2026-06-17)

- ✅ All 11 Azure resources deployed
- ✅ Bot + ingestion functions running, **all Polish localization deployed**
- ✅ Key Vault references resolve
- ✅ SharePoint grants complete (both Graph app role + per-site write to the MI)
- ✅ End-to-end smoke test passing — `Faktura_03_2026.pdf` lands in `Faktury/2026/03/`
- ✅ Teams app package built: [`artifacts/teams-app.zip`](artifacts/teams-app.zip) (manifest v0.1.1, Bot App ID injected, icons included, `packageName` removed for Teams v1.17 schema compliance)
- ⏳ **Pending:** Teams Admin (Roman, Global Administrator) to upload the zip via <https://admin.teams.microsoft.com> → Teams apps → Manage apps → Upload new app, and optionally publish org-wide / pin via Setup policies.

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

6. **SharePoint drive name is locale-dependent.** Polish tenants use `Dokumenty`, not `Documents`. Always look up via `GET /sites/{id}/drives`. Currently set via env var `SHAREPOINT_DRIVE_NAME=Dokumenty`.

7. **`config-zip` flake.** Single-shot 24 MB blob PUT to storage can hit "Bad Request" / connection timeout on slow networks. Just retry once; succeeds.

8. **OneDeploy (`az webapp deploy`) does NOT work** on Linux Consumption Y1 — returns "This API isn't available in this environment yet!" Must use `config-zip`.

9. **`package.json` `main` field** must be `dist/index.js` (not `dist/src/index.js`) for Functions v4 to find the entry point. `tsc -b` with `rootDir: ./src, outDir: ./dist` writes to `dist/index.js`.

10. **Yarn `workspaces focus --production`** hoists deps to the root `node_modules` (because `nodeLinker: node-modules`). Have to `cp -R node_modules packages/<pkg>/node_modules` and then resolve the `@bcr/shared` workspace symlink manually before zipping.

11. **Teams manifest v1.17 schema** rejects `packageName` field — remove it before uploading.

12. **Bot app type** must be `MICROSOFT_APP_TYPE=SingleTenant` since the app reg was created with `AzureADMyOrg`. Wrong value → 401 on BotFramework auth.

13. **Claude classifier API key** lives in Key Vault (`anthropic-api-key`) and is injected as `ANTHROPIC_API_KEY` via a Key Vault reference. The classifier **never throws** — any API/size/parse failure returns `null` so the deterministic fallback (`98_Nieposortowane/RRRR/MM/`) still runs. Set `ANTHROPIC_ENABLED=false` to run fallback-only (no AI).

14. **`@anthropic-ai/sdk` must be ≥ 0.40** for typed PDF `document` content blocks. The pinned `0.32.1` lacked `DocumentBlockParam`/`ContentBlockParam`; upgraded to `^0.104.2`. Content blocks are typed as `Anthropic.Messages.ContentBlockParam`.

15. **Stale nested workspace copy.** Yarn left a physical (non-symlink) copy of `@bcr/shared` at `packages/document-ingestion/node_modules/@bcr/shared` that shadowed the live package, so `tsc -b` kept seeing old types after editing shared. Fix: `rm -rf packages/document-ingestion/node_modules/@bcr/shared` (resolution then falls back to the root symlink) — or re-run `yarn install`.

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
