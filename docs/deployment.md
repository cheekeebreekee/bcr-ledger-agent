# Deployment guide

This walks through getting the bcr-ledger-agent into a brand-new Azure
subscription and Microsoft 365 tenant.

> Total time budget: ~45 minutes the first time. A later code-only deploy takes ~3 minutes:
> `yarn build && yarn workspace @bcr/<pkg> package`, then `config-zip` (see
> [`PROJECT_OVERVIEW.md` → Build and deploy](../PROJECT_OVERVIEW.md#build-and-deploy)).

> ⚠️ **This guide is for a brand-new environment. Do not run it against "dev" today.** "dev"
> serves a real client, and `main.bicep` has drifted from the app settings running there.
> `yarn deploy:dev` deploys Bicep first, which replaces every setting and takes ingestion down.
> Until the Bicep drift fix, deploy code only, in the order given in
> [`operations/human-steps.md`](operations/human-steps.md#phase-0).

---

## 0. Prerequisites

- An **Azure subscription** with `Contributor` on the target resource group.
- A **Microsoft 365 tenant** where you can:
  - register two **App Registrations** in Entra ID,
  - grant admin consent on the **Microsoft Graph** permissions below,
  - create a **SharePoint site** to host the documents.
- Local tools:
  - Node 22 LTS (`nvm use 22`)
  - Yarn 4 (`corepack enable && corepack prepare yarn@4 --activate`)
  - Azure CLI (`az --version` ≥ 2.65)
  - Azure Functions Core Tools v4 (`func --version` ≥ 4.0.6280)
  - `jq`

---

## 1. Register App Registrations in Entra ID

You need **two** app registrations:

### 1a. Bot app

```bash
az ad app create --display-name "BCR Ledger Bot" \
  --sign-in-audience AzureADMyOrg \
  --query appId -o tsv
```

- Add a **client secret** (this becomes `MICROSOFT_APP_PASSWORD`).
- Under *API permissions* → *Add a permission* → *Microsoft Graph* → *Application*:
  - (none for now — the bot doesn't talk to Graph directly)

### 1b. Ingestion API app

```bash
az ad app create --display-name "BCR Ledger Ingestion API" \
  --sign-in-audience AzureADMyOrg \
  --identifier-uris "api://<paste-newly-created-appId>"
```

- Under *Expose an API*, add an **App role** called `Documents.Ingest`
  (Allowed member types: *Applications*).
- Add **no** Microsoft Graph permission here. Ingestion calls Graph as its Function App's
  managed identity, which does not exist until the deploy in §3; it gets its grants in §5.

### 1c. Allow the bot to call the ingestion API

Assign the `Documents.Ingest` **application** permission to the bot's service principal and
grant admin consent, as in [`setup-guide.md` §2c](setup-guide.md#2c-grant-the-bot-app-permission-to-call-the-ingestion-api).
*Authorized client applications* does not apply: it is for delegated scopes, and this flow is
app-only.

---

## 2. Fill in parameter files

Edit `infrastructure/main.dev.parameters.json` (and the prod copy) with:

- `botAppId`
- `ingestionAppId`
- `sharePointSiteHostname`
- `sharePointSitePath`

---

## 3. Deploy

```bash
az login
az account set --subscription <subscription-id>

cd bcr-ledger-agent
yarn install
yarn build
yarn deploy:dev
```

The script will:
1. Create the resource group if missing
2. Deploy `infrastructure/main.bicep`
3. Build all packages
4. Zip and deploy both Function Apps

---

## 4. Seed secrets in Key Vault

```bash
KV=$(az deployment group show -g rg-bcr-ledger-dev -n bcr-ledger-dev-... \
  --query "properties.outputs.keyVaultName.value" -o tsv)

az keyvault secret set --vault-name "$KV" --name bot-app-password \
  --value "<paste-the-bot-client-secret-here>"

# Only if Claude classification is enabled (enableAnthropic = true):
az keyvault secret set --vault-name "$KV" --name anthropic-api-key \
  --value "<paste-the-anthropic-api-key-here>"   # sk-ant-…
```

Then restart both Function Apps so the new Key Vault references are picked up:

```bash
az functionapp restart -g rg-bcr-ledger-dev -n func-bcr-bot-dev-...
az functionapp restart -g rg-bcr-ledger-dev -n func-bcr-ingest-dev-...
```

---

## 5. Grant SharePoint permissions to the ingestion managed identity

Ingestion reads and writes SharePoint as the ingestion Function App's **system-assigned managed
identity**, which the deploy in §3 created. Every grant goes to that identity's app id
(`INGEST_MI_APPID`), **never** to the Ingestion API app registration: ingestion never
authenticates as the registration, so a grant to it does nothing.

The procedure is in [`setup-guide.md` §5](setup-guide.md#5-grant-sharepoint-site-permission-sitesselected):
derive `INGEST_MI_APPID` from the Function App, give the identity the Graph app role
`Sites.Selected`, then `write` on the quarantine site, `read` on the site that holds the Client
Directory, and `write` on each client site as it is bound. `Sites.Selected` is an allow-list of
per-site grants, not a single-site scope (see `security.md`, T3).

---

## 6. Sideload the Teams app

See [`teams-app/README.md`](../teams-app/README.md).

---

## 7. Smoke test

```bash
# Health endpoint (no auth)
curl https://func-bcr-ingest-dev-XXXX.azurewebsites.net/api/health

# Bot messaging endpoint should return 405 to a GET (proves it's wired up)
curl -i https://func-bcr-bot-dev-XXXX.azurewebsites.net/api/messages
```

Then, as a test guest bound to a test client, send a synthetic PDF to the bot in a 1:1 chat.
The card shows the document, its category (**Kategoria**) and the folder, with an "Otwórz"
link into that client's space. An uploader who is not bound to a client instead gets "Dokument
przekazano do weryfikacji przez zespół BCR.", with no link. Never smoke-test with a real client
document.
