import { Client, type AuthenticationProvider } from '@microsoft/microsoft-graph-client';
import { DefaultAzureCredential, ManagedIdentityCredential } from '@azure/identity';
import { createLogger } from '@bcr/shared';

/**
 * Builds a Microsoft Graph SDK client authenticated with the Function App's
 * managed identity. In local dev (`AZURE_USE_DEFAULT_CREDENTIAL=true`) we
 * fall back to `DefaultAzureCredential` so you can log in via `az login`.
 *
 * The Graph SDK uses our custom `AuthenticationProvider` which calls
 * `getToken` lazily on every request; the underlying credential caches
 * tokens and refreshes them before expiry.
 */
export interface GraphClientOptions {
  readonly userAssignedClientId?: string;
  readonly useDefaultCredentialInDev?: boolean;
}

export function createGraphClient(opts: GraphClientOptions = {}): Client {
  const log = createLogger('ingestion/graphClient');

  const credential =
    opts.useDefaultCredentialInDev ?? process.env['NODE_ENV'] !== 'production'
      ? new DefaultAzureCredential()
      : new ManagedIdentityCredential(
          opts.userAssignedClientId ? { clientId: opts.userAssignedClientId } : undefined,
        );

  const authProvider: AuthenticationProvider = {
    async getAccessToken() {
      const token = await credential.getToken('https://graph.microsoft.com/.default');
      if (!token?.token) {
        log.error('failed to acquire Graph access token');
        throw new Error('Unable to acquire Microsoft Graph access token');
      }
      return token.token;
    },
  };

  return Client.initWithMiddleware({
    authProvider,
    defaultVersion: 'v1.0',
  });
}
