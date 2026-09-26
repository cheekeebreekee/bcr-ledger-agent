param name string
param location string
param tags object
param planId string
param storageAccountName string
param appInsightsConnectionString string

@description('''
The app's own settings, as NAME: value. With runtimeSettings below they are the app's
whole set: a deploy replaces every app setting, so a setting missing here is deleted.
Secrets are Key Vault references, never values.
''')
param appSettings object

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: storageAccountName
}

resource functionApp 'Microsoft.Web/sites@2024-04-01' = {
  name: name
  location: location
  tags: tags
  kind: 'functionapp,linux'
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: planId
    httpsOnly: true
    clientAffinityEnabled: false
    // No appSettings here: they are the `appsettings` config resource below.
    // What-if masks siteConfig.appSettings entirely ("*******") and reports no
    // change whatever they hold, which is how the settings drifted unseen.
    siteConfig: {
      linuxFxVersion: 'NODE|22'
      ftpsState: 'Disabled'
      minTlsVersion: '1.2'
      use32BitWorkerProcess: false
      http20Enabled: true
      healthCheckPath: '/api/health'
      cors: {
        allowedOrigins: ['https://botservice.hosting.portal.azure.net', 'https://hosting.onecloud.azure-test.net']
      }
    }
  }
}

// Settings every Function App here has, whatever its code.
var runtimeSettings = {
  FUNCTIONS_EXTENSION_VERSION: '~4'
  FUNCTIONS_WORKER_RUNTIME: 'node'
  WEBSITE_NODE_DEFAULT_VERSION: '~22'
  AzureWebJobsStorage: 'DefaultEndpointsProtocol=https;AccountName=${storage.name};AccountKey=${storage.listKeys().keys[0].value};EndpointSuffix=core.windows.net'
  APPLICATIONINSIGHTS_CONNECTION_STRING: appInsightsConnectionString
  // Read directly, not through the config schema: the logger's `env`, and the
  // Graph client, which uses the managed identity only when this is `production`.
  NODE_ENV: 'production'
}

// WEBSITE_RUN_FROM_PACKAGE belongs to the zip deploy, not to this template. On
// Linux Consumption `config-zip` uploads the package to blob storage and points
// this setting at it with a SAS URL; the old '1' is not supported there, and
// leaving the setting out would delete it, so the app would lose its code on
// every template deploy. It is read from the running app when this resource is
// deployed and written back unchanged. A new app has none until its first zip
// deploy, and gets none here. (The config resource cannot also be declared
// `existing` in this file, hence list() by id.)
var currentSettings = list('${functionApp.id}/config/appsettings', '2024-04-01').properties
var packageSetting = contains(currentSettings, 'WEBSITE_RUN_FROM_PACKAGE')
  ? { WEBSITE_RUN_FROM_PACKAGE: currentSettings.WEBSITE_RUN_FROM_PACKAGE }
  : {}

resource functionAppSettings 'Microsoft.Web/sites/config@2024-04-01' = {
  parent: functionApp
  name: 'appsettings'
  properties: union(runtimeSettings, appSettings, packageSetting)
}

output id string = functionApp.id
output name string = functionApp.name
output defaultHostname string = functionApp.properties.defaultHostName
output principalId string = functionApp.identity.principalId
