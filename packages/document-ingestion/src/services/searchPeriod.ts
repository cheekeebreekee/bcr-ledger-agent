/**
 * The period of a client's search, as months: the model only describes it
 * ("marzec", "zeszły kwartał", "ostatnie 3 miesiące"), and this file turns the
 * description into `monthFrom`..`monthTo` against the calendar in Warsaw. The
 * model never sees a date, so its prompt stays byte-stable (and cached), and
 * "this month" is never the model's guess.
 */

/** Whose calendar a period is read in: BCR's clients are Polish companies. */
export const SEARCH_TIME_ZONE = 'Europe/Warsaw';

/** The earliest month a search reaches. A period partly before it is cut here. */
export const MIN_SEARCH_MONTH = '2000-01';

/** The longest period searched, in months (ten years). A longer one keeps its latest part. */
export const MAX_PERIOD_MONTHS = 120;

/** Years the model may name: anything outside is not a year of a document. */
const MIN_YEAR = 1900;
const MAX_YEAR = 2100;

/**
 * How the model may describe a period: `none` when the question names none;
 * `relative_*` counts back from the current month, quarter or year (`offset`
 * 0, -1, …); `last_n_months` is the current month and the `count - 1` before
 * it. Every other field is `null` when unused.
 */
export const PERIOD_KINDS = [
  'none',
  'month',
  'quarter',
  'year',
  'range',
  'relative_month',
  'relative_quarter',
  'relative_year',
  'last_n_months',
] as const;
export type PeriodKind = (typeof PERIOD_KINDS)[number];

/** A period as the model described it (the `period` object of its answer). */
export interface PeriodDescription {
  readonly kind: PeriodKind;
  /** The year of `month`, `quarter` or `year`, or the start of a `range`; `null` when not said. */
  readonly year: number | null;
  /** 1–12: the month, or the first month of a `range`. */
  readonly month: number | null;
  /** 1–4. */
  readonly quarter: number | null;
  /** The last month of a `range` and its year. */
  readonly to_year: number | null;
  readonly to_month: number | null;
  /** `relative_*`: 0 is the current one, -1 the one before. */
  readonly offset: number | null;
  /** `last_n_months`: how many months, the current one included. */
  readonly count: number | null;
}

export type ResolvedPeriod =
  | {
      readonly ok: true;
      /** `YYYY-MM`, inclusive; both absent when the question names no period. */
      readonly monthFrom?: string;
      readonly monthTo?: string;
      /** Part of the period was cut: before {@link MIN_SEARCH_MONTH}, or over {@link MAX_PERIOD_MONTHS}. */
      readonly clamped: boolean;
    }
  | { readonly ok: false; readonly reason: string };

const WARSAW_MONTH = new Intl.DateTimeFormat('en-US', {
  timeZone: SEARCH_TIME_ZONE,
  year: 'numeric',
  month: 'numeric',
});

/** The year and month it is in Warsaw at `now`. */
export function warsawMonth(now: Date): { readonly year: number; readonly month: number } {
  const parts = WARSAW_MONTH.formatToParts(now);
  const year = Number(parts.find((p) => p.type === 'year')?.value);
  const month = Number(parts.find((p) => p.type === 'month')?.value);
  return { year, month };
}

/** Months since year 0: `index(y, m) = 12y + m - 1`. */
const monthIndex = (year: number, month: number): number => year * 12 + month - 1;

const formatMonth = (index: number): string => {
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
};

const isYear = (v: number | null): v is number =>
  v !== null && Number.isInteger(v) && v >= MIN_YEAR && v <= MAX_YEAR;
const isMonth = (v: number | null): v is number =>
  v !== null && Number.isInteger(v) && v >= 1 && v <= 12;

const invalid = (reason: string): ResolvedPeriod => ({ ok: false, reason });

/**
 * The months of a described period, read at `now` in Warsaw:
 *
 *  - a month or quarter without a year is the latest one that has begun (in
 *    September, "grudzień" is last December, "marzec" this March);
 *  - a range without years starts at the latest `month` that has begun, like a
 *    month, and ends at the first `to_month` from there (in September, "od
 *    lipca do października" is this July to this October, "od października
 *    do grudnia" last year's); a range given backwards is turned round;
 *  - a period partly before {@link MIN_SEARCH_MONTH} starts there, and one
 *    longer than {@link MAX_PERIOD_MONTHS} keeps its last months (`clamped`,
 *    shown to the client as a note); one past next month ends at next month,
 *    silently, since no document is dated later; a period wholly outside that
 *    window is kept as described and simply finds nothing;
 *  - a relative period in the future is the current one (`clamped`).
 *
 * A description it cannot read (a missing or impossible month, a year
 * outside 1900–2100) is `ok: false`: the question was not understood.
 */
export function resolvePeriod(p: PeriodDescription, now: Date): ResolvedPeriod {
  const cur = warsawMonth(now);
  const current = monthIndex(cur.year, cur.month);
  const currentQuarter = Math.ceil(cur.month / 3);
  let from: number;
  let to: number;
  let clamped = false;

  switch (p.kind) {
    case 'none':
      return { ok: true, clamped: false };
    case 'month': {
      if (!isMonth(p.month)) return invalid('month');
      if (p.year !== null && !isYear(p.year)) return invalid('year');
      const year = p.year ?? (p.month <= cur.month ? cur.year : cur.year - 1);
      from = to = monthIndex(year, p.month);
      break;
    }
    case 'quarter': {
      const q = p.quarter;
      if (q === null || !Number.isInteger(q) || q < 1 || q > 4) return invalid('quarter');
      if (p.year !== null && !isYear(p.year)) return invalid('year');
      const year = p.year ?? (q <= currentQuarter ? cur.year : cur.year - 1);
      from = monthIndex(year, q * 3 - 2);
      to = from + 2;
      break;
    }
    case 'year': {
      if (p.year !== null && !isYear(p.year)) return invalid('year');
      const year = p.year ?? cur.year;
      from = monthIndex(year, 1);
      to = monthIndex(year, 12);
      break;
    }
    case 'range': {
      if (!isMonth(p.month) || !isMonth(p.to_month)) return invalid('month');
      if ((p.year !== null && !isYear(p.year)) || (p.to_year !== null && !isYear(p.to_year))) {
        return invalid('year');
      }
      let fromYear: number;
      let toYear: number;
      if (p.to_year !== null) {
        toYear = p.to_year;
        fromYear = p.year ?? (p.month <= p.to_month ? toYear : toYear - 1);
      } else if (p.year !== null) {
        fromYear = p.year;
        toYear = p.to_month >= p.month ? p.year : p.year + 1;
      } else {
        fromYear = p.month <= cur.month ? cur.year : cur.year - 1;
        toYear = p.to_month >= p.month ? fromYear : fromYear + 1;
      }
      from = monthIndex(fromYear, p.month);
      to = monthIndex(toYear, p.to_month);
      if (from > to) [from, to] = [to, from];
      break;
    }
    case 'relative_month':
    case 'relative_quarter':
    case 'relative_year': {
      const raw = p.offset;
      if (raw === null || !Number.isInteger(raw) || raw < -1200) return invalid('offset');
      if (raw > 0) clamped = true;
      const offset = Math.min(raw, 0);
      if (p.kind === 'relative_month') {
        from = to = current + offset;
      } else if (p.kind === 'relative_quarter') {
        from = monthIndex(cur.year, currentQuarter * 3 - 2) + offset * 3;
        to = from + 2;
      } else {
        from = monthIndex(cur.year + offset, 1);
        to = from + 11;
      }
      break;
    }
    case 'last_n_months': {
      const raw = p.count;
      if (raw === null || !Number.isInteger(raw) || raw < 1) return invalid('count');
      const count = Math.min(raw, MAX_PERIOD_MONTHS);
      if (count < raw) clamped = true;
      to = current;
      from = current - (count - 1);
      break;
    }
  }

  const min = monthIndex(Number(MIN_SEARCH_MONTH.slice(0, 4)), Number(MIN_SEARCH_MONTH.slice(5)));
  const max = current + 1;
  if (to >= min && from <= max) {
    if (from < min) {
      from = min;
      clamped = true;
    }
    if (to > max) to = max;
  }
  if (to - from + 1 > MAX_PERIOD_MONTHS) {
    from = to - (MAX_PERIOD_MONTHS - 1);
    clamped = true;
  }
  return { ok: true, monthFrom: formatMonth(from), monthTo: formatMonth(to), clamped };
}
