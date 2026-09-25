import { type IngestionBatchRequestPayload, LedgerAgentError } from '@bcr/shared';
import {
  IngestionClient,
  type IngestionClientOptions,
  type IngestionFetcher,
} from './ingestionClient';

const payload: IngestionBatchRequestPayload = {
  documents: [{ filename: 'a.pdf', contentType: 'application/pdf', contentBase64: 'AAAA' }],
  source: {
    tenantId: '11111111-1111-4111-8111-111111111111',
    channelId: 'msteams',
    conversationId: 'conv-1',
    activityId: 'act-1',
    conversationType: 'personal',
    teamsChannelId: undefined,
    userAadObjectId: '33333333-3333-4333-8333-333333333333',
    userDisplayName: undefined,
  },
};

const baseOptions: IngestionClientOptions = {
  baseUrl: 'https://ingestion.example.test',
  scope: 'api://placeholder/.default',
  tenantId: '11111111-1111-4111-8111-111111111111',
  clientId: '44444444-4444-4444-8444-444444444444',
  clientSecret: 'placeholder-secret',
};

function respondWith(statusCode: number, text: string) {
  return jest.fn<ReturnType<IngestionFetcher>, Parameters<IngestionFetcher>>(async () => ({
    statusCode,
    body: { text: async () => text },
  }));
}

function client(fetcher: IngestionFetcher, acquireToken = async () => 'test-token') {
  return new IngestionClient({ ...baseOptions, fetcher, acquireToken });
}

describe('IngestionClient.ingestBatch', () => {
  it('POSTs the batch as JSON with the bearer token and returns the parsed response', async () => {
    const response = {
      status: 'completed',
      results: [{ filename: 'a.pdf', status: 'quarantined' }],
    };
    const fetcher = respondWith(200, JSON.stringify(response));

    await expect(client(fetcher).ingestBatch(payload)).resolves.toEqual(response);

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe('https://ingestion.example.test/api/ingest/batch');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual({
      'content-type': 'application/json',
      authorization: 'Bearer test-token',
    });
    expect(JSON.parse(init?.body ?? '')).toEqual(payload);
  });

  it.each([400, 401, 403, 500, 502])(
    'throws IngestionFailed with the status only on HTTP %i — no response-body fragment',
    async (status) => {
      const body = JSON.stringify({
        error: { code: 'ValidationError', message: 'secret-client-name.pdf is bad' },
      });
      const err = await client(respondWith(status, body))
        .ingestBatch(payload)
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(LedgerAgentError);
      expect((err as LedgerAgentError).code).toBe('IngestionFailed');
      expect((err as LedgerAgentError).message).toBe(`Ingestion API HTTP ${status}`);
      expect((err as LedgerAgentError).message).not.toContain('secret');
    },
  );

  it('throws on a non-JSON success response without echoing the body', async () => {
    const err = await client(respondWith(200, '<html>proxy page for secret-host</html>'))
      .ingestBatch(payload)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(LedgerAgentError);
    expect((err as Error).message).toBe('Ingestion API returned a non-JSON response (HTTP 200)');
  });

  it('does not call the API when no token can be acquired', async () => {
    const fetcher = respondWith(200, '{}');
    const failingToken = async (): Promise<string> => {
      throw new Error('token endpoint unreachable');
    };
    await expect(client(fetcher, failingToken).ingestBatch(payload)).rejects.toThrow(
      'token endpoint unreachable',
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('can be constructed with the default MSAL token provider and undici fetcher', () => {
    expect(() => new IngestionClient(baseOptions)).not.toThrow();
  });
});
