import {
  MAX_PERIOD_MONTHS,
  resolvePeriod,
  warsawMonth,
  type PeriodDescription,
} from './searchPeriod';

/** 2026-09-28, midday in Warsaw (CEST). */
const NOW = new Date('2026-09-28T10:00:00Z');

const none: PeriodDescription = {
  kind: 'none',
  year: null,
  month: null,
  quarter: null,
  to_year: null,
  to_month: null,
  offset: null,
  count: null,
};
const p = (over: Partial<PeriodDescription>): PeriodDescription => ({ ...none, ...over });

describe('warsawMonth', () => {
  it.each([
    ['2026-09-28T10:00:00Z', 2026, 9],
    // 00:30 on 1 October in Warsaw (UTC+2): already October.
    ['2026-09-30T22:30:00Z', 2026, 10],
    ['2026-09-30T21:59:59Z', 2026, 9],
    // 00:30 on 1 January in Warsaw (UTC+1 in winter): already next year.
    ['2026-12-31T23:30:00Z', 2027, 1],
    ['2026-12-31T22:59:59Z', 2026, 12],
    // The spring change: 01:30 UTC on 29 March is 03:30 CEST, still March.
    ['2026-03-29T01:30:00Z', 2026, 3],
  ])('%s is %i-%i in Warsaw', (iso, year, month) => {
    expect(warsawMonth(new Date(iso))).toEqual({ year, month });
  });
});

describe('resolvePeriod, now = 2026-09-28 in Warsaw', () => {
  it.each<[string, Partial<PeriodDescription>, string | undefined, string | undefined, boolean]>([
    // A month or quarter without a year is the latest one that has begun.
    ['marzec', { kind: 'month', month: 3 }, '2026-03', '2026-03', false],
    ['wrzesień (the current month)', { kind: 'month', month: 9 }, '2026-09', '2026-09', false],
    [
      'październik (not begun: last year)',
      { kind: 'month', month: 10 },
      '2025-10',
      '2025-10',
      false,
    ],
    ['grudzień', { kind: 'month', month: 12 }, '2025-12', '2025-12', false],
    ['marzec 2024', { kind: 'month', month: 3, year: 2024 }, '2024-03', '2024-03', false],
    ['III kwartał', { kind: 'quarter', quarter: 3 }, '2026-07', '2026-09', false],
    ['IV kwartał (last year)', { kind: 'quarter', quarter: 4 }, '2025-10', '2025-12', false],
    ['I kwartał 2025', { kind: 'quarter', quarter: 1, year: 2025 }, '2025-01', '2025-03', false],
    // The current year ends at next month: no document is dated later.
    ['ten rok', { kind: 'year' }, '2026-01', '2026-10', false],
    ['2025', { kind: 'year', year: 2025 }, '2025-01', '2025-12', false],
    ['od stycznia do marca', { kind: 'range', month: 1, to_month: 3 }, '2026-01', '2026-03', false],
    [
      'od listopada do lutego',
      { kind: 'range', month: 11, to_month: 2 },
      '2025-11',
      '2026-02',
      false,
    ],
    [
      'od listopada 2025 do lutego',
      { kind: 'range', year: 2025, month: 11, to_month: 2 },
      '2025-11',
      '2026-02',
      false,
    ],
    [
      'od marca do maja 2025',
      { kind: 'range', year: 2025, month: 3, to_month: 5 },
      '2025-03',
      '2025-05',
      false,
    ],
    [
      'od października do grudnia (no years: the latest October that has begun)',
      { kind: 'range', month: 10, to_month: 12 },
      '2025-10',
      '2025-12',
      false,
    ],
    // A range that has begun this year is this year's, like its first month alone.
    [
      'od lipca do października',
      { kind: 'range', month: 7, to_month: 10 },
      '2026-07',
      '2026-10',
      false,
    ],
    [
      'od września do października',
      { kind: 'range', month: 9, to_month: 10 },
      '2026-09',
      '2026-10',
      false,
    ],
    // Ends at next month, silently, like „ten rok”.
    [
      'od stycznia do grudnia',
      { kind: 'range', month: 1, to_month: 12 },
      '2026-01',
      '2026-10',
      false,
    ],
    [
      'a range given backwards is turned round',
      { kind: 'range', year: 2026, month: 5, to_year: 2026, to_month: 2 },
      '2026-02',
      '2026-05',
      false,
    ],
    ['w tym miesiącu', { kind: 'relative_month', offset: 0 }, '2026-09', '2026-09', false],
    ['w zeszłym miesiącu', { kind: 'relative_month', offset: -1 }, '2026-08', '2026-08', false],
    ['w tym kwartale', { kind: 'relative_quarter', offset: 0 }, '2026-07', '2026-09', false],
    ['w zeszłym kwartale', { kind: 'relative_quarter', offset: -1 }, '2026-04', '2026-06', false],
    [
      'przedwczoraj kwartał (-3)',
      { kind: 'relative_quarter', offset: -3 },
      '2025-10',
      '2025-12',
      false,
    ],
    ['w zeszłym roku', { kind: 'relative_year', offset: -1 }, '2025-01', '2025-12', false],
    ['w tym roku', { kind: 'relative_year', offset: 0 }, '2026-01', '2026-10', false],
    // The future is the current one, said as clamped.
    ['w przyszłym miesiącu', { kind: 'relative_month', offset: 1 }, '2026-09', '2026-09', true],
    ['ostatnie 3 miesiące', { kind: 'last_n_months', count: 3 }, '2026-07', '2026-09', false],
    ['ostatni miesiąc', { kind: 'last_n_months', count: 1 }, '2026-09', '2026-09', false],
    // Longer than ten years keeps the last 120 months.
    ['ostatnie 500 miesięcy', { kind: 'last_n_months', count: 500 }, '2016-10', '2026-09', true],
    // Partly before 2000-01 starts there, then the ten-year cap applies.
    [
      'od 1990 do teraz',
      { kind: 'range', year: 1990, month: 1, to_year: 2026, to_month: 9 },
      '2016-10',
      '2026-09',
      true,
    ],
    [
      'od 1998 do 2003',
      { kind: 'range', year: 1998, month: 1, to_year: 2003, to_month: 12 },
      '2000-01',
      '2003-12',
      true,
    ],
    // Wholly outside the window: kept as described, finds nothing.
    ['1995', { kind: 'year', year: 1995 }, '1995-01', '1995-12', false],
    ['2030', { kind: 'year', year: 2030 }, '2030-01', '2030-12', false],
    // A range past next month ends at next month, silently.
    [
      'od sierpnia 2026 do marca 2027',
      { kind: 'range', year: 2026, month: 8, to_year: 2027, to_month: 3 },
      '2026-08',
      '2026-10',
      false,
    ],
    ['no period', { kind: 'none' }, undefined, undefined, false],
  ])('%s', (_label, over, monthFrom, monthTo, clamped) => {
    const r = resolvePeriod(p(over), NOW);
    expect(r).toEqual({
      ok: true,
      clamped,
      ...(monthFrom ? { monthFrom } : {}),
      ...(monthTo ? { monthTo } : {}),
    });
  });

  it('never spans more than the cap', () => {
    const r = resolvePeriod(p({ kind: 'last_n_months', count: 10_000 }), NOW);
    expect(r.ok && r.monthFrom && r.monthTo).toBeTruthy();
    if (r.ok && r.monthFrom && r.monthTo) {
      const months = (s: string) => Number(s.slice(0, 4)) * 12 + Number(s.slice(5));
      expect(months(r.monthTo) - months(r.monthFrom) + 1).toBe(MAX_PERIOD_MONTHS);
    }
  });

  it.each<[string, Partial<PeriodDescription>, string]>([
    ['month 13', { kind: 'month', month: 13 }, 'month'],
    ['month 0', { kind: 'month', month: 0 }, 'month'],
    ['no month', { kind: 'month' }, 'month'],
    ['a fractional month', { kind: 'month', month: 2.5 }, 'month'],
    ['year 1800', { kind: 'month', month: 3, year: 1800 }, 'year'],
    ['year 2200', { kind: 'year', year: 2200 }, 'year'],
    ['quarter 5', { kind: 'quarter', quarter: 5 }, 'quarter'],
    ['no quarter', { kind: 'quarter' }, 'quarter'],
    ['a quarter of year 99', { kind: 'quarter', quarter: 1, year: 99 }, 'year'],
    ['a range without an end', { kind: 'range', month: 1 }, 'month'],
    [
      'a range ending in year 3000',
      { kind: 'range', month: 1, to_month: 2, to_year: 3000 },
      'year',
    ],
    ['a relative month without an offset', { kind: 'relative_month' }, 'offset'],
    ['a relative year 2000 years back', { kind: 'relative_year', offset: -2000 }, 'offset'],
    ['zero months', { kind: 'last_n_months', count: 0 }, 'count'],
    ['no count', { kind: 'last_n_months' }, 'count'],
  ])('cannot read %s', (_label, over, reason) => {
    expect(resolvePeriod(p(over), NOW)).toEqual({ ok: false, reason });
  });
});

describe('resolvePeriod at a month boundary in Warsaw', () => {
  // 22:30 UTC on 30 September is 00:30 on 1 October in Warsaw.
  const lateSeptemberUtc = new Date('2026-09-30T22:30:00Z');

  it('"this month" is already October', () => {
    expect(resolvePeriod(p({ kind: 'relative_month', offset: 0 }), lateSeptemberUtc)).toEqual({
      ok: true,
      monthFrom: '2026-10',
      monthTo: '2026-10',
      clamped: false,
    });
  });

  it('"październik" without a year is this October, which has begun', () => {
    expect(resolvePeriod(p({ kind: 'month', month: 10 }), lateSeptemberUtc)).toMatchObject({
      monthFrom: '2026-10',
      monthTo: '2026-10',
    });
  });

  it('"this quarter" is already Q4 (ending at next month: nothing is dated later)', () => {
    expect(
      resolvePeriod(p({ kind: 'relative_quarter', offset: 0 }), lateSeptemberUtc),
    ).toMatchObject({ monthFrom: '2026-10', monthTo: '2026-11' });
  });

  it('"this year" is already 2027 at 00:30 on New Year in Warsaw', () => {
    expect(
      resolvePeriod(p({ kind: 'relative_year', offset: 0 }), new Date('2026-12-31T23:30:00Z')),
    ).toMatchObject({ monthFrom: '2027-01', monthTo: '2027-02' });
  });
});
