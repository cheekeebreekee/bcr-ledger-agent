// =============================================================================
// bcr-ledger-agent — the document index database. A STANDALONE template.
//
// This is NOT main.bicep and is not part of it. It is deployed on its own, in
// incremental mode, by infrastructure/db-deploy.sh (what-if first, then
// --apply), into the environment's resource group. It declares only the
// PostgreSQL server and its children (administrator, firewall rule,
// database, TLS settings): it never creates, changes or deletes the Function
// Apps, their app settings, or anything else main.bicep owns. (A main.bicep
// deploy replaces every app setting; this one sets none. The ingestion app's
// LEDGER_* settings are recorded in main.bicep and main.<env>.parameters.json
// and changed as the release runbook says.)
//
// The Entra administrator is the operator, passed at deploy time (db-deploy.sh
// reads the signed-in user), so no person's id is committed here.
// =============================================================================

targetScope = 'resourceGroup'

@description('Short env name, as in main.bicep (dev/qa/prod). "dev" is production.')
@allowed(['dev', 'qa', 'prod'])
param environmentName string

@description('Azure region.')
param location string = resourceGroup().location

@description('Object id of the Entra user who administers the server: the operator.')
param entraAdminObjectId string

@description('That user\'s UPN. It is also the PostgreSQL login name the administrator connects with.')
param entraAdminPrincipalName string

@description('User for a person; Group for an Entra group of administrators.')
@allowed(['User', 'Group'])
param entraAdminPrincipalType string = 'User'

@description('Geo-redundant backup storage (paired region). Supported on Burstable; fixed at creation.')
@allowed(['Enabled', 'Disabled'])
param geoRedundantBackup string = 'Enabled'

@description('Tags applied to every resource.')
param tags object = {
  app: 'bcr-ledger-agent'
  component: 'document-index'
  environment: environmentName
  managedBy: 'bicep'
}

// The same suffix main.bicep derives from the resource group.
var serverName = 'psql-bcr-${environmentName}-${uniqueString(resourceGroup().id)}'

module postgres 'modules/postgres.bicep' = {
  name: 'ledgerIndexPostgres'
  params: {
    name: serverName
    location: location
    tags: tags
    entraAdminObjectId: entraAdminObjectId
    entraAdminPrincipalName: entraAdminPrincipalName
    entraAdminPrincipalType: entraAdminPrincipalType
    geoRedundantBackup: geoRedundantBackup
    databaseName: 'ledger'
  }
}

@description('The server name, for az postgres flexible-server commands.')
output serverName string = postgres.outputs.name

@description('LEDGER_DB_HOST.')
output serverFqdn string = postgres.outputs.fqdn

@description('LEDGER_DB_NAME.')
output databaseName string = postgres.outputs.databaseName
