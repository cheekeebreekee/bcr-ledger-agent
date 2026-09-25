import { ConfidentialClientApplication } from '@azure/msal-node';
import { request } from 'undici';
import {
  createLogger,
  type IngestionBatchRequestPayload,
  type IngestionBatchResponsePayload,
  type IngestionRequestPayload,
  type IngestionResponsePayload,
  type UserTargetResponsePayload,
} from '@bcr/shared';

export interface IngestionClientOptions {
  readonly baseUrl: string;
  readonly scope: string;
  readonly tenantId: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /** Optional override for tests. */
  readonly fetcher?: typeof request;
}

/**
 * Thin HTTP client for the document-ingestion Function App.
 *
 * Acquires an AAD token via MSAL **client-credentials** and caches it; MSAL
 * handles renewal so we just call `acquireTokenByClientCredential` on every
 * request and let the SDK return the cached token until it expires.
 */
export class IngestionClient {
  private readonly log = createLogger('bot/ingestionClient');
  private readonly msal: ConfidentialClientApplication;
  private readonly fetcher: typeof request;

  constructor(private readonly opts: IngestionClientOptions) {
    this.msal = new ConfidentialClientApplication({
      auth: {
        clientId: opts.clientId,
        clientSecret: opts.clientSecret,
        authority: `https://login.microsoftonline.com/${opts.tenantId}`,
      },
    });
    this.fetcher = opts.fetcher ?? request;
  }

  async ingest(payload: IngestionRequestPayload): Promise<IngestionResponsePayload> {
    this.log.debug({ filename: payload.filename }, 'POST /api/ingest');
    return this.post<IngestionResponsePayload>('/api/ingest', payload);
  }

  /**
   * Classifies and files several documents from the same Teams activity in a
   * single request. Returns one consolidated table of per-document outcomes.
   */
  async ingestBatch(
    payload: IngestionBatchRequestPayload,
  ): Promise<IngestionBatchResponsePayload> {
    this.log.debug({ documentCount: payload.documents.length }, 'POST /api/ingest/batch');
    return this.post<IngestionBatchResponsePayload>('/api/ingest/batch', payload);
  }

  /**
   * Resolve which SharePoint site a given Teams user's documents live in.
   * Used by the bot's Personal Tab to deep-link the user to the right
   * document library.
   */
  async getUserTarget(userAadObjectId: string): Promise<UserTargetResponsePayload> {
    this.log.debug({ userAadObjectId }, 'GET /api/user-target');
    const qs = new URLSearchParams({ userAadObjectId }).toString();
    return this.get<UserTargetResponsePayload>(`/api/user-target?${qs}`);
  }

  private async post<T>(path: string, payload: unknown): Promise<T> {
    return this.send<T>('POST', path, payload);
  }

  private async get<T>(path: string): Promise<T> {
    return this.send<T>('GET', path);
  }

  private async send<T>(method: 'GET' | 'POST', path: string, payload?: unknown): Promise<T> {
    const token = await this.acquireToken();
    const url = new URL(path, this.opts.baseUrl).toString();

    const { statusCode, body } = await this.fetcher(url, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
    });

    const responseText = await body.text();
    let parsed: T;
    try {
      parsed = JSON.parse(responseText) as T;
    } catch {
      throw new Error(
        `Ingestion API returned non-JSON response (HTTP ${statusCode}): ${responseText.slice(0, 200)}`,
      );
    }

    if (statusCode < 200 || statusCode >= 300) {
      const errorMessage =
        (parsed as { error?: { message?: string } })?.error?.message ?? 'unknown error';
      throw new Error(`Ingestion API HTTP ${statusCode}: ${errorMessage}`);
    }
    return parsed;
  }

  private async acquireToken(): Promise<string> {
    const result = await this.msal.acquireTokenByClientCredential({
      scopes: [this.opts.scope],
    });
    if (!result?.accessToken) {
      throw new Error('MSAL returned no access token for the ingestion API');
    }
    return result.accessToken;
  }
}
