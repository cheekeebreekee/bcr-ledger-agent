#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# The app-settings gate that runs before every Bicep deploy. Read-only.
#
# Usage:
#   infrastructure/app-settings-gate.sh <resource-group> <parameters.json>
#
# A Bicep deploy replaces every app setting of both Function Apps, and what-if
# cannot show that. So before a deploy to apps that already run, this compares
# what the deploy would write with what runs (tools/check-app-settings.mjs
# --live) and fails on any difference.
#
# The comparison is skipped only when there is provably nothing to compare:
# `az group exists` answers false (a new environment), or the resource group
# holds no Function Apps. Any az failure (not signed in, no access, a network
# error) stops the deploy: it must never read as "no apps yet".
#
# Exit: 0 go on; anything else stop. infrastructure/deploy.sh and
# .github/workflows/deploy.yml both run it, so the two cannot drift apart.
# -----------------------------------------------------------------------------

set -euo pipefail

RG="${1:?missing resource group}"
PARAMS="${2:?missing parameters file}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# az's own error, if any, goes to stderr as it is: the reason must be readable.
if ! EXISTS="$(az group exists -n "$RG")"; then
  echo "Refusing: could not tell whether resource group $RG exists (az failed, above)." >&2
  exit 1
fi
case "$EXISTS" in
  false)
    echo "==> $RG does not exist yet: a new environment, no running app settings to compare"
    exit 0
    ;;
  true) ;;
  *)
    echo "Refusing: 'az group exists -n $RG' answered '$EXISTS', not true or false." >&2
    exit 1
    ;;
esac

if ! APPS="$(az functionapp list -g "$RG" --query "[].name" -o tsv)"; then
  echo "Refusing: could not list the Function Apps in $RG (az failed, above)." >&2
  exit 1
fi
if [[ -z "$APPS" ]]; then
  echo "==> No Function Apps in $RG yet: no running app settings to compare"
  exit 0
fi

echo "==> Comparing the template's app settings with the running apps in $RG (read-only)"
node "$ROOT/tools/check-app-settings.mjs" --live -g "$RG" -p "$PARAMS"
