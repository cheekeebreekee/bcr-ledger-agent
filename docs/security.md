# Security & compliance

## 1. Identity model

| Trust boundary | Principal | Credential | Validated by |
|---|---|---|---|
| Teams client → Bot Function | Bot Framework system | JWT signed by `login.botframework.com` | `CloudAdapter` / `BotFrameworkAuthentication` |
| Bot Function → Ingestion Function | Bot AAD App | Client secret (Key Vault) → access token | `AuthMiddleware` (this repo) |
| Ingestion Function → Microsoft Graph | Function App's managed identity | Federated → AAD token | Microsoft Graph |
| Ingestion Function → Key Vault | Function App's managed identity | RBAC: *Key Vault Secrets User* | Azure Key Vault |
| Ingestion Function → Document Intelligence | Function App's managed identity | RBAC: *Cognitive Services User* | AI Document Intelligence |

## 2. Secrets inventory

| Secret | Where it lives | Who consumes it |
|---|---|---|
| `bot-app-password` | Key Vault | Bot Function — `MICROSOFT_APP_PASSWORD` |
| `document-intelligence-key` | Key Vault (optional) | Ingestion Function — `DOCUMENT_INTELLIGENCE_KEY` |
| Function App master keys | Azure platform | Not used (we set `authLevel: 'anonymous'` and validate JWTs ourselves) |
| Storage account key | Azure platform | Auto-managed by Functions runtime |

**Nothing else is a secret.** Everything is referenced from app settings
using `@Microsoft.KeyVault(SecretUri=...)` so a Key Vault rotation is just
a `az keyvault secret set` followed by a Function App restart.

## 3. Threat model (top items)

1. **Forged Teams message.** Mitigated by Bot Framework JWT verification in
   `CloudAdapter`; we never trust `req.headers['x-ms-bot-source']` etc.
2. **Replay of valid bot → ingestion request.** Mitigated by JWT `iat`/`exp`
   (5-min token lifetime by default), HTTPS-only ingress, and idempotent
   uploads (collision-free filename strategy).
3. **Compromised bot identity uploads to wrong site.** Mitigated by
   `Sites.Selected` (Graph permission is scoped to a single SharePoint site).
4. **Malicious filename attempting path traversal.** Mitigated by
   `sanitizeFolderPath` / `sanitizeFilename` which strip path separators,
   forbid `..`, and reject reserved Windows names.
5. **Oversized payload DoS.** Mitigated by `MAX_DECODED_BYTES = 100 MiB`
   check in `validateIngestionPayload`, plus Azure Functions' built-in
   100-MB request body cap.
6. **Malware upload.** SharePoint itself runs A/V on every uploaded file
   (rejects with HTTP 423). The bot surfaces an explicit error card.

## 4. Data residency & retention

- **Application Insights** retains telemetry for 30 days (`logAnalytics.bicep`
  `retentionInDays: 30`).
- Document **content** is never logged; only filename, type, and folder path
  are written to telemetry.
- Document Intelligence does not persist customer data beyond the analysis
  call (see [Microsoft docs](https://learn.microsoft.com/azure/ai-services/document-intelligence/concept-privacy)).
- Audit log of every ingestion is written to App Insights with the Teams
  `activityId`, `conversationId`, `userAadObjectId`, the SharePoint
  `driveItemId`, and the classifier verdict.

## 5. Compliance checklist

- [x] HTTPS-only (`httpsOnly: true` on every Function App)
- [x] TLS ≥ 1.2 (`minTlsVersion: '1.2'`)
- [x] FTP disabled (`ftpsState: 'Disabled'`)
- [x] Managed identities (no service principals with stored secrets)
- [x] Key Vault soft-delete + purge protection
- [x] App roles enforce authorization (`Documents.Ingest`)
- [x] Structured logging with redaction of `authorization`, `*.token`, `*.secret`
- [x] No secrets in source (`.env` ignored; `.env.example` is the only template)
