import { ConfidentialClientApplication } from '@azure/msal-node';
import { request } from 'undici';
import { createLogger, type IngestionRequestPayload, type IngestionResponsePayload } from '@bcr/shared';

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
    const token = await this.acquireToken();

    const url = new URL('/api/ingest', this.opts.baseUrl).toString();
    this.log.debug({ url, filename: payload.filename }, 'POST /api/ingest');

    const { statusCode, body } = await this.fetcher(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });

    const responseText = await body.text();
    let parsed: IngestionResponsePayload;
    try {
      parsed = JSON.parse(responseText) as IngestionResponsePayload;
    } catch {
      throw new Error(`Ingestion API returned non-JSON response (HTTP ${statusCode}): ${responseText.slice(0, 200)}`);
    }

    if (statusCode < 200 || statusCode >= 300) {
      throw new Error(
        `Ingestion API HTTP ${statusCode}: ${parsed.error?.message ?? 'unknown error'}`,
      );
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
