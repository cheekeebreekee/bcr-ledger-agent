# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

`bcr-ledger-agent` is one of several `bcr-*` repos (`bcr-onboarding-agent`, `bcr-website`).
The [Conventions shared by all `bcr-*` repos](#conventions-shared-by-all-bcr--repos) section below
applies to all of them; everything else is specific to this repo.

---

## What this repo is

A document intake for BCR's clients in Microsoft Teams. Each file is classified by reading its
**content** with Claude and filed into the right folder of the right client's SharePoint Online
site — all via Azure Functions + Microsoft Graph. There are **two intakes**:

- **The channel inbox (clients).** Clients are Teams guests, and Teams lets a guest attach files
  only to channel posts, never in a chat with the bot. So a client posts the file in their Team's
  **"Dokumenty księgowe"** channel (a post with an attachment, or the „Udostępnione” tab), which
  stores it in the channel folder, and a timer in ingestion files it into the taxonomy folder
  **inside that same channel folder**.
- **The bot's 1:1 DM (whoever can attach there).** The bot receives attachments, and ingestion
  files them the same way.

UI strings are **Polish**; code, comments and logs are English.

One deployment serves many clients. Which client a document belongs to is decided by a **Client
Directory** SharePoint list, not by configuration or per-client deployment: on the bot path by the
uploader's bound row, in the channel inbox by the bound row whose channel folder holds the file.

---

## Commands

Toolchain: **Node 22** (`.nvmrc`), **Yarn 4.3.1 via Corepack** (`corepack enable` first; plain `yarn`
may resolve to a different version). Azure Functions Core Tools v4 and Azure CLI are needed for
`start:*` and `deploy:*`.

```bash
yarn install                 # or: yarn install --immutable (what CI runs)
yarn build                   # topological build of every workspace (tsc -b)
yarn test                    # Jest in every workspace
yarn test:coverage           # Jest + per-package coverage thresholds (what CI runs)
yarn test:tools              # node:test suites for the operator tools in tools/ (offline)
yarn check:app-settings      # app settings the code reads vs the ones Bicep sets (offline, CI)
yarn lint                    # ESLint over packages/**/src/**/*.ts
yarn type-check              # tsc --noEmit per workspace
yarn format                  # Prettier over sources + infrastructure/**/*.bicep
```

Single workspace / single test / single case:

```bash
yarn workspace @bcr/document-ingestion test src/services/clientResolver.test.ts
yarn workspace @bcr/document-ingestion test -t 'never guesses'
yarn workspace @bcr/shared test:coverage        # enforces per-package thresholds
```

Coverage thresholds are **per package and they fail the run**: `shared` 85/85/80/80
(lines/statements/functions/branches), `document-ingestion` 85/85/80/75, `teams-bot` 80/80/75/70.
`src/functions/**`, `src/index.ts` and `src/runtime.ts` are excluded from coverage in the two
Function App packages — they are HTTP registration and cold-start wiring. The logic lives in services
with injected collaborators (e.g. `services/batchIngestor.ts`) and is tested there.

Classifier evaluation (local; calls the Anthropic API with `ANTHROPIC_API_KEY` from your shell,
never from Key Vault; uploads nothing else anywhere):

```bash
corepack yarn workspace @bcr/document-ingestion eval:truth --arbiter <arbiter.json> --out <truth.json>
corepack yarn workspace @bcr/document-ingestion eval --dir <folder> --truth <truth.json> \
  [--client-name <name>] [--client-nip <nip>] [--out <report.md>]
```

`truth.json` is `[{file, category, month, direction?}]` (`category` may be `faktura`: an invoice,
either direction). Keep documents, truth and reports under the git-ignored `tools/out/`: they are
client data. Test fixtures are synthetic only. The code is `src/evaluation/`.

Local run (two processes; `prestart` builds, and `@bcr/shared` must be built first):

```bash
cp packages/teams-bot/local.settings.json.example packages/teams-bot/local.settings.json
cp packages/document-ingestion/local.settings.json.example packages/document-ingestion/local.settings.json
yarn start:bot            # http://localhost:3978/api/messages
yarn start:ingestion      # http://localhost:7071/api/ingest/batch
```

The Bot Framework Emulator no longer gets a file through: the gate accepts only a Teams 1:1 chat
from the BCR tenant with a GUID `aadObjectId`, which Emulator activities lack (silence in
`enforce`; in a local `BOT_GATE_MODE=log`, ingestion's source check still answers 400). Test bot
turns with `TestAdapter` (`ledgerBot.test.ts`) and ingestion with a direct call, as in
`docs/local-development.md`.

Deploy: `infrastructure/deploy.sh <env>` (`yarn deploy:prod`) packages both apps, deploys Bicep,
then zip-deploys both Function Apps; `deploy.yml` does the same via Azure OIDC. A Bicep deploy
**replaces every app setting**, so the template is the record of them all (the G1 fix): each
app's settings are a separate `Microsoft.Web/sites/config` `appsettings` resource in
`modules/functionApp.bicep` (not `siteConfig.appSettings`, which what-if masks), built from the
runtime settings, the app's map in `main.bicep` fed by `main.<env>.parameters.json`, and the
running `WEBSITE_RUN_FROM_PACKAGE`, read back with `list()` because the zip deploy owns it. A
setting changed by hand (`az functionapp config appsettings set … -o none`, which merges) goes
into the parameter file (and `main.bicep` if new) in the same change. `yarn check:app-settings`
fails when the code reads a setting Bicep does not set, Bicep sets one no code reads, or a line
holds two settings; `node tools/check-app-settings.mjs --live -g <rg> -p <params>` compares what
a deploy would write with the running apps (read-only; secrets and the package URL are never
read). Both deploy paths run `--live` through `infrastructure/app-settings-gate.sh` before any
Bicep deploy to existing apps and stop on any difference, or on any `az` failure; a deploy meant
to change settings names them in `EXPECTED_SETTING_CHANGES` (the workflow input
`expected_setting_changes`), passed on as `--expect` (`docs/deployment.md` §3a).

> ⚠️ **"dev" is production: it serves PESKOVOI.** `deploy.sh` (dev in any spelling, and
> `rg-bcr-ledger-dev`) and `deploy.yml` still refuse it, and stay that way until the **"Lifting
> gate G1"** checklist in `docs/operations/human-steps.md` is done: the
> `WEBSITE_RUN_FROM_PACKAGE` carry-over has never run against a real app, so it is rehearsed on
> a throwaway resource group first (never on dev); then a clean `--live` against dev, a reviewed
> what-if, and a reviewed commit of its own that lifts the refusal. Never lift it in passing.
> Until then deploy code only, one app at a time, in the order in
> `docs/operations/human-steps.md` (Phase 0).

`yarn workspace @bcr/<pkg> package` builds a fresh zip into `artifacts/`. It cleans `dist` and the
`tsbuildinfo`, rebuilds, then runs `tools/package-function.mjs`, which deletes the old zip first,
fails if any `dist/**/*.js` (the app's or `@bcr/shared`'s) has no `src/**/*.ts` behind it, ships
no `*.map`/`*.d.ts`/`*.tsbuildinfo`, installs production dependencies at the exact `yarn.lock`
versions with install scripts disabled (checking each top-level version against the root
`node_modules`), and vendors the just-built `@bcr/shared`. `artifacts/*.zip` are git-ignored build
output: never commit one, and deploy only a zip built for that deploy. Before deploying, still
check the vendored copy: `unzip -p artifacts/<pkg>.zip node_modules/@bcr/shared/dist/config.js |
grep -c botGateMode` (ingestion: `forbiddenTargetSitePaths`, `membershipCheckMode`,
`inboxSweepMode`, `inboxSweepRows` and `classificationAcceptThreshold`) must be greater than 0.

CI (`.github/workflows/ci.yml`) runs lint → type-check → build → test (and `test:tools`), plus
`bicep build`, `bicep lint` and the static `check-app-settings`.

---

## Architecture

Three workspaces. `@bcr/shared` is the contract between the two Function Apps — **both deployables
depend on it and neither depends on the other**; they talk over HTTP.

```
Teams ──▶ Azure Bot Service ──▶ @bcr/teams-bot (Func App)
                                      │ POST /api/ingest/batch  (AAD client-credentials JWT)
                                      ▼
Teams channel post / „Udostępnione”   @bcr/document-ingestion (Func App)
  └─▶ channel folder ◀── timer: inboxSweep (every 2 min)
                                      ├─▶ Claude (classify content)
                                      └─▶ Microsoft Graph (managed identity) ──▶ SharePoint
```

### The ingestion pipeline (the part that needs several files to understand)

Two intakes share the classifier, the taxonomy, the client SharePoint factory and its guards: the
**bot DM** (below) and the **channel inbox** (after it).

`functions/ingestDocument.ts` is thin wiring (the only route is `POST /api/ingest/batch`);
`services/batchIngestor.ts` runs the pipeline; every collaborator is a cold-start singleton from
`runtime.ts`:

1. **Auth** — `auth/authMiddleware.ts` verifies the AAD JWT itself (signature via tenant JWKS,
   issuer, audience, `tid`, a `roles` claim from the route's policy) **and** that the calling app id
   (`appid ?? azp`) is on `BOT_CALLER_APP_IDS`. Functions are `authLevel: 'anonymous'` *on purpose*.
2. **Validate** — `functions/validation.ts` (zod): only `conversationType: 'personal'`, a GUID
   `userAadObjectId`, and the BCR tenant are accepted; filename has no path separators, base64
   shape, ≤25 docs per batch, ≤100 MiB decoded.
3. **Resolve the client** — `services/clientResolver.ts#resolve()` maps `source.userAadObjectId` to
   exactly one bound Client Directory row, then (`MEMBERSHIP_CHECK_MODE=enforce`, the default)
   reads the uploader's Teams from Entra via `services/teamMembership.ts` and routes only if they
   are exactly `{row.teamId}`. Otherwise it returns the **staff-only quarantine** with a reason:
   `unmapped`, `staff`, `conflict`, `stale_directory`, `forbidden_target`, `unbound_target` (the
   row lacks `RootFolder`, `DriveId` or `TeamId`), `membership_mismatch` (the Teams read differ
   from the row's) or `membership_unverified` (they could not be read). The upload step adds
   `target_unwritable`. Quarantined documents are never classified.
4. **Classify** — `services/classificationService.ts` takes the first classifier with an answer
   from `ClaudeClassifier → FallbackClassifier` (Claude only if `ANTHROPIC_ENABLED` + key) and
   passes it through `services/acceptancePolicy.ts`, which decides the folder. `ClaudeClassifier`
   sends the content to `ANTHROPIC_MODEL` (default `claude-opus-5`) with structured output
   (`output_config.format`, the category enum from the taxonomy) at effort `low`; a PDF over 100
   pages is sent as a copy of its first 20 (`services/pdfPreview.ts`; the original is filed).
   Only the bound client's own identity is primed into the prompt. A classifier's
   **retry later** (429, 529, 5xx, timeout, connection, 401–404) stops the chain: the document is
   `rejected` with `RetryLater` (the card's Polish text says to send it again), never filed.
5. **Direction** — `services/invoiceDirection.ts`, inside classification: sales ⇄ purchase only
   from the bound client's own NIP on one side of the parties, else the model's `client_role`
   (it can only match the primed NIP or name). No identity, or the client on neither side →
   `DIRECTION_UNRESOLVED`, confidence ≤ 0.5, review. It never changes the client.
6. **Upload** — `sharePointServiceFactory.ts` returns a per-target cached `SharePointService`, which
   resolves site+drive ids (refusing a drive that differs from the row's `DriveId`, and a site
   whose site-collection id is BCR GROUP's or the quarantine site's: `SharePointTargetError`
   `forbidden_site` → quarantine as `forbidden_target`), creates the folder chain idempotently,
   then PUTs (≤4 MiB) or opens an upload session — both with `conflictBehavior=fail`, taking the
   next free `_n` name on a 409. If the client's space can't be written, the document goes to
   quarantine (`target_unwritable`), never anywhere else. Its own retry (`withRetry`) covers only
   network failures, 500 and 502; 429/503/504 belong to the Graph SDK's `RetryHandler` — never
   stack the two. A batch starts no document after 150 s (the rest are `rejected`, generic retry
   code), and a suffixed name taken after a retried network failure logs
   `sharepoint.possible_duplicate`.

### The channel inbox (clients' intake)

`functions/inboxSweep.ts` is a timer (`0 */2 * * * *`), thin wiring; `services/channelInbox.ts`
runs it with injected collaborators (`runtime.ts#channelInbox`). `INBOX_SWEEP_MODE` is
`off` (default: returns at once) | `shadow` (lists, checks, classifies, logs `inbox.would_move`,
writes nothing) | `enforce` (moves); `/api/health` shows it as `build.inboxSweep`.
`INBOX_SWEEP_ROWS` (list item ids; empty = all) narrows the rows, for a canary-first rollout
(`build.inboxSweepRows`: `all` | `listed`); `INBOX_CREATED_AFTER` leaves older files in place.

1. **Rows** — `boundClientRows(snapshot)` in `clientDirectoryReader.ts`: exactly the rows the
   snapshot routes to (active, not admin, bound, not excluded), then only those in
   `INBOX_SWEEP_ROWS` if it is set. Unavailable snapshot → nothing.
2. **Inbox** — the **client** factory's `SharePointService.resolveInbox()`: the row's `RootFolder`,
   one folder at the root of its `DriveId`, behind the same site guard and drive check as uploads.
3. **Candidates** — `listInboxChildren()`: direct children only, every page, anything whose
   `parentReference` is not this folder in this drive dropped. `selectCandidates()`: a file,
   `0 < size ≤ 100 MiB`, not `~$`/`.`, with an `eTag`, created after `INBOX_CREATED_AFTER` if
   set, older than `INBOX_MIN_AGE_MS`, with `createdBy.user.id`.
4. **Uploader** — the creator **and** the last modifier (`lastModifiedBy`) are each `userType`
   `Guest` (`services/userDirectory.ts`) **and** a member of this row's Team
   (`TeamMembershipReader.teamsOf`, cached). Anything else is left untouched (`not_guest`,
   `not_in_team`, `modified_by_other`, …); an unreadable user is `unverified` and waits.
5. **Classify** — only with 120 s left before the tick's 270 s limit, and only after
   `checkInboxItem()` re-reads the item: still a direct child at the **listed `eTag`**. Same
   `ClassificationService` (direction from this row's identity, then the acceptance policy),
   primed with this row only; the policy's folder is built with `buildFolderPath` from the
   category alone (review → `98_Nieposortowane/YYYY/MM` of the tick). Cached per (`driveItemId`,
   `eTag`) for 1 h; the file is read by id, size-capped, only if Claude reads it. A **retry
   later** leaves the file where it is for the next tick: `inbox.retry_later` with the status,
   `retryLater` in `inbox.tick`, no failure counted, never `98_`. In `shadow`, `inbox.would_move`
   is logged once per (`driveItemId`, `eTag`) per worker, and a version already reported is
   skipped before the budget (`alreadyReported`): the budget is for files that need work.
6. **Move** — only with 60 s left: `ensureInboxFolder()` under the channel folder, then
   `moveWithinInbox()`: re-check, PATCH by id with `If-Match: <listed eTag>` and
   `conflictBehavior=fail`, `_1`…`_10` on 409, then assert same item, same drive, new parent. A
   re-check miss or a 412 is `InboxItemChangedError`: left where it is now (`skippedChanged`,
   `inbox.skipped` `changed`), never a failure. Three failures (per worker) → moved to `98_`
   unclassified. Budget `INBOX_MAX_FILES_PER_TICK`, nothing new after 150 s, rows round-robin; a
   file out of time is `deferred`. Every sweep Graph call runs `withoutSdkRetries` + our bounded
   retry (the SDK would sleep through `Retry-After` past the 5-minute `functionTimeout`, which
   restarts the worker and every bot upload on it). Logs `inbox.filed|sorted_to_review|
   would_move|retry_later|failed|skipped|row_failed|tick`, ids, codes, counts and taxonomy paths
   only.

### Invariants — break these and documents mis-file

- **On the bot path, routing is decided ONLY from the authenticated uploader identity.** Document
  content — parties, NIPs, model output, the filename — can never select or change the client. The
  old phase 2 that "promoted" unrouted uploads to whichever client's NIP was in the document filed
  one client's papers into another client's Team and was steerable by prompt injection; it is
  deleted, and `clientResolver.test.ts` fails if a NIP lookup or promotion comes back. Anything
  that can't be tied to exactly one client goes to the staff-only quarantine — never BCR GROUP,
  never a guess.
- **In the channel inbox, the client is the file's location, never its uploader or content.** The
  client is the one bound row whose `DriveId` + `RootFolder` (the channel folder) hold the file.
  Nothing in the file, its name or the model's output picks another row, and the sweep never
  reads a row other than the one it is sweeping.
- **The channel inbox processes only this Team's guests' uploads.** A file is touched only when its
  creator **and** its last modifier are each `userType` `Guest` **and** a member of the row's
  Team. Staff, members, guests of other Teams, a guest's file that staff replaced (`createdBy`
  survives a replace; `lastModifiedBy` does not), files with no user creator, and users that
  cannot be read are left exactly where they are (fail closed). A guest who is also in other
  Teams is fine here: the file is already in this client's space.
- **Inbox moves stay inside the channel folder, by id, only on the version listed, and never
  overwrite.** Only the channel folder's direct children are candidates (never recurse —
  subfolders are the filed area); before the download and again before the move the item must
  still be a direct child at the listed `eTag`, and the PATCH carries `If-Match` with it, so a
  file someone moved out (an Owners-only folder, a manual subfolder), renamed or replaced after
  the listing is never pulled back or filed by stale content. The target chain is created under
  the channel folder, never the drive root; the move is a PATCH by id with
  `conflictBehavior=fail` and the `_n` rule, and afterwards the item must be the same item, in
  the row's drive, under the target folder. Never copy, never delete, never move across drives,
  never touch an item outside the inbox's direct children. `shadow` writes nothing. **No
  overwrite on a move is Graph's observed default, not a documented parameter:** Microsoft
  documents `conflictBehavior` for creating items and `if-match` for move/update, not
  `conflictBehavior` for a move. The H-12 canary's same-name move (`_1`) is the proof in this
  tenant; keep it in any rollout of a changed move.
- **`ClaudeClassifier.classify()` never throws and never rejects**, and it tells three answers
  apart. A `Classification` is only a *suggestion* (category, month, confidence, parties,
  direction settled or flagged). `{ outcome: 'retry_later' }` — 429, 529, other 5xx, timeouts,
  lost connections, 401/402/403/404 — is **not a result**: `ClassificationService` stops there
  (never the fallback), the bot path answers `RetryLater`, the inbox leaves the file for the next
  tick; a transient failure must never park a classifiable document in `98_`.
  `{ outcome: 'no_result', reason }` — unsupported type, oversize, `pdf_trim_failed`, 400/413/422,
  refusal, truncated or malformed output — lets `FallbackClassifier` file it into
  `98_Nieposortowane/YYYY/MM/` for manual review (`NOT_CLASSIFIED`, with `unclassifiedReason`).
  Preserve this contract.
- **`services/acceptancePolicy.ts` is the only place a threshold or review reason is applied.**
  `CLASSIFICATION_ACCEPT_THRESHOLD` (default 0.70; zod refuses anything outside 0.70–0.95 at cold
  start, so a 0.69 result is never filed under its category) and the reasons `NOT_CLASSIFIED`,
  `UNKNOWN_CATEGORY`, `MODEL_UNSORTED`, `DIRECTION_UNRESOLVED`, `DATE_MISSING`, `LOW_CONFIDENCE`
  (and the inbox's `PROCESSING_FAILED`) send a document to `98_` of *this* month with the
  suggestion kept for the logs. Don't add a second threshold in a classifier, the service or a
  caller. The old `ANTHROPIC_CONFIDENCE_THRESHOLD` is not read (it would stop cold start at the
  live 0.6); a set value only logs `config.retired_setting`.
- **Directory lookups are fail-closed and order-independent.** `buildSnapshot` in
  `clientDirectoryReader.ts` works in two passes: collect every key's rows, then admit a user id only
  when exactly one trusted row holds it. A user id on two rows (or on a client and an admin row) routes
  nowhere. Client rows that share a site (host + canonical path, whatever drive or folder each
  names), a `DriveId` or a `TeamId` (case-insensitive) are all excluded, their users `conflict`. A
  row on a host other than `QUARANTINE_SITE_HOSTNAME`, on a forbidden site (BCR GROUP, the
  quarantine site) or with a non-canonical `SitePath` is excluded as `forbidden_target`. A row
  without `RootFolder`, `DriveId` or `TeamId` routes nobody (`unbound_target`); only
  `tools/directory-bindings.mjs apply` binds a row, writing all three together. A shared NIP or
  ClientId only raises `directory.conflict` — neither routes anything. A snapshot older than
  `CLIENT_DIRECTORY_MAX_STALE_MS` is treated as unavailable (everything to quarantine). BCR staff
  ids never belong on client rows.
- **One canonical site path, on both sides.** Trim, split on `/`, drop empty segments; valid only as
  exactly `sites|teams` + a name matching `^[A-Za-z0-9_-][A-Za-z0-9._-]*$` that does not end in `.`;
  compare `/<seg0>/<seg1>` lower-cased. Sub-sites, `.`/`..`, `%`, `\` and whitespace are refused,
  never normalised. `canonicalSitePath` (ingestion) and the site-path helpers in
  `tools/lib/bindings.mjs` must agree exactly and share one edge-case table in their tests; change
  both or neither. `QUARANTINE_SITE_PATH` and `FORBIDDEN_TARGET_SITE_PATHS` must pass it at cold
  start.
- **Routing requires the uploader's Teams to be exactly `{row.TeamId}`, read at upload time.**
  A guest bound to client A and later added to client B's Team (B's onboarding re-invited the
  same email) used to keep routing B's documents into A (R46). `ClientResolver.resolve` now reads
  the uploader's direct memberships (`GET /users/{id}/memberOf`, as the ingestion managed identity
  with `Directory.Read.All`) and routes only when the Teams among them — by the binding tool's
  rule in `teamIdsIn`, kept identical by a test — are exactly the row's `TeamId`
  (case-insensitive); anything else is `membership_mismatch`, a failed read is
  `membership_unverified`. Fail closed: never route on a read that failed, never cache a
  failure (successes are cached 5 min per user), and keep the check in the resolver, not beside
  it. Staff and already-quarantined uploads are not read. `MEMBERSHIP_CHECK_MODE=off` is an
  emergency escape that reopens R46; it warns at cold start and shows in `/api/health`
  (`build.membershipCheck`). Keep `build.phase: 'p0'` and `build.routing: 'identity-only'`
  exactly: the operator tools gate on them. The binding tool's whole-plan apply after every
  onboarding and weekly `check` stay as defence in depth; still never build a flow that binds
  only the new row.
- **Nothing is written into BCR GROUP or the quarantine site as a client target, whatever a row
  says.** The path checks compare spellings; `SharePointService` also compares the *resolved*
  site-collection id with BCR GROUP's (from `CLIENT_DIRECTORY_SITE_ID`) and the quarantine site's
  (resolved lazily and cached — failing to resolve it refuses the write). Keep both layers.
- **`parsers/folderTaxonomy.ts` is the single source of truth for folder layout.** `categoryCatalog`
  drives the Claude system prompt (its descriptions are the model's category rules: receipts
  without a buyer are `faktury_noty`, a receipt with the buyer's NIP and a foreign invoice naming
  a buyer are invoices, pro forma is `inne`, OWU are `umowy`) *and* the output schema's category
  enum *and* `buildFolderPath()`, so the model can never name a category the uploader can't build
  a path for. Add or rename a category there and nowhere else; never change an id (ids are folder
  keys, log values and evaluation labels); `dated: true` categories require `year`/`month` and
  get a `YYYY/MM` leaf.
- **Never build a SharePoint path by string concatenation.** Go through
  `utils/pathBuilder.ts` (`sanitizeFolderPath` / `sanitizeFilename` / `joinFolderPath`, then
  `encodeGraphPath` for the URL) — it rejects traversal and reserved names, strips SharePoint's
  forbidden characters, and percent-encodes `#`, `%` and spaces so they can't truncate the request.
- **Uploads never overwrite.** `conflictBehavior=fail` on both upload paths; no existence probes (they
  raced, and told a caller which names already existed).
- **Responses and logs carry ids, not client data.** A quarantined row has no link, folder or name;
  the result card shows the taxonomy label, never the model's reasoning; logs carry `documentId`,
  `clientId`, `listItemId`, `teamId`, `driveItemId` — file names, titles, NIPs and SharePoint
  locations are redacted by the root logger (`shared/src/logger.ts`). Filing lines
  (`document.filed`, `inbox.filed|sorted_to_review|would_move`) add codes from
  `decisionLogFields()`: `category`, `suggestedCategory` (review), `confidence` (2 decimals),
  `classifier`, `model`, `month`, `reviewReasons`, and `folder` — the **taxonomy** path only,
  never the channel folder or a file name.
- **The bot processes only 1:1 chats.** Teams *channel* uploads never reach a bot (drag-drop
  bypasses Bot Framework; `@mention` activities carry only mention HTML) — they reach ingestion
  through the channel inbox instead — and group chats are refused. Every activity passes the bot
  gate (personal conversation, BCR tenant, GUID `aadObjectId`) before any logic runs, and the
  ingestion API re-checks it. `teamsChannelId` is telemetry only. The anonymous Personal Tab
  lookup (`/api/user-target`) is deleted: it mapped any user id to their client.

### Bot side

`bot/ledgerBot.ts` is the only place with turn logic and is kept free of HTTP/SDK plumbing so it is
testable with `TestAdapter`; `functions/messages.ts` just calls `adapter.processActivityDirect`.
All attachments from one activity are downloaded in parallel and sent as **one batch**, so the user
gets a single consolidated result card. A per-file download or ingest failure becomes a `rejected`
row in that card rather than an aborted turn. The gate (`BOT_GATE_MODE=log|enforce`) runs for every
activity type before the turn logic; the card escapes every inserted value and renders Polish text by
error code, never raw error messages. The help card (`buildHelpCard`) sends clients to their Team's
„Dokumenty księgowe” channel, because guests cannot attach files in the chat.

---

## Conventions shared by all `bcr-*` repos

### Node/TypeScript agent repos (`bcr-ledger-agent`, `bcr-onboarding-agent`)

- **Layout**: Yarn 4 workspaces under `packages/*`, scoped `@bcr/<name>`, plus `infrastructure/`
  (Bicep + `deploy.sh`), `docs/`, `artifacts/` (build output zips), `.github/workflows/`.
  Every repo has a `@bcr/shared` package exporting *only* from its `src/index.ts` — sub-paths are
  private. Root `package.json` scripts are the same set (`build`/`test`/`lint`/`type-check`/
  `format`/`clean`/`start:*`/`deploy:*`) implemented with `yarn workspaces foreach`.
- **`tsconfig.base.json` is strict, and two options shape the code you write**:
  - `exactOptionalPropertyTypes` — you cannot assign `undefined` to an optional property. The
    house idiom is conditional spread: `...(rootFolder ? { rootFolder } : {})`. It is everywhere;
    match it instead of widening the type.
  - `composite` + `references` — packages build with `tsc -b` and reference `../shared`. Add a
    `references` entry when a package starts depending on another.
  - `isolatedModules` + the `@typescript-eslint/consistent-type-imports` rule ⇒ type-only imports
    must be written `import type { X }` / `import { type X, fn }`.
- **Config**: a zod schema in `@bcr/shared/config.ts` plus a per-package `src/config.ts` holding an
  `envMap` of camelCase field → `SCREAMING_SNAKE` env var, declared
  `as const satisfies Record<keyof TConfig, string>` so a schema field without an env mapping is a
  compile error. `loadConfig()` is called once at cold start and throws a `ValidationError` naming
  the offending env var — configuration fails fast and visibly, never at first request.
- **Errors**: one base class per repo (`LedgerAgentError`, `OnboardingError`) carrying `code` +
  `httpStatus`, with subclasses (`ValidationError`, `UnauthorizedError`, …). HTTP handlers map with
  `err instanceof <Base>` → `{ status: err.httpStatus, jsonBody: { error: { code, message } } }` and
  collapse everything else to a generic 500. Never sniff message strings.
- **Logging**: pino via `createLogger(area, context)`; area names are `'<app>/<module>'`. Derive a
  request-scoped child with `.child({ invocationId, ... })` and pass the `Logger` down. Secrets are
  redacted by the root logger config, and `no-console` is an ESLint warning (`warn`/`error` allowed).
- **Azure Functions v4 programming model**: `src/index.ts` contains only side-effect imports of the
  function modules; each module calls `app.http(...)` at load and exports its `handleX` for tests;
  `src/runtime.ts` holds all cold-start singletons so adding a function is one import. Keep
  `package.json` `main` = `dist/index.js`.
- **Tests**: Jest + ts-jest, `*.test.ts` colocated next to the source, per-package
  `coverageThreshold` that fails the build. Dependencies are injected through constructor option
  bags (`client`, `fetcher`, `now`) rather than module mocks.
- **Prettier/ESLint** are identical across repos: single quotes, semicolons, trailing commas,
  100-column width, 2-space indent, flat ESLint config extending the TS recommended set.

### Next.js surfaces (`bcr-website`, `bcr-onboarding-agent/web`)

npm (not Yarn), Next 14 App Router, Tailwind, `next-intl`, **Vitest** (`yarn test` → `vitest run`)
and Playwright (`test:e2e`), `typecheck` rather than `type-check`.

> **Gotcha that travels between the two halves**: `expect(value, message)` is Vitest's two-argument
> form. The `packages/**` code runs Jest, which rejects it. `bcr-onboarding-agent` enforces this with
> a `no-restricted-syntax` ESLint rule; in Jest code, collect offenders into an array and assert on
> that so the failure names them.

### Operational rules

- Secrets live in Key Vault and reach Function Apps as `@Microsoft.KeyVault(SecretUri=...)` app
  settings. `.env`/`local.settings.json` are local-only and git-ignored; `*.example` files are the
  committed reference.
- Infrastructure is Bicep only (`infrastructure/main.bicep` + `modules/` + per-env parameter files).
  Don't configure Azure resources by hand in a way the template doesn't capture.
- `bcr-onboarding-agent` has generated artefacts (catalogue, prompt, risk data, PDF labels, contract
  tokens, diagrams) produced by `tools/generate-*.mjs`. **Never hand-edit them** — regenerate with
  `yarn <name>:generate`; `yarn generated:check` verifies they are in sync and is expected to pass.

---

## Azure / SharePoint facts that bite

`PROJECT_OVERVIEW.md` → *Lessons learned* has the full list (24 items). The ones that affect code:

- **SharePoint drive names are locale-dependent** — Polish tenants use `Dokumenty`, not `Documents`.
  Always resolve via `GET /sites/{id}/drives`; per-client names come from the Directory's `DriveName`
  column, the quarantine site's from `QUARANTINE_DRIVE_NAME`.
- **Graph calls use the Function App's system-assigned managed identity**, not the API app
  registration, and `Sites.Selected` needs *two* grants (Graph app role + per-site permission);
  per-site grants take ~5 min to propagate. Every grant names the MI's app id (`INGEST_MI_APPID`);
  a grant to the API app registration does nothing. See `docs/setup-guide.md` §5 and
  `infrastructure/quarantine/README.md` (the old `grant-sharepoint-permission.sh` is deleted).
  The membership check also needs Graph `Directory.Read.All` on that identity, granted only by
  `infrastructure/identity/grant-ingestion-membership-read.sh` (dry run by default; Graph calls
  use a delegated `GRAPH_TOKEN`, since the CLI's token hits `AADSTS65002` here). A managed
  identity's token carries its roles and the platform caches it ~24 h with no forced refresh,
  so grant a day before the deploy; until then bound uploads are `membership_unverified`.
- `MICROSOFT_APP_TYPE` must be `SingleTenant` (the app registration is `AzureADMyOrg`); the wrong
  value is a 401 at Bot Framework auth.
- `@anthropic-ai/sdk` 0.104.2 (the locked version) has what the classifier sends: typed PDF
  `document` blocks, `output_config.format` (`json_schema`) and `output_config.effort`. Keep the
  request free of `temperature`/`top_p`/`top_k`, `thinking.budget_tokens` and forced
  `tool_choice`: `claude-opus-5` rejects the first two, and successors reject the third. Without a
  `thinking` field `claude-opus-5` thinks adaptively, and `max_tokens` covers thinking **and**
  the answer. The same request works on `claude-opus-4-5-20251101`, the model the running app
  was set to before the classification release; the operator switches `ANTHROPIC_MODEL` at that
  deploy (`docs/operations/human-steps.md`, *Classification release*). `main.bicep` and both
  parameter files already record the release (`claude-opus-5`, `CLASSIFICATION_ACCEPT_THRESHOLD`,
  no `ANTHROPIC_CONFIDENCE_THRESHOLD`), so until that switch `--live` against dev reports exactly
  those three names, and no Bicep deploy to dev may run in between.
- If `tsc -b` keeps seeing stale `@bcr/shared` types, delete the physical copy Yarn sometimes leaves
  at `packages/<pkg>/node_modules/@bcr/shared` so resolution falls back to the root symlink.

## Docs map

| File | What's in it |
|---|---|
| `ARCHITECTURE.md` | Component/sequence detail; §4.2 multi-tenant routing, §5 auth model |
| `PROJECT_OVERVIEW.md` | Current deployed state, tooling versions, lessons learned |
| `docs/setup-guide.md` | First-time setup: app registrations, every env var and where to find it |
| `docs/deployment.md` | A new environment end to end; §3a how to change an app setting through a deploy (`--expect`) |
| `docs/client-directory-admin-guide.md` | The Client Directory list — columns and admin workflow |
| `docs/admin-sharepoint-grant.md` | `Sites.Selected` via Graph Explorer |
| `docs/security.md` | Threat model + secrets inventory |
| `docs/operations/human-steps.md` | Ordered Phase-0 rollout: who runs what, verification, rollback; "Lifting gate G1"; the *Classification release* runbook (evaluate, deploy, switch the model, go/no-go) |
| `docs/operations/incident-2026-09.md` | The cross-client routing incident: causes, IR-0..IR-3, status |
| `docs/operations/tenant-hardening.md` | Tenant settings that keep clients apart (BCR GROUP stays Private, read-only check) |
| `docs/diagrams/` | Mermaid: as-is, Phase-0 routing, target business logic/architecture/data flow, sequences, data model |
| `tools/README.md` | Operator tools (directory bindings, IR-0/IR-1): dry-run by default, `--apply` to write |
