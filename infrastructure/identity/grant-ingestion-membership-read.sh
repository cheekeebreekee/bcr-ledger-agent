#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# Give the ingestion Function App's system-assigned managed identity the one
# Microsoft Graph application permission its runtime Team-membership check
# needs: Directory.Read.All.
#
# Why: ingestion routes a bound guest only while their Teams are exactly their
# Client Directory row's TeamId (MEMBERSHIP_CHECK_MODE=enforce, R46). It reads
# them with GET /users/{id}/memberOf, and Microsoft Learn lists
# Directory.Read.All as the least privileged application permission for
# another user's memberships:
#   https://learn.microsoft.com/en-us/graph/api/user-list-memberof?view=graph-rest-1.0
# Without it every bound upload is quarantined as membership_unverified.
#
# Usage:
#   infrastructure/identity/grant-ingestion-membership-read.sh
#       --resource-group <rg> --function-app <ingestion app name> [--apply]
#
# Safety model:
#   - Dry run by default: reads and prints the current state, then prints the
#     exact request --apply would send. Nothing is written without --apply.
#   - Grants exactly one app role, Directory.Read.All on Microsoft Graph, to
#     exactly one principal: the app's system-assigned managed identity. Both
#     are fixed here; no argument can name another role, resource or
#     principal. A principal that is not a managed identity stops the run.
#   - Idempotent: if the assignment exists, nothing is sent.
#   - Removes nothing. Rollback is printed at the end, for a person to run.
#
# Who can run --apply: someone who may grant Microsoft Graph application
# permissions (Global Administrator or Privileged Role Administrator), signed
# in with `az login` to the BCR tenant. The dry run needs only read access.
#
# After --apply: a managed identity's token carries its roles as claims, and
# Microsoft documents that the platform caches managed-identity tokens "for
# around 24 hours" and that "it isn't possible to force a managed identity's
# token to be refreshed before its expiry":
#   https://learn.microsoft.com/en-us/entra/identity/managed-identities-azure-resources/managed-identity-best-practice-recommendations#limitation-of-using-managed-identities-for-authorization
# Restarting the Function App drops only the app's own in-process token, so
# it may help, but only waiting is guaranteed to. Grant well before the
# ingestion deploy that turns the check on.
#
# Exit codes: 0 done (or nothing to do); 1 refused or failed.
#
# Uses the Azure CLI only (az, az rest).
# -----------------------------------------------------------------------------
set -euo pipefail

# Microsoft Graph's application id: the same in every tenant.
readonly GRAPH_APP_ID="00000003-0000-0000-c000-000000000000"
# The one permission this script grants. Not a parameter, on purpose.
readonly PERMISSION="Directory.Read.All"
readonly G="https://graph.microsoft.com/v1.0"
readonly GUID_RE='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'

RG=""
APP=""
APPLY=0

usage() { sed -n '3,/^# ---/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; }
die() {
  echo "✖ $*" >&2
  exit 1
}
need() { [[ $# -ge 2 && -n "$2" ]] || die "$1 needs a value"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --resource-group | -g) need "$@"; RG="$2"; shift 2 ;;
    --function-app | -n) need "$@"; APP="$2"; shift 2 ;;
    --apply) APPLY=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done

[[ -n "$RG" ]] || die "--resource-group is required"
[[ -n "$APP" ]] || die "--function-app is required"
command -v az >/dev/null || die "the Azure CLI (az) is not installed"

if [[ $APPLY == 1 ]]; then
  echo "== grant $PERMISSION to $APP's managed identity (APPLY)"
else
  echo "== grant $PERMISSION to $APP's managed identity (dry run: nothing is written)"
fi
echo "   signed in to tenant: $(az account show --query tenantId -o tsv)"

# 1. The Function App's system-assigned managed identity.
MI_ID=$(az functionapp identity show -g "$RG" -n "$APP" --query principalId -o tsv 2>/dev/null || true)
[[ "$MI_ID" =~ $GUID_RE ]] ||
  die "$APP in $RG has no system-assigned managed identity (or the app was not found)"

MI_TYPE=$(az rest --method GET --url "$G/servicePrincipals/$MI_ID?\$select=servicePrincipalType" \
  --query servicePrincipalType -o tsv)
[[ "$MI_TYPE" == "ManagedIdentity" ]] ||
  die "principal $MI_ID is a '$MI_TYPE', not a ManagedIdentity: refusing"
MI_APP_ID=$(az rest --method GET --url "$G/servicePrincipals/$MI_ID?\$select=appId" --query appId -o tsv)
echo "   managed identity:     object id $MI_ID, app id $MI_APP_ID"

# 2. Microsoft Graph's service principal in this tenant, and the role's id.
GRAPH_SP_URL="$G/servicePrincipals(appId='$GRAPH_APP_ID')"
GRAPH_SP_ID=$(az rest --method GET --url "$GRAPH_SP_URL?\$select=id" --query id -o tsv)
[[ "$GRAPH_SP_ID" =~ $GUID_RE ]] || die "Microsoft Graph's service principal was not found"
ROLE_ID=$(az rest --method GET --url "$GRAPH_SP_URL?\$select=appRoles" -o tsv --query \
  "appRoles[?value=='$PERMISSION' && contains(allowedMemberTypes, 'Application')].id | [0]")
[[ "$ROLE_ID" =~ $GUID_RE ]] || die "Microsoft Graph has no application role named $PERMISSION"
echo "   Microsoft Graph:      service principal $GRAPH_SP_ID; $PERMISSION is app role $ROLE_ID"

# 3. What the identity holds now, on every resource.
show_assignments() {
  local rows
  rows=$(az rest --method GET --url "$G/servicePrincipals/$MI_ID/appRoleAssignments" -o tsv \
    --query "value[].[resourceDisplayName, resourceId, appRoleId]")
  if [[ -z "$rows" ]]; then
    echo "   (none)"
    return
  fi
  local graph_roles
  graph_roles=$(az rest --method GET --url "$GRAPH_SP_URL?\$select=appRoles" -o tsv \
    --query "appRoles[].[id, value]")
  while IFS=$'\t' read -r resource resource_id role_id; do
    local value="$role_id"
    if [[ "$resource_id" == "$GRAPH_SP_ID" ]]; then
      value=$(awk -F'\t' -v id="$role_id" '$1 == id { print $2 }' <<<"$graph_roles")
      value=${value:-$role_id}
    fi
    echo "   - $resource: $value"
  done <<<"$rows"
}

echo "-- current application permissions of the managed identity:"
show_assignments

HAS=$(az rest --method GET --url "$G/servicePrincipals/$MI_ID/appRoleAssignments" -o tsv --query \
  "length(value[?resourceId=='$GRAPH_SP_ID' && appRoleId=='$ROLE_ID'])")

ROLLBACK_HINT="Rollback: list the assignment id with
  az rest --method GET --url '$G/servicePrincipals/$MI_ID/appRoleAssignments' \\
    --query \"value[?appRoleId=='$ROLE_ID'].id\" -o tsv
then remove it with
  az rest --method DELETE --url '$G/servicePrincipals/$MI_ID/appRoleAssignments/<assignment id>'
Without the role, every bound upload is quarantined as membership_unverified."

if [[ "$HAS" != "0" ]]; then
  echo "✔ $PERMISSION is already assigned: nothing to do."
  echo "$ROLLBACK_HINT"
  exit 0
fi

BODY=$(printf '{"principalId":"%s","resourceId":"%s","appRoleId":"%s"}' \
  "$MI_ID" "$GRAPH_SP_ID" "$ROLE_ID")
URL="$G/servicePrincipals/$GRAPH_SP_ID/appRoleAssignedTo"

if [[ $APPLY != 1 ]]; then
  echo "-- would send:"
  echo "   POST $URL"
  echo "   $BODY"
  echo "Dry run: nothing was written. Run again with --apply to grant it."
  exit 0
fi

echo "-- sending:"
echo "   POST $URL"
echo "   $BODY"
az rest --method POST --url "$URL" --headers "Content-Type=application/json" --body "$BODY" \
  --query "{id:id, principalId:principalId, appRoleId:appRoleId}" -o json

echo "-- application permissions of the managed identity now:"
show_assignments

HAS=$(az rest --method GET --url "$G/servicePrincipals/$MI_ID/appRoleAssignments" -o tsv --query \
  "length(value[?resourceId=='$GRAPH_SP_ID' && appRoleId=='$ROLE_ID'])")
[[ "$HAS" != "0" ]] || die "the assignment was sent but is not listed yet: run the dry run again in a minute"

cat <<EOF
✔ $PERMISSION granted to $APP's managed identity.
  The running app's token picks the role up only when it is reissued. Microsoft documents a
  platform cache of managed-identity tokens of around 24 hours that cannot be forced. Restart
  the app (az functionapp restart -g $RG -n $APP) to drop its in-process token; if uploads are
  still quarantined as membership_unverified, wait. Grant at least a day before the deploy that
  turns the check on.
$ROLLBACK_HINT
EOF
