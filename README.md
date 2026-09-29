# bcr-ledger-agent

A Microsoft Teams **AI Agent** that watches a chat for document attachments,
classifies each file by analysing its **content with Claude** (Anthropic API),
and uploads it to the correct folder in the user's client's SharePoint Online
space — all hosted on Microsoft Azure and written in Node.js + TypeScript.

> Example  
> A client, signed in with its `{NIP}@bcr-group.pl` account, sends the bot a KSeF purchase
> invoice in a 1:1 chat.  
> The bot replies with an adaptive card: the document, its category, and the folder
> `01_Faktury/02_Faktury_zakupu/2026/02/` in that client's "Dokumenty księgowe" channel.

**One deployment serves many clients.** Which client a document belongs to is decided
per upload from **the uploader's identity only**, looked up in a *Client Directory*
SharePoint list. The document's content chooses the folder, never the client. A Member
who cannot be tied to exactly one client goes to a staff-only quarantine; a guest is
refused, with nothing stored. See
[`docs/client-directory-admin-guide.md`](./docs/client-directory-admin-guide.md).

**A client is its `{NIP}@bcr-group.pl` account** (owner's decision, 28 September 2026): an
Entra Member that BCR creates at onboarding and hands to the client. It sends documents in a
1:1 chat with the bot, or posts them in its Team's "Dokumenty księgowe" channel, which
ingestion sweeps on a timer (Teams channel uploads do not reach bots: drag-drop bypasses Bot
Framework and `@mentions` carry no attachments, so the app is personal scope only). Guests
have no capability in the ledger: onboarding still invites the client's contact as a guest,
for the Team's files only. Clients find their files in their own Team, in the "Dokumenty
księgowe" channel. (The code for this decision is in the working tree, not yet deployed.)

> **September 2026:** incident `IR-2026-09` found documents filed outside their client's
> space. Phase 0 of v2 contains it; start with
> [`docs/operations/incident-2026-09.md`](./docs/operations/incident-2026-09.md) and
> [`docs/operations/human-steps.md`](./docs/operations/human-steps.md).

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
│   ├── document-ingestion/     # HTTP-triggered ingestion / SharePoint API
│   └── ledger-db/              # The document index: PostgreSQL, row-level security per client
├── infrastructure/             # Bicep IaC (Bot, Func, KV, AI, App Insights)
├── teams-app/                  # Teams app manifest + icons (sideload package)
├── docs/                       # Deployment, local-dev, sequence diagrams
└── .github/workflows/          # CI build + multi-stage deploy
```

This is a **Yarn 4 + workspaces** monorepo (npmClient compatible).
Each `packages/*` is independently buildable and deployable.

---

## Quick start (local)

Requirements: **Node 22 LTS**, **Yarn 4**, **Azure Functions Core Tools v4** and
**Azure CLI**.

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
yarn start:ingestion     # http://localhost:7071/api/ingest/batch
```

The Bot Framework Emulator cannot reach the bot: the bot accepts only Bot Framework channel
tokens (`bot/channelAuth.ts`), and the Emulator's token is refused before any turn runs.
[`docs/local-development.md`](./docs/local-development.md) shows what works locally: the bot's
`TestAdapter` tests for card work, and a direct call to the ingestion API.

---

## Scripts (root)

| Script | What it does |
|---|---|
| `yarn build` | Build every workspace |
| `yarn test` | Run Jest in every workspace |
| `yarn lint` | ESLint over the whole repo |
| `yarn start:bot` | Start the Teams-bot Function App locally |
| `yarn start:ingestion` | Start the document-ingestion Function App locally |
| `yarn deploy:dev` | **Refused.** "dev" is production, and a template deploy replaces every app setting. The template now records dev's settings (gate G1), but `infrastructure/deploy.sh` refuses dev until [Lifting gate G1](./docs/operations/human-steps.md#lifting-gate-g1) is done: a rehearsal on a throwaway resource group, a clean `check-app-settings --live`, a reviewed what-if. Deploy code only, as in [`human-steps.md`](./docs/operations/human-steps.md#phase-0). |
| `yarn deploy:prod` | Deploy infra + code to a **new** `prod` environment, with every app setting from `main.prod.parameters.json` ([`setup-guide.md` §3a](./docs/setup-guide.md#3a-fill-in-parameter-file)). |
| `yarn check:app-settings` | The app settings the code reads vs the ones Bicep sets (CI runs it). `node tools/check-app-settings.mjs --live -g <rg> -p <params>` also compares with the running apps, read-only; `--expect NAME[,NAME...]` names the changes a deploy is meant to make ([`deployment.md` §3a](./docs/deployment.md#3a-app-settings)). |

---

## Security model (TL;DR)

1. **Teams → Bot Function** is authenticated by the Bot Framework JWT (signed by
   `login.botframework.com`). Then a gate on every activity lets through only a 1:1 chat, from
   the BCR tenant, with a valid user id.
2. **Bot Function → Ingestion Function** uses **Entra ID client credentials** (MSAL). The bot
   gets a token for `api://<ingestion-app-id>/.default`. Ingestion checks the role, and that the
   caller's app id is the bot's (`BOT_CALLER_APP_IDS`).
3. **Ingestion Function → Microsoft Graph** uses the Function App's **system-assigned managed
   identity** with `Sites.Selected`. There is a per-site grant on every client site it files
   into, so it can write to all of them by design. Routing by identity only, and filing only
   for a row's own `{NIP}@` client account, is what keeps clients apart.
4. **Secrets** live in **Key Vault** and are referenced from Function App settings
   (`@Microsoft.KeyVault(SecretUri=...)`), never in source.
5. Uploads are logged to **Application Insights** as ids and codes (`document.filed`,
   `document.quarantined`), never file names or client names.

See [`docs/security.md`](./docs/security.md) for the full threat model.

---

## 📘 Setup & deployment

- **[`docs/setup-guide.md`](./docs/setup-guide.md)** — end-to-end walkthrough:
  Entra ID app registrations, `.env` reference (every variable explained and
  *where to find it*), SharePoint `Sites.Selected` grant, Key Vault secrets,
  and Teams app sideload.
- [`docs/deployment.md`](./docs/deployment.md) — concise deploy commands.
- [`docs/local-development.md`](./docs/local-development.md) — local dev loop.
- [`docs/operations/`](./docs/operations/) — the September 2026 incident, the ordered human
  steps for Phase 0, tenant hardening, and draft GDPR notices.
