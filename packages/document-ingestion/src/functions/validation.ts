import { z } from 'zod';
import { ValidationError, type IngestionBatchRequestPayload } from '@bcr/shared';

const documentSchema = z.object({
  filename: z
    .string()
    .min(1)
    .max(255)
    .refine((s) => !s.includes('/') && !s.includes('\\'), 'filename must not contain path separators'),
  contentType: z.string().min(1).max(255),
  contentBase64: z
    .string()
    .min(1)
    .refine((s) => /^[A-Za-z0-9+/=\r\n]+$/.test(s), 'contentBase64 must be base64-encoded'),
});

/**
 * The request envelope. Only a 1:1 chat from a signed-in user of the BCR
 * tenant is accepted: the bot refuses everything else before downloading,
 * and this re-check means a caller that skips the bot's gate still cannot
 * file anything. The uploader id is what routing uses, so it must be a GUID.
 */
const sourceSchema = z.object({
  tenantId: z.string().min(1),
  channelId: z.string().min(1),
  conversationId: z.string().min(1),
  activityId: z.string().min(1),
  conversationType: z.literal('personal', {
    errorMap: () => ({ message: 'only 1:1 (personal) conversations are accepted' }),
  }),
  // Present only for messages posted in a Teams team channel; absent for 1:1 chats.
  teamsChannelId: z.string().min(1).optional(),
  userAadObjectId: z.string().uuid('userAadObjectId must be a GUID'),
  userDisplayName: z.string().optional(),
});

/** Maximum number of documents accepted in a single batch request. */
const MAX_BATCH_DOCUMENTS = 25;

const ingestionBatchRequestSchema = z.object({
  documents: z.array(documentSchema).min(1).max(MAX_BATCH_DOCUMENTS),
  source: sourceSchema,
});

/** Maximum decoded payload size — 100 MiB. Anything larger should use a SAS upload. */
const MAX_DECODED_BYTES = 100 * 1024 * 1024;

export interface BatchValidationOptions {
  /** The BCR tenant id. A request naming any other tenant is refused. */
  readonly expectedTenantId: string;
}

function formatIssues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
}

function approxDecodedBytes(contentBase64: string): number {
  return Math.floor((contentBase64.length * 3) / 4);
}

export function validateBatchIngestionPayload(
  raw: unknown,
  opts: BatchValidationOptions,
): IngestionBatchRequestPayload {
  const parsed = ingestionBatchRequestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(`Invalid batch ingestion payload: ${formatIssues(parsed.error)}`);
  }

  if (parsed.data.source.tenantId.toLowerCase() !== opts.expectedTenantId.toLowerCase()) {
    throw new ValidationError('Invalid batch ingestion payload: source.tenantId is not the BCR tenant');
  }

  // Guard against an oversized aggregate body as well as any single document.
  const totalDecodedBytes = parsed.data.documents.reduce(
    (sum, d) => sum + approxDecodedBytes(d.contentBase64),
    0,
  );
  if (totalDecodedBytes > MAX_DECODED_BYTES) {
    throw new ValidationError(`Batch exceeds maximum size of ${MAX_DECODED_BYTES} bytes`);
  }

  // Explicitly construct the payload so that optional zod fields become
  // present-but-undefined, satisfying `exactOptionalPropertyTypes`.
  const { documents, source } = parsed.data;
  return {
    documents: documents.map((d) => ({
      filename: d.filename,
      contentType: d.contentType,
      contentBase64: d.contentBase64,
    })),
    source: {
      tenantId: source.tenantId,
      channelId: source.channelId,
      conversationId: source.conversationId,
      activityId: source.activityId,
      conversationType: source.conversationType,
      teamsChannelId: source.teamsChannelId,
      userAadObjectId: source.userAadObjectId.toLowerCase(),
      userDisplayName: source.userDisplayName,
    },
  };
}
