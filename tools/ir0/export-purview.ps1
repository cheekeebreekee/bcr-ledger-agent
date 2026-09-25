#Requires -Version 7.0
<#
.SYNOPSIS
    IR-0 evidence: export the Purview unified audit log for the ledger incident.

.DESCRIPTION
    App Insights says where the ingestion put each file. The unified audit log
    says who then opened it. Together they answer the GDPR question: did anyone
    who is not staff reach another client's documents?

    Three exports, each a CSV with the raw AuditData JSON kept on every row:

      purview-file-operations.csv   SharePointFileOperation on the given sites:
                                    FileUploaded, FileAccessed, FilePreviewed,
                                    FileDownloaded, FileSyncDownloadedFull
      purview-group-events.csv      Entra group and Teams membership and settings
                                    changes (member/owner added or removed,
                                    group updated, team settings such as
                                    visibility), tenant-wide in the window
      purview-sharing-events.csv    SharePointSharingOperation on the given sites

    plus export-meta.txt and a SHA256SUMS manifest, with every hash printed.

    Read-only: Search-UnifiedAuditLog and nothing else. Paged with
    ReturnLargeSet sessions; a window that reaches the 50,000-per-session cap
    is split in half until it fits, so the export is never silently
    truncated. A session that reports ResultIndex -1 (a known service-side
    failure) is retried from scratch.

    Rows are filtered to the given sites on the client side, by the SiteUrl in
    AuditData, because server-side ObjectIds matching is exact, not by prefix.

.PARAMETER SiteUrl
    Site URLs to keep, e.g. https://contoso.sharepoint.com/sites/BCRGROUP.
    In the incident: BCR GROUP, PESKOVOI and TEST, plus any client site IR-1
    reports under site_not_walked.

.PARAMETER StartDate
    Start of the window, UTC. Pass it with a Z (2026-06-01T00:00:00Z). A value
    without a zone is taken as UTC, never as local time.

.PARAMETER EndDate
    End of the window, UTC. Default: now.

.PARAMETER ChunkHours
    Window size per file-operations search. Default 24.

.PARAMETER OutDir
    Default: tools/out/ir0-purview-<UTC stamp>. Must be empty or absent.

.EXAMPLE
    Connect-ExchangeOnline -UserPrincipalName auditor@contoso.example
    ./tools/ir0/export-purview.ps1 `
        -SiteUrl https://contoso.sharepoint.com/sites/BCRGROUP, https://contoso.sharepoint.com/sites/0001CLIENTA `
        -StartDate 2026-06-01T00:00:00Z

.NOTES
    Needs the ExchangeOnlineManagement module, a Connect-ExchangeOnline
    session, and the "View-Only Audit Logs" or "Audit Logs" role (Purview).
    Audit (Standard) keeps 180 days: export the whole exposure window now.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)] [string[]] $SiteUrl,
    [Parameter(Mandatory = $true)] [datetime] $StartDate,
    [datetime] $EndDate = [datetime]::UtcNow,
    [ValidateRange(1, 168)] [int] $ChunkHours = 24,
    [string] $OutDir,
    [string[]] $FileOperations = @('FileUploaded', 'FileAccessed', 'FilePreviewed', 'FileDownloaded', 'FileSyncDownloadedFull'),
    [switch] $SkipGroupEvents,
    [switch] $SkipSharingEvents
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3.0

$SessionCap = 50000
$PageSize = 5000

function ConvertTo-Utc([datetime] $Value) {
    if ($Value.Kind -eq [System.DateTimeKind]::Unspecified) {
        return [datetime]::SpecifyKind($Value, [System.DateTimeKind]::Utc)
    }
    return $Value.ToUniversalTime()
}

# Search-UnifiedAuditLog reads a date without a zone as UTC.
function Format-AuditDate([datetime] $Utc) { $Utc.ToString('yyyy-MM-ddTHH:mm:ss') }

function Get-Prop($Object, [string] $Name) {
    if ($null -eq $Object) { return $null }
    $p = $Object.PSObject.Properties[$Name]
    if ($null -eq $p) { return $null }
    return $p.Value
}

function ConvertTo-Cell($Value) {
    if ($null -eq $Value) { return '' }
    if ($Value -is [string]) { return $Value }
    return ($Value | ConvertTo-Json -Depth 8 -Compress)
}

function Get-Sha256([string] $Path) { (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant() }

function Protect-File([string] $Path) {
    if ($IsLinux -or $IsMacOS) { & chmod 600 -- $Path }
}

# --- inputs ------------------------------------------------------------------
$start = ConvertTo-Utc $StartDate
$end = ConvertTo-Utc $EndDate
if ($start -ge $end) { throw 'StartDate must be before EndDate.' }

$sitePrefixes = @(
    foreach ($u in $SiteUrl) {
        $uri = [uri]$u
        if ($uri.Scheme -ne 'https' -or $uri.AbsolutePath -notmatch '^/(sites|teams)/[^/]+/?$') {
            throw "SiteUrl '$u' is not https://<host>/sites/<name>."
        }
        ($uri.GetLeftPart([System.UriPartial]::Path).TrimEnd('/') + '/').ToLowerInvariant()
    }
)

function Test-OnSites($AuditData) {
    $candidates = @((Get-Prop $AuditData 'SiteUrl'), (Get-Prop $AuditData 'ObjectId')) | Where-Object { $_ }
    foreach ($c in $candidates) {
        $value = ([string]$c).ToLowerInvariant()
        if (-not $value.EndsWith('/')) { $value += '/' }
        foreach ($prefix in $sitePrefixes) {
            if ($value.StartsWith($prefix)) { return $true }
        }
    }
    return $false
}

if (-not (Get-Command Search-UnifiedAuditLog -ErrorAction SilentlyContinue)) {
    throw 'Search-UnifiedAuditLog is not available. Run Connect-ExchangeOnline first (ExchangeOnlineManagement module).'
}
$operator = ''
if (Get-Command Get-ConnectionInformation -ErrorAction SilentlyContinue) {
    $operator = (@(Get-ConnectionInformation) | Select-Object -First 1).UserPrincipalName
}

if (-not $OutDir) {
    $OutDir = Join-Path (Join-Path (Split-Path $PSScriptRoot -Parent) 'out') ("ir0-purview-" + [datetime]::UtcNow.ToString('yyyy-MM-ddTHH-mm-ssZ'))
}
if (Test-Path -LiteralPath $OutDir) {
    if (@(Get-ChildItem -LiteralPath $OutDir -Force).Count -gt 0) {
        throw "$OutDir is not empty; evidence exports never overwrite."
    }
} else {
    New-Item -ItemType Directory -Path $OutDir | Out-Null
}
if ($IsLinux -or $IsMacOS) { & chmod 700 -- $OutDir }

Write-Host ''
Write-Host 'IR-0 Purview audit export (read-only)'
Write-Host "  window    $(Format-AuditDate $start)Z .. $(Format-AuditDate $end)Z"
Write-Host "  sites     $($sitePrefixes -join ', ')"
Write-Host "  operator  $operator"
Write-Host "  out       $OutDir"
Write-Host ''

# --- search ------------------------------------------------------------------

# One ReturnLargeSet session over [From, To). Returns the records and the
# service's ResultCount, or throws after three failed sessions.
function Invoke-AuditSession([datetime] $From, [datetime] $To, [string] $RecordType, [string[]] $Operations) {
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        $session = [guid]::NewGuid().ToString()
        $records = [System.Collections.Generic.List[object]]::new()
        $total = 0
        $failed = $false
        while ($true) {
            $search = @{
                StartDate      = (Format-AuditDate $From)
                EndDate        = (Format-AuditDate $To)
                RecordType     = $RecordType
                SessionId      = $session
                SessionCommand = 'ReturnLargeSet'
                ResultSize     = $PageSize
            }
            if ($Operations) { $search.Operations = $Operations }
            $page = @(Search-UnifiedAuditLog @search)
            if ($page.Count -eq 0) { break }
            if (@($page | Where-Object { $_.ResultIndex -eq -1 }).Count -gt 0) { $failed = $true; break }
            $records.AddRange([object[]]$page)
            $total = [int]$page[0].ResultCount
            if ($records.Count -ge $total) { break }
        }
        if (-not $failed) { return [pscustomobject]@{ Records = $records; Total = $total } }
        Write-Warning "  session failed (ResultIndex -1) for $RecordType $(Format-AuditDate $From); retry $attempt"
        Start-Sleep -Seconds (20 * $attempt)
    }
    throw "Search-UnifiedAuditLog kept failing for $RecordType $(Format-AuditDate $From)..$(Format-AuditDate $To)."
}

# Every record in [From, To), splitting the window while a session hits the cap.
function Get-AuditRecords([datetime] $From, [datetime] $To, [string] $RecordType, [string[]] $Operations) {
    $result = Invoke-AuditSession $From $To $RecordType $Operations
    if ($result.Total -lt $SessionCap) { return , $result.Records }
    if (($To - $From).TotalMinutes -le 30) {
        throw "More than $SessionCap $RecordType records in 30 minutes from $(Format-AuditDate $From); export that window by hand."
    }
    $mid = $From.AddTicks([long](($To - $From).Ticks / 2))
    Write-Host "  $RecordType $(Format-AuditDate $From): $($result.Total) records, splitting"
    $left = Get-AuditRecords $From $mid $RecordType $Operations
    $right = Get-AuditRecords $mid $To $RecordType $Operations
    $both = [System.Collections.Generic.List[object]]::new()
    $both.AddRange([object[]]$left)
    $both.AddRange([object[]]$right)
    return , $both
}

$seen = [System.Collections.Generic.HashSet[string]]::new()
function Select-New($Records) {
    foreach ($r in $Records) {
        if ($seen.Add([string]$r.Identity)) { $r }
    }
}

function ConvertTo-FileRow($Record, $a) {
    [pscustomobject]@{
        CreationTimeUtc        = Get-Prop $a 'CreationTime'
        RecordType             = [string]$Record.RecordType
        Operation              = Get-Prop $a 'Operation'
        UserId                 = Get-Prop $a 'UserId'
        UserType               = ConvertTo-Cell (Get-Prop $a 'UserType')
        ClientIP               = Get-Prop $a 'ClientIP'
        UserAgent              = Get-Prop $a 'UserAgent'
        SiteUrl                = Get-Prop $a 'SiteUrl'
        ObjectId               = Get-Prop $a 'ObjectId'
        SourceRelativeUrl      = Get-Prop $a 'SourceRelativeUrl'
        SourceFileName         = Get-Prop $a 'SourceFileName'
        ListItemUniqueId       = Get-Prop $a 'ListItemUniqueId'
        ApplicationId          = Get-Prop $a 'ApplicationId'
        ApplicationDisplayName = Get-Prop $a 'ApplicationDisplayName'
        TargetUserOrGroupName  = Get-Prop $a 'TargetUserOrGroupName'
        TargetUserOrGroupType  = Get-Prop $a 'TargetUserOrGroupType'
        Identity               = [string]$Record.Identity
        AuditData              = [string]$Record.AuditData
    }
}

function ConvertTo-GroupRow($Record) {
    $a = $Record.AuditData | ConvertFrom-Json
    [pscustomobject]@{
        CreationTimeUtc    = Get-Prop $a 'CreationTime'
        RecordType         = [string]$Record.RecordType
        Operation          = Get-Prop $a 'Operation'
        UserId             = Get-Prop $a 'UserId'
        ObjectId           = Get-Prop $a 'ObjectId'
        TeamName           = Get-Prop $a 'TeamName'
        Members            = ConvertTo-Cell (Get-Prop $a 'Members')
        Target             = ConvertTo-Cell (Get-Prop $a 'Target')
        ModifiedProperties = ConvertTo-Cell (Get-Prop $a 'ModifiedProperties')
        Name               = Get-Prop $a 'Name'
        OldValue           = ConvertTo-Cell (Get-Prop $a 'OldValue')
        NewValue           = ConvertTo-Cell (Get-Prop $a 'NewValue')
        Identity           = [string]$Record.Identity
        AuditData          = [string]$Record.AuditData
    }
}

function Write-EvidenceCsv($Rows, [string] $Name) {
    $path = Join-Path $OutDir $Name
    $sorted = @($Rows | Sort-Object CreationTimeUtc, Identity)
    if ($sorted.Count -eq 0) {
        Set-Content -LiteralPath $path -Value '' -Encoding utf8BOM
    } else {
        $sorted | Export-Csv -LiteralPath $path -NoTypeInformation -Encoding utf8BOM
    }
    Protect-File $path
    Write-Host ("  {0,-34} {1,8} rows" -f $Name, $sorted.Count)
    return $sorted.Count
}

$counts = [ordered]@{}

# File operations, chunked.
$fileRows = [System.Collections.Generic.List[object]]::new()
$chunkStart = $start
while ($chunkStart -lt $end) {
    $chunkEnd = $chunkStart.AddHours($ChunkHours)
    if ($chunkEnd -gt $end) { $chunkEnd = $end }
    $records = Get-AuditRecords $chunkStart $chunkEnd 'SharePointFileOperation' $FileOperations
    $kept = 0
    foreach ($r in (Select-New $records)) {
        $a = $r.AuditData | ConvertFrom-Json
        if (Test-OnSites $a) {
            $fileRows.Add((ConvertTo-FileRow $r $a))
            $kept++
        }
    }
    Write-Host ("  {0}  {1,7} file events, {2,6} on the sites" -f (Format-AuditDate $chunkStart), $records.Count, $kept)
    $chunkStart = $chunkEnd
}
$counts['file_operations'] = Write-EvidenceCsv $fileRows 'purview-file-operations.csv'

if (-not $SkipGroupEvents) {
    $groupRows = [System.Collections.Generic.List[object]]::new()
    $groupSearches = @(
        @{ Type = 'AzureActiveDirectory'; Ops = @('Add member to group.', 'Remove member from group.', 'Add owner to group.', 'Remove owner from group.', 'Update group.') },
        @{ Type = 'MicrosoftTeams'; Ops = @('MemberAdded', 'MemberRemoved', 'MemberRoleChanged', 'TeamSettingChanged') }
    )
    foreach ($g in $groupSearches) {
        $records = Get-AuditRecords $start $end $g.Type $g.Ops
        foreach ($r in (Select-New $records)) { $groupRows.Add((ConvertTo-GroupRow $r)) }
    }
    $counts['group_events'] = Write-EvidenceCsv $groupRows 'purview-group-events.csv'
}

if (-not $SkipSharingEvents) {
    $sharingRows = [System.Collections.Generic.List[object]]::new()
    $records = Get-AuditRecords $start $end 'SharePointSharingOperation' $null
    foreach ($r in (Select-New $records)) {
        $a = $r.AuditData | ConvertFrom-Json
        if (Test-OnSites $a) { $sharingRows.Add((ConvertTo-FileRow $r $a)) }
    }
    $counts['sharing_events'] = Write-EvidenceCsv $sharingRows 'purview-sharing-events.csv'
}

# --- metadata and hashes -------------------------------------------------------
$meta = @(
    'kind=bcr.ir0.purview-export'
    "created_utc=$([datetime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ'))"
    "window_start=$(Format-AuditDate $start)Z"
    "window_end=$(Format-AuditDate $end)Z"
    "chunk_hours=$ChunkHours"
    "sites=$($sitePrefixes -join ' ')"
    "file_operations=$($FileOperations -join ' ')"
    "operator=$operator"
    "module=$((Get-Module ExchangeOnlineManagement | Select-Object -First 1).Version)"
)
foreach ($k in $counts.Keys) { $meta += "rows_$k=$($counts[$k])" }
$metaPath = Join-Path $OutDir 'export-meta.txt'
Set-Content -LiteralPath $metaPath -Value $meta -Encoding utf8
Protect-File $metaPath

$sumsPath = Join-Path $OutDir 'SHA256SUMS'
$sums = foreach ($f in (Get-ChildItem -LiteralPath $OutDir -File | Where-Object Name -ne 'SHA256SUMS' | Sort-Object Name)) {
    "$(Get-Sha256 $f.FullName)  $($f.Name)"
}
Set-Content -LiteralPath $sumsPath -Value $sums -Encoding ascii
Protect-File $sumsPath

Write-Host ''
Write-Host 'SHA-256'
foreach ($line in $sums) { Write-Host "  $line" }
Write-Host ''
Write-Host "  manifest  $(Get-Sha256 $sumsPath)  SHA256SUMS"
Write-Host ''
Write-Host 'Next: upload the directory to the immutable evidence container:'
Write-Host "  infrastructure/ir/evidence-store.sh --resource-group <rg> --account <name> --upload-dir $OutDir"
Write-Host ''
