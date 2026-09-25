# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

`bcr-ledger-agent` is one of several `bcr-*` repos (`bcr-onboarding-agent`, `bcr-website`).
The [Conventions shared by all `bcr-*` repos](#conventions-shared-by-all-bcr-repos) section below
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
yarn lint                    # ESLint over packages/**/src/**/*.ts
yarn type-check              # tsc --noEmit per workspace
yarn format                  # Prettier over sources + infrastructure/**/*.bicep
```

Single workspace / single test / single case:

```bash
yarn workspace @bcr/document-ingestion test src/services/clientResolver.test.ts
yarn workspace @bcr/document-ingestion test -t 'promotes fallback'
yarn workspace @bcr/shared test:coverage        # enforces per-package thresholds
```

Coverage thresholds are **per package and they fail the run**: `shared` 85/85/80/80
(lines/statements/functions/branches), `document-ingestion` 85/85/80/75, `teams-bot` 80/80/75/70.
`src/functions/**` and `src/index.ts` are excluded from coverage in the two Function App packages —
HTTP wiring is tested via the exported `handleX` functions, not the `app.http()` registration.

Local run (two processes; `prestart` builds, and `@bcr/shared` must be built first):

```bash
cp packages/teams-bot/local.settings.json.example packages/teams-bot/local.settings.json
cp packages/document-ingestion/local.settings.json.example packages/document-ingestion/local.settings.json
yarn start:bot            # http://localhost:3978/api/messages  (point Bot Framework Emulator here)
yarn start:ingestion      # http://localhost:7071/api/ingest
```

Deploy: `yarn deploy:dev` / `yarn deploy:prod` run `infrastructure/deploy.sh <env>` (Bicep, then
zip-deploy of both Function Apps). `yarn workspace @bcr/<pkg> package` builds the zip into
`artifacts/`. CI (`.github/workflows/ci.yml`) runs lint → type-check → build → test plus
`bicep build`/`bicep lint`; `deploy.yml` deploys via Azure OIDC.

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

`functions/ingestDocument.ts` orchestrates; every collaborator is a cold-start singleton from
`runtime.ts`:

1. **Auth** — `auth/authMiddleware.ts` verifies the AAD JWT itself (signature via tenant JWKS,
   issuer, audience, `roles` claim). Functions are `authLevel: 'anonymous'` *on purpose*.
2. **Validate** — `functions/validation.ts` (zod): filename has no path separators, base64 shape,
   ≤25 docs per batch, ≤100 MiB decoded.
3. **Pre-resolve client** — `services/clientResolver.ts#resolve()` maps `source.userAadObjectId` to
   a Client Directory row, else the fallback bucket.
4. **Classify** — `services/classificationService.ts` runs classifiers in order and returns the
   first result at/above 0.8 confidence, else the best one. Chain is
   `ClaudeClassifier → FallbackClassifier` (Claude only if `ANTHROPIC_ENABLED` + key).
5. **Post-resolve** — `resolvePostClassification()` uses the `parties[]` Claude extracted to
   (a) promote a fallback upload to a real client when exactly one party NIP matches the Directory,
   and (b) flip sprzedaż ⇄ zakup and rebuild the folder path.
6. **Upload** — `sharePointServiceFactory.ts` returns a per-target cached `SharePointService`, which
   resolves site+drive ids, creates the folder chain idempotently, de-collides the filename with
   `_n`, then PUTs (≤4 MiB) or uses a chunked upload session.

### Invariants — break these and documents mis-file

- **Two-phase resolution is deliberate.** Phase 1 runs *before* Claude so the client's identity can
  be primed into the prompt (that is how direction is decided confidently); phase 2 runs *after* so
  content can still correct routing. Any phase-2 failure must degrade to the phase-1 routing —
  an upload never blocks on refinement.
- **`ClaudeClassifier.classify()` never throws and never rejects.** Unsupported type, oversize, API
  error, malformed output, low confidence → return `null` so `FallbackClassifier` files the document
  into `98_Nieposortowane/YYYY/MM/` for manual review. Preserve this contract.
- **Directory lookups are fail-closed.** In `clientDirectoryReader.ts`, a key (NIP, alias, person
  name, AAD id) appearing on two different clients is *deleted* from the lookup map and logged —
  better to fall back than to file into the wrong client's SharePoint site. Name matching is exact
  after normalization, never fuzzy, for the same reason.
- **`parsers/folderTaxonomy.ts` is the single source of truth for folder layout.** `categoryCatalog`
  drives the Claude system prompt *and* the tool-call enum *and* `buildFolderPath()`, so the model
  can never name a category the uploader can't build a path for. Add or rename a category there and
  nowhere else; `dated: true` categories require `year`/`month` and get a `YYYY/MM` leaf.
- **Never build a SharePoint path by string concatenation.** Go through
  `utils/pathBuilder.ts` (`sanitizeFolderPath` / `sanitizeFilename` / `joinFolderPath`) — it rejects
  traversal and reserved names and strips SharePoint's forbidden characters.
- **Routing is user-identity based.** Teams *channel* uploads never reach a bot (drag-drop bypasses
  Bot Framework; `@mention` activities carry only mention HTML). `teamsChannelId` is captured for
  telemetry only — do not reintroduce channel-based routing. The Personal Tab
  (`teams-bot/src/functions/mydocs.ts` → `GET /api/user-target`) exists because of this.

### Bot side

`bot/ledgerBot.ts` is the only place with turn logic and is kept free of HTTP/SDK plumbing so it is
testable with `TestAdapter`; `functions/messages.ts` just calls `adapter.processActivityDirect`.
All attachments from one activity are downloaded in parallel and sent as **one batch**, so the user
gets a single consolidated result card. A per-file download or ingest failure becomes a `rejected`
row in that card rather than an aborted turn.

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
  column, the fallback from `FALLBACK_DRIVE_NAME`.
- **Graph calls use the Function App's system-assigned managed identity**, not the API app
  registration, and `Sites.Selected` needs *two* grants (Graph app role + per-site permission);
  per-site grants take ~5 min to propagate. See `docs/admin-sharepoint-grant.md`.
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
