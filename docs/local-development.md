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

`curl` straight into the ingestion API for tight iteration on classification:

```bash
ACCESS_TOKEN=$(az account get-access-token \
  --resource api://<ingestion-app-id> \
  --query accessToken -o tsv)

cat > /tmp/payload.json <<JSON
{
  "filename": "Invoice_03_2026.pdf",
  "contentType": "application/pdf",
  "contentBase64": "$(base64 -i ~/Downloads/sample.pdf)",
  "source": {
    "tenantId": "<tenant-id>",
    "channelId": "msteams",
    "conversationId": "local-test",
    "activityId": "local-$(date +%s)"
  }
}
JSON

curl -X POST http://localhost:7071/api/ingest \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d @/tmp/payload.json | jq .
```

## Useful Kusto

```kusto
// All ingestion attempts in the last hour, grouped by outcome
requests
| where timestamp > ago(1h)
| where name == "POST /api/ingest"
| summarize count() by tostring(customDimensions["resultCode"]), success
| order by count_ desc
```

```kusto
// Trace one Teams conversation end-to-end
union requests, traces, exceptions
| where customDimensions["conversationId"] == "<paste-id>"
| order by timestamp asc
| project timestamp, itemType, message, customDimensions
```
