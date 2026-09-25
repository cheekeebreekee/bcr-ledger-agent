#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# IR-0 evidence: export the ledger ingestion's routing and upload traces from
# Application Insights before retention (30 days) deletes them.
#
# Usage:
#   tools/ir0/export-appinsights.sh --app <component name | app id GUID>
#       [--resource-group <rg>]           needed when --app is a name
#       [--days 30 | --start <UTC> --end <UTC>]   UTC as 2026-09-25T00:00:00Z
#       [--chunk-hours 24] [--all-traces] [--out-dir <dir>]
#
#   --all-traces  also export every trace in the window, unfiltered, so that
#                 nothing the routing query does not select is lost to retention
#
# What it does:
#   - runs tools/ir0/routing-traces.kql once per chunk of the window, always
#     with BOTH --start-time and --end-time (with only a start, the CLI's
#     window is one hour, and the export would silently be one hour long);
#   - always runs tools/ir0/personal-tab-requests.kql per chunk as well: the
#     unsampled `requests` rows for /api/mydocs and /api/user-target, the only
#     record of calls to the anonymous Personal Tab lookup (W5), written to
#     requests-<chunk>.json;
#   - keeps itemCount on every row, so a reader can see whether sampling
#     thinned the traces;
#   - refuses to continue if a chunk comes back at the API's row limit, since
#     a truncated export looks complete;
#   - writes owner-only JSON files, the resolved query, a metadata file and a
#     SHA256SUMS manifest, and prints every hash.
#
# Read-only against Azure: `az monitor app-insights query` and `az account show`.
# The output holds client file names and user ids. It belongs in the evidence
# store (infrastructure/ir/evidence-store.sh), not in chat or a ticket.
# -----------------------------------------------------------------------------
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOLS_DIR="$(dirname "$SCRIPT_DIR")"
KQL_FILE="$SCRIPT_DIR/routing-traces.kql"
REQUESTS_KQL_FILE="$SCRIPT_DIR/personal-tab-requests.kql"
ROW_LIMIT=500000

APP=""
RG=""
DAYS=30
START=""
END=""
CHUNK_HOURS=24
ALL_TRACES=0
OUT_DIR=""

usage() { sed -n '3,/^# ---/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; }
die() {
  echo "✖ $*" >&2
  exit 1
}
need() { [[ $# -ge 2 && -n "$2" ]] || die "$1 needs a value"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --app) need "$@"; APP="$2"; shift 2 ;;
    --resource-group | -g) need "$@"; RG="$2"; shift 2 ;;
    --days) need "$@"; DAYS="$2"; shift 2 ;;
    --start) need "$@"; START="$2"; shift 2 ;;
    --end) need "$@"; END="$2"; shift 2 ;;
    --chunk-hours) need "$@"; CHUNK_HOURS="$2"; shift 2 ;;
    --all-traces) ALL_TRACES=1; shift ;;
    --out-dir) need "$@"; OUT_DIR="$2"; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done

# --- dates: GNU date and BSD (macOS) date differ ------------------------------
ISO_RE='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'
if date --version >/dev/null 2>&1; then GNU_DATE=1; else GNU_DATE=0; fi
to_epoch() {
  if [[ $GNU_DATE == 1 ]]; then date -u -d "$1" +%s; else date -u -j -f '%Y-%m-%dT%H:%M:%SZ' "$1" +%s; fi
}
from_epoch() {
  if [[ $GNU_DATE == 1 ]]; then date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ; else date -u -r "$1" +%Y-%m-%dT%H:%M:%SZ; fi
}
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'; else shasum -a 256 "$1" | awk '{print $1}'; fi
}
count_rows() {
  if command -v jq >/dev/null 2>&1; then
    jq '[.tables[]?.rows | length] | add // 0' "$1"
  elif command -v node >/dev/null 2>&1; then
    node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log((d.tables||[]).reduce((n,t)=>n+(t.rows||[]).length,0))' "$1"
  else
    echo "?"
  fi
}

[[ "$DAYS" =~ ^[0-9]+$ && "$DAYS" -gt 0 ]] || die "--days must be a positive integer"
[[ "$CHUNK_HOURS" =~ ^[0-9]+$ && "$CHUNK_HOURS" -gt 0 ]] || die "--chunk-hours must be a positive integer"
if [[ -n "$START$END" && ( -z "$START" || -z "$END" ) ]]; then
  die "--start and --end go together"
fi
NOW_EPOCH=$(date -u +%s)
if [[ -z "$END" ]]; then END=$(from_epoch "$NOW_EPOCH"); fi
[[ "$END" =~ $ISO_RE ]] || die "--end must look like 2026-09-25T00:00:00Z"
END_EPOCH=$(to_epoch "$END")
if [[ -z "$START" ]]; then START=$(from_epoch $((END_EPOCH - DAYS * 86400))); fi
[[ "$START" =~ $ISO_RE ]] || die "--start must look like 2026-08-26T00:00:00Z"
START_EPOCH=$(to_epoch "$START")
((START_EPOCH < END_EPOCH)) || die "--start must be before --end"

# --- Azure --------------------------------------------------------------------
command -v az >/dev/null 2>&1 || die "Azure CLI (az) not found"
az account show --output none 2>/dev/null || die "not signed in: run az login"
az extension show --name application-insights --output none 2>/dev/null ||
  die "the application-insights az extension is missing: az extension add --name application-insights"
[[ -f "$KQL_FILE" ]] || die "missing $KQL_FILE"
[[ -f "$REQUESTS_KQL_FILE" ]] || die "missing $REQUESTS_KQL_FILE"

GUID_RE='^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$'
if [[ -z "$APP" ]]; then
  [[ -n "$RG" ]] || die "pass --app <name|app id>, or --resource-group to find the one component in it"
  # A read loop rather than mapfile: macOS still ships bash 3.2.
  found=()
  while IFS= read -r name; do
    if [[ -n "$name" ]]; then found+=("$name"); fi
  done < <(az monitor app-insights component show --resource-group "$RG" --query "[].name" --output tsv)
  [[ ${#found[@]} -eq 1 ]] || die "found ${#found[@]} App Insights components in $RG; pass --app"
  APP="${found[0]}"
fi
if [[ ! "$APP" =~ $GUID_RE && -z "$RG" ]]; then die "--app is a name, so --resource-group is required"; fi

if [[ -z "$OUT_DIR" ]]; then
  OUT_DIR="$TOOLS_DIR/out/ir0-appinsights-$(date -u +%Y-%m-%dT%H-%M-%SZ)"
fi
mkdir -p "$OUT_DIR"
chmod 700 "$OUT_DIR"
[[ -z "$(ls -A "$OUT_DIR")" ]] || die "$OUT_DIR is not empty; evidence exports never overwrite"

RETENTION_EDGE=$((NOW_EPOCH - 30 * 86400))
echo
echo "IR-0 App Insights export (read-only)"
echo "  app        $APP${RG:+ (resource group $RG)}"
echo "  window     $START .. $END  (${CHUNK_HOURS} h chunks)"
echo "  signed in  $(az account show --query user.name --output tsv)"
echo "  out        $OUT_DIR"
if ((START_EPOCH < RETENTION_EDGE)); then
  echo "  ⚠ the window starts before $(from_epoch "$RETENTION_EDGE"); with 30-day retention those rows are already gone"
fi
echo

KQL_TEMPLATE="$(cat "$KQL_FILE")"
REQUESTS_TEMPLATE="$(cat "$REQUESTS_KQL_FILE")"
fill_window() { # template start end
  local q="${1//@@START@@/$2}"
  printf '%s' "${q//@@END@@/$3}"
}
routing_kql() { fill_window "$KQL_TEMPLATE" "$1" "$2"; }
requests_kql() { fill_window "$REQUESTS_TEMPLATE" "$1" "$2"; }
all_traces_kql() {
  printf '%s\n' \
    "traces" \
    "| where timestamp between (datetime($1) .. datetime($2))" \
    "| project timestamp, itemId, itemCount, operation_Id, operation_Name, cloud_RoleName, cloud_RoleInstance, severityLevel, message, customDimensions" \
    "| order by timestamp asc"
}

run_query() { # kql start end outfile
  local args=(monitor app-insights query --app "$APP" --analytics-query "$1"
    --start-time "$2" --end-time "$3" --output json)
  [[ -n "$RG" ]] && args+=(--resource-group "$RG")
  az "${args[@]}" >"$4"
  chmod 600 "$4"
  local rows
  rows=$(count_rows "$4")
  printf '  %-58s %8s rows\n' "$(basename "$4")" "$rows"
  if [[ "$rows" != "?" ]] && ((rows >= ROW_LIMIT)); then
    die "$(basename "$4") hit the ${ROW_LIMIT}-row limit and is truncated; re-run with a smaller --chunk-hours"
  fi
  TOTAL_ROWS=$((TOTAL_ROWS + ${rows/\?/0}))
}

TOTAL_ROWS=0
CHUNKS=0
chunk_start=$START_EPOCH
while ((chunk_start < END_EPOCH)); do
  chunk_end=$((chunk_start + CHUNK_HOURS * 3600))
  ((chunk_end > END_EPOCH)) && chunk_end=$END_EPOCH
  cs=$(from_epoch "$chunk_start")
  ce=$(from_epoch "$chunk_end")
  tag="${cs//:/-}"
  run_query "$(routing_kql "$cs" "$ce")" "$cs" "$ce" "$OUT_DIR/routing-$tag.json"
  run_query "$(requests_kql "$cs" "$ce")" "$cs" "$ce" "$OUT_DIR/requests-$tag.json"
  if [[ $ALL_TRACES == 1 ]]; then
    run_query "$(all_traces_kql "$cs" "$ce")" "$cs" "$ce" "$OUT_DIR/all-traces-$tag.json"
  fi
  CHUNKS=$((CHUNKS + 1))
  chunk_start=$chunk_end
done

# The queries exactly as run (window left as placeholders; the window is below).
cp "$KQL_FILE" "$OUT_DIR/routing-traces.kql"
cp "$REQUESTS_KQL_FILE" "$OUT_DIR/personal-tab-requests.kql"
chmod 600 "$OUT_DIR/routing-traces.kql" "$OUT_DIR/personal-tab-requests.kql"
{
  echo "kind=bcr.ir0.appinsights-export"
  echo "created_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "app=$APP"
  echo "resource_group=$RG"
  echo "window_start=$START"
  echo "window_end=$END"
  echo "chunk_hours=$CHUNK_HOURS"
  echo "chunks=$CHUNKS"
  echo "all_traces=$ALL_TRACES"
  echo "personal_tab_requests=1"
  echo "rows_total=$TOTAL_ROWS"
  echo "operator=$(az account show --query user.name --output tsv)"
  echo "subscription=$(az account show --query id --output tsv)"
  echo "tenant=$(az account show --query tenantId --output tsv)"
  echo "az_cli=$(az version --query '"azure-cli"' --output tsv 2>/dev/null || echo unknown)"
  echo "tool_commit=$(git -C "$TOOLS_DIR" rev-parse HEAD 2>/dev/null || echo unknown)"
} >"$OUT_DIR/export-meta.txt"
chmod 600 "$OUT_DIR/export-meta.txt"

(
  cd "$OUT_DIR"
  for f in *; do
    [[ "$f" == SHA256SUMS ]] && continue
    printf '%s  %s\n' "$(sha256_of "$f")" "$f"
  done >SHA256SUMS
  chmod 600 SHA256SUMS
)

echo
echo "SHA-256"
sed 's/^/  /' "$OUT_DIR/SHA256SUMS"
echo
echo "  manifest   $(sha256_of "$OUT_DIR/SHA256SUMS")  SHA256SUMS"
echo "  rows       $TOTAL_ROWS in $CHUNKS chunk(s)"
echo
echo "Next: upload the directory to the immutable evidence container:"
echo "  infrastructure/ir/evidence-store.sh --resource-group <rg> --account <name> --upload-dir $OUT_DIR"
echo "and feed it to IR-1:  node tools/inventory-misfiled.mjs ... --ir0 $OUT_DIR"
echo
