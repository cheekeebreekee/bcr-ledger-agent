import { AbortRetryError, retry } from './retry';

describe('retry', () => {
  it('returns the first success', async () => {
    const fn = jest.fn().mockResolvedValue('ok');
    await expect(retry(fn, { retries: 2, minTimeoutMs: 0 })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries failures and passes the attempt number', async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new Error('a'))
      .mockRejectedValueOnce(new Error('b'))
      .mockResolvedValue('ok');
    await expect(retry(fn, { retries: 2, minTimeoutMs: 0, jitter: 0 })).resolves.toBe('ok');
    expect(fn.mock.calls.map((c) => c[0])).toEqual([0, 1, 2]);
  });

  it('throws the last error once retries are exhausted', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('still down'));
    await expect(retry(fn, { retries: 1, minTimeoutMs: 0 })).rejects.toThrow('still down');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('stops immediately on AbortRetryError', async () => {
    const fn = jest.fn().mockRejectedValue(new AbortRetryError('do not retry'));
    await expect(retry(fn, { retries: 5, minTimeoutMs: 0 })).rejects.toBeInstanceOf(AbortRetryError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('uses the default policy when none is given', async () => {
    const fn = jest.fn().mockResolvedValue(1);
    await expect(retry(fn)).resolves.toBe(1);
  });
});
