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

/** Optional string that collapses `""` → `undefined` so `.default("")` works. */
const optionalStr = (defaultValue = '') =>
  z
    .string()
    .optional()
    .transform((v) => v ?? defaultValue);

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
  microsoftAppType: z
    .enum(['MultiTenant', 'SingleTenant', 'UserAssignedMSI'])
    .optional()
    .transform((v) => v ?? 'MultiTenant'),
  ingestionBaseUrl: z.string().url('INGESTION_BASE_URL must be an absolute URL'),
  ingestionScope: z.string().min(1, 'INGESTION_SCOPE is required'),
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
  sharepointSiteHostname: z.string().min(3, 'SHAREPOINT_SITE_HOSTNAME is required'),
  sharepointSitePath: z
    .string()
    .min(1, 'SHAREPOINT_SITE_PATH is required')
    .refine((p) => p.startsWith('/'), 'SHAREPOINT_SITE_PATH must start with /'),
  sharepointDriveName: optionalStr('Documents'),
  sharepointRootFolder: optionalStr(),
  // --- Claude (Anthropic) content classification ---
  anthropicEnabled: boolish(false),
  anthropicApiKey: optionalStr(),
  anthropicModel: optionalStr('claude-opus-4-5-20251101'),
  /** Hard cap on document bytes sent to the model. Default 10 MiB. */
  anthropicMaxContentBytes: numeric(10 * 1024 * 1024),
  /** Minimum confidence to accept a classification; below this → manual review. */
  anthropicConfidenceThreshold: numeric(0.6),
  // --- Client identity (per-client deployment) ---
  /** Legal/company name of the client this SharePoint space belongs to. */
  clientCompanyName: optionalStr(),
  /** Client tax id (NIP), used to decide invoice direction (sales vs purchase). */
  clientNip: optionalStr(),
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
