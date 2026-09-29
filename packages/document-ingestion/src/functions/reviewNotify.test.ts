import type { InvocationContext, Timer } from '@azure/functions';

const mockTimer = jest.fn();
jest.mock('@azure/functions', () => ({ app: { timer: mockTimer } }));

const mockLines: Record<string, unknown>[] = [];
jest.mock('@bcr/shared', () => {
  const write = (obj: unknown, msg?: string) =>
    mockLines.push({ ...(obj as Record<string, unknown>), msg });
  const log = { info: write, warn: write, error: write, debug: write, child: () => log };
  return { ...jest.requireActual('@bcr/shared'), createLogger: () => log };
});

let mockOff: string | undefined = 'webhook_unresolved';
let mockNotifier: { run: jest.Mock } | undefined;
jest.mock('../runtime', () => ({
  get reviewNoticesOff() {
    return mockOff;
  },
  get reviewNotifier() {
    return mockNotifier;
  },
}));

import { handleReviewNotify } from './reviewNotify';

const context = { invocationId: 'inv-1' } as unknown as InvocationContext;
const timer = {} as Timer;

describe('reviewNotify', () => {
  beforeEach(() => {
    mockLines.length = 0;
    mockOff = 'webhook_unresolved';
    mockNotifier = undefined;
  });

  it('registers the 10-minute timer with handleReviewNotify', () => {
    expect(mockTimer).toHaveBeenCalledWith(
      'reviewNotify',
      expect.objectContaining({ schedule: '0 */10 * * * *', handler: handleReviewNotify }),
    );
  });

  it('says review_notice.off on every run while the webhook does not resolve', async () => {
    await handleReviewNotify(timer, context);
    await handleReviewNotify(timer, context);
    expect(mockLines).toEqual([
      { event: 'review_notice.off', reason: 'webhook_unresolved', msg: 'review_notice.off' },
      { event: 'review_notice.off', reason: 'webhook_unresolved', msg: 'review_notice.off' },
    ]);
  });

  it('says nothing when off on purpose', async () => {
    mockOff = 'no_webhook';
    await handleReviewNotify(timer, context);
    expect(mockLines).toEqual([]);
  });

  it('runs the notifier when on', async () => {
    mockOff = undefined;
    mockNotifier = { run: jest.fn(async () => undefined) };
    await handleReviewNotify(timer, context);
    expect(mockNotifier.run).toHaveBeenCalledTimes(1);
    expect(mockLines).toEqual([]);
  });
});
