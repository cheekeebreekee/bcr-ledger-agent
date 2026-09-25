# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

`bcr-ledger-agent` is one of several `bcr-*` repos (`bcr-onboarding-agent`, `bcr-website`).
The [Conventions shared by all `bcr-*` repos](#conventions-shared-by-all-bcr--repos) section below
applies to all of them; everything else is specific to this repo.

---

## What this repo is

A Microsoft Teams bot that receives document attachments in a **1:1 DM**, classifies each file by
reading its **content** with Claude, and uploads it into the right folder of the right client's
SharePoint Online site — all via Azure Functions + Microsoft Graph. UI strings are **Polish**;
code, comments and logs are English.

One deployment serves many clients. Which SharePoint site a document lands in is decided per-upload
by a **Client Directory** SharePoint list, not by configuration or per-client deployment.

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
yarn lint                    # ESLint over packages/**/src/**/*.ts
yarn type-check              # tsc --noEmit per workspace
yarn format                  # Prettier over sources + infrastructure/**/*.bicep
```

Single workspace / single test / single case:

```bash
yarn workspace @bcr/document-ingestion test src/services/clientResolver.test.ts
yarn workspace @bcr/document-ingestion test -t 'never changes the client'
yarn workspace @bcr/shared test:coverage        # enforces per-package thresholds
```

Coverage thresholds are **per package and they fail the run**: `shared` 85/85/80/80
(lines/statements/functions/branches), `document-ingestion` 85/85/80/75, `teams-bot` 80/80/75/70.
`src/functions/**`, `src/index.ts` and `src/runtime.ts` are excluded from coverage in the two
Function App packages — they are HTTP registration and cold-start wiring. The logic lives in services
with injected collaborators (e.g. `services/batchIngestor.ts`) and is tested there.

Local run (two processes; `prestart` builds, and `@bcr/shared` must be built first):

```bash
cp packages/teams-bot/local.settings.json.example packages/teams-bot/local.settings.json
cp packages/document-ingestion/local.settings.json.example packages/document-ingestion/local.settings.json
yarn start:bot            # http://localhost:3978/api/messages  (point Bot Framework Emulator here)
yarn start:ingestion      # http://localhost:7071/api/ingest/batch
```

Deploy: `yarn deploy:dev` / `yarn deploy:prod` run `infrastructure/deploy.sh <env>` (Bicep, then
zip-deploy of both Function Apps); `deploy.yml` does the same via Azure OIDC.

> ⚠️ **"dev" is production: it serves PESKOVOI.** Until the Bicep drift fix (gate G1), never run
> `yarn deploy:*`, `infrastructure/deploy.sh` or the Deploy workflow against it. `main.bicep`
> lacks the hand-set app settings, a Bicep deploy replaces every setting, and ingestion then
> fails at cold start. Deploy code only, one app at a time, in the order in
> `docs/operations/human-steps.md` (Phase 0), and add settings with
> `az functionapp config appsettings set … -o none`, which merges.

`yarn build && yarn workspace @bcr/<pkg> package` builds a fresh zip into `artifacts/`
(`tools/package-function.mjs` stages it and vendors the just-built `@bcr/shared`). Before
deploying, check that the vendored copy is current: `unzip -p artifacts/<pkg>.zip
node_modules/@bcr/shared/dist/config.js | grep -c botGateMode` (ingestion:
`forbiddenTargetSitePaths`) must be greater than 0. CI (`.github/workflows/ci.yml`) runs lint →
type-check → build → test plus `bicep build`/`bicep lint`.

---

## Architecture

Three workspaces. `@bcr/shared` is the contract between the two Function Apps — **both deployables
depend on it and neither depends on the other**; they talk over HTTP.

```
Teams ──▶ Azure Bot Service ──▶ @bcr/teams-bot (Func App)
                                      │ POST /api/ingest/batch  (AAD client-credentials JWT)
                                      ▼
                                @bcr/document-ingestion (Func App)
                                      ├─▶ Claude (classify content)
                                      └─▶ Microsoft Graph (managed identity) ──▶ SharePoint
```

### The ingestion pipeline (the part that needs several files to understand)

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
   exactly one Client Directory row, else returns the **staff-only quarantine** with a reason
   (`unmapped`, `staff`, `conflict`, `stale_directory`, …). Quarantined documents are never
   classified.
4. **Classify** — `services/classificationService.ts` runs classifiers in order and returns the
   first result at/above 0.8 confidence, else the best one. Chain is
   `ClaudeClassifier → FallbackClassifier` (Claude only if `ANTHROPIC_ENABLED` + key). Only the
   bound client's own identity is primed into the prompt.
5. **Direction** — `resolvePostClassification()` flips sprzedaż ⇄ zakup from the bound client's own
   NIP. It never changes the client.
6. **Upload** — `sharePointServiceFactory.ts` returns a per-target cached `SharePointService`, which
   resolves site+drive ids (refusing a drive that differs from the row's `DriveId`), creates the
   folder chain idempotently, then PUTs (≤4 MiB) or opens an upload session — both with
   `conflictBehavior=fail`, taking the next free `_n` name on a 409. If the client's space can't be
   written, the document goes to quarantine (`target_unwritable`), never anywhere else.

### Invariants — break these and documents mis-file

- **Routing is decided ONLY from the authenticated uploader identity.** Document content — parties,
  NIPs, model output, the filename — can never select or change the client. The old phase 2 that
  "promoted" unrouted uploads to whichever client's NIP was in the document filed one client's papers
  into another client's Team and was steerable by prompt injection; it is deleted, and
  `clientResolver.test.ts` fails if a NIP lookup or promotion comes back. Anything that can't be tied
  to exactly one client goes to the staff-only quarantine — never BCR GROUP, never a guess.
- **`ClaudeClassifier.classify()` never throws and never rejects.** Unsupported type, oversize, API
  error, malformed output, low confidence → return `null` so `FallbackClassifier` files the document
  into `98_Nieposortowane/YYYY/MM/` for manual review. Preserve this contract.
- **Directory lookups are fail-closed and order-independent.** `buildSnapshot` in
  `clientDirectoryReader.ts` works in two passes: collect every key's rows, then admit a user id only
  when exactly one trusted row holds it. A user id on two rows (or on a client and an admin row) routes
  nowhere; rows sharing a target, or pointing at a forbidden site or another host, are excluded
  entirely. A shared NIP or ClientId only raises `directory.conflict` — neither routes anything. A
  snapshot older than `CLIENT_DIRECTORY_MAX_STALE_MS` is treated as unavailable (everything to
  quarantine). BCR staff ids never belong on client rows.
- **`parsers/folderTaxonomy.ts` is the single source of truth for folder layout.** `categoryCatalog`
  drives the Claude system prompt *and* the tool-call enum *and* `buildFolderPath()`, so the model
  can never name a category the uploader can't build a path for. Add or rename a category there and
  nowhere else; `dated: true` categories require `year`/`month` and get a `YYYY/MM` leaf.
- **Never build a SharePoint path by string concatenation.** Go through
  `utils/pathBuilder.ts` (`sanitizeFolderPath` / `sanitizeFilename` / `joinFolderPath`, then
  `encodeGraphPath` for the URL) — it rejects traversal and reserved names, strips SharePoint's
  forbidden characters, and percent-encodes `#`, `%` and spaces so they can't truncate the request.
- **Uploads never overwrite.** `conflictBehavior=fail` on both upload paths; no existence probes (they
  raced, and told a caller which names already existed).
- **Responses and logs carry ids, not client data.** A quarantined row has no link, folder or name;
  the result card shows the taxonomy label, never the model's reasoning; logs carry `documentId`,
  `clientId`, `listItemId`, `driveItemId` — file names, titles, NIPs and SharePoint locations are
  redacted by the root logger (`shared/src/logger.ts`).
- **Only 1:1 chats are processed.** Teams *channel* uploads never reach a bot (drag-drop bypasses
  Bot Framework; `@mention` activities carry only mention HTML), and group chats are refused. Every
  activity passes the bot gate (personal conversation, BCR tenant, GUID `aadObjectId`) before any
  logic runs, and the ingestion API re-checks it. `teamsChannelId` is telemetry only. The anonymous
  Personal Tab lookup (`/api/user-target`) is deleted: it mapped any user id to their client.

### Bot side

`bot/ledgerBot.ts` is the only place with turn logic and is kept free of HTTP/SDK plumbing so it is
testable with `TestAdapter`; `functions/messages.ts` just calls `adapter.processActivityDirect`.
All attachments from one activity are downloaded in parallel and sent as **one batch**, so the user
gets a single consolidated result card. A per-file download or ingest failure becomes a `rejected`
row in that card rather than an aborted turn. The gate (`BOT_GATE_MODE=log|enforce`) runs for every
activity type before the turn logic; the card escapes every inserted value and renders Polish text by
error code, never raw error messages.

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

`PROJECT_OVERVIEW.md` → *Lessons learned* has the full list (19 items). The ones that affect code:

- **SharePoint drive names are locale-dependent** — Polish tenants use `Dokumenty`, not `Documents`.
  Always resolve via `GET /sites/{id}/drives`; per-client names come from the Directory's `DriveName`
  column, the quarantine site's from `QUARANTINE_DRIVE_NAME`.
- **Graph calls use the Function App's system-assigned managed identity**, not the API app
  registration, and `Sites.Selected` needs *two* grants (Graph app role + per-site permission);
  per-site grants take ~5 min to propagate. Every grant names the MI's app id (`INGEST_MI_APPID`);
  a grant to the API app registration does nothing. See `docs/setup-guide.md` §5 and
  `infrastructure/quarantine/README.md` (the old `grant-sharepoint-permission.sh` is deleted).
- `MICROSOFT_APP_TYPE` must be `SingleTenant` (the app registration is `AzureADMyOrg`); the wrong
  value is a 401 at Bot Framework auth.
- `@anthropic-ai/sdk` must stay ≥ 0.40 for typed PDF `document` content blocks
  (`Anthropic.Messages.ContentBlockParam`).
- If `tsc -b` keeps seeing stale `@bcr/shared` types, delete the physical copy Yarn sometimes leaves
  at `packages/<pkg>/node_modules/@bcr/shared` so resolution falls back to the root symlink.

## Docs map

| File | What's in it |
|---|---|
| `ARCHITECTURE.md` | Component/sequence detail; §4.2 multi-tenant routing, §5 auth model |
| `PROJECT_OVERVIEW.md` | Current deployed state, tooling versions, lessons learned |
| `docs/setup-guide.md` | First-time setup: app registrations, every env var and where to find it |
| `docs/client-directory-admin-guide.md` | The Client Directory list — columns and admin workflow |
| `docs/admin-sharepoint-grant.md` | `Sites.Selected` via Graph Explorer |
| `docs/security.md` | Threat model + secrets inventory |
| `docs/operations/human-steps.md` | Ordered Phase-0 rollout: who runs what, verification, rollback |
| `docs/operations/incident-2026-09.md` | The cross-client routing incident: causes, IR-0..IR-3, status |
| `docs/operations/tenant-hardening.md` | Tenant settings that keep clients apart (BCR GROUP stays Private, read-only check) |
| `docs/diagrams/` | Mermaid: as-is, Phase-0 routing, target business logic/architecture/data flow, sequences, data model |
| `tools/README.md` | Operator tools (directory bindings, IR-0/IR-1): dry-run by default, `--apply` to write |
