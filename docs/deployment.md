# Deployment guide

This walks through getting the bcr-ledger-agent into a brand-new Azure
subscription and Microsoft 365 tenant.

> Total time budget: ~45 minutes the first time, ~3 minutes for subsequent
> code-only deploys via `yarn deploy:dev`.

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
- Under *API permissions* → *Add a permission* → *Microsoft Graph* → *Application*:
  - `Sites.Selected`
- Click *Grant admin consent for <tenant>*.

### 1c. Allow the bot to call the ingestion API

In the *Ingestion API* app → *Expose an API* → *Authorized client
applications*, add the **Bot app's client id** and check `Documents.Ingest`.

---

## 2. Grant SharePoint site permission

`Sites.Selected` lets the ingestion API write only to the **one** site you
explicitly authorise. Run this from a context with `Sites.FullControl.All`
(usually a Global Admin token):

```bash
SITE_ID=$(az rest --method get \
  --uri "https://graph.microsoft.com/v1.0/sites/contoso.sharepoint.com:/sites/BCR-Ledger" \
  --query id -o tsv)

az rest --method post \
  --uri "https://graph.microsoft.com/v1.0/sites/$SITE_ID/permissions" \
  --body '{
    "roles": ["write"],
    "grantedToIdentities": [{
      "application": {
        "id": "<INGESTION_APP_ID>",
        "displayName": "BCR Ledger Ingestion API"
      }
    }]
  }'
```

---

## 3. Fill in parameter files

Edit `infrastructure/main.dev.parameters.json` (and the prod copy) with:

- `botAppId`
- `ingestionAppId`
- `sharePointSiteHostname`
- `sharePointSitePath`

---

## 4. Deploy

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

## 5. Seed secrets in Key Vault

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

Then drag `Invoice_03_2026.pdf` into the chat. You should see:

> ✅ Filed **Invoice_03_2026.pdf**  
> Type: Invoice — Confidence: 95% — Folder: Invoices/2026/03  
> [Open in SharePoint]
