// =============================================================================
// bcr-ledger-agent — environment infrastructure
//
// Provisions everything needed to run the Teams bot + ingestion API:
//   - Storage account (Functions runtime + queue for retries)
//   - Log Analytics workspace + Application Insights
//   - Key Vault for secrets (RBAC mode)
//   - Two Function Apps (bot, ingestion) on a Linux consumption plan
//   - Azure Bot resource with Teams channel
//   - Anthropic Claude content classification (API key in Key Vault)
//   - All RBAC grants needed by managed identities
//
// Subscription scope is intentionally avoided so the same template can be
// deployed by any contributor with `Contributor` on the target RG.
//
// A deploy REPLACES every app setting of both Function Apps with the ones
// below, so this template, with main.<env>.parameters.json, must record every
// setting the apps run with. A setting changed by hand in Azure has to be
// changed here in the same change, or the next deploy reverts it. What-if
// cannot show app-setting changes: it reads no app-setting values. Compare
// with `node tools/check-app-settings.mjs --live -g <rg> -p <params>` instead;
// CI runs its static half on every push.
// =============================================================================

targetScope = 'resourceGroup'

// ---- Parameters -------------------------------------------------------------

@description('Short env name appended to resource names (dev/qa/prod).')
@allowed(['dev', 'qa', 'prod'])
param environmentName string

@description('Azure region for all resources.')
param location string = resourceGroup().location

@description('Microsoft App ID for the Bot (existing AAD App Registration).')
param botAppId string

@description('Microsoft App tenant id for the bot (single-tenant).')
param botTenantId string = tenant().tenantId

@description('App Registration ID for the ingestion API.')
param ingestionAppId string

// ---- Ingestion: routing, quarantine and guards ------------------------------
// Values, not secrets. Each maps to one app setting; what it must look like is
// in packages/shared/src/config.ts, and ingestion refuses to start on a bad one.

@description('BOT_CALLER_APP_IDS: app ids allowed to call the ingestion API, comma-separated. Today the bot only.')
param botCallerAppIds string = botAppId

@description('CLIENT_DIRECTORY_SITE_ID: three-part Graph id <host>,<siteGuid>,<webGuid> of the site holding the Client Directory (BCR GROUP).')
param clientDirectorySiteId string

@description('CLIENT_DIRECTORY_LIST_ID: Graph list id of the Client Directory.')
param clientDirectoryListId string

@description('CLIENT_DIRECTORY_CACHE_TTL_MS: how long a Directory snapshot is cached (ms).')
param clientDirectoryCacheTtlMs string = '300000'

@description('CLIENT_DIRECTORY_MAX_STALE_MS: oldest snapshot still routed on when refreshes fail (ms).')
param clientDirectoryMaxStaleMs string = '900000'

@description('QUARANTINE_SITE_HOSTNAME: the tenant\'s SharePoint host, e.g. contoso.sharepoint.com. Also the only host a Directory row may name.')
param quarantineSiteHostname string

@description('QUARANTINE_SITE_PATH: the staff-only quarantine site, /sites/<name>.')
param quarantineSitePath string

@description('QUARANTINE_DRIVE_NAME: the quarantine site\'s library (Dokumenty on a Polish tenant).')
param quarantineDriveName string = 'Documents'

@description('QUARANTINE_ROOT_FOLDER: the folder inside that library.')
param quarantineRootFolder string = 'Kwarantanna'

@description('FORBIDDEN_TARGET_SITE_PATHS: site paths no Directory row may route to, comma-separated; at least the site holding the Client Directory.')
param forbiddenTargetSitePaths string

// ---- Ingestion: channel-inbox sweep ----------------------------------------

@description('INBOX_SWEEP_MODE: off, shadow (reads and logs only) or enforce (moves files).')
@allowed(['off', 'shadow', 'enforce'])
param inboxSweepMode string = 'off'

@description('INBOX_SWEEP_ROWS: Client Directory list item ids the sweep may touch, comma-separated. Empty: every bound row.')
param inboxSweepRows string = ''

@description('INBOX_CREATED_AFTER: files created at or before this ISO 8601 UTC time are left in place. Empty: no cutoff.')
param inboxCreatedAfter string = ''

@description('INBOX_MAX_FILES_PER_TICK: most files taken into processing per sweep tick. Empty: the code default (20).')
param inboxMaxFilesPerTick string = ''

// ---- Ingestion: Claude classification ---------------------------------------

@description('Enable Claude (Anthropic) content classification?')
param enableAnthropic bool = true

@description('ANTHROPIC_MODEL: Anthropic model id used for document classification.')
param anthropicModel string = 'claude-opus-5'

@description('REVIEW_WEBHOOK_URL: review notices to the staff chat, from Key Vault secret review-webhook-url. true only once that secret exists (Classifier cost release / review notices runbook).')
param enableReviewNotices bool = false

@description('ANTHROPIC_EFFORT: output_config.effort of every classification call. low is the cheapest.')
@allowed(['low', 'medium', 'high'])
param anthropicEffort string = 'low'

@description('ANTHROPIC_THINKING: adaptive (the model decides at the given effort) or disabled (no thinking tokens; only claude-opus-5 and claude-sonnet-5 accept it).')
@allowed(['adaptive', 'disabled'])
param anthropicThinking string = 'adaptive'

@description('CLASSIFICATION_ACCEPT_THRESHOLD: the one acceptance threshold, 0.70-0.95; below it a document goes to 98_Nieposortowane for review. Ingestion refuses to start outside that range.')
param classificationAcceptThreshold string = '0.70'

// ---- Ingestion: the document index -----------------------------------------
// The database itself is infrastructure/db.bicep, a separate template deployed
// on its own: this template never creates or changes it, and db.bicep never
// touches these settings.

@description('LEDGER_INDEX_MODE: off (nothing written, no connection) or write (every filed document is recorded in the index, client-scoped). Ingestion refuses to start in write without LEDGER_DB_HOST.')
@allowed(['off', 'write'])
param ledgerIndexMode string = 'off'

@description('LEDGER_DB_HOST: the index server, <server>.postgres.database.azure.com (db.bicep output serverFqdn). Empty while LEDGER_INDEX_MODE is off.')
param ledgerDbHost string = ''

@description('LEDGER_DB_USER: the PostgreSQL login of the ingestion managed identity, which pgaadauth_create_principal names after the Function App. Empty while LEDGER_INDEX_MODE is off.')
param ledgerDbUser string = ''

// ---- Ingestion: client search (POST /api/search) ----------------------------
// Called only by the bot Function App's managed identity, with the app role
// Documents.Search that infrastructure/identity/grant-bot-search-caller.sh
// assigns. Search that cannot run safely is off with a reason at cold start;
// only a SEARCH_MODE outside off|on stops ingestion.

@description('SEARCH_MODE (ingestion): off answers every search disabled; on serves it.')
@allowed(['off', 'on'])
param searchMode string = 'off'

@description('SEARCH_ROWS: Client Directory list item ids (not ClientId) search is open to, comma-separated. Empty: every bound row. An entry that is not a list item id keeps search off (bad_rows); it never stops ingestion.')
param searchRows string = ''

@description('SEARCH_CALLER_APP_IDS: the app id of the bot Function App\'s managed identity (grant-bot-search-caller.sh prints it). Empty: search off. Never an id of BOT_CALLER_APP_IDS.')
param searchCallerAppIds string = ''

// ---- Bot --------------------------------------------------------------------

@description('BOT_GATE_MODE: what the bot does with an activity that fails the gate. enforce refuses it; log only records it.')
@allowed(['log', 'enforce'])
param botGateMode string = 'enforce'

@description('SEARCH_MODE (bot): off keeps the help card for text; on sends a guest\'s text to ingestion\'s /api/search with the bot\'s managed identity.')
@allowed(['off', 'on'])
param botSearchMode string = 'off'

// ---- Both apps --------------------------------------------------------------

@description('LOG_LEVEL of both Function Apps.')
@allowed(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
param logLevel string = environmentName == 'prod' ? 'info' : 'debug'

@description('Tags applied to every resource.')
param tags object = {
  app: 'bcr-ledger-agent'
  environment: environmentName
  managedBy: 'bicep'
}

// ---- Naming -----------------------------------------------------------------

var nameSuffix = '${environmentName}-${uniqueString(resourceGroup().id)}'
var storageName = toLower(replace('stbcr${environmentName}${uniqueString(resourceGroup().id)}', '-', ''))
var planName = 'plan-bcr-${nameSuffix}'
var kvName = 'kv-bcr-${take(nameSuffix, 20)}'
var lawName = 'log-bcr-${nameSuffix}'
var aiName = 'appi-bcr-${nameSuffix}'
var botName = 'bot-bcr-${nameSuffix}'
var botFuncName = 'func-bcr-bot-${nameSuffix}'
var ingestFuncName = 'func-bcr-ingest-${nameSuffix}'

// ---- Shared platform --------------------------------------------------------

module storage 'modules/storageAccount.bicep' = {
  name: 'storage'
  params: {
    name: storageName
    location: location
    tags: tags
  }
}

module law 'modules/logAnalytics.bicep' = {
  name: 'law'
  params: {
    name: lawName
    location: location
    tags: tags
  }
}

module appInsights 'modules/appInsights.bicep' = {
  name: 'appInsights'
  params: {
    name: aiName
    location: location
    workspaceId: law.outputs.id
    tags: tags
  }
}

module keyVault 'modules/keyVault.bicep' = {
  name: 'keyVault'
  params: {
    name: kvName
    location: location
    tags: tags
  }
}

module plan 'modules/appServicePlan.bicep' = {
  name: 'plan'
  params: {
    name: planName
    location: location
    tags: tags
  }
}

// ---- App settings -----------------------------------------------------------
// Each app's whole set, with the runtime settings in modules/functionApp.bicep:
// a deploy replaces every app setting, so a setting missing here is deleted.
// A setting left out gets the code's default (tools/check-app-settings.mjs
// lists them). Secrets are Key Vault references, never values.

var botAppSettings = {
  MICROSOFT_APP_ID: botAppId
  MICROSOFT_APP_TYPE: 'SingleTenant'
  MICROSOFT_APP_TENANT_ID: botTenantId
  MICROSOFT_APP_PASSWORD: '@Microsoft.KeyVault(SecretUri=${keyVault.outputs.uri}secrets/bot-app-password/)'
  INGESTION_BASE_URL: 'https://${ingestionFunction.outputs.defaultHostname}'
  INGESTION_SCOPE: 'api://${ingestionAppId}/.default'
  BOT_GATE_MODE: botGateMode
  SEARCH_MODE: botSearchMode
  LOG_LEVEL: logLevel
}

var ingestionAppSettings = union(
  {
    AZURE_TENANT_ID: botTenantId
    INGESTION_APP_ID: ingestionAppId
    EXPECTED_AUDIENCE: 'api://${ingestionAppId}'
    BOT_CALLER_APP_IDS: botCallerAppIds
    CLIENT_DIRECTORY_SITE_ID: clientDirectorySiteId
    CLIENT_DIRECTORY_LIST_ID: clientDirectoryListId
    CLIENT_DIRECTORY_CACHE_TTL_MS: clientDirectoryCacheTtlMs
    CLIENT_DIRECTORY_MAX_STALE_MS: clientDirectoryMaxStaleMs
    QUARANTINE_SITE_HOSTNAME: quarantineSiteHostname
    QUARANTINE_SITE_PATH: quarantineSitePath
    QUARANTINE_DRIVE_NAME: quarantineDriveName
    QUARANTINE_ROOT_FOLDER: quarantineRootFolder
    FORBIDDEN_TARGET_SITE_PATHS: forbiddenTargetSitePaths
    INBOX_SWEEP_MODE: inboxSweepMode
    INBOX_SWEEP_ROWS: inboxSweepRows
    INBOX_CREATED_AFTER: inboxCreatedAfter
    INBOX_MAX_FILES_PER_TICK: inboxMaxFilesPerTick
    // The acceptance policy applies it with Claude on or off.
    CLASSIFICATION_ACCEPT_THRESHOLD: classificationAcceptThreshold
    // Not string(enableAnthropic): ARM spells that 'True'. The code reads either,
    // but the running value is 'true', and this template records it.
    ANTHROPIC_ENABLED: enableAnthropic ? 'true' : 'false'
    LEDGER_INDEX_MODE: ledgerIndexMode
    LEDGER_DB_HOST: ledgerDbHost
    LEDGER_DB_NAME: 'ledger'
    LEDGER_DB_USER: ledgerDbUser
    SEARCH_MODE: searchMode
    SEARCH_ROWS: searchRows
    SEARCH_CALLER_APP_IDS: searchCallerAppIds
    LOG_LEVEL: logLevel
  },
  enableReviewNotices
    ? {
        REVIEW_WEBHOOK_URL: '@Microsoft.KeyVault(SecretUri=${keyVault.outputs.uri}secrets/review-webhook-url/)'
      }
    : {},
  enableAnthropic
    ? {
        ANTHROPIC_MODEL: anthropicModel
        ANTHROPIC_EFFORT: anthropicEffort
        ANTHROPIC_THINKING: anthropicThinking
        ANTHROPIC_API_KEY: '@Microsoft.KeyVault(SecretUri=${keyVault.outputs.uri}secrets/anthropic-api-key/)'
      }
    : {}
)

// ---- Bot Function App -------------------------------------------------------

module botFunction 'modules/functionApp.bicep' = {
  name: 'botFunction'
  params: {
    name: botFuncName
    location: location
    tags: tags
    planId: plan.outputs.id
    storageAccountName: storage.outputs.name
    appInsightsConnectionString: appInsights.outputs.connectionString
    appSettings: botAppSettings
  }
}

// ---- Ingestion Function App -------------------------------------------------

module ingestionFunction 'modules/functionApp.bicep' = {
  name: 'ingestionFunction'
  params: {
    name: ingestFuncName
    location: location
    tags: tags
    planId: plan.outputs.id
    storageAccountName: storage.outputs.name
    appInsightsConnectionString: appInsights.outputs.connectionString
    appSettings: ingestionAppSettings
  }
}

// ---- Azure Bot resource + Teams channel -------------------------------------

module bot 'modules/botService.bicep' = {
  name: 'bot'
  params: {
    name: botName
    location: 'global'
    tags: tags
    botAppId: botAppId
    botTenantId: botTenantId
    messagingEndpoint: 'https://${botFunction.outputs.defaultHostname}/api/messages'
  }
}

// ---- RBAC -------------------------------------------------------------------

// Both Function Apps can read Key Vault secrets via managed identity.
// Built-in role: "Key Vault Secrets User" — verified via
// `az role definition list --name "Key Vault Secrets User"`.
var kvSecretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6'

resource botKvAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: resourceGroup()
  name: guid(kvName, botFuncName, kvSecretsUserRoleId)
  properties: {
    principalId: botFunction.outputs.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', kvSecretsUserRoleId)
  }
}

resource ingestKvAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: resourceGroup()
  name: guid(kvName, ingestFuncName, kvSecretsUserRoleId)
  properties: {
    principalId: ingestionFunction.outputs.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', kvSecretsUserRoleId)
  }
}

// ---- Outputs ----------------------------------------------------------------

output botFunctionName string = botFunction.outputs.name
output botFunctionHostname string = botFunction.outputs.defaultHostname
output ingestionFunctionName string = ingestionFunction.outputs.name
output ingestionFunctionHostname string = ingestionFunction.outputs.defaultHostname
output botName string = bot.outputs.name
output keyVaultName string = keyVault.outputs.name
output keyVaultUri string = keyVault.outputs.uri
output appInsightsName string = appInsights.outputs.name
output anthropicEnabled bool = enableAnthropic
output ingestionFunctionPrincipalId string = ingestionFunction.outputs.principalId
