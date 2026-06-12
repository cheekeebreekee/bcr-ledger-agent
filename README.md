# bcr-ledger-agent

A Microsoft Teams **AI Agent** that watches a chat for document attachments,
classifies each file by its name (and optionally its content via Azure AI
Document Intelligence), and uploads it to the correct folder in SharePoint
Online — all hosted on Microsoft Azure and written in Node.js + TypeScript.

> Example  
> A user drops `Invoice_03_2026.pdf` into the chat with the bot.  
> The bot replies with an adaptive card:  
> *“✅ Uploaded `Invoice_03_2026.pdf` → `Documents/Invoices/2026/03/`.”*

---

## High-level flow

```
┌───────────┐  1. message + attachment   ┌────────────────────┐
│   Teams   │ ─────────────────────────▶ │  Azure Bot Service │
│  client   │                            │ (Teams channel)    │
└───────────┘                            └─────────┬──────────┘
                                                   │ 2. /api/messages (HTTPS)
                                                   ▼
                                         ┌────────────────────┐
                                         │  Func App: bot     │
                                         │  (Bot Framework)   │
                                         └─────────┬──────────┘
              3. download attachment via bot token │
                                                   ▼
                                         ┌────────────────────┐
                                         │ Func App:          │
                                         │ document-ingestion │
                                         │ (HTTP triggers)    │
                                         └─┬──────┬──────┬────┘
                4. classify (regex + AI)   │      │      │ 6. write audit log
                                           ▼      ▼      ▼
                              ┌────────────┐ ┌──────┐ ┌────────────┐
                              │ Document   │ │ MS   │ │ App        │
                              │ Intelligence│ │Graph │ │ Insights   │
                              └────────────┘ └──┬───┘ └────────────┘
                                                │ 5. PUT /drive/root:/path:/content
                                                ▼
                                       ┌────────────────────┐
                                       │  SharePoint Online │
                                       └────────────────────┘
```

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the deep dive.

---

## Repository layout

```
bcr-ledger-agent/
├── packages/
│   ├── shared/                 # Cross-cutting types, parsers, logger, config
│   ├── teams-bot/              # Bot Framework v4 hosted in Azure Functions
│   └── document-ingestion/     # HTTP-triggered ingestion / SharePoint API
├── infrastructure/             # Bicep IaC (Bot, Func, KV, AI, App Insights)
├── teams-app/                  # Teams app manifest + icons (sideload package)
├── docs/                       # Deployment, local-dev, sequence diagrams
└── .github/workflows/          # CI build + multi-stage deploy
```

This is a **Yarn 4 + workspaces** monorepo (npmClient compatible).
Each `packages/*` is independently buildable and deployable.

---

## Quick start (local)

Requirements: **Node 22 LTS**, **Yarn 4**, **Azure Functions Core Tools v4**,
**Azure CLI**, and a Bot Framework Emulator install.

```bash
# 1. Install deps for all workspaces
yarn install

# 2. Build the shared library once (others depend on it)
yarn workspace @bcr/shared build

# 3. Copy env templates and fill in secrets
cp packages/teams-bot/local.settings.json.example packages/teams-bot/local.settings.json
cp packages/document-ingestion/local.settings.json.example packages/document-ingestion/local.settings.json

# 4. Run both functions side-by-side
yarn start:bot           # http://localhost:3978/api/messages
yarn start:ingestion     # http://localhost:7071/api/ingest
```

Then point the **Bot Framework Emulator** at `http://localhost:3978/api/messages`
and drag any file named like `Invoice_03_2026.pdf` into the chat.

---

## Scripts (root)

| Script | What it does |
|---|---|
| `yarn build` | Build every workspace |
| `yarn test` | Run Jest in every workspace |
| `yarn lint` | ESLint over the whole repo |
| `yarn start:bot` | Start the Teams-bot Function App locally |
| `yarn start:ingestion` | Start the document-ingestion Function App locally |
| `yarn deploy:dev` | Deploy infra + code to the `dev` environment |
| `yarn deploy:prod` | Deploy infra + code to the `prod` environment |

---

## Security model (TL;DR)

1. **Teams → Bot Function** is authenticated by the Bot Framework JWT
   (signed by `login.botframework.com`); validated by the SDK middleware.
2. **Bot Function → Ingestion Function** uses **Azure AD client-credentials**
   (MSAL) — the bot gets a token for the ingestion App Registration scope
   `api://<ingestion-app-id>/.default` and sends it as a `Bearer` token.
3. **Ingestion Function → Microsoft Graph** uses the Function App’s
   **system-assigned managed identity** + a federated credential, with the
   Graph application permission `Sites.Selected` scoped to the target site.
4. **Secrets** live in **Key Vault** and are referenced from Function App
   settings (`@Microsoft.KeyVault(SecretUri=...)`) — never in source.
5. All requests and uploads are logged to **Application Insights** with
   correlation IDs so a single Teams message can be traced end to end.

See [`docs/security.md`](./docs/security.md) for the full threat model.
