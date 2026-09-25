#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# IR-0 evidence store: an immutable blob container, outside SharePoint and
# outside the ledger's own resource group, readable by exactly the people the
# incident response names.
#
# Usage:
#   infrastructure/ir/evidence-store.sh --resource-group <rg> --account <name>
#       [--location westeurope] [--container ir0-evidence] [--retention-days 400]
#       [--reader <upn|objectId>]...
#       [--upload <file>]... [--upload-dir <dir>] [--prefix <blob prefix>]
#       [--grant-uploader] [--apply]
#
#   --account         storage account name (3-24 lower-case letters/digits,
#                     globally unique), e.g. stbcrir0evidence
#   --reader          who gets "Storage Blob Data Reader" on the container.
#                     Default: $ROMAN_UPN, $IOD_UPN and yahor.simak@bcr-group.pl
#                     (Roman, the IOD, the CTO). --apply refuses while
#                     ROMAN_UPN or IOD_UPN is unset: all three, or name them.
#   --upload-dir      every file under it (e.g. an IR-0 or IR-1 output directory)
#   --prefix          blob name prefix; default ir0/<UTC date>
#   --grant-uploader  give the signed-in operator "Storage Blob Data
#                     Contributor" on the container (shared keys are off, so
#                     uploading needs a data role)
#
# Safety model:
#   - Dry run by default. State is read and printed; every change is printed
#     as the exact az command, and only run with --apply.
#   - Idempotent: what exists is checked and reused, never recreated.
#   - The container has version-level immutability (WORM) with a time-based
#     retention of --retention-days. The policy is left UNLOCKED: locking is
#     irreversible, so the lock command is printed for a person to run once
#     the evidence is in and has been checked.
#   - Evidence is never overwritten: a blob that exists with another sha256
#     stops the run.
#   - No public access, no shared keys, TLS 1.2, a CanNotDelete lock on the
#     account. An existing account is reused only if it already has all
#     three: the script never loosens or tightens someone else's account.
#   - Only the named readers can read. Every "Storage Blob Data *" role that
#     reaches the container (assigned there or inherited from the account,
#     resource group, subscription or above) must be a named reader's Reader
#     role, or, with --grant-uploader, the operator's Contributor role.
#     Anything else stops the run, dry run included, and is listed.
#   - With --grant-uploader, the command that removes the operator's write
#     role again is printed at the end, to run once the upload is checked.
#
# Uses the Azure CLI only.
# -----------------------------------------------------------------------------
set -euo pipefail

CTO_UPN="yahor.simak@bcr-group.pl"
READER_ROLE="Storage Blob Data Reader"
UPLOADER_ROLE="Storage Blob Data Contributor"

RG=""
ACCOUNT=""
LOCATION="westeurope"
CONTAINER="ir0-evidence"
RETENTION_DAYS=400
READERS=()
UPLOADS=()
UPLOAD_DIR=""
PREFIX="ir0/$(date -u +%Y-%m-%d)"
GRANT_UPLOADER=0
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
    --account) need "$@"; ACCOUNT="$2"; shift 2 ;;
    --location) need "$@"; LOCATION="$2"; shift 2 ;;
    --container) need "$@"; CONTAINER="$2"; shift 2 ;;
    --retention-days) need "$@"; RETENTION_DAYS="$2"; shift 2 ;;
    --reader) need "$@"; READERS+=("$2"); shift 2 ;;
    --upload) need "$@"; UPLOADS+=("$2"); shift 2 ;;
    --upload-dir) need "$@"; UPLOAD_DIR="${2%/}"; shift 2 ;;
    --prefix) need "$@"; PREFIX="${2%/}"; shift 2 ;;
    --grant-uploader) GRANT_UPLOADER=1; shift ;;
    --apply) APPLY=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done

[[ -n "$RG" ]] || die "--resource-group is required"
[[ "$ACCOUNT" =~ ^[a-z0-9]{3,24}$ ]] || die "--account must be 3-24 lower-case letters or digits"
[[ "$CONTAINER" =~ ^[a-z0-9]([a-z0-9-]{1,61}[a-z0-9])$ ]] || die "--container is not a valid container name"
[[ "$RETENTION_DAYS" =~ ^[0-9]+$ ]] && ((RETENTION_DAYS >= 1 && RETENTION_DAYS <= 146000)) ||
  die "--retention-days must be 1..146000"
[[ -z "$UPLOAD_DIR" || -d "$UPLOAD_DIR" ]] || die "--upload-dir $UPLOAD_DIR is not a directory"

if [[ ${#READERS[@]} -eq 0 ]]; then
  READERS=("${ROMAN_UPN:-<ROMAN_UPN unset>}" "${IOD_UPN:-<IOD_UPN unset>}" "$CTO_UPN")
fi
for r in "${READERS[@]}"; do
  if [[ "$r" == "<"* && $APPLY == 1 ]]; then
    die "reader $r: set ROMAN_UPN and IOD_UPN, or pass every --reader explicitly"
  fi
done

# Files to upload: explicit ones, then the directory's, as "path<TAB>blob name".
UPLOAD_LIST=()
for f in "${UPLOADS[@]+"${UPLOADS[@]}"}"; do
  [[ -f "$f" ]] || die "--upload $f is not a file"
  UPLOAD_LIST+=("$f"$'\t'"$PREFIX/$(basename "$f")")
done
if [[ -n "$UPLOAD_DIR" ]]; then
  base="$(basename "$UPLOAD_DIR")"
  while IFS= read -r f; do
    rel="${f#"$UPLOAD_DIR"/}"
    UPLOAD_LIST+=("$f"$'\t'"$PREFIX/$base/$rel")
  done < <(find "$UPLOAD_DIR" -type f | LC_ALL=C sort)
fi

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'; else shasum -a 256 "$1" | awk '{print $1}'; fi
}

# A change: printed always, run only with --apply.
run() {
  printf '  %s ' "$([[ $APPLY == 1 ]] && echo '+' || echo 'would run:')"
  printf '%q ' "$@"
  echo
  if [[ $APPLY == 1 ]]; then "$@" --only-show-errors --output none; fi
}

command -v az >/dev/null 2>&1 || die "Azure CLI (az) not found"
az account show --output none 2>/dev/null || die "not signed in: run az login"
SUB_ID=$(az account show --query id --output tsv)
ME=$(az account show --query user.name --output tsv)

echo
echo "IR-0 evidence store — $([[ $APPLY == 1 ]] && echo APPLY || echo 'DRY RUN (nothing is changed)')"
echo "  subscription  $SUB_ID"
echo "  signed in     $ME"
echo "  target        $RG / $ACCOUNT / $CONTAINER ($LOCATION)"
echo "  retention     $RETENTION_DAYS days, version-level, left unlocked"
echo

# --- who may hold a data role ---------------------------------------------------------
# Resolved first: the reuse check below compares every data role on the
# container with exactly these people.
GUID_RE='^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$'
lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
resolve_user() {
  if [[ "$1" =~ $GUID_RE ]]; then lower "$1"; else lower "$(az ad user show --id "$1" --query id --output tsv 2>/dev/null || true)"; fi
}
READER_OIDS=()
READERS_ALL_NAMED=1
for reader in "${READERS[@]}"; do
  oid=""
  if [[ "$reader" != "<"* ]]; then oid=$(resolve_user "$reader"); fi
  if [[ -z "$oid" ]]; then
    READERS_ALL_NAMED=0
    if [[ "$reader" != "<"* && $APPLY == 1 ]]; then die "reader $reader: no such user in this tenant"; fi
  fi
  READER_OIDS+=("$oid")
done
MY_OID=""
if [[ $GRANT_UPLOADER == 1 ]]; then MY_OID=$(lower "$(az ad signed-in-user show --query id --output tsv)"); fi

# "<object id>|<role>" per line: the only data-plane assignments allowed.
ALLOWED_DATA_ROLES=""
for oid in "${READER_OIDS[@]}"; do
  if [[ -n "$oid" ]]; then ALLOWED_DATA_ROLES+="$oid|$READER_ROLE"$'\n'; fi
done
if [[ -n "$MY_OID" ]]; then ALLOWED_DATA_ROLES+="$MY_OID|$UPLOADER_ROLE"$'\n'; fi

# Every "Storage Blob Data *" assignment that reaches $1, inherited ones
# included, as "principalId<TAB>role<TAB>scope<TAB>principalName". The name,
# which can be empty, is last: `read` collapses empty tab-separated fields.
data_roles_at() {
  az role assignment list --scope "$1" --include-inherited \
    --query "[?starts_with(roleDefinitionName, 'Storage Blob Data')].[principalId, roleDefinitionName, scope, principalName]" \
    --output tsv
}

# Report the data roles reaching $1 and stop on any that is not allowed.
check_data_roles() {
  local scope="$1" rows pid role name at unexpected=0
  rows=$(data_roles_at "$scope") || die "cannot list role assignments on $scope (needs Microsoft.Authorization/roleAssignments/read)"
  echo "  data roles reaching the container (from $scope, inherited included):"
  if [[ -z "$rows" ]]; then echo "    none"; fi
  while IFS=$'\t' read -r pid role at name; do
    [[ -n "$pid" ]] || continue
    if printf '%s' "$ALLOWED_DATA_ROLES" | grep -Fqx "$(lower "$pid")|$role"; then
      echo "    ok          $role  ${name:-$pid}  @ $at"
    else
      unexpected=$((unexpected + 1))
      echo "    NOT ALLOWED $role  ${name:-$pid}  @ $at"
    fi
  done <<<"$rows"
  if ((unexpected > 0)); then
    if [[ $READERS_ALL_NAMED == 0 && $APPLY != 1 ]]; then
      echo "  ⚠ $unexpected assignment(s) not verified: name every reader (ROMAN_UPN, IOD_UPN or --reader) to check them"
      return 0
    fi
    die "$unexpected data role assignment(s) above would let someone other than the named readers reach the evidence.
  One on the container, account or resource group: remove it (az role assignment delete --ids …) or use a
  new account in a new resource group. One inherited from the subscription or above reaches any account
  here: settle with Roman where the evidence may live before anything is uploaded."
  fi
}

# --- resource group -------------------------------------------------------------
echo "Resource group"
RG_EXISTS=0
if az group show --name "$RG" --output none 2>/dev/null; then
  RG_EXISTS=1
  echo "  exists"
else
  run az group create --name "$RG" --location "$LOCATION" --tags purpose=ir0-evidence system=bcr-ledger-agent
fi

# --- storage account --------------------------------------------------------------
echo "Storage account"
ACCOUNT_EXISTS=0
if az storage account show --name "$ACCOUNT" --resource-group "$RG" --output none 2>/dev/null; then
  ACCOUNT_EXISTS=1
  public=$(az storage account show --name "$ACCOUNT" --resource-group "$RG" --query allowBlobPublicAccess --output tsv)
  sharedkey=$(az storage account show --name "$ACCOUNT" --resource-group "$RG" --query allowSharedKeyAccess --output tsv)
  tls=$(az storage account show --name "$ACCOUNT" --resource-group "$RG" --query minimumTlsVersion --output tsv)
  echo "  exists (allowBlobPublicAccess=${public:-unset}, allowSharedKeyAccess=${sharedkey:-unset}, minimumTlsVersion=${tls:-unset})"
  [[ "$public" != "true" ]] || die "$ACCOUNT allows public blob access; this is not an evidence account. Use another name."
  # Unset means allowed. With shared keys on, anyone who can list the keys
  # reads the container, whatever its role assignments say.
  [[ "$sharedkey" == "false" ]] ||
    die "$ACCOUNT allows shared key access (allowSharedKeyAccess=${sharedkey:-unset}); this is not an evidence account. Use another name."
  [[ "$tls" == "TLS1_2" || "$tls" == "TLS1_3" ]] ||
    die "$ACCOUNT accepts TLS below 1.2 (minimumTlsVersion=${tls:-unset}); this is not an evidence account. Use another name."
else
  run az storage account create --name "$ACCOUNT" --resource-group "$RG" --location "$LOCATION" \
    --sku Standard_GRS --kind StorageV2 --min-tls-version TLS1_2 --https-only true \
    --allow-blob-public-access false --allow-shared-key-access false \
    --default-to-oauth-authentication true \
    --tags purpose=ir0-evidence system=bcr-ledger-agent
fi
ACCOUNT_ID="/subscriptions/$SUB_ID/resourceGroups/$RG/providers/Microsoft.Storage/storageAccounts/$ACCOUNT"
SCOPE="$ACCOUNT_ID/blobServices/default/containers/$CONTAINER"

versioning="false"
if [[ $ACCOUNT_EXISTS == 1 ]]; then
  versioning=$(az storage account blob-service-properties show --account-name "$ACCOUNT" --resource-group "$RG" \
    --query isVersioningEnabled --output tsv 2>/dev/null || echo false)
fi
if [[ "$versioning" == "true" ]]; then
  echo "  blob versioning on"
else
  run az storage account blob-service-properties update --account-name "$ACCOUNT" --resource-group "$RG" \
    --enable-versioning true
fi

lock_exists=0
if [[ $ACCOUNT_EXISTS == 1 ]] && [[ -n "$(az lock list --resource-group "$RG" --resource-name "$ACCOUNT" \
  --resource-type Microsoft.Storage/storageAccounts --query "[?level=='CanNotDelete'].name | [0]" --output tsv 2>/dev/null)" ]]; then
  lock_exists=1
fi
if [[ $lock_exists == 1 ]]; then
  echo "  CanNotDelete lock present"
else
  run az lock create --name ir0-evidence-nodelete --lock-type CanNotDelete --resource-group "$RG" \
    --resource-name "$ACCOUNT" --resource-type Microsoft.Storage/storageAccounts \
    --notes "IR-0 evidence: do not delete"
fi

# --- container with version-level immutability ---------------------------------------
echo "Container"
CONTAINER_EXISTS=0
if [[ $ACCOUNT_EXISTS == 1 ]] && az storage container-rm show --storage-account "$ACCOUNT" --resource-group "$RG" \
  --name "$CONTAINER" --output none 2>/dev/null; then
  CONTAINER_EXISTS=1
  vlw=$(az storage container-rm show --storage-account "$ACCOUNT" --resource-group "$RG" --name "$CONTAINER" \
    --query "immutableStorageWithVersioning.enabled" --output tsv)
  echo "  exists (version-level immutability: ${vlw:-false})"
  if [[ "$vlw" != "true" ]]; then
    die "container $CONTAINER exists without version-level immutability. Migrate it first:
  az storage container-rm migrate-vlw --storage-account $ACCOUNT --resource-group $RG --name $CONTAINER
or pass another --container."
  fi
else
  run az storage container-rm create --storage-account "$ACCOUNT" --resource-group "$RG" --name "$CONTAINER" \
    --public-access off --enable-vlw true
fi

echo "Default retention policy"
policy_state=""
policy_days=""
policy_etag=""
if [[ $CONTAINER_EXISTS == 1 ]]; then
  policy_state=$(az storage container immutability-policy show --account-name "$ACCOUNT" --resource-group "$RG" \
    --container-name "$CONTAINER" --query state --output tsv 2>/dev/null || true)
  policy_days=$(az storage container immutability-policy show --account-name "$ACCOUNT" --resource-group "$RG" \
    --container-name "$CONTAINER" --query immutabilityPeriodSinceCreationInDays --output tsv 2>/dev/null || true)
  policy_etag=$(az storage container immutability-policy show --account-name "$ACCOUNT" --resource-group "$RG" \
    --container-name "$CONTAINER" --query etag --output tsv 2>/dev/null || true)
fi
if [[ "$policy_state" == "Locked" ]]; then
  echo "  Locked, $policy_days days (can only be extended now)"
elif [[ -n "$policy_state" && "$policy_days" == "$RETENTION_DAYS" ]]; then
  echo "  $policy_state, $policy_days days"
elif [[ -n "$policy_state" ]]; then
  run az storage container immutability-policy create --account-name "$ACCOUNT" --resource-group "$RG" \
    --container-name "$CONTAINER" --period "$RETENTION_DAYS" --allow-protected-append-writes false \
    --if-match "$policy_etag"
else
  run az storage container immutability-policy create --account-name "$ACCOUNT" --resource-group "$RG" \
    --container-name "$CONTAINER" --period "$RETENTION_DAYS" --allow-protected-append-writes false
fi

# --- who can read it now ------------------------------------------------------------------
# The narrowest scope that exists: roles assigned there or above all reach
# the container once it exists.
echo "Access"
if [[ $CONTAINER_EXISTS == 1 ]]; then
  check_data_roles "$SCOPE"
elif [[ $ACCOUNT_EXISTS == 1 ]]; then
  check_data_roles "$ACCOUNT_ID"
elif [[ $RG_EXISTS == 1 ]]; then
  check_data_roles "/subscriptions/$SUB_ID/resourceGroups/$RG"
else
  check_data_roles "/subscriptions/$SUB_ID"
fi

# --- readers ------------------------------------------------------------------------------
echo "Readers ($READER_ROLE on the container)"
has_role() { # object id, role
  [[ $CONTAINER_EXISTS == 1 ]] || return 1
  local n
  n=$(az role assignment list --assignee "$1" --role "$2" --scope "$SCOPE" --query "length(@)" --output tsv 2>/dev/null || echo 0)
  [[ "$n" != "0" && -n "$n" ]]
}
for i in "${!READERS[@]}"; do
  reader="${READERS[$i]}"
  if [[ "$reader" == "<"* ]]; then
    echo "  $reader — placeholder; --apply refuses until it is set"
    continue
  fi
  oid="${READER_OIDS[$i]}"
  if [[ -z "$oid" ]]; then
    echo "  $reader — NOT FOUND in the directory"
    continue
  fi
  if has_role "$oid" "$READER_ROLE"; then
    echo "  $reader ($oid) — already assigned"
  else
    run az role assignment create --assignee-object-id "$oid" --assignee-principal-type User \
      --role "$READER_ROLE" --scope "$SCOPE"
  fi
done

if [[ $GRANT_UPLOADER == 1 ]]; then
  echo "Uploader ($UPLOADER_ROLE on the container)"
  if has_role "$MY_OID" "$UPLOADER_ROLE"; then
    echo "  $ME — already assigned"
  else
    run az role assignment create --assignee-object-id "$MY_OID" --assignee-principal-type User \
      --role "$UPLOADER_ROLE" --scope "$SCOPE"
    if [[ $APPLY == 1 ]]; then echo "  (role assignments take a few minutes to apply; uploads retry)"; fi
  fi
fi

# --- uploads ---------------------------------------------------------------------------------
if [[ ${#UPLOAD_LIST[@]} -gt 0 ]]; then
  echo "Uploads (${#UPLOAD_LIST[@]} file(s) under $PREFIX/)"
  for entry in "${UPLOAD_LIST[@]}"; do
    file="${entry%%$'\t'*}"
    blob="${entry#*$'\t'}"
    hash=$(sha256_of "$file")
    existing=""
    if [[ $CONTAINER_EXISTS == 1 ]]; then
      existing=$(az storage blob show --account-name "$ACCOUNT" --container-name "$CONTAINER" --name "$blob" \
        --auth-mode login --query "metadata.sha256" --output tsv 2>/dev/null || true)
    fi
    if [[ "$existing" == "$hash" ]]; then
      echo "  $blob — already stored, sha256 matches"
      continue
    fi
    [[ -z "$existing" ]] || die "$blob exists with sha256 $existing, not $hash. Evidence is never overwritten; use another --prefix."
    if [[ $APPLY != 1 ]]; then
      echo "  would upload $file → $blob (sha256 $hash)"
      continue
    fi
    ok=0
    for attempt in 1 2 3 4 5; do
      if az storage blob upload --account-name "$ACCOUNT" --container-name "$CONTAINER" --name "$blob" \
        --file "$file" --auth-mode login --overwrite false \
        --metadata "sha256=$hash" "source=ir0" --only-show-errors --output none; then
        ok=1
        break
      fi
      echo "  upload of $blob failed (attempt $attempt); waiting for RBAC to apply…"
      sleep 30
    done
    [[ $ok == 1 ]] || die "could not upload $blob"
    echo "  + $blob (sha256 $hash)"
  done
fi

# The operator's write role is for the upload only. It is not removed here:
# a person removes it once the upload is checked against SHA256SUMS.
print_uploader_removal() {
  echo
  echo "Write access: $ME holds $UPLOADER_ROLE on the container until removed. Once every"
  echo "file is uploaded and its sha256 checked, remove it, so that only the readers remain:"
  echo "  az role assignment delete --assignee-object-id $MY_OID --role '$UPLOADER_ROLE' \\"
  echo "    --scope $SCOPE"
  echo "If Azure refuses with ScopeLocked, the account's CanNotDelete lock is in the way. Lift it"
  echo "for that one command only, and put it back at once:"
  echo "  az lock delete --name ir0-evidence-nodelete --resource-group $RG --resource-name $ACCOUNT \\"
  echo "    --resource-type Microsoft.Storage/storageAccounts"
  echo "  (the role assignment delete above)"
  echo "  az lock create --name ir0-evidence-nodelete --lock-type CanNotDelete --resource-group $RG \\"
  echo "    --resource-name $ACCOUNT --resource-type Microsoft.Storage/storageAccounts \\"
  echo "    --notes 'IR-0 evidence: do not delete'"
  echo "A later run of this script without --grant-uploader refuses while the role is there."
}

# --- resulting state -------------------------------------------------------------------------------
echo
if [[ $APPLY != 1 ]]; then
  if [[ $GRANT_UPLOADER == 1 ]]; then print_uploader_removal; echo; fi
  echo "Dry run: nothing was changed. Re-run with --apply."
  echo
  exit 0
fi
echo "Resulting state"
az storage account show --name "$ACCOUNT" --resource-group "$RG" \
  --query "{account:name, publicAccess:allowBlobPublicAccess, sharedKey:allowSharedKeyAccess, tls:minimumTlsVersion}" \
  --output table
az storage account blob-service-properties show --account-name "$ACCOUNT" --resource-group "$RG" \
  --query "{versioning:isVersioningEnabled}" --output table
az storage container-rm show --storage-account "$ACCOUNT" --resource-group "$RG" --name "$CONTAINER" \
  --query "{container:name, versionLevelImmutability:immutableStorageWithVersioning.enabled, publicAccess:publicAccess}" \
  --output table
az storage container immutability-policy show --account-name "$ACCOUNT" --resource-group "$RG" \
  --container-name "$CONTAINER" \
  --query "{state:state, days:immutabilityPeriodSinceCreationInDays, etag:etag}" --output table
echo
echo "Role assignments on the container"
az role assignment list --scope "$SCOPE" \
  --query "[].{principal:principalName, type:principalType, role:roleDefinitionName}" --output table
echo
echo "Data roles that reach the container, inherited included"
az role assignment list --scope "$SCOPE" --include-inherited \
  --query "[?starts_with(roleDefinitionName, 'Storage Blob Data')].{principal:principalName, type:principalType, role:roleDefinitionName, scope:scope}" \
  --output table
if [[ ${#UPLOAD_LIST[@]} -gt 0 ]]; then
  echo
  echo "Blobs under $PREFIX/"
  az storage blob list --account-name "$ACCOUNT" --container-name "$CONTAINER" --prefix "$PREFIX/" \
    --auth-mode login --include v \
    --query "[].{name:name, version:versionId, size:properties.contentLength, sha256:metadata.sha256}" --output table
fi

etag=$(az storage container immutability-policy show --account-name "$ACCOUNT" --resource-group "$RG" \
  --container-name "$CONTAINER" --query etag --output tsv)
echo
echo "The retention policy is UNLOCKED. Once every evidence file is uploaded and"
echo "its sha256 checked against SHA256SUMS, lock it. Locking is irreversible: the"
echo "period can then only be extended, and nothing in the container can be deleted"
echo "for $RETENTION_DAYS days after it was written."
echo "  az storage container immutability-policy lock --account-name $ACCOUNT --resource-group $RG \\"
echo "    --container-name $CONTAINER --if-match '$etag'"
if [[ $GRANT_UPLOADER == 1 ]]; then print_uploader_removal; fi
echo
