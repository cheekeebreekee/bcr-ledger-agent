# Local development

## Run the bot and ingestion API side-by-side

```bash
cp packages/teams-bot/local.settings.json.example packages/teams-bot/local.settings.json
cp packages/document-ingestion/local.settings.json.example packages/document-ingestion/local.settings.json
# fill both in: see setup-guide.md §6. Both apps refuse to start on a missing or malformed setting.

# Terminal 1 — ingestion API on :7071
yarn start:ingestion

# Terminal 2 — bot on :3978
yarn start:bot
```

The bot needs `MICROSOFT_APP_ID`, `MICROSOFT_APP_PASSWORD` and `MICROSOFT_APP_TENANT_ID` to
start, so it runs as a real app registration: use a test registration's values, in your local
file only.

## What the Bot Framework Emulator can and cannot do

**The Emulator cannot get a file filed.** Every activity passes the bot's gate first, and the
gate lets through only a Teams 1:1 chat (`conversation.conversationType` = `personal`) from the
BCR tenant (`channelData.tenant.id`), sent by a user with a GUID `from.aadObjectId`. Emulator
activities carry none of these by default.

- With `BOT_GATE_MODE=enforce`, the value in the example settings and the default, the gate
  refuses every Emulator activity. The bot answers a refused message only in a personal
  conversation, so the Emulator sees **no reply at all**. That is the gate working, not a
  broken bot: the log shows `bot.gate.rejected` with the reason.
- With `BOT_GATE_MODE=log` in your **local** settings, the gate logs the refusal and lets the turn
  through. That is enough for the help card and card layout. A file sent this way still comes
  back as a rejected row: the bot forwards the activity's conversation type, tenant and user id
  as they are, and ingestion's source check refuses the batch with 400.

Never set `log` on a deployed bot outside the rollout window in
[`operations/human-steps.md`](operations/human-steps.md#phase-0).

To see what the bot does with a real Teams activity, use its tests:
`packages/teams-bot/src/bot/ledgerBot.test.ts` drives `LedgerBot` through `TestAdapter` with
Teams-shaped 1:1 activities and a fake ingestion client, so card changes can be checked without
the Emulator, a token or SharePoint:

```bash
yarn workspace @bcr/teams-bot test src/bot/ledgerBot.test.ts
```

To exercise ingestion itself, call it directly, as below.

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
