// =============================================================================
// bcr-ledger-agent — email alerts on the ledger's logs. A STANDALONE template.
//
// This is NOT main.bicep and is not part of it. It is deployed on its own, in
// incremental mode, by infrastructure/alerts-deploy.sh (what-if first, then
// --apply), into the environment's resource group. It declares only one
// action group (who gets the email) and the log alert rules
// (Microsoft.Insights/actionGroups, Microsoft.Insights/scheduledQueryRules):
// it never creates, changes or deletes the Function Apps, their app settings,
// the App Insights component, the Log Analytics workspace or anything else
// main.bicep owns. The component the rules query is named, not declared.
// So gate G1, which guards the app settings a main.bicep deploy replaces,
// does not hold this template, and this template cannot undo G1.
//
// What each alert means and what to do first: docs/operations/human-steps.md
// → Alerts. Queries and alert emails carry event names and counts only.
// =============================================================================

targetScope = 'resourceGroup'

@description('Short env name, as in main.bicep (dev/qa/prod). "dev" is production.')
@allowed(['dev', 'qa', 'prod'])
param environmentName string

@description('Region of the alert rules: the region of the App Insights component they query.')
param location string = resourceGroup().location

@description('Who gets the alert emails, one receiver each, in bcr-group.pl. A new address must enter Azure\'s one-time passcode within 30 minutes of the deploy, or it receives nothing; an expired code is resent from the action group in the portal (human-steps.md, Alerts, step 4).')
@minLength(1)
param alertEmails array

@description('Rules to keep disabled, by short name (inbox-heartbeat, anthropic, filing, index, security, bindings, review-notices, search): inbox-heartbeat while INBOX_SWEEP_MODE is off on purpose, or a rule that proved noisy until its query is fixed.')
param disabledRules array = []

@description('Billed Anthropic calls (classification and search) in one hour that count as unusual spend.')
@minValue(1)
param billedCallsPerHour int = 60

@description('Tags applied to every resource.')
param tags object = {
  app: 'bcr-ledger-agent'
  component: 'alerts'
  environment: environmentName
  managedBy: 'bicep'
}

// The same suffix main.bicep derives from the resource group, and its names.
var nameSuffix = '${environmentName}-${uniqueString(resourceGroup().id)}'

module alerts 'modules/alerts.bicep' = {
  name: 'ledgerAlerts'
  params: {
    location: location
    tags: tags
    nameSuffix: nameSuffix
    // Named, never declared: main.bicep owns the component.
    appInsightsId: resourceId('Microsoft.Insights/components', 'appi-bcr-${nameSuffix}')
    ingestionAppName: 'func-bcr-ingest-${nameSuffix}'
    botAppName: 'func-bcr-bot-${nameSuffix}'
    alertEmails: alertEmails
    disabledRules: disabledRules
    billedCallsPerHour: billedCallsPerHour
  }
}

@description('The action group\'s name.')
output actionGroupName string = alerts.outputs.actionGroupName

@description('The alert rules\' names, the heartbeat first.')
output ruleNames array = alerts.outputs.ruleNames
