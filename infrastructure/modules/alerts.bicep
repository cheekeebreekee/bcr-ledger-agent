// =============================================================================
// The ledger's email alerts: one action group and eight log alert rules on the
// App Insights component's `traces` (the pino JSON line is in `message`).
//
// Why these choices:
// - The pino level is inside the JSON (`level`: 40 warn, 50 error). The
//   `severityLevel` column is 1 on every pino line, so no rule filters on it.
//   Many lines have no `event` field (the name is in `msg` only), so the
//   rules match `msg`, and `event` only where the two differ.
// - Every count rule reduces its lines to a fixed `signal` code, keeps the
//   signals over their own threshold, and returns only `signal` and a count
//   `n`. The email carries the rule's description, its query text, the signal
//   (the one dimension) and the count; never a log line. A signal value is a
//   literal in the query, or a `msg`/`event` equal to a listed literal, so no
//   file name, NIP, path or id can reach the email or the alert resource.
// - Every rule runs every 15 minutes (the cheapest log alert price, USD 0.50 a
//   rule a month) and is stateful: one "Fired" email per signal, then one
//   "Resolved" email about the window plus 30-45 minutes after the last line,
//   and nothing in between while it lasts. A state is alerted on a line that
//   is logged again for as long as it lasts, never on a line said once per
//   cold start (a worker can live 8-22 hours): the membership check and the
//   inbox files waiting on a binding are on every inbox.tick (2 minutes), the
//   Directory's conflicts and excluded rows on every snapshot refresh, and a
//   webhook that did not resolve on every reviewNotify run. A bot-path line
//   is logged once per upload, so its "Resolved" proves nothing: the runbook
//   names the check that does.
// - `n` sums `itemCount` (times a tick's own count, for the inbox's
//   `skippedUnverified`), so host sampling cannot hide a burst. The one
//   exception is claude.capacity, which counts 5-minute bins, not lines.
// - The rules run with the permissions of whoever deployed them last (no
//   identity): nothing to grant, and nothing a rule can do but read logs.
// =============================================================================

@description('Region of the rules: the component\'s.')
param location string

@description('Tags applied to every resource.')
param tags object

@description('The environment suffix main.bicep uses, e.g. dev-<unique>.')
param nameSuffix string

@description('Resource id of the App Insights component the rules query.')
param appInsightsId string

@description('The ingestion Function App: its cloud_RoleName in traces.')
param ingestionAppName string

@description('The bot Function App: its cloud_RoleName in traces.')
param botAppName string

@description('Who gets the emails.')
param alertEmails array

@description('Rules to keep disabled, by short name (the part between alert-bcr- and the suffix).')
param disabledRules array

@description('Billed Anthropic calls in one hour that count as unusual spend.')
param billedCallsPerHour int

var runbook = 'Runbook: docs/operations/human-steps.md, section Alerts.'

var ingestOnly = '| where cloud_RoleName == "${ingestionAppName}"'
var bothApps = '| where cloud_RoleName in ("${ingestionAppName}", "${botAppName}")'

// The bot's authentication refusal: CloudAdapter wraps the SDK's error (and
// requireChannelIssuer's) in one generic Error whose message holds the
// inner stack. Any other adapter throw is a real error (the filing rule).
var botAuthRefused = 'msg == "adapter.processActivityDirect threw" and (err has "Unauthorized" or err contains "channel tokens" or err contains "botframework-connector/lib/auth/")'

// Every count query ends with these lines: `n` per signal, then each signal's
// own threshold. The rule fires on any row left (n > 0).
var perSignal = '| summarize n = sum(w) by signal'

resource actionGroup 'Microsoft.Insights/actionGroups@2023-01-01' = {
  name: 'ag-bcr-${nameSuffix}'
  location: 'global'
  tags: tags
  properties: {
    groupShortName: 'bcr-ledger'
    enabled: true
    emailReceivers: [
      for (address, i) in alertEmails: {
        name: 'email-${i}'
        emailAddress: address
        useCommonAlertSchema: true
      }
    ]
  }
}

// ---- The heartbeat: rows are counted, and none is the alert -----------------

var heartbeatName = 'alert-bcr-inbox-heartbeat-${nameSuffix}'

resource inboxHeartbeat 'Microsoft.Insights/scheduledQueryRules@2026-03-01' = {
  name: heartbeatName
  location: location
  tags: tags
  kind: 'LogAlert'
  properties: {
    displayName: 'BCR ledger: channel inbox silent'
    description: join(
      [
        'Sev 1. No inbox.tick from the ingestion app for 30 minutes. The channel inbox logs one every 2 minutes while INBOX_SWEEP_MODE is shadow or enforce, so clients\' channel posts are not being filed, or the telemetry stopped (the workspace\'s 1 GB daily cap).'
        'First: GET /api/health (build.inboxSweep); the app\'s state; az functionapp function list must name inboxSweep (else sync the triggers); the host\'s Executed \'Functions.inboxSweep\' lines.'
        'If you turned the sweep off on purpose, this email is expected; for a planned long stop add inbox-heartbeat to disabledRules in the alerts parameter file and redeploy the alerts.'
        runbook
      ],
      ' '
    )
    severity: 1
    enabled: !contains(disabledRules, 'inbox-heartbeat')
    scopes: [appInsightsId]
    evaluationFrequency: 'PT15M'
    // Twice the frequency: a restart or a late batch of telemetry (p99 49 s,
    // worst 203 s over 7 days) never empties a window; the longest gap
    // between ticks seen in a week was 6.5 minutes.
    windowSize: 'PT30M'
    criteria: {
      allOf: [
        {
          query: join(
            [
              'traces'
              ingestOnly
              '| where tostring(parse_json(message).msg) == "inbox.tick"'
              '| project timestamp'
            ],
            '\n'
          )
          timeAggregation: 'Count'
          operator: 'LessThan'
          threshold: 1
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    autoMitigate: true
    skipQueryValidation: false
    actions: {
      actionGroups: [actionGroup.id]
    }
  }
}

// ---- The count rules: signal codes over their thresholds ---------------------

var countRules = [
  {
    name: 'anthropic'
    displayName: 'BCR ledger: Anthropic refused, or unusual spend'
    severity: 1
    windowSize: 'PT1H'
    description: join(
      [
        'Sev 1. The classifier or the search model is refused by Anthropic, or spends unusually (signal):'
        'claude.paused or search.interpreter_paused: the account refused a call (billing: the credit is gone; unavailable: 401-404, key revoked or model withdrawn). Calls pause 15 minutes per worker; channel files wait, bot uploads get the retry text, searches answer unavailable. Nothing is filed wrong. First: the Anthropic console, the credit balance and the key (BCR\'s key; Roman tops up).'
        'claude.no_result: 5 or more requests in an hour refused as invalid or unreadable, not counting a refusal that names an image, PDF, page or media limit (the document\'s own: it went to 98_ for review). A burst means a request or billing change the code does not recognise. First: reason, status and apiErrorType of the claude.no_result lines.'
        'claude.capacity: Anthropic answered 429 (a rate or tier limit) or 529 (overloaded) in 9 or more of the hour\'s twelve 5-minute bins (n counts bins). These never count toward RETRY_EXHAUSTED, so channel files wait and bot uploads get the retry text for as long as it lasts. First: the Anthropic status page, and the org\'s rate limits in the console.'
        'billed_calls: ${billedCallsPerHour} or more billed calls in an hour (claude.usage and search.usage): a month-start flood, or a loop paying again (27 September: 86 in one hour). First: claude.usage by hour, and the inbox.tick counts.'
        runbook
      ],
      ' '
    )
    // claude.no_result leaves out a 400 that names a document limit (an image
    // over 10 MB base64 or 8000 px, a PDF over 100 pages, an encrypted PDF, a
    // media type that does not match): the document's, not the account's.
    // claude.retry_later is one line per waiting file per tick, so
    // claude.capacity counts the 5-minute bins that hold one, not the lines.
    query: join(
      [
        'traces'
        ingestOnly
        '| extend m = parse_json(message)'
        '| extend msg = tostring(m.msg), reason = tostring(m.reason)'
        '| extend signal = case('
        '    msg in ("claude.paused", "search.interpreter_paused"), msg,'
        '    msg == "claude.no_result" and reason in ("invalid_request", "internal_error", "malformed_output")'
        '      and not(tostring(m.apiErrorMessage) has_any ("image", "pdf", "pages", "dimensions", "media", "password", "encrypted")), "claude.no_result",'
        '    msg == "claude.retry_later" and reason in ("rate_limited", "overloaded"), "claude.capacity",'
        '    msg in ("claude.usage", "search.usage"), "billed_calls",'
        '    "")'
        '| where isnotempty(signal)'
        '| summarize w = sum(itemCount) by signal, b = iff(signal == "claude.capacity", bin(timestamp, 5m), datetime(null))'
        '| extend w = iff(signal == "claude.capacity", 1, w)'
        perSignal
        '| where n >= case(signal == "billed_calls", ${billedCallsPerHour}, signal == "claude.no_result", 5, signal == "claude.capacity", 9, 1)'
      ],
      '\n'
    )
  }
  {
    name: 'filing'
    displayName: 'BCR ledger: filing failed'
    severity: 2
    windowSize: 'PT15M'
    description: join(
      [
        'Sev 2. A document could not be filed or moved, or clients\' documents wait. The signal names the event:'
        'inbox.failed, inbox.row_failed, inbox.tick_failed, inbox.directory_unavailable, inbox.shadow_memo_failed, inbox.paid_memo_failed, inbox.listing_truncated (the channel inbox);'
        'document.quarantine_failed, batch.deadline_exceeded, batch.document_failed, client_target.unusable, sharepoint.possible_duplicate, request.rejected (a 400 to the bot), bot.batch_failed, bot.download_failed (the bot path);'
        'document.quarantined: a client account\'s upload was held in the quarantine as unmapped or unbound_target (the row is not bound); membership.unverified: an upload was held because its Teams could not be read;'
        'identity.unverified: 3 or more user reads failed in 15 minutes (bot uploads answer RetryLater, channel files wait as skippedUnverified; a 403 is the Directory.Read.All grant, H-8b);'
        'directory.unavailable, directory.refresh_failed (3 or more), graph.token_failed, quarantine.tagging_failed, classifier.threw;'
        'function.failed: a function invocation failed or timed out (the host\'s own line); other_error: an error line from either app that no other alert names.'
        'app.start_failed: an app\'s worker could not load its code at a host start (an app setting that fails validation at cold start, or a bad package), so none of its functions runs: the bot answers nothing, ingestion files nothing. It is logged at host starts only, so its Resolved email can come while the app is still down: fix the setting or redeploy, then az functionapp function list must name messages and mydocs (bot) or inboxSweep, reviewNotify and the routes (ingestion).'
        'Nothing is ever filed anywhere else: a document waits in the channel folder, is refused with a retry text, or is held in the quarantine. First: the runbook\'s query by event, then the stage, status and err fields.'
        runbook
      ],
      ' '
    )
    query: join(
      [
        'traces'
        bothApps
        '| extend m = parse_json(message)'
        '| extend msg = tostring(m.msg), ev = tostring(m.event), level = toint(m.level), err = tostring(m.err.message)'
        '| extend signal = case('
        '    msg in ("inbox.tick_failed", "inbox.row_failed", "inbox.failed", "inbox.directory_unavailable",'
        '      "inbox.shadow_memo_failed", "inbox.paid_memo_failed", "inbox.listing_truncated",'
        '      "batch.deadline_exceeded", "document.quarantine_failed", "sharepoint.possible_duplicate"), msg,'
        '    msg == "membership.unverified" and tostring(m.purpose) != "search", "membership.unverified",'
        '    msg in ("identity.unverified", "membership.unverified")'
        '      or (msg == "inbox.tick" and toint(m.skippedUnverified) > 0), "identity.unverified",'
        '    msg == "document.quarantined" and tostring(m.quarantineReason) in ("unmapped", "unbound_target"), "document.quarantined",'
        '    msg startswith "directory unavailable or too stale", "directory.unavailable",'
        '    msg == "directory refresh failed", "directory.refresh_failed",'
        '    msg startswith "client target unusable", "client_target.unusable",'
        '    msg == "failed to acquire Graph access token", "graph.token_failed",'
        '    msg == "setting list-item fields failed", "quarantine.tagging_failed",'
        '    msg == "classifier failed, continuing", "classifier.threw",'
        '    msg == "batch document failed", "batch.document_failed",'
        '    msg == "request rejected" and tostring(m.code) !in ("Unauthorized", "Forbidden"), "request.rejected",'
        '    msg == "batch ingestion failed", "bot.batch_failed",'
        '    msg == "failed to download attachment", "bot.download_failed",'
        '    message startswith "Executed \'Functions." and message contains "(Failed", "function.failed",'
        '    message startswith "Timeout value of", "function.failed",'
        '    message has "Worker was unable to load entry point" or message startswith "No job functions found", "app.start_failed",'
        '    level >= 50 and not(${botAuthRefused})'
        '      and ev !in ("review_notice.run_failed", "sharepoint.drive_mismatch", "sharepoint.forbidden_site")'
        '      and msg != "search.client_threw", "other_error",'
        '    "")'
        '| where isnotempty(signal)'
        '| extend w = itemCount * iff(msg == "inbox.tick", toint(m.skippedUnverified), 1)'
        perSignal
        '| where n >= case(signal in ("identity.unverified", "directory.refresh_failed"), 3, 1)'
      ],
      '\n'
    )
  }
  {
    name: 'index'
    displayName: 'BCR ledger: document index writes failing'
    severity: 2
    windowSize: 'PT15M'
    description: join(
      [
        'Sev 2. index.write_failed: a filed document got no row in the document index; or index.connection: 5 or more PostgreSQL connection errors in 15 minutes.'
        'Filing is unaffected, but those documents are missing from search, review notices and billing until written again. First: reason and status (SQLSTATE) of index.write_failed, the server\'s state, the ingestion login and its ledger_app grant.'
        runbook
      ],
      ' '
    )
    query: join(
      [
        'traces'
        ingestOnly
        '| extend msg = tostring(parse_json(message).msg)'
        '| extend signal = case('
        '    msg == "index.write_failed", "index.write_failed",'
        '    msg in ("index.pool_error", "index.connection_error"), "index.connection",'
        '    "")'
        '| where isnotempty(signal)'
        '| extend w = itemCount'
        perSignal
        '| where n >= iff(signal == "index.connection", 5, 1)'
      ],
      '\n'
    )
  }
  {
    name: 'security'
    displayName: 'BCR ledger: a guard refused a caller or a target'
    severity: 2
    windowSize: 'PT15M'
    description: join(
      [
        'Sev 2. Every guard is fail-closed, so nothing was filed wrong; each signal still needs a look the same day.'
        'caller.refused: a valid token from an app not allowed on the route (ingestion.caller.rejected, or a 403).'
        'caller.unauthenticated: 10 or more requests to ingestion without a valid token in 15 minutes.'
        'bot.auth_refused: the bot refused a request\'s Bot Framework token (expected once after your own negative check; real Teams traffic refused means the bot is unreachable: MICROSOFT_APP_TYPE, the app id, the channel-token rule).'
        'bot.gate_foreign: an activity from another tenant or without a user id.'
        'sharepoint.forbidden_site: a correctly spelled site path that resolved in Graph to BCR GROUP or the quarantine (a path spelled as one of them, or not canonical, is excluded earlier: the bindings alert\'s directory.forbidden_target). sharepoint.drive_mismatch: a target resolved to another drive than the row\'s. Both are incident indicators (H-12 step 13).'
        'inbox.unexpected_child: a channel listing returned items from outside the channel folder (raise it with Roman).'
        'search.no_access: 10 or more refused searches in 15 minutes.'
        'First: the runbook\'s query by event.'
        runbook
      ],
      ' '
    )
    query: join(
      [
        'traces'
        bothApps
        '| extend m = parse_json(message)'
        '| extend msg = tostring(m.msg), ev = tostring(m.event), code = tostring(m.code), reason = tostring(m.reason), err = tostring(m.err.message)'
        '| extend signal = case('
        '    msg == "ingestion.caller.rejected" or (msg == "request rejected" and code == "Forbidden"), "caller.refused",'
        '    msg == "request rejected" and code == "Unauthorized", "caller.unauthenticated",'
        '    ${botAuthRefused}, "bot.auth_refused",'
        '    msg == "bot.gate.rejected" and reason in ("tenant", "aad_object_id"), "bot.gate_foreign",'
        '    msg in ("sharepoint.forbidden_site", "inbox.unexpected_child"), msg,'
        '    ev == "sharepoint.drive_mismatch", "sharepoint.drive_mismatch",'
        '    msg == "search.no_access", "search.no_access",'
        '    "")'
        '| where isnotempty(signal)'
        '| extend w = itemCount'
        perSignal
        '| where n >= iff(signal in ("caller.unauthenticated", "search.no_access"), 10, 1)'
      ],
      '\n'
    )
  }
  {
    name: 'bindings'
    displayName: 'BCR ledger: a binding or a check is wrong'
    severity: 2
    windowSize: 'PT1H'
    description: join(
      [
        'Sev 2. A Directory binding, a client account or the membership check is wrong, seen in the last hour. Nothing is filed wrong (every case is held or waits), but the client\'s documents do not arrive until it is fixed, the same day.'
        'client_account.mismatch: a bound row\'s Member is not its {NIP}@ account (a staff id bound by mistake, or a NIP that is not 10 digits); bot uploads go to the quarantine as not_client_account, channel files wait (skippedNotClientAccount on every inbox.tick).'
        'membership.mismatch: a client account is in another Team too, or not in its own (R46); uploads are quarantined, channel files wait (other_teams, not_in_team: skippedMembership on every inbox.tick).'
        'directory.conflict: Client Directory rows share a key (a user id, site, drive, Team, NIP or ClientId), and the rows\' users route nowhere.'
        'directory.forbidden_target: a Directory row is excluded because its SiteHostname is not the tenant\'s host, or its SitePath is BCR GROUP, the quarantine, or not exactly /sites|teams/<name>. Its uploads are quarantined as forbidden_target and its channel is not swept. Tell Roman, run check; never point the row elsewhere by hand. Every row at once means QUARANTINE_SITE_HOSTNAME is wrong.'
        'membership.check_off: MEMBERSHIP_CHECK_MODE is off (R46 open; search is off with it), said on every inbox.tick.'
        'First: node tools/directory-bindings.mjs check, then propose and apply the whole plan; never unbind or change an account for it.'
        'A Resolved email proves nothing (a bot-path line is logged once per upload): the fix is confirmed by check (exit 0), and for membership.check_off by GET /api/health build.membershipCheck == enforce.'
        runbook
      ],
      ' '
    )
    // The states repeat: the inbox says the membership check and the files
    // waiting on a binding on every tick (2 minutes, while INBOX_SWEEP_MODE is
    // not off: the heartbeat's concern), the Directory its conflicts and
    // excluded rows on every snapshot refresh. The skipped and bot-path lines
    // carry the ids for the runbook's query.
    query: join(
      [
        'traces'
        ingestOnly
        '| extend m = parse_json(message)'
        '| extend msg = tostring(m.msg), ev = tostring(m.event), reason = tostring(m.reason)'
        '| extend signal = case('
        '    msg == "client_account.mismatch" or (msg == "inbox.skipped" and reason == "not_client_account")'
        '      or (msg == "inbox.tick" and toint(m.skippedNotClientAccount) > 0), "client_account.mismatch",'
        '    msg == "membership.mismatch" or (msg == "inbox.skipped" and reason in ("other_teams", "not_in_team"))'
        '      or (msg == "inbox.tick" and toint(m.skippedMembership) > 0), "membership.mismatch",'
        '    msg == "directory.conflict", "directory.conflict",'
        '    msg == "directory snapshot ready" and toint(m.excludedByReason.forbidden_target) > 0, "directory.forbidden_target",'
        '    msg == "document.quarantined" and tostring(m.quarantineReason) == "forbidden_target", "directory.forbidden_target",'
        '    ev == "membership.check_off" or (msg == "inbox.tick" and tostring(m.membershipCheck) == "off"), "membership.check_off",'
        '    "")'
        '| where isnotempty(signal)'
        '| extend w = itemCount'
        perSignal
        '| where n >= 1'
      ],
      '\n'
    )
  }
  {
    name: 'review-notices'
    displayName: 'BCR ledger: review notices not posted'
    severity: 3
    windowSize: 'PT30M'
    description: join(
      [
        'Sev 3. Review notices are not reaching the staff channel: review_notice.post_failed, read_failed or run_failed in two runs within 30 minutes, or review_notice.mark_failed once (a card went out but its rows were not marked, so it will be posted again).'
        'review_notice.webhook_unresolved: REVIEW_WEBHOOK_URL did not resolve to an https URL, so notices are off (review_notice.off on every run). First: the setting\'s Key Vault reference status in the portal, and the review-webhook-url secret (present, enabled, not expired) and the app\'s access to the vault.'
        'The documents are filed in 98_; only the notice waits, and it is retried every 10 minutes. First: the status of post_failed, then the Workflows flow, its owner and its run history in Power Automate.'
        runbook
      ],
      ' '
    )
    query: join(
      [
        'traces'
        ingestOnly
        '| extend m = parse_json(message)'
        '| extend msg = tostring(m.msg)'
        '| extend signal = case('
        '    msg in ("review_notice.run_failed", "review_notice.read_failed",'
        '      "review_notice.post_failed", "review_notice.mark_failed"), msg,'
        '    msg == "review_notice.off" and tostring(m.reason) == "webhook_unresolved", "review_notice.webhook_unresolved",'
        '    "")'
        '| where isnotempty(signal)'
        '| extend w = itemCount'
        perSignal
        '| where n >= iff(signal == "review_notice.mark_failed", 1, 2)'
      ],
      '\n'
    )
  }
  {
    name: 'search'
    displayName: 'BCR ledger: client search failing'
    severity: 3
    windowSize: 'PT15M'
    description: join(
      [
        'Sev 3. Client searches are failing. search.unavailable: 2 or more in 15 minutes at the internal, reserve, read, model, deadline or busy stage (identity blips are the filing alert\'s identity.unverified). search.model_cap: the per-worker cap of model calls an hour was reached. search.record_failed: 2 or more search records not finished.'
        'bot.search_refused: ingestion answered the bot with an error or a bad body (401 or 403: the managed identity grant or SEARCH_CALLER_APP_IDS). bot.search_call_failed: 2 or more calls from the bot failed or timed out.'
        'Filing is unaffected. First: the search.* lines by stage and status.'
        runbook
      ],
      ' '
    )
    query: join(
      [
        'traces'
        bothApps
        '| extend m = parse_json(message)'
        '| extend msg = tostring(m.msg), stage = tostring(m.stage)'
        '| extend signal = case('
        '    msg == "search.unavailable" and stage == "model_cap", "search.model_cap",'
        '    msg == "search.unavailable" and stage != "identity", "search.unavailable",'
        '    msg == "search.record_failed", "search.record_failed",'
        '    msg in ("search.http_error", "search.bad_response", "search.client_threw"), "bot.search_refused",'
        '    msg == "search.call_failed", "bot.search_call_failed",'
        '    "")'
        '| where isnotempty(signal)'
        '| extend w = itemCount'
        perSignal
        '| where n >= iff(signal in ("search.model_cap", "bot.search_refused"), 1, 2)'
      ],
      '\n'
    )
  }
]

resource countAlerts 'Microsoft.Insights/scheduledQueryRules@2026-03-01' = [
  for r in countRules: {
    name: 'alert-bcr-${r.name}-${nameSuffix}'
    location: location
    tags: tags
    kind: 'LogAlert'
    properties: {
      displayName: r.displayName
      description: r.description
      severity: r.severity
      enabled: !contains(disabledRules, r.name)
      scopes: [appInsightsId]
      evaluationFrequency: 'PT15M'
      windowSize: r.windowSize
      criteria: {
        allOf: [
          {
            query: r.query
            timeAggregation: 'Total'
            metricMeasureColumn: 'n'
            dimensions: [
              {
                name: 'signal'
                operator: 'Include'
                values: ['*']
              }
            ]
            operator: 'GreaterThan'
            threshold: 0
            failingPeriods: {
              numberOfEvaluationPeriods: 1
              minFailingPeriodsToAlert: 1
            }
          }
        ]
      }
      autoMitigate: true
      skipQueryValidation: false
      actions: {
        actionGroups: [actionGroup.id]
      }
    }
  }
]

var countRuleNames = [for r in countRules: 'alert-bcr-${r.name}-${nameSuffix}']

@description('The action group\'s name.')
output actionGroupName string = actionGroup.name

@description('Every rule\'s name, the heartbeat first.')
output ruleNames array = concat([heartbeatName], countRuleNames)
