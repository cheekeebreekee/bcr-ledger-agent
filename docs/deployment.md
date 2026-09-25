# Deployment guide

This walks through getting the bcr-ledger-agent into a brand-new Azure
subscription and Microsoft 365 tenant.

> Total time budget: ~45 minutes the first time. A later code-only deploy takes ~3 minutes:
> `yarn workspace @bcr/<pkg> package`, then `config-zip` (see
> [`PROJECT_OVERVIEW.md` → Build and deploy](../PROJECT_OVERVIEW.md#build-and-deploy)).

> ⚠️ **This guide is for a brand-new environment. Never run it against "dev".** "dev" is
> production: it serves a real client, and `main.bicep` has drifted from the app settings running
> there. A Bicep deploy replaces every setting and takes ingestion down, so
> `infrastructure/deploy.sh` refuses `dev` in any spelling, and the `rg-bcr-ledger-dev` resource
> group. Until the Bicep drift fix (gate G1), "dev" gets code only, in the order given in
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

## 2. Fill in the parameter file

The new environment is named `<env>` below (for example `qa`, or `prod`). Fill in
`infrastructure/main.<env>.parameters.json`; for any name but `prod`, copy it from
`main.prod.parameters.json` first. Never edit `main.dev.parameters.json`.

- `botAppId`
- `ingestionAppId`
- `sharePointSiteHostname` and `sharePointSitePath`: the template still requires them, but they
  only feed settings nothing reads any more, so any placeholder will do
  ([`setup-guide.md` §3a](setup-guide.md#3a-fill-in-parameter-file)).

---

## 3. Deploy

```bash
az login
az account set --subscription <subscription-id>

cd bcr-ledger-agent
corepack enable
corepack yarn deploy:prod                # a new prod environment
./infrastructure/deploy.sh <env>         # any other new environment: the same script
```

The script:
1. creates the resource group `rg-bcr-ledger-<env>` if it is missing;
2. deploys `infrastructure/main.bicep`;
3. builds all packages, and packages each Function App afresh (see
   [`PROJECT_OVERVIEW.md` → Build and deploy](../PROJECT_OVERVIEW.md#build-and-deploy));
4. zip-deploys both Function Apps.

### 3a. Add the settings the template lacks

`main.bicep` does not yet set the Phase-0 ingestion settings (`BOT_CALLER_APP_IDS`,
`CLIENT_DIRECTORY_*`, `QUARANTINE_*`, `FORBIDDEN_TARGET_SITE_PATHS`), so after the deploy
ingestion refuses to start, naming the first one missing. Add them once, with
`az functionapp config appsettings set … -o none`, exactly as in
[`setup-guide.md` §3d](setup-guide.md#3d-add-the-phase-0-settings-the-template-lacks). Never add
them by re-running a Bicep deploy: until the drift fix, the template does not carry them.

---

## 4. Seed secrets in Key Vault

```bash
KV=$(az keyvault list -g rg-bcr-ledger-<env> --query "[].name" -o tsv)

az keyvault secret set --vault-name "$KV" --name bot-app-password \
  --value "<paste-the-bot-client-secret-here>"

# Only if Claude classification is enabled (enableAnthropic = true):
az keyvault secret set --vault-name "$KV" --name anthropic-api-key \
  --value "<paste-the-anthropic-api-key-here>"   # sk-ant-…
```

Then restart both Function Apps so the new Key Vault references are picked up:

```bash
az functionapp restart -g rg-bcr-ledger-<env> -n func-bcr-bot-<env>-...
az functionapp restart -g rg-bcr-ledger-<env> -n func-bcr-ingest-<env>-...
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

Build the package from a staging copy of the manifest, with the placeholders replaced and
checked, as in [`setup-guide.md` §7](setup-guide.md#7-register-the-bot-in-microsoft-teams). See also
[`teams-app/README.md`](../teams-app/README.md).

---

## 7. Smoke test

```bash
# Health endpoint (no auth)
curl https://func-bcr-ingest-<env>-XXXX.azurewebsites.net/api/health

# Bot messaging endpoint should return 405 to a GET (proves it's wired up)
curl -i https://func-bcr-bot-<env>-XXXX.azurewebsites.net/api/messages
```

Then, as a test guest bound to a test client, send a synthetic PDF to the bot in a 1:1 chat.
The card shows the document, its category (**Kategoria**) and the folder, with an "Otwórz"
link into that client's space. An uploader who is not bound to a client instead gets "Dokument
przekazano do weryfikacji przez zespół BCR.", with no link. Never smoke-test with a real client
document.
