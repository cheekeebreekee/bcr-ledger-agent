import type { Classification, DocumentParty } from '@bcr/shared';
import {
  DIRECTION_UNRESOLVED,
  DIRECTION_UNRESOLVED_MAX_CONFIDENCE,
  isDirectedInvoice,
  settleInvoiceDirection,
  type ClientRole,
} from './invoiceDirection';

const CLIENT = { nip: '1111111111', companyName: 'Klient Testowy Sp. z o.o.' };
const OTHER_NIP = '2222222222';

function invoice(
  over: {
    category?: string;
    parties?: DocumentParty[];
    clientRole?: ClientRole;
    confidence?: number;
    year?: number;
    month?: number;
  } = {},
): Classification {
  return {
    documentType: 'Faktura zakupu',
    folderPath: '',
    confidence: over.confidence ?? 0.95,
    classifier: 'claude',
    fields: {
      category: over.category ?? 'faktury_zakupu',
      year: over.year ?? 2026,
      month: over.month ?? 9,
      ...(over.clientRole ? { clientRole: over.clientRole } : {}),
    },
    ...(over.parties ? { parties: over.parties } : {}),
  };
}

describe('settleInvoiceDirection', () => {
  it("files a guessed purchase as a sale when the client's NIP is the seller's", () => {
    const settled = settleInvoiceDirection(
      invoice({
        parties: [
          { role: 'seller', nip: CLIENT.nip },
          { role: 'buyer', nip: OTHER_NIP },
        ],
        clientRole: 'buyer',
      }),
      CLIENT,
    );
    expect(settled.fields).toMatchObject({
      category: 'faktury_sprzedazy',
      direction: 'sprzedaz',
      directionSource: 'nip',
    });
    expect(settled.documentType).toBe('Faktura sprzedaży');
    expect(settled.folderPath).toBe('01_Faktury/01_Faktury_sprzedaży/2026/09');
    expect(settled.reviewReasons).toBeUndefined();
    expect(settled.confidence).toBe(0.95);
  });

  it("settles a purchase from the client's NIP on the buyer's side", () => {
    const settled = settleInvoiceDirection(
      invoice({
        category: 'faktury_sprzedazy',
        parties: [
          { role: 'seller', nip: OTHER_NIP },
          { role: 'buyer', nip: CLIENT.nip },
        ],
      }),
      { ...CLIENT, nip: '111-111-11-11' },
    );
    expect(settled.fields).toMatchObject({ category: 'faktury_zakupu', direction: 'zakup' });
  });

  it("uses the model's match of the primed name when the NIP is not on the document", () => {
    const settled = settleInvoiceDirection(
      invoice({ parties: [{ role: 'seller', nip: OTHER_NIP }], clientRole: 'seller' }),
      CLIENT,
    );
    expect(settled.fields).toMatchObject({
      category: 'faktury_sprzedazy',
      direction: 'sprzedaz',
      directionSource: 'model',
    });
  });

  it('accepts a name-only identity for the model match', () => {
    const settled = settleInvoiceDirection(invoice({ clientRole: 'buyer' }), {
      nip: '',
      companyName: CLIENT.companyName,
    });
    expect(settled.fields['direction']).toBe('zakup');
  });

  it('keeps an empty folder when the invoice has no usable date', () => {
    const settled = settleInvoiceDirection(invoice({ clientRole: 'buyer', month: 13 }), CLIENT);
    expect(settled.fields['direction']).toBe('zakup');
    expect(settled.folderPath).toBe('');
  });

  // The 2026-09-26 evaluation: without an identity the model guessed, and
  // four of the client's own sales invoices were filed as purchases.
  it.each([
    ['no client identity at all', undefined, { clientRole: 'seller' as const }],
    ['an empty identity', { nip: '', companyName: '  ' }, { clientRole: 'buyer' as const }],
    ['a client that is neither party', CLIENT, { clientRole: 'none' as const }],
    ['a model that could not tell', CLIENT, { clientRole: 'unknown' as const }],
    [
      "the client's NIP on both sides",
      CLIENT,
      {
        clientRole: 'seller' as const,
        parties: [
          { role: 'seller' as const, nip: CLIENT.nip },
          { role: 'buyer' as const, nip: CLIENT.nip },
        ],
      },
    ],
    [
      "the client's NIP only on a non-invoice role",
      CLIENT,
      { parties: [{ role: 'recipient' as const, nip: CLIENT.nip }] },
    ],
  ])('never guesses with %s: review, lower confidence', (_label, client, over) => {
    const settled = settleInvoiceDirection(invoice({ ...over, confidence: 0.97 }), client);
    expect(settled.fields['category']).toBe('faktury_zakupu');
    expect(settled.fields['direction']).toBeUndefined();
    expect(settled.reviewReasons).toEqual([DIRECTION_UNRESOLVED]);
    expect(settled.confidence).toBe(DIRECTION_UNRESOLVED_MAX_CONFIDENCE);
  });

  it('keeps a confidence already below the cap, and does not repeat the flag', () => {
    const once = settleInvoiceDirection(invoice({ confidence: 0.3 }), undefined);
    const twice = settleInvoiceDirection(once, undefined);
    expect(twice.confidence).toBe(0.3);
    expect(twice.reviewReasons).toEqual([DIRECTION_UNRESOLVED]);
  });

  it.each(['faktury_korekty', 'faktury_noty', 'umowy', 'nieposortowane'])(
    'leaves %s alone: only sales and purchase invoices have a direction',
    (category) => {
      const c = invoice({ category, parties: [{ role: 'seller', nip: CLIENT.nip }] });
      expect(settleInvoiceDirection(c, CLIENT)).toBe(c);
      expect(settleInvoiceDirection(c, undefined)).toBe(c);
    },
  );

  it('picks only between the two invoice folders, whatever the parties say (property)', () => {
    const roles: DocumentParty['role'][] = ['seller', 'buyer', 'issuer', 'recipient', 'unknown'];
    const nips = [CLIENT.nip, OTHER_NIP, ''];
    const clientRoles: ClientRole[] = ['seller', 'buyer', 'none', 'unknown'];
    const offenders: string[] = [];
    for (const role of roles) {
      for (const nip of nips) {
        for (const other of nips) {
          for (const clientRole of clientRoles) {
            for (const client of [CLIENT, undefined]) {
              const parties: DocumentParty[] = [
                { role, nip },
                { role: 'buyer', nip: other },
              ];
              const settled = settleInvoiceDirection(invoice({ parties, clientRole }), client);
              const category = settled.fields['category'];
              const ok =
                isDirectedInvoice(category) &&
                (settled.reviewReasons?.includes(DIRECTION_UNRESOLVED)
                  ? settled.confidence <= DIRECTION_UNRESOLVED_MAX_CONFIDENCE &&
                    settled.fields['direction'] === undefined
                  : client !== undefined);
              if (!ok) offenders.push(JSON.stringify({ role, nip, other, clientRole, client }));
            }
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
