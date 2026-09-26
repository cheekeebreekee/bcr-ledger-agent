#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# Deploys the document index database: infrastructure/db.bicep ONLY.
#
# Usage:
#   infrastructure/db-deploy.sh <env>            # checks + what-if, changes nothing
#   infrastructure/db-deploy.sh <env> --apply    # the same, then deploys after you
#                                                # type the resource group's name
#
# This is NOT deploy.sh and db.bicep is NOT main.bicep. It never deploys
# main.bicep, never zip-deploys an app, and never replaces an app setting:
# db.bicep declares only Microsoft.DBforPostgreSQL resources, deployed in
# incremental mode, so nothing else in the resource group is changed or
# deleted. That is why it is not held by gate G1, which guards the app
# settings a main.bicep deploy replaces.
#
# Before anything else, and again on the what-if result, it refuses:
#   - a template that declares any resource outside Microsoft.DBforPostgreSQL
#     (modules, compiled as Microsoft.Resources/deployments, are looked into);
#   - a what-if that would delete anything, or create or modify anything
#     outside Microsoft.DBforPostgreSQL.
#
# The Entra administrator is the signed-in account (`az ad signed-in-user
# show`), unless DB_ENTRA_ADMIN_OBJECT_ID and DB_ENTRA_ADMIN_UPN are set.
# DB_RESOURCE_GROUP overrides rg-bcr-ledger-<env>. DB_DEPLOY_CONFIRM=<rg>
# answers the confirmation (for a scripted run). Needs az (signed in) and jq.
# -----------------------------------------------------------------------------

set -euo pipefail

lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

ENV_NAME="$(lower "${1:?usage: db-deploy.sh <dev|qa|prod> [--apply]}")"
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
TEMPLATE="$ROOT/infrastructure/db.bicep"
PARAMS="$ROOT/infrastructure/db.${ENV_NAME}.parameters.json"
RG="${DB_RESOURCE_GROUP:-rg-bcr-ledger-${ENV_NAME}}"
if [[ ! -f "$PARAMS" ]]; then
  echo "Refusing: no parameter file infrastructure/db.${ENV_NAME}.parameters.json." >&2
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# ---- 1. The template declares database resources only ------------------------
az bicep build --file "$TEMPLATE" --stdout > "$WORK/template.json"
FOREIGN="$(jq -r '[.. | objects | select(has("type") and has("apiVersion")) | .type]
  | unique | .[] | select(startswith("Microsoft.DBforPostgreSQL/") | not)
  | select(. != "Microsoft.Resources/deployments")' "$WORK/template.json")"
if [[ -n "$FOREIGN" ]]; then
  echo "Refusing: db.bicep declares resources outside Microsoft.DBforPostgreSQL:" >&2
  echo "$FOREIGN" >&2
  exit 1
fi

# ---- 2. The administrator: the signed-in operator ----------------------------
ADMIN_OID="${DB_ENTRA_ADMIN_OBJECT_ID:-$(az ad signed-in-user show --query id -o tsv)}"
ADMIN_UPN="${DB_ENTRA_ADMIN_UPN:-$(az ad signed-in-user show --query userPrincipalName -o tsv)}"
if [[ ! "$ADMIN_OID" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]]; then
  echo "Refusing: the administrator's object id is not a GUID (az ad signed-in-user show failed?)." >&2
  exit 1
fi
if [[ ! "$ADMIN_UPN" =~ ^[^@[:space:]]+@[^@[:space:]]+$ ]]; then
  echo "Refusing: the administrator's UPN does not look like one." >&2
  exit 1
fi

ARGS=(
  --resource-group "$RG"
  --template-file "$TEMPLATE"
  --parameters "@$PARAMS"
  --parameters "entraAdminObjectId=$ADMIN_OID" "entraAdminPrincipalName=$ADMIN_UPN"
  --mode Incremental
)

# ---- 3. What-if (read-only), checked ------------------------------------------
echo "==> What-if: db.bicep into $RG (incremental; administrator $ADMIN_UPN)"
az deployment group what-if "${ARGS[@]}" --no-pretty-print --only-show-errors > "$WORK/what-if.json"
jq -r '.changes[] | select(.changeType != "Ignore" and .changeType != "NoChange")
  | "  \(.changeType)\t\(.resourceId | sub("^.*/providers/"; ""))"' "$WORK/what-if.json"
UNSAFE="$(jq -r '.changes[]
  | select(.changeType == "Delete"
      or ((.changeType == "Create" or .changeType == "Modify" or .changeType == "Deploy")
          and (.resourceId | test("/providers/Microsoft\\.DBforPostgreSQL/"; "i") | not)))
  | "\(.changeType) \(.resourceId)"' "$WORK/what-if.json")"
if [[ -n "$UNSAFE" ]]; then
  echo "Refusing: the what-if would change something that is not the index database:" >&2
  echo "$UNSAFE" >&2
  exit 1
fi
echo "==> What-if clean: only Microsoft.DBforPostgreSQL resources change, nothing is deleted."

if [[ "$APPLY" != true ]]; then
  echo "Nothing deployed. Review the what-if above, then run again with --apply."
  exit 0
fi

# ---- 4. Deploy, after a typed confirmation -------------------------------------
CONFIRM="${DB_DEPLOY_CONFIRM:-}"
if [[ -z "$CONFIRM" ]]; then
  read -r -p "Type the resource group name ($RG) to deploy db.bicep into it: " CONFIRM
fi
if [[ "$CONFIRM" != "$RG" ]]; then
  echo "Refusing: the confirmation does not match $RG. Nothing deployed." >&2
  exit 1
fi
echo "==> Deploying db.bicep into $RG (incremental)"
az deployment group create "${ARGS[@]}" \
  --name "bcr-ledger-db-${ENV_NAME}-$(date -u +%Y%m%dT%H%M%SZ)" \
  --query "properties.outputs.{serverName: serverName.value, serverFqdn: serverFqdn.value, databaseName: databaseName.value}" \
  -o json --only-show-errors > "$WORK/outputs.json"
jq . "$WORK/outputs.json"
echo "==> Done. Next: docs/operations/human-steps.md → Document index release."
