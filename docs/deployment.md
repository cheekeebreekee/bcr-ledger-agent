# Deployment guide

This walks through getting the bcr-ledger-agent into a brand-new Azure
subscription and Microsoft 365 tenant.

> Total time budget: ~45 minutes the first time. A later code-only deploy takes ~3 minutes:
> `yarn workspace @bcr/<pkg> package`, then `config-zip` (see
> [`PROJECT_OVERVIEW.md` → Build and deploy](../PROJECT_OVERVIEW.md#build-and-deploy)).

> ⚠️ **This guide is for a brand-new environment. Never run it against "dev".** "dev" is
> production: it serves a real client, and a Bicep deploy replaces every app setting.
> `main.bicep` with `main.dev.parameters.json` now records the settings dev runs with (gate G1),
> but `infrastructure/deploy.sh` still refuses `dev` in any spelling, and the
> `rg-bcr-ledger-dev` resource group, until a person has reviewed a what-if and a clean
> `node tools/check-app-settings.mjs --live` against it and lifted the refusal. Until then "dev"
> gets code only, in the order given in
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
`main.prod.parameters.json` first. Never reuse `main.dev.parameters.json`: it records what
production ("dev") runs with.

- `botAppId`, `botCallerAppIds` (the bot's app id again) and `ingestionAppId`
- `clientDirectorySiteId` and `clientDirectoryListId`, `quarantineSiteHostname`,
  `quarantineSitePath`, `quarantineDriveName`, and `forbiddenTargetSitePaths`: the Phase-0
  ingestion settings, described in
  [`setup-guide.md` §3a](setup-guide.md#3a-fill-in-parameter-file). Each parameter becomes one
  app setting, and ingestion refuses to start on a missing or malformed one.

Every app setting the apps run with comes from this file: a later deploy replaces them all, so
a setting changed by hand in Azure must be changed here too.

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

### 3a. App settings

The template sets every app setting from the parameter file, the Phase-0 ingestion settings
included, so there is nothing to add by hand. A deploy replaces them all: a setting changed only
in Azure is reverted by the next deploy, and what-if cannot show it (it reads no app-setting
values). So before any deploy to an environment that already runs, `deploy.sh` and the Deploy
workflow compare the template's settings with the running apps
(`infrastructure/app-settings-gate.sh`, which runs `node tools/check-app-settings.mjs --live`,
read-only) and stop on any difference they were not told to expect. They skip the comparison
only for a resource group that does not exist yet or holds no Function Apps; an `az` failure
stops the deploy.

To change a setting in an environment that runs:

1. **Change the parameter file**, `infrastructure/main.<env>.parameters.json`. A new setting
   also needs its parameter and its line in `main.bicep`, and `corepack yarn check:app-settings`
   must pass.
2. **Compare, naming what you changed** with `--expect` (comma-separated or repeated; one name
   covers both apps):

   ```bash
   node tools/check-app-settings.mjs --live -g rg-bcr-ledger-<env> \
     -p infrastructure/main.<env>.parameters.json --expect LOG_LEVEL,INBOX_SWEEP_MODE
   ```

   A difference in a named setting prints as a `note`, with the running and the new value;
   any other difference is `drift` and fails. A named setting with no difference is a warning:
   check that you edited the right file.
3. **Review.** Every `note` is a change you meant, to the value you meant, and there is no
   `drift`. A `drift` line is a setting someone changed in Azure and did not record: record it
   in the parameter file, or, if the deploy should revert it, add it to the list and review
   again. Values only the deployment knows (the storage and App Insights connection strings,
   `INGESTION_BASE_URL`) are not compared, and Key Vault references are compared by secret
   name only.
4. **Deploy with the same names:**
   `EXPECTED_SETTING_CHANGES=LOG_LEVEL,INBOX_SWEEP_MODE ./infrastructure/deploy.sh <env>`, or the
   Deploy workflow with the input `expected_setting_changes` set to the same list. The deploy
   runs the comparison again and stops on any difference not in the list. With no list, it
   stops on every difference.

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
