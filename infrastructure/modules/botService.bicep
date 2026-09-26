param name string
param location string = 'global'
param tags object
param botAppId string
param botTenantId string
param messagingEndpoint string

resource bot 'Microsoft.BotService/botServices@2022-09-15' = {
  name: name
  location: location
  tags: tags
  sku: { name: 'F0' }
  kind: 'azurebot'
  properties: {
    displayName: name
    // The values the running bot has. Left out, a PUT would clear them.
    iconUrl: 'https://docs.botframework.com/static/devportal/client/images/bot-framework-default.png'
    schemaTransformationVersion: '1.3'
    endpoint: messagingEndpoint
    msaAppId: botAppId
    msaAppType: 'SingleTenant'
    msaAppTenantId: botTenantId
    publicNetworkAccess: 'Enabled'
    disableLocalAuth: false
  }
}

// Enable the Microsoft Teams channel
resource teamsChannel 'Microsoft.BotService/botServices/channels@2022-09-15' = {
  parent: bot
  name: 'MsTeamsChannel'
  location: location
  properties: {
    channelName: 'MsTeamsChannel'
    // The running channel's values: no calling, commercial cloud.
    properties: {
      isEnabled: true
      acceptedTerms: false
      enableCalling: false
      deploymentEnvironment: 'CommercialDeployment'
    }
  }
}

output id string = bot.id
output name string = bot.name
