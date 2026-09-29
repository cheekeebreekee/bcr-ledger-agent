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

## Why the Bot Framework Emulator cannot reach the bot

**No Emulator request reaches the bot, in any `BOT_GATE_MODE`.** The bot accepts only tokens the
Bot Framework channel service issued (`bot/channelAuth.ts`). Authentication runs before any
middleware, so the gate never sees an Emulator activity, and `BOT_GATE_MODE=log` changes nothing
for it. The Emulator gets HTTP 500, and the log shows `adapter.processActivityDirect threw` with:

- `Only Bot Framework channel tokens are accepted.` when the Emulator signs in with the app id
  and password: that is exactly the token a stolen bot secret could mint
  ([`security.md`](security.md) T15);
- `Unauthorized Access. Request is not authorized` when it sends no credentials. The bot cannot
  run without authentication: `MICROSOFT_APP_ID` and `MICROSOFT_APP_PASSWORD` are required.

Behind authentication, the gate lets through only a Teams 1:1 chat
(`conversation.conversationType` = `personal`) from the BCR tenant (`channelData.tenant.id`), sent
by a user with a GUID `from.aadObjectId`; ingestion checks the same again.

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

Ingestion reads the uploader's account first (`userType`, `userPrincipalName`), before the
Directory: a client is its `{NIP}@bcr-group.pl` account, and guests have no capability. A guest,
a user of any other type, or a deleted one comes back `rejected` with `ClientAccountRequired`,
and an account your local credential (`az login`) cannot read comes back `rejected` with
`RetryLater`; nothing is stored for either, not even in the quarantine. A Member whose id is on
no row of your test Directory comes back as `quarantined`, with no result: the expected answer
for an unbound uploader. To see a document filed, the test row must be bound (`RootFolder`,
`DriveId` and `TeamId` set, `SitePath` exactly `/sites/<name>`, and `SiteHostname` equal to your
local `QUARANTINE_SITE_HOSTNAME`); otherwise it is quarantined as `unbound_target` or
`forbidden_target`. The uploader must be the row's client account: a Member whose UPN is
`<the row's 10-digit NIP>@bcr-group.pl` (otherwise `not_client_account`). The domain is a
constant (`CLIENT_ACCOUNT_DOMAIN` in `@bcr/shared`), not a setting, so outside BCR's tenant a
local run can show the refusals and the quarantine but never a filing; filing is tested with
fakes (`clientResolver.test.ts`, `clientAccountRegression.test.ts`). The uploader must also be a
member of the row's Team and of no other Team, and your local credential must be able to read
their `memberOf`; otherwise it is quarantined as `membership_mismatch` or
`membership_unverified`. Do not set `MEMBERSHIP_CHECK_MODE=off` to get round it, even locally:
test the check, not around it (and it never skips the account rule).

The channel-inbox timer is registered locally too, and with `INBOX_SWEEP_MODE=off` (the example
setting) each tick returns at once. Do not set `shadow` or `enforce` against a real tenant from a
laptop: `enforce` moves files in client channels. The sweep is tested with fake Graph doubles
(`channelInbox.test.ts`), which is where to try a change.

## Useful Kusto

```kusto
// Routing outcomes in the last hour (Phase-0 events: ids and codes only)
traces
| where timestamp > ago(1h) and cloud_RoleName startswith "func-bcr-ingest"
| extend m = parse_json(message), msg = tostring(parse_json(message).msg)
| where msg in ("document.filed", "document.quarantined", "directory.conflict", "ingestion.caller.rejected", "membership.mismatch", "membership.unverified", "identity.refused", "identity.unverified", "client_account.mismatch", "batch.refused")
| summarize count() by msg, reason = coalesce(tostring(m.quarantineReason), tostring(m.reason), tostring(m.accountCheck))
```

```kusto
// Trace one Teams conversation end-to-end
union requests, traces, exceptions
| where customDimensions["conversationId"] == "<paste-id>"
| order by timestamp asc
| project timestamp, itemType, message, customDimensions
```
