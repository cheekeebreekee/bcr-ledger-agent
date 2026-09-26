#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# Deploys the bcr-ledger-agent infrastructure and code to one environment.
#
# Usage:
#   [EXPECTED_SETTING_CHANGES=NAME[,NAME...]] ./infrastructure/deploy.sh <env> [<resource-group>]
#
# EXPECTED_SETTING_CHANGES names the app settings this deploy is meant to
# change, after reviewing `tools/check-app-settings.mjs --live --expect` with
# the same names (docs/deployment.md §3a). Any other difference between the
# template and the running apps stops the deploy.
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

lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

# Lower-cased before any use: resource-group names are case-insensitive in
# Azure, and on the default case-insensitive macOS file system "Dev" opens
# main.dev.parameters.json, so "Dev" is dev.
ENV_NAME="$(lower "${1:?missing environment (dev|qa|prod)}")"
if [[ ! "$ENV_NAME" =~ ^[a-z0-9-]+$ ]]; then
  echo "Refusing: '$1' is not an environment name (dev|qa|prod)." >&2
  exit 1
fi
RG="${2:-rg-bcr-ledger-${ENV_NAME}}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PARAMS="$ROOT/infrastructure/main.${ENV_NAME}.parameters.json"
if [[ ! -f "$PARAMS" ]]; then
  echo "Refusing: no parameter file infrastructure/main.${ENV_NAME}.parameters.json." >&2
  exit 1
fi
PARAM_ENV="$(lower "$(jq -r '.parameters.environmentName.value // empty' "$PARAMS")")"

# "dev" is production (it serves a real client), and this deploy replaces
# every app setting of both apps. main.bicep with main.dev.parameters.json now
# records the settings dev runs with (gate G1), but the WEBSITE_RUN_FROM_PACKAGE
# carry-over in modules/functionApp.bicep has never run against a real app.
# This refusal goes only in a reviewed commit of its own, after the "Lifting
# gate G1" checklist in docs/operations/human-steps.md: a rehearsal on a
# throwaway resource group, a clean `tools/check-app-settings.mjs --live`
# against rg-bcr-ledger-dev, a reviewed what-if. Until then, deploy dev as
# code-only zips (the same page). Dev is recognised by the environment name,
# by its resource group (an explicit second argument too) and by the parameter
# file's environmentName, all case-insensitively.
if [[ "${ALLOW_DEV_BICEP:-}" != "i-have-fixed-the-drift" ]] &&
  [[ "$ENV_NAME" == "dev" || "$(lower "$RG")" == "rg-bcr-ledger-dev" || "$PARAM_ENV" == "dev" ]]; then
  echo "Refusing: dev is production; Bicep deploys to it wait for 'Lifting gate G1'." >&2
  echo "Deploy code-only zips as in docs/operations/human-steps.md." >&2
  exit 1
fi
LOCATION="${AZURE_LOCATION:-westeurope}"

# Build and package before touching Azure: a failed package stops here, with
# no infrastructure changed and no zip left at artifacts/ (the package script
# deletes the old one first).
echo "==> Installing dependencies (yarn.lock, immutable)"
(cd "$ROOT" && corepack yarn install --immutable)

echo "==> Packaging teams-bot (clean build, lockfile dependencies)"
(cd "$ROOT" && corepack yarn workspace @bcr/teams-bot package)

echo "==> Packaging document-ingestion (clean build, lockfile dependencies)"
(cd "$ROOT" && corepack yarn workspace @bcr/document-ingestion package)

for pkg in teams-bot document-ingestion; do
  if [[ ! -s "$ROOT/artifacts/$pkg.zip" ]]; then
    echo "Refusing: artifacts/$pkg.zip was not built." >&2
    exit 1
  fi
done

# The template replaces every app setting, and what-if cannot show that. If
# the apps already run, a setting set by hand and not recorded in the
# parameters file would be deleted or reverted: the gate compares them
# (read-only) and stops on any difference not named in
# EXPECTED_SETTING_CHANGES, which it reads from the environment. It passes a
# resource group that does not exist yet, or has no Function Apps; any az
# failure stops here.
bash "$ROOT/infrastructure/app-settings-gate.sh" "$RG" "$PARAMS"

echo "==> Ensuring resource group $RG exists in $LOCATION"
az group create --name "$RG" --location "$LOCATION" --output none

echo "==> Deploying Bicep template ($ENV_NAME)"
DEPLOY_OUT=$(az deployment group create \
  --resource-group "$RG" \
  --name "bcr-ledger-${ENV_NAME}-$(date +%Y%m%d-%H%M%S)" \
  --template-file "$ROOT/infrastructure/main.bicep" \
  --parameters "@$PARAMS" \
  --output json)

BOT_FUNC=$(echo "$DEPLOY_OUT" | jq -r '.properties.outputs.botFunctionName.value')
INGEST_FUNC=$(echo "$DEPLOY_OUT" | jq -r '.properties.outputs.ingestionFunctionName.value')

echo "==> Bot function:      $BOT_FUNC"
echo "==> Ingestion function: $INGEST_FUNC"

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
echo "  2. Put the Anthropic key under 'anthropic-api-key' (only if ANTHROPIC_ENABLED=true)."
echo "  3. Change app settings in main.${ENV_NAME}.parameters.json, never only in Azure: the next deploy"
echo "     replaces them all (tools/check-app-settings.mjs --live shows any difference). A deploy meant"
echo "     to change some names them in EXPECTED_SETTING_CHANGES (docs/deployment.md §3a)."
echo "  4. Grant write to the ingestion Function App's managed identity on the quarantine site and on"
echo "     each client site only (infrastructure/quarantine/README.md), never on BCR GROUP."
