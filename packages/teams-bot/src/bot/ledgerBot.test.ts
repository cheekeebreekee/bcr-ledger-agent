import { type Activity, type Attachment, type ConversationAccount, TestAdapter } from 'botbuilder';
import type {
  IngestionBatchItemResult,
  IngestionBatchRequestPayload,
  IngestionBatchResponsePayload,
} from '@bcr/shared';
import { filterFileAttachments, LedgerBot, type LedgerBotDeps } from './ledgerBot';
import { GATE_REFUSAL_TEXT, QUARANTINED_TEXT, rejectionText } from './cardText';
import { GateMiddleware } from './gateMiddleware';

// Placeholder GUIDs — not real tenants or users.
const BCR_TENANT = '11111111-1111-4111-8111-111111111111';
const FOREIGN_TENANT = '22222222-2222-4222-8222-222222222222';
const USER_OID = '33333333-3333-4333-8333-333333333333';

const TEAMS_FILE = 'application/vnd.microsoft.teams.file.download.info';

function teamsFile(name: string): Attachment {
  return {
    contentType: TEAMS_FILE,
    name,
    content: { downloadUrl: `https://files.example.test/${encodeURIComponent(name)}` },
  };
}

function personalConversation(tenantId?: string): ConversationAccount {
  return {
    id: 'conv-personal',
    name: '',
    isGroup: false,
    conversationType: 'personal',
    ...(tenantId ? { tenantId } : {}),
  };
}

function message(attachments: Attachment[], overrides: Partial<Activity> = {}): Partial<Activity> {
  return {
    type: 'message',
    id: 'activity-1',
    channelId: 'msteams',
    conversation: personalConversation(),
    channelData: { tenant: { id: BCR_TENANT } },
    from: { id: 'user-1', name: 'Anna Kowalska', aadObjectId: USER_OID },
    attachments,
    ...overrides,
  };
}

interface Fakes {
  readonly deps: LedgerBotDeps;
  readonly download: jest.Mock;
  readonly ingestBatch: jest.Mock<
    Promise<IngestionBatchResponsePayload>,
    [IngestionBatchRequestPayload]
  >;
}

function fakes(
  respond: (payload: IngestionBatchRequestPayload) => IngestionBatchItemResult[] | Error,
  failDownloadFor: readonly string[] = [],
): Fakes {
  const download = jest.fn(async (attachment: Attachment) => {
    if (failDownloadFor.includes(attachment.name ?? '')) {
      throw new Error(`HTTP 403 for ${attachment.name} at https://files.example.test/?sig=secret`);
    }
    return { content: Buffer.from(`bytes of ${attachment.name}`), contentType: 'application/pdf' };
  });
  const ingestBatch = jest.fn(async (payload: IngestionBatchRequestPayload) => {
    const outcome = respond(payload);
    if (outcome instanceof Error) throw outcome;
    return { status: 'completed' as const, results: outcome };
  });
  return {
    deps: { ingestionClient: { ingestBatch }, attachmentDownloader: { download } },
    download,
    ingestBatch,
  };
}

async function run(deps: LedgerBotDeps, activity: Partial<Activity>, gate?: GateMiddleware) {
  const bot = new LedgerBot(deps);
  const adapter = new TestAdapter(async (context) => bot.run(context));
  if (gate) adapter.use(gate);
  await adapter.processActivity(activity);
  return adapter.activeQueue;
}

interface CardRow {
  readonly cells: { items: { text?: string }[] }[];
}

function resultCard(sent: Partial<Activity>[]): { json: string; rows: (string | undefined)[][] } {
  const cardActivity = sent.find((a) => a.attachments?.length);
  const content = cardActivity?.attachments?.[0]?.content as {
    body: { type: string; rows?: CardRow[] }[];
  };
  const table = content.body.find((b) => b.type === 'Table');
  const rows = (table?.rows ?? []).slice(1).map((r) => r.cells.map((c) => c.items[0]?.text));
  return { json: JSON.stringify(content), rows };
}

const uploadedResult = (filename: string): IngestionBatchItemResult => ({
  filename,
  status: 'uploaded',
  result: {
    driveItemId: 'drive-item-1',
    webUrl: 'https://example.sharepoint.test/doc',
    folderPath: '01_Faktury/01_Faktury_sprzedazy/2026/09',
    finalFilename: filename,
    classification: {
      documentType: 'Faktura sprzedaży',
      categoryId: 'faktury_sprzedazy',
      confidence: 0.97,
      classifier: 'claude',
    },
  },
});

describe('LedgerBot upload flow', () => {
  it('downloads every file, sends one batch and renders uploaded, quarantined and rejected rows', async () => {
    const f = fakes(() => [
      uploadedResult('a.pdf'),
      { filename: 'b.pdf', status: 'quarantined' },
      {
        filename: 'c.pdf',
        status: 'rejected',
        error: { code: 'SharePointError', message: 'Graph 403 on /sites/OtherClientSite' },
      },
    ]);
    const sent = await run(
      f.deps,
      message([teamsFile('a.pdf'), teamsFile('b.pdf'), teamsFile('c.pdf')]),
    );

    expect(f.download).toHaveBeenCalledTimes(3);
    expect(f.ingestBatch).toHaveBeenCalledTimes(1);
    const payload = f.ingestBatch.mock.calls[0]?.[0];
    expect(payload?.documents.map((d) => d.filename)).toEqual(['a.pdf', 'b.pdf', 'c.pdf']);
    expect(payload?.documents[0]?.contentBase64).toBe(
      Buffer.from('bytes of a.pdf').toString('base64'),
    );

    expect(sent[0]?.type).toBe('typing');
    const { rows, json } = resultCard(sent);
    expect(rows).toEqual([
      ['✅ a.pdf', 'Faktura sprzedaży', '01\\_Faktury/01\\_Faktury\\_sprzedazy/2026/09'],
      ['📨 b.pdf', QUARANTINED_TEXT, '—'],
      ['⚠️ c.pdf', rejectionText('SharePointError'), '—'],
    ]);
    expect(json).not.toContain('OtherClientSite');
  });

  it('sends the identity and conversation type ingestion needs to re-check the source', async () => {
    const f = fakes(() => [uploadedResult('a.pdf')]);
    await run(f.deps, message([teamsFile('a.pdf')]));
    expect(f.ingestBatch.mock.calls[0]?.[0].source).toEqual({
      tenantId: BCR_TENANT,
      channelId: 'msteams',
      conversationId: 'conv-personal',
      activityId: 'activity-1',
      conversationType: 'personal',
      teamsChannelId: undefined,
      userAadObjectId: USER_OID,
      userDisplayName: 'Anna Kowalska',
    });
  });

  it('takes the tenant from conversation.tenantId when channelData has none', async () => {
    const f = fakes(() => [uploadedResult('a.pdf')]);
    await run(
      f.deps,
      message([teamsFile('a.pdf')], {
        channelData: {},
        conversation: personalConversation(BCR_TENANT),
      }),
    );
    expect(f.ingestBatch.mock.calls[0]?.[0].source.tenantId).toBe(BCR_TENANT);
  });

  it('turns a download failure into a generic rejected row and still ingests the rest', async () => {
    const f = fakes(() => [uploadedResult('ok.pdf')], ['bad.pdf']);
    const sent = await run(f.deps, message([teamsFile('bad.pdf'), teamsFile('ok.pdf')]));

    expect(f.ingestBatch.mock.calls[0]?.[0].documents.map((d) => d.filename)).toEqual(['ok.pdf']);
    const { rows, json } = resultCard(sent);
    expect(rows[0]).toEqual(['⚠️ bad.pdf', rejectionText('DownloadFailed'), '—']);
    expect(rows[1]?.[0]).toBe('✅ ok.pdf');
    expect(json).not.toMatch(/403|sig=|files\.example\.test/);
  });

  it('does not call ingestion when every download fails', async () => {
    const f = fakes(() => [], ['x.pdf']);
    const sent = await run(f.deps, message([teamsFile('x.pdf')]));
    expect(f.ingestBatch).not.toHaveBeenCalled();
    expect(resultCard(sent).rows).toEqual([['⚠️ x.pdf', rejectionText('DownloadFailed'), '—']]);
  });

  it('answers a failed ingestion call with generic Polish rows and no error text', async () => {
    const f = fakes(() => new Error('Ingestion API HTTP 500: stack at /home/site/wwwroot'));
    const sent = await run(f.deps, message([teamsFile('a.pdf'), teamsFile('b.pdf')]));

    const { rows, json } = resultCard(sent);
    expect(rows).toEqual([
      ['⚠️ a.pdf', rejectionText('IngestionFailed'), '—'],
      ['⚠️ b.pdf', rejectionText('IngestionFailed'), '—'],
    ]);
    expect(json).not.toMatch(/HTTP 500|wwwroot/);
  });

  it('escapes a hostile filename in the result card', async () => {
    const evil = '[x](https://evil).pdf';
    const f = fakes(() => [{ filename: evil, status: 'quarantined' }]);
    const sent = await run(f.deps, message([teamsFile(evil)]));
    const { rows, json } = resultCard(sent);
    expect(rows[0]?.[0]).toBe('📨 \\[x\\]\\(https://evil\\).pdf');
    expect(json).not.toContain('[x](https://evil)');
  });

  it('names a nameless attachment attachment.bin', async () => {
    const f = fakes(() => [{ filename: 'attachment.bin', status: 'quarantined' }]);
    await run(
      f.deps,
      message([{ contentType: 'application/pdf', contentUrl: 'https://x.test/a' }]),
    );
    expect(f.ingestBatch.mock.calls[0]?.[0].documents[0]?.filename).toBe('attachment.bin');
  });
});

describe('LedgerBot help', () => {
  it('answers a message without files with the help card and uploads nothing', async () => {
    const f = fakes(() => []);
    const sent = await run(
      f.deps,
      message([{ contentType: 'text/html', content: '<at>Asystent</at>' }], { text: 'pomoc' }),
    );
    expect(f.download).not.toHaveBeenCalled();
    expect(f.ingestBatch).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent[0]?.attachments?.[0]?.content)).toContain('Asystent Archiwizacji');
  });

  it('answers a message with no attachments array at all', async () => {
    const f = fakes(() => []);
    const withoutAttachments = message([], { text: 'hej' });
    delete withoutAttachments.attachments;
    const sent = await run(f.deps, withoutAttachments);
    expect(sent).toHaveLength(1);
  });

  it('greets a new member with the help card, but not the bot itself', async () => {
    const f = fakes(() => []);
    const sent = await run(f.deps, {
      ...message([]),
      type: 'conversationUpdate',
      recipient: { id: 'bot', name: 'Asystent BCR' },
      membersAdded: [
        { id: 'bot', name: 'Asystent BCR' },
        { id: 'user-1', name: 'Anna Kowalska' },
      ],
    });
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent[0]?.attachments?.[0]?.content)).toContain('Asystent Archiwizacji');
  });
});

describe('LedgerBot behind the enforce-mode gate', () => {
  const gate = () =>
    new GateMiddleware({ tenantId: BCR_TENANT, mode: 'enforce', logger: { warn: jest.fn() } });

  it.each<[string, Partial<Activity>]>([
    [
      'a group-chat message',
      {
        conversation: { id: 'g', name: '', isGroup: true, conversationType: 'groupChat' },
      },
    ],
    [
      'a channel message',
      {
        conversation: { id: 'c', name: '', isGroup: true, conversationType: 'channel' },
        channelData: { tenant: { id: BCR_TENANT }, channel: { id: '19:x@thread.tacv2' } },
      },
    ],
    ['a foreign-tenant message', { channelData: { tenant: { id: FOREIGN_TENANT } } }],
    ['a message without an AAD object id', { from: { id: 'user-1', name: 'Anna' } }],
  ])('%s produces no download and no ingestion call', async (_label, overrides) => {
    const f = fakes(() => [uploadedResult('a.pdf')]);
    const sent = await run(f.deps, message([teamsFile('a.pdf')], overrides), gate());

    expect(f.download).not.toHaveBeenCalled();
    expect(f.ingestBatch).not.toHaveBeenCalled();
    const personal =
      (overrides.conversation ?? personalConversation()).conversationType === 'personal';
    expect(sent.map((a) => a.text)).toEqual(personal ? [GATE_REFUSAL_TEXT] : []);
  });

  it('lets a well-formed 1:1 upload through', async () => {
    const f = fakes(() => [uploadedResult('a.pdf')]);
    await run(f.deps, message([teamsFile('a.pdf')]), gate());
    expect(f.ingestBatch).toHaveBeenCalledTimes(1);
  });
});

describe('filterFileAttachments', () => {
  it('keeps Teams file download info attachments', () => {
    expect(filterFileAttachments([teamsFile('Invoice_03_2026.pdf')])).toHaveLength(1);
  });

  it('keeps bot-framework attachments with a contentUrl', () => {
    const attachments: Attachment[] = [
      {
        contentType: 'application/pdf',
        name: 'Receipt_2026-03-15.pdf',
        contentUrl: 'https://smba.example.test/attachments/1',
      },
    ];
    expect(filterFileAttachments(attachments)).toHaveLength(1);
  });

  it('drops adaptive-card replies', () => {
    const attachments: Attachment[] = [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: { type: 'AdaptiveCard' },
      },
    ];
    expect(filterFileAttachments(attachments)).toHaveLength(0);
  });

  it('drops attachments with neither contentUrl nor Teams payload', () => {
    expect(filterFileAttachments([{ contentType: 'text/plain', name: 'mention' }])).toHaveLength(0);
  });

  it('drops attachments without a content type', () => {
    expect(filterFileAttachments([{ contentUrl: 'https://x.test/a' } as Attachment])).toHaveLength(
      0,
    );
  });

  it('returns an empty array for an empty input', () => {
    expect(filterFileAttachments([])).toEqual([]);
  });
});
