#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# Stores the review chat's Workflows webhook URL in Key Vault as
# `review-webhook-url`, for the ingestion's review notices. Run it yourself,
# signed in with `az login`: it asks for the URL without echoing it, and the
# URL never reaches the screen, a file or a command line.
#
# Usage:
#   tools/ops/set-review-webhook.sh [<resource-group>]    (default rg-bcr-ledger-dev)
#
# The URL comes from Teams: in the Workflows app, "Send webhook alerts to a
# channel" for the shared channel Weryfikacja dokumentów in BCR GROUP. The whole URL is the credential (its `sig` parameter is
# the signature). If it is ever exposed, delete the flow and create it again,
# then run this again.
# -----------------------------------------------------------------------------
set -euo pipefail

RG="${1:-rg-bcr-ledger-dev}"
KV=$(az keyvault list -g "$RG" --query "[?starts_with(name,'kv-bcr-')].name | [0]" -o tsv)
if [[ -z "$KV" ]]; then
  echo "STOP: no kv-bcr-* Key Vault in $RG" >&2
  exit 1
fi

printf 'Paste the webhook URL (it is not shown), then press Enter: ' >&2
IFS= read -rs URL
echo >&2
case "$URL" in
  https://*.logic.azure.com/* | https://*.logic.azure.com:*/* | https://*.environment.api.powerplatform.com/* | https://*.environment.api.powerplatform.com:*/*) ;;
  *)
    echo "STOP: that is not a Workflows webhook URL (https://…logic.azure.com/… or …environment.api.powerplatform.com/…)." >&2
    exit 1
    ;;
esac

# Piped from a shell builtin to az's stdin: never on a command line, never in a file.
printf '%s' "$URL" | az keyvault secret set --vault-name "$KV" --name review-webhook-url \
  --file /dev/stdin --content-type 'text/plain' -o none
unset URL
echo "Stored as review-webhook-url in $KV (version $(az keyvault secret show --vault-name "$KV" \
  --name review-webhook-url --query 'id' -o tsv | awk -F/ '{print $NF}' | cut -c1-8)…)." >&2
echo "Tell Claude it is done: it switches the ingestion setting to the Key Vault reference." >&2
