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

/** `MEMBERSHIP_CHECK_MODE`: see {@link ingestionConfigSchema}. */
export type MembershipCheckMode = IngestionConfig['membershipCheckMode'];

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
