import { z } from 'zod';
import { ValidationError, type IngestionRequestPayload } from '@bcr/shared';

const ingestionRequestSchema = z.object({
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
  source: z.object({
    tenantId: z.string().min(1),
    channelId: z.string().min(1),
    conversationId: z.string().min(1),
    activityId: z.string().min(1),
    userAadObjectId: z.string().optional(),
    userDisplayName: z.string().optional(),
  }),
});

/** Maximum decoded payload size — 100 MiB. Anything larger should use a SAS upload. */
const MAX_DECODED_BYTES = 100 * 1024 * 1024;

export function validateIngestionPayload(raw: unknown): IngestionRequestPayload {
  const parsed = ingestionRequestSchema.safeParse(raw);
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new ValidationError(`Invalid ingestion payload: ${message}`);
  }

  // Estimate decoded size before allocating the buffer to fail fast on huge bodies.
  const approxDecodedBytes = Math.floor((parsed.data.contentBase64.length * 3) / 4);
  if (approxDecodedBytes > MAX_DECODED_BYTES) {
    throw new ValidationError(
      `Document exceeds maximum size of ${MAX_DECODED_BYTES} bytes`,
    );
  }

  // Explicitly construct the payload so that optional zod fields become
  // present-but-undefined, satisfying `exactOptionalPropertyTypes`.
  const { filename, contentType, contentBase64, source } = parsed.data;
  return {
    filename,
    contentType,
    contentBase64,
    source: {
      tenantId: source.tenantId,
      channelId: source.channelId,
      conversationId: source.conversationId,
      activityId: source.activityId,
      userAadObjectId: source.userAadObjectId,
      userDisplayName: source.userDisplayName,
    },
  };
}
