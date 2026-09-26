param name string
param location string
param tags object

resource kv 'Microsoft.KeyVault/vaults@2024-04-01-preview' = {
  name: name
  location: location
  tags: tags
  properties: {
    tenantId: tenant().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 7
    enablePurgeProtection: true
    // No networkAcls: the running vault has none, which is the same as
    // defaultAction Allow. Network rules would be a change, not a record.
    publicNetworkAccess: 'Enabled'
  }
}

output id string = kv.id
output name string = kv.name
output uri string = kv.properties.vaultUri
