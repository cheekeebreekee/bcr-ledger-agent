#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# Phase 0: the admin steps an agent may not run (permission grants), in one
# place. Run it yourself, signed in with `az login` as a Global Administrator.
#
# Usage:
#   tools/ops/phase0-admin.sh consent       H-4a: operator-tool consents (restores + extends)
#   tools/ops/phase0-admin.sh quarantine    H-5 columns + H-6 grant, after the site exists
#   tools/ops/phase0-admin.sh membership    ingestion identity: read Team memberships
#   tools/ops/phase0-admin.sh bricore       T-6: Bricore team to Private (Roman's call)
#
# Every step prints what it will change and asks first; each is idempotent and
# prints the resulting state. Run from the repository root, in bash.
# See docs/operations/human-steps.md for the why of each step.
# -----------------------------------------------------------------------------
set -euo pipefail

RG=rg-bcr-ledger-dev
INGEST=func-bcr-ingest-dev-vyyintffz6ehq
ONB_RG=rg-bcr-onboarding-dev
AA=aa-bcr-onboarding-dev
SP_HOST=bcrgroupeu.sharepoint.com
Q_PATH=/sites/BCRLedgerKwarantanna
OPERATOR_APP_NAME='BCR Onboarding - list provisioning'
GRAPH_APP=00000003-0000-0000-c000-000000000000
SPO_APP=00000003-0000-0ff1-ce00-000000000000
GRAPH_SCOPES='openid profile offline_access Sites.Manage.All Sites.Read.All Sites.ReadWrite.All User.Read.All GroupMember.Read.All Group.Read.All Channel.ReadBasic.All'
G=https://graph.microsoft.com/v1.0

die() { echo "✖ $*" >&2; exit 1; }
ask() { read -r -p "$1 [y/N] " a; [[ $a == y || $a == Y ]]; }
graph() {
  local args=(rest --method "$1" --url "$2" -o json)
  [[ $# -ge 3 ]] && args+=(--headers Content-Type=application/json --body "$3")
  az "${args[@]}"
}

preflight() {
  command -v az >/dev/null || die 'az not found'
  command -v jq >/dev/null || die 'jq not found'
  local upn
  upn=$(az account show --query user.name -o tsv) || die 'run az login first'
  echo "Signed in as $upn"
}

# --- H-4a --------------------------------------------------------------------
step_consent() {
  local app_id sp_id graph_sp spo_sp grants gid sid
  app_id=$(az ad app list --display-name "$OPERATOR_APP_NAME" --query '[0].appId' -o tsv)
  [[ -n $app_id ]] || die "app registration '$OPERATOR_APP_NAME' not found"
  sp_id=$(az ad sp show --id "$app_id" --query id -o tsv)
  graph_sp=$(az ad sp show --id "$GRAPH_APP" --query id -o tsv)
  spo_sp=$(az ad sp show --id "$SPO_APP" --query id -o tsv)
  grants=$(graph get "$G/oauth2PermissionGrants?\$filter=clientId eq '$sp_id'")
  gid=$(jq -r --arg r "$graph_sp" '[.value[] | select(.resourceId == $r and .consentType == "AllPrincipals")][0].id // empty' <<<"$grants")
  sid=$(jq -r --arg r "$spo_sp" '[.value[] | select(.resourceId == $r and .consentType == "AllPrincipals")][0].id // empty' <<<"$grants")
  echo "Operator app '$OPERATOR_APP_NAME' ($app_id). Current tenant-wide consents:"
  jq -r '.value[] | "  \(.resourceId): \(.scope)"' <<<"$grants"
  echo "Will set Microsoft Graph (delegated) to: $GRAPH_SCOPES"
  echo "Will set SharePoint (delegated) to: AllSites.Read"
  ask 'Apply?' || return 0
  if [[ -n $gid ]]; then
    graph patch "$G/oauth2PermissionGrants/$gid" "{\"scope\":\"$GRAPH_SCOPES\"}" >/dev/null
  else
    graph post "$G/oauth2PermissionGrants" \
      "{\"clientId\":\"$sp_id\",\"consentType\":\"AllPrincipals\",\"resourceId\":\"$graph_sp\",\"scope\":\"$GRAPH_SCOPES\"}" >/dev/null
  fi
  if [[ -n $sid ]]; then
    graph patch "$G/oauth2PermissionGrants/$sid" '{"scope":"AllSites.Read"}' >/dev/null
  else
    graph post "$G/oauth2PermissionGrants" \
      "{\"clientId\":\"$sp_id\",\"consentType\":\"AllPrincipals\",\"resourceId\":\"$spo_sp\",\"scope\":\"AllSites.Read\"}" >/dev/null
  fi
  echo 'Now:'
  graph get "$G/oauth2PermissionGrants?\$filter=clientId eq '$sp_id'" | jq -r '.value[] | "  \(.resourceId): \(.scope)"'
}

# A delegated Graph token from the operator app (device code: you sign in).
operator_token() {
  local app_id tenant
  app_id=$(az ad app list --display-name "$OPERATOR_APP_NAME" --query '[0].appId' -o tsv)
  tenant=$(az account show --query tenantId -o tsv)
  GRAPH_CLIENT_ID=$app_id GRAPH_TENANT_ID=$tenant node ../bcr-onboarding-agent/tools/graph-login.mjs
}

# --- H-5 columns + H-6 grant ---------------------------------------------------
step_quarantine() {
  local tok site q_site q_list dir_site drive web cols mi_appid job status
  echo "Signing in for a Graph token (device code, on stderr)…"
  tok=$(operator_token) || die 'sign-in failed; run the consent step first'
  g() { curl -sSf -H "Authorization: Bearer $tok" -H 'Content-Type: application/json' "$@"; }
  site=$(g "$G/sites/$SP_HOST:$Q_PATH?\$select=id,webUrl") \
    || die "no site at $Q_PATH: create it first (SharePoint admin centre → Create → Communication site)"
  q_site=$(jq -r .id <<<"$site"); web=$(jq -r .webUrl <<<"$site")
  [[ $web == *"$Q_PATH" ]] || die "unexpected site $web"
  dir_site=$(az functionapp config appsettings list -g "$RG" -n "$INGEST" \
    --query "[?name=='CLIENT_DIRECTORY_SITE_ID'].value | [0]" -o tsv)
  [[ $(cut -d, -f2 <<<"$q_site") != "$(cut -d, -f2 <<<"$dir_site")" ]] || die 'that is BCR GROUP; stop'
  drive=$(g "$G/sites/$q_site/drive?\$select=name" | jq -r .name)
  q_list=$(g "$G/sites/$q_site/drive/list?\$select=id" | jq -r .id)
  echo "Quarantine site: $web"
  echo "Library: $drive (H-8 set QUARANTINE_DRIVE_NAME=Dokumenty)"
  [[ $drive == Dokumenty ]] || echo "  ! fix with: az functionapp config appsettings set -g $RG -n $INGEST -o none --settings QUARANTINE_DRIVE_NAME='$drive'"
  cols=$(g "$G/sites/$q_site/lists/$q_list/columns?\$select=name" | jq -r '.value[].name')
  for c in UploaderOid QuarantineReason OriginalFilename DocumentId; do
    if grep -qx "$c" <<<"$cols"; then echo "  column $c: exists"; continue; fi
    if ask "Create text column $c?"; then
      g -X POST "$G/sites/$q_site/lists/$q_list/columns" -d "{\"name\":\"$c\",\"text\":{}}" >/dev/null
      echo "  column $c: created"
    fi
  done
  mi_appid=$(az ad sp show --id "$(az functionapp identity show -g "$RG" -n "$INGEST" --query principalId -o tsv)" --query appId -o tsv)
  [[ $mi_appid =~ ^[0-9a-f-]{36}$ ]] || die 'could not resolve the ingestion managed identity'
  echo "H-6: grant 'write' on this site to the ingestion managed identity (app id $mi_appid)"
  echo "     via runbook Grant-TeamSiteAccess in $AA."
  ask 'Start the runbook?' || return 0
  job=$(az automation runbook start -g "$ONB_RG" --automation-account-name "$AA" -n Grant-TeamSiteAccess \
    --parameters SiteId="$q_site" AppId="$mi_appid" AppDisplayName='BCR ledger ingestion' --query name -o tsv 2>/dev/null)
  echo "  job $job"
  for _ in $(seq 1 30); do
    status=$(az automation job show -g "$ONB_RG" --automation-account-name "$AA" -n "$job" --query status -o tsv 2>/dev/null)
    [[ $status == Completed || $status == Failed || $status == Stopped || $status == Suspended ]] && break
    sleep 10
  done
  echo "  status: $status"
  az rest --method get -o tsv --url \
    "https://management.azure.com$(az automation account show -g "$ONB_RG" -n "$AA" --query id -o tsv 2>/dev/null)/jobs/$job/output?api-version=2023-11-01" \
    | tail -3
  echo 'Expect "outcome": "granted" or "exists". It takes about 5 minutes to take effect.'
}

# --- membership read for the ingestion identity ------------------------------------
step_membership() {
  local s=infrastructure/identity/grant-ingestion-membership-read.sh
  [[ -f $s ]] || die "$s is not on this branch yet"
  # Your own az login's Graph token already carries AppRoleAssignment.ReadWrite.All,
  # so no further consent is needed. It stays in the environment of this run only.
  if [[ -z ${GRAPH_TOKEN:-} ]]; then
    GRAPH_TOKEN=$(az account get-access-token --resource https://graph.microsoft.com --query accessToken -o tsv)
    export GRAPH_TOKEN
  fi
  echo 'Grant the ingestion managed identity Directory.Read.All (application, read-only),'
  echo 'which the upload-time Team-membership check needs. Do it >= 24 h before H-12:'
  echo 'a managed identity picks up a new role only when its cached token expires.'
  bash "$s" --resource-group "$RG" --function-app "$INGEST"
  ask 'Apply the grant shown above?' || return 0
  bash "$s" --resource-group "$RG" --function-app "$INGEST" --apply
}

# --- T-6 -------------------------------------------------------------------------
step_bricore() {
  local gid vis
  gid=$(az rest --method get --url "$G/groups?\$filter=startswith(displayName,'Bricore')&\$select=id" --query 'value[0].id' -o tsv)
  [[ -n $gid ]] || { echo 'No Bricore group (deleted?)'; return 0; }
  vis=$(az rest --method get --url "$G/groups/$gid?\$select=visibility" --query visibility -o tsv)
  echo "Bricore team visibility: $vis. Roman decides: Private (here) or delete (by hand)."
  [[ $vis == Private ]] && return 0
  ask 'Make it Private? Members stay.' || return 0
  graph patch "$G/groups/$gid" '{"visibility":"Private"}' >/dev/null
  echo "Now: $(az rest --method get --url "$G/groups/$gid?\$select=visibility" --query visibility -o tsv)"
}

preflight
case "${1:-}" in
  consent) step_consent ;;
  quarantine) step_quarantine ;;
  membership) step_membership ;;
  bricore) step_bricore ;;
  *) sed -n '3,14p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
