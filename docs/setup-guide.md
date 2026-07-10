# Setup Guide — `bcr-ledger-agent` in Microsoft Teams

A step-by-step walkthrough that takes you from an empty Azure subscription
and Microsoft 365 tenant to a working bot in Teams. Every `.env` /
`local.settings.json` variable in this repo is documented below with the
exact UI path (and CLI equivalent) where you can find or generate it.

> Time budget: ~60 min the first time. ~3 min for code-only redeploys after
> that.

---

## 0. Prerequisites

| Tool | Version | Install |
|---|---|---|
| **Node.js** | 22 LTS | `nvm install 22 && nvm use 22` |
| **Yarn 4 via Corepack** | 4.3.1 | `corepack enable && corepack prepare yarn@4.3.1 --activate` |
| **Azure CLI** | ≥ 2.65 | <https://learn.microsoft.com/cli/azure/install-azure-cli> |
| **Azure Functions Core Tools** | bundled per workspace | installed by `yarn install` |
| **Bot Framework Emulator** *(optional, for local testing)* | latest | <https://github.com/microsoft/BotFramework-Emulator/releases> |
| **`jq`** | any | `brew install jq` |

You will also need:

- An **Azure subscription** with `Contributor` on a resource group.
- A **Microsoft 365 tenant** where you can:
  - register App Registrations in Entra ID,
  - grant admin consent on Microsoft Graph permissions,
  - create / own a SharePoint site,
  - upload custom Teams apps (or get an admin to do it for you).

---

## 1. Glossary of identifiers you’ll collect

Throughout this guide you’ll write down these IDs once and then paste them
into multiple places. Keep a scratchpad open:

| Label | Looks like | Where it comes from |
|---|---|---|
| **Tenant ID** | UUID | Entra ID → *Overview* |
| **Subscription ID** | UUID | Azure portal → *Subscriptions* |
| **Bot App ID** | UUID | App registration (the “bot identity”) |
| **Bot App Password** | long string | Client secret on the Bot app reg |
| **Ingestion App ID** | UUID | App registration (the “API identity”) |
| **Ingestion App ID URI** | `api://<uuid>` | *Expose an API* blade on Ingestion app |
| **SharePoint Site ID** | comma-tuple | `GET /sites/{hostname}:/sites/{path}` |
| **App Insights Connection String** | `InstrumentationKey=…;IngestionEndpoint=…;` | App Insights → *Configure → Properties* |
| **Anthropic API Key** | `sk-ant-…` | [Anthropic Console](https://console.anthropic.com/) → *API Keys* |

---

## 2. Create the two Microsoft Entra ID App Registrations

The architecture uses **two** app registrations:

1. **Bot app reg** — identity of the bot to Microsoft Teams / Bot Framework.
2. **Ingestion API app reg** — identity that protects the document
   ingestion HTTP API. The bot acquires a token for this app and presents
   it on every `POST /api/ingest` call.

### 2a. Bot app registration

Portal: **Entra ID → App registrations → + New registration**

- **Name:** `BCR Ledger Bot`
- **Supported account types:** *Accounts in this organizational directory only*
- **Redirect URI:** *(leave blank)*

After creation, on **Overview**:

| Copy this value | Use as |
|---|---|
| *Application (client) ID* | `MICROSOFT_APP_ID` |
| *Directory (tenant) ID* | `MICROSOFT_APP_TENANT_ID` (and `AZURE_TENANT_ID`) |

Then under **Certificates & secrets → + New client secret**:

- **Description:** `bot-app-password-2026`
- **Expires:** 24 months (set a calendar reminder!)

| Copy this value | Use as |
|---|---|
| *Value* (shown only once!) | `MICROSOFT_APP_PASSWORD` |

CLI shortcut:

```bash
az ad app create --display-name "BCR Ledger Bot" \
  --sign-in-audience AzureADMyOrg \
  --query appId -o tsv
```

### 2b. Ingestion API app registration

Portal: **Entra ID → App registrations → + New registration**

- **Name:** `BCR Ledger Ingestion API`
- **Supported account types:** *Accounts in this organizational directory only*
- **Redirect URI:** *(leave blank)*

On the new registration:

1. **Expose an API → Set** the Application ID URI to
   `api://<INGESTION_APP_ID>`. Accept the default value.
2. **Expose an API → + Add an app role:**
   - **Display name:** `Documents.Ingest`
   - **Allowed member types:** *Applications*
   - **Value:** `Documents.Ingest`
   - **Description:** *Allows the caller to ingest documents into SharePoint.*
3. **API permissions → + Add a permission → Microsoft Graph → Application
   permissions:**
   - `Sites.Selected` (we’ll scope this to a single SharePoint site in
     step 5)
4. Click **Grant admin consent for <your tenant>**.

| Copy this value | Use as |
|---|---|
| *Application (client) ID* | `INGESTION_APP_ID` |
| *Application ID URI* | `INGESTION_SCOPE` = `api://<INGESTION_APP_ID>/.default` |
| (same) | `EXPECTED_AUDIENCE` = `api://<INGESTION_APP_ID>` |

#### ✅ Preflight checklist — verify §2b before moving on

Before touching the Bot app reg in §2c, run **one** command against the
*Ingestion API* app reg to confirm the two things that §2c will look up
(the Application ID URI and the `Documents.Ingest` app role). Missing
either is the **#1 reason** *"+ Add a permission → My APIs"* shows
**No results** or your API does not appear in the list.

```bash
# Make sure you're signed in to the right tenant first
az login --tenant "$AZURE_TENANT_ID"           # only needed once per shell
az account set --subscription "$AZURE_SUBSCRIPTION_ID"

INGESTION_APP_ID=<paste the Application (client) ID from §2b>

az ad app show --id "$INGESTION_APP_ID" \
  --query "{uris:identifierUris, roles:appRoles[].value}"
```

**Expected output** (both arrays must be non-empty):

```json
{
  "roles": ["Documents.Ingest"],
  "uris": ["api://b8b90018-9af0-4d7a-ada2-71559952ebbe"]
}
```

| If you see… | Meaning | Fix |
|---|---|---|
| `"uris": []` or `null` | **Application ID URI is missing** → API will not show under *My APIs* | Portal: *Expose an API → Set* → accept `api://<INGESTION_APP_ID>` <br>CLI: `az ad app update --id "$INGESTION_APP_ID" --identifier-uris "api://$INGESTION_APP_ID"` |
| `"roles": []` or `null` | **No app role defined** → consent screen will be empty | Re-do §2b step 2 (*Expose an API → + Add an app role*, `Allowed member types = Applications`, `Value = Documents.Ingest`) |
| `ResourceNotFoundError` / `Application … was not found` | Wrong tenant, or wrong client ID | `az account show --query tenantId` must equal `AZURE_TENANT_ID`. Re-login with `az login --tenant "$AZURE_TENANT_ID"` |
| `Please run 'az login'` | Not signed in | Run the `az login` line above |
| Both arrays populated ✅ | You’re good — proceed to §2c | — |

> ⏱️ Entra ID can take **30–60 seconds** to propagate a freshly added
> app role / URI to the *Add a permission* picker. If the CLI says
> everything is correct but the portal still shows *No results*, wait a
> minute and hit **Refresh** in the *My APIs* tab.

### 2c. Grant the Bot app permission to call the Ingestion API

We use **client credentials + app roles** (no user is involved), so the
bot needs an **application permission** assignment — not pre-authorisation
of a delegated scope.

Portal: **Entra ID → App registrations → BCR Ledger Bot →
API permissions**

1. **+ Add a permission → My APIs → BCR Ledger Ingestion API**
2. Choose **Application permissions** (not *Delegated*).
3. ✅ Check `Documents.Ingest` → **Add permissions**.
4. Click **✅ Grant admin consent for <tenant>** (mandatory).

The Bot’s `API permissions` blade should now show:

> **BCR Ledger Ingestion API** — `Documents.Ingest` — Application — ✅ Granted

CLI equivalent (recommended — also works when the portal is sluggish):

```bash
BOT_APP_ID=<bot client id>
INGESTION_APP_ID=<ingestion client id>

# 1. Resolve service principal object IDs and the role id
BOT_SP_ID=$(az ad sp show --id "$BOT_APP_ID" --query id -o tsv)
INGESTION_SP_ID=$(az ad sp show --id "$INGESTION_APP_ID" --query id -o tsv)
ROLE_ID=$(az ad app show --id "$INGESTION_APP_ID" \
  --query "appRoles[?value=='Documents.Ingest'].id | [0]" -o tsv)

# 2. Register the requested permission on the Bot app reg (cosmetic / shows up in portal)
az ad app permission add --id "$BOT_APP_ID" \
  --api "$INGESTION_APP_ID" \
  --api-permissions "${ROLE_ID}=Role"

# 3. Create the actual app-role assignment via Microsoft Graph.
# ⚠️ `az ad app permission admin-consent` does NOT do this for application
# permissions — it only consents delegated scopes. You MUST POST to Graph.
az rest --method POST \
  --url "https://graph.microsoft.com/v1.0/servicePrincipals/${BOT_SP_ID}/appRoleAssignments" \
  --headers "Content-Type=application/json" \
  --body "{\"principalId\":\"${BOT_SP_ID}\",\"resourceId\":\"${INGESTION_SP_ID}\",\"appRoleId\":\"${ROLE_ID}\"}"

# 4. Verify — must return one entry whose resourceDisplayName is the Ingestion API
az rest --method GET \
  --url "https://graph.microsoft.com/v1.0/servicePrincipals/${BOT_SP_ID}/appRoleAssignments" \
  --query "value[].{resource:resourceDisplayName, roleId:appRoleId}"
```

Expected verification output:

```json
[
  {
    "resource": "BCR Ledger Ingestion API",
    "roleId": "<same id as ROLE_ID above>"
  }
]
```

If the array is `[]`, the bot’s token will be issued without the
`Documents.Ingest` role and the Ingestion API will reject every request
with `401`. Re-run step 3.

> 💡 **Why not “Expose an API → Authorized client applications”?**
> That feature only enables when the API exposes at least one **delegated
> `scope`** and is intended to skip user-consent prompts for delegated
> flows. Our flow is app-only, so the button stays greyed out — and you
> don’t need it.

> 💡 **Portal vs CLI gotcha.** The portal’s *Grant admin consent* button
> does call the Graph `appRoleAssignments` endpoint for you, so the
> portal path works end-to-end. The CLI command `az ad app permission
> admin-consent` does **not** — it only creates an `oauth2PermissionGrant`
> (delegated). Always use the `az rest` POST shown above when scripting.

---

## 3. Create the Azure resources

The full Bicep template lives in [`infrastructure/main.bicep`](../infrastructure/main.bicep)
and creates everything in one resource group:

- Storage account (Functions runtime + queue)
- Log Analytics workspace + Application Insights
- Linux Consumption Plan
- 2 × Function Apps (system-assigned managed identity)
- Azure Bot resource (with **Teams channel** enabled)
- Key Vault (RBAC mode, soft-delete + purge protection)
- Document classification via **Claude** (Anthropic API — external, no Azure resource)

### 3a. Fill in parameter file

Edit [`infrastructure/main.dev.parameters.json`](../infrastructure/main.dev.parameters.json):

```jsonc
{
  "parameters": {
    "environmentName":            { "value": "dev" },
    "location":                   { "value": "westeurope" },
    "botAppId":                   { "value": "<Bot App ID from §2a>" },
    "ingestionAppId":             { "value": "<Ingestion App ID from §2b>" },
    "sharePointSiteHostname":     { "value": "contoso.sharepoint.com" },
    "sharePointSitePath":         { "value": "/sites/BCR-Ledger" },
    "sharePointDriveName":        { "value": "Documents" },
    "sharePointRootFolder":       { "value": "" },
    "enableAnthropic":            { "value": true },
    "anthropicModel":             { "value": "claude-opus-4-5-20251101" },
    "anthropicConfidenceThreshold": { "value": "0.6" },
    "clientCompanyName":          { "value": "0000 TEST Sp. z o.o." },
    "clientNip":                  { "value": "" }
  }
}
```

### 3b. Deploy

```bash
az login
az account set --subscription <Subscription ID>

cd bcr-ledger-agent
yarn install
yarn build
yarn deploy:dev
```

The script will print the final Function App names — note them:

| Output | Use later as |
|---|---|
| `func-bcr-bot-dev-XXXX` | bot messaging endpoint host |
| `func-bcr-ingest-dev-XXXX` | ingestion API host |
| `kv-bcr-ledger-dev-XXXX` | Key Vault name for secrets |
| `appi-bcr-ledger-dev-XXXX` | App Insights resource |

### 3c. Bot messaging endpoint

After deployment, set the Bot Service’s messaging endpoint to:

```
https://func-bcr-bot-dev-XXXX.azurewebsites.net/api/messages
```

UI path: **Azure Portal → Azure Bot resource → *Configuration* → *Messaging endpoint***.

The Bicep template attempts this automatically — verify the field is set.

---

## 4. Seed secrets in Key Vault

Both Function Apps are configured to read these via
`@Microsoft.KeyVault(SecretUri=…)` references (see Function App
*Configuration* blade after deployment).

```bash
KV=kv-bcr-ledger-dev-XXXX   # from §3b output

# Bot client secret (required)
az keyvault secret set --vault-name "$KV" \
  --name bot-app-password \
  --value "<MICROSOFT_APP_PASSWORD from §2a>"

# Anthropic (Claude) API key (only if enableAnthropic = true in §3a)
az keyvault secret set --vault-name "$KV" \
  --name anthropic-api-key \
  --value "<ANTHROPIC_API_KEY — sk-ant-…>"

# Restart the function apps so they pick up the references
az functionapp restart -g rg-bcr-ledger-dev -n func-bcr-bot-dev-XXXX
az functionapp restart -g rg-bcr-ledger-dev -n func-bcr-ingest-dev-XXXX
```

---

## 5. Grant SharePoint site permission (`Sites.Selected`)

`Sites.Selected` is the modern, **least-privilege** alternative to
`Sites.ReadWrite.All`. The ingestion app is allowed to write only to the
single site you grant it.

```bash
# 1. Look up the site ID
SITE_ID=$(az rest --method get \
  --uri "https://graph.microsoft.com/v1.0/sites/contoso.sharepoint.com:/sites/BCR-Ledger" \
  --query id -o tsv)

# 2. Grant the Ingestion app reg the "write" role on that site
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

> ⚠️ The user running this command needs `Sites.FullControl.All` (typically
> a Global / SharePoint admin). Once granted, you’re done — no per-folder
> ACLs needed.

---

## 6. Reference: every `.env` / `local.settings.json` variable

There are **three** configuration surfaces:

| File | Used by | Used when |
|---|---|---|
| `.env` (repo root) | scripts / tooling | dev shell |
| `packages/teams-bot/local.settings.json` | bot function | `yarn start:bot` |
| `packages/document-ingestion/local.settings.json` | ingestion function | `yarn start:ingestion` |

The values mostly overlap. In **production**, none of them exist — Azure
sets every value via Function App *Configuration* (with Key Vault
references for secrets).

### 6a. Azure tenant

| Variable | Where it lives | How to find it |
|---|---|---|
| `AZURE_TENANT_ID` | both `.env`s | Azure Portal → **Entra ID → Overview → Tenant ID** &nbsp;·&nbsp; CLI: `az account show --query tenantId -o tsv` |
| `AZURE_SUBSCRIPTION_ID` | `.env` (root) | Azure Portal → **Subscriptions → your sub → Overview** &nbsp;·&nbsp; CLI: `az account show --query id -o tsv` |

### 6b. Bot Framework / Teams (`packages/teams-bot/local.settings.json`)

| Variable | Where it lives | How to find it |
|---|---|---|
| `MICROSOFT_APP_ID` | teams-bot | Bot app reg → **Overview → Application (client) ID** *(§2a)* |
| `MICROSOFT_APP_PASSWORD` | teams-bot | Bot app reg → **Certificates & secrets → New client secret → Value** *(§2a)*. After deployment, paste into Key Vault as `bot-app-password` *(§4)*. |
| `MICROSOFT_APP_TENANT_ID` | teams-bot | Same as `AZURE_TENANT_ID` |
| `MICROSOFT_APP_TYPE` | teams-bot | Almost always `SingleTenant`. The other options are `MultiTenant` and `UserAssignedMSI`. |
| `INGESTION_BASE_URL` | teams-bot | `http://localhost:7071` locally, `https://func-bcr-ingest-<env>-XXXX.azurewebsites.net` in Azure. |
| `INGESTION_SCOPE` | teams-bot | `api://<INGESTION_APP_ID>/.default` — see §2b |

### 6c. Ingestion API auth & target site (`packages/document-ingestion/local.settings.json`)

| Variable | How to find it |
|---|---|
| `INGESTION_APP_ID` | Ingestion app reg → **Overview → Application (client) ID** *(§2b)* |
| `EXPECTED_AUDIENCE` | `api://<INGESTION_APP_ID>` (no `/.default` suffix) |
| `EXPECTED_ROLES` | Comma-separated list. Default `Documents.Ingest`. Add new role names if you create more in step §2b. |
| `SHAREPOINT_SITE_HOSTNAME` | The first part of your SharePoint URL — e.g. `contoso.sharepoint.com` |
| `SHAREPOINT_SITE_PATH` | The path part — must start with `/`, e.g. `/sites/BCR-Ledger`. UI: open the site in SharePoint, copy from the URL. |
| `SHAREPOINT_DRIVE_NAME` | Display name of the document library. Default is **Documents** (the built-in library). For a custom library use its exact display name. |
| `SHAREPOINT_ROOT_FOLDER` | *(optional)* Prefix every upload with this folder (e.g. `Ledger`). Leave blank to upload at drive root. |

### 6d. Claude document classification

Skip (set `ANTHROPIC_ENABLED=false`) if you want fallback-only routing
(everything goes to `98_Nieposortowane/RRRR/MM/` for manual sorting).

| Variable | How to find it |
|---|---|
| `ANTHROPIC_ENABLED` | `true` to wire the Claude classifier in; `false` to disable (fallback only). |
| `ANTHROPIC_API_KEY` | [Anthropic Console](https://console.anthropic.com/) → **API Keys**. After deployment, store as Key Vault secret `anthropic-api-key` *(§4)*. |
| `ANTHROPIC_MODEL` | Model id. Default `claude-opus-4-5-20251101`. |
| `ANTHROPIC_MAX_CONTENT_BYTES` | Max document size sent to the API. Default `10485760` (10 MiB); larger files skip AI and go to manual review. |
| `ANTHROPIC_CONFIDENCE_THRESHOLD` | Minimum model confidence (`0`–`1`) to accept a category. Default `0.6`; below this routes to manual review. |
| `CLIENT_COMPANY_NAME` | The client's legal company name — lets the model tell sales vs. purchase invoices. |
| `CLIENT_NIP` | The client's NIP (tax id) — same purpose as above. |

### 6e. Telemetry

| Variable | How to find it |
|---|---|
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | Azure Portal → your **Application Insights** resource → **Overview → Connection String**. Bicep wires this into both Function Apps automatically. |

### 6f. Misc

| Variable | Default | Notes |
|---|---|---|
| `LOG_LEVEL` | `info` | `trace` ¦ `debug` ¦ `info` ¦ `warn` ¦ `error` ¦ `fatal` |
| `NODE_ENV` | `development` | Set to `production` in Azure (Bicep does this) |

---

## 7. Register the bot in Microsoft Teams

Even though the Azure Bot resource has the Teams channel enabled, Teams
users won’t see anything until you sideload (or publish) the Teams app
package built from [`teams-app/manifest.json`](../teams-app/manifest.json).

### 7a. Prepare the manifest

```bash
cd teams-app
# Replace the two REPLACE-WITH-BOT-APP-ID placeholders
sed -i.bak "s/REPLACE-WITH-BOT-APP-ID/<MICROSOFT_APP_ID>/g" manifest.json && rm manifest.json.bak
```

Add the required icons (one-time):

- **`color.png`** — 192×192, full colour
- **`outline.png`** — 32×32, transparent + white outline

### 7b. Build the .zip

```bash
mkdir -p ../artifacts
zip ../artifacts/teams-app.zip manifest.json color.png outline.png
```

### 7c. Sideload for a single user (fastest)

1. Open Teams desktop or web.
2. Left rail → **Apps → Manage your apps → Upload an app → Upload a custom app**.
3. Pick `artifacts/teams-app.zip`.
4. Click **Add**.
5. Open a 1:1 chat with the bot. Drop in a file named e.g.
   `Invoice_03_2026.pdf`.

You should see a card like:

> ✅ Filed **Invoice_03_2026.pdf**
> Type: Invoice · Confidence: 95% · Folder: `Invoices/2026/03`
> [Open in SharePoint]

### 7d. Publish org-wide (Teams admin)

1. **Teams admin center → Teams apps → Manage apps → + Upload new app →
   Upload** the same `teams-app.zip`.
2. Set its **Publishing status** to *Published*.
3. Use **Setup policies / Permission policies** to make it available to
   the right users or groups.

> Org-wide publishing usually requires the **Teams Administrator** role.

---

## 8. Smoke tests

```bash
# 1. Ingestion is alive and unauthenticated /health works
curl https://func-bcr-ingest-dev-XXXX.azurewebsites.net/api/health

# 2. Bot endpoint exists (returns 405 to a GET — that's expected)
curl -i https://func-bcr-bot-dev-XXXX.azurewebsites.net/api/messages

# 3. Direct ingestion call (no bot involved)
ACCESS_TOKEN=$(az account get-access-token \
  --resource api://<INGESTION_APP_ID> --query accessToken -o tsv)

cat > /tmp/payload.json <<JSON
{
  "filename": "Invoice_03_2026.pdf",
  "contentType": "application/pdf",
  "contentBase64": "$(base64 -i ~/Downloads/sample.pdf)",
  "source": {
    "tenantId": "<AZURE_TENANT_ID>",
    "channelId": "msteams",
    "conversationId": "smoke-test",
    "activityId": "smoke-$(date +%s)"
  }
}
JSON

curl -X POST https://func-bcr-ingest-dev-XXXX.azurewebsites.net/api/ingest \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d @/tmp/payload.json | jq .
```

If the bot does **not** respond in Teams, query Application Insights:

```kusto
union requests, exceptions, traces
| where customDimensions["conversationId"] == "<paste from Teams>"
| order by timestamp asc
```

---

## 9. Cheat sheet — value → location matrix

| `.env` variable | Where you get it | Stored long-term in |
|---|---|---|
| `AZURE_TENANT_ID` | Entra ID Overview | Function App setting |
| `AZURE_SUBSCRIPTION_ID` | Azure Subscriptions | Used by CLI only |
| `MICROSOFT_APP_ID` | Bot app reg Overview | Function App setting |
| `MICROSOFT_APP_PASSWORD` | Bot app reg Certificates & secrets | **Key Vault** secret `bot-app-password` |
| `MICROSOFT_APP_TENANT_ID` | = `AZURE_TENANT_ID` | Function App setting |
| `MICROSOFT_APP_TYPE` | constant (`SingleTenant`) | Function App setting |
| `INGESTION_APP_ID` | Ingestion app reg Overview | Function App setting |
| `INGESTION_BASE_URL` | Function App default hostname | Bot Function App setting |
| `INGESTION_SCOPE` | `api://<INGESTION_APP_ID>/.default` | Bot Function App setting |
| `EXPECTED_AUDIENCE` | `api://<INGESTION_APP_ID>` | Ingestion Function App setting |
| `EXPECTED_ROLES` | App roles you defined | Ingestion Function App setting |
| `SHAREPOINT_SITE_HOSTNAME` | SharePoint URL | Ingestion Function App setting |
| `SHAREPOINT_SITE_PATH` | SharePoint URL path | Ingestion Function App setting |
| `SHAREPOINT_DRIVE_NAME` | SharePoint library display name | Ingestion Function App setting |
| `SHAREPOINT_ROOT_FOLDER` | your choice | Ingestion Function App setting |
| `ANTHROPIC_ENABLED` | feature flag | Ingestion Function App setting |
| `ANTHROPIC_API_KEY` | Anthropic Console | **Key Vault** secret `anthropic-api-key` |
| `ANTHROPIC_MODEL` | constant (model id) | Ingestion Function App setting |
| `ANTHROPIC_MAX_CONTENT_BYTES` | constant | Ingestion Function App setting |
| `ANTHROPIC_CONFIDENCE_THRESHOLD` | constant | Ingestion Function App setting |
| `CLIENT_COMPANY_NAME` | client legal name | Ingestion Function App setting |
| `CLIENT_NIP` | client tax id | Ingestion Function App setting |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | App Insights Overview | Both Function Apps |
| `LOG_LEVEL` | constant | Both Function Apps |
| `NODE_ENV` | `production` in Azure | Both Function Apps |

---

## 10. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Bot times out in Teams, no logs | Messaging endpoint wrong on Bot resource | Set it to `https://func-bcr-bot-<env>-XXXX.azurewebsites.net/api/messages` |
| `+ Add a permission → My APIs` shows **No results** | Ingestion API has no *Application ID URI* and/or no *app role*, **or** you're signed in to a different tenant | Run the preflight in §2b (`az ad app show --id …`); fix whichever array is empty, then **Refresh** the *My APIs* tab |
| `401 Unauthorized` from ingestion | Bot’s token has no `Documents.Ingest` role | Re-check §2c (Bot app reg → *API permissions* → application permission + admin consent) |
| Ingestion logs `Token missing required role` but portal shows *✅ Granted* | CLI script used `az ad app permission admin-consent` (creates only delegated grants, **not** app-role assignments) | Run the `az rest --method POST … /appRoleAssignments` from §2c, then verify the GET returns one entry |
| `403 Forbidden` on Graph upload | `Sites.Selected` not granted on the target site | Re-run §5 |
| Bot replies “⚠️ Could not file …” with `Folder traversal not allowed` | Tenant filename contains `..` or path separator | Rename the file or extend `pathBuilder.ts` rules |
| Cards never render in Teams | The bot identity is wrong | Confirm `MICROSOFT_APP_ID` matches the Bot app reg, *and* the Teams `manifest.json` `id` + `bots[0].botId` use the same value |
| `func: command not found` running `yarn start:bot` | Dependencies not installed from repo root | `cd bcr-ledger-agent && corepack yarn install` |
| `Yarn 1.x is being used` | Global Yarn 1 wins over Corepack shim | Use `corepack yarn …` everywhere, or prepend `~/.nvm/versions/node/v22*/bin` to your `PATH` |

---

## 11. Where to go next

- [`local-development.md`](./local-development.md) — running both functions
  locally + Emulator + curl recipes.
- [`security.md`](./security.md) — threat model, secrets inventory,
  compliance checklist.
- [`../ARCHITECTURE.md`](../ARCHITECTURE.md) — full sequence diagram and
  component contracts.
