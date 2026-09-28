import { z } from 'zod';
import { ValidationError } from './errors';
import { canonicalSitePath } from './sitePath';

// ---------------------------------------------------------------------------
// Custom Zod helpers
// ---------------------------------------------------------------------------

/**
 * A boolean derived from a string env var. Empty/undefined → the default
 * value. Accepts `"true"`/`"1"` (case-insensitive) as true; everything
 * else is false. Defined as a function so each schema gets a fresh default.
 */
const boolish = (defaultValue: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined || v === '') return defaultValue;
      const normalised = v.toLowerCase();
      return normalised === 'true' || normalised === '1' || normalised === 'yes';
    });

/**
 * CSV → readonly string[]. Trims whitespace and drops empties. Useful for
 * AAD role lists like `Documents.Ingest,Documents.Admin`.
 */
const csvList = (defaultValue: readonly string[]) =>
  z
    .string()
    .optional()
    .transform((v) =>
      v
        ? v
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : [...defaultValue],
    );

/**
 * A CSV list that must not be empty. For allow-lists (caller app ids, forbidden
 * targets) an empty value is a misconfiguration, not "allow nothing" or
 * "forbid nothing", so it fails at cold start like any required variable.
 */
const requiredCsvList = (message: string) =>
  z
    .string({ required_error: message })
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    )
    .refine((list) => list.length > 0, message);

/**
 * Site-collection paths (`/sites/<name>` or `/teams/<name>`, see
 * {@link canonicalSitePath}), returned in their canonical spelling. Anything
 * else would match no Directory row and silently disable the guard it feeds,
 * so it fails at cold start.
 */
const toCanonicalSitePaths =
  (message: string) =>
  (paths: readonly string[], ctx: z.RefinementCtx): string[] => {
    const canonical: string[] = [];
    for (const p of paths) {
      const c = canonicalSitePath(p);
      if (c === null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message });
        return z.NEVER;
      }
      canonical.push(c);
    }
    return canonical;
  };

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A UTC time, to the minute or finer, ending in `Z`: no offset to misread. */
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z$/;

/** Optional string: missing, empty or whitespace-only all give the default. */
const optionalStr = (defaultValue = '') =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? defaultValue : v));

/**
 * Numeric env var with a default. Empty/undefined → default. Rejects values
 * that don't parse to a finite number so misconfiguration fails fast.
 */
const numeric = (defaultValue: number) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v.trim() === '') return defaultValue;
      const n = Number(v);
      if (!Number.isFinite(n)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be a number' });
        return z.NEVER;
      }
      return n;
    });

/**
 * A whole number of at least `min`, from an env var, with a default.
 * Empty/undefined → default. A fraction, a negative or a non-number fails
 * at cold start: a budget or an age that parses to something else would
 * silently change what the sweep does.
 */
const wholeNumber = (defaultValue: number, min: number) =>
  numeric(defaultValue).refine(
    (n) => Number.isInteger(n) && n >= min,
    `must be a whole number of at least ${min}`,
  );

const logLevel = z
  .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
  .optional()
  .transform((v) => v ?? 'info');

/** `CLASSIFICATION_ACCEPT_THRESHOLD` when unset. */
export const CLASSIFICATION_ACCEPT_THRESHOLD_DEFAULT = 0.7;
/** The lowest accepted threshold: a 0.69 result is never filed under its category. */
export const CLASSIFICATION_ACCEPT_THRESHOLD_MIN = 0.7;
/** The highest accepted threshold. */
export const CLASSIFICATION_ACCEPT_THRESHOLD_MAX = 0.95;

// ---------------------------------------------------------------------------
// Bot configuration
//
// Validated at cold start so the process fails fast (and visibly) on
// misconfiguration rather than 500-ing on the first incoming activity.
// ---------------------------------------------------------------------------

export const botConfigSchema = z.object({
  microsoftAppId: z.string().uuid('MICROSOFT_APP_ID must be a UUID'),
  microsoftAppPassword: z.string().min(1, 'MICROSOFT_APP_PASSWORD is required'),
  microsoftAppTenantId: z.string().uuid('MICROSOFT_APP_TENANT_ID must be a UUID'),
  // Required, with no default: the app registration is AzureADMyOrg, and the
  // old `MultiTenant` default is a 401 at Bot Framework auth (lesson #12).
  microsoftAppType: z.enum(['MultiTenant', 'SingleTenant', 'UserAssignedMSI'], {
    required_error: 'MICROSOFT_APP_TYPE is required (SingleTenant for the BCR bot)',
  }),
  ingestionBaseUrl: z.string().url('INGESTION_BASE_URL must be an absolute URL'),
  ingestionScope: z.string().min(1, 'INGESTION_SCOPE is required'),
  /**
   * What the bot does with an activity that fails the gate (not a 1:1 chat,
   * not the BCR tenant, or no AAD object id). `log` records the rejection and
   * lets the turn through; `enforce` refuses it before any download. `log`
   * exists only for the first 24 h of the Phase-0 rollout, to prove real
   * guest activities pass before anything is refused.
   */
  botGateMode: z
    .enum(['log', 'enforce'])
    .optional()
    .transform((v) => v ?? 'enforce'),
  applicationInsightsConnectionString: optionalStr(),
  logLevel,
});

export type BotConfig = z.infer<typeof botConfigSchema>;

// ---------------------------------------------------------------------------
// Ingestion configuration
// ---------------------------------------------------------------------------

export const ingestionConfigSchema = z.object({
  azureTenantId: z.string().uuid('AZURE_TENANT_ID must be a UUID'),
  ingestionAppId: z.string().uuid('INGESTION_APP_ID must be a UUID'),
  expectedAudience: z.string().min(1, 'EXPECTED_AUDIENCE is required'),
  expectedRoles: csvList(['Documents.Ingest']),
  /**
   * App ids (`appid`/`azp` claim) allowed to call the ingestion API. The role
   * alone is not enough: any app that holds `Documents.Ingest` could otherwise
   * assert any user id.
   */
  // Each entry must be an app id: a pasted Key Vault reference or a stray
  // quote would start fine and then refuse every call.
  botCallerAppIds: requiredCsvList('BOT_CALLER_APP_IDS must list at least one app id').refine(
    (list) => list.every((id) => GUID.test(id)),
    'BOT_CALLER_APP_IDS entries must be app ids (GUIDs)',
  ),
  // --- Multi-tenant Client Directory (SharePoint list, see §4.2) ---
  /**
   * Graph site id (`<hostname>,<siteCollectionGuid>,<webGuid>`) where the
   * Client Directory list lives — BCR GROUP. Its site-collection GUID is the
   * resolved-site guard that keeps every client write out of BCR GROUP, so
   * only the three-part form is accepted: Graph's path form
   * (`host:/sites/X:`) or a two-part id would still read the Directory but
   * would never match a resolved site, and the guard would guard nothing.
   */
  clientDirectorySiteId: z
    .string({ required_error: 'CLIENT_DIRECTORY_SITE_ID is required' })
    .trim()
    .regex(
      /^[a-z0-9.-]+,[0-9a-f-]{36},[0-9a-f-]{36}$/i,
      'CLIENT_DIRECTORY_SITE_ID must be the three-part Graph site id <host>,<siteGuid>,<webGuid>',
    ),
  /** Graph list id (GUID) of the Client Directory list. */
  clientDirectoryListId: z.string().uuid('CLIENT_DIRECTORY_LIST_ID must be a UUID'),
  /** How long the directory snapshot is cached in-process before refetching (ms). Default 5 min. */
  clientDirectoryCacheTtlMs: numeric(5 * 60 * 1000),
  /**
   * Oldest snapshot still used when refreshes keep failing (ms). Past this age
   * the snapshot is treated as empty, so every upload goes to quarantine
   * rather than routing on a directory that may have been corrected since.
   * Default 15 min.
   */
  clientDirectoryMaxStaleMs: numeric(15 * 60 * 1000),
  // --- Staff-only quarantine for uploads that cannot be tied to one client ---
  // A dedicated communication site with no M365 group and sharing disabled.
  // Never a client Team, never BCR GROUP.
  /**
   * The tenant's SharePoint host, e.g. `contoso.sharepoint.com`. It is also
   * the only host a Directory row may name: a row on any other host routes
   * nobody. A host name only — no scheme, no path.
   */
  quarantineSiteHostname: z
    .string({ required_error: 'QUARANTINE_SITE_HOSTNAME is required' })
    .trim()
    .regex(
      /^[a-z0-9-]+\.sharepoint\.com$/i,
      'QUARANTINE_SITE_HOSTNAME must be a host name like contoso.sharepoint.com, not a URL',
    ),
  quarantineSitePath: z
    .string({ required_error: 'QUARANTINE_SITE_PATH is required' })
    .transform((p, ctx) => {
      const canonical = canonicalSitePath(p);
      if (canonical !== null) return canonical;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'QUARANTINE_SITE_PATH must be a site path like /sites/<name>',
      });
      return z.NEVER;
    }),
  quarantineDriveName: optionalStr('Documents'),
  quarantineRootFolder: optionalStr('Kwarantanna'),
  /**
   * Site paths no Directory row may ever route to (BCR GROUP, at minimum).
   * The quarantine site is added automatically. A row pointing at one of
   * these is excluded from routing as `forbidden_target`.
   */
  // Each entry is a site-collection path. A pasted URL or a sub-path would
  // never match a row and would silently disable the guard, so it fails at
  // cold start. Entries come back in their canonical spelling.
  forbiddenTargetSitePaths: requiredCsvList(
    'FORBIDDEN_TARGET_SITE_PATHS must list at least the BCR GROUP site path',
  ).transform(
    toCanonicalSitePaths(
      'FORBIDDEN_TARGET_SITE_PATHS entries must be site paths like /sites/BCRGROUP, not URLs',
    ),
  ),
  /**
   * Whether routing checks the uploader's Team membership at upload time.
   * `enforce` (the default): a bound uploader's Teams, read from Entra, must
   * be exactly their row's TeamId, or the upload is quarantined. `off` is an
   * emergency escape only: it reopens R46 (a guest added to a second client's
   * Team keeps filing into the first client's space), and is logged as a
   * warning at every cold start. Empty means the default; anything else fails
   * at cold start, so a typo can never switch the check off.
   */
  membershipCheckMode: z
    .preprocess(
      (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
      z
        .enum(['enforce', 'off'], {
          errorMap: () => ({ message: "must be 'enforce' or 'off'" }),
        })
        .optional(),
    )
    .transform((v) => v ?? 'enforce'),
  // --- Channel-inbox intake (the client's Team → "Dokumenty księgowe") ---
  /**
   * What the inbox sweep timer does. `off` (the default, also when empty):
   * returns at once. `shadow`: reads the inboxes, checks each uploader and
   * classifies, then only logs what it would move; it creates no folder and
   * moves nothing. `enforce`: moves each client upload into its taxonomy
   * folder inside the same channel folder. Anything else fails at cold start,
   * so a typo can never switch writes on.
   */
  inboxSweepMode: z
    .preprocess(
      (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
      z
        .enum(['off', 'shadow', 'enforce'], {
          errorMap: () => ({ message: "must be 'off', 'shadow' or 'enforce'" }),
        })
        .optional(),
    )
    .transform((v) => v ?? 'off'),
  /**
   * How long a file must be unmodified before the sweep touches it (ms).
   * Younger files may still be uploading or being edited. Default 2 min.
   */
  inboxMinAgeMs: wholeNumber(2 * 60 * 1000, 0),
  /** Most files taken into processing per sweep tick, across all clients. Default 20. */
  inboxMaxFilesPerTick: wholeNumber(20, 1),
  /**
   * Which bound rows the sweep may touch, as Client Directory list item ids
   * (the `listItemId` in the logs), comma-separated. Empty (the default):
   * every row the Directory routes to. Set: only those of them, so a first
   * `shadow`/`enforce` can be limited to a canary Team's row before a real
   * client's channel is swept. It only ever narrows: a listed row that is not
   * bound or is excluded is still not swept. A value that is not a list of
   * whole numbers fails at cold start.
   */
  inboxSweepRows: csvList([]).refine(
    (ids) => ids.every((id) => /^[1-9][0-9]*$/.test(id)),
    'must be Client Directory list item ids (whole numbers), comma-separated',
  ),
  /**
   * Files the sweep leaves where they are because they were created at or
   * before this time: an ISO 8601 UTC time such as `2026-10-01T00:00:00Z`.
   * Empty (the default): no cutoff. For a channel whose older attachments
   * the owner decided to leave in place when the sweep was turned on.
   */
  inboxCreatedAfter: z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v.trim() === '') return undefined;
      const ms = ISO_UTC.test(v.trim()) ? Date.parse(v.trim()) : NaN;
      if (!Number.isFinite(ms)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'must be an ISO 8601 UTC time, e.g. 2026-10-01T00:00:00Z',
        });
        return z.NEVER;
      }
      return ms;
    }),
  // --- Claude (Anthropic) content classification ---
  anthropicEnabled: boolish(false),
  anthropicApiKey: optionalStr(),
  /**
   * The model id. The request (structured output, `effort`, a cached system
   * prompt, no sampling parameters, no `thinking` field unless
   * `ANTHROPIC_THINKING=disabled`) is valid unchanged on `claude-opus-5` and
   * `claude-sonnet-5` (2/5 of Opus 5's price per token), and on the
   * `claude-opus-4-5-20251101` Opus 5 replaced.
   */
  anthropicModel: optionalStr('claude-opus-5'),
  /**
   * `ANTHROPIC_EFFORT`: `output_config.effort` of every classification call.
   * `low` (the default) is the cheapest, and enough for one short
   * classification; raise it only when an evaluation shows shallow answers at
   * `low`. Anything else fails at cold start.
   */
  anthropicEffort: z
    .preprocess(
      (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
      z
        .enum(['low', 'medium', 'high'], {
          errorMap: () => ({ message: "must be 'low', 'medium' or 'high'" }),
        })
        .optional(),
    )
    .transform((v) => v ?? 'low'),
  /**
   * `ANTHROPIC_THINKING`: `adaptive` (the default: no `thinking` field, so
   * the model decides how much to think at the given effort) or `disabled`
   * (no thinking tokens at all). Anthropic recommends adaptive at `low` first.
   * `disabled` is accepted only with a model that takes it at this effort
   * (see {@link thinkingDisabledProblem}); anything else fails at cold start.
   */
  anthropicThinking: z
    .preprocess(
      (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
      z
        .enum(['adaptive', 'disabled'], {
          errorMap: () => ({ message: "must be 'adaptive' or 'disabled'" }),
        })
        .optional(),
    )
    .transform((v) => v ?? 'adaptive'),
  /** Hard cap on document bytes sent to the model. Default 10 MiB. */
  anthropicMaxContentBytes: numeric(10 * 1024 * 1024),
  /**
   * The one confidence threshold (`CLASSIFICATION_ACCEPT_THRESHOLD`): below it
   * a document is filed in `98_Nieposortowane` for review, with the model's
   * suggestion kept. Only the acceptance policy applies it. It replaces
   * `ANTHROPIC_CONFIDENCE_THRESHOLD`, which is no longer read. Outside
   * 0.70–0.95 it fails at cold start: 0.69 would file guesses, and above 0.95
   * almost everything would wait for review.
   */
  classificationAcceptThreshold: numeric(CLASSIFICATION_ACCEPT_THRESHOLD_DEFAULT).refine(
    (n) => n >= CLASSIFICATION_ACCEPT_THRESHOLD_MIN && n <= CLASSIFICATION_ACCEPT_THRESHOLD_MAX,
    `must be a number from ${CLASSIFICATION_ACCEPT_THRESHOLD_MIN.toFixed(2)} to ` +
      `${CLASSIFICATION_ACCEPT_THRESHOLD_MAX.toFixed(2)}`,
  ),
  // --- The document index (packages/ledger-db, Azure Database for PostgreSQL) ---
  /**
   * `LEDGER_INDEX_MODE`. `off` (the default, also when empty): no database is
   * connected to and nothing is indexed. `write`: after a document is filed
   * or sorted to review by the bot path, or moved by the channel inbox in
   * `enforce` (never in `shadow`), its row is written to the index in a
   * transaction scoped to its client; quarantined documents are never
   * indexed. A failed index write is logged (`index.write_failed`) and never
   * blocks or undoes the filing. Anything else fails at cold start.
   */
  ledgerIndexMode: z
    .preprocess(
      (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
      z
        .enum(['off', 'write'], { errorMap: () => ({ message: "must be 'off' or 'write'" }) })
        .optional(),
    )
    .transform((v) => v ?? 'off'),
  /**
   * `LEDGER_DB_HOST`: the PostgreSQL server's host name,
   * `<server>.postgres.database.azure.com`. Required with `write`.
   */
  ledgerDbHost: optionalStr().refine(
    (h) => h === '' || /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(h),
    'must be a host name like <server>.postgres.database.azure.com, not a URL',
  ),
  /** `LEDGER_DB_NAME`: the database. Default `ledger`. */
  ledgerDbName: optionalStr('ledger').refine(
    (n) => /^[a-z_][a-z0-9_]{0,62}$/.test(n),
    'must be a database name (lower-case letters, digits, _)',
  ),
  /**
   * `LEDGER_DB_USER`: the PostgreSQL login of this app's managed identity,
   * named after the Function App (`pgaadauth_create_principal`). Its password
   * is an Entra token fetched per connection; there is no stored password.
   * Required with `write`.
   */
  ledgerDbUser: optionalStr().refine(
    (u) => u === '' || /^[A-Za-z0-9][A-Za-z0-9._@-]{0,62}$/.test(u),
    'must be a PostgreSQL login name (the Function App name)',
  ),
  /**
   * `AzureWebJobsStorage`: the Functions host's own storage account, set by
   * Bicep. The channel inbox keeps its shadow memo there (table
   * `inboxshadow`: ids and hashes only). Empty: the memo is this worker's
   * memory only. A secret (an account key): never logged.
   */
  webJobsStorage: optionalStr(),
  /**
   * `REVIEW_WEBHOOK_URL`: the Teams Workflows webhook that posts review notices
   * into the staff chat, as a Key Vault reference to `review-webhook-url`. The
   * whole URL is the credential: never logged. Anything but an `https://` URL
   * (empty, or a reference Key Vault could not resolve) turns the notices off,
   * with the reason said once at cold start; it never stops ingestion.
   */
  reviewWebhookUrl: optionalStr(),
  applicationInsightsConnectionString: optionalStr(),
  logLevel,
});

export type IngestionConfig = z.infer<typeof ingestionConfigSchema>;

/** `LEDGER_INDEX_MODE`: see {@link ingestionConfigSchema}. */
export type LedgerIndexMode = IngestionConfig['ledgerIndexMode'];

/**
 * The settings `LEDGER_INDEX_MODE=write` needs, by env var name, that are
 * empty in `config`. Empty with `off`: nothing is needed then.
 */
export function missingLedgerIndexSettings(
  config: Pick<IngestionConfig, 'ledgerIndexMode' | 'ledgerDbHost' | 'ledgerDbUser'>,
): string[] {
  if (config.ledgerIndexMode !== 'write') return [];
  return [
    ...(config.ledgerDbHost === '' ? ['LEDGER_DB_HOST'] : []),
    ...(config.ledgerDbUser === '' ? ['LEDGER_DB_USER'] : []),
  ];
}

/** `ANTHROPIC_EFFORT`: see {@link ingestionConfigSchema}. */
export type AnthropicEffort = IngestionConfig['anthropicEffort'];

/** `ANTHROPIC_THINKING`: see {@link ingestionConfigSchema}. */
export type AnthropicThinking = IngestionConfig['anthropicThinking'];

/**
 * The models that accept `thinking: {type: 'disabled'}` at efforts up to
 * `high`. Opus 5.5 and Fable 5.1 reject it outright: every call would be a
 * 400, and every document would go to review unclassified.
 */
const THINKING_DISABLED_MODELS: ReadonlySet<string> = new Set(['claude-opus-5', 'claude-sonnet-5']);

/**
 * Why `ANTHROPIC_THINKING=disabled` cannot run with this model, or `undefined`
 * when it can (or thinking is adaptive). Checked at cold start.
 */
export function thinkingDisabledProblem(
  config: Pick<IngestionConfig, 'anthropicThinking' | 'anthropicModel'>,
): string | undefined {
  if (config.anthropicThinking !== 'disabled') return undefined;
  return THINKING_DISABLED_MODELS.has(config.anthropicModel)
    ? undefined
    : `ANTHROPIC_THINKING: 'disabled' is not accepted by ANTHROPIC_MODEL ${config.anthropicModel}; ` +
        `use 'adaptive', or one of ${[...THINKING_DISABLED_MODELS].join(', ')}`;
}

/** `MEMBERSHIP_CHECK_MODE`: see {@link ingestionConfigSchema}. */
export type MembershipCheckMode = IngestionConfig['membershipCheckMode'];

/** `INBOX_SWEEP_MODE`: see {@link ingestionConfigSchema}. */
export type InboxSweepMode = IngestionConfig['inboxSweepMode'];

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Load a config schema from `process.env`, mapping SCREAMING_SNAKE env vars
 * to camelCase fields. Anything missing/invalid throws immediately with a
 * readable {@link ValidationError} that references the offending env var.
 */
export function loadConfig<T extends z.ZodTypeAny>(
  schema: T,
  envMap: Readonly<Record<keyof z.infer<T> & string, string>>,
  env: NodeJS.ProcessEnv = process.env,
): z.infer<T> {
  const raw: Record<string, string | undefined> = {};
  for (const [field, envVar] of Object.entries(envMap)) {
    raw[field] = env[envVar];
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => {
        const path = i.path.join('.');
        const envVar = (envMap as Record<string, string>)[path] ?? path;
        return `${envVar}: ${i.message}`;
      })
      .join('; ');
    throw new ValidationError(`Invalid configuration: ${issues}`);
  }
  return parsed.data;
}
