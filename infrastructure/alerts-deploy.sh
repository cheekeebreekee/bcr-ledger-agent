#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# Deploys the ledger's email alerts: infrastructure/alerts.bicep ONLY.
#
# Usage:
#   infrastructure/alerts-deploy.sh <env>            # checks + what-if, changes nothing
#   infrastructure/alerts-deploy.sh <env> --apply    # the same, then deploys after you
#                                                    # type the resource group's name
#
# This is NOT deploy.sh and alerts.bicep is NOT main.bicep. It never deploys
# main.bicep, never zip-deploys an app, and never replaces an app setting:
# alerts.bicep declares one action group (ag-bcr-*) and the log alert rules
# (alert-bcr-*), deployed in incremental mode, so nothing else in the
# resource group is changed or deleted. That is why it is not held by gate
# G1, which guards the app settings a main.bicep deploy replaces.
#
# Before anything else, and again on the what-if result, it refuses:
#   - a template that declares any resource type other than
#     Microsoft.Insights/actionGroups and Microsoft.Insights/scheduledQueryRules
#     (exact types: Microsoft.Insights/components, the App Insights component
#     main.bicep owns, is refused too; modules, compiled as
#     Microsoft.Resources/deployments, are looked into);
#   - a what-if that would delete anything, or create or modify anything but
#     an action group named ag-bcr-* or a rule named alert-bcr-* (so Azure's
#     own "Application Insights Smart Detection" group is never touched).
#
# ALERTS_RESOURCE_GROUP overrides rg-bcr-ledger-<env>. ALERTS_DEPLOY_CONFIRM=<rg>
# answers the confirmation (for a scripted run). Needs az (signed in) and jq.
# What each alert means: docs/operations/human-steps.md → Alerts.
# -----------------------------------------------------------------------------

set -euo pipefail

lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

ENV_NAME="$(lower "${1:?usage: alerts-deploy.sh <dev|qa|prod> [--apply]}")"
if [[ ! "$ENV_NAME" =~ ^(dev|qa|prod)$ ]]; then
  echo "Refusing: '$1' is not an environment name (dev|qa|prod)." >&2
  exit 1
fi
APPLY=false
case "${2:-}" in
  "") ;;
  --apply) APPLY=true ;;
  *) echo "Refusing: unknown argument '$2' (only --apply)." >&2; exit 1 ;;
esac

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEMPLATE="$ROOT/infrastructure/alerts.bicep"
PARAMS="$ROOT/infrastructure/alerts.${ENV_NAME}.parameters.json"
RG="${ALERTS_RESOURCE_GROUP:-rg-bcr-ledger-${ENV_NAME}}"
if [[ ! -f "$PARAMS" ]]; then
  echo "Refusing: no parameter file infrastructure/alerts.${ENV_NAME}.parameters.json." >&2
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# ---- 1. The template declares alert resources only ---------------------------
az bicep build --file "$TEMPLATE" --stdout > "$WORK/template.json"
FOREIGN="$(jq -r '[.. | objects | select(has("type") and has("apiVersion")) | .type]
  | unique | .[]
  | select(. != "Microsoft.Insights/actionGroups"
      and . != "Microsoft.Insights/scheduledQueryRules"
      and . != "Microsoft.Resources/deployments")' "$WORK/template.json")"
if [[ -n "$FOREIGN" ]]; then
  echo "Refusing: alerts.bicep declares resources other than action groups and log alert rules:" >&2
  echo "$FOREIGN" >&2
  exit 1
fi

ARGS=(
  --resource-group "$RG"
  --template-file "$TEMPLATE"
  --parameters "@$PARAMS"
  --mode Incremental
)

# ---- 2. What-if (read-only), checked ------------------------------------------
echo "==> What-if: alerts.bicep into $RG (incremental)"
az deployment group what-if "${ARGS[@]}" --no-pretty-print --only-show-errors > "$WORK/what-if.json"
jq -r '.changes[] | select(.changeType != "Ignore" and .changeType != "NoChange")
  | "  \(.changeType)\t\(.resourceId | sub("^.*/providers/"; ""))"' "$WORK/what-if.json"
UNSAFE="$(jq -r '.changes[]
  | select(.changeType != "Ignore" and .changeType != "NoChange")
  | select(.changeType == "Delete"
      or (.resourceId | test("/providers/Microsoft\\.Insights/(actionGroups/ag-bcr-[^/]+|scheduledQueryRules/alert-bcr-[^/]+)$"; "i") | not))
  | "\(.changeType) \(.resourceId)"' "$WORK/what-if.json")"
if [[ -n "$UNSAFE" ]]; then
  echo "Refusing: the what-if would change something that is not the ledger's alerts:" >&2
  echo "$UNSAFE" >&2
  exit 1
fi
echo "==> What-if clean: only ag-bcr-* and alert-bcr-* change, nothing is deleted."

if [[ "$APPLY" != true ]]; then
  echo "Nothing deployed. Review the what-if above, then run again with --apply."
  exit 0
fi

# ---- 3. Deploy, after a typed confirmation -------------------------------------
CONFIRM="${ALERTS_DEPLOY_CONFIRM:-}"
if [[ -z "$CONFIRM" ]]; then
  read -r -p "Type the resource group name ($RG) to deploy alerts.bicep into it: " CONFIRM
fi
if [[ "$CONFIRM" != "$RG" ]]; then
  echo "Refusing: the confirmation does not match $RG. Nothing deployed." >&2
  exit 1
fi
echo "==> Deploying alerts.bicep into $RG (incremental)"
az deployment group create "${ARGS[@]}" \
  --name "bcr-ledger-alerts-${ENV_NAME}-$(date -u +%Y%m%dT%H%M%SZ)" \
  --query "properties.outputs.{actionGroupName: actionGroupName.value, ruleNames: ruleNames.value}" \
  -o json --only-show-errors > "$WORK/outputs.json"
jq . "$WORK/outputs.json"
echo "==> Done. A new email address must enter Azure's one-time passcode within 30 minutes (Resend in the action group if it expired):"
echo "    docs/operations/human-steps.md → Alerts, step 4."
