#Requires -Version 7.2
<#
.SYNOPSIS
    Creates (or verifies) the staff-only quarantine site that ledger ingestion
    files unroutable uploads into (Phase 0, P0-2).

.DESCRIPTION
    Before Phase 0, an upload the Client Directory could not tie to a client
    went to the root of the BCR GROUP team library, which every member of that
    team can read. Phase 0 sends it here instead: a communication site with no
    Microsoft 365 group (so no Team, no group membership, no "join"), sharing
    disabled, and a document library that only BCR's quarantine reviewers and
    the site owners can open.

    Idempotent. Without -Apply it reads the current state and prints every
    change it would make; with -Apply it makes them. Either way it ends by
    printing the resulting state and the ingestion settings to use.

    What it does, in order:
      1. Creates the communication site (tenant admin), or checks the existing
         one is a communication site without a group.
      2. Sets SharingCapability = Disabled and disables sharing for non-owners.
      3. Creates the SharePoint group "Kwarantanna – weryfikujący" with the
         given reviewers (it reports, but does not remove, anyone else in it).
      4. Breaks permission inheritance on the default document library, without
         copying, and grants: site owners Full Control, reviewers Contribute.
      5. Removes "Everyone" and "Everyone except external users" from the site,
         the library and the site's groups.
      6. Creates the single-line text columns UploaderOid, QuarantineReason,
         OriginalFilename and DocumentId on the library (ingestion writes them
         after each quarantined upload) and the Kwarantanna root folder.

    It does NOT grant the ingestion identity write access: that needs
    Sites.FullControl.All and is a separate, audited step. See README.md.

.PARAMETER SiteUrl
    Full URL of the site, e.g. https://contoso.sharepoint.com/sites/BCRLedgerKwarantanna

.PARAMETER Owner
    UPN of the site owner (a BCR administrator).

.PARAMETER ReviewerUpn
    UPNs of the quarantine reviewers: BCR staff only, never a client or guest.

.PARAMETER ClientId
    Application (client) id of the Entra app registration PnP.PowerShell signs
    in with (PnP requires your own since September 2024;
    Register-PnPEntraIDAppForInteractiveLogin creates one).

.PARAMETER Lcid
    Site language. 1045 (Polish) makes the default library "Dokumenty", which
    is what QUARANTINE_DRIVE_NAME must then be. Fixed at creation.

.PARAMETER Apply
    Make the changes. Without it, nothing is changed.

.EXAMPLE
    ./infrastructure/quarantine/New-QuarantineSite.ps1 `
        -SiteUrl https://contoso.sharepoint.com/sites/BCRLedgerKwarantanna `
        -Owner admin@contoso.example -ReviewerUpn reviewer1@contoso.example, reviewer2@contoso.example `
        -ClientId 00000000-0000-0000-0000-000000000000
    # Read the plan, then re-run with -Apply.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)] [string] $SiteUrl,
    [Parameter(Mandatory = $true)] [string] $Owner,
    [Parameter(Mandatory = $true)] [string[]] $ReviewerUpn,
    [Parameter(Mandatory = $true)] [string] $ClientId,
    [string] $Title = 'BCR Ledger – Kwarantanna',
    [string] $GroupName = 'Kwarantanna – weryfikujący',
    [int] $Lcid = 1045,
    [string] $LibraryUrl = 'Shared Documents',
    [string] $RootFolder = 'Kwarantanna',
    [string[]] $Columns = @('UploaderOid', 'QuarantineReason', 'OriginalFilename', 'DocumentId'),
    [switch] $DeviceLogin,
    [switch] $Apply
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3.0

if (-not (Get-Module -ListAvailable -Name PnP.PowerShell)) {
    throw 'PnP.PowerShell is not installed: Install-Module PnP.PowerShell -Scope CurrentUser'
}
Import-Module PnP.PowerShell

$uri = [uri]$SiteUrl
if ($uri.Scheme -ne 'https' -or $uri.AbsolutePath -notmatch '^/sites/[^/]+/?$') {
    throw "SiteUrl must be https://<tenant>.sharepoint.com/sites/<name>, got '$SiteUrl'."
}
if ($uri.Host -notmatch '^([a-z0-9-]+)\.sharepoint\.com$') {
    throw "SiteUrl host must be <tenant>.sharepoint.com, got '$($uri.Host)'."
}
$SiteUrl = $SiteUrl.TrimEnd('/')
$sitePath = $uri.AbsolutePath.TrimEnd('/')
$adminUrl = "https://$($uri.Host.Split('.')[0])-admin.sharepoint.com"
if ($ClientId -notmatch '^[0-9a-fA-F-]{36}$') { throw 'ClientId must be the app (client) id GUID.' }
foreach ($u in @($Owner) + $ReviewerUpn) {
    if ($u -notmatch '^[^@\s]+@[^@\s]+$') { throw "'$u' is not a UPN." }
    if ($u -match '#EXT#') { throw "'$u' is a guest. Quarantine reviewers are BCR staff only." }
}

# Tenant site properties differ between PnP versions; under strict mode a
# missing property throws, so they are read through this.
function Get-Prop($Object, [string] $Name) {
    if ($null -eq $Object) { return $null }
    $p = $Object.PSObject.Properties[$Name]
    if ($null -eq $p) { return $null }
    return $p.Value
}

$EveryoneClaims = @(
    '^c:0\(\.s\|true$',                             # Everyone
    '^c:0-\.f\|rolemanager\|spo-grid-all-users/'    # Everyone except external users
)
function Test-EveryoneClaim([string] $LoginName) {
    foreach ($re in $EveryoneClaims) { if ($LoginName -match $re) { return $true } }
    return $false
}

$changes = 0
function Invoke-Change([string] $Description, [scriptblock] $Action) {
    $script:changes++
    if ($Apply) {
        Write-Host "  + $Description"
        & $Action
    } else {
        Write-Host "  would: $Description"
    }
}

function Connect-To([string] $Url) {
    $connect = @{ Url = $Url; ClientId = $ClientId }
    if ($DeviceLogin) { $connect.DeviceLogin = $true } else { $connect.Interactive = $true }
    Connect-PnPOnline @connect
}

Write-Host ''
Write-Host "Quarantine site — $(if ($Apply) { 'APPLY' } else { 'DRY RUN (nothing is changed)' })"
Write-Host "  site      $SiteUrl"
Write-Host "  title     $Title"
Write-Host "  reviewers $($ReviewerUpn -join ', ')"
Write-Host ''

# --- 1. site ----------------------------------------------------------------------
Connect-To $adminUrl
Write-Host 'Site'
$tenantSite = Get-PnPTenantSite -Identity $SiteUrl -ErrorAction SilentlyContinue
if ($null -eq $tenantSite) {
    Invoke-Change "create communication site '$Title' (LCID $Lcid, owner $Owner, no Microsoft 365 group)" {
        New-PnPSite -Type CommunicationSite -Title $Title -Url $SiteUrl -Owner $Owner -Lcid $Lcid -Wait | Out-Null
    }
    if (-not $Apply) {
        Write-Host ''
        Write-Host 'The site does not exist yet, so the rest is planned but cannot be inspected:'
        Write-Host '  would: set SharingCapability Disabled, disable sharing for non-owners'
        Write-Host "  would: create group '$GroupName' with $($ReviewerUpn.Count) reviewer(s)"
        Write-Host "  would: break inheritance on '$LibraryUrl'; owners Full Control, reviewers Contribute"
        Write-Host '  would: remove Everyone / Everyone except external users'
        Write-Host "  would: add text columns $($Columns -join ', '); create folder $RootFolder"
        Write-Host ''
        Write-Host 'Dry run. Re-run with -Apply.'
        return
    }
    $tenantSite = Get-PnPTenantSite -Identity $SiteUrl
} else {
    $template = [string](Get-Prop $tenantSite 'Template')
    Write-Host "  exists: template $template, sharing $(Get-Prop $tenantSite 'SharingCapability')"
    if ($template -notlike 'SITEPAGEPUBLISHING*') {
        throw "$SiteUrl exists but is not a communication site ($template). Pick another URL."
    }
    $groupId = [string](Get-Prop $tenantSite 'GroupId')
    if ($groupId -and $groupId -ne '00000000-0000-0000-0000-000000000000') {
        throw "$SiteUrl is connected to a Microsoft 365 group; the quarantine must not be. Pick another URL."
    }
}

# --- 2. sharing -------------------------------------------------------------------
Write-Host 'Sharing'
# An unreadable status counts as "not yet": the Set is idempotent.
$sharing = [string](Get-Prop $tenantSite 'SharingCapability')
$nonOwners = [string](Get-Prop $tenantSite 'DisableSharingForNonOwnersStatus')
if ($sharing -ne 'Disabled' -or $nonOwners -ne 'True') {
    Invoke-Change 'SharingCapability Disabled; sharing for non-owners disabled' {
        Set-PnPTenantSite -Identity $SiteUrl -SharingCapability Disabled -DisableSharingForNonOwners
    }
} else {
    Write-Host '  already Disabled'
}

# --- site-level objects -------------------------------------------------------------
Connect-To $SiteUrl
$roleDefs = Get-PnPRoleDefinition
# Role names are localised ("Pełna kontrola" on a Polish site); the kind is not.
$fullControl = ($roleDefs | Where-Object { [string]$_.RoleTypeKind -eq 'Administrator' } | Select-Object -First 1).Name
$contribute = ($roleDefs | Where-Object { [string]$_.RoleTypeKind -eq 'Contributor' } | Select-Object -First 1).Name
if (-not $fullControl -or -not $contribute) { throw 'Could not find the Full Control / Contribute role definitions.' }
$ownersGroup = Get-PnPGroup -AssociatedOwnerGroup
$library = Get-PnPList -Identity $LibraryUrl -ThrowExceptionIfListNotFound
$null = Get-PnPProperty -ClientObject $library -Property HasUniqueRoleAssignments, Title, Id

# --- 3. reviewer group ----------------------------------------------------------------
Write-Host "Group '$GroupName'"
$group = Get-PnPGroup -Identity $GroupName -ErrorAction SilentlyContinue
if ($null -eq $group) {
    Invoke-Change "create SharePoint group '$GroupName' (owned by the site owners, membership visible to members only)" {
        New-PnPGroup -Title $GroupName -Owner $ownersGroup.Title `
            -Description 'BCR staff who review documents the ledger could not tie to one client.' | Out-Null
        Set-PnPGroup -Identity $GroupName -AllowRequestToJoinLeave:$false -AllowMembersEditMembership:$false `
            -OnlyAllowMembersViewMembership:$true
    }
}
$existing = @()
if ($null -ne $group) { $existing = @(Get-PnPGroupMember -Group $GroupName | ForEach-Object { $_.LoginName.ToLowerInvariant() }) }
foreach ($upn in $ReviewerUpn) {
    $login = "i:0#.f|membership|$($upn.ToLowerInvariant())"
    if ($existing -contains $login) {
        Write-Host "  $upn — member"
    } else {
        Invoke-Change "add $upn to '$GroupName'" { Add-PnPGroupMember -Group $GroupName -LoginName $upn }
    }
}
$wanted = @($ReviewerUpn | ForEach-Object { "i:0#.f|membership|$($_.ToLowerInvariant())" })
foreach ($login in $existing) {
    if ($wanted -notcontains $login) { Write-Warning "  '$GroupName' also contains $login (not removed; check it)" }
}

# --- 4. library permissions -----------------------------------------------------------
Write-Host "Library '$($library.Title)'"
if (-not $library.HasUniqueRoleAssignments) {
    Invoke-Change 'break permission inheritance (no copy)' {
        Set-PnPList -Identity $library -BreakRoleInheritance -CopyRoleAssignments:$false
    }
} else {
    Write-Host '  unique permissions already'
}

function Get-Assignments($SecurableObject) {
    $ras = Get-PnPProperty -ClientObject $SecurableObject -Property RoleAssignments
    foreach ($ra in $ras) {
        $null = Get-PnPProperty -ClientObject $ra -Property Member, RoleDefinitionBindings
        [pscustomobject]@{
            Assignment = $ra
            Login      = [string]$ra.Member.LoginName
            Title      = [string]$ra.Member.Title
            Roles      = @($ra.RoleDefinitionBindings | ForEach-Object { $_.Name })
        }
    }
}

$libAssignments = @()
if ($library.HasUniqueRoleAssignments) { $libAssignments = @(Get-Assignments $library) }
function Test-Grant([string] $Title, [string] $Role) {
    return @($libAssignments | Where-Object { $_.Title -eq $Title -and $_.Roles -contains $Role }).Count -gt 0
}
if (-not (Test-Grant $ownersGroup.Title $fullControl)) {
    Invoke-Change "grant '$($ownersGroup.Title)' $fullControl on the library" {
        Set-PnPListPermission -Identity $library -Group $ownersGroup.Title -AddRole $fullControl
    }
}
if (-not (Test-Grant $GroupName $contribute)) {
    Invoke-Change "grant '$GroupName' $contribute on the library" {
        Set-PnPListPermission -Identity $library -Group $GroupName -AddRole $contribute
    }
}
foreach ($a in $libAssignments) {
    if ($a.Title -ne $ownersGroup.Title -and $a.Title -ne $GroupName -and -not (Test-EveryoneClaim $a.Login)) {
        Write-Warning "  the library also grants $($a.Roles -join ', ') to $($a.Title) ($($a.Login)); not removed, check it"
    }
}

# --- 5. Everyone / EEEU --------------------------------------------------------------
Write-Host 'Everyone / Everyone except external users'
$web = Get-PnPWeb
$targets = @()
$targets += @(Get-Assignments $web | Where-Object { Test-EveryoneClaim $_.Login } | ForEach-Object { $_ | Add-Member -NotePropertyName Scope -NotePropertyValue 'site' -PassThru })
$targets += @($libAssignments | Where-Object { Test-EveryoneClaim $_.Login } | ForEach-Object { $_ | Add-Member -NotePropertyName Scope -NotePropertyValue 'library' -PassThru })
foreach ($t in $targets) {
    Invoke-Change "remove '$($t.Title)' ($($t.Roles -join ', ')) from the $($t.Scope)" {
        $t.Assignment.DeleteObject()
        Invoke-PnPQuery
    }
}
$groupsToScan = @(Get-PnPGroup | Where-Object { $_.Title -ne $null })
foreach ($g in $groupsToScan) {
    foreach ($m in @(Get-PnPGroupMember -Group $g.Title)) {
        if (Test-EveryoneClaim $m.LoginName) {
            Invoke-Change "remove '$($m.Title)' from group '$($g.Title)'" {
                Remove-PnPGroupMember -Group $g.Title -LoginName $m.LoginName
            }
        }
    }
}
if ($targets.Count -eq 0) { Write-Host '  none granted directly' }

# --- 6. columns and root folder ----------------------------------------------------------
Write-Host 'Columns'
foreach ($name in $Columns) {
    $field = Get-PnPField -List $library -Identity $name -ErrorAction SilentlyContinue
    if ($null -ne $field) {
        Write-Host "  $name — exists ($($field.TypeAsString))"
        if ($field.TypeAsString -ne 'Text') { Write-Warning "  $name is $($field.TypeAsString), not single line of text" }
    } else {
        Invoke-Change "add single-line text column $name" {
            Add-PnPField -List $library -DisplayName $name -InternalName $name -Type Text -AddToDefaultView | Out-Null
        }
    }
}
Write-Host 'Root folder'
$folderUrl = "$LibraryUrl/$RootFolder"
if ($null -ne (Get-PnPFolder -Url $folderUrl -ErrorAction SilentlyContinue)) {
    Write-Host "  $RootFolder — exists"
} else {
    Invoke-Change "create folder $RootFolder" { Resolve-PnPFolder -SiteRelativePath $folderUrl | Out-Null }
}

# --- resulting state -----------------------------------------------------------------------
Write-Host ''
if (-not $Apply) {
    Write-Host "Dry run: $changes change(s) planned, none made. Re-run with -Apply."
    Write-Host ''
    return
}

Connect-To $adminUrl
$tenantSite = Get-PnPTenantSite -Identity $SiteUrl
Connect-To $SiteUrl
$library = Get-PnPList -Identity $LibraryUrl -ThrowExceptionIfListNotFound
$null = Get-PnPProperty -ClientObject $library -Property HasUniqueRoleAssignments, Title
$site = Get-PnPSite -Includes Id
$web = Get-PnPWeb -Includes Id
$graphSiteId = "$($uri.Host),$($site.Id),$($web.Id)"

Write-Host 'Resulting state'
Write-Host "  site                $SiteUrl"
$finalGroup = [string](Get-Prop $tenantSite 'GroupId')
$finalNonOwners = [string](Get-Prop $tenantSite 'DisableSharingForNonOwnersStatus')
Write-Host "  template            $(Get-Prop $tenantSite 'Template')"
Write-Host "  Microsoft 365 group $(if ($finalGroup -in @('', '00000000-0000-0000-0000-000000000000')) { 'none' } else { $finalGroup })"
Write-Host "  sharing             $(Get-Prop $tenantSite 'SharingCapability'); sharing disabled for non-owners: $(if ($finalNonOwners) { $finalNonOwners } else { 'unknown' })"
Write-Host "  Graph site id       $graphSiteId"
Write-Host "  library             '$($library.Title)', unique permissions: $($library.HasUniqueRoleAssignments)"
foreach ($a in @(Get-Assignments $library)) {
    $flag = if (Test-EveryoneClaim $a.Login) { '  ← EVERYONE, should not be here' } else { '' }
    Write-Host "    $($a.Title): $($a.Roles -join ', ')$flag"
}
Write-Host "  '$GroupName'"
foreach ($m in @(Get-PnPGroupMember -Group $GroupName)) { Write-Host "    $($m.Email) $($m.LoginName)" }
Write-Host '  columns'
foreach ($name in $Columns) {
    $f = Get-PnPField -List $library -Identity $name -ErrorAction SilentlyContinue
    Write-Host "    $name $(if ($f) { $f.TypeAsString } else { 'MISSING' })"
}
Write-Host ''
Write-Host 'Ingestion settings for this site:'
Write-Host "  QUARANTINE_SITE_HOSTNAME=$($uri.Host)"
Write-Host "  QUARANTINE_SITE_PATH=$sitePath"
Write-Host "  QUARANTINE_DRIVE_NAME=$($library.Title)"
Write-Host "  QUARANTINE_ROOT_FOLDER=$RootFolder"
Write-Host ''
Write-Host 'Next: grant the ingestion identity write on this site (README.md, "Write grant"),'
Write-Host "using the Graph site id above: $graphSiteId"
Write-Host ''
