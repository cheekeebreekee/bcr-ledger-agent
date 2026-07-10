#!/usr/bin/env bash
#
# grant-sharepoint-permission.sh
#
# Grants the Ingestion API app registration `Sites.Selected` write
# permission on a single SharePoint site, then verifies the grant.
#
# REQUIREMENTS
#   - macOS Terminal (or any bash/zsh shell)
#   - Azure CLI installed:  brew install azure-cli
#   - Signed-in identity has Microsoft Graph permission
#     `Sites.FullControl.All` (typically Global Admin or SharePoint Admin)
#
# USAGE
#   ./infrastructure/grant-sharepoint-permission.sh
#
#   or override any of the defaults inline:
#
#   TENANT_ID=...  SITE_HOSTNAME=...  SITE_PATH=/sites/... \
#   INGESTION_APP_ID=...  INGESTION_APP_DISPLAY_NAME='...' \
#       ./infrastructure/grant-sharepoint-permission.sh
#
# The script is idempotent: re-running it on an already-granted site
# returns the existing permission entry instead of failing.

set -euo pipefail

# ---------------------------------------------------------------------------
# Defaults — populated for the BCR Ledger dev tenant. Override via env vars.
# ---------------------------------------------------------------------------
TENANT_ID="${TENANT_ID:-379013e4-7d25-4668-b99f-3cfa2264dc71}"
SITE_HOSTNAME="${SITE_HOSTNAME:-bcrgroupeu.sharepoint.com}"
SITE_PATH="${SITE_PATH:-/sites/0000TESTSp.zo.o.-Ksigowo}"
INGESTION_APP_ID="${INGESTION_APP_ID:-b8b90018-9af0-4d7a-ada2-71559952ebbe}"
INGESTION_APP_DISPLAY_NAME="${INGESTION_APP_DISPLAY_NAME:-BCR Ledger Ingestion API}"
ROLE="${ROLE:-write}"   # one of: read | write | owner

# ---------------------------------------------------------------------------
# Pretty helpers
# ---------------------------------------------------------------------------
bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
ok()    { printf '\033[32m✅ %s\033[0m\n' "$*"; }
warn()  { printf '\033[33m⚠️  %s\033[0m\n' "$*"; }
fail()  { printf '\033[31m❌ %s\033[0m\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------
command -v az >/dev/null 2>&1 \
  || fail "Azure CLI not found. Install with: brew install azure-cli"

bold "→ Verifying Azure CLI login"
CURRENT_TENANT=$(az account show --query tenantId -o tsv 2>/dev/null || echo "")
if [[ -z "$CURRENT_TENANT" || "$CURRENT_TENANT" != "$TENANT_ID" ]]; then
  warn "Signing in to tenant $TENANT_ID with elevated Graph scope (Sites.FullControl.All)"
  warn "Your browser will open — approve the consent prompt."
  az login --tenant "$TENANT_ID" --scope "https://graph.microsoft.com/Sites.FullControl.All" --only-show-errors >/dev/null
else
  # Already in the right tenant, but we still need to make sure the cached
  # token has the elevated scope. Re-request a token; if Azure AD refuses,
  # fall back to a full login with the scope.
  az account get-access-token --resource "https://graph.microsoft.com" --scope "https://graph.microsoft.com/Sites.FullControl.All" --output none 2>/dev/null \
    || { warn "Cached token lacks Sites.FullControl.All — re-prompting consent in browser"; \
         az login --tenant "$TENANT_ID" --scope "https://graph.microsoft.com/Sites.FullControl.All" --only-show-errors >/dev/null; }
fi
ok "Tenant: $(az account show --query 'tenantId' -o tsv)"
ok "User:   $(az account show --query 'user.name' -o tsv)"

# ---------------------------------------------------------------------------
# 1. Resolve the SharePoint site ID
# ---------------------------------------------------------------------------
echo
bold "→ Resolving site: https://${SITE_HOSTNAME}${SITE_PATH}"
SITE_ID=$(az rest --method GET \
  --url "https://graph.microsoft.com/v1.0/sites/${SITE_HOSTNAME}:${SITE_PATH}" \
  --query id -o tsv 2>/dev/null) \
  || fail "Could not resolve site. Check SITE_HOSTNAME / SITE_PATH and that the site exists."
ok "Site ID: $SITE_ID"

# ---------------------------------------------------------------------------
# 2. Check whether the grant already exists (idempotency)
# ---------------------------------------------------------------------------
echo
bold "→ Checking existing site permissions"
EXISTING=$(az rest --method GET \
  --url "https://graph.microsoft.com/v1.0/sites/${SITE_ID}/permissions" \
  --query "value[?grantedToIdentities[?application.id=='${INGESTION_APP_ID}']]" \
  -o json 2>/dev/null || echo "[]")

if [[ "$EXISTING" != "[]" && -n "$EXISTING" ]]; then
  ok "Permission already granted — nothing to do."
  echo "$EXISTING" | sed 's/^/  /'
  exit 0
fi

# ---------------------------------------------------------------------------
# 3. Create the permission grant
# ---------------------------------------------------------------------------
echo
bold "→ Granting '${ROLE}' on the site to '${INGESTION_APP_DISPLAY_NAME}' (${INGESTION_APP_ID})"

# Build JSON in a tmp file (avoids macOS shell-quoting pain)
BODY_FILE=$(mktemp)
trap 'rm -f "$BODY_FILE"' EXIT
cat > "$BODY_FILE" <<JSON
{
  "roles": ["${ROLE}"],
  "grantedToIdentities": [
    {
      "application": {
        "id": "${INGESTION_APP_ID}",
        "displayName": "${INGESTION_APP_DISPLAY_NAME}"
      }
    }
  ]
}
JSON

az rest --method POST \
  --url "https://graph.microsoft.com/v1.0/sites/${SITE_ID}/permissions" \
  --headers "Content-Type=application/json" \
  --body "@${BODY_FILE}" \
  --output none \
  || fail "Grant failed. Caller needs Microsoft Graph 'Sites.FullControl.All' (Global / SharePoint admin)."

ok "Permission granted"

# ---------------------------------------------------------------------------
# 4. Verify
# ---------------------------------------------------------------------------
echo
bold "→ Verification"
az rest --method GET \
  --url "https://graph.microsoft.com/v1.0/sites/${SITE_ID}/permissions" \
  --query "value[].{roles:roles, app:grantedToIdentities[0].application.displayName, appId:grantedToIdentities[0].application.id}" \
  -o table

echo
ok "Done. The ingestion Function App can now write to https://${SITE_HOSTNAME}${SITE_PATH}"
