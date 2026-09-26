// =============================================================================
// Azure Database for PostgreSQL Flexible Server for the document index.
//
// The smallest server that keeps the isolation guarantees (the guarantees
// themselves are the database's row-level security, packages/ledger-db):
//   - Burstable Standard_B1ms, PostgreSQL 16, 32 GiB, no HA (Burstable has none);
//   - 7-day backups, geo-redundant when the parameter says so (chosen at
//     creation only: Azure cannot switch it later);
//   - Microsoft Entra authentication ONLY: password authentication is off, so
//     there is no administrator password and no connection string with one;
//   - TLS required (1.2 or later);
//   - public network access, admitting Azure's own addresses only (the
//     0.0.0.0 rule). A Y1 Consumption Function App has no VNet integration
//     and no fixed outbound IP, so this is the one network trade-off; see
//     docs/security.md (T19). What keeps others out is Entra-only login.
// =============================================================================

@description('Server name: 3-63 lower-case letters, digits and hyphens.')
param name string

param location string
param tags object

@description('Object id of the Entra user (or group) that administers the server.')
param entraAdminObjectId string

@description('Its UPN (or group name): also the login name the administrator connects with.')
param entraAdminPrincipalName string

@allowed(['User', 'Group', 'ServicePrincipal'])
param entraAdminPrincipalType string = 'User'

@description('Geo-redundant backup storage: Enabled or Disabled. Fixed at creation.')
@allowed(['Enabled', 'Disabled'])
param geoRedundantBackup string

@description('The database the index lives in.')
param databaseName string = 'ledger'

param tenantId string = tenant().tenantId

resource server 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: name
  location: location
  tags: tags
  sku: {
    name: 'Standard_B1ms'
    tier: 'Burstable'
  }
  properties: {
    version: '16'
    createMode: 'Default'
    storage: {
      storageSizeGB: 32
      // A fixed disk keeps the cost fixed; an index of metadata rows is far
      // below 32 GiB. Storage can be raised later (never lowered).
      autoGrow: 'Disabled'
    }
    backup: {
      backupRetentionDays: 7
      geoRedundantBackup: geoRedundantBackup
    }
    highAvailability: {
      mode: 'Disabled'
    }
    // Saturday 18:00 UTC: outside the accountants' working week.
    maintenanceWindow: {
      customWindow: 'Enabled'
      dayOfWeek: 6
      startHour: 18
      startMinute: 0
    }
    network: {
      publicNetworkAccess: 'Enabled'
    }
    authConfig: {
      activeDirectoryAuth: 'Enabled'
      passwordAuth: 'Disabled'
      tenantId: tenantId
    }
  }
}

// The server accepts one change at a time: each child waits for the previous.

resource administrator 'Microsoft.DBforPostgreSQL/flexibleServers/administrators@2024-08-01' = {
  parent: server
  name: entraAdminObjectId
  properties: {
    principalName: entraAdminPrincipalName
    principalType: entraAdminPrincipalType
    tenantId: tenantId
  }
}

// Start and end 0.0.0.0: Azure's name for "connections from Azure services".
// It admits every Azure address, other tenants' too; Entra-only login and TLS
// are what keep them out.
resource allowAzureServices 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2024-08-01' = {
  parent: server
  name: 'AllowAllAzureServicesAndResourcesWithinAzureIps'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
  dependsOn: [administrator]
}

resource database 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: server
  name: databaseName
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
  dependsOn: [allowAzureServices]
}

// Already the defaults; declared so that a change by hand shows in what-if.
resource requireTls 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2024-08-01' = {
  parent: server
  name: 'require_secure_transport'
  properties: {
    value: 'on'
    source: 'user-override'
  }
  dependsOn: [database]
}

resource minTls 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2024-08-01' = {
  parent: server
  name: 'ssl_min_protocol_version'
  properties: {
    value: 'TLSv1.2'
    source: 'user-override'
  }
  dependsOn: [requireTls]
}

output name string = server.name
output fqdn string = server.properties.fullyQualifiedDomainName
output databaseName string = database.name
