import { z } from 'zod';
import { ValidationError } from './errors';

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

const logLevel = z
  .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
  .optional()
  .transform((v) => v ?? 'info');

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
  botCallerAppIds: requiredCsvList('BOT_CALLER_APP_IDS must list at least one app id'),
  // --- Multi-tenant Client Directory (SharePoint list, see §4.2) ---
  /** Graph site id (`<hostname>,<siteGuid>,<webGuid>`) where the Client Directory list lives. */
  clientDirectorySiteId: z.string().min(1, 'CLIENT_DIRECTORY_SITE_ID is required'),
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
  quarantineSiteHostname: z.string().min(3, 'QUARANTINE_SITE_HOSTNAME is required'),
  quarantineSitePath: z
    .string()
    .min(1, 'QUARANTINE_SITE_PATH is required')
    .refine((p) => p.startsWith('/'), 'QUARANTINE_SITE_PATH must start with /'),
  quarantineDriveName: optionalStr('Documents'),
  quarantineRootFolder: optionalStr('Kwarantanna'),
  /**
   * Site paths no Directory row may ever route to (BCR GROUP, at minimum).
   * The quarantine site is added automatically. A row pointing at one of
   * these is excluded from routing as `forbidden_target`.
   */
  // Each entry is a server-relative site path. A pasted URL would never match
  // a row and would silently disable the guard, so it fails at cold start.
  forbiddenTargetSitePaths: requiredCsvList(
    'FORBIDDEN_TARGET_SITE_PATHS must list at least the BCR GROUP site path',
  ).refine(
    (list) => list.every((p) => /^\/(sites|teams)\/[^/]+\/?$/i.test(p)),
    'FORBIDDEN_TARGET_SITE_PATHS entries must be site paths like /sites/BCRGROUP, not URLs',
  ),
  // --- Claude (Anthropic) content classification ---
  anthropicEnabled: boolish(false),
  anthropicApiKey: optionalStr(),
  anthropicModel: optionalStr('claude-opus-4-5-20251101'),
  /** Hard cap on document bytes sent to the model. Default 10 MiB. */
  anthropicMaxContentBytes: numeric(10 * 1024 * 1024),
  /** Minimum confidence to accept a classification; below this → manual review. */
  anthropicConfidenceThreshold: numeric(0.6),
  applicationInsightsConnectionString: optionalStr(),
  logLevel,
});

export type IngestionConfig = z.infer<typeof ingestionConfigSchema>;

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
