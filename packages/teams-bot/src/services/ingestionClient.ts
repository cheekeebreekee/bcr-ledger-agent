import { ConfidentialClientApplication } from '@azure/msal-node';
import { request } from 'undici';
import {
  createLogger,
  type IngestionBatchRequestPayload,
  type IngestionBatchResponsePayload,
  LedgerAgentError,
} from '@bcr/shared';

/** The subset of undici's `request` the client uses; injectable for tests. */
export type IngestionFetcher = (
  url: string,
  options: { method: 'POST'; headers: Record<string, string>; body: string },
) => Promise<{ statusCode: number; body: { text(): Promise<string> } }>;

export interface IngestionClientOptions {
  readonly baseUrl: string;
  readonly scope: string;
  readonly tenantId: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /** Optional override for tests. Defaults to undici's `request`. */
  readonly fetcher?: IngestionFetcher;
  /**
   * Optional override for tests. Defaults to MSAL client-credentials against
   * `tenantId`, which caches the token and renews it before expiry.
   */
  readonly acquireToken?: () => Promise<string>;
}

/**
 * Thin HTTP client for the document-ingestion Function App. Its only call is
 * `POST /api/ingest/batch`.
 *
 * Errors carry the HTTP status and nothing from the response body: the body
 * could echo a filename or internal detail, and error messages end up in
 * logs. The bot turns any failure into one generic Polish row per document.
 */
export class IngestionClient {
  private readonly log = createLogger('bot/ingestionClient');
  private readonly fetcher: IngestionFetcher;
  private readonly acquireToken: () => Promise<string>;

  constructor(private readonly opts: IngestionClientOptions) {
    this.fetcher = opts.fetcher ?? request;
    this.acquireToken = opts.acquireToken ?? msalClientCredentials(opts);
  }

  /**
   * Classifies and files several documents from the same Teams activity in a
   * single request. Returns one consolidated table of per-document outcomes.
   */
  async ingestBatch(payload: IngestionBatchRequestPayload): Promise<IngestionBatchResponsePayload> {
    this.log.debug({ documentCount: payload.documents.length }, 'POST /api/ingest/batch');
    const token = await this.acquireToken();
    const url = new URL('/api/ingest/batch', this.opts.baseUrl).toString();

    const { statusCode, body } = await this.fetcher(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });

    // Always drain the body so undici can reuse the connection.
    const responseText = await body.text();

    if (statusCode < 200 || statusCode >= 300) {
      this.log.warn({ statusCode }, 'ingestion API returned an error status');
      throw new LedgerAgentError('IngestionFailed', `Ingestion API HTTP ${statusCode}`, 502);
    }

    try {
      return JSON.parse(responseText) as IngestionBatchResponsePayload;
    } catch {
      throw new LedgerAgentError(
        'IngestionFailed',
        `Ingestion API returned a non-JSON response (HTTP ${statusCode})`,
        502,
      );
    }
  }
}

function msalClientCredentials(opts: IngestionClientOptions): () => Promise<string> {
  const msal = new ConfidentialClientApplication({
    auth: {
      clientId: opts.clientId,
      clientSecret: opts.clientSecret,
      authority: `https://login.microsoftonline.com/${opts.tenantId}`,
    },
  });
  return async () => {
    const result = await msal.acquireTokenByClientCredential({ scopes: [opts.scope] });
    if (!result?.accessToken) {
      throw new LedgerAgentError(
        'IngestionFailed',
        'MSAL returned no access token for the ingestion API',
        502,
      );
    }
    return result.accessToken;
  };
}
