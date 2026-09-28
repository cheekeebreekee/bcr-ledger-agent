import {
  TablePaidClassifications,
  TableShadowMemo,
  statusOf,
  type ShadowMemoTable,
} from './shadowMemo';

const KEY = {
  listItemId: '10',
  driveItemId: '01ABCDEF',
  eTag: '"{9C1E5A40-0000-4000-8000-000000000001},3"',
};

function fakeTable() {
  const entities = new Map<string, Record<string, unknown>>();
  const table = {
    createTable: jest.fn(async () => undefined),
    getEntity: jest.fn(async (pk: string, rk: string) => {
      const entity = entities.get(`${pk}|${rk}`);
      if (!entity) throw Object.assign(new Error('ResourceNotFound'), { statusCode: 404 });
      return entity;
    }),
    upsertEntity: jest.fn(async (entity: Record<string, unknown>, _mode?: string) => {
      entities.set(`${String(entity['partitionKey'])}|${String(entity['rowKey'])}`, entity);
      return {};
    }),
  };
  return { table, entities, asTable: table as unknown as ShadowMemoTable };
}

describe('TableShadowMemo', () => {
  it('answers false for a version never added, true once added', async () => {
    const { asTable } = fakeTable();
    const memo = new TableShadowMemo(asTable, 'r1');

    expect(await memo.has(KEY)).toBe(false);
    await memo.add(KEY);
    expect(await memo.has(KEY)).toBe(true);
    expect(await memo.has({ ...KEY, eTag: '"{9C1E5A40-0000-4000-8000-000000000001},4"' })).toBe(
      false,
    );
  });

  it('stores ids and a digest only: the row id as partition, a hex row key, the time', async () => {
    const { asTable, entities } = fakeTable();
    const memo = new TableShadowMemo(asTable, 'r1', () => new Date('2026-09-27T11:00:00Z'));

    await memo.add(KEY);

    expect([...entities.values()]).toEqual([
      {
        partitionKey: '10',
        rowKey: expect.stringMatching(/^[0-9a-f]{64}$/),
        reportedAt: '2026-09-27T11:00:00.000Z',
      },
    ]);
  });

  it('keys on the classifier release: a new release has not reported anything yet', async () => {
    const { asTable } = fakeTable();
    await new TableShadowMemo(asTable, 'release-1').add(KEY);

    expect(await new TableShadowMemo(asTable, 'release-1').has(KEY)).toBe(true);
    expect(await new TableShadowMemo(asTable, 'release-2').has(KEY)).toBe(false);
  });

  it('creates the table once per worker, and again after a failed attempt', async () => {
    const { table, asTable } = fakeTable();
    table.createTable.mockRejectedValueOnce(Object.assign(new Error('down'), { statusCode: 503 }));
    const memo = new TableShadowMemo(asTable, 'r1');

    await expect(memo.has(KEY)).rejects.toThrow('down');
    await memo.has(KEY);
    await memo.add(KEY);
    await memo.has(KEY);

    expect(table.createTable).toHaveBeenCalledTimes(2);
  });

  it('throws what is not a 404, so the caller never takes "unknown" for "not reported"', async () => {
    const { table, asTable } = fakeTable();
    table.getEntity.mockRejectedValueOnce(
      Object.assign(new Error('forbidden'), { statusCode: 403 }),
    );

    await expect(new TableShadowMemo(asTable, 'r1').has(KEY)).rejects.toThrow('forbidden');
  });

  it('bounds each call with a timeout', async () => {
    const { table, asTable } = fakeTable();
    const memo = new TableShadowMemo(asTable, 'r1');

    await memo.has(KEY);
    await memo.add(KEY);

    expect(table.createTable.mock.calls[0]).toEqual([{ abortSignal: expect.any(AbortSignal) }]);
    expect(table.getEntity.mock.calls[0]?.[2]).toEqual({ abortSignal: expect.any(AbortSignal) });
    expect(table.upsertEntity.mock.calls[0]?.[1]).toBe('Replace');
  });
});

describe('TablePaidClassifications', () => {
  it('counts from 0, one more per add, per version and release', async () => {
    const { asTable } = fakeTable();
    const paid = new TablePaidClassifications(asTable, 'r1');

    expect(await paid.count(KEY)).toBe(0);
    expect(await paid.add(KEY)).toBe(1);
    expect(await paid.add(KEY)).toBe(2);
    expect(await paid.count(KEY)).toBe(2);
    expect(await paid.count({ ...KEY, eTag: '"v2"' })).toBe(0);
    expect(await new TablePaidClassifications(asTable, 'r2').count(KEY)).toBe(0);
  });

  it('keeps its own rows: a shadow report is not a paid count, nor the other way round', async () => {
    const { asTable } = fakeTable();
    await new TableShadowMemo(asTable, 'r1').add(KEY);
    expect(await new TablePaidClassifications(asTable, 'r1').count(KEY)).toBe(0);
    await new TablePaidClassifications(asTable, 'r1').add(KEY);
    const shadow = new TableShadowMemo(asTable, 'r1');
    const paid = new TablePaidClassifications(asTable, 'r1');
    expect(paid.rowKey(KEY)).not.toBe(shadow.rowKey(KEY));
  });

  it('stores ids, a digest and a number only', async () => {
    const { asTable, entities } = fakeTable();
    await new TablePaidClassifications(asTable, 'r1', () => new Date('2026-09-28T11:00:00Z')).add(
      KEY,
    );
    expect([...entities.values()]).toEqual([
      {
        partitionKey: '10',
        rowKey: expect.stringMatching(/^[0-9a-f]{64}$/),
        paid: 1,
        lastPaidAt: '2026-09-28T11:00:00.000Z',
      },
    ]);
  });

  it('reads a malformed count as 0, and throws what is not a 404', async () => {
    const { table, asTable } = fakeTable();
    const paid = new TablePaidClassifications(asTable, 'r1');
    table.getEntity.mockResolvedValueOnce({ paid: 'x' } as never);
    expect(await paid.count(KEY)).toBe(0);
    table.getEntity.mockRejectedValueOnce(Object.assign(new Error('down'), { statusCode: 503 }));
    await expect(paid.count(KEY)).rejects.toThrow('down');
  });

  it('creates the table once, and again after a failed attempt', async () => {
    const { table, asTable } = fakeTable();
    table.createTable.mockRejectedValueOnce(Object.assign(new Error('down'), { statusCode: 503 }));
    const paid = new TablePaidClassifications(asTable, 'r1');
    await expect(paid.count(KEY)).rejects.toThrow('down');
    await paid.count(KEY);
    await paid.add(KEY);
    expect(table.createTable).toHaveBeenCalledTimes(2);
  });

  it('builds from a connection string without calling the service', () => {
    expect(
      TablePaidClassifications.fromConnectionString('UseDevelopmentStorage=true', 'r1'),
    ).toBeInstanceOf(TablePaidClassifications);
  });
});

describe('TableShadowMemo.fromConnectionString', () => {
  it('builds a memo without calling the service', () => {
    expect(TableShadowMemo.fromConnectionString('UseDevelopmentStorage=true', 'r1')).toBeInstanceOf(
      TableShadowMemo,
    );
  });
});

describe('statusOf', () => {
  it('reads an Azure SDK error’s status code, and nothing else', () => {
    expect(statusOf(Object.assign(new Error('x'), { statusCode: 404 }))).toBe(404);
    expect(statusOf(new Error('x'))).toBeUndefined();
    expect(statusOf(null)).toBeUndefined();
    expect(statusOf({ statusCode: '404' })).toBeUndefined();
  });
});
