import { joinSql, Sql, sql } from './sql';

describe('sql', () => {
  it('turns every interpolation into a numbered parameter', () => {
    const id = "x'; DROP TABLE ledger.documents; --";
    expect(
      sql`SELECT * FROM ledger.documents WHERE drive_item_id = ${id} AND size_bytes > ${5}`.toQuery(),
    ).toEqual({
      text: 'SELECT * FROM ledger.documents WHERE drive_item_id = $1 AND size_bytes > $2',
      values: [id, 5],
    });
  });

  it('keeps null, arrays and dates as values', () => {
    const when = new Date('2026-09-26T00:00:00Z');
    expect(sql`VALUES (${null}, ${['A', 'B']}, ${when})`.toQuery()).toEqual({
      text: 'VALUES ($1, $2, $3)',
      values: [null, ['A', 'B'], when],
    });
  });

  it('splices a nested fragment with its parameters renumbered', () => {
    const inner = sql`a = ${1} AND b = ${2}`;
    expect(sql`SELECT ${'x'} WHERE ${inner} AND c = ${3}`.toQuery()).toEqual({
      text: 'SELECT $1 WHERE a = $2 AND b = $3 AND c = $4',
      values: ['x', 1, 2, 3],
    });
  });

  it('splices a fragment with no parameters, and at the very start and end', () => {
    const cols = sql`id, name`;
    expect(sql`${cols}`.toQuery()).toEqual({ text: 'id, name', values: [] });
    expect(sql`SELECT ${cols} FROM t WHERE id = ${7}`.toQuery()).toEqual({
      text: 'SELECT id, name FROM t WHERE id = $1',
      values: [7],
    });
  });

  it('refuses undefined: a missing value is a bug, never NULL by accident', () => {
    expect(() => sql`SELECT ${undefined}`).toThrow(/parameter 1 is undefined/);
  });

  it('refuses to be called with a built string instead of a template', () => {
    const built = ['DROP TABLE ledger.documents'] as unknown as TemplateStringsArray;
    expect(() => sql(built)).toThrow(/tagged template/);
    const withRaw = Object.assign(['x'], { raw: ['x'] }) as unknown as TemplateStringsArray;
    expect(() => sql(withRaw)).toThrow(/tagged template/);
  });

  it('cannot be constructed from outside, not even past the compiler', () => {
    const Forge = Sql as unknown as new (...args: unknown[]) => Sql;
    expect(() => new Forge(['DROP TABLE ledger.documents'], [])).toThrow(/sql`...` tag only/);
    expect(() => new Forge(Symbol('sql'), ['DROP TABLE ledger.documents'], [])).toThrow(
      /sql`...` tag only/,
    );
  });
});

describe('joinSql', () => {
  it('joins fragments with a separator fragment', () => {
    const where = joinSql([sql`a = ${1}`, sql`b = ${2}`, sql`c IS NULL`], sql` AND `);
    expect(sql`WHERE ${where}`.toQuery()).toEqual({
      text: 'WHERE a = $1 AND b = $2 AND c IS NULL',
      values: [1, 2],
    });
  });

  it('is an empty fragment for no fragments, and the fragment itself for one', () => {
    expect(joinSql([], sql` AND `).toQuery()).toEqual({ text: '', values: [] });
    expect(joinSql([sql`x = ${9}`], sql` AND `).toQuery()).toEqual({ text: 'x = $1', values: [9] });
  });
});
