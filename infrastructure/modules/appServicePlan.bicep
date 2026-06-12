param name string
param location string
param tags object

@description('Consumption plan tier. Use Y1 for serverless billing, EP1 for premium.')
param skuName string = 'Y1'

resource plan 'Microsoft.Web/serverfarms@2024-04-01' = {
  name: name
  location: location
  tags: tags
  sku: { name: skuName, tier: skuName == 'Y1' ? 'Dynamic' : 'ElasticPremium' }
  kind: 'linux'
  properties: {
    reserved: true // Linux
  }
}

output id string = plan.id
output name string = plan.name
