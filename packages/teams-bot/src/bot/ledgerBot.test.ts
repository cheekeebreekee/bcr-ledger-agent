import {
  type Activity,
  type Attachment,
  type ConversationAccount,
  TeamsInfo,
  TestAdapter,
} from 'botbuilder';
import {
  CLIENT_ACCOUNT_REQUIRED,
  type IngestionBatchItemResult,
  type IngestionBatchRequestPayload,
  type IngestionBatchResponsePayload,
  type SearchRequestPayload,
  type SearchResponsePayload,
} from '@bcr/shared';
import { filterFileAttachments, LedgerBot, type LedgerBotDeps } from './ledgerBot';
import {
  GATE_REFUSAL_TEXT,
  QUARANTINED_TEXT,
  rejectionText,
  SEARCH_FILTER_INVALID_TEXT,
  SEARCH_HELP_HEADING,
  SEARCH_NO_ACCESS_TEXT,
  SEARCH_NOT_UNDERSTOOD_TEXT,
  SEARCH_TOO_LONG_TEXT,
  SEARCH_UNAVAILABLE_TEXT,
  searchFloodText,
  searchRateLimitedText,
} from './cardText';
import { GateMiddleware } from './gateMiddleware';
import { buildHelpCard } from './responseBuilder';
import { buildUnavailableCard } from './searchCard';
import { SEARCH_FORM_INPUTS } from './searchText';
import { SEARCH_FLOOD_LIMIT, UserLimiter } from '../services/userLimiter';

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

  it('ingestion answers ClientAccountRequired: the card shows the Polish text, no link, folder or category', async () => {
    const f = fakes((payload) =>
      payload.documents.map((d) => ({
        filename: d.filename,
        status: 'rejected' as const,
        error: { code: CLIENT_ACCOUNT_REQUIRED, message: 'This account may not file documents' },
      })),
    );
    const sent = await run(f.deps, message([teamsFile('a.pdf'), teamsFile('b.pdf')]));

    const { rows, json } = resultCard(sent);
    const text = rejectionText(CLIENT_ACCOUNT_REQUIRED);
    expect(text).toContain('(login: NIP@bcr-group.pl)');
    expect(rows).toEqual([
      ['⚠️ a.pdf', text, '—'],
      ['⚠️ b.pdf', text, '—'],
    ]);
    expect(json).not.toMatch(/may not file|Action\.OpenUrl|Faktur/);
  });

  // Owner's decision (28 Sep 2026): ingestion alone refuses guests. The bot
  // asks Teams for no member or role before it downloads.
  it('makes no role lookup before downloading: every admitted upload goes to ingestion, which decides', async () => {
    const lookups = [
      jest.spyOn(TeamsInfo, 'getMember'),
      jest.spyOn(TeamsInfo, 'getMembers'),
      jest.spyOn(TeamsInfo, 'getPagedMembers'),
    ];
    try {
      const f = fakes((payload) =>
        payload.documents.map((d) => ({
          filename: d.filename,
          status: 'rejected' as const,
          error: { code: CLIENT_ACCOUNT_REQUIRED, message: 'refused' },
        })),
      );
      const sent = await run(f.deps, message([teamsFile('a.pdf'), teamsFile('b.pdf')]));

      for (const lookup of lookups) expect(lookup).not.toHaveBeenCalled();
      expect(f.download).toHaveBeenCalledTimes(2);
      expect(f.ingestBatch).toHaveBeenCalledTimes(1);
      expect(f.ingestBatch.mock.calls[0]?.[0].source.userAadObjectId).toBe(USER_OID);
      expect(sent.map((a) => a.type)).toEqual(['typing', 'message']);
      expect(resultCard(sent).rows.map((r) => r[1])).toEqual([
        rejectionText(CLIENT_ACCOUNT_REQUIRED),
        rejectionText(CLIENT_ACCOUNT_REQUIRED),
      ]);
    } finally {
      for (const lookup of lookups) lookup.mockRestore();
    }
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

describe('LedgerBot search', () => {
  const NOW = new Date('2026-09-28T10:00:00Z'); // 12:00 in Warsaw
  const TODAYS_HELP = JSON.stringify(buildHelpCard());

  const okAnswer: SearchResponsePayload = {
    status: 'ok',
    scopeLabel: 'Firma Testowa',
    filter: { categories: ['faktury_zakupu'] },
    total: 1,
    totalCapped: false,
    items: [
      {
        documentId: 'doc-1',
        status: 'filed',
        category: 'faktury_zakupu',
        documentMonth: '2026-03',
        invoiceNumber: 'FV/1/2026',
        issueDate: '2026-03-02',
        grossAmount: '123.45',
        currency: 'PLN',
        counterpartyName: 'Dostawca',
        counterpartyNip: '1234563218',
        webUrl: 'https://bcr.sharepoint.test/sites/Klient/a.pdf',
      },
    ],
    nextCursor: null,
    notes: [],
  };

  interface SearchFakes {
    readonly deps: LedgerBotDeps;
    readonly search: jest.Mock<Promise<SearchResponsePayload>, [SearchRequestPayload]>;
    readonly take: jest.Mock;
    readonly ingestBatch: jest.Mock;
    readonly download: jest.Mock;
  }

  function searchFakes(
    answer: SearchResponsePayload | Error = okAnswer,
    limiter: Pick<UserLimiter, 'take'> = { take: () => ({ ok: true }) },
  ): SearchFakes {
    const base = fakes(() => [uploadedResult('a.pdf')]);
    const search = jest.fn(async (_payload: SearchRequestPayload) => {
      if (answer instanceof Error) throw answer;
      return answer;
    });
    const take = jest.fn((key: string) => limiter.take(key));
    return {
      deps: {
        ...base.deps,
        search: { client: { search }, limiter: { take }, tenantId: BCR_TENANT, now: () => NOW },
      },
      search,
      take,
      ingestBatch: base.ingestBatch,
      download: base.download,
    };
  }

  const text = (t: string, overrides: Partial<Activity> = {}) =>
    message([], { text: t, ...overrides });
  const submit = (value: unknown) => message([], { value });
  const cardJson = (a: Partial<Activity> | undefined) =>
    JSON.stringify(a?.attachments?.[0]?.content);

  it('sends the question with the sender’s AAD object id, and nothing that names a client', async () => {
    const f = searchFakes();
    const sent = await run(f.deps, text('faktury zakupu z marca'));

    expect(f.search).toHaveBeenCalledTimes(1);
    const payload = f.search.mock.calls[0]?.[0];
    expect(payload).toEqual({
      source: {
        tenantId: BCR_TENANT,
        conversationId: 'conv-personal',
        activityId: 'activity-1',
        conversationType: 'personal',
        userAadObjectId: USER_OID,
      },
      query: { kind: 'question', text: 'faktury zakupu z marca' },
    });
    expect(JSON.stringify(payload)).not.toMatch(/client|listItem|scope|limit|Anna|DisplayName/i);
    expect(f.take).toHaveBeenCalledWith(USER_OID);

    expect(sent.map((a) => a.type)).toEqual(['typing', 'message']);
    expect(cardJson(sent[1])).toContain('Wyniki wyszukiwania');
    expect(f.download).not.toHaveBeenCalled();
    expect(f.ingestBatch).not.toHaveBeenCalled();
  });

  it('normalises the question before sending it', async () => {
    const f = searchFakes();
    const zwsp = String.fromCodePoint(0x200b);
    await run(f.deps, text(`<at>Asystent BCR</at>  faktury${zwsp}   <b>zakupu</b>\n`));
    expect(f.search.mock.calls[0]?.[0].query).toEqual({ kind: 'question', text: 'faktury zakupu' });
  });

  it('refuses a question over 300 characters without a call, and takes one of exactly 300', async () => {
    const f = searchFakes();
    const sent = await run(f.deps, text('a'.repeat(301)));
    expect(sent.map((a) => a.text)).toEqual([SEARCH_TOO_LONG_TEXT]);
    expect(f.search).not.toHaveBeenCalled();
    expect(f.take).not.toHaveBeenCalled();

    await run(f.deps, text('a'.repeat(300)));
    expect(f.search).toHaveBeenCalledTimes(1);
  });

  it.each(['pomoc', 'Help', '?', 'menu', ''])(
    'answers %p with the help card and its search section, without a call',
    async (t) => {
      const f = searchFakes();
      const sent = await run(f.deps, text(t));
      expect(f.search).not.toHaveBeenCalled();
      expect(f.take).not.toHaveBeenCalled();
      expect(sent).toHaveLength(1);
      expect(cardJson(sent[0])).toBe(JSON.stringify(buildHelpCard({ search: true })));
      expect(cardJson(sent[0])).toContain(SEARCH_HELP_HEADING);
    },
  );

  it('with search off answers text and card submits with today’s help card, byte for byte', async () => {
    const f = fakes(() => []);
    for (const activity of [
      text('faktury zakupu z marca'),
      submit({ v: 1, action: 'bcr.search.page', filter: {}, after: 'c' }),
    ]) {
      const sent = await run(f.deps, activity);
      expect(sent).toHaveLength(1);
      expect(cardJson(sent[0])).toBe(TODAYS_HELP);
    }
  });

  it('greets a new member with the search section only when search is on', async () => {
    const added = {
      ...message([]),
      type: 'conversationUpdate',
      recipient: { id: 'bot', name: 'Asystent BCR' },
      membersAdded: [{ id: 'user-1', name: 'Anna Kowalska' }],
    };
    const on = await run(searchFakes().deps, added);
    const off = await run(fakes(() => []).deps, added);
    expect(cardJson(on[0])).toContain(SEARCH_HELP_HEADING);
    expect(cardJson(off[0])).toBe(TODAYS_HELP);
  });

  it('keeps uploads on today’s path with search on', async () => {
    const f = searchFakes();
    const sent = await run(f.deps, message([teamsFile('a.pdf')], { text: 'faktura' }));
    expect(f.ingestBatch).toHaveBeenCalledTimes(1);
    expect(f.search).not.toHaveBeenCalled();
    expect(resultCard(sent).rows[0]?.[0]).toBe('✅ a.pdf');
  });

  it('forwards only the filter and the cursor of a page button', async () => {
    const f = searchFakes({ ...okAnswer, total: 11, nextCursor: null });
    const filter = { categories: ['faktury_sprzedazy'], monthFrom: '2026-01' };
    const sent = await run(
      f.deps,
      submit({
        v: 1,
        action: 'bcr.search.page',
        filter,
        after: 'cursor-2',
        start: 11,
        clientId: '55555555-5555-4555-8555-555555555555',
        listItemId: 2,
        scope: 'other-client',
        limit: 1000,
      }),
    );
    const payload = f.search.mock.calls[0]?.[0];
    expect(payload?.query).toEqual({ kind: 'typed', filter, after: 'cursor-2' });
    expect(payload?.source.userAadObjectId).toBe(USER_OID);
    expect(JSON.stringify(payload)).not.toMatch(/55555555|listItem|other-client|limit|start/);
    expect(cardJson(sent[1])).toContain('pokazuję dokument nr 11');
  });

  it('forwards only the filter of a submitted form: no cursor, nothing else', async () => {
    const f = searchFakes();
    await run(
      f.deps,
      submit({
        v: 1,
        action: 'bcr.search.filter',
        [SEARCH_FORM_INPUTS.monthFrom]: '2026-01',
        [SEARCH_FORM_INPUTS.grossMin]: '100',
        [SEARCH_FORM_INPUTS.status]: 'all',
        after: 'smuggled-cursor',
        clientId: '55555555-5555-4555-8555-555555555555',
      }),
    );
    expect(f.search.mock.calls[0]?.[0].query).toEqual({
      kind: 'typed',
      filter: { monthFrom: '2026-01', grossMin: '100.00' },
    });
  });

  it('answers an unusable form or page button with the fixed text, without a call', async () => {
    const f = searchFakes();
    for (const value of [
      { v: 1, action: 'bcr.search.filter', [SEARCH_FORM_INPUTS.monthFrom]: 'marzec' },
      { v: 1, action: 'bcr.search.page', filter: { clientId: 'x' }, after: 'c' },
    ]) {
      const sent = await run(f.deps, submit(value));
      expect(sent.map((a) => a.text)).toEqual([SEARCH_FILTER_INVALID_TEXT]);
    }
    expect(f.search).not.toHaveBeenCalled();
  });

  it('stops a flood per user before any call and says when to try again', async () => {
    const f = searchFakes(okAnswer, { take: () => ({ ok: false, retryAfterMs: 30_000 }) });
    const sent = await run(f.deps, text('faktury'));
    expect(f.search).not.toHaveBeenCalled();
    expect(sent.map((a) => a.text)).toEqual([searchFloodText('12:01')]);
  });

  it('lets 20 searches a minute through per user and refuses the 21st', async () => {
    const limiter = new UserLimiter({ ...SEARCH_FLOOD_LIMIT, now: () => NOW.getTime() });
    const f = searchFakes(okAnswer, limiter);
    const bot = new LedgerBot(f.deps);
    const adapter = new TestAdapter(async (context) => bot.run(context));
    for (let i = 0; i < 21; i += 1) await adapter.processActivity(text(`faktury ${i}`));
    expect(f.search).toHaveBeenCalledTimes(20);
  });

  it.each<[string, SearchResponsePayload | Error, string]>([
    ['no_access', { status: 'no_access' }, SEARCH_NO_ACCESS_TEXT],
    ['not_understood', { status: 'not_understood', reason: 'unclear' }, SEARCH_NOT_UNDERSTOOD_TEXT],
    [
      'rate_limited',
      { status: 'rate_limited', retryAfterSeconds: 240 },
      searchRateLimitedText('12:04'),
    ],
  ])('answers %s with its one fixed text', async (_label, answer, expected) => {
    const f = searchFakes(answer);
    const sent = await run(f.deps, text('faktury'));
    expect(sent.map((a) => a.type)).toEqual(['typing', 'message']);
    expect(sent[1]?.text).toBe(expected);
    expect(sent[1]?.attachments ?? []).toEqual([]);
  });

  it.each<[string, SearchResponsePayload | Error]>([
    ['unavailable', { status: 'unavailable' }],
    ['a client that threw', new Error('boom /api/search')],
  ])('answers a question %s with its fixed text and a „Zmień filtr” form', async (_l, answer) => {
    const sent = await run(searchFakes(answer).deps, text('faktury'));
    expect(sent.map((a) => a.type)).toEqual(['typing', 'message']);
    expect(cardJson(sent[1])).toBe(JSON.stringify(buildUnavailableCard()));
  });

  it('answers the form (typed) unavailable with the text: its card is already there', async () => {
    const f = searchFakes({ status: 'unavailable' });
    const sent = await run(f.deps, submit({ v: 1, action: 'bcr.search.filter' }));
    expect(f.search).toHaveBeenCalledTimes(1);
    expect(sent[1]?.text).toBe(SEARCH_UNAVAILABLE_TEXT);
    expect(sent[1]?.attachments ?? []).toEqual([]);
  });

  it('still logs attachments the filter dropped before searching, and not a plain text message', async () => {
    const f = searchFakes();
    const bot = new LedgerBot(f.deps);
    const info = jest.spyOn((bot as unknown as { log: { info: () => void } }).log, 'info');
    const adapter = new TestAdapter(async (context) => bot.run(context));
    const dropped: Attachment = { contentType: 'application/vnd.microsoft.card.hero', content: {} };
    await adapter.processActivity(message([dropped], { text: 'proszę zarchiwizować' }));
    const html: Attachment = { contentType: 'text/html', content: '<p>faktury</p>' };
    await adapter.processActivity(message([html], { text: 'faktury' }));
    const lines = info.mock.calls.filter(([, msg]) =>
      String(msg).startsWith('no file attachments'),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]?.[0]).toMatchObject({
      rawAttachmentCount: 1,
      rawAttachmentContentTypes: ['application/vnd.microsoft.card.hero'],
    });
    expect(f.search).toHaveBeenCalledTimes(2);
  });

  it('answers disabled with today’s help card and help with the search section', async () => {
    const disabled = await run(searchFakes({ status: 'disabled' }).deps, text('faktury'));
    expect(cardJson(disabled[1])).toBe(TODAYS_HELP);
    const help = await run(searchFakes({ status: 'help' }).deps, text('dzień dobry'));
    expect(cardJson(help[1])).toBe(JSON.stringify(buildHelpCard({ search: true })));
  });

  describe('behind the gate', () => {
    const groupChat: Partial<Activity> = {
      conversation: { id: 'g', name: '', isGroup: true, conversationType: 'groupChat' },
    };

    it('in enforce mode, a group chat reaches no search and gets no answer', async () => {
      const f = searchFakes();
      const gate = new GateMiddleware({
        tenantId: BCR_TENANT,
        mode: 'enforce',
        logger: { warn: jest.fn() },
      });
      const sent = await run(f.deps, text('faktury', groupChat), gate);
      expect(f.search).not.toHaveBeenCalled();
      expect(sent).toEqual([]);
    });

    it.each<[string, Partial<Activity>]>([
      ['a group chat', groupChat],
      ['a foreign tenant', { channelData: { tenant: { id: FOREIGN_TENANT } } }],
      ['a sender without an AAD object id', { from: { id: 'user-1', name: 'Anna' } }],
      ['a conversation without an id', { conversation: { ...personalConversation(), id: '' } }],
    ])(
      'in log mode, %s is never searched for and gets today’s help card',
      async (_label, overrides) => {
        const f = searchFakes();
        const gate = new GateMiddleware({
          tenantId: BCR_TENANT,
          mode: 'log',
          logger: { warn: jest.fn() },
        });
        const sent = await run(f.deps, text('faktury', overrides), gate);
        expect(f.search).not.toHaveBeenCalled();
        expect(f.take).not.toHaveBeenCalled();
        expect(sent).toHaveLength(1);
        expect(cardJson(sent[0])).toBe(TODAYS_HELP);
      },
    );
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
