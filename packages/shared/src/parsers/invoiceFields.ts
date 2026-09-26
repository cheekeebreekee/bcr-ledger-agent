/**
 * Validators for the searchable fields of an invoice, receipt or note: NIPs,
 * amounts, dates, currencies, invoice and KSeF numbers. Each takes what the
 * model (or a person) wrote and returns the normalised value, or `null` when
 * it is not a valid one. A wrong value in the document index is worse than a
 * missing one: search would find the document under the wrong NIP or amount.
 *
 * `ledger.nip_is_valid()` in `packages/ledger-db/migrations` is the same NIP
 * rule in SQL; the DB integration tests run one table of cases through both.
 */

const NIP_WEIGHTS = [6, 5, 7, 2, 3, 4, 5, 6, 7] as const;

/**
 * Whether `digits` is exactly ten digits with a valid NIP checksum: the first
 * nine weighted 6, 5, 7, 2, 3, 4, 5, 6, 7, summed, modulo 11, equal the tenth
 * (a remainder of 10 is never valid). `0000000000` passes the arithmetic and
 * is refused: it is what a blanked-out field reads as.
 */
export function isValidNip(digits: string): boolean {
  if (!/^[0-9]{10}$/.test(digits) || digits === '0000000000') return false;
  let sum = 0;
  for (let i = 0; i < NIP_WEIGHTS.length; i += 1) {
    sum += (NIP_WEIGHTS[i] as number) * Number(digits[i]);
  }
  return sum % 11 === Number(digits[9]);
}

/**
 * A NIP as written on a document — `123-456-78-19`, `123 456 78 19`,
 * `PL1234567819` — as its ten digits, or `null` when it is not a valid Polish
 * NIP. Anything but digits, spaces, hyphens and a leading `PL` is refused, so
 * a foreign VAT number never passes by accident of its digits.
 */
export function normalizeNip(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim().toUpperCase();
  const match = /^(?:PL)?\s*([0-9][0-9 -]*[0-9])$/.exec(text);
  if (!match) return null;
  const digits = (match[1] as string).replace(/[ -]/g, '');
  return isValidNip(digits) ? digits : null;
}

/** The most integer digits `numeric(14,2)` holds. */
const MAX_INTEGER_DIGITS = 12;

/**
 * An amount as a decimal string with two places (`1234.50`, `-80.00`), or
 * `null`. Accepts a sign, digits, and a `.` or `,` with one or two decimals;
 * spaces (also non-breaking) are dropped. Thousands separators, currency
 * symbols and more than two decimals are refused rather than guessed: `1.234`
 * could be either reading. Fits `numeric(14,2)`.
 */
export function normalizeAmount(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const text =
    typeof value === 'number'
      ? Number.isFinite(value)
        ? value.toString()
        : ''
      : value.replace(/[\s  ]/g, '');
  const match = /^(-?)([0-9]+)(?:[.,]([0-9]{1,2}))?$/.exec(text);
  if (!match) return null;
  const integer = (match[2] as string).replace(/^0+(?=[0-9])/, '');
  if (integer.length > MAX_INTEGER_DIGITS) return null;
  const fraction = (match[3] ?? '').padEnd(2, '0');
  const negative = match[1] === '-' && !(/^0+$/.test(integer) && fraction === '00');
  return `${negative ? '-' : ''}${integer}.${fraction}`;
}

/**
 * A calendar date written `YYYY-MM-DD`, from 1900 to 2100, or `null`. The
 * string is returned as it is when valid: `2026-02-30` is refused, never
 * rolled over into March.
 */
export function normalizeIsoDate(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  const match = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(text);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (year < 1900 || year > 2100) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? text
    : null;
}

/**
 * ISO 4217 currency codes: those in use, and those withdrawn recently enough
 * to be on documents a client still has (HRK before 2023, BGN before 2026).
 * Precious metals, fund and test codes (XAU, XDR, XTS, XXX, …) are not
 * currencies of an invoice and are left out.
 */
export const ISO_4217_CURRENCIES: ReadonlySet<string> = new Set(
  (
    'AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND BOB BOV BRL BSD ' +
    'BTN BWP BYN BZD CAD CDF CHE CHF CHW CLF CLP CNY COP COU CRC CUC CUP CVE CZK DJF DKK DOP ' +
    'DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GNF GTQ GYD HKD HNL HRK HTG HUF IDR ILS ' +
    'INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF KPW KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD ' +
    'MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MXV MYR MZN NAD NGN NIO NOK NPR NZD OMR ' +
    'PAB PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP SLE SLL SOS ' +
    'SRD SSP STN SVC SYP SZL THB TJS TMT TND TOP TRY TTD TWD TZS UAH UGX USD USN UYI UYU UYW ' +
    'UZS VED VES VND VUV WST XAF XCD XCG XOF XPF YER ZAR ZMW ZWG ZWL'
  ).split(' '),
);

/** An ISO 4217 code (`PLN`, `EUR`), upper-cased, or `null`. `zł` and `€` are not codes. */
export function normalizeCurrency(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase();
  return ISO_4217_CURRENCIES.has(code) ? code : null;
}

/** Longest invoice number kept; anything longer is not a number but a sentence. */
export const MAX_INVOICE_NUMBER_LENGTH = 100;

/** Longest party name kept. */
export const MAX_PARTY_NAME_LENGTH = 300;

/**
 * Free text (an invoice number, a party name) with its whitespace collapsed,
 * or `null` when empty, longer than `maxLength` or holding a control
 * character.
 */
export function normalizeText(value: string | null | undefined, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim();
  if (text === '' || text.length > maxLength || /[\u0000-\u001f\u007f]/.test(text)) return null;
  return text;
}

/**
 * A KSeF number (`NNNNNNNNNN-YYYYMMDD-XXXXXXXXXXXX-XX`: the seller's NIP, the
 * date, twelve hexadecimal characters and a two-character checksum),
 * upper-cased, or `null`. The NIP and the date must be valid. The CRC-8 of the
 * last group is not checked here: that belongs with the KSeF integration.
 */
export function normalizeKsefNumber(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim().toUpperCase();
  const match = /^([0-9]{10})-([0-9]{4})([0-9]{2})([0-9]{2})-[0-9A-F]{12}-[0-9A-F]{2}$/.exec(text);
  if (!match) return null;
  if (!isValidNip(match[1] as string)) return null;
  return normalizeIsoDate(`${match[2]}-${match[3]}-${match[4]}`) ? text : null;
}
