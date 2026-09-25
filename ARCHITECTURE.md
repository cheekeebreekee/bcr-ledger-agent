# Architecture

## 1. Goals & non-goals

**Goals**

- Conversational document-ingestion experience in Microsoft Teams.
- Content-based folder routing in SharePoint Online: each document is
  classified by **Claude** (Anthropic API), with a deterministic fallback to
  a manual-review folder when confidence is low.
- Fully managed, serverless Azure footprint — no VMs, no Kubernetes.
- Strict separation of concerns: the **bot** never touches SharePoint or
  the classifier directly; it only forwards work to an authenticated
  internal API.
- Zero secrets in source. Everything is in Key Vault and referenced through
  Function App settings.

**Non-goals**

- Building a generic chatbot framework. This agent has exactly one skill:
  *“take this file and file it”*.
- Long-running workflows. If an upload takes > ~30s the bot will respond
  with a *“still working”* message and move the work to a queue (future).

---

## 2. Component overview

| Component | Tech | Hosting |
|---|---|---|
| Teams Bot | Bot Framework SDK v4 (JS) | Azure Functions (Node 22, HTTP trigger) |
| Document Ingestion API | TypeScript + Azure Functions v4 programming model | Azure Functions (Node 22, HTTP trigger) |
| Shared library | TypeScript | Published intra-repo via Yarn workspaces |
| Channel registration | Azure Bot Service | Microsoft.BotService |
| Secrets | Azure Key Vault | Microsoft.KeyVault |
| Document classification | Claude (Anthropic Messages API) | api.anthropic.com (external) |
| File store | SharePoint Online (Microsoft Graph) | Microsoft 365 tenant |
| Telemetry | Application Insights | Microsoft.Insights |
| Infrastructure as code | Bicep | `infrastructure/` |

---

## 3. Sequence — happy path

```mermaid
sequenceDiagram
  actor U as User (Teams)
  participant TC as Teams client
  participant BS as Azure Bot Service
  participant FB as Bot Function App
  participant FI as Ingestion Function App
  participant CD as Client Directory (SharePoint list)
  participant CL as Claude (Anthropic API)
  participant GR as Microsoft Graph
  participant SP as SharePoint Online

  U->>TC: DMs bot with Invoice_03_2026.pdf + Receipt_2026-03.png
  TC->>BS: POST activity (message + attachments)
  BS->>FB: POST /api/messages (JWT signed by BF)
  FB->>FB: ActivityHandler validates JWT
  FB->>BS: GET each attachment via attachment service (in parallel)
  BS-->>FB: file bytes
  FB->>FI: POST /api/ingest/batch (Bearer token, { documents[], source })
  FI->>FI: Validate AAD token (audience = ingestion app)
  FI->>CD: getSnapshot() — 5min cached, byNip / byUserAadObjectId maps
  CD-->>FI: entries + lookup maps
  FI->>FI: resolve(source.userAadObjectId) → pre-resolved client (or fallback)
  loop for each document
    FI->>CL: messages.create(content + tool schema, primed with resolved client identity)
    CL-->>FI: category + year/month + confidence + reasoning + parties[]
    FI->>FI: resolvePostClassification(preResolved, classified)
    Note over FI: promotes fallback to Directory client on party NIP match;<br/>flips faktury_sprzedazy ⇄ faktury_zakupu on client role
    alt final client + folder path known
      FI->>GR: ensureFolder + PUT /content (via per-client SharePointService)
      GR->>SP: write file into resolved client's site
      SP-->>GR: 201 Created (driveItem)
      GR-->>FI: driveItem JSON
    else confidence too low or category unknown
      FI->>GR: PUT into 98_Nieposortowane/<YYYY>/<MM>/ on the resolved (or fallback) site
    end
    Note over FI: per-document failure → `rejected` row, batch continues
  end
  FI-->>FB: 200 { status: 'completed', results[] }
  FB-->>BS: Activity (one adaptive card with a summary Table)
  BS-->>TC: Card
  TC-->>U: 📊 Summary table (per doc: folder, confidence, reasoning)
```

> **Single-document route.** The original one-file-at-a-time endpoint
> `POST /api/ingest` (returning `{ status: 'uploaded', result }`) is retained
> for backwards compatibility and programmatic callers. The Teams bot always
> uses the batch route so the user gets one consolidated response.

> **Bot delivery model.** Only 1:1 DMs with the bot reliably deliver file
> attachments through Bot Framework. Files posted into Teams channels
> either bypass the bot entirely (drag-drop) or arrive without their
> content (`@mention` messages carry only the mention HTML). The bot's
> app manifest keeps `"scopes": ["personal", "team", "groupchat"]` for
> completeness but only the `personal` scope is functional today.


---

## 4. Classification pipeline

The ingestion function pipes every file through an ordered list of
`Classifier` strategies. The first one that returns a `match` wins; the
fallback always succeeds last.

1. **`ClaudeClassifier`** — see
   [`packages/document-ingestion/src/services/claudeClassifier.ts`](./packages/document-ingestion/src/services/claudeClassifier.ts).  
   Sends the document **content** (PDF → `document` block, images → `image`
   block, text → `text` block) to the Anthropic Messages API together with a
   forced tool whose `input_schema` is generated from the folder taxonomy
   ([`folderTaxonomy.ts`](./packages/shared/src/parsers/folderTaxonomy.ts)).
   The model returns a `category`, optional `year`/`month`, a `confidence`
   score, and an optional `parties[]` array (seller/buyer/issuer/recipient/
   unknown, each with NIP + company name + person name). The category maps
   to a literal SharePoint path via `buildFolderPath`; `dated` categories get
   a nested `YYYY/MM` leaf.

   Client identity is passed **per call** via `ClassifierContext.client`
   (populated from the pre-resolved routing decision). When present, the
   model is primed with the client's NIP + name and can decide invoice
   direction (sales vs purchase) directly. When absent (fallback routing),
   the model extracts parties without deciding direction and the
   `ClientResolver` derives direction post-classification (see §4.2).

   The classifier **never throws** — unsupported content type, oversized
   files (`ANTHROPIC_MAX_CONTENT_BYTES`), confidence below
   `ANTHROPIC_CONFIDENCE_THRESHOLD`, unknown categories, and API errors all
   return `null` so the fallback runs. Disabled when `ANTHROPIC_ENABLED=false`
   or no API key is configured.
2. **`FallbackClassifier`** — `98_Nieposortowane/<YYYY>/<MM>/`. Always
   succeeds so the user never sees a *“nowhere to put this”* error; the file
   is routed to manual review.

Adding or changing a category means editing the single `categoryCatalog` in
[`folderTaxonomy.ts`](./packages/shared/src/parsers/folderTaxonomy.ts) plus a
unit test — the Claude prompt/tool schema and the fallback both derive from it.

### 4.1 Batch ingestion

When a Teams message carries **more than one** attachment, the bot does **not**
file them one-by-one. Instead
[`LedgerBot.handleMessage`](./packages/teams-bot/src/bot/ledgerBot.ts)
downloads every attachment (in parallel) and forwards the whole set in a single
call to `POST /api/ingest/batch`
([`handleIngestBatch`](./packages/document-ingestion/src/functions/ingestDocument.ts)).

- **Request:** `{ documents: IngestionDocument[], source }` — one shared
  `source` block for the whole activity. Validated by
  `validateBatchIngestionPayload` (max **25** documents, aggregate decoded
  size ≤ **100 MiB**).
- **Processing:** the ingestion function classifies and uploads each document
  through the exact same pipeline as the single-file route. A failure on one
  document (download error, oversized file, Graph/SharePoint error, …) is
  captured as a `rejected` item **without aborting the batch** — every other
  document is still filed.
- **Response:** `{ status: 'completed', results: IngestionBatchItemResult[] }`,
  where each item is either `uploaded` (with the drive item, folder path, and
  the classifier's Polish `reasoning`) or `rejected` (with an error message).
- **Presentation:** the bot renders **one** adaptive card containing a single
  `Table` (`buildBatchResultCard` in
  [`responseBuilder.ts`](./packages/teams-bot/src/bot/responseBuilder.ts)) with
  a row per document — **Dokument · Folder · Pewność · Uzasadnienie** — plus an
  `Action.OpenUrl` for each successfully uploaded file. This is the *“one table
  that explains why each document was classified where”* deliverable.

The relevant shared contracts live in
[`packages/shared/src/types/bot.ts`](./packages/shared/src/types/bot.ts):
`IngestionSource`, `IngestionDocument`, `IngestionUploadResult`,
`IngestionBatchRequestPayload`, `IngestionBatchItemResult`, and
`IngestionBatchResponsePayload`.

### 4.2 Multi-tenant client routing (implemented)

A single deployment routes documents to many clients' SharePoint spaces.
The resolver runs in **two phases** — once before classification (envelope
signals only) and once after (content signals from Claude's `parties[]`).

#### Client Directory

A SharePoint list on the BCR Group site is the single source of truth.
One row per client, columns: `Title`, `ClientId`, `NIP`,
`CompanyNameAliases` (one alias per line), `PersonNames` (one name per
line), `UserAadObjectIds` (one AAD id per line), `SiteHostname`,
`SitePath`, `DriveName`, `RootFolder`, `IsAdmin`, `Status`. The list id
and site id are configured on the ingest function via
`CLIENT_DIRECTORY_LIST_ID` and `CLIENT_DIRECTORY_SITE_ID`. See
[`docs/client-directory-admin-guide.md`](./docs/client-directory-admin-guide.md)
for onboarding runbooks.

[`ClientDirectoryReader`](./packages/document-ingestion/src/services/clientDirectoryReader.ts)
fetches the list at cold start (following `@odata.nextLink` pagination),
caches the parsed snapshot in memory for `CLIENT_DIRECTORY_CACHE_TTL_MS`
(default 5 min), and rebuilds lookup maps (`byNip`, `byCompanyAlias`,
`byPersonName`, `byUserAadObjectId`) on every refresh. Duplicate keys
across clients are fail-closed: if the same NIP or AAD id shows up on
two rows, the reader drops the ambiguous key from the map and logs a
warning so an unresolved document falls back rather than mis-routes.

#### Phase 1 — pre-classification resolution

[`ClientResolver.resolve(source)`](./packages/document-ingestion/src/services/clientResolver.ts)
reads `source.userAadObjectId` (from `activity.from.aadObjectId`, captured
by the bot on every turn) and looks it up in `byUserAadObjectId`. If the
row is a non-admin client, that's the destination. If it's an admin row
(or no match), the resolver returns the configured fallback bucket — but
doesn't yet commit; content-based routing may still promote it in phase 2.

Channel-based routing was designed and briefly deployed but was removed
after live testing. Teams doesn't reliably deliver channel file uploads
to bots — drag-drop bypasses Bot Framework entirely, and `@mention`
messages only carry the mention HTML in `activity.attachments`. The bot
is DM-only in practice, so user-identity routing is the sole primary
path. `source.teamsChannelId` is still captured for observability but
nothing keys on it.

#### Phase 2 — post-classification refinement

Once Claude has returned a `Classification` (with `parties[]` populated
when the document is an invoice/contract),
[`ClientResolver.resolvePostClassification(preResolved, classification)`](./packages/document-ingestion/src/services/clientResolver.ts)
does two things:

1. **Fallback → client promotion.** If pre-resolution was `fallback` and
   exactly one `parties[].nip` matches a Directory client (via
   `snapshot.byNip`), the routing is retroactively promoted to that
   client. Ambiguous cases (multiple Directory clients present in the
   same document, e.g. an inter-client invoice) keep the fallback —
   fail-closed to avoid mis-filing.
2. **Invoice direction override.** If the resolved client's NIP appears
   in `parties[]` with `role: 'seller'` or `role: 'buyer'`, and the
   current category is `faktury_sprzedazy`, `faktury_zakupu`, or
   `nieposortowane`, `applyInvoiceDirection` rebuilds the folder path
   with the correct direction. This is the safety net for cases where
   pre-resolution routed to fallback (no client identity was primed
   into Claude), and it corrects Claude when it guesses direction wrong.

#### Per-client SharePoint clients

[`SharePointServiceFactory`](./packages/document-ingestion/src/services/sharePointServiceFactory.ts)
memoises one `SharePointService` per unique target
(`{hostname, sitePath, driveName, rootFolder}`) so cold-start site/drive
resolution is amortised across many uploads. New client rows automatically
spin up a new service on first use.

#### Fallback bucket

When no user or content routing resolves, uploads land in the fallback
target defined by `FALLBACK_SITE_HOSTNAME`, `FALLBACK_SITE_PATH`,
`FALLBACK_DRIVE_NAME`, `FALLBACK_ROOT_FOLDER`, `FALLBACK_CLIENT_ID`. Dev
fallback is the BCR Group site's default `Dokumenty` library.

### 4.3 Personal Tab — “Moje dokumenty”

A Teams personal tab that gives every user a one-click deep-link to their
client's SharePoint document library from inside Teams.

- **Manifest** — `teams-app/manifest.json` adds a `staticTabs` entry with
  `contentUrl` templated on `{userObjectId}` and `{theme}` (both
  substituted by Teams at tab-load time).
- **Content endpoint** — `GET /api/mydocs?userObjectId={id}&theme={theme}`
  on the bot function
  ([`packages/teams-bot/src/functions/mydocs.ts`](./packages/teams-bot/src/functions/mydocs.ts)).
  Anonymous auth (called by the Teams iframe); serves a small themed HTML
  page with the resolved client's name and an "Otwórz w SharePoint"
  button. The button uses the Teams JS SDK's `microsoftTeams.app.openLink`
  (falls back to `window.open`). SharePoint refuses to be iframed
  cross-origin, so the tab deep-links out instead of embedding.
- **Lookup endpoint** — `GET /api/user-target?userAadObjectId={id}` on the
  ingest function
  ([`packages/document-ingestion/src/functions/userTarget.ts`](./packages/document-ingestion/src/functions/userTarget.ts)).
  Same JWT auth as `/api/ingest` (`Documents.Ingest` role). Reuses the
  same `ClientResolver` as the ingest pipeline so “where the tab sends
  the user” always matches “where the bot files their documents”. Returns
  `{clientId, title, source, siteHostname, sitePath, driveName,
  sharepointWebUrl}`. The web URL is constructed heuristically
  (`Dokumenty` for Polish tenants, `Shared Documents` for English).
- **Auth trail** — Teams tab → anonymous GET to bot's `/api/mydocs` →
  bot calls ingest's `/api/user-target` with its existing MSAL
  client-credentials JWT (same one used for `/api/ingest`).

---

## 5. Auth model

### 5.1 Teams → Bot

Standard Bot Framework JWT. The SDK middleware in
`@bcr/teams-bot` validates it using `MicrosoftAppCredentials` configured
with the Bot’s `MicrosoftAppId`, `MicrosoftAppPassword` (or, preferred,
a managed-identity federated credential), and `MicrosoftAppTenantId`.

### 5.2 Bot → Ingestion API

Client credentials via MSAL Node:

```
POST https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token
  client_id     = <bot-app-id>
  client_secret = <bot-secret>            (Key Vault)
  scope         = api://<ingestion-app-id>/.default
  grant_type    = client_credentials
```

The ingestion function validates the JWT using `jose` and checks:
- `iss` matches the expected tenant authority
- `aud` matches its own App ID URI
- `roles` contains `Documents.Ingest`

### 5.3 Ingestion → Microsoft Graph

The Function App uses its **system-assigned managed identity**. A
federated credential on the Graph App Registration trusts the managed
identity, so we never store a Graph client secret.

Required Graph permissions (application):
- `Sites.Selected` — granted only on the target SharePoint site via
  `POST /sites/{id}/permissions` during deployment.
- `Files.ReadWrite.All` — only if you cannot use `Sites.Selected`.

---

## 6. Failure handling

| Failure | Behaviour |
|---|---|
| Claude is off, low confidence, or API error | Upload to `98_Nieposortowane/<YYYY>/<MM>/` for manual review. |
| SharePoint 409 (file exists) | Append `_n` suffix and retry once; report the final filename. |
| Graph 5xx | Exponential back-off with jitter via `p-retry` (max 3 attempts), then surface error card. |
| Token expired | MSAL token cache auto-refreshes; ingestion uses `getToken` lazily per request. |
| File > 4 MB | Switch to Graph **upload session** (`createUploadSession`) and chunk at 320 KiB × N. |
| Antivirus block (Graph 423) | Surface explicit message; do not retry. |

Every error is logged with the Teams `activityId` and `conversationId`
as custom dimensions on the Application Insights `requests` table,
so triage is one Kusto query away:

```kusto
requests
| where customDimensions["activityId"] == "<id>"
| project timestamp, name, resultCode, customDimensions
```

---

## 7. Deployment topology

A single Azure resource group per environment:

```
rg-bcr-ledger-<env>
├── stbcrledger<env>          (Storage – Functions runtime + uploads queue)
├── plan-bcr-ledger-<env>     (Linux consumption plan, Node 22)
├── func-bcr-bot-<env>
├── func-bcr-ingest-<env>
├── bot-bcr-ledger-<env>      (Azure Bot, Teams channel enabled)
├── kv-bcr-ledger-<env>       (Key Vault, RBAC mode)
├── ai-bcr-ledger-<env>       (Document Intelligence – S0)
├── appi-bcr-ledger-<env>     (Application Insights)
└── log-bcr-ledger-<env>      (Log Analytics workspace)
```

All wired up declaratively in [`infrastructure/main.bicep`](./infrastructure/main.bicep).
