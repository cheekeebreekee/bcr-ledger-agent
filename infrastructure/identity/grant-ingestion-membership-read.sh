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
#   export GRAPH_TOKEN=$(node ../bcr-onboarding-agent/tools/graph-login.mjs)
#   infrastructure/identity/grant-ingestion-membership-read.sh
#       --resource-group <rg> --function-app <ingestion app name> [--apply]
#
# Tokens:
#   - `az` (signed in with `az login`) is used only to read the Function App's
#     managed identity from Azure Resource Manager.
#   - Every Microsoft Graph call uses GRAPH_TOKEN, a delegated token. The
#     operator's own Azure CLI Graph token works and is the short route:
#       export GRAPH_TOKEN=$(az account get-access-token \
#         --resource https://graph.microsoft.com --query accessToken -o tsv)
#     In this tenant its scopes carry AppRoleAssignment.ReadWrite.All and
#     Directory.AccessAsUser.All (H-8b's grant was made with it). AADSTS65002
#     applies only to SharePoint scopes and to adding new scopes to the CLI's
#     app, never to this grant. The graph-login.mjs token (H-4a's
#     registration) is the other route.
#     The token is sent from a private temporary file, never on a command line,
#     and never printed.
#   - The dry run needs to read service principals: Directory.Read.All or
#     Application.Read.All (delegated) on the token.
#   - --apply also needs AppRoleAssignment.ReadWrite.All (delegated, admin-
#     consented on the app registration the token comes from), and the signed-
#     in person must be a Global Administrator or Privileged Role
#     Administrator: nobody else may assign Microsoft Graph app roles.
#   - Without that consent, send the one POST the dry run prints from Graph
#     Explorer instead (docs/admin-sharepoint-grant.md, Step 1), then run the
#     dry run again: it must report the role as already assigned.
#
# Safety model:
#   - Dry run by default: reads and prints the current state, then prints the
#     exact request --apply would send. Nothing is written without --apply.
#   - Grants exactly one app role, Directory.Read.All on Microsoft Graph, to
#     exactly one principal: the app's system-assigned managed identity. Both
#     are fixed here; no argument can name another role, resource or
#     principal. A principal that is not a managed identity stops the run, and
#     so does a token for another tenant than the one az is signed in to.
#   - Idempotent: if the assignment exists, nothing is sent.
#   - Removes nothing. The rollback is printed, for a person to run.
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
# Needs: az, curl, jq.
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
for tool in az curl jq; do
  command -v "$tool" >/dev/null || die "$tool is not installed"
done
[[ -n "${GRAPH_TOKEN:-}" ]] ||
  die "GRAPH_TOKEN is not set: export GRAPH_TOKEN=\$(node ../bcr-onboarding-agent/tools/graph-login.mjs)"

# The token goes to curl from a file only this user can read, so it never
# appears in a process listing.
umask 077
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
printf 'Authorization: Bearer %s\n' "$GRAPH_TOKEN" >"$WORK/auth"

# graph METHOD URL [BODY] -> the response body on stdout; stops on any non-2xx.
graph() {
  local method=$1 url=$2 body=${3-} status code
  local args=(-sS -g -o "$WORK/out" -w '%{http_code}' -X "$method" -H "@$WORK/auth"
    -H 'Accept: application/json')
  if [[ -n "$body" ]]; then
    args+=(-H 'Content-Type: application/json' --data "$body")
  fi
  status=$(curl "${args[@]}" "$url") || die "$method $url: the request did not complete"
  if [[ "$status" != 2* ]]; then
    code=$(jq -r '.error.code // empty' <"$WORK/out" 2>/dev/null || true)
    die "$method $url: HTTP $status ${code:-}"
  fi
  cat "$WORK/out"
}

# graph_values URL -> every `value` entry of every page, as one JSON array.
graph_values() {
  local url=$1 page
  : >"$WORK/values"
  while [[ -n "$url" ]]; do
    page=$(graph GET "$url")
    jq -c '.value[]' <<<"$page" >>"$WORK/values"
    url=$(jq -r '."@odata.nextLink" // empty' <<<"$page")
  done
  jq -s '.' <"$WORK/values"
}

# One claim of the token's payload, without printing the token.
claim() {
  jq -Rr --arg c "$1" '
    split(".")[1] | gsub("-"; "+") | gsub("_"; "/")
    | (if length % 4 == 0 then . else . + ("=" * (4 - length % 4)) end)
    | @base64d | fromjson | .[$c] // empty' <<<"$GRAPH_TOKEN"
}

if [[ $APPLY == 1 ]]; then
  echo "== grant $PERMISSION to $APP's managed identity (APPLY)"
else
  echo "== grant $PERMISSION to $APP's managed identity (dry run: nothing is written)"
fi

AZ_TENANT=$(az account show --query tenantId -o tsv)
TOKEN_TENANT=$(claim tid 2>/dev/null || true)
[[ -n "$TOKEN_TENANT" ]] || die "GRAPH_TOKEN is not a readable access token"
lower() { tr '[:upper:]' '[:lower:]' <<<"$1"; }
[[ "$(lower "$TOKEN_TENANT")" == "$(lower "$AZ_TENANT")" ]] ||
  die "GRAPH_TOKEN is for tenant $TOKEN_TENANT, but az is signed in to $AZ_TENANT"
TOKEN_SCOPES=$(claim scp 2>/dev/null || true)
echo "   tenant:               $AZ_TENANT"
echo "   GRAPH_TOKEN signed in as: $(claim upn 2>/dev/null || echo '?')"
if [[ " $TOKEN_SCOPES " != *" AppRoleAssignment.ReadWrite.All "* ]]; then
  if [[ $APPLY == 1 ]]; then
    die "GRAPH_TOKEN has no delegated AppRoleAssignment.ReadWrite.All: run again with the Azure CLI's Graph token (see --help), or send the dry run's request from Graph Explorer. Consent on H-4a's registration only as a last resort, and remove it again afterwards (H-4a Rollback)"
  fi
  echo "   note: GRAPH_TOKEN has no AppRoleAssignment.ReadWrite.All; --apply will need it"
fi

# 1. The Function App's system-assigned managed identity (Azure Resource Manager).
MI_ID=$(az functionapp identity show -g "$RG" -n "$APP" --query principalId -o tsv 2>/dev/null || true)
[[ "$MI_ID" =~ $GUID_RE ]] ||
  die "$APP in $RG has no system-assigned managed identity (or the app was not found)"
MI=$(graph GET "$G/servicePrincipals/$MI_ID?\$select=id,appId,servicePrincipalType")
MI_TYPE=$(jq -r '.servicePrincipalType // empty' <<<"$MI")
[[ "$MI_TYPE" == "ManagedIdentity" ]] ||
  die "principal $MI_ID is a '$MI_TYPE', not a ManagedIdentity: refusing"
echo "   managed identity:     object id $MI_ID, app id $(jq -r .appId <<<"$MI")"

# 2. Microsoft Graph's service principal in this tenant, and the role's id.
GRAPH_SP=$(graph GET "$G/servicePrincipals(appId='$GRAPH_APP_ID')?\$select=id,appRoles")
GRAPH_SP_ID=$(jq -r '.id // empty' <<<"$GRAPH_SP")
[[ "$GRAPH_SP_ID" =~ $GUID_RE ]] || die "Microsoft Graph's service principal was not found"
ROLE_ID=$(jq -r --arg v "$PERMISSION" \
  '[.appRoles[] | select(.value == $v and (.allowedMemberTypes | index("Application")))][0].id // empty' \
  <<<"$GRAPH_SP")
[[ "$ROLE_ID" =~ $GUID_RE ]] || die "Microsoft Graph has no application role named $PERMISSION"
echo "   Microsoft Graph:      service principal $GRAPH_SP_ID; $PERMISSION is app role $ROLE_ID"

# 3. What the identity holds now, on every resource.
assignments() { graph_values "$G/servicePrincipals/$MI_ID/appRoleAssignments"; }
show_assignments() {
  jq -r --argjson sp "$GRAPH_SP" '
    if length == 0 then "   (none)" else
      .[] | . as $a
      | ([$sp.appRoles[] | select(.id == $a.appRoleId) | .value][0]) as $name
      | "   - \($a.resourceDisplayName): \(if $a.resourceId == $sp.id and $name then $name else $a.appRoleId end)"
    end' <<<"$1"
}
held() {
  jq -r --arg r "$GRAPH_SP_ID" --arg role "$ROLE_ID" \
    '[.[] | select(.resourceId == $r and .appRoleId == $role)] | length' <<<"$1"
}

NOW=$(assignments)
echo "-- application permissions of the managed identity now:"
show_assignments "$NOW"

ROLLBACK_HINT="Rollback, with the same GRAPH_TOKEN: find the assignment's id,
  curl -sS -H \"Authorization: Bearer \$GRAPH_TOKEN\" '$G/servicePrincipals/$MI_ID/appRoleAssignments' \\
    | jq -r '.value[] | select(.appRoleId == \"$ROLE_ID\") | .id'
then delete it:
  curl -sS -X DELETE -H \"Authorization: Bearer \$GRAPH_TOKEN\" '$G/servicePrincipals/$MI_ID/appRoleAssignments/<assignment id>'
Without the role, every bound upload is quarantined as membership_unverified."

if [[ "$(held "$NOW")" != "0" ]]; then
  echo "✔ $PERMISSION is already assigned: nothing to do."
  echo "$ROLLBACK_HINT"
  exit 0
fi

BODY=$(jq -cn --arg p "$MI_ID" --arg r "$GRAPH_SP_ID" --arg a "$ROLE_ID" \
  '{principalId: $p, resourceId: $r, appRoleId: $a}')
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
graph POST "$URL" "$BODY" | jq '{id, principalId, resourceId, appRoleId}'

AFTER=$(assignments)
echo "-- application permissions of the managed identity after the grant:"
show_assignments "$AFTER"
[[ "$(held "$AFTER")" != "0" ]] ||
  die "the assignment was created but is not listed yet: run the dry run again in a minute"

cat <<EOF
✔ $PERMISSION granted to $APP's managed identity.
  The running app's token picks the role up only when it is reissued. Microsoft documents a
  platform cache of managed-identity tokens of around 24 hours that cannot be forced. Restart
  the app (az functionapp restart -g $RG -n $APP) to drop its in-process token; if uploads are
  still quarantined as membership_unverified, wait. Grant at least a day before the deploy that
  turns the check on.
$ROLLBACK_HINT
EOF
