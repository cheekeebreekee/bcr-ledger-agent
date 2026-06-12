// =============================================================================
// bcr-ledger-agent — environment infrastructure
//
// Provisions everything needed to run the Teams bot + ingestion API:
//   - Storage account (Functions runtime + queue for retries)
//   - Log Analytics workspace + Application Insights
//   - Key Vault for secrets (RBAC mode)
//   - Two Function Apps (bot, ingestion) on a Linux consumption plan
//   - Azure Bot resource with Teams channel
//   - Azure AI Document Intelligence (optional, gated by parameter)
//   - All RBAC grants needed by managed identities
//
// Subscription scope is intentionally avoided so the same template can be
// deployed by any contributor with `Contributor` on the target RG.
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

@description('SharePoint site hostname, e.g. contoso.sharepoint.com.')
param sharePointSiteHostname string

@description('SharePoint site path, must start with /, e.g. /sites/BCR-Ledger.')
param sharePointSitePath string

@description('SharePoint drive (library) name to upload into.')
param sharePointDriveName string = 'Documents'

@description('Optional root folder prefix inside the drive.')
param sharePointRootFolder string = ''

@description('Provision Azure AI Document Intelligence?')
param enableDocumentIntelligence bool = true

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
var diName = 'di-bcr-${nameSuffix}'
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

module documentIntelligence 'modules/documentIntelligence.bicep' = if (enableDocumentIntelligence) {
  name: 'documentIntelligence'
  params: {
    name: diName
    location: location
    tags: tags
  }
}

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
    appSettings: [
      { name: 'MICROSOFT_APP_ID', value: botAppId }
      { name: 'MICROSOFT_APP_TYPE', value: 'SingleTenant' }
      { name: 'MICROSOFT_APP_TENANT_ID', value: botTenantId }
      { name: 'MICROSOFT_APP_PASSWORD', value: '@Microsoft.KeyVault(SecretUri=${keyVault.outputs.uri}secrets/bot-app-password/)' }
      { name: 'INGESTION_BASE_URL', value: 'https://${ingestionFunction.outputs.defaultHostname}' }
      { name: 'INGESTION_SCOPE', value: 'api://${ingestionAppId}/.default' }
      { name: 'LOG_LEVEL', value: environmentName == 'prod' ? 'info' : 'debug' }
    ]
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
    appSettings: union(
      [
        { name: 'AZURE_TENANT_ID', value: botTenantId }
        { name: 'INGESTION_APP_ID', value: ingestionAppId }
        { name: 'EXPECTED_AUDIENCE', value: 'api://${ingestionAppId}' }
        { name: 'SHAREPOINT_SITE_HOSTNAME', value: sharePointSiteHostname }
        { name: 'SHAREPOINT_SITE_PATH', value: sharePointSitePath }
        { name: 'SHAREPOINT_DRIVE_NAME', value: sharePointDriveName }
        { name: 'SHAREPOINT_ROOT_FOLDER', value: sharePointRootFolder }
        { name: 'DOCUMENT_INTELLIGENCE_ENABLED', value: string(enableDocumentIntelligence) }
        { name: 'LOG_LEVEL', value: environmentName == 'prod' ? 'info' : 'debug' }
      ],
      enableDocumentIntelligence ? [
        { name: 'DOCUMENT_INTELLIGENCE_ENDPOINT', value: documentIntelligence.?outputs.endpoint }
        { name: 'DOCUMENT_INTELLIGENCE_KEY', value: '@Microsoft.KeyVault(SecretUri=${keyVault.outputs.uri}secrets/document-intelligence-key/)' }
      ] : []
    )
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
var kvSecretsUserRoleId = '4633458b-17de-41a5-8b4b-ea7a4d3b6b1c'

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
output documentIntelligenceEndpoint string = enableDocumentIntelligence ? (documentIntelligence.?outputs.endpoint ?? '') : ''
output ingestionFunctionPrincipalId string = ingestionFunction.outputs.principalId
