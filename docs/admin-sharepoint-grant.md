# Admin: grant SharePoint write permission to the ingestion function

The BCR Ledger ingestion **Azure Function** needs permission to write to
the SharePoint document library. This is a **two-step** grant via
Microsoft Graph.

> **2026-06-17 — important correction.** The previous grant targeted
> the *Ingestion API app registration* (`b8b90018-…`). That was wrong:
> the function actually authenticates to Microsoft Graph using its
> **system-assigned managed identity** (a separate service principal,
> object id `7984e56c-…`, app id `d5226274-…`, display name
> `func-bcr-ingest-dev-vyyintffz6ehq`). Smoke test failed with
> `GraphError 401 generalException` because the MI itself has no Graph
> permissions yet. Please redo the grant against the **MI** below.

---

## Two grants required

| # | Where | What | Why |
|---|---|---|---|
| 1 | Microsoft Graph (tenant-wide) | App role **`Sites.Selected`** (application) | Without this, the MI's Graph token has no `roles` claim — Graph rejects every call. |
| 2 | The SharePoint site | Permission **`write`** | Restricts what `Sites.Selected` lets the MI do to a single site. |

Both must be done by an admin **with the right directory role**:

- **Step 1 (Graph app role)** — requires **Global Administrator** OR
  **Privileged Role Administrator**. SharePoint Administrator is
  **not** enough; `AppRoleAssignment.ReadWrite.All` Graph permission
  alone is **not** enough either. Azure AD blocks app-role assignments
  on Microsoft-owned services (like Microsoft Graph) for everyone
  below those two directory roles.
- **Step 2 (per-site grant)** — requires **SharePoint Administrator**
  (or Global Admin), with `Sites.FullControl.All` consented.

If the same person can do both, great. Otherwise split: Global Admin
runs Step 1, SharePoint Admin runs Step 2.

The same `AADSTS65002` Azure CLI limitation applies, so use
**Microsoft Graph Explorer** for both steps. ~2 minutes.

---

## Prep: sign in to Graph Explorer

1. Open <https://developer.microsoft.com/graph/graph-explorer>.
2. Click **Sign in to Graph Explorer**. Sign in with your Global Admin
   account in tenant **BCR Group EU** (`379013e4-…`).
3. Click your avatar (top-right) → **Consent to permissions**. Search
   for and **Consent** to both:
   - `AppRoleAssignment.ReadWrite.All`
   - `Sites.FullControl.All`

   In the popup, choose *"Consent on behalf of your organization"* →
   **Accept**.

---

## Step 1 — Grant `Sites.Selected` (Graph app role) to the MI

> ⚠️ **Step 1 requires Global Administrator or Privileged Role
> Administrator.** If the previous admin got
> `403 Authorization_RequestDenied` here, it's because their account
> only has SharePoint Admin / Cloud App Admin / etc. — those roles
> cannot assign app roles on the Microsoft Graph service principal.
> Have a Global Admin run this step.

This is two POSTs (one to look up the role id is technically optional
because the id is constant for Microsoft Graph, but we'll do it
explicitly so the values are visible).

### 1a. (optional) Look up the role id

- Method: **GET**
- URL:
  ```
  https://graph.microsoft.com/v1.0/servicePrincipals(appId='00000003-0000-0000-c000-000000000000')?$select=appRoles
  ```

In the response, find the entry where `"value": "Sites.Selected"`. Its
`id` should be:

```
883ea226-0bf2-4a8f-9f9d-92c9162a727d
```

(That value is well-known and constant across all tenants.)

### 1b. Create the app-role assignment

- Method: **POST**
- URL:
  ```
  https://graph.microsoft.com/v1.0/servicePrincipals/7984e56c-e264-427d-8e90-ff57dea6b0fa/appRoleAssignments
  ```
- **Request body** tab — paste this **exact** JSON (every value is
  already resolved — do **not** substitute anything):
  ```json
  {
    "principalId": "7984e56c-e264-427d-8e90-ff57dea6b0fa",
    "resourceId":  "d36dca77-e03c-4dce-9928-1224658c24c7",
    "appRoleId":   "883ea226-0bf2-4a8f-9f9d-92c9162a727d"
  }
  ```
  Field meanings (for reference — do not change):
  - `principalId` = Ingestion function MI object id (the **grantee**).
  - `resourceId`  = **Microsoft Graph service principal object id** in
    this tenant (the **owner of the role**). This is *not* your user
    object id and *not* the Microsoft Graph app id `00000003-…`. The
    correct value for BCR Group EU is hard-coded above.
  - `appRoleId`   = `Sites.Selected` app role id (constant for Graph).
- Click **Run query**. Expected: **HTTP 201 Created**.

### Verify

- Method: **GET**
- URL:
  ```
  https://graph.microsoft.com/v1.0/servicePrincipals/7984e56c-e264-427d-8e90-ff57dea6b0fa/appRoleAssignments
  ```

You should see one entry with `"resourceDisplayName": "Microsoft Graph"`
and `"appRoleId": "883ea226-0bf2-4a8f-9f9d-92c9162a727d"`.

---

## Step 2 — Grant `write` on the SharePoint site to the MI

- Method: **POST**
- URL:
  ```
  https://graph.microsoft.com/v1.0/sites/bcrgroupeu.sharepoint.com,2e9926d1-8a68-4f10-a605-eccae1037a8e,126f6b2b-a082-445c-9e2e-dd2a3d263d2d/permissions
  ```
- **Request body** tab — paste exactly:
  ```json
  {
    "roles": ["write"],
    "grantedToIdentities": [
      {
        "application": {
          "id": "d5226274-a2c0-4ae9-9c3b-34158c43f2fc",
          "displayName": "func-bcr-ingest-dev-vyyintffz6ehq"
        }
      }
    ]
  }
  ```
- Click **Run query**. Expected: **HTTP 201 Created**.

### Verify

- Method: **GET**, same URL above.

You should see an entry with:
- `"roles": ["write"]`
- `"grantedToIdentities[0].application.id": "d5226274-a2c0-4ae9-9c3b-34158c43f2fc"`

> **Optional cleanup.** The previous (incorrect) grant for app id
> `b8b90018-9af0-4d7a-ada2-71559952ebbe` is still in the list. It's
> harmless (no MI is using that app id to call Graph), but you can
> delete it:
> `DELETE https://graph.microsoft.com/v1.0/sites/<siteId>/permissions/<permissionId>`
> where `<permissionId>` is the `id` of the old entry.

---

## After both grants

Reply in chat — the dev team will re-run the end-to-end smoke test.
Expected result: HTTP 201 from the ingestion API plus the test file
appearing in the SharePoint site's **Documents** library at
`Invoices/2026/03/Invoice_03_2026.pdf`.

---

## Reference data

| Item | Value |
|---|---|
| Tenant ID | `379013e4-7d25-4668-b99f-3cfa2264dc71` |
| Tenant name | BCR Group EU |
| Site URL | <https://bcrgroupeu.sharepoint.com/sites/0000TESTSp.zo.o.-Ksigowo/> |
| Site Graph ID | `bcrgroupeu.sharepoint.com,2e9926d1-8a68-4f10-a605-eccae1037a8e,126f6b2b-a082-445c-9e2e-dd2a3d263d2d` |
| **Ingestion MI — object (principal) ID** | `7984e56c-e264-427d-8e90-ff57dea6b0fa` |
| **Ingestion MI — app ID** | `d5226274-a2c0-4ae9-9c3b-34158c43f2fc` |
| **Ingestion MI — display name** | `func-bcr-ingest-dev-vyyintffz6ehq` |
| Microsoft Graph SP — appId (constant across tenants) | `00000003-0000-0000-c000-000000000000` |
| **Microsoft Graph SP — object ID in BCR Group EU tenant** | `d36dca77-e03c-4dce-9928-1224658c24c7` |
| Microsoft Graph `Sites.Selected` app role id (constant) | `883ea226-0bf2-4a8f-9f9d-92c9162a727d` |
| Role to grant on the site | `write` |

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| **Step 1 returns `403 Authorization_RequestDenied`** | First check **`resourceId`** in the body — it must be `d36dca77-e03c-4dce-9928-1224658c24c7` (Microsoft Graph SP object id in this tenant). A common mistake is to put a user object id or the Graph `appId` (`00000003-…`) there — both return 403. If `resourceId` is correct, then the signed-in user is missing the **Global Administrator** or **Privileged Role Administrator** directory role. SharePoint Admin and the `AppRoleAssignment.ReadWrite.All` Graph permission are not enough on their own. |
| `Forbidden` on Step 2 POST | The `Sites.FullControl.All` consent was skipped, or your account is not a SharePoint Admin / Global Admin. |
| Step 2 still returns 401 to the function after both grants | Token caching — restart the function app: in Azure Portal go to the Function App → **Overview** → **Restart**. Or ask the dev team to `az functionapp restart`. |
| Already exists (4xx) | Permission already granted. Skip to next step. |

---

## If you do not have Global Admin (fallback)

If nobody available has Global Administrator or Privileged Role
Administrator, the dev team can do Step 1 by **adding it to the Bicep
template and re-deploying**. The deployment principal (the user or
service principal that runs `az deployment group create`) must hold
`Microsoft.Authorization/roleAssignments/write` AND `Application
Administrator` (a built-in Azure AD role) — a slightly less privileged
combination.

Alternatively, the dev team can run a one-off PowerShell command on
behalf of a Global Admin who briefly grants them PIM access:

```powershell
Connect-MgGraph -TenantId 379013e4-7d25-4668-b99f-3cfa2264dc71 `
  -Scopes AppRoleAssignment.ReadWrite.All,Application.Read.All

$miOid    = '7984e56c-e264-427d-8e90-ff57dea6b0fa'
$graphSp  = Get-MgServicePrincipal -Filter "appId eq '00000003-0000-0000-c000-000000000000'"
$roleId   = ($graphSp.AppRoles | Where-Object { $_.Value -eq 'Sites.Selected' }).Id

New-MgServicePrincipalAppRoleAssignment `
  -ServicePrincipalId $miOid `
  -PrincipalId        $miOid `
  -ResourceId         $graphSp.Id `
  -AppRoleId          $roleId
```

This still requires the signed-in user to hold Global Admin or
Privileged Role Administrator at the time of the call — it just gives
an auditable, scriptable path versus clicking through Graph Explorer.