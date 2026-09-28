#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# Let the bot Function App's system-assigned managed identity call ingestion's
# POST /api/search: add the app role Documents.Search to the Ingestion API app
# registration if it is missing, and assign it to that identity.
#
# Why: client search runs on ingestion, and a search request names the asking
# guest in its body. Ingestion takes it only from a token that carries the
# role Documents.Search and whose app id (appid, else azp) is in
# SEARCH_CALLER_APP_IDS: the bot's managed identity, whose credential cannot
# be exported. The bot's app registration, and so its client secret (T15 in
# docs/security.md), gets neither: the secret still cannot read a document.
# See ARCHITECTURE.md §4.6, docs/security.md T21 and
# docs/operations/human-steps.md, "Client search release".
#
# Usage:
#   export GRAPH_TOKEN=$(node ../bcr-onboarding-agent/tools/graph-login.mjs)
#   infrastructure/identity/grant-bot-search-caller.sh
#       --resource-group <rg> --function-app <bot app name>
#       [--ingestion-app-id <app id>] [--apply]
#
#   --ingestion-app-id is the Ingestion API app registration's application
#   (client) id; by default ingestionAppId from
#   infrastructure/main.dev.parameters.json ("dev" is production).
#
# Tokens:
#   - `az` (signed in with `az login`) is used only to read the Function App's
#     resource id and managed identity from Azure Resource Manager.
#   - Every Microsoft Graph call uses GRAPH_TOKEN, a delegated token. The
#     operator's own Azure CLI Graph token works and is the short route:
#       export GRAPH_TOKEN=$(az account get-access-token \
#         --resource https://graph.microsoft.com --query accessToken -o tsv)
#     In this tenant its scopes carry AppRoleAssignment.ReadWrite.All and
#     Directory.AccessAsUser.All (H-8b's and the client search grant were made
#     with it). AADSTS65002 applies only to SharePoint scopes and to adding new
#     scopes to the CLI's app, never to this grant. The graph-login.mjs token
#     (H-4a's registration) is the other route.
#     The token is sent from a private temporary file, never on a command line,
#     and never printed.
#   - The dry run reads the app registration and service principals:
#     Application.Read.All or Directory.Read.All (delegated) on the token.
#   - --apply also needs AppRoleAssignment.ReadWrite.All (delegated) for the
#     assignment and, only while the role does not exist yet,
#     Application.ReadWrite.All (or Directory.AccessAsUser.All, which the Azure
#     CLI's own Graph token carries) to add it to the registration; each
#     admin-consented on the app registration the token comes from. The signed-in
#     person must be a Global Administrator, a Cloud Application Administrator
#     or an Application Administrator: each of them can do both steps.
#   - Without that consent, make the two changes by hand (the dry run prints
#     both requests; send them from Graph Explorer as in
#     docs/admin-sharepoint-grant.md, Step 1, or add the role in the Entra
#     admin center: App registrations > the Ingestion API > App roles), then
#     run the dry run again: it must report the role as already assigned.
#
# Safety model:
#   - Dry run by default: reads and prints the current state, then prints the
#     exact requests --apply would send. Nothing is written without --apply,
#     and --apply reads everything before it writes anything.
#   - One app role, Documents.Search, on one resource, the Ingestion API, for
#     exactly one principal: the bot Function App's system-assigned managed
#     identity. No argument can name another role or principal. The run stops
#     on an app whose name is not the bot's (func-bcr-bot-*); a principal that
#     is not a managed identity, or not the system-assigned identity of that
#     very app; a GRAPH_TOKEN for another tenant than the one az is signed in
#     to; a Documents.Search role that users could hold or that is disabled;
#     and any other principal that already holds the role.
#   - A role this script creates gets a fixed id (NEW_ROLE_ID below), so every
#     run and every environment names the same role. A role made by hand in
#     the admin center keeps its own id and is used as it is.
#   - Adding the role rewrites the registration's appRoles with every existing
#     role unchanged: Graph's PATCH replaces the whole list.
#   - Idempotent: whatever already exists is not sent again.
#   - Removes nothing. The rollback is printed, for a person to run.
#
# After --apply: the script prints the managed identity's app id. That value,
# and no other, is ingestion's SEARCH_CALLER_APP_IDS. A managed identity's
# token carries its roles, and Microsoft documents that the platform caches
# managed-identity tokens "for around 24 hours" (per resource) and that "it
# isn't possible to force a managed identity's token to be refreshed before
# its expiry":
#   https://learn.microsoft.com/en-us/entra/identity/managed-identities-azure-resources/managed-identity-best-practice-recommendations#limitation-of-using-managed-identities-for-authorization
# The bot's identity has never asked for a token for ingestion, so the first
# one it asks for after the grant carries the role; one asked for before it
# (the bot's SEARCH_MODE turned on too early) may lack it for a day. Grant at
# least a day before the bot's SEARCH_MODE goes on.
#
# Exit codes: 0 done (or nothing to do); 1 refused or failed.
#
# Needs: az, curl, jq.
# -----------------------------------------------------------------------------
set -euo pipefail

# The one app role this script adds and assigns. Not a parameter, on purpose.
readonly ROLE_VALUE="Documents.Search"
# The id the role gets when this script creates it: fixed, so that every run
# and every environment names the same role. Never change it once used.
readonly NEW_ROLE_ID="9a529651-5484-406f-85fb-7a5a062d6a63"
readonly ROLE_DESCRIPTION="Search one bound client's documents in the document index for the guest the request names (POST /api/search). Assigned only to the bot Function App's managed identity."
# main.bicep names the bot Function App func-bcr-bot-<env>-<suffix>.
readonly BOT_APP_PREFIX="func-bcr-bot-"
readonly G="https://graph.microsoft.com/v1.0"
readonly GUID_RE='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
# How long --apply waits for a new role to reach the service principal.
readonly SP_WAIT_TRIES=6
readonly SP_WAIT_SECONDS=10

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
readonly DEFAULT_PARAMS="$SCRIPT_DIR/../main.dev.parameters.json"

RG=""
APP=""
INGESTION_APP_ID=""
APPLY=0

usage() { sed -n '3,/^# ---/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; }
die() {
  echo "✖ $*" >&2
  exit 1
}
need() { [[ $# -ge 2 && -n "$2" ]] || die "$1 needs a value"; }
lower() { tr '[:upper:]' '[:lower:]' <<<"$1"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --resource-group | -g) need "$@"; RG="$2"; shift 2 ;;
    --function-app | -n) need "$@"; APP="$2"; shift 2 ;;
    --ingestion-app-id) need "$@"; INGESTION_APP_ID="$2"; shift 2 ;;
    --apply) APPLY=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done

[[ -n "$RG" ]] || die "--resource-group is required"
[[ -n "$APP" ]] || die "--function-app is required"
[[ "$APP" == "$BOT_APP_PREFIX"* ]] ||
  die "$APP is not the bot Function App ($BOT_APP_PREFIX*): only the bot's managed identity may call search"
for tool in az curl jq; do
  command -v "$tool" >/dev/null || die "$tool is not installed"
done
if [[ -z "$INGESTION_APP_ID" ]]; then
  [[ -f "$DEFAULT_PARAMS" ]] || die "no --ingestion-app-id, and $DEFAULT_PARAMS is missing"
  INGESTION_APP_ID=$(jq -r '.parameters.ingestionAppId.value // empty' "$DEFAULT_PARAMS")
  INGESTION_FROM="ingestionAppId in $(basename "$DEFAULT_PARAMS")"
else
  INGESTION_FROM="--ingestion-app-id"
fi
[[ "$INGESTION_APP_ID" =~ $GUID_RE ]] ||
  die "the Ingestion API app id ($INGESTION_FROM) is not a GUID: '$INGESTION_APP_ID'"
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
  : >"$WORK/out"
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
  echo "== $ROLE_VALUE for $APP's managed identity (APPLY)"
else
  echo "== $ROLE_VALUE for $APP's managed identity (dry run: nothing is written)"
fi

AZ_TENANT=$(az account show --query tenantId -o tsv)
TOKEN_TENANT=$(claim tid 2>/dev/null || true)
[[ -n "$TOKEN_TENANT" ]] || die "GRAPH_TOKEN is not a readable access token"
[[ "$(lower "$TOKEN_TENANT")" == "$(lower "$AZ_TENANT")" ]] ||
  die "GRAPH_TOKEN is for tenant $TOKEN_TENANT, but az is signed in to $AZ_TENANT"
TOKEN_SCOPES=$(claim scp 2>/dev/null || true)
has_scope() { [[ " $TOKEN_SCOPES " == *" $1 "* ]]; }
# Adding the role writes the registration: Application.ReadWrite.All, or
# Directory.AccessAsUser.All (what the Azure CLI's own Graph token carries).
can_write_app() { has_scope Application.ReadWrite.All || has_scope Directory.AccessAsUser.All; }
echo "   tenant:               $AZ_TENANT"
echo "   GRAPH_TOKEN signed in as: $(claim upn 2>/dev/null || echo '?')"

# 1. The bot Function App and its system-assigned managed identity (Azure
#    Resource Manager), checked in Entra: a managed identity, system-assigned,
#    of this very app. Entra lists both in the principal's alternativeNames.
SITE_ID=$(az functionapp show -g "$RG" -n "$APP" --query id -o tsv 2>/dev/null || true)
[[ "$SITE_ID" == /subscriptions/*/providers/Microsoft.Web/sites/* ]] ||
  die "$APP was not found in $RG"
MI_ID=$(az functionapp identity show -g "$RG" -n "$APP" --query principalId -o tsv 2>/dev/null || true)
[[ "$MI_ID" =~ $GUID_RE ]] || die "$APP in $RG has no system-assigned managed identity"
MI=$(graph GET "$G/servicePrincipals/$MI_ID?\$select=id,appId,servicePrincipalType,alternativeNames")
MI_TYPE=$(jq -r '.servicePrincipalType // empty' <<<"$MI")
[[ "$MI_TYPE" == "ManagedIdentity" ]] ||
  die "principal $MI_ID is a '$MI_TYPE', not a ManagedIdentity: refusing"
jq -e --arg site "$(lower "$SITE_ID")" '
  (.alternativeNames // []) | map(ascii_downcase)
  | any(.[]; . == "isexplicit=false") and any(.[]; . == $site)' <<<"$MI" >/dev/null ||
  die "principal $MI_ID is not the system-assigned identity of $SITE_ID: refusing"
MI_APPID=$(jq -r '.appId // empty' <<<"$MI")
[[ "$MI_APPID" =~ $GUID_RE ]] || die "the managed identity $MI_ID has no app id"
echo "   managed identity:     object id $MI_ID, app id $MI_APPID (system-assigned, $APP)"

# 2. The Ingestion API: its app registration (where app roles are defined) and
#    its service principal in this tenant (what an assignment names).
API_APP=$(graph GET "$G/applications(appId='$INGESTION_APP_ID')?\$select=id,appId,displayName,appRoles")
API_OBJ=$(jq -r '.id // empty' <<<"$API_APP")
[[ "$API_OBJ" =~ $GUID_RE ]] || die "no app registration with app id $INGESTION_APP_ID"
API_SP=$(graph GET "$G/servicePrincipals(appId='$INGESTION_APP_ID')?\$select=id,appId,displayName,appRoles")
API_SP_ID=$(jq -r '.id // empty' <<<"$API_SP")
[[ "$API_SP_ID" =~ $GUID_RE ]] || die "the Ingestion API ($INGESTION_APP_ID) has no service principal"
[[ "$MI_APPID" != "$INGESTION_APP_ID" ]] || die "the managed identity is the Ingestion API itself: refusing"
echo "   Ingestion API:        $(jq -r '.displayName // "?"' <<<"$API_APP"), app id $INGESTION_APP_ID ($INGESTION_FROM)"
echo "                         registration $API_OBJ, service principal $API_SP_ID"

# 3. The role on the registration: missing (this script adds it), or there
#    and usable by applications only, enabled.
ROLES_NAMED=$(jq -c --arg v "$ROLE_VALUE" '[.appRoles[]? | select(.value == $v)]' <<<"$API_APP")
case "$(jq length <<<"$ROLES_NAMED")" in
  0)
    ROLE_MISSING=1
    ROLE_ID="$NEW_ROLE_ID"
    if jq -e --arg id "$ROLE_ID" 'any(.appRoles[]?; (.id | ascii_downcase) == $id)' <<<"$API_APP" >/dev/null; then
      die "the Ingestion API already has another app role with id $ROLE_ID: refusing"
    fi
    echo "   app role:             $ROLE_VALUE is not defined yet; it would get id $ROLE_ID"
    ;;
  1)
    ROLE_MISSING=0
    ROLE_ID=$(jq -r '.[0].id' <<<"$ROLES_NAMED")
    [[ "$ROLE_ID" =~ $GUID_RE ]] || die "$ROLE_VALUE has no usable id"
    [[ "$(jq -c '.[0].allowedMemberTypes' <<<"$ROLES_NAMED")" == '["Application"]' ]] ||
      die "$ROLE_VALUE (id $ROLE_ID) allows $(jq -c '.[0].allowedMemberTypes' <<<"$ROLES_NAMED"): it must allow Applications only. Change it in the admin center (App roles > $ROLE_VALUE > Allowed member types: Applications), then run again"
    [[ "$(jq -r '.[0].isEnabled' <<<"$ROLES_NAMED")" == "true" ]] ||
      die "$ROLE_VALUE (id $ROLE_ID) is disabled: enable it, or remove it, then run again"
    echo "   app role:             $ROLE_VALUE is defined, id $ROLE_ID, Applications only, enabled"
    ;;
  *) die "the Ingestion API defines $ROLE_VALUE more than once: fix the registration by hand" ;;
esac

# 4. Who holds the role now: at most this identity.
if [[ $ROLE_MISSING == 1 ]]; then
  HOLDERS='[]'
else
  HOLDERS=$(graph_values "$G/servicePrincipals/$API_SP_ID/appRoleAssignedTo" |
    jq -c --arg r "$ROLE_ID" '[.[] | select(.appRoleId == $r)]')
fi
OTHERS=$(jq -c --arg mi "$MI_ID" '[.[] | select(.principalId != $mi)]' <<<"$HOLDERS")
if [[ "$(jq length <<<"$OTHERS")" != "0" ]]; then
  echo "-- $ROLE_VALUE is held by principals other than $APP's managed identity:" >&2
  jq -r '.[] | "   - \(.principalType // "?") \(.principalDisplayName // "?") (object id \(.principalId)), assignment \(.id)"' \
    <<<"$OTHERS" >&2
  echo "   Only the bot's managed identity may hold it. After checking what each one is, remove it:" >&2
  echo "   curl -sS -X DELETE -H \"Authorization: Bearer \$GRAPH_TOKEN\" '$G/servicePrincipals/$API_SP_ID/appRoleAssignedTo/<assignment id>'" >&2
  die "refusing while another principal holds $ROLE_VALUE"
fi

# 5. What the identity holds now, on every resource.
echo "-- application permissions of the managed identity now:"
NOW=$(graph_values "$G/servicePrincipals/$MI_ID/appRoleAssignments")
show_assignments() {
  jq -r --argjson sp "$API_SP" --arg role "$ROLE_ID" --arg value "$ROLE_VALUE" '
    if length == 0 then "   (none)" else
      .[] | . as $a
      | ([$sp.appRoles[]? | select(.id == $a.appRoleId) | .value][0]
         // (if $a.appRoleId == $role then $value else null end)) as $name
      | "   - \($a.resourceDisplayName): \(if $a.resourceId == $sp.id and $name then $name else $a.appRoleId end)"
    end' <<<"$1"
}
held() {
  jq -r --arg r "$API_SP_ID" --arg role "$ROLE_ID" \
    '[.[] | select(.resourceId == $r and .appRoleId == $role)] | length' <<<"$1"
}
show_assignments "$NOW"

ROLLBACK_HINT="Rollback, with the same GRAPH_TOKEN: find the assignment's id,
  curl -sS -H \"Authorization: Bearer \$GRAPH_TOKEN\" '$G/servicePrincipals/$MI_ID/appRoleAssignments' \\
    | jq -r '.value[] | select(.appRoleId == \"$ROLE_ID\") | .id'
then delete it:
  curl -sS -X DELETE -H \"Authorization: Bearer \$GRAPH_TOKEN\" '$G/servicePrincipals/$MI_ID/appRoleAssignments/<assignment id>'
Set the bot's SEARCH_MODE=off first: without the role ingestion refuses every search (403).
The $ROLE_VALUE role itself can stay on the registration: unassigned, it admits nobody."
CALLER_LINE="SEARCH_CALLER_APP_IDS for ingestion (this value, and no other):
  SEARCH_CALLER_APP_IDS=$MI_APPID"

if [[ $ROLE_MISSING == 0 && "$(held "$NOW")" != "0" ]]; then
  echo "✔ $ROLE_VALUE is already assigned to $APP's managed identity: nothing to do."
  echo "$CALLER_LINE"
  echo "$ROLLBACK_HINT"
  exit 0
fi

NEW_ROLE=$(jq -cn --arg id "$ROLE_ID" --arg v "$ROLE_VALUE" --arg d "$ROLE_DESCRIPTION" \
  '{allowedMemberTypes: ["Application"], description: $d, displayName: $v, id: $id, isEnabled: true, value: $v}')
# Every existing role, unchanged, then the new one. `origin` is read-only and
# must not be sent back.
PATCH_BODY=$(jq -c --argjson role "$NEW_ROLE" \
  '{appRoles: ([.appRoles[]? | {allowedMemberTypes, description, displayName, id, isEnabled, value}] + [$role])}' \
  <<<"$API_APP")
PATCH_URL="$G/applications/$API_OBJ"
ASSIGN_BODY=$(jq -cn --arg p "$MI_ID" --arg r "$API_SP_ID" --arg a "$ROLE_ID" \
  '{principalId: $p, resourceId: $r, appRoleId: $a}')
ASSIGN_URL="$G/servicePrincipals/$API_SP_ID/appRoleAssignedTo"

if [[ $APPLY != 1 ]]; then
  echo "-- would send:"
  if [[ $ROLE_MISSING == 1 ]]; then
    echo "   PATCH $PATCH_URL"
    echo "   $PATCH_BODY"
  fi
  echo "   POST $ASSIGN_URL"
  echo "   $ASSIGN_BODY"
  echo "   Then SEARCH_CALLER_APP_IDS=$MI_APPID on ingestion."
  has_scope AppRoleAssignment.ReadWrite.All ||
    echo "   note: GRAPH_TOKEN has no AppRoleAssignment.ReadWrite.All; --apply will need it"
  if [[ $ROLE_MISSING == 1 ]] && ! can_write_app; then
    echo "   note: GRAPH_TOKEN has no Application.ReadWrite.All; --apply will need it to add the role"
  fi
  echo "Dry run: nothing was written. Run again with --apply to grant it."
  exit 0
fi

# --apply: every scope a write needs, before the first write.
has_scope AppRoleAssignment.ReadWrite.All ||
  die "GRAPH_TOKEN has no delegated AppRoleAssignment.ReadWrite.All: run again with the Azure CLI's Graph token (see --help), or send the dry run's requests from Graph Explorer. Consent on H-4a's registration only as a last resort, and remove it again afterwards (H-4a Rollback)"
if [[ $ROLE_MISSING == 1 ]]; then
  can_write_app ||
    die "GRAPH_TOKEN has no delegated Application.ReadWrite.All, needed to add $ROLE_VALUE to the registration: use the Azure CLI's Graph token (it carries Directory.AccessAsUser.All; see --help), or add the role by hand and run again"
  echo "-- sending:"
  echo "   PATCH $PATCH_URL"
  echo "   $PATCH_BODY"
  graph PATCH "$PATCH_URL" "$PATCH_BODY" >/dev/null
  graph GET "$G/applications/$API_OBJ?\$select=appRoles" |
    jq -e --arg id "$ROLE_ID" --arg v "$ROLE_VALUE" 'any(.appRoles[]?; .id == $id and .value == $v)' >/dev/null ||
    die "the registration does not list $ROLE_VALUE after the PATCH: run the dry run again"
  # The service principal picks the registration's roles up shortly after.
  tries=0
  until graph GET "$G/servicePrincipals/$API_SP_ID?\$select=appRoles" |
    jq -e --arg id "$ROLE_ID" 'any(.appRoles[]?; .id == $id)' >/dev/null; do
    tries=$((tries + 1))
    [[ $tries -lt $SP_WAIT_TRIES ]] ||
      die "$ROLE_VALUE is on the registration, but not yet on its service principal: run this again in a few minutes (it will only assign)"
    sleep "$SP_WAIT_SECONDS"
  done
  echo "   ✔ $ROLE_VALUE added to the registration (id $ROLE_ID)"
fi

echo "-- sending:"
echo "   POST $ASSIGN_URL"
echo "   $ASSIGN_BODY"
graph POST "$ASSIGN_URL" "$ASSIGN_BODY" | jq '{id, principalId, resourceId, appRoleId}'

AFTER=$(graph_values "$G/servicePrincipals/$MI_ID/appRoleAssignments")
echo "-- application permissions of the managed identity after the grant:"
show_assignments "$AFTER"
[[ "$(held "$AFTER")" != "0" ]] ||
  die "the assignment was created but is not listed yet: run the dry run again in a minute"

cat <<EOF
✔ $ROLE_VALUE assigned to $APP's managed identity.
$CALLER_LINE
  The bot's first token for ingestion, asked for once its SEARCH_MODE is on, carries the role. A
  token asked for before this grant (SEARCH_MODE on too early) is cached by the platform for about
  a day without it, and a restart (az functionapp restart -g $RG -n $APP) drops only the app's own
  copy. So keep the bot's SEARCH_MODE off until a day after this grant.
$ROLLBACK_HINT
EOF
