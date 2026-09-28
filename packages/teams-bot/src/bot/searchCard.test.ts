import {
  categoryCatalog,
  type ClientSearchFilter,
  SEARCH_PAGE_SIZE,
  type SearchNote,
  type SearchResponsePayload,
  type SearchResultItem,
} from '@bcr/shared';
import {
  buildSearchResultCard,
  describeFilter,
  formatAmountPl,
  formatIssueDate,
  formatMonth,
  MAX_LINK_CHARS,
  retryClock,
  searchReply,
} from './searchCard';
import {
  MONTHS_GENITIVE,
  MONTHS_NOMINATIVE,
  polishPlural,
  SEARCH_COVERAGE_TEXT,
  SEARCH_EMPTY_TEXT,
  SEARCH_LINK_UNAVAILABLE_TEXT,
  SEARCH_NO_ACCESS_TEXT,
  SEARCH_NOT_UNDERSTOOD_TEXT,
  SEARCH_NOTE_TEXT,
  SEARCH_UNAVAILABLE_QUESTION_TEXT,
  SEARCH_UNAVAILABLE_TEXT,
  SEARCH_UNSUPPORTED_TEXT,
  searchFoundText,
  searchRateLimitedText,
} from './cardText';
import { parseSearchAction, SEARCH_FORM_INPUTS } from './searchText';

type OkAnswer = Extract<SearchResponsePayload, { status: 'ok' }>;

const NBSP = String.fromCodePoint(0xa0);
const RLO = String.fromCodePoint(0x202e);
const EVIL_LINK = '[x](https://evil)';
// A valid NIP (checksum) — synthetic, not a real company.
const NIP = '1234563218';
const NOW = new Date('2026-09-28T10:00:00Z'); // 12:00 in Warsaw (CEST)

function item(overrides: Partial<SearchResultItem> = {}): SearchResultItem {
  return {
    documentId: 'doc-1',
    status: 'filed',
    category: 'faktury_zakupu',
    documentMonth: '2026-09',
    invoiceNumber: 'FV/12/2026',
    issueDate: '2026-09-15',
    grossAmount: '12345.5',
    currency: 'PLN',
    counterpartyName: 'Dostawca Testowy Sp. z o.o.',
    counterpartyNip: NIP,
    webUrl: 'https://bcr.sharepoint.test/sites/Klient/Dokumenty/faktura.pdf',
    ...overrides,
  };
}

function ok(overrides: Partial<OkAnswer> = {}): OkAnswer {
  return {
    status: 'ok',
    scopeLabel: 'Firma Testowa',
    filter: { categories: ['faktury_zakupu'] },
    total: 1,
    totalCapped: false,
    items: [item()],
    nextCursor: null,
    notes: [],
    ...overrides,
  };
}

interface Element {
  readonly type: string;
  readonly text?: string;
  readonly id?: string;
  readonly title?: string;
  readonly url?: string;
  readonly value?: string;
  readonly data?: Record<string, unknown>;
  readonly items?: Element[];
  readonly actions?: Element[];
  readonly choices?: { title: string; value: string }[];
  readonly card?: Card;
}

interface Card {
  readonly body: Element[];
  readonly actions?: Element[];
}

function card(answer: OkAnswer, start = 1): Card {
  return buildSearchResultCard(answer, start) as Card;
}

/** Every TextBlock's text, containers included, in order. */
function texts(elements: readonly Element[]): string[] {
  return elements.flatMap((e) => [
    ...(e.type === 'TextBlock' && e.text !== undefined ? [e.text] : []),
    ...texts(e.items ?? []),
  ]);
}

function containers(c: Card): Element[] {
  return c.body.filter((e) => e.type === 'Container');
}

function openUrls(container: Element): Element[] {
  return (container.items ?? [])
    .filter((e) => e.type === 'ActionSet')
    .flatMap((e) => e.actions ?? [])
    .filter((a) => a.type === 'Action.OpenUrl');
}

function action(c: Card, type: string): Element | undefined {
  return (c.actions ?? []).find((a) => a.type === type);
}

describe('searchReply', () => {
  it('renders an ok answer as the result card', () => {
    const reply = searchReply(ok(), { now: NOW, start: 1 });
    expect(reply.kind).toBe('card');
  });

  it('answers help with the help card with its search section', () => {
    expect(searchReply({ status: 'help' }, { now: NOW, start: 1 })).toEqual({
      kind: 'help',
      search: true,
    });
  });

  it('answers disabled with today’s help card', () => {
    expect(searchReply({ status: 'disabled' }, { now: NOW, start: 1 })).toEqual({
      kind: 'help',
      search: false,
    });
  });

  it('has one fixed text for an unclear question and another for an unsupported one', () => {
    const unclear = searchReply(
      { status: 'not_understood', reason: 'unclear' },
      { now: NOW, start: 1 },
    );
    const unsupported = searchReply(
      { status: 'not_understood', reason: 'unsupported' },
      { now: NOW, start: 1 },
    );
    expect(unclear).toEqual({ kind: 'text', text: SEARCH_NOT_UNDERSTOOD_TEXT });
    expect(unsupported).toEqual({ kind: 'text', text: SEARCH_UNSUPPORTED_TEXT });
    expect(SEARCH_UNSUPPORTED_TEXT).toContain('nie liczę sum');
    for (const text of [SEARCH_NOT_UNDERSTOOD_TEXT, SEARCH_UNSUPPORTED_TEXT]) {
      expect(text).toContain('„faktury zakupu z marca 2026”');
    }
  });

  it('gives no_access one text whatever reason travels with it', () => {
    const reasons = ['membership_mismatch', 'staff', 'not_guest', 'unmapped', undefined];
    const replies = reasons.map((reason) =>
      searchReply({ status: 'no_access', reason } as unknown as SearchResponsePayload, {
        now: NOW,
        start: 1,
      }),
    );
    for (const reply of replies) {
      expect(reply).toEqual({ kind: 'text', text: SEARCH_NO_ACCESS_TEXT });
    }
    expect(SEARCH_NO_ACCESS_TEXT).toBe(
      'Wyszukiwanie dokumentów jest dostępne tylko dla klientów BCR z przypisaną firmą. ' +
        'Jeśli to błąd, skontaktuj się z zespołem BCR.',
    );
  });

  it('says when to try again after a rate limit, in Warsaw time, rounded up to the minute', () => {
    const reply = searchReply(
      { status: 'rate_limited', retryAfterSeconds: 90 },
      { now: NOW, start: 1 },
    );
    expect(reply).toEqual({ kind: 'text', text: searchRateLimitedText('12:02') });
    expect(searchRateLimitedText('12:02')).toMatch(
      /10 pytań w ciągu 5 minut.*Spróbuj ponownie o 12:02\.$/,
    );
  });

  it('answers unavailable for a question with a card carrying an empty „Zmień filtr” form', () => {
    // A first-time asker has no earlier card: the form (no model call) comes with this one.
    const reply = searchReply({ status: 'unavailable' }, { now: NOW, start: 1, question: true });
    expect(reply.kind).toBe('card');
    const c = (reply as { card: Card }).card;
    expect(texts(c.body)).toEqual([SEARCH_UNAVAILABLE_QUESTION_TEXT]);
    const form = action(c, 'Action.ShowCard');
    expect(form?.title).toBe('Zmień filtr');
    const values = Object.fromEntries(
      (form?.card?.body ?? []).filter((e) => e.value !== undefined).map((e) => [e.id, e.value]),
    );
    expect(values).toEqual({ [SEARCH_FORM_INPUTS.status]: 'all' });
  });

  it('answers unavailable (and anything unknown) with the fixed unavailable text', () => {
    expect(searchReply({ status: 'unavailable' }, { now: NOW, start: 1 })).toEqual({
      kind: 'text',
      text: SEARCH_UNAVAILABLE_TEXT,
    });
    expect(
      searchReply({ status: 'surprise' } as unknown as SearchResponsePayload, {
        now: NOW,
        start: 1,
      }),
    ).toEqual({ kind: 'text', text: SEARCH_UNAVAILABLE_TEXT });
    expect(SEARCH_UNAVAILABLE_TEXT).toContain('„Zmień filtr”');
  });
});

describe('retryClock', () => {
  it.each<[string, number, string]>([
    ['2026-09-28T10:00:00Z', 0, '12:00'],
    ['2026-09-28T10:00:01Z', 0, '12:01'],
    ['2026-12-01T10:00:00Z', 300, '11:05'],
    ['2026-09-30T22:30:00Z', 0, '00:30'],
    ['2026-09-28T10:00:00Z', Number.NaN, '12:00'],
    ['2026-09-28T10:00:00Z', -60, '12:00'],
  ])('%s + %ps is %s in Warsaw', (iso, seconds, clock) => {
    expect(retryClock(new Date(iso), seconds)).toBe(clock);
  });

  it('caps an absurd wait at a week rather than failing', () => {
    expect(retryClock(NOW, Number.MAX_SAFE_INTEGER)).toBe('12:00');
  });
});

describe('buildSearchResultCard', () => {
  it('has the heading, the client, what was understood, the count, the items and the coverage line', () => {
    const blocks = texts(card(ok()).body);
    expect(blocks[0]).toBe('🔎 Wyniki wyszukiwania');
    expect(blocks[1]).toBe('Firma: Firma Testowa');
    expect(blocks[2]).toBe('Zrozumiałem: Faktura zakupu');
    expect(blocks[3]).toBe('Znaleziono 1 dokument.');
    expect(blocks.at(-1)).toBe(SEARCH_COVERAGE_TEXT);
    expect(SEARCH_COVERAGE_TEXT).toBe(
      'Wyszukiwarka obejmuje dokumenty zarchiwizowane przez asystenta od 28.09.2026; ' +
        'pliki z kanału pojawiają się po kilku minutach.',
    );
  });

  it('is an Adaptive Card 1.5 of Containers, never a Table', () => {
    const c = buildSearchResultCard(ok({ items: [item(), item()] }), 1) as {
      version: string;
      type: string;
    };
    expect(c).toMatchObject({ type: 'AdaptiveCard', version: '1.5' });
    expect(containers(c as unknown as Card)).toHaveLength(2);
    expect(JSON.stringify(c)).not.toContain('"Table"');
  });

  it('shows an item: label, number · date · amount currency, counterparty and an Otwórz button', () => {
    const [container] = containers(card(ok()));
    expect(texts([container as Element])).toEqual([
      'Faktura zakupu',
      `FV/12/2026 · 15.09.2026 · 12${NBSP}345,50 PLN`,
      `Kontrahent: Dostawca Testowy Sp. z o\u2024o. (NIP ${NIP})`,
    ]);
    expect(openUrls(container as Element)).toEqual([
      {
        type: 'Action.OpenUrl',
        title: 'Otwórz',
        url: 'https://bcr.sharepoint.test/sites/Klient/Dokumenty/faktura.pdf',
      },
    ]);
  });

  it('labels a document in review „(w weryfikacji)” and falls back to its month', () => {
    const [container] = containers(
      card(
        ok({
          items: [
            item({
              status: 'in_review',
              category: 'nieposortowane',
              issueDate: null,
              documentMonth: '2026-03',
              invoiceNumber: null,
              grossAmount: null,
              counterpartyName: null,
              counterpartyNip: null,
            }),
          ],
        }),
      ),
    );
    expect(texts([container as Element])).toEqual([
      'Nieposortowane (w weryfikacji)',
      'marzec 2026',
    ]);
  });

  it.each<[string, Partial<SearchResultItem>, string | null]>([
    ['name only', { counterpartyNip: null }, 'Kontrahent: Dostawca Testowy Sp. z o\u2024o.'],
    ['NIP only', { counterpartyName: null }, `Kontrahent: NIP ${NIP}`],
    ['neither', { counterpartyName: null, counterpartyNip: null }, null],
  ])('shows the counterparty with %s', (_label, overrides, expected) => {
    const lines = texts(containers(card(ok({ items: [item(overrides)] }))));
    const line = lines.find((t) => t.startsWith('Kontrahent:')) ?? null;
    expect(line).toBe(expected);
  });

  it('shows an amount without a currency when there is none', () => {
    const lines = texts(
      containers(card(ok({ items: [item({ currency: null, grossAmount: '80' })] }))),
    );
    expect(lines[1]).toBe('FV/12/2026 · 15.09.2026 · 80,00');
  });

  it.each<[string, string | null]>([
    ['no link', null],
    ['an http link', 'http://bcr.sharepoint.test/sites/Klient/a.pdf'],
    ['a javascript: link', 'javascript:alert(1)'],
    ['not a URL', 'faktura.pdf'],
    ['a link longer than the cap', `https://bcr.sharepoint.test/${'a'.repeat(MAX_LINK_CHARS)}`],
  ])('says „Link niedostępny” for %s, with no button', (_label, webUrl) => {
    const [container] = containers(card(ok({ items: [item({ webUrl })] })));
    expect(openUrls(container as Element)).toEqual([]);
    expect(texts([container as Element]).at(-1)).toBe(SEARCH_LINK_UNAVAILABLE_TEXT);
  });

  it('leaves out a date, month, amount, currency or NIP that is not in its shape', () => {
    const json = JSON.stringify(
      card(
        ok({
          items: [
            item({
              issueDate: EVIL_LINK,
              documentMonth: '2026-13',
              grossAmount: '1e9',
              currency: 'zł',
              counterpartyNip: `PL${NIP}`,
              counterpartyName: null,
            }),
          ],
        }),
      ),
    );
    expect(json).not.toMatch(/evil|2026-13|1e9|zł|PL1234563218|Kontrahent/);
    expect(
      texts(containers(card(ok({ items: [item({ issueDate: 'x', documentMonth: null })] }))))[1],
    ).toBe(`FV/12/2026 · 12${NBSP}345,50 PLN`);
  });

  it('escapes every inserted value: a markdown link and a bidi override render literally', () => {
    const hostile = `${EVIL_LINK}${RLO}fdp.exe`;
    const c = card(
      ok({
        scopeLabel: hostile,
        filter: { counterpartyName: EVIL_LINK, invoiceNumber: '**1**' },
        items: [item({ counterpartyName: hostile, invoiceNumber: `- ${EVIL_LINK}` })],
      }),
    );
    const blocks = texts(c.body);
    expect(blocks).toContain('Firma: \\[x\\]\\(https://evil\\) fdp.exe');
    expect(blocks).toContain(
      'Zrozumiałem: kontrahent „\\[x\\]\\(https://evil\\)”; numer faktury \\*\\*1\\*\\*',
    );
    // Document values are also defanged (a colon look-alike in `://`, a dot look-alike before a letter).
    expect(blocks.some((t) => t.startsWith('\\- \\[x\\]\\(https\ua789//evil\\) · '))).toBe(true);
    expect(blocks).toContain(
      `Kontrahent: \\[x\\]\\(https\ua789//evil\\) fdp\u2024exe (NIP ${NIP})`,
    );
    for (const text of blocks) {
      expect(text).not.toContain(EVIL_LINK);
      expect(text).not.toContain(RLO);
    }
  });

  it('breaks link-shaped values from documents, so Teams cannot link them', () => {
    const c = card(
      ok({
        items: [
          item({
            counterpartyName: 'https://pay-bcr.example/login',
            invoiceNumber: 'www.evil.example',
          }),
          item({ counterpartyName: 'a@evil.example', invoiceNumber: 'FV/1/evil.example' }),
          item({ counterpartyName: 'Allegro.pl sp. z o.o.', invoiceNumber: 'FV 10.08.2026' }),
        ],
      }),
    );
    const itemTexts = containers(c).flatMap((ct) => texts([ct]));
    for (const text of itemTexts) {
      expect(text).not.toContain('://');
      expect(text).not.toContain('www.');
      expect(text).not.toContain('@');
      expect(text).not.toMatch(/\p{L}\.\p{L}/u);
    }
    // It still reads the same; digits keep their dots (no domain ends in digits).
    expect(itemTexts).toContain(`Kontrahent: Allegro\u2024pl sp. z o\u2024o. (NIP ${NIP})`);
    expect(itemTexts.some((t) => t.startsWith('FV 10.08.2026 · '))).toBe(true);
  });

  it('caps a long name and replaces a lone surrogate', () => {
    const lone = String.fromCharCode(0xd800);
    const lines = texts(
      containers(
        card(
          ok({
            items: [item({ counterpartyName: `${lone}${'A'.repeat(200)}`, counterpartyNip: null })],
          }),
        ),
      ),
    );
    expect(lines.at(1 + 1)).toBe(`Kontrahent: ${String.fromCodePoint(0xfffd)}${'A'.repeat(79)}…`);
  });

  it('counts with Polish plurals and pages with „Pokaż kolejne 10” carrying only filter, cursor and position', () => {
    const filter: ClientSearchFilter = { categories: ['faktury_sprzedazy'], monthFrom: '2026-01' };
    const items = Array.from({ length: SEARCH_PAGE_SIZE }, (_v, i) =>
      item({ documentId: `d${i}` }),
    );
    const c = card(ok({ filter, total: 23, items, nextCursor: 'cursor-2' }), 11);

    expect(texts(c.body)).toContain('Znaleziono 23 dokumenty, pokazuję 11–20.');
    const next = action(c, 'Action.Submit');
    expect(next?.title).toBe('Pokaż kolejne 10');
    expect(next?.data).toEqual({
      v: 1,
      action: 'bcr.search.page',
      filter,
      after: 'cursor-2',
      start: 21,
    });
    // What Teams sends back when the button is pressed is a typed request for the next page.
    expect(parseSearchAction(next?.data)).toEqual({
      kind: 'typed',
      filter,
      after: 'cursor-2',
      start: 21,
    });
  });

  it('says „ponad 500” when the count reached the cap', () => {
    const items = Array.from({ length: SEARCH_PAGE_SIZE }, () => item());
    const c = card(ok({ total: 500, totalCapped: true, items, nextCursor: 'c' }));
    expect(texts(c.body)).toContain('Znaleziono ponad 500 dokumentów, pokazuję 1–10.');
  });

  it('has no paging button on the last page, only „Zmień filtr”', () => {
    const c = card(ok());
    expect((c.actions ?? []).map((a) => [a.type, a.title])).toEqual([
      ['Action.ShowCard', 'Zmień filtr'],
    ]);
  });

  it('answers an empty result with the fixed text, still saying what it understood, and the form', () => {
    const c = card(ok({ total: 0, items: [], nextCursor: 'stray' }));
    const blocks = texts(c.body);
    expect(blocks).toContain(SEARCH_EMPTY_TEXT);
    expect(blocks).toContain('Zrozumiałem: Faktura zakupu');
    expect(containers(c)).toHaveLength(0);
    expect((c.actions ?? []).map((a) => a.title)).toEqual(['Zmień filtr']);
  });

  it('shows each note once, as its fixed text', () => {
    const notes: SearchNote[] = ['nip_dropped', 'period_clamped', 'nip_dropped'];
    const blocks = texts(card(ok({ notes })).body);
    expect(blocks.filter((t) => t === SEARCH_NOTE_TEXT.nip_dropped)).toHaveLength(1);
    expect(blocks).toContain(SEARCH_NOTE_TEXT.period_clamped);
  });

  it('shows nothing ingestion sends beyond the client-view fields', () => {
    const smuggled = {
      ...item(),
      uploadedByOid: '99999999-9999-4999-8999-999999999999',
      contentSha256: 'f'.repeat(64),
      driveItemId: 'drive-item-secret',
      confidence: 0.42,
      reason: 'membership_mismatch',
    } as SearchResultItem;
    const json = JSON.stringify(card(ok({ items: [smuggled] })));
    expect(json).not.toMatch(/99999999|ffffffff|drive-item-secret|0\.42|membership_mismatch/);
  });

  describe('„Zmień filtr”', () => {
    const ids = SEARCH_FORM_INPUTS;
    const full: ClientSearchFilter = {
      categories: ['faktury_zakupu', 'umowy'],
      monthFrom: '2026-01',
      monthTo: '2026-09',
      grossMin: '1500.50',
      grossMax: '20000.00',
      currency: 'EUR',
      counterpartyNip: NIP,
      counterpartyName: 'Dostawca',
      invoiceNumber: 'FV/1/2026',
      status: 'in_review',
    };

    function form(filter: ClientSearchFilter): Card {
      const show = action(card(ok({ filter })), 'Action.ShowCard');
      if (!show?.card) throw new Error('no form');
      return show.card;
    }

    it('offers every taxonomy category by its Polish label', () => {
      const choiceSet = form({}).body.find((e) => e.id === ids.categories);
      expect(choiceSet?.choices).toEqual(
        categoryCatalog.map((c) => ({ title: c.polishLabel, value: c.id })),
      );
    });

    it('is pre-filled with the filter that ran, and its button carries {v, action} only', () => {
      const f = form(full);
      const values = Object.fromEntries(f.body.map((e) => [e.id, e.value]));
      expect(values).toEqual({
        [ids.categories]: 'faktury_zakupu,umowy',
        [ids.monthFrom]: '2026-01',
        [ids.monthTo]: '2026-09',
        [ids.grossMin]: '1500,50',
        [ids.grossMax]: '20000,00',
        [ids.currency]: 'EUR',
        [ids.counterpartyNip]: NIP,
        [ids.counterpartyName]: 'Dostawca',
        [ids.invoiceNumber]: 'FV/1/2026',
        [ids.status]: 'in_review',
      });
      expect(f.actions).toEqual([
        { type: 'Action.Submit', title: 'Szukaj', data: { v: 1, action: 'bcr.search.filter' } },
      ]);
      expect(f.body.map((e) => e.type)).toEqual([
        'Input.ChoiceSet',
        ...Array<string>(8).fill('Input.Text'),
        'Input.ChoiceSet',
      ]);
    });

    it('round-trips: the submitted form is the same filter again, with no model call', () => {
      const f = form(full);
      const submitted = {
        ...(f.actions?.[0]?.data ?? {}),
        ...Object.fromEntries(f.body.map((e) => [e.id, e.value ?? ''])),
      };
      expect(parseSearchAction(submitted)).toEqual({ kind: 'typed', filter: full, start: 1 });
    });

    it('starts empty for an empty filter, with status „Wszystkie”', () => {
      const f = form({});
      const values = Object.fromEntries(f.body.map((e) => [e.id, e.value]));
      expect(values).toEqual({ [ids.status]: 'all' });
    });
  });

  it('stays under Teams’ 28 KB message limit in the worst case, with room for the envelope', () => {
    const heavy = String.fromCodePoint(0x1f4c4); // four bytes in UTF-8
    const backslash = '\\'; // escaped to two, then JSON-escaped to four bytes
    const base = 'https://bcr.sharepoint.test/sites/Klient/';
    const worstItem = (i: number) =>
      item({
        documentId: `${i}`.repeat(1000),
        status: 'in_review',
        category: 'dokumenty_firmowe',
        documentMonth: String.fromCharCode(0xd800).repeat(1000),
        invoiceNumber: backslash.repeat(1000),
        issueDate: heavy.repeat(500),
        grossAmount: '999999999999.99',
        currency: 'PLN',
        counterpartyName: heavy.repeat(1000),
        counterpartyNip: NIP,
        webUrl: `${base}${'a'.repeat(MAX_LINK_CHARS - base.length)}`,
      });
    const answer = ok({
      scopeLabel: backslash.repeat(1000),
      filter: {
        categories: categoryCatalog.map((c) => c.id),
        monthFrom: '2000-01',
        monthTo: '2027-12',
        grossMin: '999999999998.99',
        grossMax: '999999999999.99',
        currency: 'PLN',
        counterpartyNip: NIP,
        counterpartyName: backslash.repeat(60),
        invoiceNumber: backslash.repeat(60),
        status: 'in_review',
      },
      total: 500,
      totalCapped: true,
      items: Array.from({ length: SEARCH_PAGE_SIZE }, (_v, i) => worstItem(i)),
      nextCursor: 'c'.repeat(256),
      notes: [
        'counterparty_name_dropped',
        'invoice_number_dropped',
        'nip_dropped',
        'period_clamped',
      ],
    });
    const worst = Buffer.byteLength(JSON.stringify(buildSearchResultCard(answer, 99_991)), 'utf8');
    expect(worst).toBeLessThan(26 * 1024);

    const typical = Buffer.byteLength(
      JSON.stringify(
        buildSearchResultCard(ok({ items: Array.from({ length: 10 }, () => item()) }), 1),
      ),
      'utf8',
    );
    expect(typical).toBeLessThan(12 * 1024);
  });
});

describe('describeFilter', () => {
  it.each<[string, ClientSearchFilter, string]>([
    ['an empty filter', {}, 'najnowsze dokumenty'],
    [
      'categories',
      { categories: ['faktury_sprzedazy', 'wyciagi_bankowe'] },
      'Faktura sprzedaży, Wyciąg bankowy',
    ],
    ['one month', { monthFrom: '2026-03', monthTo: '2026-03' }, 'marzec 2026'],
    ['a range', { monthFrom: '2026-01', monthTo: '2026-09' }, 'od stycznia 2026 do września 2026'],
    ['a start', { monthFrom: '2025-12' }, 'od grudnia 2025'],
    ['an end', { monthTo: '2026-02' }, 'do lutego 2026'],
    [
      'amounts with a currency',
      { grossMin: '1000.00', grossMax: '25000.5', currency: 'EUR' },
      `kwota brutto od 1000,00 EUR do 25${NBSP}000,50 EUR`,
    ],
    ['a minimum', { grossMin: '5000' }, 'kwota brutto od 5000,00'],
    ['a maximum', { grossMax: '99.9' }, 'kwota brutto do 99,90'],
    ['a currency alone', { currency: 'USD' }, 'waluta USD'],
    [
      'a counterparty and an invoice number',
      { counterpartyNip: NIP, counterpartyName: 'Dostawca', invoiceNumber: 'FV/1/2026' },
      `NIP kontrahenta ${NIP}; kontrahent „Dostawca”; numer faktury FV/1/2026`,
    ],
    ['in review', { status: 'in_review' }, 'w weryfikacji'],
    ['filed', { status: 'filed' }, 'zarchiwizowane'],
    [
      'everything, in a fixed order',
      { status: 'filed', categories: ['umowy'], grossMax: '10', monthTo: '2026-09' },
      'Umowa; do września 2026; kwota brutto do 10,00; zarchiwizowane',
    ],
  ])('describes %s', (_label, filter, text) => {
    expect(describeFilter(filter)).toBe(text);
  });
});

describe('formatAmountPl', () => {
  it.each<[string, string]>([
    ['0', '0,00'],
    ['5', '5,00'],
    ['80.5', '80,50'],
    ['1234.5', '1234,50'],
    ['12345.5', `12${NBSP}345,50`],
    ['1234567.89', `1${NBSP}234${NBSP}567,89`],
    ['-80.00', '-80,00'],
    ['-0.00', '0,00'],
    ['007.10', '7,10'],
    ['999999999999.99', `999${NBSP}999${NBSP}999${NBSP}999,99`],
  ])('shows %s as %s', (decimal, shown) => {
    expect(formatAmountPl(decimal)).toBe(shown);
  });

  it('agrees with Intl pl-PL wherever a float is exact enough to compare', () => {
    const intl = new Intl.NumberFormat('pl-PL', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    const samples = ['0.01', '9.99', '999.99', '1000', '9999.99', '10000', '123456.78', '1000000'];
    const mismatches = samples.filter((s) => formatAmountPl(s) !== intl.format(Number(s)));
    expect(mismatches).toEqual([]);
  });

  it('stays exact where a float would not', () => {
    const decimal = '900719925474099.01';
    expect(Number(decimal).toFixed(2)).not.toBe(decimal);
    expect(formatAmountPl(decimal)).toBe(`900${NBSP}719${NBSP}925${NBSP}474${NBSP}099,01`);
  });

  it.each(['1e9', '12,50', '', 'abc', '1.234', 'NaN', '1 000.00'])(
    'answers null for %p (not a decimal string)',
    (value) => {
      expect(formatAmountPl(value)).toBeNull();
    },
  );
});

describe('formatIssueDate and formatMonth', () => {
  it('formats a date as DD.MM.RRRR and a month by its Polish name', () => {
    expect(formatIssueDate('2026-09-15')).toBe('15.09.2026');
    expect(formatMonth('2026-09', MONTHS_NOMINATIVE)).toBe('wrzesień 2026');
    expect(formatMonth('2026-01', MONTHS_GENITIVE)).toBe('stycznia 2026');
  });

  it.each([null, '15.09.2026', '2026-9-15', 'x'])('has no date for %p', (value) => {
    expect(formatIssueDate(value)).toBeNull();
  });

  it.each([null, '2026-00', '2026-13', '26-01'])('has no month for %p', (value) => {
    expect(formatMonth(value, MONTHS_NOMINATIVE)).toBeNull();
  });
});

describe('Polish counts', () => {
  it.each<[number, string]>([
    [0, 'dokumentów'],
    [1, 'dokument'],
    [2, 'dokumenty'],
    [4, 'dokumenty'],
    [5, 'dokumentów'],
    [11, 'dokumentów'],
    [12, 'dokumentów'],
    [14, 'dokumentów'],
    [21, 'dokumentów'],
    [22, 'dokumenty'],
    [25, 'dokumentów'],
    [102, 'dokumenty'],
    [112, 'dokumentów'],
    [122, 'dokumenty'],
  ])('%i → %s', (n, word) => {
    expect(polishPlural(n, 'dokument', 'dokumenty', 'dokumentów')).toBe(word);
  });

  it.each<[number, boolean, number, number, string]>([
    [1, false, 1, 1, 'Znaleziono 1 dokument.'],
    [3, false, 1, 3, 'Znaleziono 3 dokumenty.'],
    [10, false, 1, 10, 'Znaleziono 10 dokumentów.'],
    [23, false, 1, 10, 'Znaleziono 23 dokumenty, pokazuję 1–10.'],
    [23, false, 21, 23, 'Znaleziono 23 dokumenty, pokazuję 21–23.'],
    [11, false, 11, 11, 'Znaleziono 11 dokumentów, pokazuję dokument nr 11.'],
    [500, true, 1, 10, 'Znaleziono ponad 500 dokumentów, pokazuję 1–10.'],
  ])('total %i (capped %p), %i–%i', (total, capped, first, last, text) => {
    expect(searchFoundText(total, capped, first, last)).toBe(text);
  });
});
