import type { PendingReviewNotice } from '@bcr/ledger-db';
import type { ClientDirectoryEntry, Logger } from '@bcr/shared';
import { buildSnapshot } from './clientDirectoryReader';
import {
  LedgerReviewNotices,
  NoticePostError,
  REVIEW_NOTICE_MAX_BYTES,
  REVIEW_NOTICE_MAX_LINK,
  ReviewNotifier,
  WorkflowsWebhook,
  escapeMarkdown,
  fitToCard,
  reviewNoticeCard,
  reviewNoticesOffReason,
  runReviewNotices,
  type ReviewNoticeSource,
} from './reviewNotifier';

const HOST = 'bcrgroup.sharepoint.com';
const NOW = Date.parse('2026-09-28T12:00:00Z');

function row(listItemId: string, title: string): ClientDirectoryEntry {
  return {
    listItemId,
    title,
    clientId: `000${listItemId}`,
    nip: '',
    companyNameAliases: [],
    userAadObjectIds: [],
    target: {
      siteHostname: HOST,
      sitePath: `/sites/Client${listItemId}`,
      driveName: 'Dokumenty',
      rootFolder: 'Dokumenty księgowe',
      expectedDriveId: `drive-${listItemId}`,
    },
    teamId: `team-${listItemId}`,
    isAdmin: false,
    active: true,
  };
}

const PESKOVOI = row('2', '[0002] PESKOVOI Sp. z o. o. - Księgowość');
const OTHER = row('3', '[0003] Inny Klient');

const doc = (n: number, over: Partial<PendingReviewNotice> = {}): PendingReviewNotice => ({
  documentId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  driveItemId: `item-${n}`,
  suggestedCategory: 'faktury_zakupu',
  reviewReasons: ['LOW_CONFIDENCE'],
  documentMonth: '2026-09',
  webUrl: `https://${HOST}/sites/Client2/Dokumenty/98/f${n}.pdf`,
  createdAt: '2026-09-28T11:00:00.000000Z',
  ...over,
});

function recordingLogger(): { log: Logger; lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  const write = (obj: unknown) => lines.push({ ...(obj as Record<string, unknown>) });
  const log = { info: write, warn: write, error: write, debug: write } as unknown as Logger;
  return { log, lines };
}

function source(pending: Record<string, PendingReviewNotice[]>) {
  const marked: Record<string, string[]> = {};
  const src = {
    pending: jest.fn(async (r: ClientDirectoryEntry) => pending[r.listItemId] ?? []),
    markNotified: jest.fn(async (r: ClientDirectoryEntry, ids: readonly string[]) => {
      marked[r.listItemId] = [...(marked[r.listItemId] ?? []), ...ids];
      return ids.length;
    }),
  } satisfies ReviewNoticeSource;
  return { src, marked };
}

function setup(
  pending: Record<string, PendingReviewNotice[]>,
  post: jest.Mock = jest.fn(async () => undefined),
  rows: ClientDirectoryEntry[] = [PESKOVOI, OTHER],
) {
  const { src, marked } = source(pending);
  const { log, lines } = recordingLogger();
  const notifier = new ReviewNotifier({
    directory: {
      getSnapshot: async () =>
        buildSnapshot(rows, NOW, { forbiddenSitePaths: [], allowedSiteHostname: HOST }),
    },
    source: src,
    poster: { post },
    log,
  });
  return { notifier, src, marked, post, lines };
}

describe('ReviewNotifier', () => {
  it('posts one card per client with documents in review, then marks exactly those', async () => {
    const { notifier, marked, post, lines } = setup({ '2': [doc(1), doc(2)], '3': [doc(3)] });

    const run = await notifier.run();

    expect(run).toEqual({ clients: 2, documents: 3, posted: true, readFailures: 0 });
    expect(post).toHaveBeenCalledTimes(2);
    expect(marked).toEqual({
      '2': [doc(1).documentId, doc(2).documentId],
      '3': [doc(3).documentId],
    });
    expect(lines.filter((l) => l['event'] === 'review_notice.posted')).toEqual([
      expect.objectContaining({ clients: 2, documents: 3 }),
    ]);
  });

  it('posts nothing when nothing waits', async () => {
    const { notifier, post, src } = setup({});
    expect(await notifier.run()).toEqual({
      clients: 0,
      documents: 0,
      posted: false,
      readFailures: 0,
    });
    expect(post).not.toHaveBeenCalled();
    expect(src.markNotified).not.toHaveBeenCalled();
  });

  // The guarantee: a notice that did not go out is retried, never lost.
  it('marks nothing when the post fails, so the next run names them again', async () => {
    const post = jest.fn(async () => {
      throw new NoticePostError(400);
    });
    const { notifier, src, lines } = setup({ '2': [doc(1)] }, post);

    expect(await notifier.run()).toMatchObject({ posted: false, documents: 0 });
    expect(src.markNotified).not.toHaveBeenCalled();
    expect(lines.filter((l) => l['event'] === 'review_notice.post_failed')).toEqual([
      expect.objectContaining({ status: 400, documents: 1, listItemId: '2' }),
    ]);
  });

  it('marks only the client whose card was accepted when another client’s post fails', async () => {
    const post = jest
      .fn()
      .mockRejectedValueOnce(new NoticePostError(502))
      .mockResolvedValueOnce(undefined);
    const { notifier, marked } = setup({ '2': [doc(1)], '3': [doc(3)] }, post);
    expect(await notifier.run()).toMatchObject({ clients: 1, documents: 1, posted: true });
    expect(marked).toEqual({ '3': [doc(3).documentId] });
  });

  // Teams refuses a message over ~28 KB after the webhook has answered 202:
  // a card too big would be marked and never shown.
  it('keeps each card under the size budget, and leaves the rest unmarked for the next run', async () => {
    const long = (n: number) =>
      doc(n, { webUrl: `https://${HOST}/sites/Client2/${'x'.repeat(900)}/f${n}.pdf` });
    const many = Array.from({ length: 20 }, (_, i) => long(i + 1));
    const post = jest.fn(async (_payload: unknown) => undefined);
    const { notifier, marked } = setup({ '2': many }, post);

    const run = await notifier.run();

    const size = Buffer.byteLength(JSON.stringify(post.mock.calls[0]![0]));
    expect(size).toBeLessThanOrEqual(REVIEW_NOTICE_MAX_BYTES);
    expect(run.documents).toBeLessThan(20);
    expect(run.documents).toBeGreaterThan(0);
    expect(marked['2']).toEqual(many.slice(0, run.documents).map((d) => d.documentId));
  });

  it('still notifies the other clients when one client cannot be read', async () => {
    const { notifier, src, post, lines } = setup({ '3': [doc(3)] });
    src.pending.mockImplementationOnce(async () => {
      throw new Error('db down');
    });

    expect(await notifier.run()).toMatchObject({
      clients: 1,
      documents: 1,
      readFailures: 1,
      posted: true,
    });
    expect(post).toHaveBeenCalledTimes(1);
    expect(lines.filter((l) => l['event'] === 'review_notice.read_failed')).toEqual([
      expect.objectContaining({ listItemId: '2', err: { name: 'Error' } }),
    ]);
  });

  it('logs a failed mark and goes on: the documents are named again rather than never', async () => {
    const { notifier, src, lines } = setup({ '2': [doc(1)], '3': [doc(3)] });
    src.markNotified.mockImplementationOnce(async () => {
      throw new Error('db down');
    });
    expect(await notifier.run()).toMatchObject({ posted: true });
    expect(src.markNotified).toHaveBeenCalledTimes(2);
    expect(lines.filter((l) => l['event'] === 'review_notice.mark_failed')).toEqual([
      expect.objectContaining({ listItemId: '2', documentIds: [doc(1).documentId] }),
    ]);
  });

  it('reads only bound client rows, never an admin or unbound one', async () => {
    const admin = { ...row('4', 'Admin'), isAdmin: true };
    const unbound = {
      ...row('5', 'Niepowiązany'),
      teamId: undefined,
    } as unknown as ClientDirectoryEntry;
    const { notifier, src } = setup({}, undefined, [PESKOVOI, admin, unbound]);
    await notifier.run();
    expect(src.pending.mock.calls.map(([r]) => r.listItemId)).toEqual(['2']);
  });

  it('never throws, and does not run twice at once', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const post = jest.fn(async () => gate);
    const { notifier } = setup({ '2': [doc(1)] }, post);
    const first = notifier.run();
    await new Promise((r) => setImmediate(r));
    expect(await notifier.run()).toMatchObject({ posted: false, documents: 0 });
    release();
    expect(await first).toMatchObject({ posted: true });

    const broken = new ReviewNotifier({
      directory: {
        getSnapshot: async () => {
          throw new Error('graph down');
        },
      },
      source: source({}).src,
      poster: { post: jest.fn() },
      log: recordingLogger().log,
    });
    expect(await broken.run()).toMatchObject({ posted: false });
  });
});

describe('reviewNoticeCard', () => {
  const card = (docs: PendingReviewNotice[], r = PESKOVOI) =>
    JSON.stringify(reviewNoticeCard([{ row: r, docs }]));

  it('is one Adaptive Card for a Workflows webhook, in Polish, with a link per document', () => {
    const payload = reviewNoticeCard([{ row: PESKOVOI, docs: [doc(1)] }]) as {
      type: string;
      attachments: { contentType: string; content: { type: string; body: { text: string }[] } }[];
    };
    expect(payload.type).toBe('message');
    expect(payload.attachments[0]!.contentType).toBe('application/vnd.microsoft.card.adaptive');
    const texts = payload.attachments[0]!.content.body.map((b) => b.text);
    expect(texts[0]).toBe('Dokumenty do weryfikacji: 1');
    expect(texts).toContain('\\[0002\\] PESKOVOI Sp. z o. o. - Księgowość (1)');
    expect(texts.at(-1)).toBe(
      `- sugestia: Faktura zakupu · niska pewność · 2026-09 · [Otwórz plik](https://${HOST}/sites/Client2/Dokumenty/98/f1.pdf)`,
    );
  });

  it('names no file, amount or NIP: only the label, reasons, month and link', () => {
    const text = card([doc(1, { webUrl: null })]);
    expect(text).not.toContain('item-1');
    expect(text).not.toContain('f1.pdf');
    expect(text).toContain('niska pewność');
  });

  it('leaves out a link too long for a card line', () => {
    const text = card([
      doc(1, { webUrl: `https://${HOST}/${'y'.repeat(REVIEW_NOTICE_MAX_LINK)}` }),
    ]);
    expect(text).not.toContain('Otwórz plik');
    expect(fitToCard(PESKOVOI, [doc(1)])).toHaveLength(1);
  });

  it('keeps a link Markdown cannot cut short, and drops one that is not https', () => {
    expect(card([doc(1, { webUrl: `https://${HOST}/a (1).pdf` })])).toContain(
      `(https://${HOST}/a%20%281%29.pdf)`,
    );
    expect(card([doc(1, { webUrl: 'javascript:alert(1)' })])).not.toContain('javascript');
  });

  it('says so when there is no suggestion or no reason, and shows an unknown code escaped', () => {
    const text = card([
      doc(1, { suggestedCategory: null, reviewReasons: ['NEW_*CODE*'], documentMonth: null }),
    ]);
    expect(text).toContain('bez sugestii');
    expect(text).toContain('NEW\\\\_\\\\*CODE\\\\*');
    expect(card([doc(1, { reviewReasons: [] })])).toContain('do sprawdzenia');
  });

  it('escapes a title that would otherwise render as a link or a list', () => {
    const tricky = row('9', '- [kliknij](https://evil.example)');
    expect(card([doc(1)], tricky)).toContain(
      '\\\\- \\\\[kliknij\\\\]\\\\(https://evil.example\\\\)',
    );
  });
});

describe('escapeMarkdown', () => {
  it('matches the bot’s card escaping', () => {
    expect(escapeMarkdown('a*b_c[d](e)\n1. x')).toBe('a\\*b\\_c\\[d\\]\\(e\\) 1. x');
    expect(escapeMarkdown('1. lista')).toBe('1\\. lista');
  });
});

describe('WorkflowsWebhook', () => {
  it('posts the payload as JSON and accepts a 2xx', async () => {
    const fetch = jest.fn(async () => new Response(null, { status: 202 }));
    await new WorkflowsWebhook('https://flow.example/hook?sig=x', { fetch: fetch as never }).post({
      a: 1,
    });
    expect(fetch).toHaveBeenCalledWith(
      'https://flow.example/hook?sig=x',
      expect.objectContaining({ method: 'POST', body: '{"a":1}' }),
    );
  });

  it('throws its status on a refusal, and unreachable when there is no answer, never the URL', async () => {
    const refused = new WorkflowsWebhook('https://flow.example/hook?sig=secret', {
      fetch: (async () => new Response(null, { status: 400 })) as never,
    });
    await expect(refused.post({})).rejects.toMatchObject({ status: 400 });
    const down = new WorkflowsWebhook('https://flow.example/hook?sig=secret', {
      fetch: (async () => {
        throw new TypeError('fetch failed');
      }) as never,
    });
    const err = await down.post({}).catch((e: unknown) => e as NoticePostError);
    expect(err).toMatchObject({ status: 'unreachable' });
    expect(String((err as Error).message)).not.toContain('secret');
  });
});

describe('LedgerReviewNotices', () => {
  it('reads and marks in the bound row’s own client scope', async () => {
    const scopes: string[] = [];
    const db = {
      withClientTx: jest.fn(async (clientId: string, fn: (tx: never) => Promise<unknown>) => {
        scopes.push(clientId);
        return fn({ query: async () => [] } as never);
      }),
    };
    const notices = new LedgerReviewNotices({
      db: db as never,
      directoryListId: 'c0ffee00-1234-4abc-9def-00112233aabb',
    });
    await notices.pending(PESKOVOI, 5).catch(() => undefined);
    await notices.markNotified(PESKOVOI, []).catch(() => undefined);
    expect(new Set(scopes).size).toBe(1);
    expect(scopes[0]).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('review notices off', () => {
  const RESOLVED =
    'https://prod-00.westeurope.logic.azure.com/workflows/x/triggers/manual/paths/invoke?sig=s';

  it.each([
    [false, RESOLVED, 'index_off'],
    [false, '', 'index_off'],
    [true, '', 'no_webhook'],
    [
      true,
      '@Microsoft.KeyVault(SecretUri=https://kv.vault.azure.net/secrets/review-webhook-url)',
      'webhook_unresolved',
    ],
    [true, 'http://example.test/hook', 'webhook_unresolved'],
    [true, RESOLVED, undefined],
  ] as const)('index writes %s, webhook %s: %s', (indexWrites, webhookUrl, reason) => {
    expect(reviewNoticesOffReason({ indexWrites, webhookUrl })).toBe(reason);
  });

  // The review-notices alert reads this line: a setting that stopped
  // resolving must show on every run, not only at the cold start.
  it('says a webhook that did not resolve on every run, without the URL', async () => {
    const { log, lines } = recordingLogger();
    await runReviewNotices(undefined, 'webhook_unresolved', log);
    await runReviewNotices(undefined, 'webhook_unresolved', log);
    expect(lines).toEqual([
      { event: 'review_notice.off', reason: 'webhook_unresolved' },
      { event: 'review_notice.off', reason: 'webhook_unresolved' },
    ]);
  });

  it.each(['index_off', 'no_webhook', undefined] as const)(
    'says nothing when off on purpose (%s)',
    async (reason) => {
      const { log, lines } = recordingLogger();
      await runReviewNotices(undefined, reason, log);
      expect(lines).toEqual([]);
    },
  );

  it('runs the notifier when on, and says nothing of its own', async () => {
    const { log, lines } = recordingLogger();
    const run = jest.fn(async () => ({ clients: 0, documents: 0, posted: false, readFailures: 0 }));
    await runReviewNotices({ run }, undefined, log);
    expect(run).toHaveBeenCalledWith(log);
    expect(lines).toEqual([]);
  });
});
