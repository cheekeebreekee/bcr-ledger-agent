#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# Deploys the bcr-ledger-agent infrastructure and code to one environment.
#
# Usage:
#   ./infrastructure/deploy.sh <env> [<resource-group>]
#
# Prerequisites:
#   - `az login` already executed with rights on the subscription / RG
#   - Bot Framework AAD App + Ingestion API AAD App already created
#   - Parameter file `main.<env>.parameters.json` already filled in
#
# This script is intentionally simple. CI runs the equivalent steps via the
# GitHub Actions workflow in `.github/workflows/deploy.yml`.
# -----------------------------------------------------------------------------

set -euo pipefail

ENV_NAME="${1:?missing environment (dev|qa|prod)}"
RG="${2:-rg-bcr-ledger-${ENV_NAME}}"
LOCATION="${AZURE_LOCATION:-westeurope}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "==> Ensuring resource group $RG exists in $LOCATION"
az group create --name "$RG" --location "$LOCATION" --output none

echo "==> Deploying Bicep template ($ENV_NAME)"
DEPLOY_OUT=$(az deployment group create \
  --resource-group "$RG" \
  --name "bcr-ledger-${ENV_NAME}-$(date +%Y%m%d-%H%M%S)" \
  --template-file "$ROOT/infrastructure/main.bicep" \
  --parameters "@$ROOT/infrastructure/main.${ENV_NAME}.parameters.json" \
  --output json)

BOT_FUNC=$(echo "$DEPLOY_OUT" | jq -r '.properties.outputs.botFunctionName.value')
INGEST_FUNC=$(echo "$DEPLOY_OUT" | jq -r '.properties.outputs.ingestionFunctionName.value')

echo "==> Bot function:      $BOT_FUNC"
echo "==> Ingestion function: $INGEST_FUNC"

echo "==> Building all packages"
(cd "$ROOT" && yarn install --immutable && yarn build)

echo "==> Packaging teams-bot"
(cd "$ROOT" && yarn workspace @bcr/teams-bot package)

echo "==> Packaging document-ingestion"
(cd "$ROOT" && yarn workspace @bcr/document-ingestion package)

echo "==> Deploying teams-bot code"
az functionapp deployment source config-zip \
  --resource-group "$RG" \
  --name "$BOT_FUNC" \
  --src "$ROOT/artifacts/teams-bot.zip"

echo "==> Deploying document-ingestion code"
az functionapp deployment source config-zip \
  --resource-group "$RG" \
  --name "$INGEST_FUNC" \
  --src "$ROOT/artifacts/document-ingestion.zip"

echo "✅ Deployment complete."
echo "Don't forget:"
echo "  1. Put the bot's client secret into Key Vault under 'bot-app-password'."
echo "  2. Put the Document Intelligence key under 'document-intelligence-key'."
echo "  3. Grant the ingestion Function App's managed identity 'Sites.Selected' on the SharePoint site."
