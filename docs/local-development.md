# Local development

## Run the bot and ingestion API side-by-side

```bash
# Terminal 1 — ingestion API on :7071
yarn start:ingestion

# Terminal 2 — bot on :3978
yarn start:bot

# Terminal 3 — Bot Framework Emulator
#   open it, "Open Bot" → http://localhost:3978/api/messages
#   Microsoft App ID / Password = the values in local.settings.json
```

## Mocking the ingestion API while iterating on the bot

If you only want to work on the bot UX you can stub the ingestion API.
The included `mockIngestion.ts` mini-server returns a canned success
response, lets you verify the adaptive cards render correctly, and never
touches SharePoint:

```bash
yarn ts-node scripts/mockIngestion.ts
# then set INGESTION_BASE_URL=http://localhost:7071 in the bot's
# local.settings.json (no real auth required because the bot still mints
# a JWT but the mock server just discards it)
```

## Triggering ingestion without the bot

⚠️ **A local ingestion writes to whatever the Directory it reads points at.** Point
`CLIENT_DIRECTORY_*` at a test list, and `QUARANTINE_*` at a test site, in your
`local.settings.json`. Never point them at the live Client Directory, and never upload a real
client document from a laptop.

Since Phase 0, ingestion has a single route, `POST /api/ingest/batch`. It accepts a token only
from an app id in `BOT_CALLER_APP_IDS`. It also requires a 1:1-chat source from the configured
tenant with a UUID user id. For local iteration, put the app id your token carries in your
**local** `BOT_CALLER_APP_IDS`. Never add it to a deployed app.

```bash
ACCESS_TOKEN=<a token for api://<ingestion-app-id> whose appid is in your local BOT_CALLER_APP_IDS>

cat > /tmp/payload.json <<JSON
{
  "documents": [{
    "filename": "Invoice_03_2026.pdf",
    "contentType": "application/pdf",
    "contentBase64": "$(base64 -i ~/Downloads/synthetic-sample.pdf)"
  }],
  "source": {
    "tenantId": "<AZURE_TENANT_ID>",
    "channelId": "msteams",
    "conversationId": "local-test",
    "activityId": "local-$(date +%s)",
    "conversationType": "personal",
    "userAadObjectId": "<object id of a test user>"
  }
}
JSON

curl -X POST http://localhost:7071/api/ingest/batch \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d @/tmp/payload.json | jq .
```

A user id that is on no row of your test Directory comes back as `quarantined`, with no result.
That is the expected answer for an unbound uploader.

## Useful Kusto

```kusto
// Routing outcomes in the last hour (Phase-0 events: ids and codes only)
traces
| where timestamp > ago(1h) and cloud_RoleName startswith "func-bcr-ingest"
| extend m = parse_json(message), msg = tostring(parse_json(message).msg)
| where msg in ("document.filed", "document.quarantined", "directory.conflict", "ingestion.caller.rejected")
| summarize count() by msg, reason = tostring(m.quarantineReason)
```

```kusto
// Trace one Teams conversation end-to-end
union requests, traces, exceptions
| where customDimensions["conversationId"] == "<paste-id>"
| order by timestamp asc
| project timestamp, itemType, message, customDimensions
```
