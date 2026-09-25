# bcr-ledger-agent

A Microsoft Teams **AI Agent** that watches a chat for document attachments,
classifies each file by analysing its **content with Claude** (Anthropic API),
and uploads it to the correct folder in the user's client's SharePoint Online
space — all hosted on Microsoft Azure and written in Node.js + TypeScript.

> Example  
> A PESKOVOI employee DMs the bot with `8652567240-20260217-FD.pdf` (a KSeF
> purchase invoice).  
> The bot replies with an adaptive card:  
> *“✅ Zarchiwizowano → `01_Faktury/02_Faktury_zakupu/2026/02/` in PESKOVOI's SharePoint.”*

**One deployment routes for many clients.** Which SharePoint site a
document lands in is decided per-upload by a *Client Directory*
SharePoint list — no per-client deployment, no channel setup. See
[`docs/client-directory-admin-guide.md`](./docs/client-directory-admin-guide.md).

**Users interact via 1:1 DM.** Teams channel uploads don't reliably
reach bots (drag-drop bypasses Bot Framework; `@mentions` don't carry
attachments) — the app manifest ships a *Personal Tab* (“Moje
dokumenty”) that deep-links each user into their SharePoint document
library from inside Teams.

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
                4. classify content (AI)   │      │      │ 6. write audit log
                                           ▼      ▼      ▼
                              ┌────────────┐ ┌──────┐ ┌────────────┐
                              │ Claude     │ │ MS   │ │ App        │
                              │ (Anthropic)│ │Graph │ │ Insights   │
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

---

## 📘 Setup & deployment

- **[`docs/setup-guide.md`](./docs/setup-guide.md)** — end-to-end walkthrough:
  Entra ID app registrations, `.env` reference (every variable explained and
  *where to find it*), SharePoint `Sites.Selected` grant, Key Vault secrets,
  and Teams app sideload.
- [`docs/deployment.md`](./docs/deployment.md) — concise deploy commands.
- [`docs/local-development.md`](./docs/local-development.md) — local dev loop.
